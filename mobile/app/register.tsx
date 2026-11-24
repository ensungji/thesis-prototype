// mobile/app/register.tsx
// Teacher self-registration ("Create an account" on the Sign in screen).
// Calls the register-teacher edge function (no login needed). The new account
// is a teacher that can't sign in until the admin approves it (Admin Panel →
// Pending approval → Approve). Same look as app/login.tsx.

import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { isOnline } from "../lib/network";
import { colors as C, fonts } from "../lib/theme";
import { BrailleCell } from "../components/BrailleCell";
import { PasswordStrengthMeter } from "../components/PasswordStrength";

// Same limits as register-teacher
const MAX = { name: 100, email: 254, password: 72, title: 50, institution: 150 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

type Field = "name" | "email" | "password" | "confirm" | "title" | "institution";

/** The function's own message (e.g. "An account with this email already exists…"), if it sent one. */
async function functionError(error: unknown): Promise<string | null> {
  const ctx = (error as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === "function") {
    try {
      const body = await ctx.json();
      if (body && typeof body.error === "string") return body.error;
    } catch {
      // not JSON
    }
  }
  return null;
}

export default function Register() {
  const router = useRouter();

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [title, setTitle] = useState("");
  const [institution, setInstitution] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [focused, setFocused] = useState<Field | null>(null);
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // ── Checks (shown under a field once it has been left, all on submit) ──────
  const emailTrim = email.trim();
  const problems: Partial<Record<Field, string>> = {};
  if (fullName.trim().length < 2) problems.name = "Enter your full name.";
  if (!EMAIL_RE.test(emailTrim)) problems.email = "Enter a valid email address, like name@school.edu.ph.";
  if (password.length < 8) problems.password = "At least 8 characters.";
  if (confirm !== password || !confirm) problems.confirm = "The passwords don't match.";
  const canSubmit = Object.keys(problems).length === 0 && !loading;

  const show = (f: Field) => (touched[f] ? problems[f] : undefined);
  const leave = (f: Field) => {
    setFocused(null);
    setTouched((t) => ({ ...t, [f]: true }));
  };

  async function submit() {
    setTouched({ name: true, email: true, password: true, confirm: true });
    setError(null);
    if (Object.keys(problems).length > 0) return;
    if (!isOnline()) {
      setError("You're offline. Connect to the internet and try again.");
      return;
    }
    setLoading(true);
    const { data, error: fnError } = await supabase.functions.invoke("register-teacher", {
      body: {
        full_name: fullName.trim(),
        email: emailTrim.toLowerCase(),
        password,
        title: title.trim() || undefined,
        institution: institution.trim() || undefined,
      },
    });
    setLoading(false);
    if (fnError || !(data as { ok?: boolean } | null)?.ok) {
      const msg = (await functionError(fnError)) ?? (data as { error?: string } | null)?.error;
      setError(
        msg ??
          (/network|fetch|timeout/i.test(String((fnError as Error | null)?.message))
            ? "No connection to the server. Check the internet and try again."
            : "Couldn't create the account. Try again later."),
      );
      return;
    }
    setPassword("");
    setConfirm("");
    setDone(true);
  }

  const backToSignIn = () => (router.canGoBack() ? router.back() : router.replace("/login"));

  // ── Done ───────────────────────────────────────────────────────────────────
  if (done) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={[styles.scroll, { justifyContent: "center" }]}>
          <View style={styles.doneCard} accessibilityRole="alert">
            <Ionicons name="checkmark-circle" size={48} color={C.green} />
            <Text style={styles.doneTitle}>Account created</Text>
            <Text style={styles.doneText}>
              The admin needs to approve it before you can sign in.
            </Text>
            <Text style={styles.doneHint}>{emailTrim.toLowerCase()}</Text>
          </View>
          <Pressable
            onPress={backToSignIn}
            style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
          >
            <Text style={styles.ctaText}>Back to Sign in</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // ── Form ───────────────────────────────────────────────────────────────────
  const input = (f: Field, extra?: object) => [styles.input, focused === f && styles.inputFocused, !!show(f) && styles.inputError, extra];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.topBar}>
            <Pressable
              onPress={backToSignIn}
              accessibilityRole="button"
              accessibilityLabel="Back to sign in"
              style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
            >
              <Ionicons name="arrow-back" size={20} color={C.navy} />
              <Text style={styles.backText}>Sign in</Text>
            </Pressable>
          </View>

          <View style={styles.brandRow}>
            <BrailleCell pattern={[1, 2, 5]} size={11} />
            <View>
              <Text style={styles.brandName}>Braille D.O.T.S</Text>
              <Text style={styles.brandSub}>DYNAMIC OUTPUT TACTILE SYSTEM</Text>
            </View>
          </View>

          <View style={styles.headingBlock}>
            <Text style={styles.h1}>Create an account</Text>
            <Text style={styles.sub}>
              {"For teachers. The admin approves new accounts\nbefore they can be used."}
            </Text>
          </View>

          <View style={styles.form}>
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Full name</Text>
              <TextInput
                style={input("name")}
                value={fullName}
                onChangeText={(v) => { setFullName(v); setError(null); }}
                onFocus={() => setFocused("name")}
                onBlur={() => leave("name")}
                placeholder="Juan Dela Cruz"
                placeholderTextColor={C.muted}
                autoCapitalize="words"
                autoComplete="name"
                maxLength={MAX.name}
                returnKeyType="next"
                accessibilityLabel="Full name"
              />
              {!!show("name") && <Text style={styles.fieldError}>{show("name")}</Text>}
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={input("email")}
                value={email}
                onChangeText={(v) => { setEmail(v); setError(null); }}
                onFocus={() => setFocused("email")}
                onBlur={() => leave("email")}
                placeholder="your@email.com"
                placeholderTextColor={C.muted}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect={false}
                maxLength={MAX.email}
                returnKeyType="next"
                accessibilityLabel="Email address"
              />
              {!!show("email") && <Text style={styles.fieldError}>{show("email")}</Text>}
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Password</Text>
              <View style={styles.passwordRow}>
                <TextInput
                  style={input("password", styles.passwordInput)}
                  value={password}
                  onChangeText={(v) => { setPassword(v); setError(null); }}
                  onFocus={() => setFocused("password")}
                  onBlur={() => leave("password")}
                  placeholder="At least 8 characters"
                  placeholderTextColor={C.muted}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoComplete="new-password"
                  autoCorrect={false}
                  maxLength={MAX.password}
                  returnKeyType="next"
                  accessibilityLabel="Password"
                />
                <Pressable
                  onPress={() => setShowPassword((v) => !v)}
                  style={styles.toggleBtn}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? "Hide passwords" : "Show passwords"}
                >
                  <Text style={styles.toggleText}>{showPassword ? "Hide" : "Show"}</Text>
                </Pressable>
              </View>
              <PasswordStrengthMeter password={password} />
              {!!show("password") && <Text style={styles.fieldError}>{show("password")}</Text>}
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Confirm password</Text>
              <TextInput
                style={input("confirm")}
                value={confirm}
                onChangeText={(v) => { setConfirm(v); setError(null); }}
                onFocus={() => setFocused("confirm")}
                onBlur={() => leave("confirm")}
                placeholder="Type it again"
                placeholderTextColor={C.muted}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoComplete="new-password"
                autoCorrect={false}
                maxLength={MAX.password}
                returnKeyType="next"
                accessibilityLabel="Confirm password"
              />
              {!!show("confirm") && <Text style={styles.fieldError}>{show("confirm")}</Text>}
              {!show("confirm") && confirm.length > 0 && confirm === password && (
                <Text style={styles.fieldOk}>Passwords match</Text>
              )}
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>
                Title <Text style={styles.optional}>(optional)</Text>
              </Text>
              <TextInput
                style={input("title")}
                value={title}
                onChangeText={setTitle}
                onFocus={() => setFocused("title")}
                onBlur={() => leave("title")}
                placeholder="e.g. Teacher I, SPED Teacher"
                placeholderTextColor={C.muted}
                maxLength={MAX.title}
                returnKeyType="next"
                accessibilityLabel="Title, optional"
              />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>
                Institution <Text style={styles.optional}>(optional)</Text>
              </Text>
              <TextInput
                style={input("institution")}
                value={institution}
                onChangeText={setInstitution}
                onFocus={() => setFocused("institution")}
                onBlur={() => leave("institution")}
                placeholder="School or organization"
                placeholderTextColor={C.muted}
                maxLength={MAX.institution}
                returnKeyType="done"
                onSubmitEditing={submit}
                accessibilityLabel="Institution, optional"
              />
            </View>

            {error && (
              <View style={styles.errorBox} accessibilityRole="alert">
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            <Pressable
              onPress={submit}
              disabled={loading}
              accessibilityRole="button"
              accessibilityLabel="Create account"
              accessibilityState={{ disabled: !canSubmit, busy: loading }}
              style={({ pressed }) => [styles.cta, (!canSubmit || pressed) && { opacity: canSubmit ? 0.85 : 0.6 }]}
            >
              {loading ? <ActivityIndicator color="#1A1200" /> : <Text style={styles.ctaText}>Create account</Text>}
            </Pressable>
          </View>

          <Text style={styles.footer}>© {new Date().getFullYear()} Braille D.O.T.S</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// Same look as app/login.tsx
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  scroll: { flexGrow: 1, padding: 24, paddingBottom: 40, gap: 28 },

  topBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44 },
  backText: { fontFamily: fonts.heading, fontSize: 15, color: C.navy },

  brandRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  brandName: { fontFamily: fonts.heading, fontSize: 18, color: C.navy },
  brandSub: { fontFamily: fonts.mono, fontSize: 9, color: C.brown, letterSpacing: 0.5 },

  headingBlock: { gap: 8 },
  h1: { fontFamily: fonts.heading, fontSize: 30, color: C.navy, lineHeight: 38 },
  sub: { fontFamily: fonts.body, fontSize: 14, color: C.ink, lineHeight: 22 },

  form: { gap: 18 },
  fieldGroup: { gap: 6 },
  label: { fontFamily: fonts.heading, fontSize: 14, color: C.navy },
  optional: { fontFamily: fonts.body, fontSize: 13, color: C.muted },

  input: {
    fontFamily: fonts.body,
    fontSize: 16,
    color: C.ink,
    backgroundColor: C.white,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  inputFocused: { borderColor: C.navy },
  inputError: { borderColor: C.red },
  fieldError: { fontFamily: fonts.body, fontSize: 12.5, color: C.red },
  fieldOk: { fontFamily: fonts.body, fontSize: 12.5, color: C.green },

  passwordRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  passwordInput: { flex: 1 },
  toggleBtn: {
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    backgroundColor: C.white,
    minWidth: 64,
    alignItems: "center",
  },
  toggleText: { fontFamily: fonts.heading, fontSize: 13, color: C.navy },

  errorBox: { backgroundColor: C.redBg, borderRadius: 10, padding: 12, borderWidth: 1, borderColor: C.red },
  errorText: { fontFamily: fonts.body, fontSize: 13.5, color: C.red, lineHeight: 20 },

  cta: {
    backgroundColor: C.amber,
    borderRadius: 14,
    paddingVertical: 16,
    minHeight: 52,
    justifyContent: "center",
    alignItems: "center",
    elevation: 3,
    shadowColor: C.amber,
    shadowOpacity: 0.4,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  ctaText: { fontFamily: fonts.heading, fontSize: 17, color: "#1A1200" },

  doneCard: {
    backgroundColor: C.white,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: C.border,
    padding: 24,
    alignItems: "center",
    gap: 10,
  },
  doneTitle: { fontFamily: fonts.heading, fontSize: 22, color: C.navy },
  doneText: { fontFamily: fonts.body, fontSize: 15, color: C.ink, lineHeight: 22, textAlign: "center" },
  doneHint: { fontFamily: fonts.mono, fontSize: 12, color: C.muted },

  footer: { fontFamily: fonts.body, fontSize: 12, color: C.muted, textAlign: "center" },
});
