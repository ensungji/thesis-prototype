// supabase/functions/register-device/index.ts
// Braille D.O.T.S. — device registration at boot (AUDIT 3.4)
//
// ESP32 (firmware v7.3+, built with a DEVICE_SECRET) → POST
//   https://<project>.supabase.co/functions/v1/register-device
//   headers: Authorization: Bearer <anon key>, x-device-secret: <secret>
//   body:    {"device_code":"DOTS-0001"}
//
// Replaces the firmware's direct anon upsert into "devices". The device row
// must already exist (it does for every device that has booted before, or
// insert it by hand), and its secret hash must match device_secrets.
// Sets status = "connected" and returns the same shape the old REST call did:
//   [{ "id": "<uuid>", "paired_student_id": "<uuid or null>" }]
//
// Secrets: none beyond the built-in SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
// Optional: REQUIRE_DEVICE_SECRET=true (shared with grade-answer).

import { createClient } from "npm:@supabase/supabase-js@2";
import { checkDeviceSecret } from "../_shared/device-auth.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let code = "";
  try {
    const body = await req.json();
    code = typeof body?.device_code === "string" ? body.device_code.trim() : "";
  } catch {
    // fall through to the check below
  }
  if (!/^[A-Za-z0-9-]{1,32}$/.test(code)) return json({ error: "device_code required" }, 400);

  const { data: dev, error } = await admin
    .from("devices")
    .select("id, paired_student_id")
    .eq("device_code", code)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!dev) return json({ error: "unknown device" }, 403);

  const auth = await checkDeviceSecret(admin, dev.id, req);
  if (!auth.ok) {
    await admin.from("system_logs").insert({
      level: "warn",
      source: "server",
      event: "device_rejected",
      message: `register-device refused ${code}: ${auth.reason}`,
      device_id: dev.id,
      meta: {},
    });
    return json({ error: "forbidden" }, 403);
  }

  const { error: upErr } = await admin.from("devices").update({ status: "connected" }).eq("id", dev.id);
  if (upErr) return json({ error: upErr.message }, 500);

  return json([{ id: dev.id, paired_student_id: dev.paired_student_id }]);
});
