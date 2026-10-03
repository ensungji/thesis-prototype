// mobile/app/(teacher)/sessions/add-word.tsx
// Full-screen flow for adding a word to a session's word list.
// Receives sessionId via params.
// Tabs: New Word | Word Bank | Word List (preview + reorder)

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  FlatList,
  Modal,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  ActivityIndicator,
  Switch,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../lib/supabase";
import { colors as C, fonts, radius } from "../../../lib/theme";
import { isValidWord } from "../../../lib/braille";
import { Toast } from "../../../components/Toast";
import {
  type Difficulty,
  DIFFICULTIES,
  DIFFICULTY_META,
  getDifficultyFromLength,
} from "../../../lib/difficulty";
import {
  MIN_WORD_DURATION_SEC,
  MAX_WORD_DURATION_SEC,
  DEFAULT_WORD_DURATION_SEC,
  clampDuration,
  saveWordDurations,
  loadWordDurations,
} from "../../../lib/session-timer";
import DraggableFlatList, {
  ScaleDecorator,
} from "react-native-draggable-flatlist";

type WordBankItem = {
  id: string;
  word: string;
  category?: string;
  difficulty?: string;
};
type SessionWord = {
  id: string;
  word: string;
  order_index: number;
  duration_seconds?: number;
};
type Tab = "new" | "bank" | "list";

// ─── Difficulty badge (tinted, subtle — sits on word cards) ──────────────────

function DifficultyBadge({ difficulty }: { difficulty: string }) {
  const meta = DIFFICULTY_META[difficulty as Difficulty];
  if (!meta) return null;
  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: meta.badgeBg,
          borderColor: meta.badgeBorder,
        },
      ]}
    >
      <Text style={[styles.badgeText, { color: meta.badgeText }]}>
        {meta.label}
      </Text>
    </View>
  );
}

export default function AddWordScreen() {
  const router = useRouter();
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();

  const [tab, setTab] = useState<Tab>("new");
  const [newWord, setNewWord] = useState("");
  const [newWordDuration, setNewWordDuration] = useState(DEFAULT_WORD_DURATION_SEC);
  const [bankDurations, setBankDurations] = useState<Record<string, number>>({});
  const [saveToBank, setSaveToBank] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorModal, setErrorModal] = useState<{ title: string; message: string } | null>(null);

  function getBankWordDuration(id: string) {
    return bankDurations[id] ?? DEFAULT_WORD_DURATION_SEC;
  }

  function setBankWordDuration(id: string, sec: number) {
    setBankDurations((prev) => ({
      ...prev,
      [id]: clampDuration(sec),
    }));
  }

  // Auto-suggested difficulty, derived from live word input
  const suggestedDifficulty = useMemo(
    () => (newWord.trim().length > 0 ? getDifficultyFromLength(newWord) : null),
    [newWord]
  );

  // Manual override — null means "follow the suggestion"
  const [overrideDifficulty, setOverrideDifficulty] =
    useState<Difficulty | null>(null);

  // The effective difficulty to save
  const effectiveDifficulty: Difficulty =
    overrideDifficulty ?? suggestedDifficulty ?? "easy";

  function handleNewWordChange(v: string) {
    // Strip anything that isn't a letter — enforces A-Z as the user types
    // so numbers, spaces, and symbols are silently removed before validation.
    const stripped = v.replace(/[^a-zA-Z]/g, "").toUpperCase();
    setNewWord(stripped);
    // Reset override when word changes so the auto-suggestion kicks in fresh
    setOverrideDifficulty(null);
  }

  function handleOverride(d: Difficulty) {
    // Tapping the already-selected override deselects it (reverts to suggestion)
    setOverrideDifficulty((prev) => (prev === d ? null : d));
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  const [toast, setToast] = useState<{
    visible: boolean;
    message: string;
    detail?: string;
    variant: "success" | "delete";
  }>({ visible: false, message: "", variant: "success" });

  function showToast(message: string, detail?: string, variant: "success" | "delete" = "success") {
    setToast({ visible: true, message, detail, variant });
  }

  // ── Word bank ──────────────────────────────────────────────────────────────
  const [wordBank, setWordBank] = useState<WordBankItem[]>([]);
  const [bankSearch, setBankSearch] = useState("");
  const [diffFilter, setDiffFilter] = useState<Difficulty | null>(null);
  const [loadingBank, setLoadingBank] = useState(false);

  function toggleDiffFilter(d: Difficulty) {
    setDiffFilter((prev) => (prev === d ? null : d));
  }

  // ── Session word list (preview + reorder) ──────────────────────────────────
  const [sessionWords, setSessionWords] = useState<SessionWord[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [reordering, setReordering] = useState(false);

  // ── Loaders ────────────────────────────────────────────────────────────────
  const loadWordBank = useCallback(async () => {
    setLoadingBank(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from("word_library")
      .select("id, word, category, difficulty")
      .eq("teacher_id", user.id)
      .order("word");
    setWordBank(data ?? []);
    setLoadingBank(false);
  }, []);

  const loadSessionWords = useCallback(async () => {
    if (!sessionId) return;
    setLoadingList(true);
    let words: SessionWord[] = [];
    const { data, error } = await supabase
      .from("session_words")
      .select("id, word, order_index, duration_seconds")
      .eq("session_id", sessionId)
      .order("order_index");

    if (error && error.message.includes("duration_seconds")) {
      const { data: fallbackData } = await supabase
        .from("session_words")
        .select("id, word, order_index")
        .eq("session_id", sessionId)
        .order("order_index");
      words = (fallbackData ?? []).map((sw) => ({
        ...sw,
        duration_seconds: DEFAULT_WORD_DURATION_SEC,
      }));
    } else {
      words = data ?? [];
    }

    const storedDurations = await loadWordDurations(sessionId);
    const resolved = words.map((sw) => ({
      ...sw,
      duration_seconds: clampDuration(
        sw.duration_seconds ??
          storedDurations[sw.id] ??
          storedDurations[sw.word] ??
          DEFAULT_WORD_DURATION_SEC
      ),
    }));

    setSessionWords(resolved);
    setLoadingList(false);
  }, [sessionId]);

  // Reload word bank every time this screen comes into focus so that
  // entries added via the main Word Bank nav are always reflected here.
  useFocusEffect(
    useCallback(() => {
      loadWordBank();
    }, [loadWordBank])
  );

  useEffect(() => {
    loadSessionWords();
  }, [loadSessionWords]);

  // ── Update per-word timer ──────────────────────────────────────────────────
  async function updateWordDuration(wordId: string, value: number) {
    const safe = clampDuration(value);
    setSessionWords((prev) =>
      prev.map((sw) => (sw.id === wordId ? { ...sw, duration_seconds: safe } : sw))
    );
    if (sessionId) {
      const current = await loadWordDurations(sessionId);
      current[wordId] = safe;
      await saveWordDurations(sessionId, current);
      await supabase
        .from("session_words")
        .update({ duration_seconds: safe })
        .eq("id", wordId);
    }
  }

  // ── Add word ───────────────────────────────────────────────────────────────
  async function addWord(
    word: string,
    fromBank = false,
    duration = DEFAULT_WORD_DURATION_SEC
  ) {
    const w = word.trim().toUpperCase();
    if (!w || !isValidWord(w)) {
      setErrorModal({
        title: "Invalid word",
        message:
          "Only letters A–Z are supported. Numbers, spaces, and special characters are not allowed.",
      });
      return;
    }

    setSaving(true);
    // Hard-cap duration strictly between 5s and 60s (Hardware Safety)
    const safeDuration = clampDuration(duration);

    // Get current word count for order_index
    const { count } = await supabase
      .from("session_words")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId!);

    // Check for duplicate
    const { data: existing } = await supabase
      .from("session_words")
      .select("id")
      .eq("session_id", sessionId!)
      .eq("word", w)
      .maybeSingle();

    if (existing) {
      setErrorModal({
        title: "Already in sequence",
        message: `"${w}" is already in this session's sequence. Each word can only appear once.`,
      });
      setSaving(false);
      return;
    }

    let insertedId: string | null = null;
    const { data: insertData, error: insertError } = await supabase
      .from("session_words")
      .insert({
        session_id: sessionId,
        word: w,
        order_index: count ?? 0,
        duration_seconds: safeDuration,
      })
      .select("id")
      .maybeSingle();

    if (insertError && insertError.message.includes("duration_seconds")) {
      const { data: fallbackData } = await supabase
        .from("session_words")
        .insert({ session_id: sessionId, word: w, order_index: count ?? 0 })
        .select("id")
        .maybeSingle();
      insertedId = fallbackData?.id ?? null;
    } else {
      insertedId = insertData?.id ?? null;
    }

    // Persist duration in local storage cache
    if (sessionId) {
      const currentDurations = await loadWordDurations(sessionId);
      if (insertedId) currentDurations[insertedId] = safeDuration;
      currentDurations[w] = safeDuration;
      await saveWordDurations(sessionId, currentDurations);
    }

    // Optionally save to word bank (with duplicate check)
    if (saveToBank && !fromBank) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        // Check for existing entry in word_library
        const { data: existingInBank } = await supabase
          .from("word_library")
          .select("id")
          .eq("teacher_id", user.id)
          .eq("word", w)
          .maybeSingle();

        if (existingInBank) {
          // Word already in bank — don't duplicate; just inform the user.
          showToast(
            "Word already in your Word Bank",
            `"${w}" already exists in your Word Bank and was added to your word list instead.`,
            "success",
          );
        } else {
          const { error: bankError } = await supabase.from("word_library").insert({
            teacher_id: user.id,
            word: w,
            category: "My Words",
            difficulty: effectiveDifficulty,
          });

          if (bankError) {
            showToast("Failed to save to Word Bank", bankError.message, "delete");
          } else {
            showToast("Added to Word Bank", `"${w}" was saved to your Word Bank.`, "success");
            // Refresh word bank so newly saved word appears immediately
            await loadWordBank();
          }
        }
      }
    }

    setSaving(false);
    setNewWord("");
    setOverrideDifficulty(null);

    // Refresh list and switch to it so the user sees what they just added
    await loadSessionWords();
    setTab("list");
  }

  // ── Remove word from session list ───────────────────────────────────────────────
  async function removeSessionWord(wordId: string, wordText: string) {
    await supabase.from("session_words").delete().eq("id", wordId);
    setSessionWords((prev) => prev.filter((w) => w.id !== wordId));
    showToast("Word removed", `"${wordText}" was removed from the list.`, "delete");
  }

  // ── Reorder ────────────────────────────────────────────────────────────────
  async function persistReorder(reordered: SessionWord[]) {
    setReordering(true);
    const updated = reordered.map((w, i) => ({ ...w, order_index: i }));
    setSessionWords(updated);
    await Promise.all(
      updated.map((w) =>
        supabase
          .from("session_words")
          .update({ order_index: w.order_index })
          .eq("id", w.id),
      ),
    );
    setReordering(false);
  }

  const filteredBank = wordBank.filter((w) => {
    const matchesSearch = w.word
      .toLowerCase()
      .includes(bankSearch.toLowerCase());
    const effectiveDiff =
      w.difficulty &&
      (w.difficulty === "easy" ||
        w.difficulty === "medium" ||
        w.difficulty === "hard")
        ? (w.difficulty as Difficulty)
        : getDifficultyFromLength(w.word);
    const matchesDiff = diffFilter ? effectiveDiff === diffFilter : true;
    return matchesSearch && matchesDiff;
  });

  const activeMeta = DIFFICULTY_META[effectiveDifficulty];
  const showDifficultySection = newWord.trim().length > 0;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      <SafeAreaView style={styles.safe} edges={["top"]}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
          >
            <Ionicons name="arrow-back" size={20} color={C.navy} />
            <Text style={styles.backText}>Timed Sequence</Text>
          </Pressable>

          {/* Word count badge */}
          {sessionWords.length > 0 && (
            <Pressable
              onPress={() => setTab("list")}
              style={[
                styles.listCountChip,
                tab === "list" && { backgroundColor: C.navy },
              ]}
            >
              <Ionicons
                name="list"
                size={13}
                color={tab === "list" ? C.white : C.navy}
              />
              <Text
                style={[
                  styles.listCountText,
                  tab === "list" && { color: C.white },
                ]}
              >
                {sessionWords.length} word{sessionWords.length !== 1 ? "s" : ""}
              </Text>
            </Pressable>
          )}
        </View>

        {/* Tab bar */}
        <View style={styles.tabBar}>
          <Pressable
            onPress={() => setTab("new")}
            style={[styles.tabBtn, tab === "new" && styles.tabBtnActive]}
          >
            <Ionicons
              name="create-outline"
              size={15}
              color={tab === "new" ? C.navy : C.muted}
            />
            <Text style={[styles.tabBtnText, tab === "new" && styles.tabBtnTextActive]}>
              New Word
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setTab("bank")}
            style={[styles.tabBtn, tab === "bank" && styles.tabBtnActive]}
          >
            <Ionicons
              name="library-outline"
              size={15}
              color={tab === "bank" ? C.navy : C.muted}
            />
            <Text style={[styles.tabBtnText, tab === "bank" && styles.tabBtnTextActive]}>
              Word Bank
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setTab("list")}
            style={[styles.tabBtn, tab === "list" && styles.tabBtnActive]}
          >
            <Ionicons
              name="timer-outline"
              size={15}
              color={tab === "list" ? C.navy : C.muted}
            />
            <Text style={[styles.tabBtnText, tab === "list" && styles.tabBtnTextActive]}>
              Sequence
              {sessionWords.length > 0 && (
                <Text style={styles.tabCount}> {sessionWords.length}</Text>
              )}
            </Text>
          </Pressable>
        </View>

        {/* ── NEW WORD TAB ──────────────────────────────────────────────────── */}
        {tab === "new" && (
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
          >
            <ScrollView
              contentContainerStyle={styles.newWordContent}
              keyboardShouldPersistTaps="handled"
            >
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Enter a word</Text>
                <TextInput
                  style={styles.wordInput}
                  value={newWord}
                  onChangeText={handleNewWordChange}
                  placeholder="TYPE A WORD"
                  placeholderTextColor={C.muted}
                  autoFocus
                  autoCapitalize="characters"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={() => addWord(newWord)}
                />
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
                              isSelected
                                ? [styles.chipActiveLabel, { color: meta.chipText }]
                                : styles.chipInactiveLabel,
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

              {/* ── Hold Duration selector (Solenoid Safety: 5s – 60s) ── */}
              <View style={styles.durCard}>
                <View style={styles.durCardHeader}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.durCardTitle}>Hold Duration</Text>
                    <Text style={styles.durCardHint}>
                      Hardware safety: 5s – 60s per word
                    </Text>
                  </View>
                  <View style={styles.durStepper}>
                    <Pressable
                      onPress={() => setNewWordDuration((d) => clampDuration(d - 5))}
                      disabled={newWordDuration <= MIN_WORD_DURATION_SEC}
                      style={({ pressed }) => [
                        styles.durBtn,
                        newWordDuration <= MIN_WORD_DURATION_SEC && styles.durBtnDisabled,
                        pressed && { opacity: 0.6 },
                      ]}
                      hitSlop={4}
                      accessibilityLabel="Decrease duration by 5 seconds"
                    >
                      <Ionicons
                        name="remove"
                        size={16}
                        color={newWordDuration <= MIN_WORD_DURATION_SEC ? C.border : C.navy}
                      />
                    </Pressable>
                    <View style={styles.durDisplay}>
                      <Ionicons name="timer-outline" size={13} color={C.muted} />
                      <Text style={styles.durDisplayText}>{newWordDuration}s</Text>
                    </View>
                    <Pressable
                      onPress={() => setNewWordDuration((d) => clampDuration(d + 5))}
                      disabled={newWordDuration >= MAX_WORD_DURATION_SEC}
                      style={({ pressed }) => [
                        styles.durBtn,
                        newWordDuration >= MAX_WORD_DURATION_SEC && styles.durBtnDisabled,
                        pressed && { opacity: 0.6 },
                      ]}
                      hitSlop={4}
                      accessibilityLabel="Increase duration by 5 seconds"
                    >
                      <Ionicons
                        name="add"
                        size={16}
                        color={newWordDuration >= MAX_WORD_DURATION_SEC ? C.border : C.navy}
                      />
                    </Pressable>
                  </View>
                </View>
              </View>

              <Pressable
                style={styles.saveToBankRow}
                onPress={() => setSaveToBank((v) => !v)}
                accessibilityRole="switch"
              >
                <View style={styles.saveToBankText}>
                  <Ionicons name="library-outline" size={16} color={C.navy} />
                  <Text style={styles.saveToBankLabel}>Save to my Word Bank</Text>
                </View>
                <Switch
                  value={saveToBank}
                  onValueChange={setSaveToBank}
                  trackColor={{ true: C.navy }}
                  thumbColor={C.white}
                />
              </Pressable>

              <Pressable
                onPress={() => addWord(newWord, false, newWordDuration)}
                disabled={saving || !newWord.trim()}
                style={({ pressed }) => [
                  styles.addBtn,
                  (!newWord.trim() || saving) && { opacity: 0.5 },
                  pressed && { opacity: 0.85 },
                ]}
              >
                {saving ? (
                  <ActivityIndicator color="#1A1200" />
                ) : (
                  <>
                    <Ionicons name="add" size={18} color="#1A1200" />
                    <Text style={styles.addBtnText}>Add to Sequence</Text>
                  </>
                )}
              </Pressable>

              {/* Mini word list preview at the bottom of the New Word tab */}
              {sessionWords.length > 0 && (
                <View style={styles.previewCard}>
                  <View style={styles.previewHeader}>
                    <Text style={styles.previewLabel}>WORDS IN LIST</Text>
                    <Pressable
                      onPress={() => setTab("list")}
                      hitSlop={8}
                      style={({ pressed }) => [{ opacity: pressed ? 0.6 : 1 }]}
                    >
                      <Text style={styles.previewSeeAll}>Reorder →</Text>
                    </Pressable>
                  </View>
                  {sessionWords.map((sw, i) => (
                    <View key={sw.id} style={styles.previewRow}>
                      <Text style={styles.previewIndex}>
                        {String(i + 1).padStart(2, "0")}
                      </Text>
                      <Text style={styles.previewWord}>{sw.word}</Text>
                    </View>
                  ))}
                </View>
              )}
            </ScrollView>
          </KeyboardAvoidingView>
        )}

        {/* ── WORD BANK TAB ─────────────────────────────────────────────────── */}
        {tab === "bank" && (
          <View style={styles.bankContent}>
            <View style={styles.searchRow}>
              <Ionicons name="search-outline" size={16} color={C.muted} style={styles.searchIcon} />
              <TextInput
                style={styles.searchInput}
                value={bankSearch}
                onChangeText={setBankSearch}
                placeholder="Search word bank..."
                placeholderTextColor={C.muted}
                autoCapitalize="none"
                returnKeyType="search"
              />
              {bankSearch.length > 0 && (
                <Pressable onPress={() => setBankSearch("")} hitSlop={8}>
                  <Ionicons name="close-circle" size={16} color={C.muted} />
                </Pressable>
              )}
            </View>

            {/* ── Difficulty filter chips ── */}
            <View style={styles.filterRow}>
              {/* "All" chip */}
              <Pressable
                onPress={() => setDiffFilter(null)}
                style={({ pressed }) => [
                  styles.chip,
                  diffFilter === null ? styles.chipAllActive : styles.chipInactive,
                  pressed && { opacity: 0.8 },
                ]}
                accessibilityRole="button"
                accessibilityLabel="Show all difficulties"
              >
                <Text
                  style={[
                    styles.chipLabel,
                    diffFilter === null
                      ? styles.chipAllActiveLabel
                      : styles.chipInactiveLabel,
                  ]}
                >
                  All
                </Text>
              </Pressable>

              {DIFFICULTIES.map((d) => {
                const meta = DIFFICULTY_META[d];
                const active = diffFilter === d;
                return (
                  <Pressable
                    key={d}
                    onPress={() => toggleDiffFilter(d)}
                    style={({ pressed }) => [
                      styles.chip,
                      active
                        ? [styles.chipActive, { backgroundColor: meta.chipBg }]
                        : styles.chipInactive,
                      pressed && { opacity: 0.8 },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`Filter by ${meta.label}`}
                  >
                    <Text
                      style={[
                        styles.chipLabel,
                        active
                          ? [styles.chipActiveLabel, { color: meta.chipText }]
                          : styles.chipInactiveLabel,
                      ]}
                    >
                      {meta.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {/* ── Count ── */}
            <Text style={styles.countText}>
              {filteredBank.length} word{filteredBank.length !== 1 ? "s" : ""}
              {diffFilter ? ` · ${DIFFICULTY_META[diffFilter].label}` : ""}
            </Text>

            {loadingBank ? (
              <View style={styles.center}>
                <ActivityIndicator color={C.navy} />
              </View>
            ) : filteredBank.length === 0 ? (
              <View style={styles.emptyWrap}>
                <Ionicons name="library-outline" size={32} color={C.border} />
                <Text style={styles.emptyTitle}>
                  {wordBank.length === 0
                    ? "Word bank is empty"
                    : "No matching words"}
                </Text>
                <Text style={styles.emptyBody}>
                  {wordBank.length === 0
                    ? "Switch to New Word and save words to your bank."
                    : "Try a different search or filter."}
                </Text>
              </View>
            ) : (
              <FlatList
                data={filteredBank}
                keyExtractor={(w) => w.id}
                contentContainerStyle={styles.bankList}
                keyboardShouldPersistTaps="handled"
                ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
                renderItem={({ item }) => {
                  const effectiveDiff =
                    item.difficulty &&
                    (item.difficulty === "easy" ||
                      item.difficulty === "medium" ||
                      item.difficulty === "hard")
                      ? (item.difficulty as Difficulty)
                      : getDifficultyFromLength(item.word);
                  const dur = getBankWordDuration(item.id);
                  return (
                    <View style={styles.bankItem}>
                      <View style={styles.bankItemLeft}>
                        <Text style={styles.bankWord}>{item.word}</Text>
                        <DifficultyBadge difficulty={effectiveDiff} />
                      </View>

                      {/* Per-word timer stepper: 5s - 60s hard-capped */}
                      <View style={styles.rowDurControl}>
                        <Pressable
                          onPress={() => setBankWordDuration(item.id, dur - 5)}
                          disabled={dur <= MIN_WORD_DURATION_SEC}
                          style={({ pressed }) => [
                            styles.rowDurBtn,
                            dur <= MIN_WORD_DURATION_SEC && styles.durBtnDisabled,
                            pressed && { opacity: 0.6 },
                          ]}
                          hitSlop={4}
                          accessibilityLabel="Decrease duration by 5s"
                        >
                          <Ionicons
                            name="remove"
                            size={13}
                            color={dur <= MIN_WORD_DURATION_SEC ? C.border : C.navy}
                          />
                        </Pressable>
                        <View style={styles.rowDurBadge}>
                          <Ionicons name="timer-outline" size={11} color={C.muted} />
                          <Text style={styles.rowDurText}>{dur}s</Text>
                        </View>
                        <Pressable
                          onPress={() => setBankWordDuration(item.id, dur + 5)}
                          disabled={dur >= MAX_WORD_DURATION_SEC}
                          style={({ pressed }) => [
                            styles.rowDurBtn,
                            dur >= MAX_WORD_DURATION_SEC && styles.durBtnDisabled,
                            pressed && { opacity: 0.6 },
                          ]}
                          hitSlop={4}
                          accessibilityLabel="Increase duration by 5s"
                        >
                          <Ionicons
                            name="add"
                            size={13}
                            color={dur >= MAX_WORD_DURATION_SEC ? C.border : C.navy}
                          />
                        </Pressable>
                      </View>

                      <Pressable
                        onPress={() => addWord(item.word, true, dur)}
                        style={({ pressed }) => [
                          styles.addChip,
                          pressed && { opacity: 0.75 },
                        ]}
                      >
                        <Ionicons name="add" size={14} color={C.navy} />
                        <Text style={styles.addChipText}>Add</Text>
                      </Pressable>
                    </View>
                  );
                }}
              />
            )}
          </View>
        )}

        {/* ── WORD LIST TAB (preview + reorder) ────────────────────────────── */}
        {tab === "list" && (
          <View style={styles.listContent}>
            {loadingList ? (
              <View style={styles.center}>
                <ActivityIndicator color={C.navy} />
              </View>
            ) : sessionWords.length === 0 ? (
              <View style={styles.emptyWrap}>
                <Ionicons name="list-outline" size={36} color={C.border} />
                <Text style={styles.emptyTitle}>No words yet</Text>
                <Text style={styles.emptyBody}>
                  Switch to New Word or Word Bank to start building your list.
                </Text>
              </View>
            ) : (
              <>
                <View style={styles.listHeader}>
                  <Text style={styles.listHeaderLabel}>
                    {sessionWords.length} word{sessionWords.length !== 1 ? "s" : ""} · drag{" "}
                    <Ionicons name="menu" size={12} color={C.muted} /> to reorder
                  </Text>
                  {reordering && (
                    <ActivityIndicator size="small" color={C.navy} />
                  )}
                </View>

                <DraggableFlatList
                  data={sessionWords}
                  keyExtractor={(item) => item.id}
                  contentContainerStyle={styles.listItems}
                  onDragEnd={({ data }) => persistReorder(data)}
                  renderItem={({ item: sw, drag, isActive, getIndex }) => {
                    const i = getIndex() ?? 0;
                    return (
                      <ScaleDecorator activeScale={1.03}>
                        <View
                          style={[
                            styles.wordRow,
                            isActive && styles.wordRowActive,
                          ]}
                        >
                          {/* Drag handle */}
                          <Pressable
                            onLongPress={drag}
                            delayLongPress={120}
                            style={styles.dragHandle}
                            hitSlop={6}
                            accessibilityLabel="Hold to reorder"
                          >
                            <Ionicons
                              name="menu"
                              size={20}
                              color={isActive ? C.navy : C.muted}
                            />
                          </Pressable>

                          {/* Order number */}
                          <Text style={styles.wordIndex}>
                            {String(i + 1).padStart(2, "0")}
                          </Text>

                          {/* Word */}
                          <Text style={styles.wordText}>{sw.word}</Text>

                          {/* Per-word timer adjuster right in the sequence list */}
                          <View style={styles.rowDurControl}>
                            <Pressable
                              onPress={() =>
                                updateWordDuration(
                                  sw.id,
                                  (sw.duration_seconds ?? DEFAULT_WORD_DURATION_SEC) - 5
                                )
                              }
                              disabled={
                                (sw.duration_seconds ?? DEFAULT_WORD_DURATION_SEC) <=
                                MIN_WORD_DURATION_SEC
                              }
                              style={({ pressed }) => [
                                styles.rowDurBtn,
                                (sw.duration_seconds ?? DEFAULT_WORD_DURATION_SEC) <=
                                  MIN_WORD_DURATION_SEC && styles.durBtnDisabled,
                                pressed && { opacity: 0.6 },
                              ]}
                              hitSlop={4}
                            >
                              <Ionicons
                                name="remove"
                                size={13}
                                color={
                                  (sw.duration_seconds ?? DEFAULT_WORD_DURATION_SEC) <=
                                  MIN_WORD_DURATION_SEC
                                    ? C.border
                                    : C.navy
                                }
                              />
                            </Pressable>
                            <View style={styles.rowDurBadge}>
                              <Ionicons name="timer-outline" size={11} color={C.muted} />
                              <Text style={styles.rowDurText}>
                                {sw.duration_seconds ?? DEFAULT_WORD_DURATION_SEC}s
                              </Text>
                            </View>
                            <Pressable
                              onPress={() =>
                                updateWordDuration(
                                  sw.id,
                                  (sw.duration_seconds ?? DEFAULT_WORD_DURATION_SEC) + 5
                                )
                              }
                              disabled={
                                (sw.duration_seconds ?? DEFAULT_WORD_DURATION_SEC) >=
                                MAX_WORD_DURATION_SEC
                              }
                              style={({ pressed }) => [
                                styles.rowDurBtn,
                                (sw.duration_seconds ?? DEFAULT_WORD_DURATION_SEC) >=
                                  MAX_WORD_DURATION_SEC && styles.durBtnDisabled,
                                pressed && { opacity: 0.6 },
                              ]}
                              hitSlop={4}
                            >
                              <Ionicons
                                name="add"
                                size={13}
                                color={
                                  (sw.duration_seconds ?? DEFAULT_WORD_DURATION_SEC) >=
                                  MAX_WORD_DURATION_SEC
                                    ? C.border
                                    : C.navy
                                }
                              />
                            </Pressable>
                          </View>

                          {/* Remove button */}
                          <Pressable
                            onPress={() => removeSessionWord(sw.id, sw.word)}
                            hitSlop={8}
                            style={({ pressed }) => [
                              styles.removeBtn,
                              pressed && { opacity: 0.5 },
                            ]}
                            accessibilityLabel={`Remove ${sw.word}`}
                          >
                            <Ionicons name="trash-outline" size={15} color={C.red} />
                          </Pressable>
                        </View>
                      </ScaleDecorator>
                    );
                  }}
                />
              </>
            )}
          </View>
        )}
      </SafeAreaView>

      {/* ── Error modal (duplicate / invalid word) ────────────────────────── */}
      <Modal
        visible={!!errorModal}
        animationType="slide"
        transparent
        onRequestClose={() => setErrorModal(null)}
      >
        <View style={styles.modalOverlay}>
          <Pressable
            style={styles.backdrop}
            onPress={() => setErrorModal(null)}
          />
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <View style={styles.errorPreview}>
              <Ionicons name="alert-circle-outline" size={28} color={C.brown} />
              <Text style={styles.errorPreviewText}>{errorModal?.title}</Text>
            </View>
            <Text style={styles.sheetBody}>{errorModal?.message}</Text>
            <Pressable
              onPress={() => setErrorModal(null)}
              style={({ pressed }) => [
                styles.sheetDismissBtn,
                pressed && { opacity: 0.8 },
              ]}
            >
              <Text style={styles.sheetDismissBtnText}>Got it</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ── Toast notifications ───────────────────────────────────────────── */}
      <Toast
        visible={toast.visible}
        message={toast.message}
        detail={toast.detail}
        variant={toast.variant}
        onDismiss={() => setToast((t) => ({ ...t, visible: false }))}
      />
    </>
  );
}

const CHIP_INACTIVE_BG = "#EDEDEB";

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: C.white,
    borderBottomWidth: 1.5,
    borderBottomColor: C.border,
  },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 6 },
  backText: { fontFamily: fonts.heading, fontSize: 15, color: C.navy },
  listCountChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: C.blueWash,
    borderRadius: 100,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  listCountText: { fontFamily: fonts.heading, fontSize: 12, color: C.navy },

  // Tab bar
  tabBar: {
    flexDirection: "row",
    justifyContent: "center",
    backgroundColor: C.white,
    borderBottomWidth: 1.5,
    borderBottomColor: C.border,
    paddingHorizontal: 12,
    gap: 4,
  },
  tabBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
    marginBottom: -1.5,
  },
  tabBtnActive: { borderBottomColor: C.navy },
  tabBtnText: { fontFamily: fonts.heading, fontSize: 13, color: C.muted },
  tabBtnTextActive: { color: C.navy },
  tabCount: { fontFamily: fonts.mono, fontSize: 11, color: C.navy },

  // New word tab
  newWordContent: {
    padding: 20,
    gap: 20,
    paddingBottom: 40,
  },
  fieldGroup: { gap: 8 },
  label: { fontFamily: fonts.heading, fontSize: 14, color: C.navy },
  wordInput: {
    fontFamily: fonts.mono,
    fontSize: 18,
    letterSpacing: 3,
    color: C.ink,
    backgroundColor: C.white,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
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
  },
  overrideChipInactive: {
    backgroundColor: CHIP_INACTIVE_BG,
  },
  overrideChipLabel: {
    fontFamily: fonts.headingSemi,
    fontSize: 13,
    letterSpacing: 0.3,
  },
  autoDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    opacity: 0.7,
  },

  durCard: {
    backgroundColor: C.white,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: C.border,
    padding: 14,
  },
  durCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  durCardTitle: {
    fontFamily: fonts.heading,
    fontSize: 14,
    color: C.navy,
  },
  durCardHint: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: C.muted,
  },
  durStepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    padding: 3,
    gap: 4,
  },
  durBtn: {
    width: 28,
    height: 28,
    borderRadius: 7,
    backgroundColor: C.white,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: C.border,
  },
  durBtnDisabled: {
    opacity: 0.35,
    backgroundColor: "transparent",
  },
  durDisplay: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    minWidth: 46,
    justifyContent: "center",
  },
  durDisplayText: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: C.navy,
    fontWeight: "700",
  },

  rowDurControl: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.bg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    padding: 2,
    gap: 2,
  },
  rowDurBtn: {
    width: 22,
    height: 22,
    borderRadius: 5,
    backgroundColor: C.white,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: C.border,
  },
  rowDurBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 4,
  },
  rowDurText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: C.navy,
    fontWeight: "700",
  },

  saveToBankRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: C.white,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  saveToBankText: { flexDirection: "row", alignItems: "center", gap: 10 },
  saveToBankLabel: { fontFamily: fonts.body, fontSize: 14, color: C.ink },

  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: C.amber,
    borderRadius: 14,
    paddingVertical: 16,
  },
  addBtnText: { fontFamily: fonts.heading, fontSize: 17, color: "#1A1200" },

  // Mini preview inside "New Word" tab
  previewCard: {
    backgroundColor: C.white,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: C.border,
    overflow: "hidden",
  },
  previewHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  previewLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: C.brown,
    letterSpacing: 1,
  },
  previewSeeAll: { fontFamily: fonts.heading, fontSize: 12, color: C.navy },
  previewRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  previewIndex: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: C.muted,
    width: 22,
  },
  previewWord: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: C.navy,
    letterSpacing: 1.5,
  },

  // Word bank tab
  bankContent: { flex: 1 },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    margin: 16,
    marginBottom: 8,
    backgroundColor: C.white,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  searchIcon: { marginRight: -2 },
  searchInput: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 15,
    color: C.ink,
    padding: 0,
  },
  bankList: { padding: 16, paddingTop: 8 },
  bankItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: C.white,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1.5,
    borderColor: C.border,
  },
  bankItemLeft: { flex: 1, gap: 4 },
  bankWord: {
    fontFamily: fonts.mono,
    fontSize: 15,
    color: C.navy,
    letterSpacing: 1.5,
  },
  bankCategory: { fontFamily: fonts.body, fontSize: 11, color: C.muted },
  addChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: C.blueWash,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 100,
  },
  addChipText: { fontFamily: fonts.heading, fontSize: 12, color: C.navy },

  // ── Filter chips ─────────────────────────────────────────────────────────────
  filterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-start",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  chip: {
    borderRadius: radius.pill,
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  chipLabel: {
    fontFamily: fonts.headingSemi,
    fontSize: 13,
    letterSpacing: 0.3,
  },
  chipInactive: {
    backgroundColor: CHIP_INACTIVE_BG,
  },
  chipInactiveLabel: {
    color: C.muted,
  },
  chipAllActive: {
    backgroundColor: C.ink,
  },
  chipAllActiveLabel: {
    color: C.white,
  },
  chipActive: {
    // backgroundColor set inline
  },
  chipActiveLabel: {
    fontFamily: fonts.heading,
    color: C.white,
  },
  countText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: C.muted,
    paddingHorizontal: 20,
    paddingBottom: 4,
    letterSpacing: 0.5,
  },

  // ── Difficulty badge (tinted — on word cards) ────────────────────────────────
  badge: {
    alignSelf: "flex-start",
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.8,
  },

  // Word List tab
  listContent: { flex: 1 },
  listHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  listHeaderLabel: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: C.muted,
  },
  listItems: { paddingHorizontal: 16, paddingBottom: 40, gap: 8 },

  // Draggable word row
  wordRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: C.white,
    borderRadius: 12,
    paddingVertical: 13,
    paddingRight: 16,
    borderWidth: 1.5,
    borderColor: C.border,
  },
  wordRowActive: {
    borderColor: C.navy,
    shadowColor: C.navy,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 6,
  },
  dragHandle: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    justifyContent: "center",
    alignItems: "center",
  },
  wordIndex: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: C.muted,
    width: 22,
  },
  wordText: {
    fontFamily: fonts.mono,
    fontSize: 15,
    color: C.navy,
    letterSpacing: 1.5,
    flex: 1,
  },
  removeBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    justifyContent: "center",
    alignItems: "center",
  },

  // Empty states
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 40,
    gap: 10,
  },
  emptyTitle: { fontFamily: fonts.heading, fontSize: 17, color: C.navy },
  emptyBody: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: C.muted,
    textAlign: "center",
    lineHeight: 20,
  },

  // Error modal
  modalOverlay: { flex: 1, justifyContent: "flex-end" },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  sheet: {
    backgroundColor: C.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 44,
    gap: 12,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: C.border,
    alignSelf: "center",
    marginBottom: 4,
  },
  errorPreview: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    alignSelf: "center",
    backgroundColor: C.brownBg,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: C.brown,
  },
  errorPreviewText: { fontFamily: fonts.heading, fontSize: 18, color: C.brown },
  sheetBody: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: C.muted,
    textAlign: "center",
    lineHeight: 20,
  },
  sheetDismissBtn: {
    backgroundColor: C.navy,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 4,
  },
  sheetDismissBtnText: { fontFamily: fonts.heading, fontSize: 15, color: C.white },
});
