// mobile/lib/session-timer.ts
// Shared constants, hardware safety constraints, and helpers for Timed Sequence sessions.

import AsyncStorage from "@react-native-async-storage/async-storage";

// ── Hardware Safety Limits (CRITICAL) ─────────────────────────────────────────
// Solenoids in the Braille display heat up quickly under continuous duty.
// They MUST NOT remain energized for longer than 60 seconds per word.
export const MIN_WORD_DURATION_SEC = 5;
export const MAX_WORD_DURATION_SEC = 60;
export const DEFAULT_WORD_DURATION_SEC = 10;

/**
 * Hard-caps any duration value strictly between MIN_WORD_DURATION_SEC (5)
 * and MAX_WORD_DURATION_SEC (60).
 */
export function clampDuration(sec?: number | null): number {
  if (sec == null || isNaN(sec)) return DEFAULT_WORD_DURATION_SEC;
  return Math.max(
    MIN_WORD_DURATION_SEC,
    Math.min(MAX_WORD_DURATION_SEC, Math.round(sec))
  );
}

// ── Session Type Helpers ──────────────────────────────────────────────────────
// "Live Session" (formerly "Manual")
// "Timed Sequence" (formerly "Word List")

export type SessionType =
  | "live_session"
  | "timed_sequence"
  | "manual"
  | "word_list";

export function isTimedSequence(type?: string | null): boolean {
  return type === "timed_sequence" || type === "word_list";
}

export function isLiveSession(type?: string | null): boolean {
  return type === "live_session" || type === "live" || type === "manual";
}

export function getSessionTypeLabel(type?: string | null): string {
  return isTimedSequence(type) ? "Timed Sequence" : "Live Session";
}

// ── Local Duration Persistence (Fallback & Cache) ─────────────────────────────

const DURATION_KEY_PREFIX = "session_word_durations_";

export async function saveWordDurations(
  sessionId: string,
  durations: Record<string, number>
): Promise<void> {
  try {
    const key = `${DURATION_KEY_PREFIX}${sessionId}`;
    await AsyncStorage.setItem(key, JSON.stringify(durations));
  } catch {
    // Ignore storage errors
  }
}

export async function loadWordDurations(
  sessionId: string
): Promise<Record<string, number>> {
  try {
    const key = `${DURATION_KEY_PREFIX}${sessionId}`;
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const clamped: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number") {
        clamped[k] = clampDuration(v);
      }
    }
    return clamped;
  } catch {
    return {};
  }
}
