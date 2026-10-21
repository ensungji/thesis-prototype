// mobile/lib/word-order.ts
// Shuffling a Timed Sequence and saving the new order.
// Used by the session screen and the add-word screen.

import { supabase } from "./supabase";

// Fisher-Yates algorithm for unbiased, true randomization
export function fisherYatesShuffle<T extends { id: string }>(items: T[]): T[] {
  if (items.length <= 1) return [...items];
  const shuffled = [...items];
  for (let attempt = 0; attempt < 3; attempt++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const isSameOrder = shuffled.every((item, idx) => item.id === items[idx].id);
    if (!isSameOrder) break;
  }
  return shuffled;
}

/**
 * Saves the session's word order in one server call: every position is saved,
 * or none (reorder_session_words). Returns "" on success, else the error.
 */
export async function saveWordOrder(sessionId: string, wordIds: string[]): Promise<string> {
  try {
    const { error } = await supabase.rpc("reorder_session_words", {
      p_session: sessionId,
      p_ids: wordIds,
    });
    return error ? error.message : "";
  } catch (err) {
    return String((err as { message?: string })?.message ?? err);
  }
}
