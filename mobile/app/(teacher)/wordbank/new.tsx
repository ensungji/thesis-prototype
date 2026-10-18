// mobile/app/(teacher)/wordbank/new.tsx
// Dedicated screen for adding a new word to the word bank.
// Difficulty is auto-assigned from word length but can be manually overridden.

import { useState, useMemo } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../lib/supabase";
import { colors as C, fonts, radius } from "../../../lib/theme";
import { isValidWord } from "../../../lib/braille";
import {
  type Difficulty,
  DIFFICULTIES,
  DIFFICULTY_META,
  getDifficultyFromLength,
} from "../../../lib/difficulty";
import { wordbankToastBus } from "../../../lib/wordbank-toast";

export default function NewWordScreen() {
  const router = useRouter();

  const [word, setWord] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-suggested difficulty, derived from live word input
  const suggestedDifficulty = useMemo(
    () => (word.trim().length > 0 ? getDifficultyFromLength(word) : null),
    [word]
  );

  // Manual override — null means "follow the suggestion"
  const [overrideDifficulty, setOverrideDifficulty] =
    useState<Difficulty | null>(null);

  // The effective difficulty to save
  const effectiveDifficulty: Difficulty =
    overrideDifficulty ?? suggestedDifficulty ?? "easy";

  function handleWordChange(v: string) {
    // Strip anything that isn't a letter — enforces A-Z as the user types
    // so numbers, spaces, and symbols are silently removed before validation.
    const stripped = v.replace(/[^a-zA-Z]/g, "").toUpperCase();
    setWord(stripped);
    setError(null);
    // Reset override when word changes so the auto-suggestion kicks in fresh
    setOverrideDifficulty(null);
  }

  function handleOverride(d: Difficulty) {
    // Tapping the already-selected override deselects it (reverts to suggestion)
    setOverrideDifficulty((prev) => (prev === d ? null : d));
  }

  async function saveWord() {
    const w = word.trim().toUpperCase();
    setError(null);

    if (!w) return;
    if (!isValidWord(w)) {
      setError("Only letters A–Z are supported.");
      return;
    }

    setSaving(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) { setSaving(false); return; }

    // Check for duplicate
    const { data: existing } = await supabase
      .from("word_library")
      .select("id")
      .eq("teacher_id", user.id)
      .eq("word", w)
      .maybeSingle();

    if (existing) {
      setError(`"${w}" is already in your word bank.`);
      setSaving(false);
      return;
    }

    const { error: insertError } = await supabase.from("word_library").insert({
      teacher_id: user.id,
      word: w,
      category: "My Words",
      difficulty: effectiveDifficulty,
    });

    setSaving(false);
    if (insertError) {
      console.log("Supabase Error:", insertError);
      setError("Something went wrong. Please try again.");
      return;
    }

    // Emit the success event synchronously before unmounting.
    // index.tsx listens via wordbankToastBus and shows the toast there.
    wordbankToastBus.emit({ type: "added", word: w });
    router.back();
  }

  const activeMeta = DIFFICULTY_META[effectiveDifficulty];
  const showDifficultySection = word.trim().length > 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
        >
          <Ionicons name="arrow-back" size={20} color={C.navy} />
          <Text style={styles.backText}>Word Bank</Text>
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── Title ── */}
          <View style={styles.titleBlock}>
            <Text style={styles.pageTitle}>Add Word</Text>
            <Text style={styles.pageSubtitle}>
              Words saved here can be picked when building session word lists.
            </Text>
          </View>

          {/* ── Word input ── */}
          <View style={styles.fieldGroup}>
            {/* Wrapper carries all visual chrome so the TextInput is layout-neutral */}
            <View style={[styles.wordInputWrapper, error && styles.wordInputWrapperError]}>
              <TextInput
                style={styles.wordInput}
                value={word}
                onChangeText={handleWordChange}
                placeholder="TYPE A WORD"
                placeholderTextColor={C.muted}
                autoFocus
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={saveWord}
              />
            </View>
            {error && (
              <View style={styles.errorRow}>
                <Ionicons name="alert-circle-outline" size={14} color={C.red} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
            <Text style={styles.hint}>Only letters A–Z (no numbers or symbols).</Text>
          </View>

          {/* ── Difficulty section (appears once typing starts) ── */}
          {showDifficultySection && (
            <View style={styles.difficultyCard}>
              {/* Section header + live preview badge */}
              <View style={styles.diffCardHeader}>
                <View>
                  <Text style={styles.diffCardTitle}>Difficulty</Text>
                  <Text style={styles.diffCardHint}>
                    {overrideDifficulty
                      ? "Manually set — tap again to revert."
                      : "Auto-assigned. Tap to override."}
                  </Text>
                </View>

                {/* Live preview — solid chip styling */}
                <View
                  style={[
                    styles.previewChip,
                    { backgroundColor: activeMeta.chipBg },
                  ]}
                >
                  <Text style={[styles.previewChipText, { color: activeMeta.chipText }]}>
                    {activeMeta.label}
                  </Text>
                </View>
              </View>

              {/* ── Override selector chips ── */}
              <View style={styles.overrideRow}>
                {DIFFICULTIES.map((d) => {
                  const meta = DIFFICULTY_META[d];
                  const isSelected = effectiveDifficulty === d;
                  const isAutoSuggested = !overrideDifficulty && suggestedDifficulty === d;

                  return (
                    <Pressable
                      key={d}
                      onPress={() => handleOverride(d)}
                      style={({ pressed }) => [
                        styles.overrideChip,
                        isSelected
                          ? { backgroundColor: meta.chipBg }
                          : styles.overrideChipInactive,
                        pressed && { opacity: 0.8 },
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={`Set difficulty to ${meta.label}${isAutoSuggested ? " (auto)" : ""}`}
                    >
                      <Text
                        style={[
                          styles.overrideChipLabel,
                          { color: isSelected ? meta.chipText : C.muted },
                        ]}
                      >
                        {meta.label}
                      </Text>

                      {/* Small dot — marks the auto-suggested chip */}
                      {isAutoSuggested && (
                        <View
                          style={[
                            styles.autoDot,
                            {
                              backgroundColor: isSelected
                                ? meta.chipText
                                : meta.chipBg,
                            },
                          ]}
                        />
                      )}
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}

          {/* ── Save button ── */}
          <Pressable
            onPress={saveWord}
            disabled={saving || !word.trim()}
            style={({ pressed }) => [
              styles.saveBtn,
              (!word.trim() || saving) && { opacity: 0.5 },
              pressed && { opacity: 0.85 },
            ]}
          >
            {saving ? (
              <ActivityIndicator color="#1A1200" />
            ) : (
              <>
                <Ionicons name="checkmark" size={18} color="#1A1200" />
                <Text style={styles.saveBtnText}>Save to Word Bank</Text>
              </>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const CHIP_INACTIVE_BG = "#EDEDEB";

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },

  // ── Header ──────────────────────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: C.white,
    borderBottomWidth: 1.5,
    borderBottomColor: C.border,
  },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 6 },
  backText: { fontFamily: fonts.heading, fontSize: 15, color: C.navy },

  // ── Content ─────────────────────────────────────────────────────────────────
  content: {
    padding: 20,
    gap: 28,
  },

  titleBlock: { gap: 6 },
  pageTitle: { fontFamily: fonts.heading, fontSize: 28, color: C.navy },
  pageSubtitle: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: C.muted,
    lineHeight: 20,
  },

  // ── Word input ───────────────────────────────────────────────────────────────
  fieldGroup: { gap: 8 },
  // The wrapper holds all visual chrome (bg, border, radius, padding).
  // Keeping these off the TextInput itself fixes the Android cursor-right bug
  // caused by letterSpacing + textAlign:center on a self-sized input.
  wordInputWrapper: {
    backgroundColor: C.white,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 18,
  },
  wordInputWrapperError: { borderColor: C.red },
  wordInput: {
    flex: 1,
    margin: 0,
    padding: 0,
    fontFamily: fonts.mono,
    fontSize: 22,
    letterSpacing: 0,
    color: C.ink,
    textAlign: "left",
  },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  errorText: { fontFamily: fonts.body, fontSize: 13, color: C.red },
  hint: { fontFamily: fonts.body, fontSize: 12, color: C.muted },

  // ── Difficulty card ──────────────────────────────────────────────────────────
  difficultyCard: {
    gap: 14,
    backgroundColor: C.white,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: C.border,
    padding: 16,
  },
  diffCardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  diffCardTitle: {
    fontFamily: fonts.heading,
    fontSize: 15,
    color: C.navy,
    marginBottom: 3,
  },
  diffCardHint: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: C.muted,
    lineHeight: 17,
  },

  // Live preview chip (solid, matches active override)
  previewChip: {
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  previewChipText: {
    fontFamily: fonts.headingSemi,
    fontSize: 13,
    letterSpacing: 0.3,
  },

  // ── Override chip selector ───────────────────────────────────────────────────
  overrideRow: {
    flexDirection: "row",
    gap: 8,
  },
  overrideChip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    borderRadius: radius.pill,
    paddingVertical: 10,
    // backgroundColor applied inline
  },
  overrideChipInactive: {
    backgroundColor: CHIP_INACTIVE_BG,
  },
  overrideChipLabel: {
    fontFamily: fonts.headingSemi,
    fontSize: 13,
    letterSpacing: 0.3,
  },
  // Small dot that marks the auto-suggested chip
  autoDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    opacity: 0.7,
  },

  // ── Save button ──────────────────────────────────────────────────────────────
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: C.amber,
    borderRadius: 14,
    paddingVertical: 16,
  },
  saveBtnText: { fontFamily: fonts.heading, fontSize: 17, color: "#1A1200" },
});
