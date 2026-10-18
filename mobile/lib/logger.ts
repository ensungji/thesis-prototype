// mobile/lib/logger.ts
// Writes events to the system_logs table (admins see them in Admin → Logs).
//
//   logEvent("error", "device_command_failed", "Could not send CAT", { session_id })
//
// - Never throws and never blocks the UI.
// - Offline? The log waits in the outbox and is sent later, with its real time.
// - startAppLogging() also records how long the phone was offline.

import { insertOrQueue, newId } from "./outbox";
import { subscribeOnline } from "./network";

export type LogLevel = "info" | "warn" | "error";

export function logEvent(
  level: LogLevel,
  event: string,
  message: string,
  extra?: { session_id?: string | null; device_id?: string | null; meta?: Record<string, unknown> },
) {
  const row = {
    id: newId(),
    created_at: new Date().toISOString(),
    level,
    source: "app",
    event,
    message: message.slice(0, 500),
    session_id: extra?.session_id ?? null,
    device_id: extra?.device_id ?? null,
    meta: extra?.meta ?? {},
  };
  if (__DEV__) console.log(`[log] ${level} ${event}: ${message}`);
  insertOrQueue("system_logs", row).catch(() => {
    // logging must never crash the app
  });
}

let started = false;
let offlineSince: number | null = null;

/** Call once (the OfflineBanner does). Logs each offline period. */
export function startAppLogging() {
  if (started) return;
  started = true;
  subscribeOnline((online) => {
    if (!online) {
      offlineSince = Date.now();
      return;
    }
    if (offlineSince) {
      const secs = Math.round((Date.now() - offlineSince) / 1000);
      logEvent("warn", "app_offline", `Phone was offline for ${secs}s`, {
        meta: { seconds: secs, from: new Date(offlineSince).toISOString() },
      });
      offlineSince = null;
    }
  });
}
