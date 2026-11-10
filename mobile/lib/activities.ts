// mobile/lib/activities.ts
// Activities (admin-made word lists, migrations 16–17): types, the word-list
// parser, and the database calls the admin screens use.
//
// The database enforces the rules (RLS + triggers); these helpers only make
// the calls and pass its error messages on, e.g. "Add at least one word
// before publishing" or "A published activity can't be edited".

import { supabase } from "./supabase";
import { colors as C } from "./theme";
import { type Difficulty } from "./difficulty";
import { MAX_WORD_DURATION_SEC, MIN_WORD_DURATION_SEC } from "./session-timer";

export type ActivityStatus = "draft" | "published" | "hidden";

export type Activity = {
  id: string;
  name: string;
  description: string | null;
  level: Difficulty | null;
  status: ActivityStatus;
  created_at: string;
  published_at: string | null;
  word_count: number;
};

export type ActivityWord = {
  id: string;
  activity_id: string;
  position: number;
  word: string;
  duration_seconds: number;
};

/** Default hold time for an activity word (activity_words.duration_seconds default). */
export const ACTIVITY_WORD_DEFAULT_SEC = 20;
/** activity_words.word: A-Z only, 1-40 letters. */
export const ACTIVITY_WORD_MAX_LETTERS = 40;

export const STATUS_LABEL: Record<ActivityStatus, string> = {
  draft: "Draft",
  published: "Published",
  hidden: "Hidden",
};

export const STATUS_COLORS: Record<ActivityStatus, { bg: string; text: string }> = {
  draft: { bg: C.blueWash, text: C.navy },
  published: { bg: C.greenBg, text: C.green },
  hidden: { bg: C.border, text: C.ink },
};

export function clampActivityDuration(sec: number): number {
  if (!Number.isFinite(sec)) return ACTIVITY_WORD_DEFAULT_SEC;
  return Math.max(MIN_WORD_DURATION_SEC, Math.min(MAX_WORD_DURATION_SEC, Math.round(sec)));
}

// ── Word list parser ──────────────────────────────────────────────────────────

export type DroppedWord = { text: string; reason: string };
export type ParsedWords = { words: string[]; dropped: DroppedWord[] };

/**
 * Turns typed / pasted text into activity words.
 * Words are separated by commas, spaces or new lines, and uppercased.
 * Dropped (and listed, so the admin sees why):
 *   - anything with a character that isn't a letter A-Z ("don't", "café", "3")
 *   - words longer than 40 letters
 *   - repeats, within the text or of a word already in the activity
 */
export function parseWordList(text: string, existing: string[] = []): ParsedWords {
  const seen = new Set(existing.map((w) => w.toUpperCase()));
  const words: string[] = [];
  const dropped: DroppedWord[] = [];
  for (const token of text.split(/[\s,]+/)) {
    if (!token) continue;
    const word = token.toUpperCase();
    if (!/^[A-Z]+$/.test(word)) {
      dropped.push({ text: token, reason: "not A–Z letters only" });
    } else if (word.length > ACTIVITY_WORD_MAX_LETTERS) {
      dropped.push({ text: token, reason: `longer than ${ACTIVITY_WORD_MAX_LETTERS} letters` });
    } else if (seen.has(word)) {
      dropped.push({ text: token, reason: "already in the list" });
    } else {
      seen.add(word);
      words.push(word);
    }
  }
  return { words, dropped };
}

/** "don't (not A–Z letters only), CAT (already in the list)" */
export function describeDropped(dropped: DroppedWord[]): string {
  return dropped.map((d) => `${d.text} (${d.reason})`).join(", ");
}

// ── Database ──────────────────────────────────────────────────────────────────

type Result<T> = { data: T; error: null } | { data: null; error: string };
const fail = (e: { message: string }) => ({ data: null, error: e.message }) as const;

export async function listActivities(): Promise<Result<Activity[]>> {
  const { data, error } = await supabase
    .from("activities")
    .select("id, name, description, level, status, created_at, published_at, activity_words(count)")
    .order("created_at", { ascending: false });
  if (error) return fail(error);
  return {
    data: (data ?? []).map(({ activity_words, ...a }) => ({
      ...(a as Omit<Activity, "word_count">),
      word_count: (activity_words as { count: number }[] | null)?.[0]?.count ?? 0,
    })),
    error: null,
  };
}

export async function getActivity(id: string): Promise<Result<{ activity: Activity; words: ActivityWord[] }>> {
  const [a, w] = await Promise.all([
    supabase
      .from("activities")
      .select("id, name, description, level, status, created_at, published_at")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("activity_words")
      .select("id, activity_id, position, word, duration_seconds")
      .eq("activity_id", id)
      .order("position"),
  ]);
  if (a.error) return fail(a.error);
  if (w.error) return fail(w.error);
  if (!a.data) return { data: null, error: "This activity doesn't exist any more." };
  const words = (w.data ?? []) as ActivityWord[];
  return { data: { activity: { ...(a.data as Omit<Activity, "word_count">), word_count: words.length }, words }, error: null };
}

export type ActivityDetails = { name: string; description: string | null; level: Difficulty | null };

export async function createActivity(d: ActivityDetails): Promise<Result<string>> {
  const { data, error } = await supabase.from("activities").insert(d).select("id").single();
  if (error) return fail(error);
  return { data: data.id as string, error: null };
}

export async function updateActivityDetails(id: string, d: ActivityDetails): Promise<Result<true>> {
  const { error } = await supabase.from("activities").update(d).eq("id", id);
  return error ? fail(error) : { data: true, error: null };
}

/** draft → published, published ↔ hidden. The database refuses anything else. */
export async function setActivityStatus(id: string, status: ActivityStatus): Promise<Result<true>> {
  const { data, error } = await supabase.from("activities").update({ status }).eq("id", id).select("id");
  if (error) return fail(error);
  if (!data?.length) return { data: null, error: "Nothing changed. Is this account still an admin?" };
  return { data: true, error: null };
}

/** Drafts only (RLS). Returns an error when nothing was deleted. */
export async function deleteDraft(id: string): Promise<Result<true>> {
  const { data, error } = await supabase.from("activities").delete().eq("id", id).select("id");
  if (error) return fail(error);
  if (!data?.length) return { data: null, error: "Only drafts can be deleted. Hide a published activity instead." };
  return { data: true, error: null };
}

/** Copies an activity (any status) into a new draft; returns the new id. */
export async function duplicateActivity(id: string): Promise<Result<string>> {
  const { data, error } = await supabase.rpc("duplicate_activity", { p_activity: id });
  if (error) return fail(error);
  return { data: data as string, error: null };
}

/** Adds words at the end, in order, with the default time. */
export async function addWords(activityId: string, words: string[], afterPosition: number): Promise<Result<ActivityWord[]>> {
  if (words.length === 0) return { data: [], error: null };
  const rows = words.map((word, i) => ({
    activity_id: activityId,
    position: afterPosition + 1 + i,
    word,
    duration_seconds: ACTIVITY_WORD_DEFAULT_SEC,
  }));
  const { data, error } = await supabase
    .from("activity_words")
    .insert(rows)
    .select("id, activity_id, position, word, duration_seconds");
  if (error) return fail(error);
  return { data: ((data ?? []) as ActivityWord[]).sort((a, b) => a.position - b.position), error: null };
}

export async function setWordDuration(wordId: string, sec: number): Promise<Result<true>> {
  const { error } = await supabase
    .from("activity_words")
    .update({ duration_seconds: clampActivityDuration(sec) })
    .eq("id", wordId);
  return error ? fail(error) : { data: true, error: null };
}

export async function removeWord(wordId: string): Promise<Result<true>> {
  const { error } = await supabase.from("activity_words").delete().eq("id", wordId);
  return error ? fail(error) : { data: true, error: null };
}

/**
 * Saves new positions for the given words in ONE request (an upsert), so a
 * swap never trips the unique (activity_id, position) rule: it's checked only
 * when the request's transaction ends (DEFERRABLE, migration 16).
 */
export async function savePositions(words: ActivityWord[]): Promise<Result<true>> {
  if (words.length === 0) return { data: true, error: null };
  const { error } = await supabase.from("activity_words").upsert(
    words.map((w) => ({
      id: w.id,
      activity_id: w.activity_id,
      position: w.position,
      word: w.word,
      duration_seconds: w.duration_seconds,
    })),
    { onConflict: "id" }
  );
  return error ? fail(error) : { data: true, error: null };
}
