// mobile/lib/activities.ts
// Activities (word lists run as a session, migrations 16–17, 24, 25): types,
// the word-list parser, and the database calls the Activities screens use.
//
// Teachers own activities (migration 25). The teacher who made one edits the
// draft, publishes it, deletes the draft, and shares / un-shares it once it's
// published ("Share with all teachers"). Other teachers see shared published
// ones, run them and duplicate them (the copy is their own private draft).
// Admins only oversee: they read every activity and hide / unhide published
// ones. status "hidden" always means hidden by an admin.
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
  created_by: string | null;
  shared: boolean;
  /** The creator's name, copied when it was made (teachers can't read each
   *  other's profiles). Empty if their profile had no name. */
  author_name: string | null;
  /** When / which admin hid it (status "hidden"). */
  hidden_at: string | null;
  hidden_by: string | null;
  word_count: number;
};

/** Which app area an Activities screen is in: decides links and what can be managed. */
export type ActivitiesArea = "admin" | "teacher";

export const ACTIVITY_ROUTE: Record<ActivitiesArea, string> = {
  admin: "/admin/activity",
  teacher: "/(teacher)/sessions/activity",
};

/** Only the teacher who made an activity manages it (edit, publish, share,
 *  delete the draft). Admins never do: they only hide / unhide. */
export function canManage(activity: Pick<Activity, "created_by">, area: ActivitiesArea, me: string | null): boolean {
  return area === "teacher" && !!me && activity.created_by === me;
}

/** "Ms. Cruz", or "a teacher" when the name is empty. */
export function authorName(author: string | null | undefined): string {
  return author?.trim() || "a teacher";
}

/** "by Ms. Cruz" */
export function byAuthor(activity: Pick<Activity, "author_name">): string {
  return `by ${authorName(activity.author_name)}`;
}

/** The status as its owner sees it: "Hidden by admin" instead of "Hidden". */
export function ownerStatusLabel(status: ActivityStatus): string {
  return status === "hidden" ? "Hidden by admin" : STATUS_LABEL[status];
}

/** For an activity session: "Animals · by Ms. Cruz" (or just the name for a
 *  session started before migration 25 copied the author). */
export function activitySessionLabel(name: string | null | undefined, author: string | null | undefined): string {
  if (!name) return "";
  return author?.trim() ? `${name} · by ${author.trim()}` : name;
}

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

/** The signed-in user's id, from the stored session (no network call). */
export async function myUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

const ACTIVITY_COLUMNS =
  "id, name, description, level, status, created_at, published_at, created_by, shared, author_name, hidden_at, hidden_by";

type ActivityRow = Omit<Activity, "word_count">;

function toActivity(a: ActivityRow, word_count: number): Activity {
  return { ...a, word_count };
}

/** Every activity this user can see (RLS): all for an admin; shared published + own for a teacher. */
export async function listActivities(): Promise<Result<Activity[]>> {
  const { data, error } = await supabase
    .from("activities")
    .select(`${ACTIVITY_COLUMNS}, activity_words(count)`)
    .order("created_at", { ascending: false });
  if (error) return fail(error);
  return {
    data: (data ?? []).map(({ activity_words, ...a }) =>
      toActivity(a as unknown as ActivityRow, (activity_words as { count: number }[] | null)?.[0]?.count ?? 0)
    ),
    error: null,
  };
}

export async function getActivity(id: string): Promise<Result<{ activity: Activity; words: ActivityWord[] }>> {
  const [a, w] = await Promise.all([
    supabase
      .from("activities")
      .select(ACTIVITY_COLUMNS)
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
  return { data: { activity: toActivity(a.data as unknown as ActivityRow, words.length), words }, error: null };
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

/** The owner publishes a draft, shared with every teacher or not (one update). */
export async function publishActivity(id: string, shared: boolean): Promise<Result<true>> {
  const { data, error } = await supabase
    .from("activities")
    .update({ status: "published", shared })
    .eq("id", id)
    .select("id");
  if (error) return fail(error);
  if (!data?.length) return { data: null, error: "Nothing changed. Only the teacher who made it can publish it." };
  return { data: true, error: null };
}

/** The owner shares / un-shares a published activity. Sessions that already
 *  used it keep their own copy of the words, so nothing else changes. */
export async function setActivityShared(id: string, shared: boolean): Promise<Result<true>> {
  const { data, error } = await supabase.from("activities").update({ shared }).eq("id", id).select("id");
  if (error) return fail(error);
  if (!data?.length) return { data: null, error: "Nothing changed. Only the teacher who made it can share it." };
  return { data: true, error: null };
}

/** Admin moderation: published ↔ hidden. The database refuses anything else. */
export async function setActivityHidden(id: string, hidden: boolean): Promise<Result<true>> {
  const { data, error } = await supabase
    .from("activities")
    .update({ status: hidden ? "hidden" : "published" })
    .eq("id", id)
    .select("id");
  if (error) return fail(error);
  if (!data?.length) return { data: null, error: "Nothing changed. Only an admin can hide or unhide an activity." };
  return { data: true, error: null };
}

/** Drafts only (RLS). Returns an error when nothing was deleted. */
export async function deleteDraft(id: string): Promise<Result<true>> {
  const { data, error } = await supabase.from("activities").delete().eq("id", id).select("id");
  if (error) return fail(error);
  if (!data?.length) return { data: null, error: "Only drafts can be deleted. Hide a published activity instead." };
  return { data: true, error: null };
}

/** Copies an activity this teacher can see into a new private draft they own;
 *  returns the new id. A hidden activity can't be copied (migration 25). */
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
