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
