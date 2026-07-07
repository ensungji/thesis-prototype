// mobile/app/admin/add-teacher.tsx
// Dedicated screen — create a new teacher account.

import { useState, useRef } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  TextInput as RNTextInput,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { colors as C, fonts } from "../../lib/theme";

export default function AddTeacherScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [title, setTitle] = useState("");
  const [institution, setInstitution] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs for focus-chaining via the keyboard "next" button
  const emailRef    = useRef<RNTextInput>(null);
  const passRef     = useRef<RNTextInput>(null);
  const titleRef    = useRef<RNTextInput>(null);
  const instRef     = useRef<RNTextInput>(null);

  async function handleCreate() {
    if (!name.trim() || !email.trim() || !pass.trim()) {
      setError("Name, email and password are required.");
      return;
    }
    if (pass.trim().length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    setSaving(true);
    setError(null);

    const { data, error: fnError } = await supabase.functions.invoke(
      "create-teacher",
      {
        body: {
          email: email.trim().toLowerCase(),
          password: pass.trim(),
          full_name: name.trim(),
          title: title.trim() || null,
          institution: institution.trim() || null,
        },
      },
    );

    setSaving(false);
    if (fnError || data?.error) {
      setError(fnError?.message ?? data?.error ?? "Failed to create teacher.");
      return;
    }

    router.replace({
      pathname: "/admin" as any,
      params: { created: name.trim() },
    });
  }

  return (
    /*
     * Outer SafeAreaView guards ONLY the top edge (status bar).
     * The bottom safe area is handled by the pinned footer below,
     * which uses insets.bottom directly. This prevents the Android
     * gesture bar / 3-button nav from overlapping the primary CTA.
     */
    <SafeAreaView style={styles.safe} edges={["top"]}>

      {/* ── Header ── */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
          accessibilityRole="button"
          accessibilityLabel="Go back to admin"
        >
          <Ionicons name="arrow-back" size={20} color={C.navy} />
          <Text style={styles.backText}>Admin</Text>
        </Pressable>
      </View>

      {/*
        KeyboardAvoidingView shrinks the available space when the
        software keyboard appears so the pinned footer stays visible.
        On Android we use "height"; on iOS "padding" works better.
      */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        {/* ── Scrollable form ── */}
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.pageTitle}>Add Teacher</Text>
          <Text style={styles.pageSub}>
            Create a new teacher account. They can sign in immediately with
            these credentials.
          </Text>

          <View style={styles.form}>
            {/* Full name */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Full name</Text>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholder="e.g. Maria Santos"
                placeholderTextColor={C.muted}
                autoCapitalize="words"
                returnKeyType="next"
                onSubmitEditing={() => emailRef.current?.focus()}
                blurOnSubmit={false}
              />
            </View>

            {/* Email */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Email</Text>
              <TextInput
                ref={emailRef}
                style={styles.input}
                value={email}
                onChangeText={setEmail}
                placeholder="teacher@email.com"
                placeholderTextColor={C.muted}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="next"
                onSubmitEditing={() => passRef.current?.focus()}
                blurOnSubmit={false}
              />
            </View>

            {/* Password */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Temporary password</Text>
              <View style={styles.passRow}>
                <TextInput
                  ref={passRef}
                  style={[styles.input, { flex: 1 }]}
                  value={pass}
                  onChangeText={setPass}
                  placeholder="Min. 6 characters"
                  placeholderTextColor={C.muted}
                  secureTextEntry={!showPass}
                  autoCapitalize="none"
                  returnKeyType="next"
                  onSubmitEditing={() => titleRef.current?.focus()}
                  blurOnSubmit={false}
                />
                <Pressable
                  onPress={() => setShowPass((v) => !v)}
                  style={styles.showBtn}
                  accessibilityRole="button"
                  accessibilityLabel={showPass ? "Hide password" : "Show password"}
                >
                  <Text style={styles.showBtnText}>
                    {showPass ? "Hide" : "Show"}
                  </Text>
                </Pressable>
              </View>
            </View>

            {/* Title (optional) */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>
                Title <Text style={styles.optional}>(optional)</Text>
              </Text>
              <TextInput
                ref={titleRef}
                style={styles.input}
                value={title}
                onChangeText={setTitle}
                placeholder="e.g. Special Education Teacher"
                placeholderTextColor={C.muted}
                autoCapitalize="words"
                returnKeyType="next"
                onSubmitEditing={() => instRef.current?.focus()}
                blurOnSubmit={false}
              />
            </View>

            {/* Institution (optional) */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>
                Institution <Text style={styles.optional}>(optional)</Text>
              </Text>
              <TextInput
                ref={instRef}
                style={styles.input}
                value={institution}
                onChangeText={setInstitution}
                placeholder="e.g. Philippine School for the Deaf"
                placeholderTextColor={C.muted}
                autoCapitalize="words"
                returnKeyType="done"
                onSubmitEditing={handleCreate}
              />
            </View>

            {/* Error banner */}
            {error && (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle-outline" size={16} color={C.red} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </View>
        </ScrollView>

        {/*
          ── Pinned footer ──
          Lives OUTSIDE the ScrollView so it never scrolls off-screen
          and never sits behind the Android navigation bar.
          insets.bottom guarantees clearance above gesture bar / 3-button nav.
        */}
        <View
          style={[
            styles.footer,
            { paddingBottom: Math.max(insets.bottom, 12) + 8 },
          ]}
        >
          <Pressable
            onPress={handleCreate}
            disabled={saving}
            style={({ pressed }) => [
              styles.createBtn,
              saving && { opacity: 0.6 },
              pressed && !saving && { opacity: 0.85 },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Create teacher account"
          >
            {saving ? (
              <ActivityIndicator color="#1A1200" />
            ) : (
              <>
                <Ionicons name="person-add-outline" size={18} color="#1A1200" />
                <Text style={styles.createBtnText}>Create Account</Text>
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
  flex: { flex: 1 },

  // ── Header ──────────────────────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: C.white,
    borderBottomWidth: 1.5,
    borderBottomColor: C.border,
  },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 6 },
  backText: { fontFamily: fonts.heading, fontSize: 16, color: C.navy },

  // ── Scroll content ───────────────────────────────────────────────────────────
  scroll: {
    padding: 16,
    paddingTop: 20,
    paddingBottom: 8,         // footer handles the bottom clearance
    gap: 16,
  },

  pageTitle: { fontFamily: fonts.heading, fontSize: 22, color: C.navy },
  pageSub: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: C.muted,
    lineHeight: 19,
    marginTop: -6,
  },

  form:       { gap: 12 },
  fieldGroup: { gap: 5 },
  label:      { fontFamily: fonts.heading, fontSize: 13, color: C.navy },
  optional:   { fontFamily: fonts.body, fontSize: 11, color: C.muted },

  input: {
    fontFamily: fonts.body,
    fontSize: 15,
    color: C.ink,
    backgroundColor: C.white,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },

  passRow: { flexDirection: "row", gap: 8 },
  showBtn: {
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: C.border,
    backgroundColor: C.white,
    justifyContent: "center",
  },
  showBtnText: { fontFamily: fonts.heading, fontSize: 13, color: C.navy },

  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: C.redBg,
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: C.red,
  },
  errorText: { fontFamily: fonts.body, fontSize: 13, color: C.red, flex: 1 },

  // ── Pinned footer ────────────────────────────────────────────────────────────
  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
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
    paddingVertical: 15,
  },
  createBtnText: { fontFamily: fonts.heading, fontSize: 15, color: "#1A1200" },
});
