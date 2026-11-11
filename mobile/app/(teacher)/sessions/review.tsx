// mobile/app/(teacher)/sessions/review.tsx
// Review a finished session (any type): per word, each student's final
// result, tries and who graded it; filter Needs review / Wrong / All; expand a
// row for every try (answer_attempts) with its recording; re-grade any row.
// Re-grading is allowed once the session is finished (grading lock,
// migration 22); the first re-grade keeps what it was ("was: correct by voice").
// "Done reviewing" saves sessions.reviewed_at (migration 23); from then on the
// session counts toward the speech grading agreement shown at the top.

import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../lib/supabase";
import { updateOrQueue } from "../../../lib/outbox";
import { colors as C, fonts, MIN_TOUCH } from "../../../lib/theme";
import { getSessionTypeLabel } from "../../../lib/session-timer";
import {
  type ReviewAttempt,
  type ReviewData,
  type ReviewFilter,
  type ReviewResult,
  type ReviewTry,
  agreementSentence,
  gradedByLabel,
  loadReview,
  loadTries,
  markReviewed,
  matchesFilter,
  reloadAttempt,
  resultOf,
  shortDate,
  speechAgreement,
  wasLabel,
} from "../../../lib/review";
import { BrailleLoader } from "../../../components/BrailleLoader";
import { PlayRecordingButton } from "../../../components/PlayRecordingButton";
import { Toast } from "../../../components/Toast";

const RESULT_STYLE: Record<ReviewResult, { bg: string; fg: string; label: string }> = {
  correct: { bg: C.greenBg, fg: C.green, label: "✓ Correct" },
  wrong: { bg: C.redBg, fg: C.red, label: "✗ Wrong" },
  review: { bg: C.brownBg, fg: C.brown, label: "⚠ Review" },
  missed: { bg: C.border, fg: C.muted, label: "– No answer" },
  skipped: { bg: C.border, fg: C.muted, label: "» Skipped" },
};
const TRY_STYLE: Record<ReviewTry["result"], { fg: string; label: string }> = {
  correct: { fg: C.green, label: "Correct" },
  wrong: { fg: C.red, label: "Wrong" },
  review: { fg: C.brown, label: "Review" },
};
const FILTERS: { key: ReviewFilter; label: string }[] = [
  { key: "review", label: "Needs review" },
  { key: "wrong", label: "Wrong" },
  { key: "all", label: "All" },
];

const clean = (t?: string | null) => (t ?? "").replace(/[.!?,]/g, "").trim();
const clock = (iso: string) => {
  const d = new Date(iso);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
};

type TriesState = { loading: boolean; error?: string; tries: ReviewTry[] };

export default function SessionReview() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [data, setData] = useState<ReviewData | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<ReviewFilter | null>(null); // null = pick on first load
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tries, setTries] = useState<Record<string, TriesState>>({});
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ message: string; detail?: string } | null>(null);
  const insets = useSafeAreaInsets();
  const [confirmDone, setConfirmDone] = useState(false);
  const [markingDone, setMarkingDone] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const [res, user] = await Promise.all([loadReview(id), supabase.auth.getUser()]);
    setUserId(user.data.user?.id ?? null);
    if (res.error !== null) setError(res.error);
    else {
      setData(res.data);
      setError("");
      // First load: start on "Needs review" when there is any
      setFilter((f) => f ?? (res.data.attempts.some((a) => resultOf(a) === "review") ? "review" : "all"));
    }
    setLoading(false);
    setRefreshing(false);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const studentName = useCallback(
    (sid: string) => data?.students.find((s) => s.id === sid)?.full_name ?? "Student",
    [data]
  );

  const counts = useMemo(() => {
    const all = data?.attempts ?? [];
    return {
      review: all.filter((a) => matchesFilter(a, "review")).length,
      wrong: all.filter((a) => matchesFilter(a, "wrong")).length,
      all: all.length,
    };
  }, [data]);

  async function toggle(a: ReviewAttempt) {
    const next = new Set(expanded);
    if (next.has(a.id)) {
      next.delete(a.id);
      setExpanded(next);
      return;
    }
    next.add(a.id);
    setExpanded(next);
    if (!a.session_word_id || tries[a.id]?.tries.length) return;
    setTries((t) => ({ ...t, [a.id]: { loading: true, tries: [] } }));
    const res = await loadTries(a.session_word_id, a.student_id);
    setTries((t) => ({
      ...t,
      [a.id]: res.error !== null ? { loading: false, error: res.error, tries: [] } : { loading: false, tries: res.data },
    }));
  }

  async function regrade(a: ReviewAttempt, correct: boolean) {
    if (!data || saving.has(a.id)) return;
    if (a.graded_by === "teacher" && a.is_correct === correct && !a.needs_review) return; // already so
    const before = a;
    const patch = { is_correct: correct, needs_review: false, graded_by: "teacher" };
    const replace = (row: ReviewAttempt) =>
      setData((d) => (d ? { ...d, attempts: d.attempts.map((x) => (x.id === row.id ? row : x)) } : d));
    replace({ ...a, ...patch });
    setSaving((s) => new Set(s).add(a.id));
    const { queued, error: err } = await updateOrQueue("word_attempts", patch, { id: a.id });
    if (err) {
      replace(before);
      setToast({ message: "Couldn't save the grade", detail: err });
    } else if (!queued) {
      // the server added the re-grade history (original_*, regraded_*)
      const fresh = await reloadAttempt(a.id);
      if (fresh) replace(fresh);
    }
    setSaving((s) => {
      const n = new Set(s);
      n.delete(a.id);
      return n;
    });
  }

  async function doneReviewing() {
    if (!data || markingDone) return;
    setMarkingDone(true);
    const res = await markReviewed(data.session.id);
    setMarkingDone(false);
    setConfirmDone(false);
    if (res.error !== null) {
      setToast({ message: "Couldn't mark it reviewed", detail: res.error });
      return;
    }
    setData((d) => (d ? { ...d, session: { ...d.session, reviewed_at: res.data } } : d));
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading && !data) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.center}>
          <BrailleLoader size={16} />
        </View>
      </SafeAreaView>
    );
  }

  const f = filter ?? "all";
  const header = (
    <View style={styles.header}>
      <Pressable
        onPress={() => router.back()}
        style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
        accessibilityRole="button"
        accessibilityLabel="Back to the session"
      >
        <Ionicons name="arrow-back" size={22} color={C.navy} />
      </Pressable>
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>Review</Text>
        {data && (
          <Text style={styles.subtitle} numberOfLines={1}>
            {data.session.name} · {getSessionTypeLabel(data.session.type)}
          </Text>
        )}
      </View>
    </View>
  );

  if (!data) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        {header}
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error || "Couldn't load this session."}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const finished = data.session.status === "finished";
  const groups = data.words
    .map((w) => ({
      word: w,
      rows: data.attempts
        .filter((a) => a.session_word_id === w.id && matchesFilter(a, f))
        .sort((x, y) => studentName(x.student_id).localeCompare(studentName(y.student_id))),
      answered: data.attempts.some((a) => a.session_word_id === w.id),
    }))
    .filter((g) => g.rows.length > 0 || (f === "all" && !g.answered));
  // Answers whose word is gone (older rows): shown under All only
  const orphans = f === "all" ? data.attempts.filter((a) => !data.words.some((w) => w.id === a.session_word_id)) : [];

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {header}
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              setTries({});
              load();
            }}
            tintColor={C.navy}
          />
        }
      >
        {!finished && (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>
              {"This session hasn't finished yet. Voice grades can be changed once it ends."}
            </Text>
          </View>
        )}

        {/* Speech grading agreement: only once the teacher says they're done */}
        {finished &&
          (data.session.reviewed_at ? (
            (() => {
              const g = speechAgreement(data.attempts);
              return (
                <View style={styles.agreeCard} accessible accessibilityLiveRegion="polite">
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Ionicons name="checkmark-done" size={16} color={C.green} />
                    <Text style={styles.agreeLabel}>REVIEWED {shortDate(data.session.reviewed_at).toUpperCase()}</Text>
                  </View>
                  <Text style={styles.agreeText}>{agreementSentence(g, "you")}</Text>
                  {g.voice > 0 && g.voice > g.agreed && (
                    <Text style={styles.meta}>
                      {g.voice - g.agreed} changed by you to a different result.
                    </Text>
                  )}
                  {g.stillReview > 0 && (
                    <Text style={styles.meta}>
                      {g.stillReview} still marked Review {g.stillReview === 1 ? "isn't" : "aren't"} counted.
                    </Text>
                  )}
                </View>
              );
            })()
          ) : (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>
                {"When you've checked the answers, tap Done reviewing at the bottom. Then this session counts toward the speech grading agreement."}
              </Text>
            </View>
          ))}

        <View style={styles.chips}>
          {FILTERS.map(({ key, label }) => {
            const on = f === key;
            return (
              <Pressable
                key={key}
                onPress={() => setFilter(key)}
                style={[styles.chip, on && styles.chipOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>
                  {label} {counts[key]}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {groups.length === 0 && orphans.length === 0 && (
          <Text style={styles.empty}>
            {f === "review" ? "Nothing needs review." : f === "wrong" ? "No wrong answers." : "No answers in this session."}
          </Text>
        )}

        {groups.map(({ word, rows, answered }) => (
          <View key={word.id} style={styles.wordCard}>
            <Text style={styles.wordHead}>
              {String(data.words.indexOf(word) + 1).padStart(2, "0")} · {word.word}
            </Text>
            {!answered && <Text style={styles.meta}>No answers (not shown, or nobody was assigned).</Text>}
            {rows.map((a) => (
              <Row
                key={a.id}
                a={a}
                name={studentName(a.student_id)}
                regrader={a.regraded_by ? (a.regraded_by === userId ? "you" : data.names[a.regraded_by] ?? "a teacher") : null}
                canRegrade={finished}
                saving={saving.has(a.id)}
                expanded={expanded.has(a.id)}
                tries={tries[a.id]}
                onToggle={() => toggle(a)}
                onGrade={(c) => regrade(a, c)}
              />
            ))}
          </View>
        ))}

        {orphans.length > 0 && (
          <View style={styles.wordCard}>
            <Text style={styles.wordHead}>Other answers</Text>
            {orphans.map((a) => (
              <Row
                key={a.id}
                a={a}
                name={`${studentName(a.student_id)} · ${a.word}`}
                regrader={a.regraded_by ? (a.regraded_by === userId ? "you" : data.names[a.regraded_by] ?? "a teacher") : null}
                canRegrade={finished}
                saving={saving.has(a.id)}
                expanded={expanded.has(a.id)}
                tries={tries[a.id]}
                onToggle={() => toggle(a)}
                onGrade={(c) => regrade(a, c)}
              />
            ))}
          </View>
        )}

        {finished && !data.session.reviewed_at && (
          <Pressable
            onPress={() => (counts.review > 0 ? setConfirmDone(true) : doneReviewing())}
            disabled={markingDone}
            style={({ pressed }) => [styles.doneBtn, (pressed || markingDone) && { opacity: 0.75 }]}
            accessibilityRole="button"
            accessibilityHint="Counts this session toward the speech grading agreement"
          >
            {markingDone ? (
              <ActivityIndicator color="#1A1200" />
            ) : (
              <>
                <Ionicons name="checkmark-done" size={20} color="#1A1200" />
                <Text style={styles.doneText}>Done reviewing</Text>
              </>
            )}
          </Pressable>
        )}
      </ScrollView>

      {/* Some answers still say Review: ask before counting the session */}
      <Modal visible={confirmDone} animationType="slide" transparent onRequestClose={() => setConfirmDone(false)}>
        <View style={styles.overlay}>
          <Pressable style={styles.backdrop} onPress={() => !markingDone && setConfirmDone(false)} />
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}>
            <Text style={styles.sheetTitle}>
              {counts.review} answer{counts.review === 1 ? "" : "s"} still need{counts.review === 1 ? "s" : ""} review
            </Text>
            <Text style={styles.sheetBody}>
              {"Answers still marked Review won't count toward the speech grading agreement. Grade them with ✓ / ✗ first, or mark the session done anyway."}
            </Text>
            <View style={styles.sheetActions}>
              <Pressable
                onPress={() => {
                  setConfirmDone(false);
                  setFilter("review");
                }}
                style={({ pressed }) => [styles.sheetBtn, styles.sheetBtnPlain, pressed && { opacity: 0.7 }]}
                accessibilityRole="button"
              >
                <Text style={styles.sheetBtnPlainText}>Show them</Text>
              </Pressable>
              <Pressable
                onPress={doneReviewing}
                disabled={markingDone}
                style={({ pressed }) => [styles.sheetBtn, styles.sheetBtnMain, (pressed || markingDone) && { opacity: 0.75 }]}
                accessibilityRole="button"
              >
                <Text style={styles.sheetBtnMainText}>{markingDone ? "Saving…" : "Done anyway"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Toast
        message={toast?.message ?? ""}
        detail={toast?.detail}
        visible={!!toast}
        variant="warning"
        duration={6000}
        onDismiss={() => setToast(null)}
      />
    </SafeAreaView>
  );
}

// ── One student's result for one word ─────────────────────────────────────────

function Row({
  a,
  name,
  regrader,
  canRegrade,
  saving,
  expanded,
  tries,
  onToggle,
  onGrade,
}: {
  a: ReviewAttempt;
  name: string;
  regrader: string | null;
  canRegrade: boolean;
  saving: boolean;
  expanded: boolean;
  tries?: TriesState;
  onToggle: () => void;
  onGrade: (correct: boolean) => void;
}) {
  const r = resultOf(a);
  const rs = RESULT_STYLE[r];
  const n = a.tries ?? 0;
  const was = wasLabel(a);
  const details = [
    gradedByLabel(a.graded_by),
    n > 0 ? `${n} ${n === 1 ? "try" : "tries"}` : null,
    a.transcript && a.graded_by !== "missed" && a.graded_by !== "skipped" ? `heard "${clean(a.transcript)}"` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const hasTries = n > 0 || !!a.audio_path;

  return (
    <View style={styles.row}>
      <View style={styles.rowTop}>
        <Pressable
          onPress={onToggle}
          disabled={!hasTries}
          style={({ pressed }) => [styles.rowMain, pressed && hasTries && { opacity: 0.7 }]}
          accessibilityRole="button"
          accessibilityState={{ expanded, disabled: !hasTries }}
          accessibilityLabel={`${name}: ${rs.label}. ${details}${was ? `. Re-graded by ${regrader}, was ${was}` : ""}`}
          accessibilityHint={hasTries ? (expanded ? "Hides the tries" : "Shows every try") : undefined}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Text style={styles.name} numberOfLines={1}>
              {name}
            </Text>
            <View style={[styles.badge, { backgroundColor: rs.bg }]}>
              <Text style={[styles.badgeText, { color: rs.fg }]}>{rs.label}</Text>
            </View>
          </View>
          <Text style={styles.meta} numberOfLines={2}>
            {details}
          </Text>
          {was && (
            <Text style={styles.regraded}>
              Re-graded by {regrader} (was: {was})
            </Text>
          )}
        </Pressable>
        {hasTries && (
          <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={18} color={C.muted} style={{ marginTop: 4 }} />
        )}
      </View>

      {canRegrade && (
        <View style={styles.gradeRow}>
          {saving && <ActivityIndicator size="small" color={C.navy} />}
          <GradeButton
            correct
            on={r === "correct"}
            disabled={saving}
            label={`Mark ${name} correct`}
            onPress={() => onGrade(true)}
          />
          <GradeButton
            correct={false}
            on={r === "wrong"}
            disabled={saving}
            label={`Mark ${name} wrong`}
            onPress={() => onGrade(false)}
          />
        </View>
      )}

      {expanded && (
        <View style={styles.tries}>
          {!tries || tries.loading ? (
            <ActivityIndicator color={C.navy} />
          ) : tries.error ? (
            <Text style={styles.errorText}>{tries.error}</Text>
          ) : tries.tries.length === 0 ? (
            <View style={styles.tryRow}>
              <Text style={[styles.meta, { flex: 1 }]}>
                No tries saved (answered before every try was kept). The saved recording:
              </Text>
              <PlayRecordingButton path={a.audio_path} label={`${name}'s recording`} size="large" />
            </View>
          ) : (
            tries.tries.map((t) => (
              <View key={t.id} style={styles.tryRow}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.tryHead}>
                    Try {t.attempt_no} · <Text style={{ color: TRY_STYLE[t.result].fg }}>{TRY_STYLE[t.result].label}</Text>
                  </Text>
                  <Text style={styles.meta}>
                    {t.transcript ? `heard "${clean(t.transcript)}"` : "nothing heard"}
                    {t.confidence != null ? ` · ${Math.round(t.confidence * 100)}% sure` : ""}
                    {` · ${clock(t.created_at)}`}
                  </Text>
                </View>
                <PlayRecordingButton
                  path={t.audio_path}
                  label={`try ${t.attempt_no} by ${name}`}
                  size="large"
                />
              </View>
            ))
          )}
        </View>
      )}
    </View>
  );
}

function GradeButton({
  correct,
  on,
  disabled,
  label,
  onPress,
}: {
  correct: boolean;
  on: boolean;
  disabled: boolean;
  label: string;
  onPress: () => void;
}) {
  const color = correct ? C.green : C.red;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.gradeBtn,
        { borderColor: color },
        on && { backgroundColor: color },
        (pressed || disabled) && { opacity: 0.6 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on, disabled }}
    >
      <Ionicons name={correct ? "checkmark" : "close"} size={20} color={on ? C.white : color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: C.white,
    borderBottomWidth: 1.5,
    borderBottomColor: C.border,
  },
  backBtn: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: "center", justifyContent: "center" },
  title: { fontFamily: fonts.heading, fontSize: 20, color: C.navy },
  subtitle: { fontFamily: fonts.mono, fontSize: 11, color: C.muted },
  scroll: { padding: 16, gap: 12, paddingBottom: 48 },
  notice: { padding: 10, borderRadius: 10, backgroundColor: C.brownBg },
  noticeText: { fontFamily: fonts.body, fontSize: 13, color: C.ink },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: 14,
    borderRadius: 100,
    borderWidth: 1.5,
    borderColor: C.border,
    backgroundColor: C.white,
  },
  chipOn: { backgroundColor: C.navy, borderColor: C.navy },
  chipText: { fontFamily: fonts.headingSemi, fontSize: 13, color: C.ink },
  chipTextOn: { color: C.white },
  empty: { fontFamily: fonts.body, fontSize: 14, color: C.muted, textAlign: "center", marginTop: 24 },
  wordCard: {
    backgroundColor: C.white,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1.5,
    borderColor: C.border,
    gap: 4,
  },
  wordHead: { fontFamily: fonts.mono, fontSize: 16, color: C.navy, letterSpacing: 2, marginBottom: 4 },
  row: { borderTopWidth: 1, borderTopColor: C.border, paddingVertical: 10, gap: 8 },
  rowTop: { flexDirection: "row", gap: 8 },
  rowMain: { flex: 1, gap: 3 },
  name: { fontFamily: fonts.bodyBold, fontSize: 15, color: C.ink, flexShrink: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 100 },
  badgeText: { fontFamily: fonts.mono, fontSize: 11 },
  meta: { fontFamily: fonts.body, fontSize: 13, color: C.muted },
  regraded: { fontFamily: fonts.body, fontSize: 12, color: C.brown },
  gradeRow: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 10 },
  gradeBtn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: MIN_TOUCH / 2,
    borderWidth: 1.5,
    backgroundColor: C.white,
    alignItems: "center",
    justifyContent: "center",
  },
  tries: { backgroundColor: C.bg, borderRadius: 10, padding: 10, gap: 8 },
  tryRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  tryHead: { fontFamily: fonts.bodyBold, fontSize: 13, color: C.ink },
  agreeCard: {
    padding: 14,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: C.green,
    backgroundColor: C.greenBg,
    gap: 4,
  },
  agreeLabel: { fontFamily: fonts.mono, fontSize: 11, color: C.green, letterSpacing: 1 },
  agreeText: { fontFamily: fonts.heading, fontSize: 16, color: C.ink, lineHeight: 22 },
  doneBtn: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 14,
    backgroundColor: C.amber,
    marginTop: 8,
  },
  doneText: { fontFamily: fonts.heading, fontSize: 17, color: "#1A1200" },
  overlay: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.45)" },
  sheet: { backgroundColor: C.white, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, gap: 12 },
  sheetTitle: { fontFamily: fonts.heading, fontSize: 20, color: C.navy },
  sheetBody: { fontFamily: fonts.body, fontSize: 14, color: C.ink, lineHeight: 21 },
  sheetActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  sheetBtn: {
    flex: 1,
    minHeight: MIN_TOUCH,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    borderWidth: 1.5,
  },
  sheetBtnPlain: { backgroundColor: C.bg, borderColor: C.border },
  sheetBtnPlainText: { fontFamily: fonts.heading, fontSize: 15, color: C.navy },
  sheetBtnMain: { backgroundColor: C.amber, borderColor: C.amber },
  sheetBtnMainText: { fontFamily: fonts.heading, fontSize: 15, color: "#1A1200" },
  errorBox: {
    margin: 16,
    padding: 12,
    borderRadius: 8,
    backgroundColor: C.redBg,
    borderWidth: 1,
    borderColor: C.red,
  },
  errorText: { fontFamily: fonts.body, fontSize: 13, color: C.red },
});
