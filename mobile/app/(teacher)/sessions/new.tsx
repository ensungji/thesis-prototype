// mobile/app/(teacher)/sessions/new.tsx
// Dedicated screen for creating a new session.

import { useState, useEffect } from "react";
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
import { colors as C, fonts } from "../../../lib/theme";
import { Toast } from "../../../components/Toast";
import {
  type SessionType,
  isTimedSequence,
  isLiveSession,
} from "../../../lib/session-timer";

export default function NewSessionScreen() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [type, setType] = useState<SessionType>("live_session");
  const [saving, setSaving] = useState(false);
  // true  → an in_progress/paused session exists; creation is blocked
  const [blocked, setBlocked] = useState(false);
  const [errorToast, setErrorToast] = useState(false);

  /** Check whether the teacher already has an active session. */
  async function checkForActiveSession(): Promise<boolean> {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return false;
    const { count } = await supabase
      .from("sessions")
      .select("id", { count: "exact", head: true })
      .eq("teacher_id", user.id)
      .in("status", ["in_progress", "paused"]);
    return (count ?? 0) > 0;
  }

  // Pre-flight on mount — warn immediately if already blocked.
  useEffect(() => {
    checkForActiveSession().then((isBlocked) => {
      if (isBlocked) {
        setBlocked(true);
        setErrorToast(true);
      }
    });
  }, []);

  async function createSession() {
    if (!name.trim()) return;
    setSaving(true);

    // ── Pre-flight check ─────────────────────────────────────────────────────
    const isBlocked = await checkForActiveSession();
    if (isBlocked) {
      setBlocked(true);
      setErrorToast(true);
      setSaving(false);
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    const {
      data: { user },
    } = await supabase.auth.getUser();

    let sessionType: string = type;
    let { data, error } = await supabase
      .from("sessions")
      .insert({
        teacher_id: user!.id,
        name: name.trim(),
        purpose: purpose.trim() || null,
        type: sessionType,
      })
      .select("id")
      .single();

    // Fallback if the database has a legacy check constraint
    if (error && error.message.includes("check")) {
      sessionType = isTimedSequence(type) ? "word_list" : "manual";
      const retry = await supabase
        .from("sessions")
        .insert({
          teacher_id: user!.id,
          name: name.trim(),
          purpose: purpose.trim() || null,
          type: sessionType,
        })
        .select("id")
        .single();
      data = retry.data;
      error = retry.error;
    }

    setSaving(false);
    if (error || !data) return;
    router.replace(`/(teacher)/sessions/${data.id}` as any);
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={20} color={C.navy} />
          <Text style={styles.backText}>Sessions</Text>
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Page title */}
          <View style={styles.titleBlock}>
            <Text style={styles.pageTitle}>New Session</Text>
            <Text style={styles.pageSubtitle}>
              Set up the basics — you can assign students and words after.
            </Text>
          </View>

          {/* Session name */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Session name</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="e.g. Monday Practice"
              placeholderTextColor={C.muted}
              autoFocus
              autoCapitalize="words"
              returnKeyType="next"
            />
          </View>

          {/* Purpose */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>
              Purpose <Text style={styles.optional}>(optional)</Text>
            </Text>
            <TextInput
              style={[styles.input, styles.multiline]}
              value={purpose}
              onChangeText={setPurpose}
              placeholder="e.g. Introduce letters A–E to Grade 1 learners"
              placeholderTextColor={C.muted}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </View>

          {/* Session type */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Session type</Text>
            <View style={styles.typeRow}>
              <Pressable
                onPress={() => setType("live_session")}
                style={[
                  styles.typeBtn,
                  isLiveSession(type) && styles.typeBtnActive,
                ]}
              >
                <Ionicons
                  name="radio-outline"
                  size={20}
                  color={isLiveSession(type) ? C.white : C.muted}
                />
                <View>
                  <Text
                    style={[
                      styles.typeBtnLabel,
                      isLiveSession(type) && styles.typeBtnLabelActive,
                    ]}
                  >
                    Live Session
                  </Text>
                  <Text
                    style={[
                      styles.typeBtnSub,
                      isLiveSession(type) && { color: "rgba(255,255,255,0.7)" },
                    ]}
                  >
                    Type words live
                  </Text>
                </View>
              </Pressable>

              <Pressable
                onPress={() => setType("timed_sequence")}
                style={[
                  styles.typeBtn,
                  isTimedSequence(type) && styles.typeBtnActive,
                ]}
              >
                <Ionicons
                  name="timer-outline"
                  size={20}
                  color={isTimedSequence(type) ? C.white : C.muted}
                />
                <View>
                  <Text
                    style={[
                      styles.typeBtnLabel,
                      isTimedSequence(type) && styles.typeBtnLabelActive,
                    ]}
                  >
                    Timed Sequence
                  </Text>
                  <Text
                    style={[
                      styles.typeBtnSub,
                      isTimedSequence(type) && { color: "rgba(255,255,255,0.7)" },
                    ]}
                  >
                    Timed word sequence
                  </Text>
                </View>
              </Pressable>
            </View>
          </View>
        </ScrollView>

        {/* Sticky create button */}
        <View style={styles.footer}>
          <Pressable
            onPress={createSession}
            disabled={saving || !name.trim() || blocked}
            style={({ pressed }) => [
              styles.createBtn,
              (saving || !name.trim() || blocked) && { opacity: 0.5 },
              pressed && { opacity: 0.85 },
            ]}
          >
            {saving ? (
              <ActivityIndicator color="#1A1200" />
            ) : (
              <>
                <Ionicons name="checkmark" size={18} color="#1A1200" />
                <Text style={styles.createBtnText}>Create Session</Text>
              </>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      {/* Active-session block toast — rendered outside KeyboardAvoidingView
          so it always appears over the footer bar at the bottom. */}
      <Toast
        message="Cannot create: Another session is currently active."
        visible={errorToast}
        variant="delete"
        duration={4000}
        onDismiss={() => setErrorToast(false)}
      />
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
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  backText: {
    fontFamily: fonts.heading,
    fontSize: 15,
    color: C.navy,
  },

  scroll: {
    padding: 20,
    gap: 24,
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
  label: { fontFamily: fonts.heading, fontSize: 14, color: C.navy },
  optional: { fontFamily: fonts.body, fontSize: 12, color: C.muted },
  input: {
    fontFamily: fonts.body,
    fontSize: 15,
    color: C.ink,
    backgroundColor: C.white,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  multiline: { minHeight: 90, paddingTop: 14 },

  typeRow: { flexDirection: "row", gap: 10 },
  typeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 14,
    padding: 16,
    backgroundColor: C.white,
    borderWidth: 1.5,
    borderColor: C.border,
  },
  typeBtnActive: { backgroundColor: C.navy, borderColor: C.navy },
  typeBtnLabel: { fontFamily: fonts.heading, fontSize: 14, color: C.ink },
  typeBtnLabelActive: { color: C.white },
  typeBtnSub: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: C.muted,
    marginTop: 2,
  },

  footer: {
    padding: 16,
    paddingBottom: 24,
    backgroundColor: C.bg,
    borderTopWidth: 1.5,
    borderTopColor: C.border,
  },
  createBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: C.amber,
    borderRadius: 14,
    paddingVertical: 16,
  },
  createBtnText: { fontFamily: fonts.heading, fontSize: 17, color: "#1A1200" },
});
