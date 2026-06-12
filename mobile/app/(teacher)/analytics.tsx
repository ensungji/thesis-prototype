// mobile/app/(teacher)/analytics.tsx
// Class performance overview — real data from Supabase word_attempts.

import { useState, useEffect, useCallback } from "react";
import {
  View, Text, Pressable, ScrollView, StyleSheet,
  ActivityIndicator, RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";
import { colors as C, fonts } from "../../lib/theme";
import { BrailleCell } from "../../components/BrailleCell";
import { BrailleLoader } from "../../components/BrailleLoader";

// ── Types ─────────────────────────────────────────────────────────────────────

type Period = "week" | "month" | "all";

type StudentStat = {
  id: string;
  full_name: string;
  total: number;
  correct: number;
  avgResponseMs: number;
  streak: number;
};

type ClassSummary = {
  avgAccuracy: number;
  totalWords: number;
  avgResponseMs: number;
  topStreak: number;
  topStreakStudent: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getInitials(name: string): string {
  return name.trim().split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
}

function formatTime(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function periodFilter(period: Period): string | null {
  if (period === "all") return null;
  const now = new Date();
  if (period === "week") {
    now.setDate(now.getDate() - 7);
  } else {
    now.setMonth(now.getMonth() - 1);
  }
  return now.toISOString();
}

function accuracyColors(pct: number) {
  if (pct >= 80) return { bar: C.green,  bg: C.greenBg,  text: C.green  };
  if (pct >= 60) return { bar: C.amber,  bg: C.brownBg,  text: C.brown  };
  return               { bar: C.red,    bg: C.redBg,    text: C.red    };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SummaryCard({ value, label, bg, color }: {
  value: string; label: string; bg: string; color: string;
}) {
  return (
    <View style={[styles.summaryCard, { backgroundColor: bg }]}>
      <Text style={[styles.summaryValue, { color }]}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

function StudentStatCard({ stat, onPress }: { stat: StudentStat; onPress: () => void }) {
  const accuracy = stat.total > 0 ? Math.round((stat.correct / stat.total) * 100) : 0;
  const ac = accuracyColors(accuracy);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.statCard, pressed && { opacity: 0.85 }]}
      accessibilityRole="button"
    >
      {/* Top row */}
      <View style={styles.statCardTop}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{getInitials(stat.full_name)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.studentName}>{stat.full_name}</Text>
          <Text style={styles.studentMeta}>
            {stat.correct}/{stat.total} correct
            {stat.avgResponseMs > 0 ? ` · ${formatTime(stat.avgResponseMs)} avg` : ""}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end", gap: 4 }}>
          <View style={[styles.accuracyBadge, { backgroundColor: ac.bg }]}>
            <Text style={[styles.accuracyBadgeText, { color: ac.text }]}>{accuracy}%</Text>
          </View>
          {stat.streak > 0 && (
            <Text style={styles.streakText}>🔥 {stat.streak}</Text>
          )}
        </View>
      </View>

      {/* Accuracy bar */}
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${accuracy}%` as any, backgroundColor: ac.bar }]} />
      </View>
    </Pressable>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function AnalyticsScreen() {
  const router = useRouter();

  const [period, setPeriod]           = useState<Period>("all");
  const [studentStats, setStudentStats] = useState<StudentStat[]>([]);
  const [summary, setSummary]         = useState<ClassSummary | null>(null);
  const [loading, setLoading]         = useState(true);
  const [refreshing, setRefreshing]   = useState(false);

  const loadAnalytics = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // Fetch all students for this teacher
    const { data: students } = await supabase
      .from("students")
      .select("id, full_name")
      .eq("teacher_id", user.id)
      .order("full_name");

    if (!students || students.length === 0) {
      setStudentStats([]);
      setSummary(null);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    // Fetch word attempts for all students, filtered by period
    const since = periodFilter(period);
    let query = supabase
      .from("word_attempts")
      .select("student_id, is_correct, response_time_ms, attempted_at")
      .in("student_id", students.map(s => s.id));

    if (since) query = query.gte("attempted_at", since);

    const { data: attempts } = await query.order("attempted_at", { ascending: false });
    const allAttempts = attempts ?? [];

    // Compute per-student stats
    const stats: StudentStat[] = students.map(s => {
      const mine = allAttempts.filter(a => a.student_id === s.id);
      const total   = mine.length;
      const correct = mine.filter(a => a.is_correct).length;
      const timed   = mine.filter(a => (a.response_time_ms ?? 0) > 0);
      const avgResponseMs = timed.length > 0
        ? Math.round(timed.reduce((acc, a) => acc + (a.response_time_ms ?? 0), 0) / timed.length)
        : 0;

      // Streak: consecutive correct from most recent
      // Re-fetch in DESC order (already sorted DESC above)
      let streak = 0;
      for (const a of mine) {
        if (a.is_correct) streak++;
        else break;
      }

      return { id: s.id, full_name: s.full_name, total, correct, avgResponseMs, streak };
    });

    setStudentStats(stats);

    // Class summary
    const totalWords   = stats.reduce((s, x) => s + x.total, 0);
    const avgAccuracy  = stats.length > 0
      ? Math.round(stats.reduce((s, x) => s + (x.total > 0 ? (x.correct / x.total) * 100 : 0), 0) / stats.length)
      : 0;
    const respondingStudents = stats.filter(x => x.avgResponseMs > 0);
    const avgResponseMs = respondingStudents.length > 0
      ? Math.round(respondingStudents.reduce((s, x) => s + x.avgResponseMs, 0) / respondingStudents.length)
      : 0;
    const topStreakStat = stats.reduce((best, x) => x.streak > best.streak ? x : best, stats[0]);

    setSummary({
      avgAccuracy,
      totalWords,
      avgResponseMs,
      topStreak: topStreakStat?.streak ?? 0,
      topStreakStudent: topStreakStat?.full_name.split(" ")[0] ?? "—",
    });

    setLoading(false);
    setRefreshing(false);
  }, [period]);

  useEffect(() => { loadAnalytics(); }, [loadAnalytics]);

  // ── Realtime: re-compute analytics whenever a new attempt comes in ───────────
  useEffect(() => {
    const channel = supabase
      .channel("analytics-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "word_attempts" },
        () => { loadAnalytics(); }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [loadAnalytics]);

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.center}><BrailleLoader size={16} /></View>
      </SafeAreaView>
    );
  }

  const hasData = studentStats.some(s => s.total > 0);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Analytics</Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); loadAnalytics(); }}
            tintColor={C.navy}
          />
        }
      >
        {/* Period filter */}
        <View style={styles.periodRow}>
          {(["week", "month", "all"] as Period[]).map(p => (
            <Pressable
              key={p}
              onPress={() => { setPeriod(p); setLoading(true); }}
              style={[styles.periodChip, period === p && styles.periodChipActive]}
              accessibilityRole="button"
            >
              <Text style={[styles.periodChipText, period === p && styles.periodChipTextActive]}>
                {p === "week" ? "This Week" : p === "month" ? "This Month" : "All Time"}
              </Text>
            </Pressable>
          ))}
        </View>

        {!hasData ? (
          /* Empty state */
          <View style={styles.empty}>
            <BrailleCell pattern={[]} size={18} emptyColor={C.border} />
            <Text style={styles.emptyTitle}>No data yet</Text>
            <Text style={styles.emptyBody}>
              Complete a session with students to start seeing accuracy rates and response times here.
            </Text>
          </View>
        ) : (
          <>
            {/* Class summary */}
            <Text style={styles.sectionLabel}>CLASS OVERVIEW</Text>
            <View style={styles.summaryRow}>
              <SummaryCard
                value={`${summary?.avgAccuracy ?? 0}%`}
                label="Class Accuracy"
                bg={(summary?.avgAccuracy ?? 0) >= 80 ? C.greenBg : (summary?.avgAccuracy ?? 0) >= 60 ? C.brownBg : C.redBg}
                color={(summary?.avgAccuracy ?? 0) >= 80 ? C.green : (summary?.avgAccuracy ?? 0) >= 60 ? C.brown : C.red}
              />
              <SummaryCard
                value={String(summary?.totalWords ?? 0)}
                label="Total Words"
                bg={C.blueWash}
                color={C.navy}
              />
            </View>
            <View style={styles.summaryRow}>
              <SummaryCard
                value={summary?.avgResponseMs ? formatTime(summary.avgResponseMs) : "—"}
                label="Avg Response"
                bg={C.brownBg}
                color={C.brown}
              />
              <SummaryCard
                value={summary?.topStreak ? `🔥 ${summary.topStreak}` : "—"}
                label={`Top Streak${summary?.topStreakStudent ? ` · ${summary.topStreakStudent}` : ""}`}
                bg={summary?.topStreak ? C.greenBg : C.bg}
                color={summary?.topStreak ? C.green : C.muted}
              />
            </View>

            {/* Student breakdown */}
            <Text style={styles.sectionLabel}>STUDENT PERFORMANCE</Text>
            <View style={styles.statList}>
              {studentStats.map(stat => (
                <StudentStatCard
                  key={stat.id}
                  stat={stat}
                  onPress={() => router.push(`/(teacher)/students/${stat.id}` as any)}
                />
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  header: {
    paddingHorizontal: 20, paddingVertical: 16,
    backgroundColor: C.white, borderBottomWidth: 1.5, borderBottomColor: C.border,
  },
  title: { fontFamily: fonts.heading, fontSize: 24, color: C.navy },

  scroll: { padding: 16, gap: 14, paddingBottom: 40 },

  // Period filter
  periodRow:            { flexDirection: "row", gap: 8 },
  periodChip:           { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 100, borderWidth: 1.5, borderColor: C.border, backgroundColor: C.white },
  periodChipActive:     { backgroundColor: C.navy, borderColor: C.navy },
  periodChipText:       { fontFamily: fonts.heading, fontSize: 12, color: C.muted },
  periodChipTextActive: { color: C.white },

  sectionLabel: { fontFamily: fonts.mono, fontSize: 11, color: C.brown, letterSpacing: 1, marginTop: 4 },

  // Summary cards
  summaryRow:    { flexDirection: "row", gap: 10 },
  summaryCard:   { flex: 1, borderRadius: 14, padding: 14, alignItems: "center", gap: 4 },
  summaryValue:  { fontFamily: fonts.heading, fontSize: 22, lineHeight: 26 },
  summaryLabel:  { fontFamily: fonts.body, fontSize: 10, color: C.ink, textAlign: "center" },

  // Student stat cards
  statList:          { gap: 12 },
  statCard:          { backgroundColor: C.white, borderRadius: 14, padding: 16, borderWidth: 1.5, borderColor: C.border, gap: 12 },
  statCardTop:       { flexDirection: "row", alignItems: "center", gap: 12 },
  avatar:            { width: 44, height: 44, borderRadius: 22, backgroundColor: C.navy, alignItems: "center", justifyContent: "center" },
  avatarText:        { fontFamily: fonts.heading, fontSize: 16, color: C.white },
  studentName:       { fontFamily: fonts.heading, fontSize: 15, color: C.navy },
  studentMeta:       { fontFamily: fonts.body, fontSize: 12, color: C.muted, marginTop: 2 },
  accuracyBadge:     { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 100 },
  accuracyBadgeText: { fontFamily: fonts.heading, fontSize: 13 },
  streakText:        { fontFamily: fonts.mono, fontSize: 11, color: C.green },
  barTrack:          { height: 6, backgroundColor: C.border, borderRadius: 100, overflow: "hidden" },
  barFill:           { height: 6, borderRadius: 100 },

  // Empty state
  empty:      { alignItems: "center", justifyContent: "center", padding: 40, marginTop: 40, gap: 12 },
  emptyTitle: { fontFamily: fonts.heading, fontSize: 18, color: C.navy },
  emptyBody:  { fontFamily: fonts.body, fontSize: 14, color: C.ink, textAlign: "center", lineHeight: 22 },
});