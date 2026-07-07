// mobile/app/(teacher)/sessions/[id].tsx
// Session detail — setup, active, paused, and finished views.
// Realtime device broadcasting via device_commands table.

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Animated,
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  Modal,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Alert,
  AppState,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../lib/supabase";
import { colors as C, fonts } from "../../../lib/theme";
import { BrailleCell } from "../../../components/BrailleCell";
import { BrailleLoader } from "../../../components/BrailleLoader";
import { Toast } from "../../../components/Toast";
import { wordToChunks, getPattern, isValidWord } from "../../../lib/braille";
import AsyncStorage from "@react-native-async-storage/async-storage";


// ── Types ─────────────────────────────────────────────────────────────────────

type Session = {
  id: string;
  name: string;
  purpose: string | null;
  type: "manual" | "word_list";
  status: string;
  started_at: string | null;
  finished_at: string | null;
};
type Device = { id: string; device_code: string; status: string } | null;
type Student = { id: string; full_name: string; device: Device };
type SessionWord = { id: string; word: string; order_index: number };
type WordBankItem = { id: string; word: string; category: string };
type WordAttempt = {
  id: string;
  word: string;
  is_correct: boolean;
  response_time_ms: number | null;
  attempted_at: string;
};
type StudentSessionStats = { student: Student; attempts: WordAttempt[] };

// ── Helpers ───────────────────────────────────────────────────────────────────

const getInitials = (n: string) =>
  n
    .trim()
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

const DEVICE_COLOR: Record<string, string> = {
  connected: C.green,
  pending: C.navy,
  offline: C.red,
};

// ── Five-cell display ─────────────────────────────────────────────────────────

function FiveCellDisplay({ chunk }: { chunk: string }) {
  return (
    <View style={styles.fiveCells}>
      {Array.from({ length: 5 }, (_, i) => {
        const letter = chunk[i] ?? "";
        return (
          <View key={i} style={styles.cellSlot}>
            <View style={[styles.cellBox, !letter && styles.cellBoxEmpty]}>
              <BrailleCell
                pattern={letter ? getPattern(letter) : []}
                size={14}
                color={letter ? C.navy : C.muted}
                emptyColor={letter ? "rgba(12,68,124,0.15)" : C.border}
              />
            </View>
            <Text style={[styles.cellLetter, !letter && { color: C.border }]}>
              {letter || "·"}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function SessionDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  // ── Core data ───────────────────────────────────────────────────────────────
  const [session, setSession] = useState<Session | null>(null);
  const [allStudents, setAllStudents] = useState<Student[]>([]);
  const [assignedIds, setAssignedIds] = useState<Set<string>>(new Set());
  const [sessionWords, setSessionWords] = useState<SessionWord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);

  // ── Word list builder ───────────────────────────────────────────────────────
  // (add-word logic lives in add-word.tsx; reloaded via useFocusEffect)

  // ── Active session ──────────────────────────────────────────────────────────
  const [manualWord, setManualWord] = useState("");
  const [chunks, setChunks] = useState<string[]>([]);
  const [chunkIndex, setChunkIndex] = useState(0);
  const [wordListIndex, setWordListIndex] = useState(0);
  const [wordSent, setWordSent] = useState(false);

  // The most recently *sent* word — used on the Paused card for context recovery.
  // Set in doSendWord() and restored from AsyncStorage in restoreWordPosition().
  // Distinct from manualWord (text input value) and wordListIndex (list position).
  const [lastSentWord, setLastSentWord] = useState("");

  // Tracks which words have been broadcast this session run (for dup detection)
  const sentWords = useRef<Set<string>>(new Set()).current;

  // Duplicate word modal
  const [dupWordModal, setDupWordModal] = useState(false);
  const [dupWord, setDupWord] = useState("");

  // ── Live attempt feed ───────────────────────────────────────────────────────
  const [liveAttempts, setLiveAttempts] = useState<WordAttempt[]>([]);

  // ── Pulse animation for the Live dot ────────────────────────────────────────
  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.3, duration: 800, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1,   duration: 800, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulseAnim]);

  // ── Session stats modal (finished view) ────────────────────────────────────
  const [statsModal, setStatsModal] = useState(false);
  const [statsData, setStatsData] = useState<StudentSessionStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);

  // ── Auto-pause: app background + navigation away ────────────────────────────
  // sessionStatusRef mirrors session.status without stale-closure issues so
  // useFocusEffect / AppState cleanup callbacks always read the latest value.
  const appStateRef      = useRef(AppState.currentState);
  const sessionStatusRef = useRef<string | null>(null);
  useEffect(() => {
    sessionStatusRef.current = session?.status ?? null;
  }, [session?.status]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", async (next) => {
      if (
        (next === "background" || next === "inactive") &&
        appStateRef.current === "active" &&
        sessionStatusRef.current === "in_progress"
      ) {
        // Direct DB update + local state (ref-safe, no stale closure)
        await supabase.from("sessions").update({ status: "paused" }).eq("id", id!);
        setSession((prev) => (prev ? { ...prev, status: "paused" } : prev));
      }
      appStateRef.current = next;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ── Finish session modal ────────────────────────────────────────────────────
  const [finishSessionModal, setFinishSessionModal] = useState(false);
  const [finishingSession, setFinishingSession] = useState(false);
  const [finishToast, setFinishToast] = useState<{ name: string } | null>(null);

  // ── Delete session modal ────────────────────────────────────────────────────
  const [deleteSessionModal, setDeleteSessionModal] = useState(false);
  const [deletingSession, setDeletingSession] = useState(false);
  const [deleteCountdown, setDeleteCountdown] = useState(5);

  // Tick down from 5 whenever the delete modal is open
  useEffect(() => {
    if (!deleteSessionModal) return;
    if (deleteCountdown <= 0) return;
    const t = setTimeout(() => setDeleteCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [deleteSessionModal, deleteCountdown]);

  // ── Word delete confirmation ────────────────────────────────────────────────
  const [deleteWordModal, setDeleteWordModal] = useState(false);
  const [wordToRemove, setWordToRemove] = useState<SessionWord | null>(null);




  // ── Load data ───────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    if (!id) return;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const [sessionRes, studentsRes, devicesRes, assignedRes, wordsRes] =
      await Promise.all([
        supabase.from("sessions").select("*").eq("id", id).single(),
        supabase
          .from("students")
          .select("id, full_name")
          .eq("teacher_id", user.id)
          .order("full_name"),
        supabase
          .from("devices")
          .select("id, device_code, status, paired_student_id"),
        supabase
          .from("session_students")
          .select("student_id")
          .eq("session_id", id),
        supabase
          .from("session_words")
          .select("id, word, order_index")
          .eq("session_id", id)
          .order("order_index"),
      ]);

    const devicesData = devicesRes.data ?? [];
    const merged: Student[] = (studentsRes.data ?? []).map((s) => ({
      ...s,
      device: devicesData.find((d) => d.paired_student_id === s.id) ?? null,
    }));

    const fetchedSession = sessionRes.data;
    const fetchedWords: SessionWord[] = wordsRes.data ?? [];

    setSession(fetchedSession);
    setAllStudents(merged);
    setAssignedIds(new Set((assignedRes.data ?? []).map((r) => r.student_id)));
    setSessionWords(fetchedWords);
    setLoading(false);
    setRefreshing(false);

    // Restore last-broadcast word whenever the session is active or just resumed
    if (
      (fetchedSession?.status === "in_progress" ||
        fetchedSession?.status === "paused") &&
      fetchedWords.length > 0
    ) {
      await restoreWordPosition(id, fetchedWords);
    }
  }, [id]);

  // ── Restore last-sent word from AsyncStorage ────────────────────────────────
  // Reads the per-session key saved on every broadcastChunk (or sendWord when
  // no devices are connected) so the teacher UI always reflects the last word,
  // regardless of device connectivity or app restart.
  async function restoreWordPosition(sessionId: string, words: SessionWord[]) {
    try {
      const raw = await AsyncStorage.getItem(`session_word_pos_${sessionId}`);

      // Pre-populate sentWords from DB records (manual sessions track history)
      words.forEach((sw) => sentWords.add(sw.word));

      if (!raw) return;

      const pos = JSON.parse(raw) as {
        word: string;
        chunkIndex: number;
      };

      // Snap wordListIndex for word_list sessions
      const idx = words.findIndex((sw) => sw.word === pos.word);
      if (idx !== -1) setWordListIndex(idx);

      // Restore braille display state
      const restoredChunks = wordToChunks(pos.word);
      setChunks(restoredChunks);
      setChunkIndex(pos.chunkIndex ?? 0);
      setWordSent(true);

      // Restore manual word input
      setManualWord(pos.word);

      // Fix 3: restore lastSentWord so the Paused card always shows the correct
      // word regardless of session type (manual or word_list).
      setLastSentWord(pos.word);
    } catch {
      // Silently ignore storage errors
    }
  }

  // ── Persist word position to AsyncStorage ─────────────────────────────────
  async function saveWordPosition(sessionId: string, word: string, chunkIndex: number) {
    try {
      await AsyncStorage.setItem(
        `session_word_pos_${sessionId}`,
        JSON.stringify({ word, chunkIndex }),
      );
    } catch {
      // Silently ignore storage errors
    }
  }

  useEffect(() => {
    loadData();
  }, [loadData]);

  // On focus: reload data. On blur (navigate away): auto-pause if in_progress.
  // The cleanup return fires for every navigation-away event (back, tab switch,
  // dashboard tap, etc.) — this is the primary pause trigger.
  useFocusEffect(
    useCallback(() => {
      loadData();
      return () => {
        if (sessionStatusRef.current === "in_progress") {
          // Fire-and-forget — no await in cleanup
          supabase.from("sessions").update({ status: "paused" }).eq("id", id!);
        }
      };
    }, [loadData, id])
  );

  // ── Realtime subscriptions ──────────────────────────────────────────────────
  useEffect(() => {
    if (!id) return;

    const channel = supabase
      .channel(`session-detail-${id}`)
      // Session row changes (status, started_at, finished_at)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "sessions", filter: `id=eq.${id}` },
        (payload) => {
          setSession((prev) => prev ? { ...prev, ...(payload.new as Session) } : prev);
        }
      )
      // Device connection-status changes (shows live dot colour changes)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "devices" },
        (payload) => {
          const updated = payload.new as { id: string; status: string };
          setAllStudents((prev) =>
            prev.map((s) =>
              s.device?.id === updated.id
                ? { ...s, device: { ...s.device!, status: updated.status } }
                : s
            )
          );
        }
      )
      // New word attempts (student responses appear live during a session)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "word_attempts", filter: `session_id=eq.${id}` },
        (payload) => {
          const attempt = payload.new as WordAttempt;
          setLiveAttempts((prev) => [attempt, ...prev]);
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [id]);


  // ── Student assignment ──────────────────────────────────────────────────────

  async function toggleStudent(studentId: string) {
    if (session?.status !== "pending") return;
    const isAssigned = assignedIds.has(studentId);
    if (isAssigned) {
      await supabase
        .from("session_students")
        .delete()
        .eq("session_id", id!)
        .eq("student_id", studentId);
      setAssignedIds((prev) => {
        const s = new Set(prev);
        s.delete(studentId);
        return s;
      });
    } else {
      await supabase
        .from("session_students")
        .insert({ session_id: id, student_id: studentId });
      setAssignedIds((prev) => new Set(prev).add(studentId));
    }
  }

  async function removeWord(wordId: string) {
    await supabase.from("session_words").delete().eq("id", wordId);
    setSessionWords((prev) => prev.filter((w) => w.id !== wordId));
  }

  function deleteSession() {
    setDeleteCountdown(5); // reset countdown each time modal opens
    setDeleteSessionModal(true);
  }

  async function executeDeleteSession() {
    if (deleteCountdown > 0) return; // safety guard
    setDeletingSession(true);
    const sessionName = session?.name ?? "Session";
    await supabase.from("sessions").delete().eq("id", id!);
    setDeletingSession(false);
    setDeleteSessionModal(false);
    router.replace({
      pathname: "/(teacher)/sessions" as any,
      params: { deletedName: sessionName },
    });
  }

  function openAddWord() {
    router.push({
      pathname: "/(teacher)/sessions/add-word" as any,
      params: { sessionId: id },
    });
  }

  // ── Session lifecycle ───────────────────────────────────────────────────────

  async function launchSession() {
    if (assignedIds.size === 0) {
      Alert.alert(
        "No students",
        "Assign at least one student before launching.",
      );
      return;
    }
    if (session?.type === "word_list" && sessionWords.length === 0) {
      Alert.alert(
        "No words",
        "Add at least one word to the list before launching.",
      );
      return;
    }
    setSaving(true);
    await supabase
      .from("sessions")
      .update({ status: "in_progress", started_at: new Date().toISOString() })
      .eq("id", id!);
    await loadData();
    setSaving(false);
  }

  async function pauseSession(auto = false) {
    // Fix 5: eagerly update the ref so the useFocusEffect cleanup callback
    // (which fires on immediate navigation after a manual pause) reads the
    // correct status and does not double-fire the DB update.
    sessionStatusRef.current = "paused";
    await supabase.from("sessions").update({ status: "paused" }).eq("id", id!);
    // [REALTIME] Send pause command to all devices
    if (!auto) await loadData();
    else setSession((prev) => (prev ? { ...prev, status: "paused" } : prev));
  }

  async function resumeSession() {
    // Fix 6: eagerly update the ref so that any race between resume and
    // immediate navigation is handled correctly (the cleanup will see
    // in_progress and will re-pause, which is the desired behaviour).
    sessionStatusRef.current = "in_progress";
    await supabase
      .from("sessions")
      .update({ status: "in_progress" })
      .eq("id", id!);
    await loadData();
    // Position is already restored inside loadData via restoreWordPosition
  }

  function confirmFinish() {
    setFinishSessionModal(true);
  }

  async function executeFinishSession() {
    setFinishingSession(true);
    const sessionName = session?.name ?? "Session";
    await supabase
      .from("sessions")
      .update({
        status: "finished",
        finished_at: new Date().toISOString(),
      })
      .eq("id", id!);
    await loadData();
    setFinishingSession(false);
    setFinishSessionModal(false);
    setFinishToast({ name: sessionName });
  }

  // ── Send word to devices ────────────────────────────────────────────────────

  async function sendWord(word: string) {
    const w = word.trim().toUpperCase();
    if (!w || !isValidWord(w)) {
      Alert.alert("Invalid word", "Only letters A–Z are supported.");
      return;
    }
    // Duplicate check — show confirm modal instead of silently re-sending
    if (sentWords.has(w)) {
      setDupWord(w);
      setDupWordModal(true);
      return;
    }
    await doSendWord(w);
  }

  // Internal: broadcasts the word; also called on "Re-send Anyway"
  async function doSendWord(w: string) {
    // Record history for manual sessions
    if (session?.type === "manual" && !sessionWords.find((sw) => sw.word === w)) {
      const { data: wordData } = await supabase
        .from("session_words")
        .insert({ session_id: id, word: w, order_index: sessionWords.length })
        .select("id, word, order_index")
        .single();
      if (wordData) setSessionWords((prev) => [...prev, wordData]);
    }
    sentWords.add(w);
    // Fix 2: track the last *actually sent* word so the Paused card always
    // displays accurate context, independent of list position or input state.
    setLastSentWord(w);
    const newChunks = wordToChunks(w);
    setChunks(newChunks);
    setChunkIndex(0);
    setWordSent(true);
    await saveWordPosition(id!, w, 0);
    await broadcastChunk(newChunks, 0, w);
  }

  async function goToChunk(newIdx: number) {
    if (newIdx < 0 || newIdx >= chunks.length) return;
    setChunkIndex(newIdx);
    const word =
      session?.type === "manual"
        ? manualWord
        : (sessionWords[wordListIndex]?.word ?? "");
    // Persist chunk position so resume always shows the exact chunk
    await saveWordPosition(id!, word, newIdx);
    await broadcastChunk(chunks, newIdx, word);
  }

  async function broadcastChunk(chunkArr: string[], idx: number, word: string) {
    const connectedDevices = allStudents
      .filter((s) => assignedIds.has(s.id) && s.device?.status === "connected")
      .map((s) => s.device!.id);

    if (connectedDevices.length === 0) return; // no connected devices, UI still shows

    // [REALTIME] ESP32 listens to device_commands via Supabase Realtime
    const commands = connectedDevices.map((device_id) => ({
      device_id,
      session_id: id,
      command_type: "display_chunk" as const,
      payload: {
        word,
        chunk: chunkArr[idx],
        chunk_index: idx,
        total_chunks: chunkArr.length,
      },
    }));
    await supabase.from("device_commands").insert(commands);
  }

  // ── Render helpers ──────────────────────────────────────────────────────────

  async function openStudentStats(student: Student) {
    setStatsData(null);
    setLoadingStats(true);
    setStatsModal(true);
    const { data } = await supabase
      .from("word_attempts")
      .select("id, word, is_correct, response_time_ms, attempted_at")
      .eq("student_id", student.id)
      .eq("session_id", id!)
      .order("attempted_at", { ascending: true });
    setStatsData({ student, attempts: data ?? [] });
    setLoadingStats(false);
  }

  const assignedStudents = allStudents.filter((s) => assignedIds.has(s.id));

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.center}>
          <BrailleLoader size={16} />
        </View>
      </SafeAreaView>
    );
  }
  if (!session) return null;

  const filteredBank = [] as WordBankItem[]; // word bank is now on add-word screen

  // ── DUPLICATE WORD MODAL ────────────────────────────────────────────────────
  const DupWordModal = (
    <Modal
      visible={dupWordModal}
      animationType="slide"
      transparent
      onRequestClose={() => setDupWordModal(false)}
    >
      <View style={styles.modalOverlay}>
        <Pressable style={styles.backdrop} onPress={() => setDupWordModal(false)} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          {/* Word pill preview */}
          <View style={styles.dupWordPreview}>
            <Ionicons name="repeat-outline" size={22} color={C.brown} />
            <Text style={styles.dupWordPreviewText}>{dupWord}</Text>
          </View>
          <Text style={styles.deleteTitle}>Already sent this session</Text>
          <Text style={styles.deleteSub}>
            {"You already sent "}{dupWord ? `"${dupWord}"` : "this word"}{" to devices earlier. Would you like to re-send it?"}
          </Text>
          <View style={styles.sheetActions}>
            <Pressable
              onPress={() => setDupWordModal(false)}
              style={({ pressed }) => [
                styles.sheetBtn,
                styles.btnNotYet,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text style={styles.btnNotYetText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={async () => {
                setDupWordModal(false);
                sentWords.delete(dupWord); // allow re-send
                await doSendWord(dupWord);
              }}
              style={({ pressed }) => [
                styles.sheetBtn,
                styles.btnConfirm,
                pressed && { opacity: 0.85 },
              ]}
            >
              <Text style={styles.btnConfirmText}>Re-send Anyway</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );

  // ── FINISH SESSION MODAL ────────────────────────────────────────────────────
  const FinishSessionModal = (
    <Modal
      visible={finishSessionModal}
      animationType="slide"
      transparent
      onRequestClose={() => setFinishSessionModal(false)}
    >
      <View style={styles.modalOverlay}>
        <Pressable
          style={styles.backdrop}
          onPress={() => setFinishSessionModal(false)}
        />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.finishPreview}>
            <Ionicons name="flag-outline" size={28} color={C.green} />
            <Text style={styles.finishPreviewText}>{session?.name}</Text>
          </View>
          <Text style={styles.deleteTitle}>Finish this session?</Text>
          <Text style={styles.deleteSub}>
            {"Mark this session as finished. Students will no longer be able to respond. This cannot be undone."}
          </Text>
          <View style={styles.sheetActions}>
            <Pressable
              onPress={() => setFinishSessionModal(false)}
              style={({ pressed }) => [
                styles.sheetBtn,
                styles.btnNotYet,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text style={styles.btnNotYetText}>Not Yet</Text>
            </Pressable>
            <Pressable
              onPress={executeFinishSession}
              disabled={finishingSession}
              style={({ pressed }) => [
                styles.sheetBtn,
                styles.btnFinishConfirm,
                finishingSession && { opacity: 0.6 },
                pressed && !finishingSession && { opacity: 0.85 },
              ]}
            >
              {finishingSession ? (
                <ActivityIndicator color={C.white} />
              ) : (
                <Text style={styles.btnFinishConfirmText}>Finish Session</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );

  // ── DELETE SESSION MODAL (shared across all status views) ───────────────────
  const DeleteSessionModal = (
    <Modal
      visible={deleteSessionModal}
      animationType="slide"
      transparent
      onRequestClose={() => setDeleteSessionModal(false)}
    >
      <View style={styles.modalOverlay}>
        <Pressable
          style={styles.backdrop}
          onPress={() => setDeleteSessionModal(false)}
        />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.deletePreview}>
            <Ionicons name="warning-outline" size={28} color={C.red} />
            <Text style={styles.deletePreviewText}>{session?.name}</Text>
          </View>
          <Text style={styles.deleteTitle}>Delete this session?</Text>
          <Text style={styles.deleteSub}>
            {"This permanently removes the session and all its associated data. This cannot be undone."
            }
          </Text>
          {deleteCountdown > 0 && (
            <View style={styles.countdownRow}>
              <Ionicons name="time-outline" size={14} color={C.muted} />
              <Text style={styles.countdownText}>
                Are you sure? You can delete in{" "}
                <Text style={styles.countdownNumber}>{deleteCountdown}s</Text>
              </Text>
            </View>
          )}
          <View style={styles.sheetActions}>
            <Pressable
              onPress={executeDeleteSession}
              disabled={deletingSession || deleteCountdown > 0}
              style={({ pressed }) => [
                styles.sheetBtn,
                styles.btnDestructive,
                (deleteCountdown > 0 || deletingSession) && styles.btnDestructiveDisabled,
                pressed && deleteCountdown === 0 && { opacity: 0.85 },
              ]}
            >
              {deletingSession ? (
                <ActivityIndicator color={C.red} />
              ) : (
                <Text style={styles.btnDestructiveText}>
                  {deleteCountdown > 0 ? `Delete (${deleteCountdown})` : "Delete"}
                </Text>
              )}
            </Pressable>
            <Pressable
              onPress={() => setDeleteSessionModal(false)}
              style={({ pressed }) => [
                styles.sheetBtn,
                styles.btnKeep,
                pressed && { opacity: 0.85 },
              ]}
            >
              <Text style={styles.btnKeepText}>Keep It</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );

  // ── SHARED HEADER ───────────────────────────────────────────────────────────

  const Header = (
    <View style={styles.header}>
      <Pressable
        onPress={() => router.back()}
        style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
      >
        <Ionicons name="arrow-back" size={20} color={C.navy} />
        <Text style={styles.backText}>Sessions</Text>
      </Pressable>
      <View style={styles.headerRight}>
        {session.status === "in_progress" && (
          <>
            <Pressable
              onPress={() => pauseSession(false)}
              style={({ pressed }) => [
                styles.pauseBtn,
                pressed && { opacity: 0.8 },
              ]}
            >
              <Ionicons name="pause" size={14} color={C.brown} />
              <Text style={styles.pauseBtnText}>Pause</Text>
            </Pressable>
            <Pressable
              onPress={confirmFinish}
              style={({ pressed }) => [
                styles.finishBtn,
                pressed && { opacity: 0.8 },
              ]}
            >
              <Text style={styles.finishBtnText}>Finish</Text>
            </Pressable>
          </>
        )}
        {session.status !== "in_progress" && (
          <Pressable
            onPress={deleteSession}
            hitSlop={10}
            style={({ pressed }) => [
              styles.deleteBtn,
              pressed && { opacity: 0.6 },
            ]}
            accessibilityLabel="Delete session"
          >
            <Ionicons name="trash-outline" size={18} color={C.red} />
          </Pressable>
        )}
      </View>
    </View>
  );

  // ══════════════════════════════════════════════════════════════════════════
  // PENDING VIEW — setup, assign students, build word list
  // ══════════════════════════════════════════════════════════════════════════

  if (session.status === "pending")
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        {Header}
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
          {/* Session info */}
          <View style={styles.infoCard}>
            <Text style={styles.sessionName}>{session.name}</Text>
            {session.purpose && (
              <Text style={styles.sessionPurpose}>{session.purpose}</Text>
            )}
            <View style={styles.infoRow}>
              <View style={[styles.badge, { backgroundColor: C.blueWash }]}>
                <Text style={[styles.badgeText, { color: C.navy }]}>
                  {session.type === "word_list" ? "Word List" : "Manual"}
                </Text>
              </View>
              <View style={[styles.badge, { backgroundColor: C.border }]}>
                <Text style={[styles.badgeText, { color: C.muted }]}>
                  Pending
                </Text>
              </View>
            </View>
          </View>

          {/* Assign students */}
          <Text style={styles.sectionLabel}>ASSIGN STUDENTS</Text>
          <Text style={styles.sectionHint}>
            Only students with connected devices can receive words.
          </Text>
          {allStudents.length === 0 ? (
            <Text style={styles.emptyHint}>
              No students yet — add them in the Students tab first.
            </Text>
          ) : (
            <View style={styles.studentGrid}>
              {allStudents.map((s) => {
                const assigned = assignedIds.has(s.id);
                const statusColor = s.device
                  ? (DEVICE_COLOR[s.device.status] ?? C.muted)
                  : C.muted;
                return (
                  <Pressable
                    key={s.id}
                    onPress={() => toggleStudent(s.id)}
                    style={({ pressed }) => [
                      styles.studentChip,
                      assigned && styles.studentChipActive,
                      pressed && { opacity: 0.8 },
                    ]}
                  >
                    {assigned && (
                      <Ionicons
                        name="checkmark-circle"
                        size={14}
                        color={C.white}
                      />
                    )}
                    <Text
                      style={[
                        styles.studentChipText,
                        assigned && { color: C.white },
                      ]}
                    >
                      {s.full_name}
                    </Text>
                    <View
                      style={[
                        styles.statusDot,
                        { backgroundColor: statusColor },
                      ]}
                    />
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* Word list builder (word_list type only) */}
          {session.type === "word_list" && (
            <>
              <Text style={styles.sectionLabel}>WORD LIST</Text>
              <Text style={styles.sectionHint}>
                Words will be sent to devices in this order.
              </Text>

              {sessionWords.length > 0 && (
                <View style={styles.wordListContainer}>
                  {sessionWords.map((sw, i) => (
                    <View key={sw.id} style={styles.wordRow}>
                      <Text style={styles.wordIndex}>
                        {String(i + 1).padStart(2, "0")}
                      </Text>
                      <Text style={styles.wordText}>{sw.word}</Text>
                      <Pressable
                        onPress={() => {
                          setWordToRemove(sw);
                          setDeleteWordModal(true);
                        }}
                        hitSlop={8}
                        style={({ pressed }) => [
                          { opacity: pressed ? 0.5 : 1 },
                        ]}
                      >
                        <Ionicons
                          name="trash-outline"
                          size={16}
                          color={C.red}
                        />
                      </Pressable>
                    </View>
                  ))}
                </View>
              )}

              <View style={styles.wordListActions}>
                <Pressable
                  onPress={openAddWord}
                  style={({ pressed }) => [
                    styles.addWordBtn,
                    { flex: 1 },
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  <Ionicons name="add" size={16} color={C.navy} />
                  <Text style={styles.addWordBtnText}>Add Word</Text>
                </Pressable>
                {sessionWords.length > 1 && (
                  <Pressable
                    onPress={openAddWord}
                    style={({ pressed }) => [
                      styles.reorderBtn,
                      pressed && { opacity: 0.85 },
                    ]}
                  >
                    <Ionicons name="menu" size={16} color={C.navy} />
                    <Text style={styles.reorderBtnText}>Reorder</Text>
                  </Pressable>
                )}
              </View>
            </>
          )}


          {/* Launch button */}
          <Pressable
            onPress={launchSession}
            disabled={saving || assignedIds.size === 0}
            style={({ pressed }) => [
              styles.launchBtn,
              (saving || assignedIds.size === 0) && { opacity: 0.5 },
              pressed && { opacity: 0.85 },
            ]}
          >
            {saving ? (
              <ActivityIndicator color="#1A1200" />
            ) : (
              <>
                <Ionicons name="play" size={18} color="#1A1200" />
                <Text style={styles.launchBtnText}>Launch Session</Text>
              </>
            )}
          </Pressable>
        </ScrollView>

        {/* ── Delete session modal ───────────────────────────────────────────── */}
        {DeleteSessionModal}

        {/* ── Finish toast ─────────────────────────────────────────────────────── */}
        <Toast
          message="Session finished"
          detail={finishToast?.name}
          visible={!!finishToast}
          variant="success"
          onDismiss={() => setFinishToast(null)}
        />

        {/* ── Word delete confirmation modal ─────────────────────────────────── */}
        <Modal
          visible={deleteWordModal}
          animationType="slide"
          transparent
          onRequestClose={() => setDeleteWordModal(false)}
        >
          <View style={styles.modalOverlay}>
            <Pressable
              style={styles.backdrop}
              onPress={() => setDeleteWordModal(false)}
            />
            <View style={styles.sheet}>
              <View style={styles.handle} />
              <View style={styles.deletePreview}>
                <Text
                  style={[
                    styles.deletePreviewText,
                    { fontFamily: fonts.mono, letterSpacing: 3 },
                  ]}
                >
                  {wordToRemove?.word}
                </Text>
              </View>
              <Text style={styles.deleteTitle}>Remove from word list?</Text>
              <Text style={styles.deleteSub}>
                This word will be removed from this session only. Your word bank
                is not affected.
              </Text>
              <View style={styles.sheetActions}>
                <Pressable
                  onPress={() => setDeleteWordModal(false)}
                  style={({ pressed }) => [
                    styles.sheetBtn,
                    styles.btnCancel,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={styles.btnCancelText}>Keep It</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    if (wordToRemove) removeWord(wordToRemove.id);
                    setDeleteWordModal(false);
                    setWordToRemove(null);
                  }}
                  style={({ pressed }) => [
                    styles.sheetBtn,
                    styles.btnDestructive,
                    pressed && { opacity: 0.8 },
                  ]}
                >
                  <Text style={styles.btnDestructiveText}>Remove</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

      </SafeAreaView>
    );

  // ══════════════════════════════════════════════════════════════════════════
  // PAUSED VIEW
  // ══════════════════════════════════════════════════════════════════════════

  if (session.status === "paused")
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        {Header}
        <View style={styles.centeredView}>
          <View style={styles.pausedCard}>
            <Ionicons name="pause-circle" size={52} color={C.amber} />
            <Text style={styles.pausedTitle}>Session Paused</Text>
            <Text style={styles.pausedSub}>{session.name}</Text>

            {/* Last word context — Fix 4: use lastSentWord (set in doSendWord
                and restored in restoreWordPosition) instead of the fragile
                manualWord/sessionWords fallback that could show the last word
                in the list rather than the last *sent* word. */}
            <View style={styles.pausedLastWord}>
              <Text style={styles.pausedLastWordLabel}>Last word sent</Text>
              <Text style={styles.pausedLastWordValue}>
                {lastSentWord || "—"}
              </Text>
            </View>

            <View style={styles.pausedActions}>
              <Pressable
                onPress={resumeSession}
                style={({ pressed }) => [
                  styles.resumeBtn,
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Ionicons name="play" size={16} color="#1A1200" />
                <Text style={styles.resumeBtnText}>Resume</Text>
              </Pressable>
              <Pressable
                onPress={confirmFinish}
                style={({ pressed }) => [
                  styles.finishPausedBtn,
                  pressed && { opacity: 0.8 },
                ]}
              >
                <Text style={styles.finishPausedBtnText}>Finish Session</Text>
              </Pressable>
            </View>
          </View>
        </View>
        {DeleteSessionModal}
        {DupWordModal}
        {FinishSessionModal}
        <Toast
          message="Session finished"
          detail={finishToast?.name}
          visible={!!finishToast}
          variant="success"
          onDismiss={() => setFinishToast(null)}
        />
      </SafeAreaView>
    );

  // ══════════════════════════════════════════════════════════════════════════
  // FINISHED VIEW
  // ══════════════════════════════════════════════════════════════════════════

  if (session.status === "finished")
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        {Header}
        {DeleteSessionModal}
        <Toast
          message="Session finished"
          detail={finishToast?.name}
          visible={!!finishToast}
          variant="success"
          onDismiss={() => setFinishToast(null)}
        />
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.infoCard}>
            <Text style={styles.sessionName}>{session.name}</Text>
            {session.purpose && (
              <Text style={styles.sessionPurpose}>{session.purpose}</Text>
            )}
            <View
              style={[
                styles.badge,
                { backgroundColor: C.blueWash, alignSelf: "flex-start" },
              ]}
            >
              <Text style={[styles.badgeText, { color: C.navy }]}>
                Finished
              </Text>
            </View>
          </View>

          {/* ── Words sent during session ──────────────────────── */}
          <Text style={styles.sectionLabel}>WORDS SENT</Text>
          {sessionWords.length === 0 ? (
            <View style={[styles.infoCard, { alignItems: "center", paddingVertical: 20 }]}>
              <Ionicons name="text-outline" size={28} color={C.muted} />
              <Text style={[styles.emptyHint, { marginTop: 6 }]}>
                No words were sent in this session.
              </Text>
            </View>
          ) : (
            <View style={styles.wordListContainer}>
              {sessionWords.map((sw, i) => (
                <View
                  key={sw.id}
                  style={[
                    styles.wordRow,
                    i < sessionWords.length - 1 && {
                      borderBottomWidth: 1,
                      borderBottomColor: C.border,
                    },
                  ]}
                >
                  <Text style={styles.wordIndex}>
                    {String(i + 1).padStart(2, "0")}
                  </Text>
                  <Text style={[styles.wordText, { letterSpacing: 2 }]}>
                    {sw.word}
                  </Text>
                  {/* Show if any student answered this word */}
                </View>
              ))}
            </View>
          )}

          <Text style={styles.sectionLabel}>PARTICIPANTS</Text>
          <View style={{ gap: 10 }}>
            {assignedStudents.map((s) => (
              <Pressable
                key={s.id}
                onPress={() => openStudentStats(s)}
                style={({ pressed }) => [
                  styles.finishedStudentRow,
                  pressed && { opacity: 0.85 },
                ]}
              >
                <View style={styles.avatarSmall}>
                  <Text style={styles.avatarSmallText}>
                    {getInitials(s.full_name)}
                  </Text>
                </View>
                <Text style={styles.finishedStudentName}>{s.full_name}</Text>
                <View style={styles.viewStatsChip}>
                  <Text style={styles.viewStatsText}>View Stats</Text>
                  <Ionicons name="chevron-forward" size={12} color={C.navy} />
                </View>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <Modal
          visible={statsModal}
          animationType="slide"
          transparent
          onRequestClose={() => setStatsModal(false)}
        >
          <View style={styles.modalOverlay}>
            <Pressable
              style={styles.backdrop}
              onPress={() => setStatsModal(false)}
            />
            <View style={[styles.sheet, { maxHeight: "90%" }]}>
              <View style={styles.handle} />
              {loadingStats || !statsData ? (
                <View style={{ alignItems: "center", paddingVertical: 32 }}>
                  <ActivityIndicator size="large" color={C.navy} />
                </View>
              ) : (
                <FlatList
                  data={sessionWords}
                  keyExtractor={(sw) => sw.id}
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={{ gap: 0, paddingBottom: 8 }}
                  ListHeaderComponent={
                    <>
                      {/* Student header */}
                      <View style={styles.statsStudentHeader}>
                        <View style={[styles.avatarSmall, { width: 48, height: 48, borderRadius: 24 }]}>
                          <Text style={[styles.avatarSmallText, { fontSize: 17 }]}>
                            {getInitials(statsData.student.full_name)}
                          </Text>
                        </View>
                        <View>
                          <Text style={styles.sheetTitle}>
                            {statsData.student.full_name}
                          </Text>
                          <Text style={{ fontFamily: fonts.body, fontSize: 12, color: C.muted }}>
                            {sessionWords.length} word{sessionWords.length !== 1 ? "s" : ""} sent this session
                          </Text>
                        </View>
                      </View>

                      {/* Summary chips */}
                      {(() => {
                        const total   = statsData.attempts.length;
                        const correct = statsData.attempts.filter((a) => a.is_correct).length;
                        const acc     = total > 0 ? Math.round((correct / total) * 100) : 0;
                        const timed   = statsData.attempts.filter((a) => (a.response_time_ms ?? 0) > 0);
                        const avgMs   = timed.length > 0
                          ? Math.round(timed.reduce((s, a) => s + (a.response_time_ms ?? 0), 0) / timed.length)
                          : 0;
                        return (
                          <View style={{ flexDirection: "row", gap: 10, marginBottom: 16 }}>
                            <View style={[styles.statsChip, { backgroundColor: acc >= 80 ? C.greenBg : acc >= 60 ? C.brownBg : total === 0 ? C.bg : C.redBg }]}>
                              <Text style={[styles.statsChipValue, { color: acc >= 80 ? C.green : acc >= 60 ? C.brown : total === 0 ? C.muted : C.red }]}>
                                {acc}%
                              </Text>
                              <Text style={styles.statsChipLabel}>Accuracy</Text>
                            </View>
                            <View style={[styles.statsChip, { backgroundColor: C.blueWash }]}>
                              <Text style={[styles.statsChipValue, { color: C.navy }]}>
                                {avgMs > 0 ? avgMs >= 1000 ? `${(avgMs / 1000).toFixed(1)}s` : `${avgMs}ms` : "—"}
                              </Text>
                              <Text style={styles.statsChipLabel}>Avg Response</Text>
                            </View>
                            <View style={[styles.statsChip, { backgroundColor: C.brownBg }]}>
                              <Text style={[styles.statsChipValue, { color: C.brown }]}>
                                {correct}/{total}
                              </Text>
                              <Text style={styles.statsChipLabel}>Correct</Text>
                            </View>
                          </View>
                        );
                      })()}

                      {/* Column headers */}
                      <View style={styles.reviewTableHeader}>
                        <Text style={[styles.reviewHeaderCell, { flex: 0.5 }]}>#</Text>
                        <Text style={[styles.reviewHeaderCell, { flex: 1.4 }]}>WORD</Text>
                        <Text style={[styles.reviewHeaderCell, { flex: 2 }]}>SPOKEN INPUT</Text>
                        <Text style={[styles.reviewHeaderCell, { flex: 1 }]}>RESULT</Text>
                      </View>
                    </>
                  }
                  ListEmptyComponent={
                    <Text style={styles.emptyHint}>No words sent this session.</Text>
                  }
                  renderItem={({ item: sw, index: i }) => {
                    // Find matching attempt for this word
                    const attempt = statsData.attempts.find(
                      (a) => a.word === sw.word
                    );
                    return (
                      <View
                        style={[
                          styles.reviewRow,
                          i % 2 === 0 && { backgroundColor: C.bg },
                        ]}
                      >
                        {/* # */}
                        <Text style={[styles.reviewCell, { flex: 0.5, color: C.muted, fontSize: 11 }]}>
                          {String(i + 1).padStart(2, "0")}
                        </Text>

                        {/* Word sent */}
                        <Text style={[styles.reviewCell, { flex: 1.4, fontFamily: fonts.mono, letterSpacing: 1.5, color: C.navy }]}>
                          {sw.word}
                        </Text>

                        {/* Spoken input — placeholder until STT/firmware ready */}
                        {attempt ? (
                          <View style={{ flex: 2, flexDirection: "row", alignItems: "center", gap: 5 }}>
                            <Ionicons
                              name={attempt.is_correct ? "mic" : "mic-outline"}
                              size={11}
                              color={attempt.is_correct ? C.green : C.muted}
                            />
                            <Text
                              style={[styles.reviewCell, {
                                flex: 1,
                                color: attempt.is_correct ? C.green : C.red,
                                fontFamily: fonts.body,
                              }]}
                            >
                              {attempt.is_correct ? sw.word : "(incorrect)"}
                            </Text>
                          </View>
                        ) : (
                          <View style={[styles.reviewVoicePlaceholder, { flex: 2 }]}>
                            <Ionicons name="mic-off-outline" size={11} color={C.muted} />
                            <Text style={styles.reviewVoicePlaceholderText}>
                              voice input soon
                            </Text>
                          </View>
                        )}

                        {/* Result badge */}
                        {attempt ? (
                          <View
                            style={[
                              styles.resultBadge,
                              { flex: 1, backgroundColor: attempt.is_correct ? C.greenBg : C.redBg },
                            ]}
                          >
                            <Text style={[styles.resultBadgeText, { color: attempt.is_correct ? C.green : C.red }]}>
                              {attempt.is_correct ? "✓ Correct" : "✗ Wrong"}
                            </Text>
                          </View>
                        ) : (
                          <View style={[styles.resultBadge, { flex: 1, backgroundColor: C.border }]}>
                            <Text style={[styles.resultBadgeText, { color: C.muted }]}>—</Text>
                          </View>
                        )}
                      </View>
                    );
                  }}
                />
              )}
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    );

  // ══════════════════════════════════════════════════════════════════════════
  // ACTIVE VIEW — in_progress
  // ══════════════════════════════════════════════════════════════════════════

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {Header}
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Session name + status */}
        <View style={styles.activeHeader}>
          <Text style={styles.sessionName}>{session.name}</Text>
          <View style={styles.liveIndicator}>
            <Animated.View style={[styles.liveDot, { opacity: pulseAnim }]} />
            <Text style={styles.liveText}>Live</Text>
          </View>
        </View>

        {/* Connected students */}
        <Text style={styles.sectionLabel}>STUDENTS</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ marginBottom: 4 }}
        >
          <View style={styles.studentStrip}>
            {assignedStudents.map((s) => {
              const color = s.device
                ? (DEVICE_COLOR[s.device.status] ?? C.muted)
                : C.muted;
              return (
                <View key={s.id} style={styles.studentPill}>
                  <View
                    style={[styles.studentPillAvatar, { borderColor: color }]}
                  >
                    <Text style={styles.studentPillInitials}>
                      {getInitials(s.full_name)}
                    </Text>
                  </View>
                  <Text style={styles.studentPillName} numberOfLines={1}>
                    {s.full_name.split(" ")[0]}
                  </Text>
                  <View
                    style={[styles.statusDot, { backgroundColor: color }]}
                  />
                </View>
              );
            })}
          </View>
        </ScrollView>

        {/* ── MANUAL: type word live ────────────────────────────────── */}
        {session.type === "manual" && (
          <>
            <View style={styles.sectionCard}>
              <Text style={styles.cardLabel}>SEND WORD</Text>
              <View style={styles.sendRow}>
                <TextInput
                  style={[styles.wordInput, { flex: 1 }]}
                  value={manualWord}
                  onChangeText={(v) => {
                    setManualWord(v.toUpperCase());
                    setWordSent(false);
                  }}
                  placeholder="TYPE WORD"
                  placeholderTextColor={C.muted}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  returnKeyType="send"
                  onSubmitEditing={() => sendWord(manualWord)}
                />
                <Pressable
                  onPress={() => sendWord(manualWord)}
                  style={({ pressed }) => [
                    styles.sendBtn,
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  <Ionicons name="send" size={16} color="#1A1200" />
                  <Text style={styles.sendBtnText}>Send</Text>
                </Pressable>
              </View>
            </View>

            {/* Words sent history + live student responses */}
            {sessionWords.length > 0 && (
              <View style={styles.sectionCard}>
                <Text style={styles.cardLabel}>WORDS SENT</Text>
                <View style={{ gap: 8 }}>
                  {[...sessionWords].reverse().map((sw, i) => {
                    // Find any live attempt for this word
                    const attempt = liveAttempts.find(
                      (a) => a.word === sw.word
                    );
                    return (
                      <View key={sw.id} style={styles.historyRow}>
                        <Text style={styles.historyIndex}>
                          {String(sessionWords.length - i).padStart(2, "0")}
                        </Text>
                        <Text style={styles.historyWord}>{sw.word}</Text>
                        {attempt && (
                          <View
                            style={[
                              styles.attemptLiveBadge,
                              { backgroundColor: attempt.is_correct ? C.greenBg : C.redBg },
                            ]}
                          >
                            <Text
                              style={[
                                styles.attemptLiveBadgeText,
                                { color: attempt.is_correct ? C.green : C.red },
                              ]}
                            >
                              {attempt.is_correct ? "✓ Correct" : "✗ Wrong"}
                            </Text>
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              </View>
            )}

            {/* Live student response feed (most recent attempts, any word) */}
            {liveAttempts.length > 0 && (
              <View style={styles.sectionCard}>
                <Text style={styles.cardLabel}>LIVE RESPONSES</Text>
                <View style={{ gap: 8 }}>
                  {liveAttempts.slice(0, 5).map((a) => (
                    <View key={a.id} style={styles.historyRow}>
                      <View
                        style={[
                          styles.responseDot,
                          { backgroundColor: a.is_correct ? C.green : C.red },
                        ]}
                      />
                      <Text style={styles.historyWord}>{a.word}</Text>
                      <View style={{ flex: 1 }} />
                      <Text
                        style={[
                          styles.responseLabel,
                          { color: a.is_correct ? C.green : C.red },
                        ]}
                      >
                        {a.is_correct ? "Correct" : "Wrong"}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
          </>
        )}

        {/* ── WORD LIST: navigate through list ─────────────────────── */}
        {session.type === "word_list" && sessionWords.length > 0 && (
          <View style={styles.sectionCard}>
            <Text style={styles.cardLabel}>WORD LIST</Text>
            <View style={styles.wordNavRow}>
              <Pressable
                onPress={() => {
                  const newIdx = Math.max(0, wordListIndex - 1);
                  setWordListIndex(newIdx);
                  setWordSent(false);
                  setChunks([]);
                  // Save navigation position so resume lands on the same word
                  saveWordPosition(id!, sessionWords[newIdx]?.word ?? "", 0);
                }}
                disabled={wordListIndex === 0}
                style={({ pressed }) => [
                  styles.navBtn,
                  pressed && { opacity: 0.7 },
                  wordListIndex === 0 && { opacity: 0.3 },
                ]}
              >
                <Ionicons name="chevron-back" size={20} color={C.navy} />
              </Pressable>
              <View style={styles.wordDisplay}>
                <Text style={styles.wordDisplayIndex}>
                  {wordListIndex + 1} / {sessionWords.length}
                </Text>
                <Text style={styles.wordDisplayText}>
                  {sessionWords[wordListIndex]?.word}
                </Text>
                {/* Show attempt result for current word live */}
                {(() => {
                  const currentWord = sessionWords[wordListIndex]?.word;
                  const attempt = liveAttempts.find((a) => a.word === currentWord);
                  if (!attempt) return null;
                  return (
                    <View
                      style={[
                        styles.wordListAttemptBadge,
                        { backgroundColor: attempt.is_correct ? C.greenBg : C.redBg },
                      ]}
                    >
                      <Text
                        style={[
                          styles.wordListAttemptText,
                          { color: attempt.is_correct ? C.green : C.red },
                        ]}
                      >
                        {attempt.is_correct ? "✓ Correct" : "✗ Wrong"}
                      </Text>
                    </View>
                  );
                })()}
              </View>
              <Pressable
                onPress={() => {
                  const newIdx = Math.min(sessionWords.length - 1, wordListIndex + 1);
                  setWordListIndex(newIdx);
                  setWordSent(false);
                  setChunks([]);
                  // Save navigation position so resume lands on the same word
                  saveWordPosition(id!, sessionWords[newIdx]?.word ?? "", 0);
                }}
                disabled={wordListIndex === sessionWords.length - 1}
                style={({ pressed }) => [
                  styles.navBtn,
                  pressed && { opacity: 0.7 },
                  wordListIndex === sessionWords.length - 1 && { opacity: 0.3 },
                ]}
              >
                <Ionicons name="chevron-forward" size={20} color={C.navy} />
              </Pressable>
            </View>
            <Pressable
              onPress={() => sendWord(sessionWords[wordListIndex]?.word ?? "")}
              style={({ pressed }) => [
                styles.sendBtn,
                { alignSelf: "stretch", justifyContent: "center" },
                pressed && { opacity: 0.85 },
              ]}
            >
              <Ionicons name="send" size={16} color="#1A1200" />
              <Text style={styles.sendBtnText}>Send to Devices</Text>
            </Pressable>
          </View>
        )}

        {/* ── Word list: live responses feed ───────────────────────── */}
        {session.type === "word_list" && liveAttempts.length > 0 && (
          <View style={styles.sectionCard}>
            <Text style={styles.cardLabel}>LIVE RESPONSES</Text>
            <View style={{ gap: 8 }}>
              {liveAttempts.slice(0, 5).map((a) => (
                <View key={a.id} style={styles.historyRow}>
                  <View
                    style={[
                      styles.responseDot,
                      { backgroundColor: a.is_correct ? C.green : C.red },
                    ]}
                  />
                  <Text style={styles.historyWord}>{a.word}</Text>
                  <View style={{ flex: 1 }} />
                  <Text
                    style={[
                      styles.responseLabel,
                      { color: a.is_correct ? C.green : C.red },
                    ]}
                  >
                    {a.is_correct ? "Correct" : "Wrong"}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* ── Chunk display (shown after word is sent) ──────────────── */}
        {wordSent && chunks.length > 0 && (
          <View style={styles.sectionCard}>
            <View style={styles.chunkHeader}>
              <Text style={styles.cardLabel}>DEVICE DISPLAY</Text>
              <Text style={styles.chunkCount}>
                Chunk {chunkIndex + 1} of {chunks.length}
              </Text>
            </View>

            <FiveCellDisplay chunk={chunks[chunkIndex]} />

            {/* Chunk navigation */}
            {chunks.length > 1 && (
              <View style={styles.chunkNavRow}>
                <Pressable
                  onPress={() => goToChunk(chunkIndex - 1)}
                  disabled={chunkIndex === 0}
                  style={({ pressed }) => [
                    styles.chunkNavBtn,
                    pressed && { opacity: 0.7 },
                    chunkIndex === 0 && { opacity: 0.3 },
                  ]}
                >
                  <Ionicons name="arrow-back" size={16} color={C.navy} />
                  <Text style={styles.chunkNavText}>Prev</Text>
                </Pressable>
                <Pressable
                  onPress={() => goToChunk(chunkIndex + 1)}
                  disabled={chunkIndex === chunks.length - 1}
                  style={({ pressed }) => [
                    styles.chunkNavBtn,
                    pressed && { opacity: 0.7 },
                    chunkIndex === chunks.length - 1 && { opacity: 0.3 },
                  ]}
                >
                  <Text style={styles.chunkNavText}>Next</Text>
                  <Ionicons name="arrow-forward" size={16} color={C.navy} />
                </Pressable>
              </View>
            )}
            <Text style={styles.deviceHint}>
              Student presses Next / Back on the device to navigate chunks.
            </Text>
          </View>
        )}
      </ScrollView>
      {DupWordModal}
      {FinishSessionModal}
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  centeredView: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },

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
  headerRight: { flexDirection: "row", gap: 8 },
  pauseBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: C.brownBg,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  pauseBtnText: { fontFamily: fonts.heading, fontSize: 13, color: C.brown },
  finishBtn: {
    backgroundColor: C.greenBg,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  finishBtnText: { fontFamily: fonts.heading, fontSize: 13, color: C.green },

  scroll: { padding: 16, paddingBottom: 40, gap: 16 },

  infoCard: {
    backgroundColor: C.white,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1.5,
    borderColor: C.border,
    gap: 8,
  },
  sessionName: { fontFamily: fonts.heading, fontSize: 20, color: C.navy },
  sessionPurpose: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: C.muted,
    lineHeight: 20,
  },
  infoRow: { flexDirection: "row", gap: 8 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 100 },
  badgeText: { fontFamily: fonts.mono, fontSize: 10 },

  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: C.brown,
    letterSpacing: 1,
    marginTop: 4,
  },
  sectionHint: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: C.muted,
    marginTop: -8,
    lineHeight: 18,
  },
  emptyHint: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: C.muted,
    textAlign: "center",
    paddingVertical: 12,
  },

  // Student assignment chips
  studentGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  studentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 100,
    backgroundColor: C.white,
    borderWidth: 1.5,
    borderColor: C.border,
  },
  studentChipActive: { backgroundColor: C.navy, borderColor: C.navy },
  studentChipText: { fontFamily: fonts.heading, fontSize: 13, color: C.ink },
  statusDot: { width: 7, height: 7, borderRadius: 4 },

  // Word list builder
  wordListContainer: {
    backgroundColor: C.white,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: C.border,
    overflow: "hidden",
  },
  wordRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    backgroundColor: C.white,
  },
  wordIndex: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: C.muted,
    width: 24,
  },
  wordText: {
    fontFamily: fonts.mono,
    fontSize: 15,
    color: C.navy,
    flex: 1,
    letterSpacing: 1,
  },
  deleteBtn: { padding: 6, borderRadius: 8, backgroundColor: C.redBg },
  wordListActions: {
    flexDirection: "row",
    gap: 10,
  },
  addWordBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 16,
    backgroundColor: C.white,
    borderWidth: 1.5,
    borderColor: C.border,
    justifyContent: "center",
  },
  addWordBtnText: { fontFamily: fonts.heading, fontSize: 14, color: C.navy },
  reorderBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 16,
    backgroundColor: C.blueWash,
    borderWidth: 1.5,
    borderColor: C.navy,
    justifyContent: "center",
  },
  reorderBtnText: { fontFamily: fonts.heading, fontSize: 14, color: C.navy },

  // Manual session history
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: C.bg,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  historyIndex: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: C.muted,
    width: 20,
  },
  historyWord: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: C.navy,
    flex: 1,
    letterSpacing: 1,
  },

  // Live attempt badges (shown inline in WORDS SENT and WORD LIST)
  attemptLiveBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  },
  attemptLiveBadgeText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.5,
  },

  // Live response feed items
  responseDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  responseLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.5,
  },

  // Word list: inline attempt result below word display
  wordListAttemptBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 100,
    marginTop: 4,
    alignSelf: "center",
  },
  wordListAttemptText: {
    fontFamily: fonts.heading,
    fontSize: 12,
  },

  // Launch
  launchBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: C.amber,
    borderRadius: 14,
    paddingVertical: 16,
  },
  launchBtnText: { fontFamily: fonts.heading, fontSize: 17, color: "#1A1200" },

  // Paused view
  pausedCard: {
    backgroundColor: C.white,
    borderRadius: 20,
    padding: 32,
    alignItems: "center",
    gap: 12,
    borderWidth: 1.5,
    borderColor: C.border,
    width: "100%",
  },
  pausedTitle: { fontFamily: fonts.heading, fontSize: 22, color: C.navy },
  pausedSub: { fontFamily: fonts.body, fontSize: 14, color: C.muted },
  pausedLastWord: {
    alignItems: "center",
    gap: 4,
    backgroundColor: C.blueWash,
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
    width: "100%",
    borderWidth: 1,
    borderColor: C.border,
  },
  pausedLastWordLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: C.muted,
    letterSpacing: 1.5,
    textTransform: "uppercase",
  },
  pausedLastWordValue: {
    fontFamily: fonts.heading,
    fontSize: 22,
    color: C.navy,
    letterSpacing: 2,
  },
  pausedActions: { width: "100%", gap: 10, marginTop: 8 },
  resumeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: C.amber,
    borderRadius: 12,
    paddingVertical: 14,
  },
  resumeBtnText: { fontFamily: fonts.heading, fontSize: 15, color: "#1A1200" },
  finishPausedBtn: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    backgroundColor: C.white,
    borderWidth: 1.5,
    borderColor: C.border,
  },
  finishPausedBtnText: {
    fontFamily: fonts.heading,
    fontSize: 15,
    color: C.navy,
  },

  // Finished view
  finishedStudentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: C.white,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1.5,
    borderColor: C.border,
  },
  avatarSmall: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: C.navy,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarSmallText: { fontFamily: fonts.heading, fontSize: 13, color: C.white },
  finishedStudentName: {
    fontFamily: fonts.heading,
    fontSize: 14,
    color: C.navy,
    flex: 1,
  },
  viewStatsChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    backgroundColor: C.blueWash,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 100,
  },
  viewStatsText: { fontFamily: fonts.mono, fontSize: 10, color: C.navy },

  // Session stats modal
  statsChip: {
    flex: 1,
    borderRadius: 12,
    padding: 12,
    alignItems: "center",
    gap: 3,
  },
  statsChipValue: { fontFamily: fonts.heading, fontSize: 20 },
  statsChipLabel: {
    fontFamily: fonts.body,
    fontSize: 10,
    color: C.ink,
    textAlign: "center",
  },
  attemptRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: C.bg,
    borderRadius: 10,
    padding: 12,
  },
  attemptDot: { width: 8, height: 8, borderRadius: 4 },
  attemptWord: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: C.navy,
    letterSpacing: 1,
  },
  attemptTime: { fontFamily: fonts.mono, fontSize: 11, color: C.muted },
  resultBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 100 },
  resultBadgeText: { fontFamily: fonts.mono, fontSize: 9 },

  // Active view
  activeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  liveIndicator: { flexDirection: "row", alignItems: "center", gap: 5 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.green },
  liveText: { fontFamily: fonts.mono, fontSize: 11, color: C.green },
  studentStrip: { flexDirection: "row", gap: 12, paddingVertical: 4 },
  studentPill: { alignItems: "center", gap: 4, width: 64 },
  studentPillAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: C.navy,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
  },
  studentPillInitials: {
    fontFamily: fonts.heading,
    fontSize: 15,
    color: C.white,
  },
  studentPillName: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: C.ink,
    textAlign: "center",
  },

  sectionCard: {
    backgroundColor: C.white,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1.5,
    borderColor: C.border,
    gap: 12,
  },
  cardLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: C.brown,
    letterSpacing: 1,
  },
  sendRow: { flexDirection: "row", gap: 10 },
  wordInput: {
    fontFamily: fonts.mono,
    fontSize: 15,
    letterSpacing: 2,
    color: C.ink,
    backgroundColor: C.bg,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  sendBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: C.amber,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  sendBtnText: { fontFamily: fonts.heading, fontSize: 14, color: "#1A1200" },

  // Word list navigation
  wordNavRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  navBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: C.bg,
    borderWidth: 1.5,
    borderColor: C.border,
    alignItems: "center",
    justifyContent: "center",
  },
  wordDisplay: { flex: 1, alignItems: "center", gap: 2 },
  wordDisplayIndex: { fontFamily: fonts.mono, fontSize: 11, color: C.muted },
  wordDisplayText: {
    fontFamily: fonts.mono,
    fontSize: 22,
    color: C.navy,
    letterSpacing: 3,
  },

  // Chunk display
  chunkHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  chunkCount: { fontFamily: fonts.mono, fontSize: 11, color: C.muted },
  fiveCells: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 8,
  },
  cellSlot: { alignItems: "center", gap: 6 },
  cellBox: {
    width: 44,
    height: 52,
    borderRadius: 10,
    backgroundColor: C.blueWash,
    alignItems: "center",
    justifyContent: "center",
  },
  cellBoxEmpty: {
    backgroundColor: C.bg,
    borderWidth: 1.5,
    borderColor: C.border,
  },
  cellLetter: { fontFamily: fonts.mono, fontSize: 13, color: C.navy },
  chunkNavRow: { flexDirection: "row", gap: 10 },
  chunkNavBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: C.bg,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingVertical: 11,
  },
  chunkNavText: { fontFamily: fonts.heading, fontSize: 14, color: C.navy },
  deviceHint: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: C.muted,
    textAlign: "center",
    lineHeight: 18,
  },

  // Modals
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
    gap: 12,
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
  sheetActions: { flexDirection: "row", gap: 10, marginTop: 4 },

  // Delete modals
  deletePreview: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    alignSelf: "center",
    backgroundColor: C.redBg,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: C.red,
  },
  deletePreviewText: { fontFamily: fonts.heading, fontSize: 18, color: C.red },
  deleteTitle: {
    fontFamily: fonts.heading,
    fontSize: 18,
    color: C.navy,
    textAlign: "center",
  },
  deleteSub: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: C.muted,
    textAlign: "center",
    lineHeight: 20,
  },
  // Destructive (Delete) — subtle red outline, no fill
  btnDestructive: {
    borderWidth: 1.5,
    borderColor: C.red,
    backgroundColor: C.redBg,
  },
  btnDestructiveDisabled: {
    borderColor: C.border,
    backgroundColor: C.bg,
  },
  btnDestructiveText: {
    fontFamily: fonts.heading,
    fontSize: 15,
    color: C.red,
  },

  // Keep It (safe action) — solid green
  btnKeep: { backgroundColor: C.green },
  btnKeepText: { fontFamily: fonts.heading, fontSize: 15, color: C.white },

  // Finish modal
  finishPreview: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    alignSelf: "center",
    backgroundColor: C.greenBg,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: C.green,
  },
  finishPreviewText: { fontFamily: fonts.heading, fontSize: 18, color: C.green },

  // Finish confirm button — solid green
  btnFinishConfirm: { backgroundColor: C.green },
  btnFinishConfirmText: { fontFamily: fonts.heading, fontSize: 15, color: C.white },

  // Not Yet (dismiss) — neutral outline
  btnNotYet: { backgroundColor: C.bg, borderWidth: 1.5, borderColor: C.border },
  btnNotYetText: { fontFamily: fonts.heading, fontSize: 15, color: C.navy },
  countdownRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: C.brownBg,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  countdownText: { fontFamily: fonts.body, fontSize: 13, color: C.brown, flex: 1 },
  countdownNumber: { fontFamily: fonts.heading, fontSize: 13, color: C.brown },
  sheetInput: {
    fontFamily: fonts.body,
    fontSize: 15,
    color: C.ink,
    backgroundColor: C.bg,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  sheetBtn: { flex: 1, borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  // Legacy neutral button (word-delete modal Keep It)
  btnCancel: { backgroundColor: C.bg, borderWidth: 1.5, borderColor: C.border },
  btnConfirm: { backgroundColor: C.amber },
  btnCancelText: { fontFamily: fonts.heading, fontSize: 15, color: C.navy },
  btnConfirmText: { fontFamily: fonts.heading, fontSize: 15, color: "#1A1200" },

  // Duplicate word modal
  dupWordPreview: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    alignSelf: "center",
    backgroundColor: C.brownBg,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: C.brown,
  },
  dupWordPreviewText: { fontFamily: fonts.heading, fontSize: 18, color: C.brown },

  // Word bank
  tabRow: {
    flexDirection: "row",
    backgroundColor: C.bg,
    borderRadius: 12,
    padding: 4,
    gap: 4,
  },
  tab: { flex: 1, paddingVertical: 8, alignItems: "center", borderRadius: 10 },
  tabActive: { backgroundColor: C.white },
  tabText: { fontFamily: fonts.heading, fontSize: 13, color: C.muted },
  tabTextActive: { color: C.navy },
  saveToBankRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
  },
  saveToBankLabel: { fontFamily: fonts.body, fontSize: 14, color: C.ink },
  bankItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: C.bg,
    borderRadius: 10,
    padding: 12,
  },
  bankWord: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: C.navy,
    flex: 1,
    letterSpacing: 1,
  },
  bankCategory: { fontFamily: fonts.body, fontSize: 11, color: C.muted },

  // Stats modal — student header
  statsStudentHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 14,
  },

  // Stats modal — word review table
  reviewTableHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: C.blueWash,
    borderRadius: 8,
    marginBottom: 4,
  },
  reviewHeaderCell: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: C.navy,
    letterSpacing: 0.8,
  },
  reviewRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 8,
    gap: 4,
  },
  reviewCell: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: C.ink,
  },
  reviewVoicePlaceholder: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    opacity: 0.5,
  },
  reviewVoicePlaceholderText: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: C.muted,
    fontStyle: "italic",
  },
});
