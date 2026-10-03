// Supabase Edge Function: reset-teacher-password
// Admin sets a new password directly for a teacher account.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const { teacherId, newPassword } = await req.json();

  if (!teacherId || !newPassword) {
    return new Response(
      JSON.stringify({ error: "teacherId and newPassword are required." }),
      { headers: { ...cors, "Content-Type": "application/json" }, status: 400 }
    );
  }

  if (newPassword.length < 8) {
    return new Response(
      JSON.stringify({ error: "Password must be at least 8 characters." }),
      { headers: { ...cors, "Content-Type": "application/json" }, status: 400 }
    );
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { error } = await admin.auth.admin.updateUserById(
    teacherId,
    { password: newPassword }
  );

  if (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...cors, "Content-Type": "application/json" }, status: 400 }
    );
  }

  return new Response(
    JSON.stringify({ success: true }),
    { headers: { ...cors, "Content-Type": "application/json" }, status: 200 }
  );
});
