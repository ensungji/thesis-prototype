// mobile/lib/difficulty.ts
// Shared helpers for the Easy / Medium / Hard difficulty system.
//
// Color split:
//   badgeBg / badgeText / badgeBorder  → tinted, subtle — used on word cards
//   chipBg  / chipText                 → solid, high-contrast — used on active filter/override chips

import { colors as C } from "./theme";

// ─── Type ────────────────────────────────────────────────────────────────────

export type Difficulty = "easy" | "medium" | "hard";

/** All known difficulty values, in display order. */
export const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

// ─── Auto-assignment ─────────────────────────────────────────────────────────

/**
 * Derive a default difficulty from the word's character count.
 *  ≤ 3 letters → easy
 *  4–5 letters → medium
 *  ≥ 6 letters → hard
 */
export function getDifficultyFromLength(word: string): Difficulty {
  const len = word.trim().length;
  if (len <= 3) return "easy";
  if (len <= 5) return "medium";
  return "hard";
}

// ─── Visual metadata ─────────────────────────────────────────────────────────

export type DifficultyMeta = {
  label: string;
  /** Card badge — tinted subtle background */
  badgeBg: string;
  badgeText: string;
  badgeBorder: string;
  /** Active filter / override chip — solid high-contrast background */
  chipBg: string;
  chipText: string;
};

/**
 * Visual styling for each difficulty tier.
 *
 *  easy   → green  family  (intuitive: green = easy / go)
 *  medium → amber  family  (intuitive: yellow/amber = caution / medium)
 *  hard   → red    family  (intuitive: red/orange = danger / hard)
 */
export const DIFFICULTY_META: Record<Difficulty, DifficultyMeta> = {
  easy: {
    label: "Easy",
    // Card badge — soft green wash
    badgeBg: C.greenBg,
    badgeText: C.green,
    badgeBorder: C.green,
    // Active chip — solid vibrant green
    chipBg: C.diffEasy,
    chipText: C.white,
  },
  medium: {
    label: "Medium",
    // Card badge — warm amber wash
    badgeBg: C.brownBg,
    badgeText: C.brown,
    badgeBorder: C.amber,
    // Active chip — solid amber (existing token)
    chipBg: C.amber,
    chipText: "#1A1200",
  },
  hard: {
    label: "Hard",
    // Card badge — soft red wash
    badgeBg: C.redBg,
    badgeText: C.red,
    badgeBorder: C.red,
    // Active chip — solid red-orange
    chipBg: C.diffHard,
    chipText: C.white,
  },
};
