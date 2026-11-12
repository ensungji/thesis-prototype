// mobile/lib/maintenance.ts
// Maintenance mode (migration 26): one row in app_settings that every signed-in
// user can read and only an admin can change.
//
//   const m = useMaintenance();   // { on, message, startedAt, setBy, loaded }
//
// While it's on, teachers can look at everything but can't create or start
// sessions or change activities; sessions already running can finish. The
// database enforces this (SQLSTATE DT002), so the app only greys buttons out
// and explains. Admins aren't blocked.
//
// One shared store for the whole app: loaded once, kept up to date by
// Realtime, and re-read when the app comes back to the front or someone signs in.

import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { supabase } from "./supabase";

export type Maintenance = {
  on: boolean;
  message: string | null;
  startedAt: string | null;
  setBy: string | null;
  /** false until the first read finished */
  loaded: boolean;
};

/** Shown when the admin didn't write a message. */
export const MAINTENANCE_DEFAULT_TEXT =
  "Starting new sessions and changing activities is paused. Sessions already running can finish.";

/** Under a greyed-out button. */
export const MAINTENANCE_BLOCKED_HINT = "Maintenance mode is on. Try again when it ends.";

const OFF: Maintenance = { on: false, message: null, startedAt: null, setBy: null, loaded: false };

type Row = {
  maintenance: boolean;
  maintenance_message: string | null;
  maintenance_started_at: string | null;
  maintenance_set_by: string | null;
};

const COLUMNS = "maintenance, maintenance_message, maintenance_started_at, maintenance_set_by";

let state: Maintenance = OFF;
const listeners = new Set<(m: Maintenance) => void>();
let started = false;

function publish(next: Maintenance) {
  state = next;
  listeners.forEach((fn) => fn(state));
}

function fromRow(r: Partial<Row> | null | undefined): Maintenance {
  return {
    on: !!r?.maintenance,
    message: r?.maintenance_message ?? null,
    startedAt: r?.maintenance_started_at ?? null,
    setBy: r?.maintenance_set_by ?? null,
    loaded: true,
  };
}

/** Re-reads the setting. Errors (offline, signed out) keep the last known value. */
export async function refreshMaintenance(): Promise<Maintenance> {
  const { data, error } = await supabase.from("app_settings").select(COLUMNS).maybeSingle();
  if (!error) publish(data ? fromRow(data as Row) : { ...OFF, loaded: true });
  return state;
}

function start() {
  if (started) return;
  started = true;
  refreshMaintenance();
  supabase
    .channel(`app-settings-${Date.now()}`)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "app_settings" }, (payload) =>
      publish(fromRow(payload.new as Row))
    )
    .subscribe();
  AppState.addEventListener("change", (s) => {
    if (s === "active") refreshMaintenance();
  });
  supabase.auth.onAuthStateChange((event) => {
    // deferred: calling Supabase inside this callback can deadlock on the auth lock
    if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") setTimeout(() => refreshMaintenance(), 0);
    if (event === "SIGNED_OUT") publish(OFF);
  });
}

export function useMaintenance(): Maintenance {
  const [m, setM] = useState<Maintenance>(state);
  useEffect(() => {
    start();
    listeners.add(setM);
    setM(state);
    return () => {
      listeners.delete(setM);
    };
  }, []);
  return m;
}

/** A refusal from the maintenance guard (migration 26). */
export function isMaintenanceError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === "DT002" || /Maintenance mode is on/i.test(err.message ?? "");
}

/** Admin only (RLS). Returns an error message, or null when saved. */
export async function setMaintenance(on: boolean, message: string | null): Promise<string | null> {
  const { data, error } = await supabase
    .from("app_settings")
    .update({ maintenance: on, maintenance_message: message?.trim() || null })
    .eq("id", true)
    .select(COLUMNS);
  if (error) return error.message;
  if (!data?.length) return "Nothing changed. Only an admin can change maintenance mode.";
  publish(fromRow(data[0] as Row));
  return null;
}
