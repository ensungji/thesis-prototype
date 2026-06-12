// mobile/app/(teacher)/students/[id].tsx
// Student detail — stats, recent attempts, and all options (edit/pair/delete).

import { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../lib/supabase";
import { colors as C, fonts } from "../../../lib/theme";
import { BrailleCell } from "../../../components/BrailleCell";
import { BrailleLoader } from "../../../components/BrailleLoader";

// ── Types ─────────────────────────────────────────────────────────────────────

type Student = { id: string; full_name: string };
type Device = { id: string; device_code: string; status: string } | null;
type WordAttempt = {
  id: string;
  word: string;
  is_correct: boolean;
  response_time_ms: number | null;
  attempted_at: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const getInitials = (name: string) =>
  name
    .trim()
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

const formatTime = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function computeStats(attempts: WordAttempt[]) {
  const total = attempts.length;
  const correct = attempts.filter((a) => a.is_correct).length;
  const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;
  const timed = attempts.filter((a) => (a.response_time_ms ?? 0) > 0);
  const avgResponse =
    timed.length > 0
      ? Math.round(
          timed.reduce((s, a) => s + (a.response_time_ms ?? 0), 0) /
            timed.length,
        )
      : 0;
  let streak = 0;
  for (const a of attempts) {
    if (a.is_correct) streak++;
    else break;
  }
  return { total, accuracy, avgResponse, streak };
}

function StatCard({
  value,
  label,
  bg,
  color,
}: {
  value: string;
  label: string;
  bg: string;
  color: string;
}) {
  return (
    <View style={[styles.statCard, { backgroundColor: bg }]}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function StudentDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [student, setStudent] = useState<Student | null>(null);
  const [device, setDevice] = useState<Device>(null);
  const [attempts, setAttempts] = useState<WordAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Options sheet
  const [optionsModal, setOptionsModal] = useState(false);

  // Delete modal
  const [deleteModal, setDeleteModal] = useState(false);

  // Edit modal
  const [editModal, setEditModal] = useState(false);
  const [editName, setEditName] = useState("");

  // Pair modal
  const [pairModal, setPairModal] = useState(false);
  const [deviceCode, setDeviceCode] = useState("");
  const [pairError, setPairError] = useState<string | null>(null);

  // ── Load data ────────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    if (!id) return;
    const [studentRes, deviceRes, attemptsRes] = await Promise.all([
      supabase.from("students").select("id, full_name").eq("id", id).single(),
      supabase
        .from("devices")
        .select("id, device_code, status")
        .eq("paired_student_id", id)
        .maybeSingle(),
      supabase
        .from("word_attempts")
        .select("id, word, is_correct, response_time_ms, attempted_at")
        .eq("student_id", id)
        .order("attempted_at", { ascending: false })
        .limit(50),
    ]);
    setStudent(studentRes.data);
    setDevice(deviceRes.data ?? null);
    setAttempts(attemptsRes.data ?? []);
    setLoading(false);
    setRefreshing(false);
  }, [id]);

  useEffect(() => {
    loadData();
    const channel = supabase
      .channel(`student-detail-${id}`)
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "students",
          filter: `id=eq.${id}`,
        },
        () => router.back(),
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "students",
          filter: `id=eq.${id}`,
        },
        loadData,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "devices",
          filter: `paired_student_id=eq.${id}`,
        },
        loadData,
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [id, loadData, router]);

  // ── Options ──────────────────────────────────────────────────────────────────

  function showOptions() {
    setOptionsModal(true);
  }

  // ── Edit name ─────────────────────────────────────────────────────────────────

  async function saveEdit() {
    if (!editName.trim() || !id) return;
    setSaving(true);
    const { error } = await supabase
      .from("students")
      .update({ full_name: editName.trim() })
      .eq("id", id);
    setSaving(false);
    if (error) {
      Alert.alert("Error", error.message);
      return;
    }
    setEditModal(false);
    loadData();
  }

  // ── Pair device ───────────────────────────────────────────────────────────────

  async function pairDevice() {
    if (!deviceCode.trim() || !id) return;
    const code = deviceCode.trim().toUpperCase();
    setSaving(true);
    setPairError(null);
    const { error } = await supabase
      .from("devices")
      .upsert(
        { device_code: code, paired_student_id: id },
        { onConflict: "device_code" },
      );
    setSaving(false);
    if (error) {
      setPairError("This device code is already in use by another student.");
      return;
    }
    setPairModal(false);
    loadData();
  }

  // ── Delete ────────────────────────────────────────────────────────────────────

  async function deleteStudent() {
    setSaving(true);
    const { error } = await supabase.from("students").delete().eq("id", id!);
    setSaving(false);
    if (error) {
      setDeleteModal(false);
      return;
    }
    router.back();
  }

  // ── Loading / error states ────────────────────────────────────────────────────

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.center}>
          <BrailleLoader size={16} />
        </View>
      </SafeAreaView>
    );
  }

  if (!student) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.center}>
          <Text style={styles.errorTxt}>Student not found.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const { total, accuracy, avgResponse, streak } = computeStats(attempts);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
          accessibilityRole="button"
        >
          <Ionicons name="arrow-back" size={20} color={C.navy} />
          <Text style={styles.backText}>Students</Text>
        </Pressable>
        <Pressable
          onPress={showOptions}
          style={({ pressed }) => [
            styles.optionsBtn,
            pressed && { opacity: 0.6 },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Student options"
        >
          <Ionicons name="ellipsis-vertical" size={20} color={C.navy} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              loadData();
            }}
            tintColor={C.navy}
          />
        }
      >
        {/* Identity */}
        <View style={styles.identity}>
          <View style={styles.avatarLarge}>
            <Text style={styles.avatarLargeText}>
              {getInitials(student.full_name)}
            </Text>
          </View>
          <Text style={styles.studentName}>{student.full_name}</Text>
          {device ? (
            <View style={styles.deviceChip}>
              <Ionicons name="hardware-chip-outline" size={12} color={C.navy} />
              <Text style={styles.deviceChipText}>{device.device_code}</Text>
            </View>
          ) : (
            <Pressable
              onPress={() => {
                setDeviceCode("");
                setPairError(null);
                setPairModal(true);
              }}
              style={({ pressed }) => [
                styles.pairChip,
                pressed && { opacity: 0.8 },
              ]}
            >
              <Ionicons name="link-outline" size={12} color={C.brown} />
              <Text style={styles.pairChipText}>Tap to pair device</Text>
            </Pressable>
          )}
          <Text style={styles.studentSub}>
            {total} word{total !== 1 ? "s" : ""} attempted
          </Text>
        </View>

        {/* Stats */}
        <Text style={styles.sectionLabel}>PERFORMANCE</Text>
        <View style={styles.statsGrid}>
          <StatCard
            value={`${accuracy}%`}
            label="Accuracy"
            bg={
              accuracy >= 80
                ? C.greenBg
                : accuracy >= 60
                  ? C.brownBg
                  : total === 0
                    ? C.bg
                    : C.redBg
            }
            color={
              accuracy >= 80
                ? C.green
                : accuracy >= 60
                  ? C.brown
                  : total === 0
                    ? C.muted
                    : C.red
            }
          />
          <StatCard
            value={avgResponse > 0 ? formatTime(avgResponse) : "—"}
            label="Avg Response"
            bg={C.blueWash}
            color={C.navy}
          />
        </View>
        <View style={styles.statsGrid}>
          <StatCard
            value={String(total)}
            label="Total Words"
            bg={C.brownBg}
            color={C.brown}
          />
          <StatCard
            value={String(streak)}
            label="Current Streak 🔥"
            bg={streak > 0 ? C.greenBg : C.bg}
            color={streak > 0 ? C.green : C.muted}
          />
        </View>

        {/* Recent attempts */}
        <Text style={styles.sectionLabel}>RECENT ATTEMPTS</Text>
        {attempts.length === 0 ? (
          <View style={styles.empty}>
            <BrailleCell pattern={[]} size={14} emptyColor={C.border} />
            <Text style={styles.emptyTitle}>No attempts yet</Text>
            <Text style={styles.emptyBody}>
              Start a session to see progress here.
            </Text>
          </View>
        ) : (
          <View style={styles.attemptList}>
            {attempts.map((a) => (
              <View key={a.id} style={styles.attemptRow}>
                <View
                  style={[
                    styles.dot,
                    { backgroundColor: a.is_correct ? C.green : C.red },
                  ]}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.attemptWord}>{a.word}</Text>
                  <Text style={styles.attemptDate}>
                    {formatDate(a.attempted_at)}
                  </Text>
                </View>
                {a.response_time_ms != null && (
                  <Text style={styles.attemptTime}>
                    {formatTime(a.response_time_ms)}
                  </Text>
                )}
                <View
                  style={[
                    styles.resultBadge,
                    { backgroundColor: a.is_correct ? C.greenBg : C.redBg },
                  ]}
                >
                  <Text
                    style={[
                      styles.resultBadgeText,
                      { color: a.is_correct ? C.green : C.red },
                    ]}
                  >
                    {a.is_correct ? "Correct" : "Wrong"}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {/* ── Options sheet ──────────────────────────────────────────────────── */}
      <Modal
        visible={optionsModal}
        animationType="slide"
        transparent
        onRequestClose={() => setOptionsModal(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable
            style={styles.backdrop}
            onPress={() => setOptionsModal(false)}
          />
          <View style={styles.sheet}>
            <View style={styles.handle} />

            {/* Student name as title */}
            <Text style={styles.sheetTitle}>{student?.full_name}</Text>

            {/* Edit Name */}
            <Pressable
              onPress={() => {
                setOptionsModal(false);
                setEditName(student?.full_name ?? "");
                setTimeout(() => setEditModal(true), 300);
              }}
              style={({ pressed }) => [
                styles.optionBtn,
                pressed && { backgroundColor: C.bg },
              ]}
            >
              <View
                style={[styles.optionIcon, { backgroundColor: C.blueWash }]}
              >
                <Ionicons name="pencil-outline" size={18} color={C.navy} />
              </View>
              <Text style={styles.optionText}>Edit Name</Text>
              <Ionicons name="chevron-forward" size={16} color={C.muted} />
            </Pressable>

            {/* Pair / Change Device */}
            <Pressable
              onPress={() => {
                setOptionsModal(false);
                setDeviceCode(device?.device_code ?? "");
                setPairError(null);
                setTimeout(() => setPairModal(true), 300);
              }}
              style={({ pressed }) => [
                styles.optionBtn,
                pressed && { backgroundColor: C.bg },
              ]}
            >
              <View style={[styles.optionIcon, { backgroundColor: C.brownBg }]}>
                <Ionicons
                  name="hardware-chip-outline"
                  size={18}
                  color={C.brown}
                />
              </View>
              <Text style={styles.optionText}>
                {device ? "Change Device" : "Pair Device"}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={C.muted} />
            </Pressable>

            {/* Remove Student — destructive */}
            <Pressable
              onPress={() => {
                setOptionsModal(false);
                setTimeout(() => setDeleteModal(true), 300);
              }}
              style={({ pressed }) => [
                styles.optionBtn,
                pressed && { backgroundColor: C.redBg },
              ]}
            >
              <View style={[styles.optionIcon, { backgroundColor: C.redBg }]}>
                <Ionicons name="trash-outline" size={18} color={C.red} />
              </View>
              <Text style={[styles.optionText, { color: C.red }]}>
                Remove Student
              </Text>
              <Ionicons name="chevron-forward" size={16} color={C.red} />
            </Pressable>

            {/* Cancel */}
            <Pressable
              onPress={() => setOptionsModal(false)}
              style={({ pressed }) => [
                styles.cancelBtn,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ── Delete confirmation modal ───────────────────────────────────────── */}
      <Modal
        visible={deleteModal}
        animationType="slide"
        transparent
        onRequestClose={() => setDeleteModal(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable
            style={styles.backdrop}
            onPress={() => setDeleteModal(false)}
          />
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <View
              style={[
                styles.optionIcon,
                {
                  backgroundColor: C.redBg,
                  alignSelf: "center",
                  width: 52,
                  height: 52,
                  borderRadius: 16,
                  marginBottom: 4,
                },
              ]}
            >
              <Ionicons name="trash-outline" size={24} color={C.red} />
            </View>
            <Text style={[styles.sheetTitle, { textAlign: "center" }]}>
              Remove Student?
            </Text>
            <Text style={[styles.sheetHint, { textAlign: "center" }]}>
              This will permanently delete {student?.full_name} and all their
              session history. This cannot be undone.
            </Text>
            <View style={styles.sheetActions}>
              <Pressable
                onPress={() => setDeleteModal(false)}
                style={({ pressed }) => [
                  styles.sheetBtn,
                  styles.btnCancel,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={styles.btnCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={deleteStudent}
                disabled={saving}
                style={({ pressed }) => [
                  styles.sheetBtn,
                  styles.btnDelete,
                  pressed && { opacity: 0.85 },
                ]}
              >
                {saving ? (
                  <ActivityIndicator color={C.white} />
                ) : (
                  <Text style={styles.btnDeleteText}>Remove</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Edit name modal ─────────────────────────────────────────────────── */}
      <Modal
        visible={editModal}
        animationType="slide"
        transparent
        onRequestClose={() => setEditModal(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable
            style={styles.backdrop}
            onPress={() => setEditModal(false)}
          />
          <KeyboardAvoidingView style={styles.keyboardSheet} behavior="padding">
            <View style={styles.sheet}>
              <View style={styles.handle} />
              <Text style={styles.sheetTitle}>Edit Name</Text>
              <Text style={styles.sheetLabel}>Full name</Text>
              <TextInput
                style={styles.sheetInput}
                value={editName}
                onChangeText={setEditName}
                autoFocus
                autoCapitalize="words"
                returnKeyType="done"
                onSubmitEditing={saveEdit}
              />
              <View style={styles.sheetActions}>
                <Pressable
                  onPress={() => setEditModal(false)}
                  style={({ pressed }) => [
                    styles.sheetBtn,
                    styles.btnCancel,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={styles.btnCancelText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={saveEdit}
                  disabled={saving}
                  style={({ pressed }) => [
                    styles.sheetBtn,
                    styles.btnConfirm,
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  {saving ? (
                    <ActivityIndicator color="#1A1200" />
                  ) : (
                    <Text style={styles.btnConfirmText}>Save</Text>
                  )}
                </Pressable>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>

      {/* ── Pair device modal ───────────────────────────────────────────────── */}
      <Modal
        visible={pairModal}
        animationType="slide"
        transparent
        onRequestClose={() => setPairModal(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable
            style={styles.backdrop}
            onPress={() => setPairModal(false)}
          />
          <KeyboardAvoidingView style={styles.keyboardSheet} behavior="padding">
            <View style={styles.sheet}>
              <View style={styles.handle} />
              <Text style={styles.sheetTitle}>
                {device ? "Change Device" : "Pair Device"}
              </Text>
              <Text style={styles.sheetLabel}>Device code</Text>
              <TextInput
                style={[
                  styles.sheetInput,
                  { fontFamily: fonts.mono, letterSpacing: 1.5 },
                ]}
                value={deviceCode}
                onChangeText={(v) => {
                  setDeviceCode(v.toUpperCase());
                  setPairError(null);
                }}
                placeholder="e.g. DOTS-4F2A"
                placeholderTextColor={C.muted}
                autoFocus
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={pairDevice}
              />
              <Text style={styles.sheetHint}>
                Find this code in the firmware serial monitor or on the device
                label.
              </Text>
              {pairError && (
                <View style={styles.errorBox}>
                  <Text style={styles.errorBoxText}>{pairError}</Text>
                </View>
              )}
              <View style={styles.sheetActions}>
                <Pressable
                  onPress={() => setPairModal(false)}
                  style={({ pressed }) => [
                    styles.sheetBtn,
                    styles.btnCancel,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={styles.btnCancelText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={pairDevice}
                  disabled={saving}
                  style={({ pressed }) => [
                    styles.sheetBtn,
                    styles.btnConfirm,
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  {saving ? (
                    <ActivityIndicator color="#1A1200" />
                  ) : (
                    <Text style={styles.btnConfirmText}>Pair Device</Text>
                  )}
                </Pressable>
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  errorTxt: { fontFamily: fonts.body, fontSize: 14, color: C.red },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: C.white,
    borderBottomWidth: 1.5,
    borderBottomColor: C.border,
  },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 6 },
  backText: { fontFamily: fonts.heading, fontSize: 16, color: C.navy },
  optionsBtn: { padding: 4 },

  scroll: { padding: 20, paddingBottom: 40, gap: 16 },

  identity: { alignItems: "center", gap: 6, paddingVertical: 8 },
  avatarLarge: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: C.navy,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarLargeText: { fontFamily: fonts.heading, fontSize: 26, color: C.white },
  studentName: { fontFamily: fonts.heading, fontSize: 22, color: C.navy },
  studentSub: { fontFamily: fonts.body, fontSize: 13, color: C.muted },
  deviceChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: C.blueWash,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 100,
  },
  deviceChipText: { fontFamily: fonts.mono, fontSize: 11, color: C.navy },
  pairChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: C.brownBg,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 100,
  },
  pairChipText: { fontFamily: fonts.mono, fontSize: 11, color: C.brown },

  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: C.brown,
    letterSpacing: 1,
    marginTop: 4,
  },
  statsGrid: { flexDirection: "row", gap: 10 },
  statCard: {
    flex: 1,
    borderRadius: 14,
    padding: 14,
    alignItems: "center",
    gap: 4,
  },
  statValue: { fontFamily: fonts.heading, fontSize: 24, lineHeight: 28 },
  statLabel: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: C.ink,
    textAlign: "center",
  },

  empty: {
    alignItems: "center",
    padding: 32,
    gap: 10,
    backgroundColor: C.white,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: C.border,
  },
  emptyTitle: { fontFamily: fonts.heading, fontSize: 16, color: C.navy },
  emptyBody: {
    fontFamily: fonts.body,
    fontSize: 13.5,
    color: C.ink,
    textAlign: "center",
    lineHeight: 20,
  },

  attemptList: { gap: 10 },
  attemptRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: C.white,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1.5,
    borderColor: C.border,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  attemptWord: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: C.navy,
    letterSpacing: 1,
  },
  attemptDate: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: C.muted,
    marginTop: 2,
  },
  attemptTime: { fontFamily: fonts.mono, fontSize: 12, color: C.muted },
  resultBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 100 },
  resultBadgeText: { fontFamily: fonts.mono, fontSize: 10 },

  modalOverlay: { flex: 1, justifyContent: "flex-end" },
  keyboardSheet: { flex: 1, justifyContent: "flex-end" },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  sheet: {
    backgroundColor: C.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 44,
    gap: 10,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: C.border,
    alignSelf: "center",
    marginBottom: 4,
  },
  sheetTitle: { fontFamily: fonts.heading, fontSize: 20, color: C.navy },
  sheetLabel: {
    fontFamily: fonts.heading,
    fontSize: 14,
    color: C.navy,
    marginTop: 4,
  },
  sheetHint: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: C.muted,
    lineHeight: 18,
  },
  sheetInput: {
    fontFamily: fonts.body,
    fontSize: 16,
    color: C.ink,
    backgroundColor: C.bg,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  sheetActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  sheetBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  btnCancel: { backgroundColor: C.bg, borderWidth: 1.5, borderColor: C.border },
  btnConfirm: { backgroundColor: C.amber },
  btnDelete: { backgroundColor: C.red },
  btnCancelText: { fontFamily: fonts.heading, fontSize: 15, color: C.navy },
  btnConfirmText: { fontFamily: fonts.heading, fontSize: 15, color: "#1A1200" },
  btnDeleteText: { fontFamily: fonts.heading, fontSize: 15, color: C.white },
  errorBox: {
    backgroundColor: C.redBg,
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: C.red,
  },
  errorBoxText: { fontFamily: fonts.body, fontSize: 13, color: C.red },

  // Options sheet
  optionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderRadius: 12,
  },
  optionIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  optionText: {
    flex: 1,
    fontFamily: fonts.heading,
    fontSize: 16,
    color: C.navy,
  },
  cancelBtn: {
    marginTop: 4,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    backgroundColor: C.bg,
    borderWidth: 1.5,
    borderColor: C.border,
  },
  cancelBtnText: { fontFamily: fonts.heading, fontSize: 15, color: C.navy },
});
