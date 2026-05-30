// mobile/app/(teacher)/analytics.tsx
// Shows per-student accuracy, response times, and word counts.
// Mock data used for now — Supabase queries are commented [BACKEND].

import { useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors as C, fonts } from "../../lib/theme";
import { BrailleCell } from "../../components/BrailleCell";

// ── Types ─────────────────────────────────────────────────────────────────────

type Period = "week" | "month" | "all";

type StudentStat = {
  id: string;
  name: string;
  wordsTried: number;
  correctWords: number;
  avgResponseMs: number;
};

// ── Mock data — replace with Supabase queries ─────────────────────────────────
// [BACKEND]
// const { data: attempts } = await supabase
//   .from("word_attempts")
//   .select("*, students(full_name)")
//   .eq("students.teacher_id", profile.id);
// Then group by student and compute accuracy + avg response time.

const MOCK: StudentStat[] = [
  { id: "1", name: "Maria Santos",   wordsTried: 24, correctWords: 20, avgResponseMs: 3200 },
  { id: "2", name: "Juan dela Cruz", wordsTried: 18, correctWords: 12, avgResponseMs: 4800 },
  { id: "3", name: "Ana Reyes",      wordsTried: 30, correctWords: 27, avgResponseMs: 2850 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function accuracy(s: StudentStat): number {
  if (s.wordsTried === 0) return 0;
  return Math.round((s.correctWords / s.wordsTried) * 100);
}

function formatTime(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function getInitials(name: string): string {
  return name.trim().split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
}

function accuracyColors(pct: number): { bar: string; bg: string; text: string } {
  if (pct >= 80) return { bar: C.green, bg: C.greenBg, text: C.green };
  if (pct >= 60) return { bar: C.amber, bg: C.brownBg, text: C.brown };
  return               { bar: C.red,   bg: C.redBg,   text: C.red   };
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

function StudentStatCard({ stat }: { stat: StudentStat }) {
  const pct    = accuracy(stat);
  const colors = accuracyColors(pct);

  return (
    <View style={styles.statCard}>
      {/* Student info */}
      <View style={styles.statCardTop}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{getInitials(stat.name)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.studentName}>{stat.name}</Text>
          <Text style={styles.studentMeta}>
            {stat.correctWords}/{stat.wordsTried} correct · {formatTime(stat.avgResponseMs)} avg
          </Text>
        </View>
        {/* Accuracy badge */}
        <View style={[styles.accuracyBadge, { backgroundColor: colors.bg }]}>
          <Text style={[styles.accuracyBadgeText, { color: colors.text }]}>{pct}%</Text>
        </View>
      </View>

      {/* Accuracy bar */}
      <View style={styles.barTrack}>
        <View
          style={[
            styles.barFill,
            { width: `${pct}%` as any, backgroundColor: colors.bar },
          ]}
        />
      </View>
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function AnalyticsScreen() {
  const [period, setPeriod] = useState<Period>("all");

  // Derive overall summary from mock data
  // [BACKEND] These would be computed from real Supabase data
  const totalWords   = MOCK.reduce((s, m) => s + m.wordsTried, 0);
  const avgAccuracy  = MOCK.length
    ? Math.round(MOCK.reduce((s, m) => s + accuracy(m), 0) / MOCK.length)
    : 0;
  const avgResponse  = MOCK.length
    ? Math.round(MOCK.reduce((s, m) => s + m.avgResponseMs, 0) / MOCK.length)
    : 0;

  const hasData = MOCK.length > 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Analytics</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        {/* Period filter */}
        <View style={styles.periodRow}>
          {(["week", "month", "all"] as Period[]).map((p) => (
            <Pressable
              key={p}
              onPress={() => setPeriod(p)}
              style={[styles.periodChip, period === p && styles.periodChipActive]}
              accessibilityRole="button"
              accessibilityLabel={`Filter by ${p === "all" ? "all time" : `this ${p}`}`}
            >
              <Text style={[styles.periodChipText, period === p && styles.periodChipTextActive]}>
                {p === "week" ? "This Week" : p === "month" ? "This Month" : "All Time"}
              </Text>
            </Pressable>
          ))}
        </View>

        {hasData ? (
          <>
            {/* Summary row */}
            <Text style={styles.sectionLabel}>OVERVIEW</Text>
            <View style={styles.summaryRow}>
              <SummaryCard value={`${avgAccuracy}%`} label="Avg Accuracy" bg={avgAccuracy >= 80 ? C.greenBg : avgAccuracy >= 60 ? C.brownBg : C.redBg} color={avgAccuracy >= 80 ? C.green : avgAccuracy >= 60 ? C.brown : C.red} />
              <SummaryCard value={String(totalWords)}   label="Words Sent"   bg={C.blueWash} color={C.navy}  />
              <SummaryCard value={formatTime(avgResponse)} label="Avg Response" bg={C.brownBg}  color={C.brown} />
            </View>

            {/* Per-student breakdown */}
            <Text style={styles.sectionLabel}>STUDENT PERFORMANCE</Text>
            <View style={styles.statList}>
              {MOCK.map((stat) => (
                <StudentStatCard key={stat.id} stat={stat} />
              ))}
            </View>

            <Text style={styles.dataNote}>
              ✦ Data shown is for demonstration. Live results will appear here once sessions are completed and backend is connected.
            </Text>
          </>
        ) : (
          /* Empty state */
          <View style={styles.empty}>
            <BrailleCell pattern={[]} size={18} emptyColor={C.border} />
            <Text style={styles.emptyTitle}>No data yet</Text>
            <Text style={styles.emptyBody}>
              Complete a session with students to start seeing accuracy rates and response times here.
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 16, gap: 16, paddingBottom: 40 },

  header: {
    paddingHorizontal: 20, paddingVertical: 16,
    backgroundColor: C.white,
    borderBottomWidth: 1.5, borderBottomColor: C.border,
  },
  title: { fontFamily: fonts.heading, fontSize: 24, color: C.navy },

  // Period filter
  periodRow: { flexDirection: "row", gap: 8 },
  periodChip: {
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 100, borderWidth: 1.5, borderColor: C.border,
    backgroundColor: C.white,
  },
  periodChipActive:     { backgroundColor: C.navy, borderColor: C.navy },
  periodChipText:       { fontFamily: fonts.heading, fontSize: 12, color: C.muted },
  periodChipTextActive: { color: C.white },

  sectionLabel: { fontFamily: fonts.mono, fontSize: 11, color: C.brown, letterSpacing: 1, marginTop: 4 },

  // Summary
  summaryRow:   { flexDirection: "row", gap: 10 },
  summaryCard:  { flex: 1, borderRadius: 14, padding: 14, alignItems: "center", gap: 4 },
  summaryValue: { fontFamily: fonts.heading, fontSize: 22, lineHeight: 26 },
  summaryLabel: { fontFamily: fonts.body, fontSize: 10, color: C.ink, textAlign: "center" },

  // Student stat cards
  statList: { gap: 12 },
  statCard: {
    backgroundColor: C.white, borderRadius: 14, padding: 16,
    borderWidth: 1.5, borderColor: C.border, gap: 12,
  },
  statCardTop:    { flexDirection: "row", alignItems: "center", gap: 12 },
  avatar:         { width: 44, height: 44, borderRadius: 22, backgroundColor: C.navy, alignItems: "center", justifyContent: "center" },
  avatarText:     { fontFamily: fonts.heading, fontSize: 15, color: C.white },
  studentName:    { fontFamily: fonts.heading, fontSize: 15, color: C.navy },
  studentMeta:    { fontFamily: fonts.body, fontSize: 12, color: C.muted, marginTop: 2 },
  accuracyBadge:  { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 100 },
  accuracyBadgeText: { fontFamily: fonts.heading, fontSize: 14 },

  // Accuracy bar
  barTrack: { height: 8, backgroundColor: C.border, borderRadius: 100, overflow: "hidden" },
  barFill:  { height: 8, borderRadius: 100 },

  // Data note
  dataNote: {
    fontFamily: fonts.body, fontSize: 11, color: C.muted,
    textAlign: "center", lineHeight: 18, marginTop: 4,
  },

  // Empty state
  empty:      { alignItems: "center", justifyContent: "center", padding: 40, marginTop: 40, gap: 12 },
  emptyTitle: { fontFamily: fonts.heading, fontSize: 18, color: C.navy },
  emptyBody:  { fontFamily: fonts.body, fontSize: 14, color: C.ink, textAlign: "center", lineHeight: 22 },
});