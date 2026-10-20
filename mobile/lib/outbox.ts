// mobile/lib/outbox.ts
// "Save now, or later if offline."
//
// updateOrQueue() tries the Supabase update right away. If the phone is
// offline (or the request fails because of the network), the change is
// stored on the phone and sent automatically when the connection returns.
//
// Rules:
//   - UPDATEs are queued (status changes, grade overrides). They are
//     safe to send late and safe to send twice.
//   - INSERTs can be queued too (teacher hand-grades), but only with an id
//     made on the phone (newId()), so sending twice never makes duplicates.
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
  op?: "update" | "insert";       // missing = update (older queued items)
  onConflict?: string;            // insert only: columns that make a row "already there" (default id)
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

async function send(
  table: string,
  values: Record<string, unknown>,
  match: Record<string, string>,
  op: "update" | "insert" = "update",
  onConflict = "id",
) {
  if (op === "insert") {
    // ON CONFLICT DO NOTHING: a row that already arrived is not added twice
    let { error } = await supabase.from(table).upsert(values, { onConflict, ignoreDuplicates: true });
    // 42P10 = no unique index on those columns yet (migration not run): plain id check
    if (error?.code === "42P10" && onConflict !== "id") {
      ({ error } = await supabase.from(table).upsert(values, { onConflict: "id", ignoreDuplicates: true }));
    }
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from(table).update(values).match(match);
  if (error) throw error;
}

/** A random UUID made on the phone, so queued inserts can't duplicate. */
export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Insert a row now, or queue it if offline. The row MUST have an `id`
 * from newId(). Returns { queued: true } when saved for later.
 */
export async function insertOrQueue(
  table: string,
  row: Record<string, unknown> & { id: string },
  opts?: { onConflict?: string },
): Promise<{ queued: boolean; error?: string }> {
  start();
  const queueIt = async () => {
    await load();
    queue.push({
      op: "insert",
      onConflict: opts?.onConflict,
      key: "insert:" + table + ":" + row.id,
      table,
      values: row,
      match: { id: row.id },
      queuedAt: Date.now(),
      tries: 0,
    });
    await save();
  };
  if (!isOnline()) {
    await queueIt();
    return { queued: true };
  }
  try {
    await send(table, row, { id: row.id }, "insert", opts?.onConflict);
    return { queued: false };
  } catch (err) {
    if (isNetworkError(err)) {
      await queueIt();
      recheckOnline();
      return { queued: true };
    }
    return { queued: false, error: String((err as { message?: string })?.message ?? err) };
  }
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
  // An older change to this row is still waiting: merge into it instead of
  // sending now, or the older one could land after this one and win.
  await load();
  if (queue.some((q) => q.key === rowKey(table, match))) {
    await enqueue(table, values, match);
    flushOutbox();
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

// A change the server kept refusing was thrown away — tell the admin.
function queueDropLog(item: QueuedUpdate, err: unknown) {
  const id = newId();
  queue.push({
    op: "insert",
    key: "insert:system_logs:" + id,
    table: "system_logs",
    values: {
      id,
      created_at: new Date().toISOString(),
      level: "error",
      source: "app",
      event: "sync_dropped",
      message: `Gave up saving a change to ${item.table}: ${String((err as { message?: string })?.message ?? err)}`.slice(0, 500),
      meta: { table: item.table, op: item.op ?? "update", match: item.match, values: item.values },
    },
    match: { id },
    queuedAt: Date.now(),
    tries: 0,
  });
}

// Retry timer: while changes are waiting, keep trying (3s, 6s, 12s … max 30s)
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 3000;

function scheduleRetry() {
  if (retryTimer || queue.length === 0) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    flushOutbox();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 30000);
}

const MAX_TRIES = 5; // real server errors only; network errors never count

/** Send everything waiting in the outbox (oldest first). */
export async function flushOutbox() {
  await load();
  if (flushing || queue.length === 0 || !isOnline()) return;
  flushing = true;
  let networkProblem = false;
  try {
    // The login token may have expired while offline — refresh it first
    try {
      await supabase.auth.getSession();
    } catch {
      // ignore — the requests below will tell us if something is wrong
    }

    // A failing item no longer blocks the ones behind it. But if an item fails,
    // later items for the SAME row wait (so an update never runs before its insert).
    const blockedRows = new Set<string>();
    for (const item of [...queue]) {
      const row = item.table + JSON.stringify(item.match);
      if (blockedRows.has(row)) continue;
      try {
        const sentValues = item.values;
        await send(item.table, sentValues, item.match, item.op ?? "update", item.onConflict);
        // Something newer was merged in while this was sending (enqueue gives
        // the item a NEW values object) → keep it for the next pass.
        if (item.values === sentValues) queue = queue.filter((q) => q !== item); // sent
      } catch (err) {
        if (isNetworkError(err)) {
          networkProblem = true; // connection dropped again — stop for now
          break;
        }
        item.tries += 1;
        blockedRows.add(row);
        console.warn(`Outbox item failed (try ${item.tries}/${MAX_TRIES}):`, item.key, err);
        if (item.tries >= MAX_TRIES) {
          queue = queue.filter((q) => q !== item); // give up so it can't block forever
          if (item.table !== "system_logs") queueDropLog(item, err);
        }
      }
      await save();
    }
  } finally {
    flushing = false;
    await save();
  }

  if (queue.length === 0) {
    retryDelay = 3000; // all sent — reset the backoff
  } else {
    if (networkProblem) recheckOnline();
    scheduleRetry();
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