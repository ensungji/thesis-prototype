// mobile/app/(teacher)/wordbank/new.tsx
// Dedicated screen for adding a new word to the word bank.

import { useState } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../lib/supabase";
import { colors as C, fonts } from "../../../lib/theme";
import { isValidWord } from "../../../lib/braille";

export default function NewWordScreen() {
  const router = useRouter();

  const [word, setWord] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      difficulty: "beginner",
    });

    setSaving(false);
    if (insertError) {
      setError("Something went wrong. Please try again.");
      return;
    }

    router.back();
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Header */}
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
        <View style={styles.content}>
          <View style={styles.titleBlock}>
            <Text style={styles.pageTitle}>Add Word</Text>
            <Text style={styles.pageSubtitle}>
              Words saved here can be picked when building session word lists.
            </Text>
          </View>

          <View style={styles.fieldGroup}>
            <TextInput
              style={[styles.wordInput, error && styles.wordInputError]}
              value={word}
              onChangeText={(v) => {
                setWord(v.toUpperCase());
                setError(null);
              }}
              placeholder="TYPE A WORD"
              placeholderTextColor={C.muted}
              autoFocus
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={saveWord}
            />
            {error && (
              <View style={styles.errorRow}>
                <Ionicons name="alert-circle-outline" size={14} color={C.red} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
            <Text style={styles.hint}>Only letters A–Z (no numbers or symbols).</Text>
          </View>

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
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },

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

  fieldGroup: { gap: 8 },
  wordInput: {
    fontFamily: fonts.mono,
    fontSize: 22,
    letterSpacing: 4,
    color: C.ink,
    backgroundColor: C.white,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 14,
    paddingHorizontal: 20,
    paddingVertical: 18,
    textAlign: "center",
  },
  wordInputError: { borderColor: C.red },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  errorText: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: C.red,
  },
  hint: { fontFamily: fonts.body, fontSize: 12, color: C.muted },

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
