// mobile/lib/review.ts
// The review screen after a session (sessions/review.tsx): loading, labels,
// filters, and the speech grading agreement.
//
// word_attempts = the final result per student per word; answer_attempts =
// every voice try (migration 20). Re-grading after the session ended is
// allowed for every row; the first re-grade keeps original_is_correct /
// original_graded_by / regraded_by / regraded_at (migration 22).

import { supabase } from "./supabase";

export type ReviewAttempt = {
  id: string;
  student_id: string;
  session_word_id: string | null;
  word: string;
  is_correct: boolean;
  needs_review: boolean | null;
  graded_by: string | null;
  transcript: string | null;
  confidence: number | null;
  audio_path: string | null;
  tries: number | null;
  attempted_at: string;
  original_is_correct: boolean | null;
  original_graded_by: string | null;
  regraded_by: string | null;
  regraded_at: string | null;
};

export type ReviewTry = {
  id: string;
  attempt_no: number;
  transcript: string | null;
  result: "correct" | "wrong" | "review";
  confidence: number | null;
  response_time_ms: number | null;
  created_at: string;
  audio_path: string | null;
};

export type ReviewWord = { id: string; word: string; order_index: number };
export type ReviewStudent = { id: string; full_name: string };
export type ReviewSession = {
  id: string;
  name: string;
  type: string;
  status: string;
  reviewed_at?: string | null; // migration 23
  activity_name?: string | null; // activity sessions (migration 18)
  activity_author?: string | null; // migration 25
};

export type ReviewData = {
  session: ReviewSession;
  words: ReviewWord[];
  students: ReviewStudent[];
  attempts: ReviewAttempt[];
  names: Record<string, string>; // profile id → name (re-graders)
};

export const ATTEMPT_COLUMNS =
  "id, student_id, session_word_id, word, is_correct, needs_review, graded_by, transcript, confidence, " +
  "audio_path, tries, attempted_at, original_is_correct, original_graded_by, regraded_by, regraded_at";

// ── Labels ────────────────────────────────────────────────────────────────────

export type ReviewResult = "correct" | "wrong" | "review" | "missed" | "skipped";

export function resultOf(a: ReviewAttempt): ReviewResult {
  if (a.graded_by === "missed") return "missed";
  if (a.graded_by === "skipped") return "skipped";
  if (a.needs_review) return "review";
  return a.is_correct ? "correct" : "wrong";
}

/** Who graded the final result: Voice / Teacher / No answer / Skipped. */
export function gradedByLabel(gradedBy: string | null): string {
  switch (gradedBy) {
    case "auto":
      return "Voice";
    case "teacher":
      return "Teacher";
    case "missed":
      return "No answer";
    case "skipped":
      return "Skipped";
    default:
      return "Unknown";
  }
}

/** What it was before the first re-grade, e.g. "correct by voice", "no answer". null = never re-graded. */
export function wasLabel(a: ReviewAttempt): string | null {
  if (!a.regraded_at) return null;
  if (a.original_graded_by === "missed") return "no answer";
  if (a.original_graded_by === "skipped") return "skipped";
  const result = a.original_is_correct ? "correct" : "wrong";
  if (a.original_graded_by === "auto") return `${result} by voice`;
  if (a.original_graded_by === "teacher") return `${result} by teacher`;
  return result;
}

// ── Filters ───────────────────────────────────────────────────────────────────

export type ReviewFilter = "review" | "wrong" | "all";

/** review = still needs review; wrong = wrong, no answer or skipped; all = everything. */
export function matchesFilter(a: ReviewAttempt, f: ReviewFilter): boolean {
  if (f === "all") return true;
  const r = resultOf(a);
  if (f === "review") return r === "review";
  return r === "wrong" || r === "missed" || r === "skipped";
}

// ── Speech grading agreement ──────────────────────────────────────────────────
// The same rule as speech_grading_agreement() in migration 23:
//   voice answer  = graded by voice when the session ended: still 'auto' and
//                   never re-graded, or re-graded from 'auto' (original_graded_by)
//   still review  = still 'auto' + needs_review, never re-graded: the teacher
//                   hasn't decided, so it isn't counted either way
//   agreed        = never re-graded, or re-graded to the same is_correct
//   disagreed     = re-graded to a different is_correct
// Only sessions marked "Done reviewing" (sessions.reviewed_at) are counted.

export type Agreement = { voice: number; agreed: number; stillReview: number };

export function speechAgreement(attempts: ReviewAttempt[]): Agreement {
  let voice = 0;
  let agreed = 0;
  let stillReview = 0;
  for (const a of attempts) {
    const regraded = !!a.regraded_at;
    const isVoice = regraded ? a.original_graded_by === "auto" : a.graded_by === "auto";
    if (!isVoice) continue;
    if (!regraded && a.needs_review) {
      stillReview++;
      continue;
    }
    voice++;
    if (!regraded || a.is_correct === a.original_is_correct) agreed++;
  }
  return { voice, agreed, stillReview };
}

export function agreementSentence(g: Agreement, who = "the teacher"): string {
  if (g.voice === 0) return "No voice answers to compare yet.";
  const pct = Math.round((g.agreed / g.voice) * 100);
  return `Speech grading agreed with ${who} on ${g.agreed} of ${g.voice} voice answers (${pct}%)`;
}

// ── Loading ───────────────────────────────────────────────────────────────────

type Result<T> = { data: T; error: null } | { data: null; error: string };

export async function loadReview(sessionId: string): Promise<Result<ReviewData>> {
  const [s, w, ss, a] = await Promise.all([
    supabase.from("sessions").select("*").eq("id", sessionId).maybeSingle(),
    supabase.from("session_words").select("id, word, order_index").eq("session_id", sessionId).order("order_index"),
    supabase.from("session_students").select("student_id").eq("session_id", sessionId),
    supabase.from("word_attempts").select(ATTEMPT_COLUMNS).eq("session_id", sessionId),
  ]);
  const err = s.error ?? w.error ?? ss.error ?? a.error;
  if (err) return { data: null, error: err.message };
  if (!s.data) return { data: null, error: "This session doesn't exist any more." };

  const attempts = (a.data ?? []) as unknown as ReviewAttempt[];
  // Assigned students, plus anyone with an answer (e.g. unassigned later)
  const studentIds = [
    ...new Set([...(ss.data ?? []).map((r) => r.student_id as string), ...attempts.map((x) => x.student_id)]),
  ];
  const regraderIds = [...new Set(attempts.map((x) => x.regraded_by).filter((x): x is string => !!x))];
  const [st, pr] = await Promise.all([
    studentIds.length
      ? supabase.from("students").select("id, full_name").in("id", studentIds).order("full_name")
      : Promise.resolve({ data: [], error: null }),
    // RLS: a teacher can read only their own profile; anyone else shows as "a teacher"
    regraderIds.length
      ? supabase.from("profiles").select("id, full_name").in("id", regraderIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (st.error) return { data: null, error: st.error.message };

  const names: Record<string, string> = {};
  for (const p of (pr.data ?? []) as { id: string; full_name: string | null }[]) {
    if (p.full_name) names[p.id] = p.full_name;
  }
  return {
    data: {
      session: s.data as ReviewSession,
      words: (w.data ?? []) as ReviewWord[],
      students: (st.data ?? []) as ReviewStudent[],
      attempts,
      names,
    },
    error: null,
  };
}

/** Every try for one student + word, oldest first. */
export async function loadTries(sessionWordId: string, studentId: string): Promise<Result<ReviewTry[]>> {
  const { data, error } = await supabase
    .from("answer_attempts")
    .select("id, attempt_no, transcript, result, confidence, response_time_ms, created_at, audio_path")
    .eq("session_word_id", sessionWordId)
    .eq("student_id", studentId)
    .order("attempt_no");
  if (error) return { data: null, error: error.message };
  return { data: (data ?? []) as ReviewTry[], error: null };
}

/** "Done reviewing": sessions.reviewed_at = now (migration 23; finished sessions only). */
export async function markReviewed(sessionId: string): Promise<Result<string>> {
  const { data, error } = await supabase
    .from("sessions")
    .update({ reviewed_at: new Date().toISOString() })
    .eq("id", sessionId)
    .select("reviewed_at")
    .maybeSingle();
  if (error) return { data: null, error: error.message };
  if (!data?.reviewed_at) return { data: null, error: "Not saved. Is this your session?" };
  return { data: data.reviewed_at as string, error: null };
}

export type AdminAgreement = { reviewedSessions: number; voice: number; agreed: number; stillReview: number };

/** Totals over every reviewed session (admin only, speech_grading_agreement in migration 23). */
export async function loadAdminAgreement(): Promise<Result<AdminAgreement>> {
  const { data, error } = await supabase.rpc("speech_grading_agreement");
  if (error) return { data: null, error: error.message };
  const row = (Array.isArray(data) ? data[0] : data) as
    | { reviewed_sessions: number; voice_answers: number; agreed: number; still_review: number }
    | undefined;
  return {
    data: {
      reviewedSessions: row?.reviewed_sessions ?? 0,
      voice: row?.voice_answers ?? 0,
      agreed: row?.agreed ?? 0,
      stillReview: row?.still_review ?? 0,
    },
    error: null,
  };
}

export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export async function reloadAttempt(id: string): Promise<ReviewAttempt | null> {
  const { data } = await supabase.from("word_attempts").select(ATTEMPT_COLUMNS).eq("id", id).maybeSingle();
  return (data as unknown as ReviewAttempt | null) ?? null;
}
