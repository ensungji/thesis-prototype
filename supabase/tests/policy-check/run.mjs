// Runs the stub schema, every migration in order, then behaviour checks.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const migDir = process.argv[2];
const db = new PGlite();
let failures = 0;

const A = "aaaaaaaa-0000-0000-0000-000000000000";
const B = "bbbbbbbb-0000-0000-0000-000000000000";
const D = "dddddddd-0000-0000-0000-000000000000";

async function as(user, role, sql) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user ?? ""]);
  if (role) await db.exec(`set role ${role}`);
  try {
    return await db.query(sql);
  } finally {
    await db.exec("reset role");
  }
}

async function check(name, fn) {
  try {
    const msg = await fn();
    console.log(`PASS  ${name}${msg ? "  (" + msg + ")" : ""}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}
const expectError = async (p, re) => {
  try { await p; } catch (e) { if (!re || re.test(e.message)) return e.message; throw new Error("wrong error: " + e.message); }
  throw new Error("expected an error, got none");
};
const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };

await db.exec(readFileSync(new URL("./stub.sql", import.meta.url), "utf8"));

// ── migrations, in file order ────────────────────────────────────────────────
for (const f of readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()) {
  await check(`migration ${f}`, async () => { await db.exec(readFileSync(join(migDir, f), "utf8")); });
}
await check("LATER migration parses and runs (on the stub)", async () => {
  const f = readdirSync(migDir).find((f) => f.startsWith("LATER_"));
  await db.exec("begin");
  try {
    // stub lacks these policies; create them so the drops are real
    await db.exec(`create policy "esp32 insert devices" on devices for insert to anon with check (true);
                   create policy "esp32 update devices" on devices for update to anon using (true) with check (true);`);
    await db.exec(readFileSync(join(migDir, f), "utf8"));
  } finally { await db.exec("rollback"); }
});

// ── 01/02/03 profiles ────────────────────────────────────────────────────────
await check("teacher can't make themselves admin", () =>
  expectError(as(A, "authenticated", `update profiles set role = 'admin' where id = '${A}'`), /Only an admin/));
await check("teacher can't reactivate / change is_active", () =>
  expectError(as(A, "authenticated", `update profiles set is_active = false where id = '${A}'`), /Only an admin/));
await check("teacher can still edit their own name", async () => {
  const r = await as(A, "authenticated", `update profiles set full_name = 'Alice', active_device_id = 'x' where id = '${A}' returning id`);
  eq(r.rows.length, 1, "rows");
});
await check("admin can deactivate a teacher", async () => {
  const r = await as(D, "authenticated", `update profiles set is_active = false where id = '${B}' returning is_active`);
  eq(r.rows, [{ is_active: false }], "rows");
  await as(D, "authenticated", `update profiles set is_active = true where id = '${B}'`);
});
await check("SQL editor (no user) can promote by hand", async () => {
  await as(null, null, `update profiles set role = 'admin' where id = '${B}'`);
  await as(null, null, `update profiles set role = 'teacher' where id = '${B}'`);
});
await check("deactivated admin is not an admin", async () => {
  await as(null, null, `update profiles set is_active = false where id = '${D}'`);
  const r = await as(D, "authenticated", `select public.is_admin() as a, public.dots_is_admin() as b`);
  await as(null, null, `update profiles set is_active = true where id = '${D}'`);
  eq(r.rows, [{ a: false, b: false }], "is_admin");
});
await check("anon can no longer insert profiles", () =>
  expectError(as(null, "anon", `insert into profiles (id, role) values (gen_random_uuid(), 'admin')`), /row-level security/));
await check("sign-up with role=admin in metadata becomes a teacher", async () => {
  await as(null, null, `insert into auth.users values ('99999999-0000-0000-0000-000000000000', 'n@x', '{"role":"admin","full_name":"N"}')`);
  const r = await as(null, null, `select role, full_name from profiles where id = '99999999-0000-0000-0000-000000000000'`);
  eq(r.rows, [{ role: "teacher", full_name: "N" }], "profile");
});

// ── 04 dedupe ────────────────────────────────────────────────────────────────
await check("dedupe keeps the teacher's grade over newer voice answers (null graded_by ranks below it)", async () => {
  const r = await as(null, null, `select id from word_attempts where session_word_id = '11000000-0000-0000-0000-000000000000' and student_id is not null order by id`);
  eq(r.rows.map((x) => x.id), ["f1000000-0000-0000-0000-000000000000"], "kept");
  const l = await as(null, null, `select word_attempt_id from letter_attempts`);
  eq(l.rows, [{ word_attempt_id: "f1000000-0000-0000-0000-000000000000" }], "letter_attempts moved to kept row");
  const b = await as(null, null, `select count(*)::int as n from audit_backup.word_attempts_dupes_20261019`);
  eq(b.rows, [{ n: 2 }], "backup");
});
await check("dedupe leaves rows without a student alone", async () => {
  const r = await as(null, null, `select count(*)::int as n from word_attempts where student_id is null`);
  eq(r.rows, [{ n: 2 }], "student-less rows");
  await as(null, null, `delete from word_attempts where student_id is null`);
});
await check("second answer for the same word is now rejected (23505)", () =>
  expectError(as(null, null, `insert into word_attempts (student_id, session_word_id) values ('a1000000-0000-0000-0000-000000000000', '11000000-0000-0000-0000-000000000000')`), /duplicate key/));
await check("answers without a word id never clash", async () => {
  await as(null, null, `insert into word_attempts (student_id) values ('a2000000-0000-0000-0000-000000000000'), ('a2000000-0000-0000-0000-000000000000')`);
  await as(null, null, `delete from word_attempts where session_word_id is null`);
});

// ── 05 word_attempts policies + app hand-grade flow ──────────────────────────
await check("teacher can't regrade another class's answer", async () => {
  const r = await as(A, "authenticated", `update word_attempts set is_correct = false where id = 'f6000000-0000-0000-0000-000000000000' returning id`);
  eq(r.rows.length, 0, "rows updated");
});
await check("teacher can't insert an answer for another class's student", () =>
  expectError(as(A, "authenticated", `insert into word_attempts (student_id, graded_by) values ('b1000000-0000-0000-0000-000000000000', 'teacher')`), /row-level security/));
await check("hand grade: insert on conflict do nothing + update by pair", async () => {
  // DOG is a voice row: since migration 22 it can only be overridden once the session has ended
  await as(null, null, `update sessions set status = 'finished' where id = '5a000000-0000-0000-0000-000000000000'`);
  try { await handGradeDog(); } finally {
    await as(null, null, `update sessions set status = 'in_progress' where id = '5a000000-0000-0000-0000-000000000000'`);
  }
});
async function handGradeDog() {
  await as(A, "authenticated", `insert into word_attempts (id, student_id, session_word_id, is_correct, graded_by)
    values (gen_random_uuid(), 'a1000000-0000-0000-0000-000000000000', '12000000-0000-0000-0000-000000000000', true, 'teacher')
    on conflict (session_word_id, student_id) do nothing`);
  const r = await as(A, "authenticated", `update word_attempts set is_correct = true, needs_review = false, graded_by = 'teacher'
    where session_word_id = '12000000-0000-0000-0000-000000000000' and student_id = 'a1000000-0000-0000-0000-000000000000' returning id`);
  eq(r.rows.length, 1, "one row graded");
  // put DOG back to wrong for the stats test
  await as(null, null, `update word_attempts set is_correct = false, graded_by = 'auto' where id = 'f4000000-0000-0000-0000-000000000000'`);
}

// ── 06 storage ───────────────────────────────────────────────────────────────
await check("teacher reads only their own students' recordings", async () => {
  const r = await as(A, "authenticated", `select name from storage.objects`);
  eq(r.rows.map((x) => x.name), ["5a000000-0000-0000-0000-000000000000/a1000000-0000-0000-0000-000000000000/1_cat.wav"], "visible");
});

// ── 07/08 devices ────────────────────────────────────────────────────────────
await check("teacher sees own + free devices only", async () => {
  const r = await as(A, "authenticated", `select device_code from devices order by 1`);
  eq(r.rows.map((x) => x.device_code), ["DOTS-0001", "DOTS-0003"], "visible");
});
await check("pairing list: other class's device is taken, no student id", async () => {
  const r = await as(A, "authenticated", `select device_code, paired_student_id, taken from list_pairing_devices()`);
  eq(r.rows, [
    { device_code: "DOTS-0001", paired_student_id: "a1000000-0000-0000-0000-000000000000", taken: true },
    { device_code: "DOTS-0002", paired_student_id: null, taken: true },
    { device_code: "DOTS-0003", paired_student_id: null, taken: false },
  ], "list");
});
await check("claim a free device (releases the old one)", async () => {
  await as(A, "authenticated", `select claim_device('de300000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000')`);
  const r = await as(null, null, `select device_code, paired_student_id from devices order by 1`);
  eq(r.rows.map((x) => [x.device_code, x.paired_student_id]), [
    ["DOTS-0001", null], ["DOTS-0002", "b1000000-0000-0000-0000-000000000000"], ["DOTS-0003", "a1000000-0000-0000-0000-000000000000"]], "devices");
});
await check("device with another of MY students moves to this one", async () => {
  // DOTS-0003 is with Ana now; give it to Ben
  await as(A, "authenticated", `select claim_device('de300000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000')`);
  let r = await as(null, null, `select paired_student_id from devices where device_code = 'DOTS-0003'`);
  eq(r.rows, [{ paired_student_id: "a2000000-0000-0000-0000-000000000000" }], "moved to Ben");
  // and back to Ana (Ben then has none)
  await as(A, "authenticated", `select claim_device('de300000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000')`);
  r = await as(null, null, `select paired_student_id from devices where device_code = 'DOTS-0003'`);
  eq(r.rows, [{ paired_student_id: "a1000000-0000-0000-0000-000000000000" }], "back to Ana");
});
await check("claim an unknown device fails", () =>
  expectError(as(A, "authenticated", `select claim_device('00000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000')`), /no such device/));
await check("claiming another class's device fails and changes nothing", async () => {
  await expectError(as(A, "authenticated", `select claim_device('de200000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000')`), /already paired/);
  const r = await as(null, null, `select paired_student_id from devices where device_code = 'DOTS-0003'`);
  eq(r.rows, [{ paired_student_id: "a1000000-0000-0000-0000-000000000000" }], "old device still paired");
});
await check("claim for another class's student is refused", () =>
  expectError(as(A, "authenticated", `select claim_device('de100000-0000-0000-0000-000000000000', 'b1000000-0000-0000-0000-000000000000')`), /not your student/));
await check("direct unpair UPDATE no longer works", async () => {
  const r = await as(A, "authenticated", `update devices set paired_student_id = null where device_code = 'DOTS-0002' returning id`);
  eq(r.rows.length, 0, "rows");
});
await check("set_device_status: own device yes, other class's no", async () => {
  await as(A, "authenticated", `select set_device_status('de300000-0000-0000-0000-000000000000', 'connected')`);
  await as(A, "authenticated", `select set_device_status('de200000-0000-0000-0000-000000000000', 'offline')`);
  const r = await as(null, null, `select device_code, status from devices order by 1`);
  eq(r.rows.map((x) => x.status), ["connected", "connected", "connected"], "statuses");
});
await check("release_device", async () => {
  await as(A, "authenticated", `select release_device('a1000000-0000-0000-0000-000000000000')`);
  const r = await as(null, null, `select paired_student_id from devices where device_code = 'DOTS-0003'`);
  eq(r.rows, [{ paired_student_id: null }], "released");
  await as(null, null, `update devices set paired_student_id = 'a1000000-0000-0000-0000-000000000000' where device_code = 'DOTS-0001'`);
});
await check("anon can't call the device functions", () =>
  expectError(as(null, "anon", `select claim_device('de300000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000000')`), /permission denied/));
await check("anon still reads devices (firmware realtime)", async () => {
  const r = await as(null, "anon", `select count(*)::int as n from devices`);
  eq(r.rows, [{ n: 3 }], "anon rows");
});

// ── 09 word_library ──────────────────────────────────────────────────────────
await check("shared words: readable, not deletable", async () => {
  const r = await as(A, "authenticated", `select word from word_library order by 1`);
  eq(r.rows.map((x) => x.word), ["MINE", "SHARED"], "read");
  const d = await as(A, "authenticated", `delete from word_library where word = 'SHARED' returning id`);
  eq(d.rows.length, 0, "deleted");
  const o = await as(A, "authenticated", `delete from word_library where word = 'MINE' returning id`);
  eq(o.rows.length, 1, "own deleted");
});

// "Save to my Word Bank" (add-word / wordbank/new → lib/word-bank.ts saveWordToBank).
// OLD = the lookup the app used: .eq("word", "CAT").maybeSingle(); NEW = .ilike("word", "CAT").limit(1).
const bankOld = (w) => as(A, "authenticated", `select id from word_library where teacher_id = '${A}' and word = '${w}'`);
const bankNew = (w) => as(A, "authenticated", `select id from word_library where teacher_id = '${A}' and word ilike '${w}' limit 1`);
await check("word bank lookup: OLD misses the teacher's lowercase 'cat' when saving CAT; NEW finds it", async () => {
  await as(A, "authenticated", `insert into word_library (teacher_id, word) values ('${A}', 'cat')`);
  eq([(await bankOld("CAT")).rows.length, (await bankNew("CAT")).rows.length], [0, 1], "OLD / NEW rows");
  await as(null, null, `delete from word_library where teacher_id = '${A}'`);
});
await check("word bank lookup: with 2 copies, OLD gets 2 rows (maybeSingle errors, read as 'not in bank'); NEW gets 1", async () => {
  await as(A, "authenticated", `insert into word_library (teacher_id, word) values ('${A}', 'SUN'), ('${A}', 'SUN')`);
  eq([(await bankOld("SUN")).rows.length, (await bankNew("SUN")).rows.length], [2, 1], "OLD / NEW rows");
  await as(null, null, `delete from word_library where teacher_id = '${A}'`);
});
await check("word bank save: a shared word doesn't count as the teacher's; the teacher's insert passes RLS", async () => {
  eq((await bankNew("SHARED")).rows.length, 0, "shared counted as own");
  const r = await as(A, "authenticated", `insert into word_library (teacher_id, word, category, difficulty)
    values ('${A}', 'SHARED', 'My Words', 'hard') returning word`);
  eq(r.rows, [{ word: "SHARED" }], "saved");
  await expectError(as(A, "authenticated", `insert into word_library (teacher_id, word) values ('${B}', 'X')`), /row-level security/);
  await as(null, null, `delete from word_library where teacher_id = '${A}'`);
});

// ── 10 session_students ──────────────────────────────────────────────────────
await check("can't assign another class's student to your session", () =>
  expectError(as(A, "authenticated", `insert into session_students values ('5a000000-0000-0000-0000-000000000000', 'b1000000-0000-0000-0000-000000000000')`), /row-level security/));
await check("can assign your own student", async () => {
  await as(A, "authenticated", `insert into session_students values ('5a000000-0000-0000-0000-000000000000', 'a2000000-0000-0000-0000-000000000000')`);
});

// ── 11 stats ─────────────────────────────────────────────────────────────────
await check("teacher_student_stats: newest per word, review skipped", async () => {
  const r = await as(A, "authenticated", `select full_name, total, correct, avg_response_ms, streak from teacher_student_stats()`);
  // Ana: CAT = the kept teacher grade, correct (3000 ms), DOG wrong (4000 ms),
  // SUN needs review (skipped). streak: DOG (newest counted) is wrong → 0
  eq(r.rows, [
    { full_name: "Ana", total: 2, correct: 1, avg_response_ms: 3500, streak: 0 },
    { full_name: "Ben", total: 0, correct: 0, avg_response_ms: 0, streak: 0 },
  ], "stats");
});
await check("teacher_student_stats: streak counts newest correct in a row", async () => {
  await as(null, null, `update word_attempts set attempted_at = now() - interval '40 min' where id = 'f4000000-0000-0000-0000-000000000000'`);
  const r = await as(A, "authenticated", `select streak from teacher_student_stats() where full_name = 'Ana'`);
  eq(r.rows, [{ streak: 1 }], "streak");
});
await check("teacher_student_stats: period filter", async () => {
  const r = await as(A, "authenticated", `select total from teacher_student_stats(now() - interval '35 min') where full_name = 'Ana'`);
  eq(r.rows, [{ total: 1 }], "since");
});

// ── 12 reorder ───────────────────────────────────────────────────────────────
await check("reorder saves the whole order", async () => {
  await as(A, "authenticated", `select reorder_session_words('5a000000-0000-0000-0000-000000000000',
    array['13000000-0000-0000-0000-000000000000','11000000-0000-0000-0000-000000000000','12000000-0000-0000-0000-000000000000']::uuid[])`);
  const r = await as(null, null, `select word from session_words where session_id = '5a000000-0000-0000-0000-000000000000' order by order_index`);
  eq(r.rows.map((x) => x.word), ["SUN", "CAT", "DOG"], "order");
});
await check("reorder with a foreign id fails and saves nothing", async () => {
  await expectError(as(A, "authenticated", `select reorder_session_words('5a000000-0000-0000-0000-000000000000',
    array['11000000-0000-0000-0000-000000000000','1b000000-0000-0000-0000-000000000000']::uuid[])`), /reorder/);
  const r = await as(null, null, `select word from session_words where session_id = '5a000000-0000-0000-0000-000000000000' order by order_index`);
  eq(r.rows.map((x) => x.word), ["SUN", "CAT", "DOG"], "unchanged");
});
await check("teacher B can't reorder A's session", () =>
  expectError(as(B, "authenticated", `select reorder_session_words('5a000000-0000-0000-0000-000000000000',
    array['11000000-0000-0000-0000-000000000000']::uuid[])`), /reorder/));

// ── 13 device_secrets ────────────────────────────────────────────────────────
await check("device_secrets is invisible to anon and teachers", async () => {
  await as(null, null, `insert into device_secrets values ('de100000-0000-0000-0000-000000000000', 'abc')`);
  await expectError(as(null, "anon", `select * from device_secrets`), /permission denied/);
  await expectError(as(A, "authenticated", `select * from device_secrets`), /permission denied/);
});

// ── 14 session_words duration ────────────────────────────────────────────────
await check("word time defaults to 10 s and must stay within 5–60 s", async () => {
  const r = await as(null, null, `insert into session_words (session_id, word, order_index)
    values ('5a000000-0000-0000-0000-000000000000', 'BEE', 3) returning duration_seconds`);
  eq(r.rows, [{ duration_seconds: 10 }], "default");
  await as(null, null, `update session_words set duration_seconds = 30 where word = 'BEE' and session_id = '5a000000-0000-0000-0000-000000000000'`);
  await expectError(as(null, null, `update session_words set duration_seconds = 61 where word = 'BEE'`), /session_words_duration_range/);
  await expectError(as(null, null, `update session_words set duration_seconds = 4 where word = 'BEE'`), /session_words_duration_range/);
  await as(null, null, `delete from session_words where word = 'BEE' and session_id = '5a000000-0000-0000-0000-000000000000'`);
});

// ── 15 "No answer" rows (graded_by = 'missed') ───────────────────────────────
const ANA = "a1000000-0000-0000-0000-000000000000";
const BEN = "a2000000-0000-0000-0000-000000000000";
const CAT = "11000000-0000-0000-0000-000000000000";
const missedInsert = (student) => as(A, "authenticated", `insert into word_attempts
    (id, student_id, session_id, session_word_id, word, is_correct, needs_review, graded_by)
  values (gen_random_uuid(), '${student}', '5a000000-0000-0000-0000-000000000000', '${CAT}', 'CAT', false, false, 'missed')
  on conflict (session_word_id, student_id) do nothing`);
await check("a graded_by check that lists values gets 'missed' added", async () => {
  await as(null, null, `alter table word_attempts add constraint wa_graded_by_ck check (graded_by in ('auto', 'teacher'))`);
  await db.exec(readFileSync(join(migDir, "20261022120200_word_attempts_graded_by_missed.sql"), "utf8"));
  const r = await as(null, null, `select conname from pg_constraint where conrelid = 'word_attempts'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%graded_by%'`);
  eq(r.rows.map((x) => x.conname), ["word_attempts_graded_by_check"], "checks");
  await expectError(as(null, null, `update word_attempts set graded_by = 'bogus' where id = 'f4000000-0000-0000-0000-000000000000'`), /graded_by_check/);
  await missedInsert(BEN);
  await as(null, null, `delete from word_attempts where student_id = '${BEN}'`);
  await as(null, null, `alter table word_attempts drop constraint word_attempts_graded_by_check`);
});
await check("No answer: saved once per student and word", async () => {
  await missedInsert(BEN);
  await missedInsert(BEN); // a retry from the outbox
  const r = await as(null, null, `select graded_by, is_correct from word_attempts where student_id = '${BEN}'`);
  eq(r.rows, [{ graded_by: "missed", is_correct: false }], "rows");
});
await check("No answer never replaces an answer that's already there", async () => {
  await missedInsert(ANA); // Ana's CAT is the teacher's grade
  const r = await as(null, null, `select graded_by, is_correct from word_attempts where student_id = '${ANA}' and session_word_id = '${CAT}'`);
  eq(r.rows, [{ graded_by: "teacher", is_correct: true }], "Ana's CAT");
});
await check("No answer counts as wrong; a student with only No answer is in the stats", async () => {
  const r = await as(A, "authenticated", `select total, correct from teacher_student_stats() where full_name = 'Ben'`);
  eq(r.rows, [{ total: 1, correct: 0 }], "Ben");
});
await check("teacher can override a No answer row (matched on student + word)", async () => {
  const u = await as(A, "authenticated", `update word_attempts set is_correct = true, needs_review = false, graded_by = 'teacher'
    where session_word_id = '${CAT}' and student_id = '${BEN}' returning id`);
  eq(u.rows.length, 1, "rows");
  const r = await as(A, "authenticated", `select total, correct from teacher_student_stats() where full_name = 'Ben'`);
  eq(r.rows, [{ total: 1, correct: 1 }], "Ben");
  await as(null, null, `delete from word_attempts where student_id = '${BEN}'`);
});

// ── 16 + 25 activities: teachers own them, the admin only hides / unhides ────
// A = Alice (named above), the creator of "Animals"; B = another teacher; D = admin.
const ACT = "ac100000-0000-0000-0000-000000000000";
const ACT2 = "ac200000-0000-0000-0000-000000000000"; // A's empty draft
const visible = async (who, id) => {
  const a = await as(who, "authenticated", `select count(*)::int as n from activities where id = '${id}'`);
  const w = await as(who, "authenticated", `select count(*)::int as n from activity_words where activity_id = '${id}'`);
  return [a.rows[0].n, w.rows[0].n];
};
await check("teacher creates a draft; created_by, author_name and shared (false) are set by the database", async () => {
  const r = await as(A, "authenticated", `insert into activities (id, name, level, created_by, shared, author_name)
    values ('${ACT}', 'Animals', 'easy', '${D}', true, 'Fake') returning status, created_by, published_at, shared, author_name`);
  eq(r.rows, [{ status: "draft", created_by: A, published_at: null, shared: false, author_name: "Alice" }], "row");
});
await check("a new activity can't start as published", () =>
  expectError(as(A, "authenticated", `insert into activities (name, status) values ('X', 'published')`), /must start as a draft/));
await check("an admin can't create an activity", () =>
  expectError(as(D, "authenticated", `insert into activities (name) values ('X')`), /row-level security/));
await check("activity words: A-Z only, 1-40 letters, 5-60 s, default 20 s", async () => {
  const r = await as(A, "authenticated", `insert into activity_words (activity_id, position, word)
    values ('${ACT}', 0, 'CAT') returning duration_seconds`);
  eq(r.rows, [{ duration_seconds: 20 }], "default");
  await as(A, "authenticated", `insert into activity_words (activity_id, position, word, duration_seconds)
    values ('${ACT}', 1, 'DOG', 30), ('${ACT}', 2, 'SUN', 5)`);
  for (const [w, d] of [["cat", 20], ["CAT1", 20], ["", 20], ["A".repeat(41), 20], ["COW", 4], ["COW", 61]]) {
    await expectError(as(A, "authenticated", `insert into activity_words (activity_id, position, word, duration_seconds)
      values ('${ACT}', 9, '${w}', ${d})`), /activity_words_(word_check|duration_range)/);
  }
  await as(A, "authenticated", `insert into activity_words (activity_id, position, word) values ('${ACT}', 9, '${"A".repeat(40)}')`);
  await as(A, "authenticated", `delete from activity_words where activity_id = '${ACT}' and position = 9`);
});
await check("draft words can be reordered in one statement (swap positions)", async () => {
  await as(A, "authenticated", `update activity_words set position = 1 - position where activity_id = '${ACT}' and position in (0, 1)`);
  const r = await as(A, "authenticated", `select word from activity_words where activity_id = '${ACT}' order by position`);
  eq(r.rows.map((x) => x.word), ["DOG", "CAT", "SUN"], "order");
});
await check("a draft: another teacher sees nothing; the admin sees it and its words (overview)", async () => {
  eq([await visible(B, ACT), await visible(D, ACT)], [[0, 0], [1, 3]], "B / admin");
});
await check("a draft with no words can't be published; a draft can't be hidden or shared", async () => {
  await as(A, "authenticated", `insert into activities (id, name) values ('${ACT2}', 'Empty')`);
  await expectError(as(A, "authenticated", `update activities set status = 'published' where id = '${ACT2}'`), /at least one word/);
  await expectError(as(A, "authenticated", `update activities set status = 'hidden' where id = '${ACT2}'`), /Only an admin can hide/);
  await expectError(as(D, "authenticated", `update activities set status = 'hidden' where id = '${ACT2}'`), /admin can only hide or unhide a published/);
  await expectError(as(A, "authenticated", `update activities set shared = true where id = '${ACT}'`), /Only a published activity can be shared/);
  await expectError(as(null, null, `update activities set shared = true where id = '${ACT}'`), /activities_draft_not_shared|Only a published/);
});
await check("an admin can't edit, publish, add words to or delete a teacher's draft", async () => {
  await expectError(as(D, "authenticated", `update activities set name = 'Pets' where id = '${ACT}'`), /admin can only hide/);
  await expectError(as(D, "authenticated", `update activities set status = 'published' where id = '${ACT}'`), /admin can only hide/);
  await expectError(as(D, "authenticated", `insert into activity_words (activity_id, position, word) values ('${ACT}', 9, 'COW')`), /row-level security/);
  const uw = await as(D, "authenticated", `update activity_words set duration_seconds = 9 where activity_id = '${ACT}' returning id`);
  const d = await as(D, "authenticated", `delete from activities where id = '${ACT}' returning id`);
  eq([uw.rows.length, d.rows.length], [0, 0], "rows changed");
});
await check("publish sets published_at; private until shared; shared → another teacher sees it and its author", async () => {
  const p = await as(A, "authenticated", `update activities set status = 'published' where id = '${ACT}' returning published_at, shared`);
  if (!p.rows[0].published_at) throw new Error("published_at not set");
  eq(p.rows[0].shared, false, "shared after publish");
  eq(await visible(B, ACT), [0, 0], "B sees private");
  await as(A, "authenticated", `update activities set shared = true where id = '${ACT}'`);
  eq(await visible(B, ACT), [1, 3], "B sees shared");
  const r = await as(B, "authenticated", `select author_name from activities where id = '${ACT}'`);
  eq(r.rows, [{ author_name: "Alice" }], "author");
});
await check("publish and share in one update", async () => {
  const P = "ac210000-0000-0000-0000-000000000000";
  await as(A, "authenticated", `insert into activities (id, name) values ('${P}', 'One go')`);
  await as(A, "authenticated", `insert into activity_words (activity_id, position, word) values ('${P}', 0, 'GO')`);
  const r = await as(A, "authenticated", `update activities set status = 'published', shared = true where id = '${P}' returning status, shared`);
  eq(r.rows, [{ status: "published", shared: true }], "row");
  await as(null, null, `delete from activities where id = '${P}'`);
});
await check("published: no edits, no word changes, no going back to draft", async () => {
  await expectError(as(A, "authenticated", `update activities set name = 'Pets' where id = '${ACT}'`), /can't be edited/);
  await expectError(as(A, "authenticated", `update activities set published_at = now() - interval '1 day' where id = '${ACT}'`), /can't be edited/);
  await expectError(as(A, "authenticated", `update activities set status = 'draft' where id = '${ACT}'`), /back to draft/);
  await expectError(as(A, "authenticated", `insert into activity_words (activity_id, position, word) values ('${ACT}', 5, 'COW')`), /can't be changed/);
  await expectError(as(A, "authenticated", `update activity_words set duration_seconds = 10 where activity_id = '${ACT}'`), /can't be changed/);
  await expectError(as(A, "authenticated", `delete from activity_words where activity_id = '${ACT}'`), /can't be changed/);
  // the lock holds for the SQL editor / service role too
  await expectError(as(null, null, `update activities set name = 'Pets' where id = '${ACT}'`), /can't be edited/);
  await expectError(as(null, null, `update activity_words set word = 'COW' where activity_id = '${ACT}'`), /can't be changed/);
});
await check("a word can't be moved from a draft into a published activity", async () => {
  await as(A, "authenticated", `insert into activity_words (activity_id, position, word) values ('${ACT2}', 0, 'COW')`);
  return expectError(as(A, "authenticated", `update activity_words set activity_id = '${ACT}', position = 7
    where activity_id = '${ACT2}'`), /can't be changed/);
});
await check("published: its teacher can't delete or hide it; another teacher can't change, share or delete it", async () => {
  const d = await as(A, "authenticated", `delete from activities where id = '${ACT}' returning id`);
  await expectError(as(A, "authenticated", `update activities set status = 'hidden' where id = '${ACT}'`), /Only an admin can hide/);
  const bs = await as(B, "authenticated", `update activities set shared = false where id = '${ACT}' returning id`);
  const bh = await as(B, "authenticated", `update activities set status = 'hidden' where id = '${ACT}' returning id`);
  const bd = await as(B, "authenticated", `delete from activities where id = '${ACT}' returning id`);
  eq([d.rows.length, bs.rows.length, bh.rows.length, bd.rows.length], [0, 0, 0, 0], "rows changed");
});
await check("an admin can't delete a published activity or change its sharing", async () => {
  const d = await as(D, "authenticated", `delete from activities where id = '${ACT}' returning id`);
  eq(d.rows.length, 0, "rows deleted");
  await expectError(as(D, "authenticated", `update activities set shared = false where id = '${ACT}'`), /admin can only hide/);
});
await check("admin hides: hidden_at / hidden_by set; others stop seeing it; its teacher sees it but can't share, unhide or duplicate", async () => {
  const before = await as(null, null, `select published_at from activities where id = '${ACT}'`);
  const h = await as(D, "authenticated", `update activities set status = 'hidden' where id = '${ACT}' returning hidden_by, hidden_at is not null as at`);
  eq(h.rows, [{ hidden_by: D, at: true }], "hidden row");
  eq([await visible(B, ACT), await visible(A, ACT)], [[0, 0], [1, 3]], "B / A see");
  await expectError(as(A, "authenticated", `update activities set shared = false where id = '${ACT}'`), /Only a published activity can be shared/);
  await expectError(as(A, "authenticated", `update activities set status = 'published' where id = '${ACT}'`), /Only an admin can hide/);
  await expectError(as(A, "authenticated", `select duplicate_activity('${ACT}')`), /hidden activity can't be duplicated/);
  await expectError(as(D, "authenticated", `update activities set status = 'draft' where id = '${ACT}'`), /admin can only hide|back to draft/);
  const u = await as(D, "authenticated", `update activities set status = 'published' where id = '${ACT}'
    returning hidden_by, hidden_at, shared`);
  eq(u.rows, [{ hidden_by: null, hidden_at: null, shared: true }], "unhidden");
  const after = await as(null, null, `select published_at from activities where id = '${ACT}'`);
  eq(String(after.rows[0].published_at), String(before.rows[0].published_at), "published_at");
  eq(await visible(B, ACT), [1, 3], "B sees it again");
});
await check("a teacher deletes their own draft; its words go with it", async () => {
  const d = await as(A, "authenticated", `delete from activities where id = '${ACT2}' returning id`);
  eq(d.rows.length, 1, "deleted");
  const w = await as(null, null, `select count(*)::int as n from activity_words where activity_id = '${ACT2}'`);
  eq(w.rows, [{ n: 0 }], "words left");
});
await check("deleting the creator's profile keeps the published activity (created_by → null, author_name kept)", async () => {
  const E = "eeeeeeee-0000-0000-0000-000000000000";
  await as(null, null, `insert into profiles (id, role, full_name) values ('${E}', 'teacher', ' Eve ')`);
  await as(E, "authenticated", `insert into activities (id, name) values ('ac300000-0000-0000-0000-000000000000', 'Temp')`);
  await as(E, "authenticated", `insert into activity_words (activity_id, position, word) values ('ac300000-0000-0000-0000-000000000000', 0, 'HI')`);
  await as(E, "authenticated", `update activities set status = 'published' where id = 'ac300000-0000-0000-0000-000000000000'`);
  await as(null, null, `delete from profiles where id = '${E}'`);
  const r = await as(null, null, `select status, created_by, author_name from activities where id = 'ac300000-0000-0000-0000-000000000000'`);
  eq(r.rows, [{ status: "published", created_by: null, author_name: "Eve" }], "row");
  await as(null, null, `delete from activities where id = 'ac300000-0000-0000-0000-000000000000'`); // SQL editor may delete; words cascade
});
await check("anon can't read activities", () =>
  expectError(as(null, "anon", `select * from activities`), /permission denied/));

// ── 17 + 25 duplicate_activity ───────────────────────────────────────────────
await check("duplicate a published activity → the teacher's private draft with the same words", async () => {
  const r = await as(A, "authenticated", `select duplicate_activity('${ACT}') as id`);
  const id = r.rows[0].id;
  const a = await as(null, null, `select name, level, status, created_by, published_at, shared, author_name from activities where id = '${id}'`);
  eq(a.rows, [{ name: "Animals (copy)", level: "easy", status: "draft", created_by: A, published_at: null, shared: false, author_name: "Alice" }], "copy");
  const w = await as(null, null, `select position, word, duration_seconds from activity_words where activity_id = '${id}' order by position`);
  eq(w.rows, [
    { position: 0, word: "DOG", duration_seconds: 30 },
    { position: 1, word: "CAT", duration_seconds: 20 },
    { position: 2, word: "SUN", duration_seconds: 5 },
  ], "words");
  await as(A, "authenticated", `update activities set name = 'Pets' where id = '${id}'`);
  await as(A, "authenticated", `update activity_words set word = 'COW' where activity_id = '${id}' and position = 0`);
  const o = await as(null, null, `select word from activity_words where activity_id = '${ACT}' order by position`);
  eq(o.rows.map((x) => x.word), ["DOG", "CAT", "SUN"], "original unchanged");
  await as(A, "authenticated", `delete from activities where id = '${id}'`);
});
await check("duplicate keeps the name within 100 characters", async () => {
  await as(A, "authenticated", `insert into activities (id, name) values ('ac400000-0000-0000-0000-000000000000', '${"N".repeat(100)}')`);
  const r = await as(A, "authenticated", `select duplicate_activity('ac400000-0000-0000-0000-000000000000') as id`);
  const a = await as(null, null, `select char_length(name)::int as n, right(name, 7) as tail from activities where id = '${r.rows[0].id}'`);
  eq(a.rows, [{ n: 100, tail: " (copy)" }], "name");
  await as(null, null, `delete from activities where id in ('ac400000-0000-0000-0000-000000000000', '${r.rows[0].id}')`);
});
await check("duplicate: another teacher's copy of a shared one is their private draft; admin refused; unknown id refused; anon can't call it", async () => {
  const id = (await as(B, "authenticated", `select duplicate_activity('${ACT}') as id`)).rows[0].id;
  const a = await as(null, null, `select status, shared, created_by, author_name,
    (select count(*)::int from activity_words where activity_id = '${id}') as words from activities where id = '${id}'`);
  eq(a.rows, [{ status: "draft", shared: false, created_by: B, author_name: null, words: 3 }], "copy (B has no name)");
  await as(B, "authenticated", `delete from activities where id = '${id}'`);
  await expectError(as(D, "authenticated", `select duplicate_activity('${ACT}')`), /Only a teacher/);
  await expectError(as(A, "authenticated", `select duplicate_activity(gen_random_uuid())`), /No such activity/);
  await expectError(as(null, "anon", `select duplicate_activity('${ACT}')`), /permission denied/);
  const n = await as(null, null, `select count(*)::int as n from activities`);
  eq(n.rows, [{ n: 1 }], "no stray copies");
});

// ── 18 sessions: type 'activity' + columns ───────────────────────────────────
await check("session type: manual, word_list, activity allowed; live_session still refused (app fallback)", async () => {
  const r = await as(A, "authenticated", `insert into sessions (teacher_id, name, type) values
    ('${A}', 'm', 'manual'), ('${A}', 'w', 'word_list'), ('${A}', 'a', 'activity') returning current_index, activity_id`);
  eq(r.rows, [0, 0, 0].map((n) => ({ current_index: n, activity_id: null })), "rows");
  await expectError(as(A, "authenticated", `insert into sessions (teacher_id, name, type) values ('${A}', 'x', 'live_session')`), /sessions_type_check/);
  await expectError(as(A, "authenticated", `insert into sessions (teacher_id, name, type) values ('${A}', 'x', 'timed_sequence')`), /sessions_type_check/);
  await expectError(as(A, "authenticated", `update sessions set current_index = -1 where name = 'a'`), /sessions_current_index_check/);
  await as(null, null, `delete from sessions where name in ('m', 'w', 'a')`);
});
await check("deleting an activity keeps the session and its copied name and author (activity_id → null)", async () => {
  await as(A, "authenticated", `insert into activities (id, name) values ('ac500000-0000-0000-0000-000000000000', 'Gone')`);
  await as(A, "authenticated", `insert into activity_words (activity_id, position, word) values ('ac500000-0000-0000-0000-000000000000', 0, 'GO')`);
  await as(A, "authenticated", `update activities set status = 'published' where id = 'ac500000-0000-0000-0000-000000000000'`);
  await as(null, null, `insert into sessions (id, teacher_id, name, type, status, activity_id, activity_name, activity_author)
    values ('5c000000-0000-0000-0000-000000000000', '${A}', 'S', 'activity', 'finished', 'ac500000-0000-0000-0000-000000000000', 'Gone', 'Alice')`);
  await as(null, null, `delete from activities where id = 'ac500000-0000-0000-0000-000000000000'`);
  const r = await as(null, null, `select type, status, activity_id, activity_name, activity_author from sessions where id = '5c000000-0000-0000-0000-000000000000'`);
  eq(r.rows, [{ type: "activity", status: "finished", activity_id: null, activity_name: "Gone", activity_author: "Alice" }], "session");
  await as(null, null, `delete from sessions where id = '5c000000-0000-0000-0000-000000000000'`);
});

// ── 19 start_activity_session ────────────────────────────────────────────────
const SA = "5d000000-0000-0000-0000-000000000000"; // A's pending session
const startAct = (who, sess, act) => as(who, "authenticated", `select start_activity_session('${sess}', '${act}') as n`);
const sessionWords = (sess) => as(null, null,
  `select word, order_index, duration_seconds from session_words where session_id = '${sess}' order by order_index`);
await check("start: copies the words in order with their times, marks the session, copies name + author", async () => {
  await as(null, null, `insert into sessions (id, teacher_id, name) values ('${SA}', '${A}', 'Act run')`);
  const r = await startAct(A, SA, ACT);
  eq(r.rows, [{ n: 3 }], "returned");
  eq((await sessionWords(SA)).rows, [
    { word: "DOG", order_index: 0, duration_seconds: 30 },
    { word: "CAT", order_index: 1, duration_seconds: 20 },
    { word: "SUN", order_index: 2, duration_seconds: 5 },
  ], "session words");
  const s = await as(null, null, `select type, status, activity_id, activity_name, activity_author, current_index from sessions where id = '${SA}'`);
  eq(s.rows, [{ type: "activity", status: "pending", activity_id: ACT, activity_name: "Animals", activity_author: "Alice", current_index: 0 }], "session");
});
await check("start: a retry does nothing and returns the count again", async () => {
  eq((await startAct(A, SA, ACT)).rows, [{ n: 3 }], "returned");
  eq((await sessionWords(SA)).rows.length, 3, "words");
});
await check("start: another activity on a session that has words is refused", async () => {
  const id = (await as(A, "authenticated", `select duplicate_activity('${ACT}') as id`)).rows[0].id;
  await as(A, "authenticated", `update activities set status = 'published' where id = '${id}'`);
  await expectError(startAct(A, SA, id), /already has words/);
  await as(null, null, `delete from activities where id = '${id}'`);
});
await check("start: only the session's teacher; an admin never", async () => {
  await expectError(startAct(B, SA, ACT), /Not your session/);
  await expectError(startAct(D, SA, ACT), /Only a teacher can start/);
  await expectError(startAct(A, "00000000-0000-0000-0000-000000000000", ACT), /Not your session/);
  await expectError(as(null, "anon", `select start_activity_session('${SA}', '${ACT}')`), /permission denied/);
  await expectError(as(null, null, `select start_activity_session('${SA}', '${ACT}')`), /Not signed in/);
});
await check("start: draft / hidden / unknown activity refused, nothing copied", async () => {
  const S2 = "5e000000-0000-0000-0000-000000000000";
  await as(null, null, `insert into sessions (id, teacher_id, name) values ('${S2}', '${A}', 'Other')`);
  const draft = (await as(A, "authenticated", `select duplicate_activity('${ACT}') as id`)).rows[0].id;
  await expectError(startAct(A, S2, draft), /Only a published activity/);
  await as(D, "authenticated", `update activities set status = 'hidden' where id = '${ACT}'`);
  await expectError(startAct(A, S2, ACT), /Only a published activity/);
  await as(D, "authenticated", `update activities set status = 'published' where id = '${ACT}'`);
  await expectError(startAct(A, S2, "00000000-0000-0000-0000-000000000000"), /Only a published activity/);
  eq((await sessionWords(S2)).rows.length, 0, "words");
  const s = await as(null, null, `select type, activity_id from sessions where id = '${S2}'`);
  eq(s.rows, [{ type: "manual", activity_id: null }], "session unchanged");
  await as(null, null, `delete from activities where id = '${draft}'`);
  await as(null, null, `delete from sessions where id = '${S2}'`);
});
await check("start: a session that has started, or already has words, is refused", async () => {
  await expectError(startAct(A, "5a000000-0000-0000-0000-000000000000", ACT), /already started/); // in_progress
  const S3 = "5f000000-0000-0000-0000-000000000000";
  await as(null, null, `insert into sessions (id, teacher_id, name) values ('${S3}', '${A}', 'Has words')`);
  await as(null, null, `insert into session_words (session_id, word, order_index) values ('${S3}', 'BEE', 0)`);
  await expectError(startAct(A, S3, ACT), /already has words/);
  await as(null, null, `delete from sessions where id = '${S3}'`);
});
await check("start: gaps in positions → order_index 0, 1, 2", async () => {
  const G = "ac600000-0000-0000-0000-000000000000", S4 = "5f100000-0000-0000-0000-000000000000";
  await as(A, "authenticated", `insert into activities (id, name) values ('${G}', 'Gaps')`);
  await as(A, "authenticated", `insert into activity_words (activity_id, position, word) values ('${G}', 10, 'B'), ('${G}', 2, 'A'), ('${G}', 40, 'C')`);
  await as(A, "authenticated", `update activities set status = 'published' where id = '${G}'`);
  await as(null, null, `insert into sessions (id, teacher_id, name) values ('${S4}', '${A}', 'Gaps run')`);
  await startAct(A, S4, G);
  eq((await sessionWords(S4)).rows.map((x) => [x.word, x.order_index]), [["A", 0], ["B", 1], ["C", 2]], "order");
});
await check("hiding, then deleting, an activity leaves the session, its words and answers alone", async () => {
  const G = "ac600000-0000-0000-0000-000000000000", S4 = "5f100000-0000-0000-0000-000000000000";
  const sw = (await as(null, null, `select id from session_words where session_id = '${S4}' and order_index = 0`)).rows[0].id;
  await as(null, null, `insert into word_attempts (student_id, session_id, session_word_id, word, is_correct, audio_path)
    values ('${ANA}', '${S4}', '${sw}', 'A', true, '${S4}/${ANA}/1_a.wav')`);
  await as(D, "authenticated", `update activities set status = 'hidden' where id = '${G}'`);
  await as(null, null, `delete from activities where id = '${G}'`);
  const s = await as(null, null, `select activity_id, activity_name from sessions where id = '${S4}'`);
  eq(s.rows, [{ activity_id: null, activity_name: "Gaps" }], "session");
  eq((await sessionWords(S4)).rows.map((x) => x.word), ["A", "B", "C"], "words");
  const w = await as(null, null, `select word, is_correct, audio_path from word_attempts where session_id = '${S4}'`);
  eq(w.rows, [{ word: "A", is_correct: true, audio_path: `${S4}/${ANA}/1_a.wav` }], "answers");
  await as(null, null, `delete from word_attempts where session_id = '${S4}'`);
  await as(null, null, `delete from sessions where id = '${S4}'`);
});

// ── 20 answer_attempts ───────────────────────────────────────────────────────
const SW_A = "11000000-0000-0000-0000-000000000000"; // CAT in A's session 5a
const SW_B = "1b000000-0000-0000-0000-000000000000"; // BEE in B's session 5b
const BEA = "b1000000-0000-0000-0000-000000000000";
await check("answer_attempts: the service role inserts", async () => {
  await as(null, "service_role", `insert into answer_attempts (session_word_id, student_id, attempt_no, result, transcript)
    values ('${SW_A}', '${ANA}', 1, 'wrong', 'cap'), ('${SW_A}', '${ANA}', 2, 'correct', 'cat'),
           ('${SW_B}', '${BEA}', 1, 'review', '')`);
});
await check("answer_attempts: one row per try; result must be correct / wrong / review", async () => {
  await expectError(as(null, "service_role", `insert into answer_attempts (session_word_id, student_id, attempt_no, result)
    values ('${SW_A}', '${ANA}', 2, 'wrong')`), /answer_attempts_one_per_try/);
  await expectError(as(null, "service_role", `insert into answer_attempts (session_word_id, student_id, attempt_no, result)
    values ('${SW_A}', '${ANA}', 3, 'missed')`), /answer_attempts_result_check/);
  await expectError(as(null, "service_role", `insert into answer_attempts (session_word_id, student_id, attempt_no, result)
    values ('${SW_A}', '${ANA}', 0, 'wrong')`), /answer_attempts_attempt_no_check/);
  await expectError(as(null, "service_role", `insert into answer_attempts (session_word_id, student_id, attempt_no, result)
    values ('00000000-0000-0000-0000-000000000000', '${ANA}', 1, 'wrong')`), /foreign key/);
});
await check("answer_attempts: the session's teacher reads theirs, admin reads all, other teacher none", async () => {
  const a = await as(A, "authenticated", `select attempt_no, result from answer_attempts order by attempt_no`);
  eq(a.rows, [{ attempt_no: 1, result: "wrong" }, { attempt_no: 2, result: "correct" }], "teacher A");
  const b = await as(B, "authenticated", `select count(*)::int as n from answer_attempts where student_id = '${ANA}'`);
  eq(b.rows, [{ n: 0 }], "teacher B sees A's");
  const d = await as(D, "authenticated", `select count(*)::int as n from answer_attempts`);
  eq(d.rows, [{ n: 3 }], "admin");
});
await check("answer_attempts: teachers and admins can't write, anon can't read", async () => {
  await expectError(as(A, "authenticated", `insert into answer_attempts (session_word_id, student_id, attempt_no, result)
    values ('${SW_A}', '${ANA}', 9, 'correct')`), /permission denied/);
  await expectError(as(A, "authenticated", `update answer_attempts set result = 'correct'`), /permission denied/);
  await expectError(as(D, "authenticated", `delete from answer_attempts`), /permission denied/);
  await expectError(as(null, "anon", `select * from answer_attempts`), /permission denied/);
});
await check("answer_attempts: deleting a session deletes its tries, never blocks the delete", async () => {
  const S = "5f200000-0000-0000-0000-000000000000", W = "1f200000-0000-0000-0000-000000000000";
  await as(null, null, `insert into sessions (id, teacher_id, name) values ('${S}', '${A}', 'Temp')`);
  await as(null, null, `insert into session_words (id, session_id, word, order_index) values ('${W}', '${S}', 'HI', 0)`);
  await as(null, "service_role", `insert into answer_attempts (session_word_id, student_id, attempt_no, result) values ('${W}', '${ANA}', 1, 'wrong')`);
  const d = await as(A, "authenticated", `delete from sessions where id = '${S}' returning id`);
  eq(d.rows.length, 1, "session deleted");
  const n = await as(null, null, `select count(*)::int as n from answer_attempts where session_word_id = '${W}'`);
  eq(n.rows, [{ n: 0 }], "tries left");
});

// ── 21 word_attempts: tries, re-grade columns, checks, FK ────────────────────
const M21 = "20261111120600_word_attempts_tries_regrade.sql";
await check("migration 21 runs a second time (restores the checks the 15 re-run test removed)", async () => {
  await db.exec(readFileSync(join(migDir, M21), "utf8"));
  const r = await as(null, null, `select conname from pg_constraint where conrelid = 'word_attempts'::regclass
    and contype in ('c', 'f') order by 1`);
  eq(r.rows.map((x) => x.conname), [
    "word_attempts_graded_by_check", "word_attempts_original_graded_by_check", "word_attempts_regraded_by_fkey",
    "word_attempts_session_id_fkey", "word_attempts_session_word_id_fkey", "word_attempts_tries_check"], "constraints");
});
await check("graded_by: null, auto, teacher, missed, skipped allowed; anything else refused", async () => {
  for (const g of ["auto", "teacher", "missed", "skipped"]) {
    await as(null, null, `update word_attempts set graded_by = '${g}' where id = 'f4000000-0000-0000-0000-000000000000'`);
  }
  await as(null, null, `update word_attempts set graded_by = null where id = 'f4000000-0000-0000-0000-000000000000'`);
  await expectError(as(null, null, `update word_attempts set graded_by = 'bogus' where id = 'f4000000-0000-0000-0000-000000000000'`), /word_attempts_graded_by_check/);
  // (migration 22 keeps the re-grade columns from being written, so test the check without it)
  await db.exec(`alter table word_attempts disable trigger word_attempts_grading_lock`);
  try {
    await expectError(as(null, null, `update word_attempts set original_graded_by = 'bogus' where id = 'f4000000-0000-0000-0000-000000000000'`), /original_graded_by_check/);
  } finally { await db.exec(`alter table word_attempts enable trigger word_attempts_grading_lock`); }
  await expectError(as(null, null, `update word_attempts set tries = -1 where id = 'f4000000-0000-0000-0000-000000000000'`), /tries_check/);
  await as(null, null, `update word_attempts set graded_by = 'auto' where id = 'f4000000-0000-0000-0000-000000000000'`);
});
await check("tries: 0 by default, 1 for an existing row with a recording", async () => {
  await as(null, null, `insert into word_attempts (id, student_id, session_id, session_word_id, word, is_correct, audio_path)
    values ('f7000000-0000-0000-0000-000000000000', '${BEN}', '5a000000-0000-0000-0000-000000000000', '${SW_A}', 'CAT', false, 'x/y/1_cat.wav')`);
  eq((await as(null, null, `select tries from word_attempts where id = 'f7000000-0000-0000-0000-000000000000'`)).rows, [{ tries: 0 }], "new row");
  await db.exec(readFileSync(join(migDir, M21), "utf8"));
  const r = await as(null, null, `select id, tries from word_attempts where id in ('f7000000-0000-0000-0000-000000000000', 'f4000000-0000-0000-0000-000000000000') order by id`);
  eq(r.rows.map((x) => x.tries), [0, 1], "f4 (no recording) / f7 (recording)");
  await as(null, null, `delete from word_attempts where id = 'f7000000-0000-0000-0000-000000000000'`);
});
await check("session_word_id must be a real word", () =>
  expectError(as(null, null, `insert into word_attempts (student_id, session_word_id, word, is_correct)
    values ('${BEN}', '00000000-0000-0000-0000-000000000000', 'X', false)`), /word_attempts_session_word_id_fkey/));
await check("deleting a session keeps its answers (word + session ids emptied) and the stats don't change", async () => {
  const S = "5f300000-0000-0000-0000-000000000000", W1 = "1f310000-0000-0000-0000-000000000000", W2 = "1f320000-0000-0000-0000-000000000000";
  await as(null, null, `insert into sessions (id, teacher_id, name, status) values ('${S}', '${A}', 'Old', 'finished')`);
  await as(null, null, `insert into session_words (id, session_id, word, order_index) values ('${W1}', '${S}', 'HI', 0), ('${W2}', '${S}', 'GO', 1)`);
  await as(null, null, `insert into word_attempts (student_id, session_id, session_word_id, word, is_correct, response_time_ms, graded_by) values
    ('${BEN}', '${S}', '${W1}', 'HI', true, 1000, 'auto'), ('${BEN}', '${S}', '${W2}', 'GO', false, 3000, 'missed')`);
  await as(null, "service_role", `insert into answer_attempts (session_word_id, student_id, attempt_no, result) values ('${W1}', '${BEN}', 1, 'correct')`);
  const stats = () => as(A, "authenticated", `select total, correct, avg_response_ms, streak from teacher_student_stats() where full_name = 'Ben'`);
  const before = (await stats()).rows;
  eq(before, [{ total: 2, correct: 1, avg_response_ms: 2000, streak: 0 }], "before");
  const d = await as(A, "authenticated", `delete from sessions where id = '${S}' returning id`);
  eq(d.rows.length, 1, "deleted");
  eq((await stats()).rows, before, "stats after delete");
  const r = await as(null, null, `select word, session_id, session_word_id from word_attempts where student_id = '${BEN}' order by word`);
  eq(r.rows, [{ word: "GO", session_id: null, session_word_id: null }, { word: "HI", session_id: null, session_word_id: null }], "kept rows");
  const t = await as(null, null, `select count(*)::int as n from answer_attempts where student_id = '${BEN}'`);
  eq(t.rows, [{ n: 0 }], "tries removed with the words");
  await as(null, null, `delete from word_attempts where student_id = '${BEN}'`);
});

// ── 22 grading lock ──────────────────────────────────────────────────────────
// Session L (A's, in_progress) with words L1..L6; Ana answers.
const L = "5f400000-0000-0000-0000-000000000000";
const LW = (n) => `1f40000${n}-0000-0000-0000-000000000000`;
const LA = (n) => `fa40000${n}-0000-0000-0000-000000000000`; // Ana's row for word n
const row = async (n) => (await as(null, null, `select is_correct, needs_review, graded_by, tries, transcript,
  original_is_correct, original_graded_by, regraded_by, regraded_at is not null as regraded from word_attempts where id = '${LA(n)}'`)).rows[0];
// what grade-answer sends for a new voice answer
const voice = (n, result, tries, who = null) => as(who, who ? "authenticated" : null, `update word_attempts set
  is_correct = ${result === "correct" || result === "review-but-matched"}, needs_review = ${result.startsWith("review")},
  graded_by = 'auto', transcript = '${result} #${tries}', tries = ${tries}, attempted_at = now() where id = '${LA(n)}'`);
const teacherGrade = (n, correct) => as(A, "authenticated", `update word_attempts
  set is_correct = ${correct}, needs_review = false, graded_by = 'teacher' where id = '${LA(n)}' returning id`);
await check("lock setup: session + device answers", async () => {
  await as(null, null, `insert into sessions (id, teacher_id, name, status) values ('${L}', '${A}', 'Lock', 'in_progress')`);
  for (let n = 1; n <= 6; n++) {
    await as(null, null, `insert into session_words (id, session_id, word, order_index) values ('${LW(n)}', '${L}', 'W${n}', ${n})`);
  }
  // 1 voice correct, 2 voice wrong, 3 voice review, 4 missed, 5 skipped, 6 teacher
  await as(null, "service_role", `insert into word_attempts (id, student_id, session_id, session_word_id, word, is_correct, needs_review, graded_by, tries) values
    ('${LA(1)}', '${ANA}', '${L}', '${LW(1)}', 'W1', true,  false, 'auto', 1),
    ('${LA(2)}', '${ANA}', '${L}', '${LW(2)}', 'W2', false, false, 'auto', 1),
    ('${LA(3)}', '${ANA}', '${L}', '${LW(3)}', 'W3', true,  true,  'auto', 1),
    ('${LA(4)}', '${ANA}', '${L}', '${LW(4)}', 'W4', false, false, 'missed', 0),
    ('${LA(5)}', '${ANA}', '${L}', '${LW(5)}', 'W5', false, false, 'skipped', 0),
    ('${LA(6)}', '${ANA}', '${L}', '${LW(6)}', 'W6', true,  false, 'teacher', 0)`);
});
await check("teacher can't create a voice row (explicit 'auto' or the column default)", async () => {
  await expectError(as(A, "authenticated", `insert into word_attempts (student_id, session_id, word, is_correct, graded_by)
    values ('${BEN}', '${L}', 'X', true, 'auto')`), /Only the device/);
  await expectError(as(A, "authenticated", `insert into word_attempts (student_id, session_id, word, is_correct)
    values ('${BEN}', '${L}', 'X', true)`), /Only the device/);
});
await check("teacher insert: tries forced to 0, re-grade columns empty", async () => {
  const r = await as(A, "authenticated", `insert into word_attempts (student_id, session_id, word, is_correct, graded_by, tries, original_is_correct, regraded_at)
    values ('${BEN}', '${L}', 'X', true, 'teacher', 7, false, now()) returning tries, original_is_correct, regraded_at`);
  eq(r.rows, [{ tries: 0, original_is_correct: null, regraded_at: null }], "row");
  await as(null, null, `delete from word_attempts where student_id = '${BEN}'`);
});
await check("active session: teacher can't change voice rows (correct, wrong, review)", async () => {
  for (const n of [1, 2, 3]) {
    await expectError(teacherGrade(n, n !== 1), /locked until the session ends/);
  }
  await expectError(as(A, "authenticated", `update word_attempts set needs_review = false where id = '${LA(3)}'`), /locked until/);
});
await check("active session: missed / skipped / teacher rows stay editable, no re-grade history", async () => {
  for (const n of [4, 5, 6]) eq((await teacherGrade(n, n !== 6)).rows.length, 1, `row ${n}`);
  const r = await row(4);
  eq([r.graded_by, r.is_correct, r.original_is_correct, r.regraded], ["teacher", true, null, false], "W4");
  // the app's own hand grade flow on a voice row: the insert is skipped, the update refused
  await as(A, "authenticated", `insert into word_attempts (id, student_id, session_id, session_word_id, word, is_correct, graded_by)
    values (gen_random_uuid(), '${ANA}', '${L}', '${LW(2)}', 'W2', true, 'teacher') on conflict (session_word_id, student_id) do nothing`);
  await expectError(as(A, "authenticated", `update word_attempts set is_correct = true, needs_review = false, graded_by = 'teacher'
    where session_word_id = '${LW(2)}' and student_id = '${ANA}'`), /locked until/);
});
await check("teacher can only change the grade; tries / re-grade columns silently kept", async () => {
  await expectError(as(A, "authenticated", `update word_attempts set transcript = 'x' where id = '${LA(6)}'`), /only change the grade/);
  await expectError(as(A, "authenticated", `update word_attempts set word = 'X' where id = '${LA(6)}'`), /only change the grade/);
  await expectError(as(A, "authenticated", `update word_attempts set session_id = null where id = '${LA(1)}'`), /only change the grade/);
  await expectError(as(A, "authenticated", `update word_attempts set graded_by = 'auto' where id = '${LA(6)}'`), /Only the device/);
  await as(A, "authenticated", `update word_attempts set tries = 9, regraded_at = now(), original_is_correct = false where id = '${LA(6)}'`);
  const r = await row(6);
  eq([r.tries, r.regraded, r.original_is_correct], [0, false, null], "W6");
});
await check("device: unlimited retries while not correct (wrong → review → wrong)", async () => {
  await voice(2, "review", 2);
  await voice(2, "wrong", 3);
  const r = await row(2);
  eq([r.is_correct, r.needs_review, r.graded_by, r.tries, r.transcript], [false, false, "auto", 3, "wrong #3"], "W2");
});
await check("device: a review row with is_correct = true does NOT lock", async () => {
  await voice(3, "wrong", 2);
  eq((await row(3)).transcript, "wrong #2", "W3 replaced");
  await voice(3, "review-but-matched", 3);
  await voice(3, "correct", 4);
  const r = await row(3);
  eq([r.is_correct, r.needs_review, r.tries], [true, false, 4], "W3 now correct");
});
await check("device: voice-correct locks; a later voice answer is refused (DT001), tries may still go up", async () => {
  const e = await expectError(voice(1, "wrong", 2), /already correct/);
  const code = await db.query(`do $$ begin update word_attempts set is_correct = false where id = '${LA(1)}'; end $$`).catch((x) => x.code);
  eq(code, "DT001", "SQLSTATE");
  await as(null, null, `update word_attempts set tries = 2 where id = '${LA(1)}'`);
  const r = await row(1);
  eq([r.is_correct, r.graded_by, r.tries, r.transcript], [true, "auto", 2, null], "W1 kept");
  return e;
});
await check("device: replaces missed / skipped rows; keeps (adds to) a teacher's grade", async () => {
  await as(null, null, `update word_attempts set graded_by = 'missed', is_correct = false where id = '${LA(4)}'`); // back to No answer
  await voice(4, "wrong", 1);
  await as(null, null, `update word_attempts set graded_by = 'skipped', is_correct = false where id = '${LA(5)}'`);
  await voice(5, "correct", 1);
  await as(null, "service_role", `update word_attempts set transcript = 'heard', tries = 1 where id = '${LA(6)}'`);
  const r = [await row(4), await row(5), await row(6)].map((x) => [x.graded_by, x.is_correct]);
  eq(r, [["auto", false], ["auto", true], ["teacher", false]], "W4 W5 W6 (W6 = the teacher's 'wrong' from above)");
});
await check("the existing AFTER trigger still runs for allowed changes only", async () => {
  // stand-in for the live trg_log_teacher_grade (AFTER INSERT / UPDATE)
  await db.exec(`create table grade_log (wa uuid);
    create or replace function log_grade() returns trigger language plpgsql as $f$ begin
      if new.graded_by = 'teacher' then insert into grade_log values (new.id); end if; return new; end $f$;
    create trigger trg_log_teacher_grade after insert or update on word_attempts for each row execute function log_grade();
    grant all on grade_log to authenticated;`);
  await teacherGrade(6, false);                                   // allowed → logged
  await expectError(teacherGrade(2, true), /locked until/);       // refused → not logged
  const r = await as(null, null, `select wa from grade_log`);
  eq(r.rows.map((x) => x.wa), [LA(6)], "logged");
  await db.exec(`drop trigger trg_log_teacher_grade on word_attempts; drop table grade_log; drop function log_grade()`);
});
await check("session ended: first re-grade saves the original, later ones don't change it", async () => {
  await as(A, "authenticated", `update sessions set status = 'finished' where id = '${L}'`);
  eq((await teacherGrade(1, false)).rows.length, 1, "re-graded");
  let r = await row(1);
  eq([r.is_correct, r.graded_by, r.original_is_correct, r.original_graded_by, r.regraded_by, r.regraded],
     [false, "teacher", true, "auto", A, true], "after 1st");
  const at1 = (await as(null, null, `select regraded_at from word_attempts where id = '${LA(1)}'`)).rows[0].regraded_at;
  await teacherGrade(1, true);
  await as(A, "authenticated", `update word_attempts set is_correct = false, needs_review = true where id = '${LA(1)}'`);
  r = await row(1);
  const at2 = (await as(null, null, `select regraded_at from word_attempts where id = '${LA(1)}'`)).rows[0].regraded_at;
  eq([r.is_correct, r.needs_review, r.original_is_correct, r.original_graded_by, String(at2)],
     [false, true, true, "auto", String(at1)], "after 3rd");
});
await check("session ended: a voice row changed without graded_by becomes 'teacher' (re-grade recorded)", async () => {
  await as(A, "authenticated", `update word_attempts set is_correct = true where id = '${LA(2)}'`);
  const r = await row(2);
  eq([r.is_correct, r.graded_by, r.original_is_correct, r.original_graded_by], [true, "teacher", false, "auto"], "W2");
});
await check("session ended: the correct lock still holds for the device", async () => {
  await expectError(voice(5, "wrong", 2), /already correct/); // W5: voice-correct
  eq((await row(5)).is_correct, true, "W5 kept");
});
await check("SQL editor / device can't write the re-grade columns either", async () => {
  await as(null, null, `update word_attempts set original_is_correct = null, regraded_at = null where id = '${LA(1)}'`);
  const r = await row(1);
  eq([r.original_is_correct, r.regraded], [true, true], "kept");
});
await check("deleting the re-grader's profile empties regraded_by, keeps the rest", async () => {
  const E = "eeeeeeee-0000-0000-0000-000000000000", ST = "e1000000-0000-0000-0000-000000000000";
  await as(null, null, `insert into profiles (id, role) values ('${E}', 'teacher')`);
  await as(null, null, `insert into students (id, teacher_id, full_name) values ('${ST}', '${E}', 'Eve')`);
  await as(null, null, `insert into word_attempts (id, student_id, session_id, session_word_id, word, is_correct, graded_by)
    values ('fe000000-0000-0000-0000-000000000000', '${ST}', '${L}', '${LW(1)}', 'W1', true, 'auto')`);
  await as(E, "authenticated", `update word_attempts set is_correct = false, graded_by = 'teacher' where id = 'fe000000-0000-0000-0000-000000000000'`);
  await as(null, null, `delete from profiles where id = '${E}'`);
  const r = await as(null, null, `select is_correct, original_is_correct, regraded_by, regraded_at is not null as at from word_attempts where id = 'fe000000-0000-0000-0000-000000000000'`);
  eq(r.rows, [{ is_correct: false, original_is_correct: true, regraded_by: null, at: true }], "row");
  await as(null, null, `delete from students where id = '${ST}'`);
  await as(null, null, `delete from word_attempts where id = 'fe000000-0000-0000-0000-000000000000'`);
});
await check("teacher deletes an ACTIVE session: allowed, voice rows kept (ids emptied)", async () => {
  await as(A, "authenticated", `update sessions set status = 'paused' where id = '${L}'`);
  const d = await as(A, "authenticated", `delete from sessions where id = '${L}' returning id`);
  eq(d.rows.length, 1, "deleted");
  const r = await as(null, null, `select count(*)::int as n, count(session_id)::int as s, count(session_word_id)::int as w
    from word_attempts where id::text like 'fa40000%'`);
  eq(r.rows, [{ n: 6, s: 0, w: 0 }], "rows kept, ids emptied");
  await as(null, null, `delete from word_attempts where id::text like 'fa40000%'`);
});

// ── 23 reviewed_at + speech_grading_agreement ────────────────────────────────
await check("reviewed_at: only a finished session can be marked reviewed; the teacher sets it", async () => {
  await expectError(as(A, "authenticated", `update sessions set reviewed_at = now() where id = '5a000000-0000-0000-0000-000000000000'`),
    /sessions_reviewed_only_finished/); // 5a is in_progress
  const S = "5f500000-0000-0000-0000-000000000000";
  await as(null, null, `insert into sessions (id, teacher_id, name, status) values ('${S}', '${A}', 'Rev', 'finished')`);
  const r = await as(A, "authenticated", `update sessions set reviewed_at = now() where id = '${S}' returning reviewed_at is not null as ok`);
  eq(r.rows, [{ ok: true }], "teacher set it");
  const b = await as(B, "authenticated", `update sessions set reviewed_at = null where id = '${S}' returning id`);
  eq(b.rows.length, 0, "another teacher can't");
});
await check("speech_grading_agreement: admin only", async () => {
  await expectError(as(A, "authenticated", `select * from speech_grading_agreement()`), /Only an admin/);
  await expectError(as(null, "anon", `select * from speech_grading_agreement()`), /permission denied/);
});
await check("speech_grading_agreement: counts voice answers of reviewed sessions only", async () => {
  const S = "5f500000-0000-0000-0000-000000000000";   // finished + reviewed
  const U = "5f600000-0000-0000-0000-000000000000";   // finished, NOT reviewed
  await as(null, null, `insert into sessions (id, teacher_id, name, status) values ('${U}', '${A}', 'Unrev', 'finished')`);
  const W = (n) => `1f50000${n}-0000-0000-0000-000000000000`;
  for (let n = 1; n <= 7; n++) {
    await as(null, null, `insert into session_words (id, session_id, word, order_index) values ('${W(n)}', '${n === 7 ? U : S}', 'W${n}', ${n})`);
  }
  // device rows (service role): 1 correct, 2 wrong, 3 review, 4 correct, 5 wrong, 6 missed, 7 correct in the unreviewed session
  await as(null, "service_role", `insert into word_attempts (student_id, session_id, session_word_id, word, is_correct, needs_review, graded_by) values
    ('${ANA}', '${S}', '${W(1)}', 'W1', true,  false, 'auto'),
    ('${ANA}', '${S}', '${W(2)}', 'W2', false, false, 'auto'),
    ('${ANA}', '${S}', '${W(3)}', 'W3', true,  true,  'auto'),
    ('${ANA}', '${S}', '${W(4)}', 'W4', true,  false, 'auto'),
    ('${ANA}', '${S}', '${W(5)}', 'W5', false, false, 'auto'),
    ('${ANA}', '${S}', '${W(6)}', 'W6', false, false, 'missed'),
    ('${ANA}', '${U}', '${W(7)}', 'W7', true,  false, 'auto')`);
  // teacher re-grades after the end: W4 correct → wrong (disagree), W5 wrong → wrong + reviewed flag stays
  // (same result = agree), W6 missed → correct (not a voice answer)
  await as(A, "authenticated", `update word_attempts set is_correct = false, graded_by = 'teacher' where session_word_id = '${W(4)}'`);
  await as(A, "authenticated", `update word_attempts set is_correct = false, needs_review = false, graded_by = 'teacher' where session_word_id = '${W(5)}'`);
  await as(A, "authenticated", `update word_attempts set is_correct = true, graded_by = 'teacher' where session_word_id = '${W(6)}'`);
  const r = await as(D, "authenticated", `select * from speech_grading_agreement()`);
  // reviewed sessions: S only. voice: W1 W2 W4 W5 (W3 still review, W6 missed, W7 unreviewed) → 4, agreed W1 W2 W5 → 3
  eq(r.rows, [{ reviewed_sessions: 1, voice_answers: 4, agreed: 3, still_review: 1 }], "totals");
  await as(null, null, `delete from sessions where id in ('${S}', '${U}')`);
  await as(null, null, `delete from word_attempts where session_id is null and student_id = '${ANA}' and word like 'W_'`);
});

// ── 25 private activities, sharing, re-run ───────────────────────────────────
const TB = "ac700000-0000-0000-0000-000000000000"; // B's private activity
await check("25: B's private published activity: only B and admins see it; A can't start or duplicate it; B can run it", async () => {
  await as(B, "authenticated", `insert into activities (id, name) values ('${TB}', 'Mine')`);
  await as(B, "authenticated", `insert into activity_words (activity_id, position, word) values ('${TB}', 0, 'AB'), ('${TB}', 1, 'CD')`);
  await as(B, "authenticated", `update activities set status = 'published' where id = '${TB}'`);
  eq([await visible(B, TB), await visible(A, TB), await visible(D, TB)], [[1, 2], [0, 0], [1, 2]], "B / A / admin see");
  const SA2 = "5f700000-0000-0000-0000-000000000000", SB2 = "5f800000-0000-0000-0000-000000000000";
  await as(null, null, `insert into sessions (id, teacher_id, name) values ('${SA2}', '${A}', 'a'), ('${SB2}', '${B}', 'b')`);
  await expectError(startAct(A, SA2, TB), /Only a published activity/);
  await expectError(as(A, "authenticated", `select duplicate_activity('${TB}')`), /No such activity/);
  eq((await startAct(B, SB2, TB)).rows, [{ n: 2 }], "B's start");
  const s = await as(null, null, `select activity_author from sessions where id = '${SB2}'`);
  eq(s.rows, [{ activity_author: null }], "author (B has no name)");
  await as(null, null, `delete from sessions where id in ('${SA2}', '${SB2}')`);
});
await check("25: another teacher can't edit, add words to, or delete a teacher's draft, or move a word into it", async () => {
  const DR = "ac710000-0000-0000-0000-000000000000";
  await as(B, "authenticated", `insert into activities (id, name) values ('${DR}', 'Draft')`);
  await as(B, "authenticated", `insert into activity_words (activity_id, position, word) values ('${DR}', 0, 'EF')`);
  const u = await as(A, "authenticated", `update activities set name = 'Hacked' where id = '${DR}' returning id`);
  const uw = await as(A, "authenticated", `update activity_words set word = 'ZZ' where activity_id = '${DR}' returning id`);
  const dw = await as(A, "authenticated", `delete from activity_words where activity_id = '${DR}' returning id`);
  const d = await as(A, "authenticated", `delete from activities where id = '${DR}' returning id`);
  eq([u.rows.length, uw.rows.length, dw.rows.length, d.rows.length], [0, 0, 0, 0], "rows changed");
  await expectError(as(A, "authenticated", `insert into activity_words (activity_id, position, word) values ('${DR}', 5, 'GH')`), /row-level security/);
  await as(null, null, `delete from activities where id = '${DR}'`);
});
await check("25: un-sharing: other teachers can't start it any more; their earlier sessions keep their words", async () => {
  const SB = "5f810000-0000-0000-0000-000000000000", SB3 = "5f820000-0000-0000-0000-000000000000";
  await as(null, null, `insert into sessions (id, teacher_id, name) values ('${SB}', '${B}', 'b1'), ('${SB3}', '${B}', 'b2')`);
  eq((await startAct(B, SB, ACT)).rows, [{ n: 3 }], "B runs the shared one");
  await as(A, "authenticated", `update activities set shared = false where id = '${ACT}'`);
  await expectError(startAct(B, SB3, ACT), /Only a published activity/);
  eq((await sessionWords(SB)).rows.length, 3, "B's earlier session");
  const s = await as(null, null, `select activity_id, activity_name, activity_author from sessions where id = '${SB}'`);
  eq(s.rows, [{ activity_id: ACT, activity_name: "Animals", activity_author: "Alice" }], "session kept");
  await as(A, "authenticated", `update activities set shared = true where id = '${ACT}'`);
  await as(null, null, `delete from sessions where id in ('${SB}', '${SB3}')`);
});
await check("25 + 26: both migrations run again without changing anything", async () => {
  await db.exec(readFileSync(join(migDir, "20261112120100_teacher_owned_activities.sql"), "utf8"));
  await db.exec(readFileSync(join(migDir, "20261112120200_maintenance_mode.sql"), "utf8"));
  const r = await as(null, null, `select name, shared, author_name from activities where id in ('${ACT}', '${TB}') order by name`);
  eq(r.rows, [{ name: "Animals", shared: true, author_name: "Alice" }, { name: "Mine", shared: false, author_name: null }], "kept");
  const p = await as(null, null, `select count(*)::int as n from pg_policies where tablename in ('activities', 'activity_words')`);
  eq(p.rows, [{ n: 10 }], "policies");
  const a = await as(null, null, `select count(*)::int as n, bool_or(maintenance) as on from app_settings`);
  eq(a.rows, [{ n: 1, on: false }], "app_settings");
  // start_activity_session still has the maintenance check (26 runs after 25)
  const f = await as(null, null, `select prosrc like '%maintenance_blocks_me%' as ok from pg_proc where proname = 'start_activity_session'`);
  eq(f.rows, [{ ok: true }], "function");
});

// ── 26 maintenance mode ──────────────────────────────────────────────────────
const RUN = "5fa00000-0000-0000-0000-000000000000", PEND = "5fb00000-0000-0000-0000-000000000000";
const RUNW = "1fa00000-0000-0000-0000-000000000000";
const DRAFT = "ac900000-0000-0000-0000-000000000000";
const expectDT002 = async (p) => {
  try { await p; } catch (e) {
    if (e.code === "DT002" && /Maintenance mode is on/.test(e.message)) return;
    throw new Error(`wrong error: ${e.code} ${e.message}`);
  }
  throw new Error("expected DT002, got none");
};
await check("26: app_settings: signed-in users read the one row; only an admin changes it; anon nothing", async () => {
  eq((await as(A, "authenticated", `select maintenance from app_settings`)).rows, [{ maintenance: false }], "teacher reads");
  eq((await as(A, "authenticated", `update app_settings set maintenance = true returning id`)).rows.length, 0, "teacher update");
  await expectError(as(A, "authenticated", `insert into app_settings (id) values (true)`), /permission denied/);
  await expectError(as(A, "authenticated", `delete from app_settings`), /permission denied/);
  await expectError(as(null, "anon", `select * from app_settings`), /permission denied/);
  await expectError(as(null, null, `insert into app_settings (id) values (false)`), /app_settings_single_row/);
});
await check("26: setup before it's on: A's draft, a pending and a running session", async () => {
  await as(A, "authenticated", `insert into activities (id, name) values ('${DRAFT}', 'Maint draft')`);
  await as(null, null, `insert into sessions (id, teacher_id, name, status) values ('${PEND}', '${A}', 'pend', 'pending'), ('${RUN}', '${A}', 'run', 'in_progress')`);
  await as(null, null, `insert into session_words (id, session_id, word, order_index) values ('${RUNW}', '${RUN}', 'HAT', 0)`);
  await as(null, "service_role", `insert into word_attempts (student_id, session_id, session_word_id, word, is_correct, graded_by, tries)
    values ('${ANA}', '${RUN}', '${RUNW}', 'HAT', false, 'missed', 0)`);
});
await check("26: an admin turns it on: started_at / set_by set by the database, message trimmed, maintenance_on logged", async () => {
  const r = await as(D, "authenticated", `update app_settings set maintenance = true, maintenance_message = '  Back at 3  ',
    maintenance_set_by = '${A}', maintenance_started_at = '2000-01-01' returning maintenance_set_by, maintenance_message,
    maintenance_started_at > now() - interval '1 minute' as recent`);
  eq(r.rows, [{ maintenance_set_by: D, maintenance_message: "Back at 3", recent: true }], "row");
  const l = await as(null, null, `select level, source, event, message, user_id from system_logs where event like 'maintenance%'`);
  eq(l.rows, [{ level: "warn", source: "server", event: "maintenance_on", message: "Maintenance mode turned on: Back at 3", user_id: D }], "log");
  eq((await as(A, "authenticated", `select maintenance_on() as on, maintenance_blocks_me() as me`)).rows, [{ on: true, me: true }], "teacher");
  eq((await as(D, "authenticated", `select maintenance_blocks_me() as me`)).rows, [{ me: false }], "admin");
});
await check("26: teacher refused (DT002): create / start a session, start an activity", async () => {
  await expectDT002(as(A, "authenticated", `insert into sessions (teacher_id, name) values ('${A}', 'x')`));
  await expectDT002(as(A, "authenticated", `update sessions set status = 'in_progress', started_at = now() where id = '${PEND}'`));
  await expectDT002(as(A, "authenticated", `update sessions set status = 'paused' where id = '${PEND}'`));
  await expectDT002(startAct(A, PEND, ACT));
});
await check("26: teacher refused (DT002): create, edit, publish, share, delete, duplicate activities; any word change", async () => {
  await expectDT002(as(A, "authenticated", `insert into activities (name) values ('x')`));
  await expectDT002(as(A, "authenticated", `update activities set description = 'x' where id = '${DRAFT}'`));
  await expectDT002(as(A, "authenticated", `update activities set status = 'published' where id = '${DRAFT}'`));
  await expectDT002(as(A, "authenticated", `update activities set shared = false where id = '${ACT}'`));
  await expectDT002(as(A, "authenticated", `delete from activities where id = '${DRAFT}'`));
  await expectDT002(as(B, "authenticated", `select duplicate_activity('${ACT}')`));
  await expectDT002(as(A, "authenticated", `insert into activity_words (activity_id, position, word) values ('${DRAFT}', 0, 'HI')`));
});
await check("26: teacher can still read everything, and a started session carries on", async () => {
  eq((await visible(A, ACT))[0], 1, "reads activities");
  await as(A, "authenticated", `update sessions set current_index = 1 where id = '${RUN}'`);       // Next
  await as(A, "authenticated", `update sessions set status = 'paused' where id = '${RUN}'`);       // Pause
  await as(A, "authenticated", `update sessions set status = 'in_progress' where id = '${RUN}'`);  // Resume
  await as(A, "authenticated", `insert into session_words (session_id, word, order_index) values ('${RUN}', 'MAP', 1)`); // Live word
  eq((await as(A, "authenticated", `update word_attempts set is_correct = true, needs_review = false, graded_by = 'teacher'
    where session_word_id = '${RUNW}' returning id`)).rows.length, 1, "grade");
  await as(A, "authenticated", `update sessions set status = 'finished', finished_at = now() where id = '${RUN}'`); // Finish
  await as(A, "authenticated", `update sessions set reviewed_at = now() where id = '${RUN}'`);     // Done reviewing
  eq((await as(null, null, `select status from sessions where id = '${RUN}'`)).rows, [{ status: "finished" }], "finished");
});
await check("26: not blocked: the device (service role), the admin, the SQL editor", async () => {
  await as(null, "service_role", `insert into answer_attempts (session_word_id, student_id, attempt_no, result) values ('${RUNW}', '${ANA}', 1, 'wrong')`);
  await as(D, "authenticated", `update activities set status = 'hidden' where id = '${ACT}'`);
  await as(D, "authenticated", `update activities set status = 'published' where id = '${ACT}'`);
  await as(null, null, `update activities set description = 'by hand' where id = '${DRAFT}'`);
});
await check("26: an admin turns it off: maintenance_off logged, started_at cleared, set_by = who turned it off; teacher unblocked", async () => {
  const r = await as(D, "authenticated", `update app_settings set maintenance = false returning maintenance_started_at, maintenance_set_by, maintenance_message`);
  eq(r.rows, [{ maintenance_started_at: null, maintenance_set_by: D, maintenance_message: "Back at 3" }], "row");
  const l = await as(null, null, `select event, message from system_logs where event = 'maintenance_off'`);
  eq(l.rows, [{ event: "maintenance_off", message: "Maintenance mode turned off" }], "log");
  await as(A, "authenticated", `update sessions set status = 'in_progress', started_at = now() where id = '${PEND}'`);
  await as(A, "authenticated", `delete from activities where id = '${DRAFT}'`);
  await as(null, null, `delete from sessions where id in ('${RUN}', '${PEND}')`);
});
await check("26: changing only the message logs nothing; the SQL editor can switch it off in an emergency", async () => {
  await as(D, "authenticated", `update app_settings set maintenance = true`);
  await as(D, "authenticated", `update app_settings set maintenance_message = 'New text'`);
  await as(null, null, `update app_settings set maintenance = false`);
  const l = await as(null, null, `select event, user_id from system_logs where event like 'maintenance%' order by created_at, event`);
  eq(l.rows.map((x) => x.event).sort(), ["maintenance_off", "maintenance_off", "maintenance_on", "maintenance_on"], "logs");
  eq((await as(null, null, `select maintenance, maintenance_set_by from app_settings`)).rows, [{ maintenance: false, maintenance_set_by: null }], "off");
});

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
