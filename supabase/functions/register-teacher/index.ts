// Supabase Edge Function: register-teacher (v1)
// Teacher self-registration from the app's "Create an account" screen.
// Callable WITHOUT being signed in (the app sends the anon key, as for any
// function call). Public sign-ups in Supabase Auth stay OFF: only this
// function creates these accounts, with the service role.
//
// Body: { full_name, email, password, title?, institution? }
// Anything else in the body (role, is_active, pending_approval, ...) is
// ignored. A new account is ALWAYS:
//   role 'teacher', is_active false, pending_approval true,
//   login banned ("876000h", like a deactivated teacher) until the admin
//   approves it with set-teacher-active (activate).
//
// Safety net in the database (migration 28): the auth user is created with
// app_metadata.dots_signup = 'self', so the profile row starts as teacher /
// inactive / pending in the same transaction (trigger signup_starts_pending),
// even if a later step here fails. The ban is set when the user is created.
// If a later step fails, the account stays banned, the error is logged to
// system_logs, and nothing is deleted.
//
// Abuse checks: inputs trimmed, length limits, email format, duplicate email
// refused, at most MAX_PENDING_PER_HOUR new sign-ups per hour.
//
// Responses: 200 { ok: true } · 400 { error } (invalid input) ·
//            409 { error } (email taken) · 429 { error } · 500 { error }

import { createClient } from "npm:@supabase/supabase-js@2";

const BAN = "876000h"; // ~100 years, same as set-teacher-active
const MAX_PENDING_PER_HOUR = 20;
const LIMITS = { full_name: 100, email: 254, title: 50, institution: 150, passwordMin: 8, passwordMax: 72 };
// one @, something before and after, a dot in the domain, no spaces
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// control characters (line breaks, tabs, …) aren't allowed in names
const CONTROL_RE = /[\u0000-\u001F\u007F]/;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { headers: { ...cors, "Content-Type": "application/json" }, status });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function log(level: "info" | "warn" | "error", event: string, message: string, meta: Record<string, unknown> = {}, userId: string | null = null) {
  const { error } = await admin.from("system_logs").insert({
    level,
    source: "server",
    event,
    message: message.slice(0, 500),
    user_id: userId,
    meta,
  });
  if (error) console.error("log failed:", error.message);
}

/** Trimmed text, or "" (non-strings count as empty). */
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  // ── 1. Validate (only these five fields are ever read) ─────────────────────
  const fullName = text(body.full_name).replace(/\s+/g, " ");
  const email = text(body.email).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  const title = text(body.title).replace(/\s+/g, " ");
  const institution = text(body.institution).replace(/\s+/g, " ");

  if (fullName.length < 2) return json({ error: "Enter your full name." }, 400);
  if (fullName.length > LIMITS.full_name) return json({ error: `Full name: at most ${LIMITS.full_name} characters.` }, 400);
  if (!email || email.length > LIMITS.email || !EMAIL_RE.test(email)) return json({ error: "Enter a valid email address." }, 400);
  if (password.length < LIMITS.passwordMin) return json({ error: `Password: at least ${LIMITS.passwordMin} characters.` }, 400);
  if (password.length > LIMITS.passwordMax) return json({ error: `Password: at most ${LIMITS.passwordMax} characters.` }, 400);
  if (title.length > LIMITS.title) return json({ error: `Title: at most ${LIMITS.title} characters.` }, 400);
  if (institution.length > LIMITS.institution) return json({ error: `Institution: at most ${LIMITS.institution} characters.` }, 400);
  if ([fullName, title, institution].some((s) => CONTROL_RE.test(s))) return json({ error: "Names can't contain line breaks or tabs." }, 400);

  // ── 2. Abuse checks ────────────────────────────────────────────────────────
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const { count: recent, error: countErr } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("pending_approval", true)
    .gte("created_at", hourAgo);
  if (countErr) {
    await log("error", "signup_failed", `Sign-up check failed: ${countErr.message}`, { step: "rate_limit" });
    return json({ error: "Couldn't create the account right now. Try again later." }, 500);
  }
  if ((recent ?? 0) >= MAX_PENDING_PER_HOUR) {
    await log("warn", "signup_rate_limited", `Sign-up refused: ${recent} pending sign-ups in the last hour`, { email });
    return json({ error: "Too many sign-ups right now. Try again in an hour, or ask the admin to add you." }, 429);
  }

  // case-insensitive exact match (escape ilike's wildcards: "a_b@x.com" must not match "axb@x.com")
  const pattern = email.replace(/[\\%_]/g, (c) => "\\" + c);
  const { data: taken, error: takenErr } = await admin.from("profiles").select("id").ilike("email", pattern).limit(1);
  if (takenErr) {
    await log("error", "signup_failed", `Sign-up check failed: ${takenErr.message}`, { step: "duplicate_check" });
    return json({ error: "Couldn't create the account right now. Try again later." }, 500);
  }
  if (taken && taken.length > 0) return json({ error: "An account with this email already exists. Sign in, or contact the admin." }, 409);

  // ── 3. Auth user: banned and marked as a sign-up from the start ────────────
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    ban_duration: BAN,
    user_metadata: { full_name: fullName },
    app_metadata: { dots_signup: "self" }, // migration 28: profile starts pending
  });
  if (createErr || !created?.user) {
    const msg = createErr?.message ?? "no user returned";
    if (/already|exists|registered/i.test(msg)) {
      return json({ error: "An account with this email already exists. Sign in, or contact the admin." }, 409);
    }
    if (/password/i.test(msg)) return json({ error: msg }, 400);
    await log("error", "signup_failed", `Sign-up: auth user not created: ${msg}`, { step: "create_user", email });
    return json({ error: "Couldn't create the account right now. Try again later." }, 500);
  }
  const user = created.user;

  // The ban must be in place before anything else (normally set by createUser)
  if (!user.banned_until || new Date(user.banned_until).getTime() <= Date.now()) {
    const { error: banErr } = await admin.auth.admin.updateUserById(user.id, { ban_duration: BAN });
    if (banErr) {
      await log("error", "signup_not_locked",
        `Sign-up ${email}: the login could NOT be banned (${banErr.message}). The profile is inactive / pending; ban it by hand (Authentication → Users) or approve / deactivate it in the Admin Panel.`,
        { step: "ban", email }, user.id);
      return json({ error: "Your account was created but isn't set up completely. Contact the admin." }, 500);
    }
  }

  // ── 4. Profile: always teacher / inactive / pending (never from the body) ──
  const { error: profErr } = await admin.from("profiles").upsert({
    id: user.id,
    email,
    full_name: fullName,
    title: title || null,
    institution: institution || null,
    role: "teacher",
    is_active: false,
    pending_approval: true,
  });
  if (profErr) {
    // The login stays banned; the profile (if handle_new_user made it) is
    // already teacher / inactive / pending through migration 28. Nothing deleted.
    await log("error", "signup_profile_failed",
      `Sign-up ${email}: account created and banned, but the profile wasn't saved (${profErr.message}).`,
      { step: "profile", email }, user.id);
    return json({ error: "Your account was created but isn't set up completely. Contact the admin." }, 500);
  }

  await log("info", "teacher_signup", `New teacher sign-up waiting for approval: ${fullName} (${email})`, { email }, user.id);
  return json({ ok: true }, 200);
});
