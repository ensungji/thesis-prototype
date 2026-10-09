// mobile/lib/network.ts
// Tells the whole app whether Supabase is reachable.
//
// Pure JavaScript (no native module → no rebuild needed).
// It pings Supabase's health endpoint:
//   - every 10s while online
//   - every 3s while offline (so "back online" is noticed fast)
//   - immediately when the app comes back to the foreground
//
// Use it anywhere:
//   const online = useOnline();          // in a component
//   isOnline();                          // anywhere else (e.g. the outbox)
//   const stop = subscribeOnline(fn);    // get notified on changes

import { useEffect, useState } from "react";
import { AppState } from "react-native";

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";

const ONLINE_INTERVAL_MS = 10000;
const OFFLINE_INTERVAL_MS = 3000;
const TIMEOUT_MS = 5000;
const FAILS_BEFORE_OFFLINE = 2; // one slow ping shouldn't flash the banner

let online = true;
let fails = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
const listeners = new Set<(online: boolean) => void>();

function setOnline(next: boolean) {
  if (next === online) return;
  online = next;
  listeners.forEach((fn) => fn(online));
}

async function ping(): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: SUPABASE_KEY },
      signal: ctrl.signal,
    });
    return res.status < 500; // any answer from the server = reachable
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function check() {
  const ok = await ping();
  if (ok) {
    fails = 0;
    setOnline(true);
  } else if (++fails >= FAILS_BEFORE_OFFLINE) {
    setOnline(false);
  }
  schedule();
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(check, online ? ONLINE_INTERVAL_MS : OFFLINE_INTERVAL_MS);
}

function start() {
  if (started) return;
  started = true;
  check();
  AppState.addEventListener("change", (s) => {
    if (s === "active") check();
  });
}

/** Current state, for code outside React (e.g. the outbox). */
export function isOnline() {
  return online;
}

/** Run fn whenever online/offline changes. Returns an unsubscribe function. */
export function subscribeOnline(fn: (online: boolean) => void) {
  start();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Force a check right now (e.g. after a failed save). */
export function recheckOnline() {
  start();
  check();
}

/** React hook: re-renders when the connection changes. */
export function useOnline() {
  const [state, setState] = useState(online);
  useEffect(() => subscribeOnline(setState), []);
  return state;
}
