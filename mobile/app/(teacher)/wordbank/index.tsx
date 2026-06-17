// mobile/app/(teacher)/wordbank/index.tsx
// Teacher's personal word bank — search and delete words.
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
import { colors as C, fonts } from "../../../lib/theme";
import { BrailleCell } from "../../../components/BrailleCell";
import { BrailleLoader } from "../../../components/BrailleLoader";

type Word = { id: string; word: string };

export default function WordBankScreen() {
  const router = useRouter();

  const [words, setWords] = useState<Word[]>([]);
  const [filtered, setFiltered] = useState<Word[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Delete confirmation
  const [deleteModal, setDeleteModal] = useState(false);
  const [wordToDelete, setWordToDelete] = useState<Word | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadWords = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from("word_library")
      .select("id, word")
      .eq("teacher_id", user.id)
      .order("word");
    setWords(data ?? []);
    setFiltered(data ?? []);
    setLoading(false);
    setRefreshing(false);
  }, []);

  // Initial load
  useEffect(() => {
    loadWords();
  }, [loadWords]);

  // Reload when navigating back from add screen
  const loadWordsRef = useRef(loadWords);
  useEffect(() => { loadWordsRef.current = loadWords; });
  useFocusEffect(
    useCallback(() => {
      loadWordsRef.current();
    }, [])
  );

  // Live search filter
  useEffect(() => {
    if (!search.trim()) {
      setFiltered(words);
      return;
    }
    setFiltered(
      words.filter((w) => w.word.toLowerCase().includes(search.toLowerCase())),
    );
  }, [search, words]);

  function confirmDelete(word: Word) {
    setWordToDelete(word);
    setDeleteModal(true);
  }

  async function executeDelete() {
    if (!wordToDelete) return;
    setDeleting(true);
    await supabase.from("word_library").delete().eq("id", wordToDelete.id);
    // Optimistic update — remove from local state immediately
    setWords((prev) => prev.filter((w) => w.id !== wordToDelete.id));
    setDeleting(false);
    setDeleteModal(false);
    setWordToDelete(null);
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
      {/* Header */}
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

      {/* Search */}
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

      {/* Count */}
      <Text style={styles.countText}>
        {filtered.length} word{filtered.length !== 1 ? "s" : ""}
      </Text>

      {/* Word list */}
      <FlatList
        data={filtered}
        keyExtractor={(w) => w.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              loadWords();
            }}
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
            <Text style={styles.wordText}>{item.word}</Text>
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
              {search.trim()
                ? `No results for "${search}"`
                : "Word bank is empty"}
            </Text>
            <Text style={styles.emptyBody}>
              {search.trim()
                ? "Try a different search."
                : "Tap + Add to start building your personal word bank. Words saved here appear when building session word lists."}
            </Text>
          </View>
        }
      />

      {/* Delete confirmation modal (kept as modal — it's just a quick confirm) */}
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

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

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

  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    margin: 16,
    marginBottom: 4,
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
  countText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: C.muted,
    paddingHorizontal: 20,
    paddingBottom: 8,
    letterSpacing: 0.5,
  },

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
  wordText: {
    fontFamily: fonts.mono,
    fontSize: 18,
    color: C.navy,
    flex: 1,
    letterSpacing: 2,
  },
  deleteBtn: { padding: 6, borderRadius: 8, backgroundColor: C.redBg },

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

  // Delete modal
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
