// mobile/app/(teacher)/dashboard.tsx
// Teacher home screen — overview of students, sessions, and devices.
// All numbers are mocked for now; replace with Supabase queries once APK is ready.

import { View, Text, Pressable, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { colors as C, fonts } from "../../lib/theme";
import { BrailleCell } from "../../components/BrailleCell";

// ── Mock data — replace with real Supabase queries ────────────────────────────
// TODO: const { data: profile } = await supabase.from("profiles").select().single();
// TODO: const { count: studentCount } = await supabase.from("students").select("*", { count: "exact" });
const MOCK = {
  teacherName: "Teacher",
  students: 0,
  activeSessions: 0,
  connectedDevices: 0,
};

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ value, label, bg, color }: {
  value: number; label: string; bg: string; color: string;
}) {
  return (
    <View style={[styles.statCard, { backgroundColor: bg }]}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const router = useRouter();

  function signOut() {
    // TODO: await supabase.auth.signOut(); — uncomment when new APK ready
    router.replace("/");
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <BrailleCell pattern={[1, 2, 5]} size={10} />
            <View>
              <Text style={styles.greeting}>Welcome back,</Text>
              <Text style={styles.teacherName}>{MOCK.teacherName}</Text>
            </View>
          </View>
          <Pressable
            onPress={signOut}
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            style={({ pressed }) => [styles.signOutBtn, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.signOutText}>Sign Out</Text>
          </Pressable>
        </View>

        {/* Stats */}
        <Text style={styles.sectionLabel}>OVERVIEW</Text>
        <View style={styles.statsRow}>
          <StatCard value={MOCK.students}        label="Students"  bg={C.blueWash}  color={C.navy}  />
          <StatCard value={MOCK.activeSessions}  label="Sessions"  bg={C.brownBg}   color={C.brown} />
          <StatCard value={MOCK.connectedDevices}label="Devices"   bg={C.greenBg}   color={C.green} />
        </View>

        {/* Quick actions */}
        <Text style={styles.sectionLabel}>QUICK ACTIONS</Text>
        <View style={styles.actionsRow}>
          <Pressable
            // TODO: remove `as any` once sessions.tsx is wired up properly
            onPress={() => router.push("/(teacher)/sessions" as any)}
            style={({ pressed }) => [styles.actionBtn, styles.actionPrimary, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityLabel="Start a new session"
          >
            <Text style={styles.actionTextPrimary}>+ New Session</Text>
          </Pressable>
          <Pressable
            onPress={() => router.push("/(teacher)/students" as any)}
            style={({ pressed }) => [styles.actionBtn, styles.actionSecondary, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityLabel="Add a student"
          >
            <Text style={styles.actionTextSecondary}>+ Add Student</Text>
          </Pressable>
        </View>

        {/* Recent sessions */}
        <Text style={styles.sectionLabel}>RECENT SESSIONS</Text>
        <View style={styles.emptyState}>
          <BrailleCell pattern={[]} size={14} emptyColor={C.border} />
          <Text style={styles.emptyTitle}>No sessions yet</Text>
          <Text style={styles.emptyBody}>
            {"Start your first session to begin tracking your students' progress."}
          </Text>
        </View>
        {/* TODO: replace empty state with a FlatList of real sessions from Supabase */}

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 20, paddingBottom: 40, gap: 16 },

  // Header
  header:      { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerLeft:  { flexDirection: "row", alignItems: "center", gap: 10 },
  greeting:    { fontFamily: fonts.body, fontSize: 12, color: C.muted },
  teacherName: { fontFamily: fonts.heading, fontSize: 18, color: C.navy },
  signOutBtn:  {
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 10, borderWidth: 1.5, borderColor: C.border,
    backgroundColor: C.white,
  },
  signOutText: { fontFamily: fonts.heading, fontSize: 13, color: C.navy },

  sectionLabel: { fontFamily: fonts.mono, fontSize: 11, color: C.brown, letterSpacing: 1, marginTop: 4 },

  // Stats
  statsRow:  { flexDirection: "row", gap: 10 },
  statCard:  { flex: 1, borderRadius: 14, padding: 14, alignItems: "center", gap: 4 },
  statValue: { fontFamily: fonts.heading, fontSize: 28, lineHeight: 32 },
  statLabel: { fontFamily: fonts.body, fontSize: 11, color: C.ink },

  // Actions
  actionsRow:         { flexDirection: "row", gap: 10 },
  actionBtn:          { flex: 1, borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  actionPrimary:      { backgroundColor: C.amber },
  actionSecondary:    { backgroundColor: C.white, borderWidth: 1.5, borderColor: C.border },
  actionTextPrimary:  { fontFamily: fonts.heading, fontSize: 14, color: "#1A1200" },
  actionTextSecondary:{ fontFamily: fonts.heading, fontSize: 14, color: C.navy },

  // Empty state
  emptyState: {
    backgroundColor: C.white, borderRadius: 16, padding: 32,
    alignItems: "center", gap: 10, borderWidth: 1.5, borderColor: C.border,
  },
  emptyTitle: { fontFamily: fonts.heading, fontSize: 16, color: C.navy },
  emptyBody:  { fontFamily: fonts.body, fontSize: 13.5, color: C.ink, textAlign: "center", lineHeight: 20 },
});