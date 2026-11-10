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
  expectError(as(A, "authenticated", `insert into word_attempts (student_id) values ('b1000000-0000-0000-0000-000000000000')`), /row-level security/));
await check("hand grade: insert on conflict do nothing + update by pair", async () => {
  await as(A, "authenticated", `insert into word_attempts (id, student_id, session_word_id, is_correct, graded_by)
    values (gen_random_uuid(), 'a1000000-0000-0000-0000-000000000000', '12000000-0000-0000-0000-000000000000', true, 'teacher')
    on conflict (session_word_id, student_id) do nothing`);
  const r = await as(A, "authenticated", `update word_attempts set is_correct = true, needs_review = false, graded_by = 'teacher'
    where session_word_id = '12000000-0000-0000-0000-000000000000' and student_id = 'a1000000-0000-0000-0000-000000000000' returning id`);
  eq(r.rows.length, 1, "one row graded");
  // put DOG back to wrong for the stats test
  await as(null, null, `update word_attempts set is_correct = false, graded_by = 'auto' where id = 'f4000000-0000-0000-0000-000000000000'`);
});

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
  const r = await as(null, null, `select conname from pg_constraint where conrelid = 'word_attempts'::regclass and contype = 'c'`);
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

// ── 16 activities ────────────────────────────────────────────────────────────
const ACT = "ac100000-0000-0000-0000-000000000000";
await check("admin creates a draft; created_by is the admin, whatever was sent", async () => {
  const r = await as(D, "authenticated", `insert into activities (id, name, level, created_by)
    values ('${ACT}', 'Animals', 'easy', '${A}') returning status, created_by, published_at`);
  eq(r.rows, [{ status: "draft", created_by: D, published_at: null }], "row");
});
await check("a new activity can't start as published", () =>
  expectError(as(D, "authenticated", `insert into activities (name, status) values ('X', 'published')`), /must start as a draft/));
await check("teacher can't create an activity", () =>
  expectError(as(A, "authenticated", `insert into activities (name) values ('X')`), /row-level security/));
await check("activity words: A-Z only, 1-40 letters, 5-60 s, default 20 s", async () => {
  const r = await as(D, "authenticated", `insert into activity_words (activity_id, position, word)
    values ('${ACT}', 0, 'CAT') returning duration_seconds`);
  eq(r.rows, [{ duration_seconds: 20 }], "default");
  await as(D, "authenticated", `insert into activity_words (activity_id, position, word, duration_seconds)
    values ('${ACT}', 1, 'DOG', 30), ('${ACT}', 2, 'SUN', 5)`);
  for (const [w, d] of [["cat", 20], ["CAT1", 20], ["", 20], ["A".repeat(41), 20], ["COW", 4], ["COW", 61]]) {
    await expectError(as(D, "authenticated", `insert into activity_words (activity_id, position, word, duration_seconds)
      values ('${ACT}', 9, '${w}', ${d})`), /activity_words_(word_check|duration_range)/);
  }
  await as(D, "authenticated", `insert into activity_words (activity_id, position, word) values ('${ACT}', 9, '${"A".repeat(40)}')`);
  await as(D, "authenticated", `delete from activity_words where activity_id = '${ACT}' and position = 9`);
});
await check("draft words can be reordered in one statement (swap positions)", async () => {
  await as(D, "authenticated", `update activity_words set position = 1 - position where activity_id = '${ACT}' and position in (0, 1)`);
  const r = await as(D, "authenticated", `select word from activity_words where activity_id = '${ACT}' order by position`);
  eq(r.rows.map((x) => x.word), ["DOG", "CAT", "SUN"], "order");
});
await check("teacher sees no drafts", async () => {
  const r = await as(A, "authenticated", `select count(*)::int as n from activities`);
  const w = await as(A, "authenticated", `select count(*)::int as n from activity_words`);
  eq([r.rows[0].n, w.rows[0].n], [0, 0], "visible");
});
await check("a draft with no words can't be published; a draft can't be hidden", async () => {
  await as(D, "authenticated", `insert into activities (id, name) values ('ac200000-0000-0000-0000-000000000000', 'Empty')`);
  await expectError(as(D, "authenticated", `update activities set status = 'published' where id = 'ac200000-0000-0000-0000-000000000000'`), /at least one word/);
  await expectError(as(D, "authenticated", `update activities set status = 'hidden' where id = 'ac200000-0000-0000-0000-000000000000'`), /before hiding/);
});
await check("publish sets published_at; teacher then reads it and its words", async () => {
  const p = await as(D, "authenticated", `update activities set status = 'published' where id = '${ACT}' returning published_at`);
  if (!p.rows[0].published_at) throw new Error("published_at not set");
  const r = await as(A, "authenticated", `select name from activities`);
  const w = await as(A, "authenticated", `select count(*)::int as n from activity_words`);
  eq([r.rows.map((x) => x.name), w.rows[0].n], [["Animals"], 3], "visible");
});
await check("published: no edits, no word changes, no going back to draft", async () => {
  await expectError(as(D, "authenticated", `update activities set name = 'Pets' where id = '${ACT}'`), /can't be edited/);
  await expectError(as(D, "authenticated", `update activities set published_at = now() - interval '1 day' where id = '${ACT}'`), /can't be edited/);
  await expectError(as(D, "authenticated", `update activities set status = 'draft' where id = '${ACT}'`), /back to draft/);
  await expectError(as(D, "authenticated", `insert into activity_words (activity_id, position, word) values ('${ACT}', 5, 'COW')`), /can't be changed/);
  await expectError(as(D, "authenticated", `update activity_words set duration_seconds = 10 where activity_id = '${ACT}'`), /can't be changed/);
  await expectError(as(D, "authenticated", `delete from activity_words where activity_id = '${ACT}'`), /can't be changed/);
  // the lock holds for the SQL editor / service role too
  await expectError(as(null, null, `update activities set name = 'Pets' where id = '${ACT}'`), /can't be edited/);
  await expectError(as(null, null, `update activity_words set word = 'COW' where activity_id = '${ACT}'`), /can't be changed/);
});
await check("a word can't be moved from a draft into a published activity", async () => {
  await as(D, "authenticated", `insert into activity_words (activity_id, position, word) values ('ac200000-0000-0000-0000-000000000000', 0, 'COW')`);
  return expectError(as(D, "authenticated", `update activity_words set activity_id = '${ACT}', position = 7
    where activity_id = 'ac200000-0000-0000-0000-000000000000'`), /can't be changed/);
});
await check("teacher can't change or delete a published activity", async () => {
  const u = await as(A, "authenticated", `update activities set status = 'hidden' where id = '${ACT}' returning id`);
  const d = await as(A, "authenticated", `delete from activities where id = '${ACT}' returning id`);
  eq([u.rows.length, d.rows.length], [0, 0], "rows");
});
await check("admin can't delete a published activity (hide it instead)", async () => {
  const d = await as(D, "authenticated", `delete from activities where id = '${ACT}' returning id`);
  eq(d.rows.length, 0, "rows deleted");
});
await check("hide → teachers no longer see it; un-hide keeps the first published_at", async () => {
  const before = await as(null, null, `select published_at from activities where id = '${ACT}'`);
  await as(D, "authenticated", `update activities set status = 'hidden' where id = '${ACT}'`);
  const r = await as(A, "authenticated", `select count(*)::int as n from activities`);
  const w = await as(A, "authenticated", `select count(*)::int as n from activity_words`);
  eq([r.rows[0].n, w.rows[0].n], [0, 0], "teacher sees");
  await expectError(as(D, "authenticated", `update activities set status = 'draft' where id = '${ACT}'`), /back to draft/);
  await as(D, "authenticated", `update activities set status = 'published' where id = '${ACT}'`);
  const after = await as(null, null, `select published_at from activities where id = '${ACT}'`);
  eq(String(after.rows[0].published_at), String(before.rows[0].published_at), "published_at");
});
await check("admin deletes a draft; its words go with it", async () => {
  const d = await as(D, "authenticated", `delete from activities where id = 'ac200000-0000-0000-0000-000000000000' returning id`);
  eq(d.rows.length, 1, "deleted");
  const w = await as(null, null, `select count(*)::int as n from activity_words where activity_id = 'ac200000-0000-0000-0000-000000000000'`);
  eq(w.rows, [{ n: 0 }], "words left");
});
await check("deleting the creator's profile keeps the published activity (created_by → null)", async () => {
  const E = "eeeeeeee-0000-0000-0000-000000000000";
  await as(null, null, `insert into profiles (id, role) values ('${E}', 'admin')`);
  await as(E, "authenticated", `insert into activities (id, name) values ('ac300000-0000-0000-0000-000000000000', 'Temp')`);
  await as(E, "authenticated", `insert into activity_words (activity_id, position, word) values ('ac300000-0000-0000-0000-000000000000', 0, 'HI')`);
  await as(E, "authenticated", `update activities set status = 'published' where id = 'ac300000-0000-0000-0000-000000000000'`);
  await as(null, null, `delete from profiles where id = '${E}'`);
  const r = await as(null, null, `select status, created_by from activities where id = 'ac300000-0000-0000-0000-000000000000'`);
  eq(r.rows, [{ status: "published", created_by: null }], "row");
  await as(null, null, `delete from activities where id = 'ac300000-0000-0000-0000-000000000000'`); // SQL editor may delete; words cascade
});
await check("anon can't read activities", () =>
  expectError(as(null, "anon", `select * from activities`), /permission denied/));

// ── 17 duplicate_activity ────────────────────────────────────────────────────
await check("duplicate a published activity → editable draft with the same words", async () => {
  const r = await as(D, "authenticated", `select duplicate_activity('${ACT}') as id`);
  const id = r.rows[0].id;
  const a = await as(null, null, `select name, level, status, created_by, published_at from activities where id = '${id}'`);
  eq(a.rows, [{ name: "Animals (copy)", level: "easy", status: "draft", created_by: D, published_at: null }], "copy");
  const w = await as(null, null, `select position, word, duration_seconds from activity_words where activity_id = '${id}' order by position`);
  eq(w.rows, [
    { position: 0, word: "DOG", duration_seconds: 30 },
    { position: 1, word: "CAT", duration_seconds: 20 },
    { position: 2, word: "SUN", duration_seconds: 5 },
  ], "words");
  await as(D, "authenticated", `update activities set name = 'Pets' where id = '${id}'`);
  await as(D, "authenticated", `update activity_words set word = 'COW' where activity_id = '${id}' and position = 0`);
  const o = await as(null, null, `select word from activity_words where activity_id = '${ACT}' order by position`);
  eq(o.rows.map((x) => x.word), ["DOG", "CAT", "SUN"], "original unchanged");
  await as(D, "authenticated", `delete from activities where id = '${id}'`);
});
await check("duplicate keeps the name within 100 characters", async () => {
  await as(D, "authenticated", `insert into activities (id, name) values ('ac400000-0000-0000-0000-000000000000', '${"N".repeat(100)}')`);
  const r = await as(D, "authenticated", `select duplicate_activity('ac400000-0000-0000-0000-000000000000') as id`);
  const a = await as(null, null, `select char_length(name)::int as n, right(name, 7) as tail from activities where id = '${r.rows[0].id}'`);
  eq(a.rows, [{ n: 100, tail: " (copy)" }], "name");
  await as(null, null, `delete from activities where id in ('ac400000-0000-0000-0000-000000000000', '${r.rows[0].id}')`);
});
await check("duplicate: teacher refused, unknown id refused, anon can't call it", async () => {
  await expectError(as(A, "authenticated", `select duplicate_activity('${ACT}')`), /Only an admin/);
  await expectError(as(D, "authenticated", `select duplicate_activity(gen_random_uuid())`), /No such activity/);
  await expectError(as(null, "anon", `select duplicate_activity('${ACT}')`), /permission denied/);
  const n = await as(null, null, `select count(*)::int as n from activities`);
  eq(n.rows, [{ n: 1 }], "no stray copies");
});

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
