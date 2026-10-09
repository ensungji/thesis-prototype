// mobile/lib/outbox.ts
// "Save now, or later if offline."
//
// updateOrQueue() tries the Supabase update right away. If the phone is
// offline (or the request fails because of the network), the change is
// stored on the phone and sent automatically when the connection returns.
//
// Rules:
//   - Only UPDATEs are queued (status changes, grade overrides). They are
//     safe to send late and safe to send twice.
//   - Device commands (words, clears) are NEVER queued: a word arriving
//     minutes later would raise the dots unexpectedly.
//   - Several queued updates to the same row are merged (latest wins), so
//     "paused" then "finished" is sent once as "finished".
//   - Real server errors (e.g. permission denied) are NOT queued — they
//     would fail again forever. They are returned to the caller.

import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";
import { isOnline, subscribeOnline, recheckOnline } from "./network";

const KEY = "outbox_v1";

type QueuedUpdate = {
  key: string;                    // table + row match, used for merging
  table: string;
  values: Record<string, unknown>;
  match: Record<string, string>;
  queuedAt: number;
  tries: number;
};

let queue: QueuedUpdate[] = [];
let loaded = false;
let flushing = false;
let started = false;
const listeners = new Set<(n: number) => void>();

const rowKey = (table: string, match: Record<string, string>) =>
  table + ":" + Object.keys(match).sort().map((k) => `${k}=${match[k]}`).join("&");

function emit() {
  listeners.forEach((fn) => fn(queue.length));
}

async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    queue = raw ? JSON.parse(raw) : [];
  } catch {
    queue = [];
  }
  emit();
}

async function save() {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(queue));
  } catch {
    // storage full / unavailable — keep in memory
  }
  emit();
}

// Network problems look like this; anything else is a real server answer.
function isNetworkError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err ?? "").toLowerCase();
  return (
    msg.includes("network request failed") ||
    msg.includes("failed to fetch") ||
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("aborted")
  );
}

async function enqueue(table: string, values: Record<string, unknown>, match: Record<string, string>) {
  await load();
  const key = rowKey(table, match);
  const existing = queue.find((q) => q.key === key);
  if (existing) {
    existing.values = { ...existing.values, ...values }; // latest wins
    existing.queuedAt = Date.now();
  } else {
    queue.push({ key, table, values, match, queuedAt: Date.now(), tries: 0 });
  }
  await save();
}

async function send(table: string, values: Record<string, unknown>, match: Record<string, string>) {
  const { error } = await supabase.from(table).update(values).match(match);
  if (error) throw error;
}

/**
 * Update a row now, or queue it if offline.
 * Returns { queued: true } when saved for later, { error } on a real failure.
 */
export async function updateOrQueue(
  table: string,
  values: Record<string, unknown>,
  match: Record<string, string>,
): Promise<{ queued: boolean; error?: string }> {
  start();
  if (!isOnline()) {
    await enqueue(table, values, match);
    return { queued: true };
  }
  try {
    await send(table, values, match);
    return { queued: false };
  } catch (err) {
    if (isNetworkError(err)) {
      await enqueue(table, values, match);
      recheckOnline(); // probably just went offline — update the banner
      return { queued: true };
    }
    return { queued: false, error: String((err as { message?: string })?.message ?? err) };
  }
}

/** Send everything waiting in the outbox (oldest first). */
export async function flushOutbox() {
  await load();
  if (flushing || queue.length === 0 || !isOnline()) return;
  flushing = true;
  try {
    while (queue.length > 0) {
      const item = queue[0];
      try {
        await send(item.table, item.values, item.match);
        queue.shift(); // sent
      } catch (err) {
        if (isNetworkError(err)) break; // still offline — try again later
        // Real server error: retry a few times, then drop so it can't block the queue
        item.tries += 1;
        console.warn("Outbox item failed:", item.key, err);
        if (item.tries >= 3) queue.shift();
        else break;
      }
      await save();
    }
  } finally {
    flushing = false;
    await save();
  }
}

function start() {
  if (started) return;
  started = true;
  load().then(flushOutbox);
  subscribeOnline((online) => {
    if (online) flushOutbox();
  });
}

/** Number of changes waiting to sync (for the banner). */
export function usePendingCount() {
  const [n, setN] = useState(queue.length);
  useEffect(() => {
    start();
    listeners.add(setN);
    setN(queue.length);
    return () => {
      listeners.delete(setN);
    };
  }, []);
  return n;
}
