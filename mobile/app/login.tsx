// mobile/app/login.tsx
// Teacher login — real Supabase Auth, production ready.
// Includes Interactive Override flow for concurrent session protection.

import { useState, useEffect } from "react";
import {
  Alert,
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
import { colors as C, fonts } from "../lib/theme";
import { BrailleCell } from "../components/BrailleCell";
import { getDeviceId, resetDeviceId } from "../lib/device-id";
import { homeFor, readAccess, routeForSession } from "../lib/route-for-session";

// Shown when the login is refused because the account is banned / inactive:
// a self-registered teacher not approved yet (migration 28), or deactivated.
const NOT_ACTIVE_MSG =
  "Your account is waiting for admin approval or has been deactivated. Contact the admin.";

export default function Login() {
  const router = useRouter();

  const [email, setEmail]               = useState("");
  const [password, setPassword]         = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [focused, setFocused]           = useState<"email" | "password" | null>(null);

  // A saved login (e.g. Back to the welcome screen → Get Started) goes to
  // where its role belongs, never straight to the teacher screens
  // (lib/route-for-session). Deactivated: signed out, the form stays.
  useEffect(() => {
    let active = true;
    routeForSession().then(({ route, reason }) => {
      if (!active) return;
      if (route) router.replace(route as any);
      else if (reason === "inactive") setError(NOT_ACTIVE_MSG);
      else if (reason === "offline") setError("Couldn't check your account. Check your connection and try again.");
    });
    return () => {
      active = false;
    };
  }, [router]);

  /** Claim this device as active and navigate to the correct screen. */
  async function claimDeviceAndNavigate(
    userId: string,
    role: string,
    deviceId: string
  ) {
    // Write our device ID to the profile so the Realtime listener can
    // detect overrides on other devices.
    await supabase
      .from("profiles")
      .update({ active_device_id: deviceId })
      .eq("id", userId);

    router.replace(homeFor(role) as any);
  }

  async function signIn() {
    if (!email.trim() || !password) {
      setError("Please enter your email and password.");
      return;
    }

    setLoading(true);
    setError(null);

    const { data: signInData, error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });

    if (authError) {
      setLoading(false);
      // A banned login (not approved yet, or deactivated) comes back as
      // code "user_banned" / "User is banned"
      const banned = authError.code === "user_banned" || /banned/i.test(authError.message);
      setError(banned ? NOT_ACTIVE_MSG : authError.message);
      return;
    }

    // Profile for role + active check + concurrent session check (also
    // remembers the role on this phone for the offline fallback)
    const access = await readAccess(signInData.user!.id);

    setLoading(false);

    // No profile = we can't tell the role or whether the account is active:
    // don't let them in (a deactivated teacher must not slip through)
    if (!access.ok) {
      await supabase.auth.signOut();
      setError("Couldn't load your account. Check your connection and try again.");
      return;
    }
    const profile = { role: access.role, active_device_id: access.activeDeviceId };

    // Only block if explicitly deactivated (is_active === false, not null/undefined)
    if (!access.isActive) {
      await supabase.auth.signOut();
      setError(NOT_ACTIVE_MSG);
      return;
    }

    const localDeviceId = await getDeviceId();

    // ── Interactive Override: concurrent session detection ──────────────────
    // If another device already has an active session (active_device_id is set
    // and doesn't match ours), pause and ask the user before overriding.
    if (profile.active_device_id && profile.active_device_id !== localDeviceId) {
      Alert.alert(
        "Account in Use",
        "Someone is currently using this account. Do you want to override their session and log in here?",
        [
          {
            text: "Cancel",
            style: "cancel",
            onPress: async () => {
              // Abort login — sign out silently so auth state is clean
              await supabase.auth.signOut();
            },
          },
          {
            text: "Override",
            style: "destructive",
            onPress: async () => {
              // Generate a fresh device ID so the old device's listener fires
              const newDeviceId = await resetDeviceId();
              await claimDeviceAndNavigate(
                signInData.user!.id,
                profile.role,
                newDeviceId
              );
            },
          },
        ]
      );
      return; // Wait for the Alert callback
    }

    // No conflict — claim the device and proceed
    await claimDeviceAndNavigate(signInData.user!.id, profile.role, localDeviceId);
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Top bar: back + ? */}
          <View style={styles.topBar}>
            <Pressable
              onPress={() => router.back()}
              accessibilityRole="button"
              accessibilityLabel="Go back to home"
              style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
            >
              <Ionicons name="arrow-back" size={20} color={C.navy} />
              <Text style={styles.backText}>Back</Text>
            </Pressable>
            <Pressable
              onPress={() => router.push("/about" as any)}
              style={({ pressed }) => [styles.helpBtn, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel="How it works"
            >
              <Ionicons name="help-circle" size={28} color={C.navy} />
            </Pressable>
          </View>

          {/* Brand */}
          <View style={styles.brandRow}>
            <BrailleCell pattern={[1, 2, 5]} size={11} />
            <View>
              <Text style={styles.brandName}>Braille D.O.T.S</Text>
              <Text style={styles.brandSub}>DYNAMIC OUTPUT TACTILE SYSTEM</Text>
            </View>
          </View>

          {/* Heading */}
          <View style={styles.headingBlock}>
            <Text style={styles.h1}>Sign in</Text>
            <Text style={styles.sub}>
              {"Sign in with your teacher or admin account.\nNew teacher? Create an account below."}
            </Text>
          </View>

          {/* Form */}
          <View style={styles.form}>

            {/* Email */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={[styles.input, focused === "email" && styles.inputFocused]}
                value={email}
                onChangeText={(v) => { setEmail(v); setError(null); }}
                onFocus={() => setFocused("email")}
                onBlur={() => setFocused(null)}
                placeholder="your@email.com"
                placeholderTextColor={C.muted}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="next"
                accessibilityLabel="Email address"
              />
            </View>

            {/* Password */}
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>Password</Text>
              <View style={styles.passwordRow}>
                <TextInput
                  style={[
                    styles.input,
                    styles.passwordInput,
                    focused === "password" && styles.inputFocused,
                  ]}
                  value={password}
                  onChangeText={(v) => { setPassword(v); setError(null); }}
                  onFocus={() => setFocused("password")}
                  onBlur={() => setFocused(null)}
                  placeholder="••••••••"
                  placeholderTextColor={C.muted}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={signIn}
                  accessibilityLabel="Password"
                />
                <Pressable
                  onPress={() => setShowPassword((v) => !v)}
                  style={styles.toggleBtn}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? "Hide password" : "Show password"}
                >
                  <Text style={styles.toggleText}>
                    {showPassword ? "Hide" : "Show"}
                  </Text>
                </Pressable>
              </View>
            </View>

            {/* Error */}
            {error && (
              <View style={styles.errorBox} accessibilityRole="alert">
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            {/* Sign In */}
            <Pressable
              onPress={signIn}
              disabled={loading}
              accessibilityRole="button"
              accessibilityLabel="Sign in"
              style={({ pressed }) => [
                styles.cta,
                (pressed || loading) && { opacity: 0.85 },
              ]}
            >
              {loading ? (
                <ActivityIndicator color="#1A1200" />
              ) : (
                <Text style={styles.ctaText}>Sign In</Text>
              )}
            </Pressable>

            {/* Self-registration (register-teacher; the admin approves it) */}
            <Pressable
              onPress={() => router.push("/register" as any)}
              style={({ pressed }) => [styles.createLink, pressed && { opacity: 0.6 }]}
              accessibilityRole="link"
              accessibilityHint="Opens the sign-up form. The admin approves new accounts."
            >
              <Text style={styles.createText}>
                {"No account yet? "}
                <Text style={styles.createTextStrong}>Create an account</Text>
              </Text>
            </Pressable>

          </View>

          <Text style={styles.footer}>
            © {new Date().getFullYear()} Braille D.O.T.S
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: C.bg },
  scroll: { flexGrow: 1, padding: 24, paddingBottom: 40, gap: 32 },

  topBar:   { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 0 },
  backBtn:  { flexDirection: "row", alignItems: "center", gap: 6 },
  backText: { fontFamily: fonts.heading, fontSize: 15, color: C.navy },
  helpBtn:  { padding: 4 },

  brandRow:  { flexDirection: "row", alignItems: "center", gap: 12 },
  brandName: { fontFamily: fonts.heading, fontSize: 18, color: C.navy },
  brandSub:  { fontFamily: fonts.mono, fontSize: 9, color: C.brown, letterSpacing: 0.5 },

  headingBlock: { gap: 8 },
  h1:  { fontFamily: fonts.heading, fontSize: 30, color: C.navy, lineHeight: 38 },
  sub: { fontFamily: fonts.body, fontSize: 14, color: C.ink, lineHeight: 22 },

  form:       { gap: 20 },
  fieldGroup: { gap: 6 },
  label:      { fontFamily: fonts.heading, fontSize: 14, color: C.navy },

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

  passwordRow:   { flexDirection: "row", alignItems: "center", gap: 8 },
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

  errorBox: {
    backgroundColor: C.redBg,
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: C.red,
  },
  errorText: { fontFamily: fonts.body, fontSize: 13.5, color: C.red, lineHeight: 20 },

  cta: {
    backgroundColor: C.amber,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    elevation: 3,
    shadowColor: C.amber,
    shadowOpacity: 0.4,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  ctaText: { fontFamily: fonts.heading, fontSize: 17, color: "#1A1200" },

  createLink: { alignItems: "center", justifyContent: "center", minHeight: 44, paddingVertical: 8 },
  createText: { fontFamily: fonts.body, fontSize: 14, color: C.ink },
  createTextStrong: { fontFamily: fonts.heading, color: C.navy, textDecorationLine: "underline" },

  footer: { fontFamily: fonts.body, fontSize: 12, color: C.muted, textAlign: "center" },
});