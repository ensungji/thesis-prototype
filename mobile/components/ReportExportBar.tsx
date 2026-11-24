// mobile/components/ReportExportBar.tsx
// "Export PDF" + "Export CSV" for the three reports (lib/report-data.ts +
// lib/pdf-report.ts). Shows a spinner while the report is made. If it fails
// (offline, server error, old app build without PDF support) it calls onError
// so the screen shows its toast (Toast is positioned on the screen, so it
// can't live inside a ScrollView).
//
//   scope = { kind: "student", studentId }   students/[id].tsx (with period chips)
//           { kind: "session", sessionId }   finished session + Review screen
//           { kind: "period", period }       Analytics tab (period from its chips)

import { useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors as C, fonts, MIN_TOUCH } from "../lib/theme";
import {
  type Report,
  type ReportPeriod,
  PERIOD_LABEL,
  loadPeriodReport,
  loadSessionReport,
  loadStudentReport,
  reportErrorMessage,
} from "../lib/report-data";
import { shareReportCsv, shareReportPdf } from "../lib/pdf-report";

export type ReportScope =
  | { kind: "student"; studentId: string }
  | { kind: "session"; sessionId: string }
  | { kind: "period"; period: ReportPeriod };

const PERIODS: ReportPeriod[] = ["today", "week", "month", "all"];

type Props = {
  scope: ReportScope;
  /** Optional heading above the buttons. */
  label?: string;
  /** Show a toast: e.g. ("Couldn't make the PDF", "You're offline…"). */
  onError: (message: string, detail: string) => void;
};

export function ReportExportBar({ scope, label, onError }: Props) {
  const [busy, setBusy] = useState<"pdf" | "csv" | null>(null);
  const [studentPeriod, setStudentPeriod] = useState<ReportPeriod>("all");

  async function load(): Promise<Report> {
    if (scope.kind === "student") return loadStudentReport(scope.studentId, studentPeriod);
    if (scope.kind === "session") return loadSessionReport(scope.sessionId);
    return loadPeriodReport(scope.period);
  }

  async function run(kind: "pdf" | "csv") {
    if (busy) return;
    setBusy(kind);
    try {
      const report = await load();
      if (kind === "pdf") await shareReportPdf(report);
      else await shareReportCsv(report);
    } catch (e) {
      onError(kind === "pdf" ? "Couldn't make the PDF" : "Couldn't make the CSV", reportErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const Btn = ({ kind, icon, text }: { kind: "pdf" | "csv"; icon: keyof typeof Ionicons.glyphMap; text: string }) => {
    const mine = busy === kind;
    const disabled = !!busy;
    return (
      <Pressable
        onPress={() => run(kind)}
        disabled={disabled}
        style={({ pressed }) => [
          styles.btn,
          kind === "pdf" ? styles.btnPrimary : styles.btnSecondary,
          disabled && !mine && { opacity: 0.45 },
          pressed && { opacity: 0.8 },
        ]}
        accessibilityRole="button"
        accessibilityLabel={`${text}${scope.kind === "student" ? `, ${PERIOD_LABEL[studentPeriod]}` : ""}`}
        accessibilityState={{ disabled, busy: mine }}
      >
        {mine ? (
          <ActivityIndicator size="small" color={kind === "pdf" ? C.white : C.navy} />
        ) : (
          <Ionicons name={icon} size={18} color={kind === "pdf" ? C.white : C.navy} />
        )}
        <Text style={[styles.btnText, kind === "pdf" ? { color: C.white } : { color: C.navy }]} numberOfLines={1}>
          {mine ? "Preparing…" : text}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={styles.wrap}>
      {!!label && <Text style={styles.label}>{label}</Text>}
      {scope.kind === "student" && (
        <View style={styles.chips}>
          {PERIODS.map((p) => (
            <Pressable
              key={p}
              onPress={() => setStudentPeriod(p)}
              disabled={!!busy}
              style={[styles.chip, studentPeriod === p && styles.chipActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: studentPeriod === p }}
            >
              <Text style={[styles.chipText, studentPeriod === p && styles.chipTextActive]}>{PERIOD_LABEL[p]}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={styles.row}>
        <Btn kind="pdf" icon="document-text-outline" text="Export PDF" />
        <Btn kind="csv" icon="grid-outline" text="Export CSV" />
      </View>
      {busy && (
        <Text style={styles.hint}>Loading every answer and try. Large periods can take a little while.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  label: { fontFamily: fonts.mono, fontSize: 11, color: C.brown, letterSpacing: 1 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    minHeight: 36,
    justifyContent: "center",
    borderRadius: 100,
    borderWidth: 1.5,
    borderColor: C.border,
    backgroundColor: C.white,
  },
  chipActive: { backgroundColor: C.navy, borderColor: C.navy },
  chipText: { fontFamily: fonts.heading, fontSize: 12, color: C.muted },
  chipTextActive: { color: C.white },
  row: { flexDirection: "row", gap: 10 },
  btn: {
    flex: 1,
    minHeight: MIN_TOUCH,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 12,
  },
  btnPrimary: { backgroundColor: C.navy },
  btnSecondary: { backgroundColor: C.white, borderWidth: 1.5, borderColor: C.navy },
  btnText: { fontFamily: fonts.heading, fontSize: 14 },
  hint: { fontFamily: fonts.body, fontSize: 12, color: C.muted },
});
