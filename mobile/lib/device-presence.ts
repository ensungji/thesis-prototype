// mobile/lib/device-presence.ts   (needs firmware v7.1+)
// Live "who's online" for the D.O.T.S. devices.
//
// Each device, on the Realtime channel "dots-presence":
//   - joins presence (key = its UUID) → we hear about it immediately
//   - broadcasts "alive" every 3 s: { id, code, showing: "CAT", busy? }
//
// A device is OFFLINE when we haven't heard "alive" for 10 s
// (45 s if it said busy:"answer" — it closes its connection on purpose
// while uploading an answer). This catches real power cuts in ~10 s,
// instead of waiting 30–60 s for the server to notice.
// (Devices that never send "alive" — older firmware — fall back to the
// server's presence leave, which is slower but still correct.)
//
// This module (started once, by the OfflineBanner):
//   - keeps devices.status in the database honest ("connected" / "offline")
//   - tells listeners (the session screen) when a device goes offline or
//     comes back, with what it's showing, so the word can be re-sent

import { supabase } from "./supabase";

type Info = { code?: string; showing?: string; busy?: string };

export type PresenceEvent =
  | {
      type: "online";
      deviceId: string;
      code: string;
      showing: string;
      wasOffline: boolean;
      /** It went quiet for an answer upload (firmware v7.2+ clears its display then). */
      afterAnswer: boolean;
    }
  | { type: "offline"; deviceId: string; code: string };

const ALIVE_TIMEOUT_MS = 10000; // no "alive" this long → offline
const BUSY_TIMEOUT_MS = 45000;  // …or this long while it uploads an answer
const CHECK_EVERY_MS = 2000;
const LEAVE_GRACE_MS = 8000;    // fallback for devices without "alive"
const AFTER_ANSWER_MS = 15000;  // a rejoin this soon after an answer upload is "after an answer"

type Dev = {
  online: boolean;
  everOnline: boolean; // seen online before in this app run
  sendsAlive: boolean; // has sent at least one "alive" (firmware v7.1+)
  lastSeen: number;
  busy: boolean;
  answerEndedAt: number; // when it last stopped being busy with an answer (0 = never)
  code: string;
  showing: string;
};

const devs = new Map<string, Dev>();
const listeners = new Set<(e: PresenceEvent) => void>();
let started = false;
let synced = false;

function emit(e: PresenceEvent) {
  listeners.forEach((fn) => {
    try {
      fn(e);
    } catch (err) {
      console.warn("presence listener failed:", err);
    }
  });
}

async function loggedIn() {
  const { data } = await supabase.auth.getSession();
  return !!data.session;
}

// Only writes when the value really changes (the DB trigger logs each change)
async function writeStatus(deviceId: string, status: "connected" | "offline") {
  if (!(await loggedIn())) return;
  // Server-side function: only for free devices or this teacher's own
  // (migration 07); it also skips writes that change nothing
  const { error } = await supabase.rpc("set_device_status", { p_device: deviceId, p_status: status });
  if (error) console.warn("device status update failed:", error.message);
}

// Heard from a device. rejoined = it (re)connected its socket just now.
function heard(id: string, info: Info, rejoined: boolean, viaAlive: boolean) {
  const prev = devs.get(id);
  const now = Date.now();
  const busy = !!info.busy;
  const d: Dev = {
    online: true,
    everOnline: prev?.everOnline ?? false,
    sendsAlive: (prev?.sendsAlive ?? false) || viaAlive,
    lastSeen: now,
    busy,
    // The first message after an upload may be "alive" or the presence rejoin,
    // in either order, so remember WHEN the answer ended rather than a flag
    answerEndedAt: prev?.busy && !busy ? now : prev?.answerEndedAt ?? 0,
    code: info.code ?? prev?.code ?? "",
    showing: info.showing ?? prev?.showing ?? "",
  };
  devs.set(id, d);

  const cameOnline = !prev?.online;
  if (cameOnline) writeStatus(id, "connected");

  // Tell the session screen when it came (back) online, or re-connected
  // (it may have lost its display) — not for every 3-second "alive"
  if (synced && (cameOnline || rejoined)) {
    emit({
      type: "online",
      deviceId: id,
      code: d.code,
      showing: d.showing,
      wasOffline: cameOnline && d.everOnline,
      afterAnswer: !busy && d.answerEndedAt > 0 && now - d.answerEndedAt < AFTER_ANSWER_MS,
    });
  }
  d.everOnline = true;
}

function markOffline(id: string, d: Dev) {
  d.online = false;
  writeStatus(id, "offline");
  emit({ type: "offline", deviceId: id, code: d.code });
}

function checkTimeouts() {
  const now = Date.now();
  devs.forEach((d, id) => {
    if (!d.online || !d.sendsAlive) return; // no "alive" support → presence leave decides
    if (now - d.lastSeen < (d.busy ? BUSY_TIMEOUT_MS : ALIVE_TIMEOUT_MS)) return;
    markOffline(id, d);
  });
}

// Grace before calling a non-"alive" device offline after it left
function d0Grace(id: string) {
  return devs.get(id)?.busy ? BUSY_TIMEOUT_MS : LEAVE_GRACE_MS;
}

// After the first sync: devices marked "connected" that aren't here are offline
async function reconcile(present: string[]) {
  if (!(await loggedIn())) return;
  const { data } = await supabase.from("devices").select("id").eq("status", "connected");
  for (const row of data ?? []) {
    if (!present.includes(row.id)) writeStatus(row.id, "offline");
  }
}

export function startDevicePresence() {
  if (started) return;
  started = true;

  const channel = supabase.channel("dots-presence");

  channel
    // The device (re)joined: show it right away (the server may still list an
    // old, dead connection of it for a while — "alive" timing decides offline)
    .on("presence", { event: "join" }, ({ key, newPresences }) => {
      const metas = newPresences as unknown as Info[];
      const meta = metas[metas.length - 1] ?? {};
      if (meta.busy) {
        // just its "going quiet for an answer" update: remember it, no event
        const d = devs.get(key);
        if (d) d.busy = true;
        return;
      }
      heard(key, meta, true, false);
    })
    // Fallback for devices that don't send "alive": the server says it left
    .on("presence", { event: "leave" }, ({ key, currentPresences }) => {
      if ((currentPresences ?? []).length > 0) return; // another connection still there
      setTimeout(() => {
        const d = devs.get(key);
        if (!d || !d.online || d.sendsAlive) return; // "alive" timing handles these
        if ((channel.presenceState()[key] ?? []).length > 0) return; // came back
        markOffline(key, d);
      }, d0Grace(key));
    })
    .on("broadcast", { event: "alive" }, ({ payload }) => {
      const p = payload as Info & { id?: string };
      if (p?.id) heard(p.id, p, false, true);
    })
    .on("presence", { event: "sync" }, () => {
      if (synced) return;
      synced = true;
      reconcile(Object.keys(channel.presenceState()));
    })
    .subscribe();

  setInterval(checkTimeouts, CHECK_EVERY_MS);
}

/** Get told when a device comes back online or goes offline. Returns unsubscribe. */
export function onDevicePresence(fn: (e: PresenceEvent) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}