// mobile/lib/route-for-session.ts
// Where a signed-in user belongs: the Admin Panel, the teacher screens, or
// nowhere (signed out / stay put). Used by app/index.tsx (app start and when
// the welcome screen comes back into view), app/login.tsx (a saved login and
// right after signing in), and the guards in (teacher)/_layout.tsx and
// admin/_layout.tsx, so every entry point follows the same rules:
//
//   no saved login              → null ("no-session"): show welcome / login
//   profile.is_active === false → signed out here, null ("inactive")
//   role 'admin'                → /admin
//   any other role              → /(teacher)/dashboard
//   profile can't load (offline, server error) → the role this phone saw
//     the last time it loaded the profile for this user ("offline"). Never
//     signs out (the server bans a deactivated login anyway), and never sends
//     a user it has seen as an admin to the teacher screens. No role seen yet
//     on this phone → null: stay where you are.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";

export const ADMIN_HOME = "/admin";
export const TEACHER_HOME = "/(teacher)/dashboard";
export type HomeRoute = typeof ADMIN_HOME | typeof TEACHER_HOME;

export type SessionRoute = {
  route: HomeRoute | null;
  reason: "ok" | "no-session" | "inactive" | "offline";
  userId: string | null;
};

const roleKey = (userId: string) => `dots.lastRole.${userId}`;

/** The home screen for a role. Anything that isn't 'admin' is a teacher. */
export function homeFor(role: string | null | undefined): HomeRoute {
  return role === "admin" ? ADMIN_HOME : TEACHER_HOME;
}

/** Remember the role this phone last saw for a user (offline fallback). */
export async function rememberRole(userId: string, role: string | null | undefined): Promise<void> {
  try {
    await AsyncStorage.setItem(roleKey(userId), role === "admin" ? "admin" : "teacher");
  } catch {
    // storage full / unavailable: only the offline fallback is affected
  }
}

/** The role this phone last saw for a user, or null. */
export async function rememberedRole(userId: string): Promise<"admin" | "teacher" | null> {
  try {
    const v = await AsyncStorage.getItem(roleKey(userId));
    return v === "admin" || v === "teacher" ? v : null;
  } catch {
    return null;
  }
}

export type Access =
  | { ok: true; role: string; isActive: boolean; activeDeviceId: string | null }
  | { ok: false; error: string };

/** Read role / is_active (and active_device_id for the login override check). Remembers the role. */
export async function readAccess(userId: string): Promise<Access> {
  const { data, error } = await supabase
    .from("profiles")
    .select("role, is_active, active_device_id")
    .eq("id", userId)
    .maybeSingle();
  if (error || !data) return { ok: false, error: error?.message ?? "No profile for this account." };
  const p = data as { role: string | null; is_active: boolean | null; active_device_id: string | null };
  await rememberRole(userId, p.role);
  return { ok: true, role: p.role ?? "teacher", isActive: p.is_active !== false, activeDeviceId: p.active_device_id };
}

/** Decide where the saved login (if any) belongs. Signs out a deactivated user. */
export async function routeForSession(): Promise<SessionRoute> {
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user.id ?? null;
  if (!userId) return { route: null, reason: "no-session", userId: null };

  const access = await readAccess(userId);
  if (access.ok) {
    if (!access.isActive) {
      await supabase.auth.signOut();
      return { route: null, reason: "inactive", userId };
    }
    return { route: homeFor(access.role), reason: "ok", userId };
  }

  // Couldn't load the profile: keep them signed in, use what this phone knows
  const last = await rememberedRole(userId);
  return { route: last ? homeFor(last) : null, reason: "offline", userId };
}
