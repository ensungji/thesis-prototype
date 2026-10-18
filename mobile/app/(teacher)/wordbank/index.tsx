// mobile/app/(teacher)/wordbank/index.tsx
// Teacher's personal word bank — search, filter by difficulty, and delete words.
// Add words via the dedicated new.tsx screen.

import { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  Pressable,
  FlatList,
  TextInput,
  Modal,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../lib/supabase";
import { colors as C, fonts, radius } from "../../../lib/theme";
import { BrailleCell } from "../../../components/BrailleCell";
import { BrailleLoader } from "../../../components/BrailleLoader";
import { Toast } from "../../../components/Toast";
import {
  type Difficulty,
  DIFFICULTIES,
  DIFFICULTY_META,
} from "../../../lib/difficulty";
import { wordbankToastBus } from "../../../lib/wordbank-toast";

type Word = { id: string; word: string; difficulty: string };

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

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function WordBankScreen() {
  const router = useRouter();

  const [words, setWords] = useState<Word[]>([]);
  const [filtered, setFiltered] = useState<Word[]>([]);
  const [search, setSearch] = useState("");
  const [diffFilter, setDiffFilter] = useState<Difficulty | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Delete confirmation
  const [deleteModal, setDeleteModal] = useState(false);
  const [wordToDelete, setWordToDelete] = useState<Word | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Unified toast state — single Toast instance handles both add and delete.
  // toastKey forces a full remount on every showToast call so animation state
  // always resets cleanly, even when overriding an already-visible toast.
  const [toastKey, setToastKey] = useState(0);
  const [toastVisible, setToastVisible] = useState(false);
  const [toastData, setToastData] = useState<{
    message: string;
    detail: string;
    variant: "success" | "delete";
  }>({ message: "", detail: "", variant: "success" });

  function showToast(message: string, detail: string, variant: "success" | "delete") {
    setToastData({ message, detail, variant });
    setToastVisible(true);
    // Incrementing the key unmounts + remounts Toast, resetting all animation
    // state. This guarantees a new toast always overrides the current one.
    setToastKey((k) => k + 1);
  }

  const loadWords = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from("word_library")
      .select("id, word, difficulty")
      .eq("teacher_id", user.id)
      .order("word");
    setWords(data ?? []);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { loadWords(); }, [loadWords]);

  const loadWordsRef = useRef(loadWords);
  useEffect(() => { loadWordsRef.current = loadWords; });
  useFocusEffect(
    useCallback(() => { loadWordsRef.current(); }, [])
  );

  // Subscribe to the word bank event bus while this screen is mounted.
  // new.tsx emits 'added' synchronously before unmounting, so the listener
  // is already registered here and receives the event reliably.
  useEffect(() => {
    wordbankToastBus.on((event) => {
      if (event.type === "added") {
        showToast("Added to Word Bank", event.word, "success");
      }
    });
    return () => wordbankToastBus.off();
  }, []);

  // Combined search + difficulty filter
  useEffect(() => {
    let result = words;
    if (search.trim()) {
      result = result.filter((w) =>
        w.word.toLowerCase().includes(search.toLowerCase())
      );
    }
    if (diffFilter) {
      result = result.filter((w) => w.difficulty === diffFilter);
    }
    setFiltered(result);
  }, [search, diffFilter, words]);

  function toggleDiffFilter(d: Difficulty) {
    setDiffFilter((prev) => (prev === d ? null : d));
  }

  function confirmDelete(word: Word) {
    setWordToDelete(word);
    setDeleteModal(true);
  }

  async function executeDelete() {
    if (!wordToDelete) return;
    setDeleting(true);
    await supabase.from("word_library").delete().eq("id", wordToDelete.id);
    const removed = wordToDelete.word;
    setWords((prev) => prev.filter((w) => w.id !== wordToDelete.id));
    setDeleting(false);
    setDeleteModal(false);
    setWordToDelete(null);
    showToast("Removed from Word Bank", removed, "delete");
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.center}>
          <BrailleLoader size={16} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Toast
        key={toastKey}
        visible={toastVisible}
        variant={toastData.variant}
        message={toastData.message}
        detail={toastData.detail}
        onDismiss={() => setToastVisible(false)}
      />
      {/* ── Header ── */}
      <View style={styles.header}>
        <Text style={styles.title}>Word Bank</Text>
        <Pressable
          onPress={() => router.push("/(teacher)/wordbank/new" as any)}
          style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.85 }]}
          accessibilityRole="button"
          accessibilityLabel="Add a word"
        >
          <Ionicons name="add" size={18} color="#1A1200" />
          <Text style={styles.addBtnText}>Add</Text>
        </Pressable>
      </View>

      {/* ── Search ── */}
      <View style={styles.searchBar}>
        <Ionicons name="search" size={16} color={C.muted} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search words..."
          placeholderTextColor={C.muted}
          autoCapitalize="characters"
          autoCorrect={false}
          returnKeyType="search"
        />
        {search.length > 0 && (
          <Pressable onPress={() => setSearch("")} hitSlop={8}>
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
        {filtered.length} word{filtered.length !== 1 ? "s" : ""}
        {diffFilter ? ` · ${DIFFICULTY_META[diffFilter].label}` : ""}
      </Text>

      {/* ── Word list ── */}
      <FlatList
        data={filtered}
        keyExtractor={(w) => w.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); loadWords(); }}
            tintColor={C.navy}
          />
        }
        renderItem={({ item }) => (
          <View style={styles.wordCard}>
            <View style={styles.wordBraillePreview}>
              <BrailleCell
                pattern={[]}
                size={8}
                emptyColor="rgba(12,68,124,0.1)"
              />
            </View>
            <View style={styles.wordCardBody}>
              <Text style={styles.wordText}>{item.word}</Text>
              <DifficultyBadge difficulty={item.difficulty} />
            </View>
            <Pressable
              onPress={() => confirmDelete(item)}
              hitSlop={8}
              style={({ pressed }) => [
                styles.deleteBtn,
                pressed && { opacity: 0.6 },
              ]}
              accessibilityLabel={`Remove ${item.word}`}
            >
              <Ionicons name="trash-outline" size={16} color={C.red} />
            </Pressable>
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <BrailleCell pattern={[]} size={16} emptyColor={C.border} />
            <Text style={styles.emptyTitle}>
              {search.trim() || diffFilter
                ? "No matching words"
                : "Word bank is empty"}
            </Text>
            <Text style={styles.emptyBody}>
              {search.trim() || diffFilter
                ? "Try a different search or filter."
                : "Tap + Add to start building your personal word bank. Words saved here appear when building session word lists."}
            </Text>
          </View>
        }
      />

      {/* ── Delete confirmation modal ── */}
      <Modal
        visible={deleteModal}
        animationType="slide"
        transparent
        onRequestClose={() => setDeleteModal(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable
            style={styles.backdrop}
            onPress={() => setDeleteModal(false)}
          />
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <View style={styles.deleteWordPreview}>
              <Text style={styles.deleteWordText}>{wordToDelete?.word}</Text>
            </View>
            <Text style={styles.deleteTitle}>Remove from Word Bank?</Text>
            <Text style={styles.deleteSub}>
              {"This word will be removed from your bank. It won't affect sessions that have already used it."}
            </Text>
            <View style={styles.sheetActions}>
              <Pressable
                onPress={() => setDeleteModal(false)}
                style={({ pressed }) => [
                  styles.sheetBtn,
                  styles.btnCancel,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={styles.btnCancelText}>Keep It</Text>
              </Pressable>
              <Pressable
                onPress={executeDelete}
                disabled={deleting}
                style={({ pressed }) => [
                  styles.sheetBtn,
                  styles.btnDelete,
                  pressed && { opacity: 0.8 },
                ]}
              >
                {deleting ? (
                  <ActivityIndicator color={C.white} />
                ) : (
                  <Text style={styles.btnDeleteText}>Remove</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const CHIP_INACTIVE_BG = "#EDEDEB"; // slightly darker than bg — visible but quiet

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  // ── Header ──────────────────────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 16,
    backgroundColor: C.white,
    borderBottomWidth: 1.5,
    borderBottomColor: C.border,
  },
  title: { fontFamily: fonts.heading, fontSize: 24, color: C.navy },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: C.amber,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  addBtnText: { fontFamily: fonts.heading, fontSize: 14, color: "#1A1200" },

  // ── Search ──────────────────────────────────────────────────────────────────
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 12,
    backgroundColor: C.white,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: C.border,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  searchInput: {
    flex: 1,
    fontFamily: fonts.mono,
    fontSize: 14,
    color: C.ink,
    letterSpacing: 1,
  },

  // ── Filter chips ─────────────────────────────────────────────────────────────
  filterRow: {
    flexDirection: "row",
    flexWrap: "wrap",           // chips wrap to next line on small screens
    justifyContent: "flex-start", // cluster left — no space-between stretch
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },

  // Shared chip base
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

  // Inactive state — subtle muted gray, no border
  chipInactive: {
    backgroundColor: CHIP_INACTIVE_BG,
  },
  chipInactiveLabel: {
    color: C.muted,
  },

  // Active "All" chip — sleek near-black
  chipAllActive: {
    backgroundColor: C.ink,
  },
  chipAllActiveLabel: {
    color: C.white,
  },

  // Active difficulty chip — backgroundColor applied inline from meta.chipBg
  chipActive: {
    // backgroundColor set inline
  },
  chipActiveLabel: {
    fontFamily: fonts.heading,
    color: C.white,
  },

  // ── Count ───────────────────────────────────────────────────────────────────
  countText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: C.muted,
    paddingHorizontal: 20,
    paddingBottom: 8,
    letterSpacing: 0.5,
  },

  // ── Word list ────────────────────────────────────────────────────────────────
  list: { paddingHorizontal: 16, gap: 10, paddingBottom: 40 },

  wordCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: C.white,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1.5,
    borderColor: C.border,
  },
  wordBraillePreview: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: C.blueWash,
    alignItems: "center",
    justifyContent: "center",
  },
  wordCardBody: {
    flex: 1,
    gap: 6,
  },
  wordText: {
    fontFamily: fonts.mono,
    fontSize: 18,
    color: C.navy,
    letterSpacing: 2,
  },
  deleteBtn: { padding: 6, borderRadius: 8, backgroundColor: C.redBg },

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

  // ── Empty state ──────────────────────────────────────────────────────────────
  empty: {
    alignItems: "center",
    justifyContent: "center",
    padding: 40,
    marginTop: 40,
    gap: 12,
  },
  emptyTitle: {
    fontFamily: fonts.heading,
    fontSize: 18,
    color: C.navy,
    textAlign: "center",
  },
  emptyBody: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: C.ink,
    textAlign: "center",
    lineHeight: 22,
  },

  // ── Delete modal ─────────────────────────────────────────────────────────────
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
  sheetActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  sheetBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  btnCancel: { backgroundColor: C.bg, borderWidth: 1.5, borderColor: C.border },
  btnCancelText: { fontFamily: fonts.heading, fontSize: 15, color: C.navy },
  btnDelete: { backgroundColor: C.red },
  btnDeleteText: { fontFamily: fonts.heading, fontSize: 15, color: C.white },
  deleteWordPreview: {
    alignSelf: "center",
    backgroundColor: C.redBg,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: C.red,
  },
  deleteWordText: {
    fontFamily: fonts.mono,
    fontSize: 22,
    color: C.red,
    letterSpacing: 3,
  },
  deleteTitle: {
    fontFamily: fonts.heading,
    fontSize: 18,
    color: C.navy,
    textAlign: "center",
  },
  deleteSub: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: C.muted,
    textAlign: "center",
    lineHeight: 20,
  },
});
