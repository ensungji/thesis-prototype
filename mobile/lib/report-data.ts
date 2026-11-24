// mobile/lib/report-data.ts
// Data for the three reports (per student, per session, analytics period):
// loading every row (paged past the 1,000-row limit), turning rows into
// answers + tries, the calculated metrics, and the CSV (one row per try).
// The PDF layout is in lib/pdf-report.ts. Both are used by
// components/ReportExportBar.tsx.
//
// Privacy: students appear only by their stored name / code. Recording paths
// never leave this file: a report only says "recording saved: yes / no".
// Times are shown in Asia/Manila (UTC+8, no daylight saving).

import { supabase } from "./supabase";
import { isOnline } from "./network";
import { speechAgreement, type Agreement, type ReviewAttempt } from "./review";

// ── Time (Asia/Manila) ────────────────────────────────────────────────────────

const MANILA_MS = 8 * 3600_000;
const DAY_MS = 24 * 3600_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

function manila(iso: string | Date): Date | null {
  const t = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
  return Number.isNaN(t) ? null : new Date(t + MANILA_MS); // read with getUTC*
}

/** "2026-11-24 14:05:09" (Asia/Manila), "" when empty. */
export function fmtDateTime(iso: string | Date | null | undefined): string {
  const d = iso ? manila(iso) : null;
  if (!d) return "";
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** "24 Nov 2026" (Asia/Manila). */
export function fmtDate(iso: string | Date | null | undefined): string {
  const d = iso ? manila(iso) : null;
  if (!d) return "";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "14:05:09" (Asia/Manila). */
export function fmtTime(iso: string | Date | null | undefined): string {
  const d = iso ? manila(iso) : null;
  if (!d) return "";
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** "24 Nov 2026, 14:05" (Asia/Manila). */
export function fmtLong(iso: string | Date | null | undefined): string {
  const d = iso ? manila(iso) : null;
  if (!d) return "";
  return `${fmtDate(iso)}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Midnight today in Asia/Manila, as a real instant. */
export function manilaMidnight(now = new Date()): Date {
  return new Date(Math.floor((now.getTime() + MANILA_MS) / DAY_MS) * DAY_MS - MANILA_MS);
}

/** "1 h 05 min 12 s" */
export function fmtDuration(ms: number | null): string {
  if (ms == null || ms < 0) return "";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${pad(m)} min ${pad(s % 60)} s` : `${m} min ${pad(s % 60)} s`;
}

// ── Periods (Analytics chips + student report) ───────────────────────────────

export type ReportPeriod = "today" | "week" | "month" | "all";

export const PERIOD_LABEL: Record<ReportPeriod, string> = {
  today: "Today",
  week: "This Week",
  month: "This Month",
  all: "All Time",
};

/**
 * Start of a period. Today = since midnight (Asia/Manila); This Week =
 * rolling 7 days; This Month = rolling month (same day last month); All Time =
 * no start. Same rules as the Analytics tab.
 */
export function periodSince(period: ReportPeriod, now = new Date()): Date | null {
  if (period === "all") return null;
  if (period === "today") return manilaMidnight(now);
  const d = new Date(now);
  if (period === "week") d.setDate(d.getDate() - 7);
  else d.setMonth(d.getMonth() - 1);
  return d;
}

// ── Labels ────────────────────────────────────────────────────────────────────

export type Group = "Beginner" | "Intermediate" | "Other";
export const GROUPS: Group[] = ["Beginner", "Intermediate", "Other"];

/** B01… = Beginner, I01… = Intermediate (a letter followed by a digit); any other name = Other. */
export function groupOf(name: string | null | undefined): Group {
  const n = (name ?? "").trim();
  if (/^B\d/i.test(n)) return "Beginner";
  if (/^I\d/i.test(n)) return "Intermediate";
  return "Other";
}

export type TypeKey = "live" | "timed" | "activity" | "unknown";
export const TYPE_KEYS: TypeKey[] = ["live", "timed", "activity", "unknown"];
export const TYPE_LABEL: Record<TypeKey, string> = {
  live: "Live",
  timed: "Timed",
  activity: "Activity",
  unknown: "Unknown (session deleted)",
};

export function typeKeyOf(type: string | null | undefined): TypeKey {
  switch (type) {
    case "manual":
    case "live_session":
      return "live";
    case "word_list":
    case "timed_sequence":
      return "timed";
    case "activity":
      return "activity";
    default:
      return "unknown";
  }
}

export type LengthKey = "3" | "5" | "6+" | "other";
export const LENGTH_KEYS: LengthKey[] = ["3", "5", "6+", "other"];
export const LENGTH_LABEL: Record<LengthKey, string> = {
  "3": "3 letters",
  "5": "5 letters",
  "6+": "More than 5 letters",
  other: "Other lengths (1–2 or 4 letters)",
};

export function lengthKeyOf(len: number): LengthKey {
  if (len === 3) return "3";
  if (len === 5) return "5";
  if (len > 5) return "6+";
  return "other";
}

export type FinalResult = "correct" | "wrong" | "review" | "no answer" | "skipped";

function finalResultOf(a: RawAttempt): FinalResult {
  if (a.graded_by === "missed") return "no answer";
  if (a.graded_by === "skipped") return "skipped";
  if (a.needs_review) return "review";
  return a.is_correct ? "correct" : "wrong";
}

function graderLabel(g: string | null | undefined): string {
  switch (g) {
    case "auto":
      return "voice";
    case "teacher":
      return "teacher";
    case "missed":
      return "no answer (app)";
    case "skipped":
      return "skipped (app)";
    default:
      return g ? g : "";
  }
}

function originalResultLabel(a: RawAttempt): string {
  if (!a.regraded_at) return "";
  if (a.original_graded_by === "missed") return "no answer";
  if (a.original_graded_by === "skipped") return "skipped";
  if (a.original_is_correct == null) return "";
  return a.original_is_correct ? "correct" : "wrong";
}

// ── Raw rows (select * so every column comes back, also new ones) ────────────

type RawSession = {
  id: string;
  name: string | null;
  type: string | null;
  status: string | null;
  purpose?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  reviewed_at?: string | null;
  activity_name?: string | null;
  activity_author?: string | null;
};
type RawWord = { id: string; session_id: string; word: string; order_index: number | null; duration_seconds: number | null };
type RawAttempt = {
  id: string;
  student_id: string | null;
  session_id: string | null;
  session_word_id: string | null;
  word: string | null;
  is_correct: boolean | null;
  response_time_ms: number | null;
  attempted_at: string;
  transcript: string | null;
  transcribed_text?: string | null; // older column, if the table still has it
  confidence: number | null;
  audio_path: string | null;
  needs_review: boolean | null;
  graded_by: string | null;
  tries?: number | null;
  original_is_correct?: boolean | null;
  original_graded_by?: string | null;
  regraded_by?: string | null;
  regraded_at?: string | null;
};
type RawTry = {
  id: string;
  session_word_id: string;
  student_id: string;
  attempt_no: number;
  audio_path: string | null;
  transcript: string | null;
  result: string;
  confidence: number | null;
  response_time_ms: number | null;
  created_at: string;
  device_id?: string | null; // migration 27
  late?: boolean | null; // migration 27
};
type Student = { id: string; full_name: string };
type DeviceRow = { id: string; device_code: string; paired_student_id: string | null };

// ── Report model ──────────────────────────────────────────────────────────────

export type ReportTry = {
  attemptNo: number;
  at: string;
  heard: string;
  result: string;
  confidence: number | null;
  responseMs: number | null;
  recordingSaved: boolean;
  deviceCode: string; // "" = not recorded
  late: boolean | null; // null = not recorded
};

export type ReportSession = {
  id: string;
  name: string;
  typeKey: TypeKey;
  purpose: string;
  status: string;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  reviewedAt: string | null;
  activityName: string;
  activityAuthor: string;
  words: { id: string; word: string; position: number; holdSeconds: number | null }[];
  studentIds: string[]; // assigned + anyone with an answer
};

export type ReportAnswer = {
  id: string;
  studentId: string;
  studentName: string;
  group: Group;
  session: ReportSession | null; // null = the session was deleted
  word: string;
  wordLength: number;
  position: number | null;
  holdSeconds: number | null;
  answeredAt: string;
  heard: string;
  heardOld: string; // transcribed_text (older column), if any
  confidence: number | null;
  result: FinalResult;
  isCorrect: boolean;
  needsReview: boolean;
  tries: number;
  responseMs: number | null;
  gradedBy: string;
  rawGradedBy: string | null;
  originalResult: string;
  originalGrader: string;
  originalIsCorrect: boolean | null;
  rawOriginalGradedBy: string | null;
  regradedBy: string;
  regradedAt: string | null;
  recordingSaved: boolean;
  deviceCode: string;
  late: boolean | null;
  tryList: ReportTry[];
};

export type LenStat = { scored: number; correct: number; accuracy: number | null; avgResponseMs: number | null };

export type Metrics = {
  answers: number; // every answer row
  scored: number; // answers − still waiting for review
  correct: number;
  accuracy: number | null;
  firstTryCorrect: number;
  firstTryAccuracy: number | null;
  avgTries: number | null;
  avgTriesUntilCorrect: number | null;
  avgResponseMs: number | null;
  fastestMs: number | null;
  slowestMs: number | null;
  timed: number;
  noAnswer: number;
  noAnswerRate: number | null;
  skipped: number;
  needsReview: number;
  regraded: number;
  byLength: Record<LengthKey, LenStat>;
  byType: Record<TypeKey, LenStat>;
  agreement: Agreement; // reviewed sessions only
  agreementPct: number | null;
};

export type StudentSummary = {
  id: string;
  name: string;
  group: Group;
  deviceCode: string; // paired now
  metrics: Metrics;
  rank: number | null; // by accuracy, ties by scored answers; null = no scored answers
};

export type Report = {
  kind: "student" | "session" | "period";
  title: string;
  subtitle: string;
  fileBase: string;
  teacherName: string;
  generatedAt: Date;
  since: Date | null;
  until: Date;
  rangeText: string;
  answers: ReportAnswer[]; // sorted: student, session time, word position
  sessions: ReportSession[]; // sorted by start time
  students: StudentSummary[]; // the students in this report, sorted by name
  overall: Metrics;
  groups: Record<Group, Metrics>;
  rankedOf: number; // students with scored answers (class standing)
  hasOldTranscript: boolean;
};

// ── Metrics ───────────────────────────────────────────────────────────────────

const ratio = (n: number, d: number) => (d > 0 ? n / d : null);
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Try number of the first try graded correct; null if the answer isn't correct. */
export function triesUntilCorrect(a: ReportAnswer): number | null {
  if (a.result !== "correct") return null;
  const first = a.tryList.find((t) => t.result === "correct");
  if (first) return first.attemptNo;
  return Math.max(1, a.tries); // correct by the teacher, or tries saved before answer_attempts
}

function lenStat(list: ReportAnswer[]): LenStat {
  const scored = list.filter((a) => !a.needsReview);
  const correct = scored.filter((a) => a.isCorrect).length;
  const timed = scored.map((a) => a.responseMs ?? 0).filter((x) => x > 0);
  return { scored: scored.length, correct, accuracy: ratio(correct, scored.length), avgResponseMs: mean(timed) };
}

const asReviewAttempt = (a: ReportAnswer): ReviewAttempt =>
  ({
    is_correct: a.isCorrect,
    needs_review: a.needsReview,
    graded_by: a.rawGradedBy,
    regraded_at: a.regradedAt,
    original_graded_by: a.rawOriginalGradedBy,
    original_is_correct: a.originalIsCorrect,
  }) as ReviewAttempt;

/**
 * @param agreementAll count the speech grading agreement over every answer
 *   given (the session report), instead of only reviewed sessions.
 */
export function computeMetrics(list: ReportAnswer[], agreementAll = false): Metrics {
  // Same as the app's Analytics (teacher_student_stats): an answer still
  // waiting for review isn't scored; no answer and skipped count as wrong.
  const scored = list.filter((a) => !a.needsReview);
  const correct = scored.filter((a) => a.isCorrect).length;
  const untilCorrect = scored.map(triesUntilCorrect).filter((x): x is number => x != null);
  const firstTryCorrect = untilCorrect.filter((x) => x === 1).length;
  const timed = list.map((a) => a.responseMs ?? 0).filter((x) => x > 0);
  const noAnswer = list.filter((a) => a.result === "no answer").length;
  const skipped = list.filter((a) => a.result === "skipped").length;

  const byLength = {} as Record<LengthKey, LenStat>;
  for (const k of LENGTH_KEYS) byLength[k] = lenStat(list.filter((a) => lengthKeyOf(a.wordLength) === k));
  const byType = {} as Record<TypeKey, LenStat>;
  for (const k of TYPE_KEYS) byType[k] = lenStat(list.filter((a) => (a.session?.typeKey ?? "unknown") === k));

  const forAgreement = agreementAll ? list : list.filter((a) => !!a.session?.reviewedAt);
  const agreement = speechAgreement(forAgreement.map(asReviewAttempt));

  return {
    answers: list.length,
    scored: scored.length,
    correct,
    accuracy: ratio(correct, scored.length),
    firstTryCorrect,
    firstTryAccuracy: ratio(firstTryCorrect, scored.length),
    avgTries: mean(list.filter((a) => a.result !== "skipped").map((a) => a.tries)),
    avgTriesUntilCorrect: mean(untilCorrect),
    avgResponseMs: mean(timed),
    fastestMs: timed.length ? Math.min(...timed) : null,
    slowestMs: timed.length ? Math.max(...timed) : null,
    timed: timed.length,
    noAnswer,
    noAnswerRate: ratio(noAnswer, list.length),
    skipped,
    needsReview: list.filter((a) => a.needsReview).length,
    regraded: list.filter((a) => !!a.regradedAt).length,
    byLength,
    byType,
    agreement,
    agreementPct: ratio(agreement.agreed, agreement.voice),
  };
}

/** Rank by accuracy (high first), ties by scored answers (more first). */
function rankStudents(stats: { id: string; m: Metrics }[]): Map<string, number> {
  const ranked = stats
    .filter((s) => s.m.scored > 0)
    .sort((a, b) => (b.m.accuracy ?? 0) - (a.m.accuracy ?? 0) || b.m.scored - a.m.scored);
  const out = new Map<string, number>();
  ranked.forEach((s, i) => {
    const prev = ranked[i - 1];
    const tie = prev && prev.m.accuracy === s.m.accuracy && prev.m.scored === s.m.scored;
    out.set(s.id, tie ? out.get(prev.id)! : i + 1);
  });
  return out;
}

// ── Loading ───────────────────────────────────────────────────────────────────

export class ReportError extends Error {}

const PAGE = 1000;
const IN_CHUNK = 100;

type Page = { data: unknown[] | null; error: { message: string } | null };

/**
 * Every row of a query, page by page. Stops at an empty page (not a short
 * one), so a server row limit below 1,000 can't cut rows off either.
 * The query must have a stable order.
 */
async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<Page>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new ReportError(error.message);
    const rows = (data ?? []) as T[];
    if (rows.length === 0) return out;
    out.push(...rows);
    from += rows.length;
  }
}

/** fetchAll over an id list, in chunks (keeps the URL short). */
async function fetchIn<T>(ids: string[], page: (chunk: string[], from: number, to: number) => PromiseLike<Page>): Promise<T[]> {
  const out: T[] = [];
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    out.push(...(await fetchAll<T>((from, to) => page(chunk, from, to))));
  }
  return out;
}

async function me(): Promise<{ id: string; name: string }> {
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) throw new ReportError("You're signed out. Sign in again and retry.");
  const { data: p } = await supabase.from("profiles").select("full_name, title").eq("id", user.id).maybeSingle();
  const prof = p as { full_name: string | null; title: string | null } | null;
  const name = [prof?.title, prof?.full_name].filter((x) => x && x.trim()).join(" ").trim();
  return { id: user.id, name: name || user.email || "Teacher" };
}

async function loadStudents(teacherId: string): Promise<Student[]> {
  return fetchAll<Student>((f, t) =>
    supabase.from("students").select("id, full_name").eq("teacher_id", teacherId).order("id").range(f, t),
  );
}

async function loadDevices(): Promise<DeviceRow[]> {
  const { data, error } = await supabase.rpc("list_pairing_devices");
  if (error) throw new ReportError(error.message);
  return (data ?? []) as DeviceRow[];
}

async function loadSessionsByIds(ids: string[]): Promise<RawSession[]> {
  return fetchIn<RawSession>(ids, (chunk, f, t) =>
    supabase.from("sessions").select("*").in("id", chunk).order("id").range(f, t),
  );
}

type Raw = {
  teacher: { id: string; name: string };
  students: Student[]; // the teacher's students
  devices: DeviceRow[];
  sessions: RawSession[];
  words: RawWord[];
  sessionStudents: { session_id: string; student_id: string }[];
  attempts: RawAttempt[];
  tries: RawTry[];
  names: Record<string, string>;
};

/** Sessions, words, assigned students, tries and re-grader names for a set of answers. */
async function loadAround(
  teacher: { id: string; name: string },
  attempts: RawAttempt[],
  extraSessions: RawSession[] = [],
): Promise<Omit<Raw, "teacher" | "attempts">> {
  const known = new Set(extraSessions.map((s) => s.id));
  const missing = attempts.map((a) => a.session_id).filter((x): x is string => !!x && !known.has(x));
  const [students, devices, more] = await Promise.all([
    loadStudents(teacher.id),
    loadDevices(),
    loadSessionsByIds(missing),
  ]);
  const sessions = [...extraSessions, ...more];
  const sessionIds = sessions.map((s) => s.id);
  const [words, sessionStudents] = await Promise.all([
    fetchIn<RawWord>(sessionIds, (chunk, f, t) =>
      supabase
        .from("session_words")
        .select("id, session_id, word, order_index, duration_seconds")
        .in("session_id", chunk)
        .order("id")
        .range(f, t),
    ),
    fetchIn<{ session_id: string; student_id: string }>(sessionIds, (chunk, f, t) =>
      supabase
        .from("session_students")
        .select("session_id, student_id")
        .in("session_id", chunk)
        .order("session_id")
        .order("student_id")
        .range(f, t),
    ),
  ]);
  const swIds = attempts.map((a) => a.session_word_id).filter((x): x is string => !!x);
  const tries = await fetchIn<RawTry>(swIds, (chunk, f, t) =>
    supabase.from("answer_attempts").select("*").in("session_word_id", chunk).order("id").range(f, t),
  );

  const names: Record<string, string> = { [teacher.id]: teacher.name };
  const regraders = [...new Set(attempts.map((a) => a.regraded_by).filter((x): x is string => !!x && x !== teacher.id))];
  if (regraders.length) {
    // RLS: a teacher reads only their own profile; an admin reads all
    const { data } = await supabase.from("profiles").select("id, full_name").in("id", regraders);
    for (const p of (data ?? []) as { id: string; full_name: string | null }[]) {
      if (p.full_name) names[p.id] = p.full_name;
    }
  }
  return { students, devices, sessions, words, sessionStudents, tries, names };
}

function build(raw: Raw): {
  answers: ReportAnswer[];
  sessions: ReportSession[];
  studentName: Map<string, string>;
  deviceOf: Map<string, string>;
} {
  const studentName = new Map(raw.students.map((s) => [s.id, s.full_name]));
  const deviceCode = new Map(raw.devices.map((d) => [d.id, d.device_code]));
  const deviceOf = new Map<string, string>();
  for (const d of raw.devices) if (d.paired_student_id) deviceOf.set(d.paired_student_id, d.device_code);

  const wordsBySession = new Map<string, RawWord[]>();
  for (const w of raw.words) {
    const list = wordsBySession.get(w.session_id) ?? [];
    list.push(w);
    wordsBySession.set(w.session_id, list);
  }
  const assigned = new Map<string, Set<string>>();
  for (const r of raw.sessionStudents) {
    const set = assigned.get(r.session_id) ?? new Set<string>();
    set.add(r.student_id);
    assigned.set(r.session_id, set);
  }
  for (const a of raw.attempts) {
    if (!a.session_id || !a.student_id) continue;
    const set = assigned.get(a.session_id) ?? new Set<string>();
    set.add(a.student_id);
    assigned.set(a.session_id, set);
  }

  const wordInfo = new Map<string, { position: number; holdSeconds: number | null }>();
  const sessions: ReportSession[] = raw.sessions.map((s) => {
    const words = (wordsBySession.get(s.id) ?? [])
      .slice()
      .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0) || a.id.localeCompare(b.id))
      .map((w, i) => {
        const info = { id: w.id, word: w.word, position: i + 1, holdSeconds: w.duration_seconds ?? null };
        wordInfo.set(w.id, info);
        return info;
      });
    return {
      id: s.id,
      name: s.name?.trim() || "(no name)",
      typeKey: typeKeyOf(s.type),
      purpose: s.purpose?.trim() ?? "",
      status: s.status ?? "",
      createdAt: s.created_at ?? null,
      startedAt: s.started_at ?? null,
      finishedAt: s.finished_at ?? null,
      reviewedAt: s.reviewed_at ?? null,
      activityName: s.activity_name?.trim() ?? "",
      activityAuthor: s.activity_author?.trim() ?? "",
      words,
      studentIds: [...(assigned.get(s.id) ?? [])],
    };
  });
  sessions.sort((a, b) => sessionTime(a).localeCompare(sessionTime(b)));
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  const triesByKey = new Map<string, RawTry[]>();
  for (const t of raw.tries) {
    const k = `${t.session_word_id}|${t.student_id}`;
    const list = triesByKey.get(k) ?? [];
    list.push(t);
    triesByKey.set(k, list);
  }

  const answers: ReportAnswer[] = raw.attempts
    .filter((a) => !!a.student_id)
    .map((a) => {
      const tryRows = a.session_word_id
        ? (triesByKey.get(`${a.session_word_id}|${a.student_id}`) ?? []).slice().sort((x, y) => x.attempt_no - y.attempt_no)
        : [];
      const tryList: ReportTry[] = tryRows.map((t) => ({
        attemptNo: t.attempt_no,
        at: t.created_at,
        heard: t.transcript ?? "",
        result: t.result,
        confidence: t.confidence,
        responseMs: t.response_time_ms,
        recordingSaved: !!t.audio_path,
        deviceCode: t.device_id ? (deviceCode.get(t.device_id) ?? "") : "",
        late: t.late ?? null,
      }));
      const withDevice = [...tryList].reverse().find((t) => t.deviceCode);
      const lateKnown = tryList.filter((t) => t.late != null);
      const word = (a.word ?? "").toUpperCase();
      const info = a.session_word_id ? wordInfo.get(a.session_word_id) : undefined;
      const name = studentName.get(a.student_id!) ?? "(student removed)";
      const result = finalResultOf(a);
      return {
        id: a.id,
        studentId: a.student_id!,
        studentName: name,
        group: groupOf(name),
        session: a.session_id ? (sessionById.get(a.session_id) ?? null) : null,
        word,
        wordLength: word.replace(/[^A-Z]/g, "").length || word.length,
        position: info?.position ?? null,
        holdSeconds: info?.holdSeconds ?? null,
        answeredAt: a.attempted_at,
        heard: a.transcript ?? "",
        heardOld: a.transcribed_text && a.transcribed_text !== a.transcript ? a.transcribed_text : "",
        confidence: a.confidence,
        result,
        isCorrect: !!a.is_correct,
        needsReview: !!a.needs_review,
        tries: a.tries ?? 0,
        responseMs: a.response_time_ms,
        gradedBy: graderLabel(a.graded_by),
        rawGradedBy: a.graded_by,
        originalResult: originalResultLabel(a),
        originalGrader: a.regraded_at ? graderLabel(a.original_graded_by) : "",
        originalIsCorrect: a.original_is_correct ?? null,
        rawOriginalGradedBy: a.original_graded_by ?? null,
        regradedBy: a.regraded_by ? (raw.names[a.regraded_by] ?? "another account") : "",
        regradedAt: a.regraded_at ?? null,
        recordingSaved: !!a.audio_path,
        deviceCode: withDevice?.deviceCode ?? "",
        late: lateKnown.length ? lateKnown.some((t) => t.late) : null,
        tryList,
      };
    });

  answers.sort(
    (x, y) =>
      x.studentName.localeCompare(y.studentName, undefined, { numeric: true }) ||
      // deleted sessions ("~") after the dated ones
      (x.session ? sessionTime(x.session) : "~").localeCompare(y.session ? sessionTime(y.session) : "~") ||
      (x.position ?? 1e9) - (y.position ?? 1e9) ||
      x.answeredAt.localeCompare(y.answeredAt),
  );
  return { answers, sessions, studentName, deviceOf };
}

const sessionTime = (s: ReportSession) => s.startedAt ?? s.createdAt ?? "";

function groupMetrics(answers: ReportAnswer[], agreementAll = false): Record<Group, Metrics> {
  const out = {} as Record<Group, Metrics>;
  for (const g of GROUPS) out[g] = computeMetrics(answers.filter((a) => a.group === g), agreementAll);
  return out;
}

function summaries(
  ids: string[],
  answers: ReportAnswer[],
  studentName: Map<string, string>,
  deviceOf: Map<string, string>,
  agreementAll = false,
): StudentSummary[] {
  const list = ids.map((id) => {
    const name = studentName.get(id) ?? answers.find((a) => a.studentId === id)?.studentName ?? "(student removed)";
    return {
      id,
      name,
      group: groupOf(name),
      deviceCode: deviceOf.get(id) ?? "",
      metrics: computeMetrics(answers.filter((a) => a.studentId === id), agreementAll),
      rank: null as number | null,
    };
  });
  const ranks = rankStudents(list.map((s) => ({ id: s.id, m: s.metrics })));
  for (const s of list) s.rank = ranks.get(s.id) ?? null;
  return list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function rangeText(since: Date | null, until: Date, answers: ReportAnswer[]): string {
  if (since) return `${fmtDateTime(since)} to ${fmtDateTime(until)} (Asia/Manila)`;
  const times = answers.map((a) => a.answeredAt).sort();
  return times.length
    ? `All time: answers from ${fmtDateTime(times[0])} to ${fmtDateTime(times[times.length - 1])} (Asia/Manila)`
    : `All time, up to ${fmtDateTime(until)} (Asia/Manila)`;
}

const slug = (s: string) =>
  (typeof s.normalize === "function" ? s.normalize("NFKD") : s)
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "report";

function stamp(d: Date): string {
  return fmtDateTime(d).replace(/[-:]/g, "").replace(" ", "-").slice(0, 13); // 20261124-1405
}

function checkOnline() {
  if (!isOnline()) throw new ReportError("You're offline. Connect to the internet and try again.");
}

/** Readable message for anything thrown while loading / exporting. */
export function reportErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/network request failed|failed to fetch|network error|timeout/i.test(msg)) {
    return "No connection to the server. Check the internet and try again.";
  }
  return msg || "Something went wrong.";
}

// ── 1. Per-student report ─────────────────────────────────────────────────────

export async function loadStudentReport(studentId: string, period: ReportPeriod): Promise<Report> {
  checkOnline();
  const teacher = await me();
  const until = new Date();
  const since = periodSince(period, until);
  const sinceIso = since?.toISOString() ?? null;

  // Every answer by any of this teacher's students in the period: the student's
  // own rows for the report, everyone's for the class standing
  const all = await fetchAll<RawAttempt>((f, t) => {
    let q = supabase.from("word_attempts").select("*").not("student_id", "is", null);
    if (sinceIso) q = q.gte("attempted_at", sinceIso);
    return q.order("id").range(f, t);
  });
  const mine = all.filter((a) => a.student_id === studentId);
  const around = await loadAround(teacher, mine);
  const raw: Raw = { teacher, attempts: mine, ...around };
  const { answers, sessions, studentName, deviceOf } = build(raw);

  if (!studentName.has(studentId)) throw new ReportError("This student isn't in your class.");

  // Class standing: same metrics for every student of this teacher
  const classRaw: Raw = { ...raw, attempts: all.filter((a) => studentName.has(a.student_id ?? "")), tries: raw.tries };
  const classAnswers = build({ ...classRaw, sessions: [], words: [], sessionStudents: [] }).answers;
  const classStats = summaries([...studentName.keys()], classAnswers, studentName, deviceOf);
  const rankedOf = classStats.filter((s) => s.rank != null).length;
  const standing = classStats.find((s) => s.id === studentId)?.rank ?? null;

  const students = summaries([studentId], answers, studentName, deviceOf);
  students[0].rank = standing;
  const name = studentName.get(studentId)!;
  return {
    kind: "student",
    title: `Student report: ${name}`,
    subtitle: PERIOD_LABEL[period],
    fileBase: `dots-student-${slug(name)}-${period}-${stamp(until)}`,
    teacherName: teacher.name,
    generatedAt: until,
    since,
    until,
    rangeText: rangeText(since, until, answers),
    answers,
    sessions: sessions.filter((s) => answers.some((a) => a.session?.id === s.id)),
    students,
    overall: students[0].metrics,
    groups: groupMetrics(answers),
    rankedOf,
    hasOldTranscript: answers.some((a) => !!a.heardOld),
  };
}

// ── 2. Per-session report ─────────────────────────────────────────────────────

export async function loadSessionReport(sessionId: string): Promise<Report> {
  checkOnline();
  const teacher = await me();
  const until = new Date();
  const { data: s, error } = await supabase.from("sessions").select("*").eq("id", sessionId).maybeSingle();
  if (error) throw new ReportError(error.message);
  if (!s) throw new ReportError("This session doesn't exist any more.");

  const attempts = await fetchAll<RawAttempt>((f, t) =>
    supabase.from("word_attempts").select("*").eq("session_id", sessionId).order("id").range(f, t),
  );
  const around = await loadAround(teacher, attempts, [s as RawSession]);
  const { answers, sessions, studentName, deviceOf } = build({ teacher, attempts, ...around });
  const session = sessions[0];

  const students = summaries(session.studentIds, answers, studentName, deviceOf, true);
  const since = session.startedAt ? new Date(session.startedAt) : null;
  const end = session.finishedAt ? new Date(session.finishedAt) : until;
  return {
    kind: "session",
    title: `Session report: ${session.name}`,
    subtitle: TYPE_LABEL[session.typeKey],
    fileBase: `dots-session-${slug(session.name)}-${stamp(until)}`,
    teacherName: teacher.name,
    generatedAt: until,
    since,
    until: end,
    rangeText: since
      ? `${fmtDateTime(since)} to ${session.finishedAt ? fmtDateTime(end) : "not finished"} (Asia/Manila)`
      : "Not started",
    answers,
    sessions,
    students,
    overall: computeMetrics(answers, true),
    groups: groupMetrics(answers, true),
    rankedOf: students.filter((x) => x.rank != null).length,
    hasOldTranscript: answers.some((a) => !!a.heardOld),
  };
}

// ── 3. Analytics (period) report ──────────────────────────────────────────────

export async function loadPeriodReport(period: ReportPeriod): Promise<Report> {
  checkOnline();
  const teacher = await me();
  const until = new Date();
  const since = periodSince(period, until);
  const sinceIso = since?.toISOString() ?? null;

  const [attempts, ownSessions] = await Promise.all([
    fetchAll<RawAttempt>((f, t) => {
      let q = supabase.from("word_attempts").select("*").not("student_id", "is", null);
      if (sinceIso) q = q.gte("attempted_at", sinceIso);
      return q.order("id").range(f, t);
    }),
    // Sessions held in the period (also ones with no answers)
    fetchAll<RawSession>((f, t) => {
      let q = supabase.from("sessions").select("*").eq("teacher_id", teacher.id);
      if (sinceIso) q = q.or(`created_at.gte.${sinceIso},started_at.gte.${sinceIso}`);
      return q.order("id").range(f, t);
    }),
  ]);
  const around = await loadAround(teacher, attempts, ownSessions);
  const { answers: allAnswers, sessions, studentName, deviceOf } = build({ teacher, attempts, ...around });
  // Only this teacher's students (an admin's RLS would show every class)
  const answers = allAnswers.filter((a) => studentName.has(a.studentId));
  const students = summaries([...studentName.keys()], answers, studentName, deviceOf);
  return {
    kind: "period",
    title: "Class analytics report",
    subtitle: PERIOD_LABEL[period],
    fileBase: `dots-analytics-${period}-${stamp(until)}`,
    teacherName: teacher.name,
    generatedAt: until,
    since,
    until,
    rangeText: rangeText(since, until, answers),
    answers,
    sessions,
    students,
    overall: computeMetrics(answers),
    groups: groupMetrics(answers),
    rankedOf: students.filter((x) => x.rank != null).length,
    hasOldTranscript: answers.some((a) => !!a.heardOld),
  };
}

// ── Number formats (PDF + CSV) ────────────────────────────────────────────────

export const pct = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
export const num = (x: number | null, d = 2) => (x == null ? "—" : x.toFixed(d));
export const ms = (x: number | null) => (x == null || x <= 0 ? "—" : `${(x / 1000).toFixed(2)} s`);
export const yesNo = (b: boolean | null) => (b == null ? "not recorded" : b ? "yes" : "no");

// ── CSV: one row per try ──────────────────────────────────────────────────────

export const CSV_COLUMNS: { key: string; meaning: string }[] = [
  { key: "session_name", meaning: "Session name (empty if the session was deleted)." },
  { key: "session_type", meaning: "Live, Timed or Activity." },
  { key: "session_purpose", meaning: "Purpose typed when the session was made." },
  { key: "session_status", meaning: "pending, in_progress, paused or finished." },
  { key: "session_started_at", meaning: "When the session was launched (Asia/Manila)." },
  { key: "session_finished_at", meaning: "When the session was finished (Asia/Manila)." },
  { key: "session_reviewed_at", meaning: "When the teacher tapped Done reviewing (empty = not reviewed)." },
  { key: "activity_name", meaning: "Activity the words came from (Activity sessions)." },
  { key: "activity_author", meaning: "Teacher who made that activity." },
  { key: "student", meaning: "Student name / code as stored (e.g. B01)." },
  { key: "group", meaning: "Beginner (code B + digit), Intermediate (I + digit), or Other." },
  { key: "word", meaning: "The word shown on the device." },
  { key: "word_length", meaning: "Number of letters." },
  { key: "word_length_group", meaning: "3 letters / 5 letters / more than 5 / other." },
  { key: "word_position", meaning: "Position of the word in the session's word list (1 = first)." },
  { key: "words_in_session", meaning: "How many words the session's list has." },
  { key: "hold_time_s", meaning: "Hold time set for the word in seconds (session_words.duration_seconds; Activity sessions don't use it)." },
  { key: "answered_at", meaning: "When the final result was saved (Asia/Manila)." },
  { key: "device_used", meaning: "Device code of the latest voice try (empty = not recorded: tries before migration 27, or no voice try)." },
  { key: "heard_text", meaning: "What speech recognition heard for the final result (word_attempts.transcript)." },
  { key: "confidence", meaning: "Speech recognition confidence of the final result (0–1)." },
  { key: "final_result", meaning: "correct / wrong / review / no answer / skipped." },
  { key: "is_correct", meaning: "true / false as stored." },
  { key: "needs_review", meaning: "true = still waiting for the teacher to decide (not scored)." },
  { key: "tries", meaning: "How many voice tries the student made for the word." },
  { key: "response_time_ms", meaning: "Response time of the final result in milliseconds." },
  { key: "response_time_s", meaning: "Same in seconds." },
  { key: "graded_by", meaning: "voice / teacher / no answer (app) / skipped (app)." },
  { key: "original_result", meaning: "Result before the first re-grade (empty = never re-graded)." },
  { key: "original_grader", meaning: "Who graded it before the first re-grade." },
  { key: "regraded_by", meaning: "Who re-graded it after the session." },
  { key: "regraded_at", meaning: "When it was first re-graded (Asia/Manila)." },
  { key: "late_answer", meaning: "yes = a try was for a word the device no longer showed (migration 27; 'not recorded' before)." },
  { key: "recording_saved", meaning: "yes = a recording of the final answer is stored (the file itself is never in a report)." },
  { key: "try_number", meaning: "Try number 1, 2, 3… (empty = no voice try saved: teacher grade, no answer, skipped, or before tries were kept)." },
  { key: "try_time", meaning: "When the try was graded (Asia/Manila)." },
  { key: "try_heard_text", meaning: "What speech recognition heard on this try." },
  { key: "try_result", meaning: "correct / wrong / review for this try (voice only)." },
  { key: "try_confidence", meaning: "Speech recognition confidence of this try (0–1)." },
  { key: "try_response_time_ms", meaning: "Response time of this try in milliseconds." },
  { key: "try_response_time_s", meaning: "Same in seconds." },
  { key: "try_device", meaning: "Device code that sent this try." },
  { key: "try_late", meaning: "yes / no / not recorded." },
  { key: "try_recording_saved", meaning: "yes / no." },
];

const OLD_TRANSCRIPT_COLUMN = {
  key: "heard_text_old_column",
  meaning: "Older heard-text column (word_attempts.transcribed_text), only when it differs from heard_text.",
};

export function csvColumns(r: Report) {
  if (!r.hasOldTranscript) return CSV_COLUMNS;
  const i = CSV_COLUMNS.findIndex((c) => c.key === "heard_text") + 1;
  return [...CSV_COLUMNS.slice(0, i), OLD_TRANSCRIPT_COLUMN, ...CSV_COLUMNS.slice(i)];
}

const sec = (x: number | null) => (x == null ? "" : (x / 1000).toFixed(3));

export function reportCsvRows(r: Report): { header: string[]; rows: (string | number | boolean | null)[][] } {
  const cols = csvColumns(r);
  const rows: (string | number | boolean | null)[][] = [];
  for (const a of r.answers) {
    const s = a.session;
    const base: Record<string, string | number | boolean | null> = {
      session_name: s?.name ?? "",
      session_type: TYPE_LABEL[s?.typeKey ?? "unknown"],
      session_purpose: s?.purpose ?? "",
      session_status: s?.status ?? "",
      session_started_at: fmtDateTime(s?.startedAt),
      session_finished_at: fmtDateTime(s?.finishedAt),
      session_reviewed_at: fmtDateTime(s?.reviewedAt),
      activity_name: s?.activityName ?? "",
      activity_author: s?.activityAuthor ?? "",
      student: a.studentName,
      group: a.group,
      word: a.word,
      word_length: a.wordLength,
      word_length_group: LENGTH_LABEL[lengthKeyOf(a.wordLength)],
      word_position: a.position,
      words_in_session: s ? s.words.length : null,
      hold_time_s: a.holdSeconds,
      answered_at: fmtDateTime(a.answeredAt),
      device_used: a.deviceCode,
      heard_text: a.heard,
      heard_text_old_column: a.heardOld,
      confidence: a.confidence,
      final_result: a.result,
      is_correct: a.isCorrect,
      needs_review: a.needsReview,
      tries: a.tries,
      response_time_ms: a.responseMs,
      response_time_s: sec(a.responseMs),
      graded_by: a.gradedBy,
      original_result: a.originalResult,
      original_grader: a.originalGrader,
      regraded_by: a.regradedBy,
      regraded_at: fmtDateTime(a.regradedAt),
      late_answer: yesNo(a.late),
      recording_saved: a.recordingSaved ? "yes" : "no",
    };
    const tries = a.tryList.length ? a.tryList : [null];
    for (const t of tries) {
      const row = {
        ...base,
        try_number: t?.attemptNo ?? null,
        try_time: fmtDateTime(t?.at),
        try_heard_text: t?.heard ?? "",
        try_result: t?.result ?? "",
        try_confidence: t?.confidence ?? null,
        try_response_time_ms: t?.responseMs ?? null,
        try_response_time_s: sec(t?.responseMs ?? null),
        try_device: t?.deviceCode ?? "",
        try_late: t ? yesNo(t.late) : "",
        try_recording_saved: t ? (t.recordingSaved ? "yes" : "no") : "",
      } as Record<string, string | number | boolean | null>;
      rows.push(cols.map((c) => row[c.key] ?? ""));
    }
  }
  return { header: cols.map((c) => c.key), rows };
}
