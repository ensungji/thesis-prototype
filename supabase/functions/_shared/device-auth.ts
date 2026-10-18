// supabase/functions/_shared/device-auth.ts
// Per-device secret check (AUDIT 3.4), shared by register-device and grade-answer.
//
// The device sends its secret in the "x-device-secret" header. The database
// keeps only its SHA-256 (table device_secrets, service role only).
//
// While devices are being reflashed, a device with NO stored secret is still
// let in, unless the edge-function secret REQUIRE_DEVICE_SECRET is "true".

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Same-length strings compared without stopping at the first difference
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type DeviceAuth =
  | { ok: true; legacy: boolean } // legacy = no secret stored for this device yet
  | { ok: false; reason: string };

export async function checkDeviceSecret(
  admin: SupabaseClient,
  deviceId: string,
  req: Request,
): Promise<DeviceAuth> {
  const { data, error } = await admin
    .from("device_secrets")
    .select("secret_hash")
    .eq("device_id", deviceId)
    .maybeSingle();

  if (error) {
    // Table missing = migration 13 not run yet: behave like "no secret stored"
    if (error.code !== "42P01" && error.code !== "PGRST205") {
      return { ok: false, reason: `secret lookup failed: ${error.message}` };
    }
  }

  if (!data) {
    if (Deno.env.get("REQUIRE_DEVICE_SECRET") === "true") {
      return { ok: false, reason: "no secret stored for this device" };
    }
    return { ok: true, legacy: true };
  }

  const secret = req.headers.get("x-device-secret") ?? "";
  if (!secret) return { ok: false, reason: "missing x-device-secret" };
  const hash = await sha256Hex(secret);
  if (!sameText(hash, String(data.secret_hash).toLowerCase())) {
    return { ok: false, reason: "wrong device secret" };
  }
  return { ok: true, legacy: false };
}
