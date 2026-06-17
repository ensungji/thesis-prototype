// mobile/app/(teacher)/sessions/add-word.tsx
// Full-screen flow for adding a word to a session's word list.
// Receives sessionId (and current word count for order_index) via params.

import { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  ActivityIndicator,
  Switch,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../lib/supabase";
import { colors as C, fonts } from "../../../lib/theme";
import { isValidWord } from "../../../lib/braille";

type WordBankItem = { id: string; word: string; category: string };
type Tab = "new" | "bank";

export default function AddWordScreen() {
  const router = useRouter();
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();

  const [tab, setTab] = useState<Tab>("new");
  const [newWord, setNewWord] = useState("");
  const [saveToBank, setSaveToBank] = useState(false);
  const [saving, setSaving] = useState(false);

  const [wordBank, setWordBank] = useState<WordBankItem[]>([]);
  const [bankSearch, setBankSearch] = useState("");
  const [loadingBank, setLoadingBank] = useState(false);

  // Load word bank on mount
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

  useEffect(() => {
    loadWordBank();
  }, [loadWordBank]);

  async function addWord(word: string, fromBank = false) {
    const w = word.trim().toUpperCase();
    if (!w || !isValidWord(w)) {
      Alert.alert("Invalid word", "Only letters A–Z are supported.");
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
      Alert.alert("Duplicate", "This word is already in the list.");
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
        // Silently ignore if word already exists in bank
        await supabase.from("word_library").insert({
          teacher_id: user.id,
          word: w,
          category: "My Words",
          difficulty: "beginner",
        });
      }
    }

    setSaving(false);
    router.back();
  }

  const filteredBank = wordBank.filter((w) =>
    w.word.toLowerCase().includes(bankSearch.toLowerCase()),
  );

  return (
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
      </View>

      {/* Tab switcher */}
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
      </View>

      {/* ── NEW WORD TAB ────────────────────────────────────────────────────── */}
      {tab === "new" && (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.newWordContent}>
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
          </View>
        </KeyboardAvoidingView>
      )}

      {/* ── WORD BANK TAB ───────────────────────────────────────────────────── */}
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

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

  // Tab bar
  tabBar: {
    flexDirection: "row",
    backgroundColor: C.white,
    borderBottomWidth: 1.5,
    borderBottomColor: C.border,
    paddingHorizontal: 16,
    gap: 4,
  },
  tabBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 13,
    paddingHorizontal: 4,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
    marginBottom: -1.5,
  },
  tabBtnActive: { borderBottomColor: C.navy },
  tabBtnText: { fontFamily: fonts.heading, fontSize: 14, color: C.muted },
  tabBtnTextActive: { color: C.navy },

  // New word tab
  newWordContent: {
    padding: 20,
    gap: 20,
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
});
