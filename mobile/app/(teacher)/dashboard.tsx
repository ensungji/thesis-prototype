// mobile/app/(teacher)/dashboard.tsx
// Fully wired to Supabase — real profile, real counts, real recent sessions.

import { useState, useEffect, useCallback } from "react";
import {
  View, Text, Pressable, ScrollView, Modal,
  StyleSheet, ActivityIndicator, RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";
import { colors as C, fonts } from "../../lib/theme";
import { BrailleCell } from "../../components/BrailleCell";

// ── Types ─────────────────────────────────────────────────────────────────────

type Profile = {
  id: string;
  email: string;
  full_name: string;
  role: string;
  title: string | null;
  institution: string | null;
};

type RecentSession = {
  id: string;
  name: string;
  status: string;
  type: string;
  updated_at: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getInitials(name: string): string {
  return name.trim().split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" });
  return `${date} · ${time}`;
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  pending:     { bg: C.border,   text: C.muted  },
  in_progress: { bg: C.greenBg,  text: C.green  },
  paused:      { bg: C.brownBg,  text: C.brown  },
  finished:    { bg: C.blueWash, text: C.navy   },
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

  const [profile, setProfile]             = useState<Profile | null>(null);
  const [studentCount, setStudentCount]   = useState(0);
  const [activeCount, setActiveCount]     = useState(0);
  const [totalCount, setTotalCount]       = useState(0);
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([]);
  const [loading, setLoading]             = useState(true);
  const [refreshing, setRefreshing]       = useState(false);
  const [profileSheet, setProfileSheet]   = useState(false);

  const loadDashboard = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { router.replace("/"); return; }

    const [profileRes, studentsRes, activeRes, totalRes, recentRes] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", user.id).single(),
      supabase.from("students").select("id", { count: "exact", head: true }).eq("teacher_id", user.id),
      supabase.from("sessions").select("id", { count: "exact", head: true }).eq("teacher_id", user.id).eq("status", "in_progress"),
      supabase.from("sessions").select("id", { count: "exact", head: true }).eq("teacher_id", user.id),
      supabase.from("sessions").select("id, name, status, type, updated_at").eq("teacher_id", user.id).order("updated_at", { ascending: false }).limit(5),
    ]);

    setProfile(profileRes.data);
    setStudentCount(studentsRes.count ?? 0);
    setActiveCount(activeRes.count ?? 0);
    setTotalCount(totalRes.count ?? 0);
    setRecentSessions(recentRes.data ?? []);
    setLoading(false);
    setRefreshing(false);
  }, [router]);

  useEffect(() => {
    loadDashboard();

    const channel = supabase
      .channel("dashboard-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, loadDashboard)
      .on("postgres_changes", { event: "*", schema: "public", table: "students" }, loadDashboard)
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [loadDashboard]);

  async function signOut() {
    await supabase.auth.signOut();
    router.replace("/");
  }

  // ── Loading state ───────────────────────────────────────────────────────────
  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.loadingCenter}>
          <ActivityIndicator size="large" color={C.navy} />
        </View>
      </SafeAreaView>
    );
  }

  const displayName = profile?.full_name?.trim() || profile?.email || "Teacher";
  const initials = displayName === profile?.email
    ? displayName[0].toUpperCase()
    : getInitials(displayName);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <BrailleCell pattern={[1, 2, 5]} size={10} />
          <View>
            <Text style={styles.greeting}>Welcome back,</Text>
            <Text style={styles.teacherName}>{displayName}</Text>
          </View>
        </View>

        {/* Initials button → profile sheet */}
        <Pressable
          onPress={() => setProfileSheet(true)}
          accessibilityRole="button"
          accessibilityLabel="View profile"
          style={({ pressed }) => [styles.initialsBtn, pressed && { opacity: 0.8 }]}
        >
          <Text style={styles.initialsText}>{initials}</Text>
        </Pressable>
      </View>

      {/* Teacher subtitle */}
      {(profile?.title || profile?.institution) && (
        <View style={styles.subtitleRow}>
          {profile?.title && (
            <Text style={styles.subtitleTitle}>{profile.title}</Text>
          )}
          {profile?.institution && (
            <Text style={styles.subtitleInstitution}>{profile.institution}</Text>
          )}
        </View>
      )}

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); loadDashboard(); }}
            tintColor={C.navy}
          />
        }
      >
        {/* Stats */}
        <Text style={styles.sectionLabel}>OVERVIEW</Text>
        <View style={styles.statsRow}>
          <StatCard value={studentCount} label="Students"  bg={C.blueWash} color={C.navy}  />
          <StatCard value={activeCount}  label="Live"      bg={C.greenBg}  color={C.green} />
          <StatCard value={totalCount}   label="Sessions"  bg={C.brownBg}  color={C.brown} />
        </View>

        {/* Quick actions */}
        <Text style={styles.sectionLabel}>QUICK ACTIONS</Text>
        <View style={styles.actionsRow}>
          <Pressable
            onPress={() => router.push("/(teacher)/sessions" as any)}
            style={({ pressed }) => [styles.actionBtn, styles.actionPrimary, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
          >
            <Text style={styles.actionTextPrimary}>+ New Session</Text>
          </Pressable>
          <Pressable
            onPress={() => router.push("/(teacher)/students" as any)}
            style={({ pressed }) => [styles.actionBtn, styles.actionSecondary, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
          >
            <Text style={styles.actionTextSecondary}>+ Add Student</Text>
          </Pressable>
        </View>

        {/* Recent sessions */}
        <Text style={styles.sectionLabel}>RECENT SESSIONS</Text>
        {recentSessions.length === 0 ? (
          <View style={styles.emptyState}>
            <BrailleCell pattern={[]} size={14} emptyColor={C.border} />
            <Text style={styles.emptyTitle}>No sessions yet</Text>
            <Text style={styles.emptyBody}>
              {"Start your first session to begin tracking your students' progress."}
            </Text>
          </View>
        ) : (
          <View style={styles.sessionList}>
            {recentSessions.map((s) => {
              const sc = STATUS_COLORS[s.status] ?? STATUS_COLORS.pending;
              return (
                <Pressable
                  key={s.id}
                  onPress={() => router.push("/(teacher)/sessions" as any)}
                  style={({ pressed }) => [styles.sessionRow, pressed && { opacity: 0.85 }]}
                >
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={styles.sessionName}>{s.name}</Text>
                    <Text style={styles.sessionDate}>Updated {formatDate(s.updated_at)}</Text>
                  </View>
                  <View style={{ alignItems: "flex-end", gap: 4 }}>
                    <View style={[styles.badge, { backgroundColor: sc.bg }]}>
                      <Text style={[styles.badgeText, { color: sc.text }]}>
                        {s.status.replace("_", " ")}
                      </Text>
                    </View>
                    <Text style={styles.typeText}>
                      {s.type === "word_list" ? "Word List" : "Manual"}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>

      {/* Profile sheet modal */}
      <Modal
        visible={profileSheet}
        animationType="slide"
        transparent
        onRequestClose={() => setProfileSheet(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable style={styles.modalBackdrop} onPress={() => setProfileSheet(false)} />
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />

            {/* Large initials */}
            <View style={styles.profileAvatarLarge}>
              <Text style={styles.profileAvatarText}>{initials}</Text>
            </View>

            <Text style={styles.profileName}>{profile?.full_name ?? "—"}</Text>
            <Text style={styles.profileEmail}>{profile?.email ?? "—"}</Text>

            {/* Role badge */}
            <View style={styles.roleBadge}>
              <Text style={styles.roleBadgeText}>
                {profile?.role?.toUpperCase() ?? "TEACHER"}
              </Text>
            </View>

            {(profile?.title || profile?.institution) && (
              <View style={styles.profileMeta}>
                {profile?.title && (
                  <Text style={styles.profileMetaText}>{profile.title}</Text>
                )}
                {profile?.institution && (
                  <Text style={styles.profileMetaText}>{profile.institution}</Text>
                )}
              </View>
            )}

            <Pressable
              onPress={signOut}
              style={({ pressed }) => [styles.signOutBtn, pressed && { opacity: 0.8 }]}
              accessibilityRole="button"
            >
              <Text style={styles.signOutText}>Sign Out</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:          { flex: 1, backgroundColor: C.bg },
  loadingCenter: { flex: 1, alignItems: "center", justifyContent: "center" },

  // Header
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 20, paddingVertical: 14,
    backgroundColor: C.white, borderBottomWidth: 1.5, borderBottomColor: C.border,
  },
  headerLeft:  { flexDirection: "row", alignItems: "center", gap: 10 },
  greeting:    { fontFamily: fonts.body, fontSize: 12, color: C.muted },
  teacherName: { fontFamily: fonts.heading, fontSize: 18, color: C.navy },
  initialsBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: C.navy, alignItems: "center", justifyContent: "center",
  },
  initialsText: { fontFamily: fonts.heading, fontSize: 15, color: C.white },

  subtitleRow: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: C.white,
    borderBottomWidth: 1.5,
    borderBottomColor: C.border,
    alignItems: "center",
    gap: 2,
  },
  subtitleTitle: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: C.brown,
    letterSpacing: 0.8,
    textAlign: "center",
  },
  subtitleInstitution: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: C.muted,
    textAlign: "center",
    lineHeight: 18,
  },

  scroll:      { padding: 20, paddingBottom: 40, gap: 14 },
  sectionLabel:{ fontFamily: fonts.mono, fontSize: 11, color: C.brown, letterSpacing: 1, marginTop: 4 },

  // Stats
  statsRow:  { flexDirection: "row", gap: 10 },
  statCard:  { flex: 1, borderRadius: 14, padding: 14, alignItems: "center", gap: 4 },
  statValue: { fontFamily: fonts.heading, fontSize: 28, lineHeight: 32 },
  statLabel: { fontFamily: fonts.body, fontSize: 11, color: C.ink },

  // Actions
  actionsRow:          { flexDirection: "row", gap: 10 },
  actionBtn:           { flex: 1, borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  actionPrimary:       { backgroundColor: C.amber },
  actionSecondary:     { backgroundColor: C.white, borderWidth: 1.5, borderColor: C.border },
  actionTextPrimary:   { fontFamily: fonts.heading, fontSize: 14, color: "#1A1200" },
  actionTextSecondary: { fontFamily: fonts.heading, fontSize: 14, color: C.navy },

  // Recent sessions
  sessionList: { gap: 10 },
  sessionRow: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: C.white, borderRadius: 14, padding: 14,
    borderWidth: 1.5, borderColor: C.border,
  },
  sessionName: { fontFamily: fonts.heading, fontSize: 14, color: C.navy },
  sessionDate: { fontFamily: fonts.body, fontSize: 12, color: C.muted },
  badge:       { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 100 },
  badgeText:   { fontFamily: fonts.mono, fontSize: 10 },
  typeText:    { fontFamily: fonts.mono, fontSize: 10, color: C.muted },

  // Empty state
  emptyState: {
    backgroundColor: C.white, borderRadius: 16, padding: 32,
    alignItems: "center", gap: 10, borderWidth: 1.5, borderColor: C.border,
  },
  emptyTitle: { fontFamily: fonts.heading, fontSize: 16, color: C.navy },
  emptyBody:  { fontFamily: fonts.body, fontSize: 13.5, color: C.ink, textAlign: "center", lineHeight: 20 },

  // Profile modal
  modalOverlay:  { flex: 1, justifyContent: "flex-end" },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.45)" },
  modalSheet: {
    backgroundColor: C.white, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 24, paddingBottom: 44, alignItems: "center", gap: 8,
  },
  modalHandle:        { width: 40, height: 4, borderRadius: 2, backgroundColor: C.border, marginBottom: 8 },
  profileAvatarLarge: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: C.navy, alignItems: "center", justifyContent: "center", marginBottom: 4,
  },
  profileAvatarText: { fontFamily: fonts.heading, fontSize: 26, color: C.white },
  profileName:       { fontFamily: fonts.heading, fontSize: 20, color: C.navy },
  profileEmail:      { fontFamily: fonts.body, fontSize: 14, color: C.muted },
  roleBadge:         { backgroundColor: C.blueWash, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 100 },
  roleBadgeText:     { fontFamily: fonts.mono, fontSize: 11, color: C.navy, letterSpacing: 1 },
  profileMeta:       { alignItems: "center", gap: 2, marginTop: 4 },
  profileMetaText:   { fontFamily: fonts.body, fontSize: 13, color: C.ink },
  signOutBtn: {
    marginTop: 12, width: "100%", borderRadius: 14,
    paddingVertical: 14, alignItems: "center",
    backgroundColor: C.redBg, borderWidth: 1.5, borderColor: C.red,
  },
  signOutText: { fontFamily: fonts.heading, fontSize: 15, color: C.red },
});