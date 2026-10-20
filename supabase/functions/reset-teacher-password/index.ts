// Supabase Edge Function: reset-teacher-password
// Admin sets a new password directly for a teacher account.
// Only an active admin may call it, and only teacher accounts can be reset.

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

  // 1. Who is calling? (supabase.functions.invoke sends the signed-in user's token)
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: userData } = await admin.auth.getUser(token);
  const caller = userData?.user;
  if (!caller) return json({ error: "Not signed in." }, 401);

  // 2. Caller must be an active admin
  const { data: me } = await admin
    .from("profiles")
    .select("role, is_active")
    .eq("id", caller.id)
    .maybeSingle();
  if (me?.role !== "admin" || me.is_active === false) {
    return json({ error: "Admins only." }, 403);
  }

  let body: { teacherId?: unknown; newPassword?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "teacherId and newPassword are required." }, 400);
  }
  const { teacherId, newPassword } = body;

  if (typeof teacherId !== "string" || !teacherId || typeof newPassword !== "string" || !newPassword) {
    return json({ error: "teacherId and newPassword are required." }, 400);
  }

  if (newPassword.length < 8) {
    return json({ error: "Password must be at least 8 characters." }, 400);
  }

  // 3. Target must be a teacher (an admin can't be reset through here)
  const { data: target } = await admin
    .from("profiles")
    .select("role")
    .eq("id", teacherId)
    .maybeSingle();
  if (target?.role !== "teacher") return json({ error: "Not a teacher account." }, 403);

  const { error } = await admin.auth.admin.updateUserById(teacherId, { password: newPassword });

  if (error) return json({ error: error.message }, 400);

  return json({ success: true }, 200);
});
