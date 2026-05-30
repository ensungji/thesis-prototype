// mobile/lib/braille.ts
// Braille A–Z encoding + helpers.
// Extracted from the prototype's index.tsx — delete that copy once this is wired in.
//
// Dot numbering:
//   1  4
//   2  5
//   3  6
// (left column top-to-bottom, then right column)

export const BRAILLE_MAP: Record<string, number[]> = {
  A: [1],         B: [1, 2],       C: [1, 4],       D: [1, 4, 5],    E: [1, 5],
  F: [1, 2, 4],   G: [1, 2, 4, 5], H: [1, 2, 5],    I: [2, 4],       J: [2, 4, 5],
  K: [1, 3],      L: [1, 2, 3],    M: [1, 3, 4],     N: [1, 3, 4, 5], O: [1, 3, 5],
  P: [1, 2, 3, 4], Q: [1, 2, 3, 4, 5], R: [1, 2, 3, 5], S: [2, 3, 4], T: [2, 3, 4, 5],
  U: [1, 3, 6],   V: [1, 2, 3, 6], W: [2, 4, 5, 6],  X: [1, 3, 4, 6], Y: [1, 3, 4, 5, 6],
  Z: [1, 3, 5, 6],
};

/**
 * Returns the raised-dot pattern for a single letter.
 * Returns [] for any character not in the map (spaces, punctuation, etc.).
 */
export function getPattern(letter: string): number[] {
  return BRAILLE_MAP[letter.toUpperCase()] ?? [];
}

/**
 * Splits a word into an array of uppercase A–Z characters only.
 * Strips spaces, numbers, and punctuation — ESP32 only handles A–Z.
 * e.g. "Hello!" → ["H", "E", "L", "L", "O"]
 */
export function wordToLetters(word: string): string[] {
  return word.toUpperCase().split("").filter((c) => /[A-Z]/.test(c));
}

/**
 * Returns true if the word contains at least one mappable letter
 * and every letter has a braille pattern.
 */
export function isValidWord(word: string): boolean {
  const letters = wordToLetters(word);
  return letters.length > 0 && letters.every((c) => c in BRAILLE_MAP);
}

/**
 * (For preview only) Checks if a dot position (1–6) is raised
 * for the given letter.
 */
export function isDotRaised(letter: string, dot: number): boolean {
  return getPattern(letter).includes(dot);
}