// Supabase Edge Function: create-teacher (v2)
// Uses upsert so profile is always created even if trigger fails.
// Only an active admin may call it.

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

  // Who is calling? (supabase.functions.invoke sends the signed-in user's token)
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

  let body: { email?: string; password?: string; full_name?: string; title?: string; institution?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }
  const { email, password, full_name, title, institution } = body;

  // Create auth user
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name, role: "teacher" },
  });

  if (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...cors, "Content-Type": "application/json" }, status: 400 }
    );
  }

  // Upsert profile directly — doesn't rely on trigger
  if (data.user) {
    const { error: profileError } = await admin.from("profiles").upsert({
      id:          data.user.id,
      email:       data.user.email,
      full_name:   full_name || "",
      role:        "teacher",
      title:       title || null,
      institution: institution || null,
      is_active:   true,
    });

    if (profileError) {
      return new Response(
        JSON.stringify({ error: "User created but profile failed: " + profileError.message }),
        { headers: { ...cors, "Content-Type": "application/json" }, status: 500 }
      );
    }
  }

  return new Response(
    JSON.stringify({ user: data.user }),
    { headers: { ...cors, "Content-Type": "application/json" }, status: 200 }
  );
});