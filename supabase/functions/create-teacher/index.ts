// Supabase Edge Function: create-teacher (v2)
// Uses upsert so profile is always created even if trigger fails.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const { email, password, full_name, title, institution } = await req.json();

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

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