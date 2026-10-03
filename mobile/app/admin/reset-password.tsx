// mobile/app/admin/reset-password.tsx
// Admin screen: directly set a new password for a teacher account.
// Calls the reset-teacher-password Edge Function which uses the service-role
// key server-side — the service key never touches the mobile client.

import { useState } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { colors as C, fonts } from "../../lib/theme";

// Password strength checker
function getStrength(pw: string): { level: 0 | 1 | 2 | 3; label: string; color: string } {
  if (pw.length === 0) return { level: 0, label: "", color: C.border };
  if (pw.length < 8)   return { level: 1, label: "Too short", color: C.red };
  const strong = /[A-Z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw);
  const medium = /[A-Z]/.test(pw) || /[0-9]/.test(pw);
  if (strong) return { level: 3, label: "Strong", color: C.green };
  if (medium)  return { level: 2, label: "Medium", color: "#F59E0B" };
  return { level: 1, label: "Weak", color: C.red };
}

export default function ResetPasswordScreen() {
  const router  = useRouter();
  const insets  = useSafeAreaInsets();
  const { id, full_name, email } = useLocalSearchParams<{
    id: string;
    full_name: string;
    email: string;
  }>();

  const [newPassword, setNewPassword]         = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNew, setShowNew]                 = useState(false);
  const [showConfirm, setShowConfirm]         = useState(false);
  const [saving, setSaving]                   = useState(false);
  const [error, setError]                     = useState<string | null>(null);
  const [success, setSuccess]                 = useState(false);

  const strength = getStrength(newPassword);

  async function handleReset() {
    setError(null);

    if (!newPassword) {
      setError("Please enter a new password.");
      return;
    }
    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSaving(true);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      setError("Your session has expired. Please sign in again.");
      setSaving(false);
      return;
    }

    const res = await supabase.functions.invoke("reset-teacher-password", {
      body: { teacherId: id, newPassword },
    });

    setSaving(false);

    if (res.error || res.data?.error) {
      setError(res.data?.error ?? res.error?.message ?? "Something went wrong.");
      return;
    }

    setSuccess(true);
  }

  // ── Success state ─────────────────────────────────────────────────────────
  if (success) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
          >
            <Ionicons name="arrow-back" size={20} color={C.navy} />
            <Text style={styles.backText}>Admin</Text>
          </Pressable>
        </View>
        <View style={styles.successWrap}>
          <View style={styles.successIcon}>
            <Ionicons name="checkmark-circle" size={52} color={C.green} />
          </View>
          <Text style={styles.successTitle}>Password updated</Text>
          <Text style={styles.successBody}>
            The new password for{"\n"}
            <Text style={{ fontFamily: fonts.heading, color: C.navy }}>
              {full_name || email}
            </Text>
            {"\n"}has been set successfully.
          </Text>
          <Pressable
            onPress={() => router.replace("/admin" as any)}
            style={({ pressed }) => [styles.doneBtn, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.doneBtnText}>Done</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // ── Form ──────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
        >
          <Ionicons name="arrow-back" size={20} color={C.navy} />
          <Text style={styles.backText}>Admin</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingBottom: Math.max(insets.bottom, 16) + 16 },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        {/* Page heading */}
        <Text style={styles.pageTitle}>Reset Password</Text>
        <Text style={styles.pageSub}>
          Set a new password for this teacher account.
        </Text>

        {/* Teacher info card */}
        <View style={styles.teacherCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {(full_name || email || "?").trim().slice(0, 2).toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.teacherName}>{full_name || "—"}</Text>
            <Text style={styles.teacherEmail}>{email}</Text>
          </View>
        </View>

        {/* Warning note */}
        <View style={styles.warningBox}>
          <Ionicons name="warning-outline" size={16} color="#B45309" />
          <Text style={styles.warningText}>
            The teacher will need to use this new password to sign in. Make sure to share it securely.
          </Text>
        </View>

        <View style={styles.form}>
          {/* New password */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>New password</Text>
            <View style={styles.inputRow}>
              <TextInput
                style={[styles.input, styles.inputFlex]}
                value={newPassword}
                onChangeText={(v) => { setNewPassword(v); setError(null); }}
                placeholder="Min. 8 characters"
                placeholderTextColor={C.muted}
                secureTextEntry={!showNew}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="next"
              />
              <Pressable
                onPress={() => setShowNew((v) => !v)}
                style={styles.toggleBtn}
                accessibilityLabel={showNew ? "Hide password" : "Show password"}
              >
                <Ionicons
                  name={showNew ? "eye-off-outline" : "eye-outline"}
                  size={18}
                  color={C.muted}
                />
              </Pressable>
            </View>

            {/* Strength bar */}
            {newPassword.length > 0 && (
              <View style={styles.strengthWrap}>
                <View style={styles.strengthBar}>
                  {[1, 2, 3].map((seg) => (
                    <View
                      key={seg}
                      style={[
                        styles.strengthSeg,
                        {
                          backgroundColor:
                            strength.level >= seg ? strength.color : C.border,
                        },
                      ]}
                    />
                  ))}
                </View>
                <Text style={[styles.strengthLabel, { color: strength.color }]}>
                  {strength.label}
                </Text>
              </View>
            )}
          </View>

          {/* Confirm password */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Confirm password</Text>
            <View style={styles.inputRow}>
              <TextInput
                style={[
                  styles.input,
                  styles.inputFlex,
                  confirmPassword.length > 0 &&
                    confirmPassword !== newPassword &&
                    styles.inputError,
                ]}
                value={confirmPassword}
                onChangeText={(v) => { setConfirmPassword(v); setError(null); }}
                placeholder="Re-enter password"
                placeholderTextColor={C.muted}
                secureTextEntry={!showConfirm}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={handleReset}
              />
              <Pressable
                onPress={() => setShowConfirm((v) => !v)}
                style={styles.toggleBtn}
                accessibilityLabel={showConfirm ? "Hide password" : "Show password"}
              >
                <Ionicons
                  name={showConfirm ? "eye-off-outline" : "eye-outline"}
                  size={18}
                  color={C.muted}
                />
              </Pressable>
            </View>
            {confirmPassword.length > 0 && confirmPassword !== newPassword && (
              <Text style={styles.matchError}>Passwords do not match</Text>
            )}
          </View>

          {/* Error */}
          {error && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color={C.red} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}
        </View>

        {/* Submit */}
        <Pressable
          onPress={handleReset}
          disabled={saving}
          style={({ pressed }) => [
            styles.saveBtn,
            saving && { opacity: 0.6 },
            pressed && !saving && { opacity: 0.85 },
          ]}
        >
          {saving ? (
            <ActivityIndicator color={C.white} />
          ) : (
            <>
              <Ionicons name="lock-closed-outline" size={18} color={C.white} />
              <Text style={styles.saveBtnText}>Set New Password</Text>
            </>
          )}
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: C.white,
    borderBottomWidth: 1.5,
    borderBottomColor: C.border,
  },
  backBtn:  { flexDirection: "row", alignItems: "center", gap: 6 },
  backText: { fontFamily: fonts.heading, fontSize: 16, color: C.navy },

  scroll: { padding: 16, paddingTop: 20, gap: 16 },

  pageTitle: { fontFamily: fonts.heading, fontSize: 22, color: C.navy },
  pageSub: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: C.muted,
    lineHeight: 19,
    marginTop: -6,
  },

  teacherCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: C.white,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1.5,
    borderColor: C.border,
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: C.navy,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText:   { fontFamily: fonts.heading, fontSize: 15, color: C.white },
  teacherName:  { fontFamily: fonts.heading, fontSize: 15, color: C.navy },
  teacherEmail: { fontFamily: fonts.body, fontSize: 13, color: C.muted },

  warningBox: {
    flexDirection: "row",
    gap: 10,
    backgroundColor: "#FFFBEB",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "#FDE68A",
    alignItems: "flex-start",
  },
  warningText: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 13,
    color: "#92400E",
    lineHeight: 19,
  },

  form:       { gap: 14 },
  fieldGroup: { gap: 6 },
  label:      { fontFamily: fonts.heading, fontSize: 13, color: C.navy },

  inputRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  inputFlex: { flex: 1 },
  input: {
    fontFamily: fonts.body,
    fontSize: 15,
    color: C.ink,
    backgroundColor: C.white,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  inputError: { borderColor: C.red },
  toggleBtn: {
    width: 46,
    height: 46,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    backgroundColor: C.white,
    alignItems: "center",
    justifyContent: "center",
  },

  strengthWrap:  { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 2 },
  strengthBar:   { flexDirection: "row", gap: 5, flex: 1 },
  strengthSeg:   { flex: 1, height: 4, borderRadius: 2 },
  strengthLabel: { fontFamily: fonts.mono, fontSize: 10 },

  matchError: { fontFamily: fonts.body, fontSize: 12, color: C.red, marginTop: -2 },

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

  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: C.navy,
    borderRadius: 14,
    paddingVertical: 15,
    marginTop: 4,
  },
  saveBtnText: { fontFamily: fonts.heading, fontSize: 15, color: C.white },

  successWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 16,
  },
  successIcon:  { marginBottom: 8 },
  successTitle: { fontFamily: fonts.heading, fontSize: 24, color: C.navy },
  successBody: {
    fontFamily: fonts.body,
    fontSize: 15,
    color: C.ink,
    textAlign: "center",
    lineHeight: 24,
  },
  doneBtn: {
    marginTop: 8,
    backgroundColor: C.navy,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 48,
  },
  doneBtnText: { fontFamily: fonts.heading, fontSize: 15, color: C.white },
});
