// mobile/lib/word-bank.ts
// The teacher's Word Bank plus the shared words (teacher_id = null), for
// picking words: the Add Word screen and the Live session's Word Bank sheet.

import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { supabase } from "./supabase";
import { type Difficulty, getDifficultyFromLength } from "./difficulty";

export type WordBankItem = {
  id: string;
  word: string;
  category?: string | null;
  difficulty?: string | null;
  shared: boolean; // a shared word, not one of the teacher's own
};

/** The word's saved difficulty, or one guessed from its length. */
export function wordDifficulty(w: { word: string; difficulty?: string | null }): Difficulty {
  return w.difficulty === "easy" || w.difficulty === "medium" || w.difficulty === "hard"
    ? w.difficulty
    : getDifficultyFromLength(w.word);
}

/** Words matching a search text and (optionally) a difficulty. */
export function filterWordBank(words: WordBankItem[], search: string, difficulty: Difficulty | null = null) {
  const q = search.trim().toLowerCase();
  return words.filter(
    (w) =>
      w.word.toLowerCase().includes(q) &&
      (difficulty ? wordDifficulty(w) === difficulty : true)
  );
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
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const { data, error: loadError } = await supabase
        .from("word_library")
        .select("id, word, category, difficulty, teacher_id")
        .or(`teacher_id.eq.${user.id},teacher_id.is.null`)
        .order("word");
      if (loadError) {
        setError(loadError.message); // keep the words already loaded
        return;
      }
      // A word in both lists is shown once, as the teacher's own
      const byWord = new Map<string, WordBankItem>();
      for (const row of data ?? []) {
        const key = row.word.toUpperCase();
        const item: WordBankItem = {
          id: row.id,
          word: row.word,
          category: row.category,
          difficulty: row.difficulty,
          shared: row.teacher_id == null,
        };
        if (!byWord.has(key) || !item.shared) byWord.set(key, item);
      }
      setWords([...byWord.values()]);
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
