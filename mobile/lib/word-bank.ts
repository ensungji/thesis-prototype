// mobile/lib/word-bank.ts
// The shared Word Bank (migration 29): every active teacher reads every
// teacher's words, plus the old shared words (teacher_id = null). Used by the
// Word Bank tab, Add Word's Word Bank tab, the Live session's Word Bank sheet
// and the activity editor's From Word Bank.
//   - each word is listed once (case-insensitive); the teacher's own copy wins
//   - mine = the teacher's own word (only these can be deleted);
//     shared = anyone else's (other teachers', or teacher_id null)
//   - "Already in your Word Bank" (saveWordToBank) still checks only the
//     teacher's own words

import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { supabase } from "./supabase";
import { type Difficulty, getDifficultyFromLength } from "./difficulty";

export type WordBankItem = {
  id: string;
  word: string;
  category?: string | null;
  difficulty?: string | null;
  mine: boolean; // the signed-in teacher's own word (can delete it)
  shared: boolean; // = !mine: added by another teacher (or an old shared word)
};

/** Mine / All chips. */
export type WordBankScope = "all" | "mine";

/** The word's saved difficulty, or one guessed from its length. */
export function wordDifficulty(w: { word: string; difficulty?: string | null }): Difficulty {
  return w.difficulty === "easy" || w.difficulty === "medium" || w.difficulty === "hard"
    ? w.difficulty
    : getDifficultyFromLength(w.word);
}

/** Words matching a search text, (optionally) a difficulty, and Mine / All. */
export function filterWordBank(
  words: WordBankItem[],
  search: string,
  difficulty: Difficulty | null = null,
  scope: WordBankScope = "all",
) {
  const q = search.trim().toLowerCase();
  return words.filter(
    (w) =>
      w.word.toLowerCase().includes(q) &&
      (difficulty ? wordDifficulty(w) === difficulty : true) &&
      (scope === "mine" ? w.mine : true)
  );
}

const PAGE = 1000;

/**
 * Every word the teacher can read (RLS: all words for an active teacher),
 * each word once, A–Z. Paged, so more than 1,000 rows are never cut off.
 */
export async function loadWordBank(): Promise<{ words: WordBankItem[]; error: string | null }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const uid = sessionData.session?.user.id;
  if (!uid) return { words: [], error: "You're signed out." };

  type Row = { id: string; word: string; category: string | null; difficulty: string | null; teacher_id: string | null };
  const rows: Row[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await supabase
      .from("word_library")
      .select("id, word, category, difficulty, teacher_id")
      .order("word")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) return { words: [], error: error.message };
    if (!data || data.length === 0) break;
    rows.push(...(data as Row[]));
    from += data.length;
  }

  const byWord = new Map<string, WordBankItem>();
  for (const row of rows) {
    const key = row.word.trim().toUpperCase();
    if (!key) continue;
    const mine = row.teacher_id === uid;
    const item: WordBankItem = {
      id: row.id,
      word: row.word,
      category: row.category,
      difficulty: row.difficulty,
      mine,
      shared: !mine,
    };
    // the teacher's own copy wins; otherwise the first one (A–Z, then id)
    if (!byWord.has(key) || (mine && !byWord.get(key)!.mine)) byWord.set(key, item);
  }
  const words = [...byWord.values()].sort((a, b) => a.word.toUpperCase().localeCompare(b.word.toUpperCase()));
  return { words, error: null };
}

export type SaveToBankResult =
  | { status: "saved" }
  | { status: "exists" } // already in the teacher's own Word Bank (any letter case)
  | { status: "error"; message: string };

/**
 * Saves a word to the signed-in teacher's own Word Bank (category "My Words"),
 * unless they already have it.
 *   - The user comes from the stored session (no network call), so a slow
 *     auth server can't silently skip the save.
 *   - The "already saved" lookup ignores letter case (older words may be
 *     lower case) and tolerates copies saved twice (limit 1, not maybeSingle,
 *     which errors on 2+ rows).
 *   - A failed lookup is reported, not taken as "not saved yet".
 * Words are saved in capitals, as typed (A–Z only, so ilike has no wildcards).
 */
export async function saveWordToBank(word: string, difficulty: Difficulty): Promise<SaveToBankResult> {
  const w = word.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(w)) return { status: "error", message: "Only letters A–Z can be saved." };

  const { data: sessionData } = await supabase.auth.getSession();
  const uid = sessionData.session?.user.id;
  if (!uid) return { status: "error", message: "You're signed out. Sign in again to save to your Word Bank." };

  const { data: existing, error: lookupError } = await supabase
    .from("word_library")
    .select("id")
    .eq("teacher_id", uid)
    .ilike("word", w)
    .limit(1);
  if (lookupError) return { status: "error", message: lookupError.message };
  if (existing && existing.length > 0) return { status: "exists" };

  const { error: insertError } = await supabase.from("word_library").insert({
    teacher_id: uid,
    word: w,
    category: "My Words",
    difficulty,
  });
  if (insertError) return { status: "error", message: insertError.message };
  return { status: "saved" };
}

/**
 * Loads the Word Bank. By default it reloads every time the screen comes into
 * focus, so words added in the Word Bank tab show up; pass
 * { reloadOnFocus: false } to load only when reload() is called.
 */
export function useWordBank({ reloadOnFocus = true }: { reloadOnFocus?: boolean } = {}) {
  const [words, setWords] = useState<WordBankItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await loadWordBank();
      if (res.error) {
        setError(res.error); // keep the words already loaded
        return;
      }
      setWords(res.words);
      setError("");
    } catch (err) {
      setError(String((err as { message?: string })?.message ?? err));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (reloadOnFocus) reload();
    }, [reloadOnFocus, reload])
  );

  return { words, loading, error, reload };
}
