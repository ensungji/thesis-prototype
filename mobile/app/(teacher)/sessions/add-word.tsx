// mobile/app/(teacher)/sessions/add-word.tsx
// Full-screen flow for adding a word to a session's word list.
// Receives sessionId via params.
// Tabs: New Word | Word Bank | Word List (preview + reorder)

import { useState, useEffect, useCallback } from "react";
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
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../lib/supabase";
import { colors as C, fonts } from "../../../lib/theme";
import { isValidWord } from "../../../lib/braille";
import DraggableFlatList, {
  ScaleDecorator,
} from "react-native-draggable-flatlist";

type WordBankItem = { id: string; word: string; category: string };
type SessionWord = { id: string; word: string; order_index: number };
type Tab = "new" | "bank" | "list";

export default function AddWordScreen() {
  const router = useRouter();
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();

  const [tab, setTab] = useState<Tab>("new");
  const [newWord, setNewWord] = useState("");
  const [saveToBank, setSaveToBank] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorModal, setErrorModal] = useState<{ title: string; message: string } | null>(null);

  // ── Word bank ──────────────────────────────────────────────────────────────
  const [wordBank, setWordBank] = useState<WordBankItem[]>([]);
  const [bankSearch, setBankSearch] = useState("");
  const [loadingBank, setLoadingBank] = useState(false);

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
      .select("id, word, category")
      .eq("teacher_id", user.id)
      .order("word");
    setWordBank(data ?? []);
    setLoadingBank(false);
  }, []);

  const loadSessionWords = useCallback(async () => {
    if (!sessionId) return;
    setLoadingList(true);
    const { data } = await supabase
      .from("session_words")
      .select("id, word, order_index")
      .eq("session_id", sessionId)
      .order("order_index");
    setSessionWords(data ?? []);
    setLoadingList(false);
  }, [sessionId]);

  useEffect(() => {
    loadWordBank();
    loadSessionWords();
  }, [loadWordBank, loadSessionWords]);

  // ── Add word ───────────────────────────────────────────────────────────────
  async function addWord(word: string, fromBank = false) {
    const w = word.trim().toUpperCase();
    if (!w || !isValidWord(w)) {
      setErrorModal({
        title: "Invalid word",
        message: "Only letters A–Z are supported. Numbers, spaces, and special characters are not allowed.",
      });
      return;
    }

    setSaving(true);

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
        title: "Already in list",
        message: `"${w}" is already in this session's word list. Each word can only appear once.`,
      });
      setSaving(false);
      return;
    }

    await supabase
      .from("session_words")
      .insert({ session_id: sessionId, word: w, order_index: count ?? 0 });

    // Optionally save to word bank
    if (saveToBank && !fromBank) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        await supabase.from("word_library").insert({
          teacher_id: user.id,
          word: w,
          category: "My Words",
          difficulty: "beginner",
        });
      }
    }

    setSaving(false);
    setNewWord("");

    // Refresh list and switch to it so the user sees what they just added
    await loadSessionWords();
    setTab("list");
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

  const filteredBank = wordBank.filter((w) =>
    w.word.toLowerCase().includes(bankSearch.toLowerCase()),
  );

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
            <Text style={styles.backText}>Word List</Text>
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
              name="reorder-three-outline"
              size={15}
              color={tab === "list" ? C.navy : C.muted}
            />
            <Text style={[styles.tabBtnText, tab === "list" && styles.tabBtnTextActive]}>
              Word List
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
                  onChangeText={(v) => setNewWord(v.toUpperCase())}
                  placeholder="TYPE A WORD"
                  placeholderTextColor={C.muted}
                  autoFocus
                  autoCapitalize="characters"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={() => addWord(newWord)}
                />
                <Text style={styles.hint}>Only letters A–Z are supported.</Text>
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
                onPress={() => addWord(newWord)}
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
                    <Text style={styles.addBtnText}>Add to List</Text>
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

            {loadingBank ? (
              <View style={styles.center}>
                <ActivityIndicator color={C.navy} />
              </View>
            ) : filteredBank.length === 0 ? (
              <View style={styles.emptyWrap}>
                <Ionicons name="library-outline" size={32} color={C.border} />
                <Text style={styles.emptyTitle}>
                  {wordBank.length === 0 ? "Word bank is empty" : "No matches"}
                </Text>
                <Text style={styles.emptyBody}>
                  {wordBank.length === 0
                    ? "Switch to New Word and save words to your bank."
                    : "Try a different search term."}
                </Text>
              </View>
            ) : (
              <FlatList
                data={filteredBank}
                keyExtractor={(w) => w.id}
                contentContainerStyle={styles.bankList}
                keyboardShouldPersistTaps="handled"
                ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
                renderItem={({ item }) => (
                  <Pressable
                    onPress={() => addWord(item.word, true)}
                    style={({ pressed }) => [
                      styles.bankItem,
                      pressed && { opacity: 0.75 },
                    ]}
                  >
                    <View style={styles.bankItemLeft}>
                      <Text style={styles.bankWord}>{item.word}</Text>
                      <Text style={styles.bankCategory}>{item.category}</Text>
                    </View>
                    {saving ? (
                      <ActivityIndicator size="small" color={C.navy} />
                    ) : (
                      <View style={styles.addChip}>
                        <Ionicons name="add" size={14} color={C.navy} />
                        <Text style={styles.addChipText}>Add</Text>
                      </View>
                    )}
                  </Pressable>
                )}
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
    </>
  );
}

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
    paddingHorizontal: 8,
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
  bankItemLeft: { flex: 1, gap: 2 },
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
