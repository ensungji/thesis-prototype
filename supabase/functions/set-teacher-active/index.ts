// Supabase Edge Function: set-teacher-active
// Admin activates or deactivates a teacher account (AUDIT 3.3).
//
// Deactivating also BANS the login, so the teacher's token can't be refreshed
// and they can't sign in again. A token they already hold stays valid until it
// expires (at most 1 hour). Activating lifts the ban.
//
// Body: { teacherId: string, active: boolean }
// Only an active admin may call it, and only teacher accounts can be changed.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      headers: { ...cors, "Content-Type": "application/json" },
      status,
    });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Who is calling?
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: userData } = await admin.auth.getUser(token);
  const caller = userData?.user;
  if (!caller) return json({ error: "Not signed in." }, 401);

  // Caller must be an active admin
  const { data: me } = await admin
    .from("profiles")
    .select("role, is_active")
    .eq("id", caller.id)
    .maybeSingle();
  if (me?.role !== "admin" || me.is_active === false) {
    return json({ error: "Admins only." }, 403);
  }

  let body: { teacherId?: unknown; active?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "teacherId and active are required." }, 400);
  }
  const { teacherId, active } = body;
  if (typeof teacherId !== "string" || !teacherId || typeof active !== "boolean") {
    return json({ error: "teacherId and active are required." }, 400);
  }

  // Target must be a teacher
  const { data: target } = await admin
    .from("profiles")
    .select("role")
    .eq("id", teacherId)
    .maybeSingle();
  if (target?.role !== "teacher") return json({ error: "Not a teacher account." }, 403);

  // 1. Login ban first: if this fails, nothing has changed yet
  const { error: banErr } = await admin.auth.admin.updateUserById(teacherId, {
    ban_duration: active ? "none" : "876000h", // ~100 years
  });
  if (banErr) return json({ error: banErr.message }, 400);

  // 2. Profile flag (service role: allowed by the profile guard trigger)
  const { error: profErr } = await admin
    .from("profiles")
    .update({ is_active: active })
    .eq("id", teacherId);
  if (profErr) {
    // undo the ban change so login and profile agree
    await admin.auth.admin.updateUserById(teacherId, {
      ban_duration: active ? "876000h" : "none",
    });
    return json({ error: profErr.message }, 500);
  }

  return json({ success: true, active }, 200);
});
