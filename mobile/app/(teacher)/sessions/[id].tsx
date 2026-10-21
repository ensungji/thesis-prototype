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
  AppState,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter, useFocusEffect, useNavigation } from "expo-router";
import { usePreventRemove } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../lib/supabase";
import { updateOrQueue, insertOrQueue, newId } from "../../../lib/outbox";
import { logEvent } from "../../../lib/logger";
import { isOnline, subscribeOnline } from "../../../lib/network";
import { onDevicePresence, type PresenceEvent } from "../../../lib/device-presence";
import { colors as C, fonts } from "../../../lib/theme";
import { BrailleCell } from "../../../components/BrailleCell";
import { BrailleLoader } from "../../../components/BrailleLoader";
import { Toast } from "../../../components/Toast";
import { Countdown } from "../../../components/Countdown";
import { wordToChunks, getPattern, isValidWord } from "../../../lib/braille";
import { fisherYatesShuffle, saveWordOrder } from "../../../lib/word-order";
import { useWordBank, filterWordBank } from "../../../lib/word-bank";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useKeepAwake } from "expo-keep-awake";
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import {
  MIN_WORD_DURATION_SEC,
  MAX_WORD_DURATION_SEC,
  DEFAULT_WORD_DURATION_SEC,
  clampDuration,
  resolveWordDuration,
  isTimedSequence,
  isLiveSession,
  getSessionTypeLabel,
  loadWordDurations,
  saveWordDurations,
  SessionType,
} from "../../../lib/session-timer";

// Mandatory 10-second hardware cooldown between words to prevent solenoid burnout
const COOLDOWN_DURATION_SEC = 10;

// ── Types ─────────────────────────────────────────────────────────────────────

type Session = {
  id: string;
  name: string;
  purpose: string | null;
  type: SessionType | "manual" | "word_list";
  status: string;
  started_at: string | null;
  finished_at: string | null;
};
type Device = { id: string; device_code: string; status: string } | null;
type Student = { id: string; full_name: string; device: Device };
type SessionWord = {
  id: string;
  word: string;
  order_index: number;
  duration_seconds?: number;
};
type WordAttempt = {
  id: string;
  student_id?: string | null;
  session_word_id?: string | null;
  word: string;
  is_correct: boolean;
  response_time_ms: number | null;
  attempted_at: string;
  transcript?: string | null;
  needs_review?: boolean | null;
  audio_path?: string | null;
  graded_by?: string | null;
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

// ── Voice answer grading helpers ──────────────────────────────────────────────

type AttemptStatus = "correct" | "wrong" | "review" | "missed";

function attemptStatus(a: WordAttempt): AttemptStatus {
  if (a.graded_by === "missed") return "missed"; // saved when the word ended unanswered (counts as wrong)
  if (a.needs_review) return "review";
  return a.is_correct ? "correct" : "wrong";
}

const STATUS_STYLE: Record<AttemptStatus, { bg: string; fg: string; label: string; short: string }> = {
  correct: { bg: C.greenBg, fg: C.green, label: "✓ Correct",   short: "Correct" },
  wrong:   { bg: C.redBg,   fg: C.red,   label: "✗ Wrong",     short: "Wrong" },
  review:  { bg: C.brownBg, fg: C.brown, label: "⚠ Review",    short: "Review" },
  missed:  { bg: C.border,  fg: C.muted, label: "– No answer", short: "No answer" },
};

// Where a grade change is saved. A "No answer" row is matched on student +
// word: if a voice answer reached the server first, the row the phone made
// was never added, and the grade must land on the voice answer instead.
function attemptMatch(a: WordAttempt): Record<string, string> {
  return a.graded_by === "missed" && a.session_word_id && a.student_id
    ? { session_word_id: a.session_word_id, student_id: a.student_id }
    : { id: a.id };
}

const cleanTranscript = (t?: string | null) => (t ?? "").replace(/[.!?,]/g, "").trim();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asWordId = (id?: string | null) => (id && UUID_RE.test(id) ? id : null);

// Answers to ONE sending of a word. New answers are linked by session_word_id;
// older ones (from before this fix) fall back to matching the word text.
function attemptsForWord(attempts: WordAttempt[], sw: { id: string; word: string }) {
  return attempts.filter((a) =>
    a.session_word_id
      ? a.session_word_id === sw.id
      : a.word?.toUpperCase() === sw.word.toUpperCase()
  );
}

// The newest answer in a list (the one that counts)
function latestAttempt(list: WordAttempt[]): WordAttempt | null {
  let best: WordAttempt | null = null;
  for (const a of list) {
    if (!best || Date.parse(a.attempted_at) > Date.parse(best.attempted_at)) best = a;
  }
  return best;
}

// Plays a student's recording from the private "answers" bucket
function PlayRecordingButton({ path }: { path: string | null }) {
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const playerRef = useRef<AudioPlayer | null>(null);

  useEffect(() => {
    return () => {
      playerRef.current?.remove();
      playerRef.current = null;
    };
  }, []);

  async function toggle() {
    if (!path) return;
    if (playing && playerRef.current) {
      playerRef.current.pause();
      setPlaying(false);
      return;
    }
    setLoading(true);
    const { data } = await supabase.storage.from("answers").createSignedUrl(path, 600);
    setLoading(false);
    if (!data?.signedUrl) return;

    playerRef.current?.remove();
    const player = createAudioPlayer({ uri: data.signedUrl });
    playerRef.current = player;
    player.addListener("playbackStatusUpdate", (st) => {
      if (st.didJustFinish) setPlaying(false);
    });
    player.play();
    setPlaying(true);
  }

  return (
    <Pressable
      onPress={toggle}
      disabled={!path || loading}
      hitSlop={8}
      style={({ pressed }) => [
        styles.playBtn,
        !path && { opacity: 0.3 },
        pressed && { opacity: 0.7 },
      ]}
      accessibilityLabel={playing ? "Stop recording" : "Play recording"}
    >
      {loading ? (
        <ActivityIndicator size="small" color={C.navy} />
      ) : (
        <Ionicons name={playing ? "stop" : "play"} size={12} color={C.navy} />
      )}
    </Pressable>
  );
}

// ── Teacher fallback grading (✓ / ✗ per student, current word) ─────────────

function HandGradeCard({
  word,
  wordId,
  students,
  attempts,
  onGrade,
}: {
  word: string;
  wordId: string | null;
  students: Student[];
  attempts: WordAttempt[];
  onGrade: (
    student: Student,
    word: string,
    wordId: string | null,
    correct: boolean,
    existing: WordAttempt | null
  ) => void;
}) {
  if (!word || students.length === 0) return null;
  const w = word.toUpperCase();
  return (
    <View style={styles.sectionCard}>
      <Text style={styles.cardLabel}>GRADE BY HAND · {w}</Text>
      <Text style={hg.hint}>
        Tap ✓ or ✗ if the voice answer is missing or needs a check.
      </Text>
      <View style={{ gap: 8 }}>
        {students.map((st) => {
          // attempts are newest first → this is the student's latest answer
          const mine = attempts.filter((x) => x.student_id === st.id);
          const a = latestAttempt(
            wordId ? attemptsForWord(mine, { id: wordId, word: w }) : mine.filter((x) => x.word?.toUpperCase() === w)
          );
          const status = a ? attemptStatus(a) : null;
          const byTeacher = a?.graded_by === "teacher";
          return (
            <View key={st.id} style={hg.row}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={hg.name} numberOfLines={1}>{st.full_name}</Text>
                <Text
                  style={[hg.sub, status && { color: STATUS_STYLE[status].fg }]}
                  numberOfLines={1}
                >
                  {!a
                    ? "No answer yet"
                    : STATUS_STYLE[status!].short +
                      (byTeacher
                        ? " · graded by you"
                        : a.transcript
                        ? ` · heard "${cleanTranscript(a.transcript)}"`
                        : "")}
                </Text>
              </View>
              {a?.audio_path ? <PlayRecordingButton path={a.audio_path} /> : null}
              <Pressable
                onPress={() => onGrade(st, w, wordId, true, a)}
                hitSlop={6}
                style={({ pressed }) => [
                  hg.btn,
                  status === "correct" && { backgroundColor: C.green, borderColor: C.green },
                  pressed && { opacity: 0.7 },
                ]}
                accessibilityLabel={`Mark ${st.full_name} correct`}
              >
                <Ionicons name="checkmark" size={18} color={status === "correct" ? C.white : C.green} />
              </Pressable>
              <Pressable
                onPress={() => onGrade(st, w, wordId, false, a)}
                hitSlop={6}
                style={({ pressed }) => [
                  hg.btn,
                  status === "wrong" && { backgroundColor: C.red, borderColor: C.red },
                  pressed && { opacity: 0.7 },
                ]}
                accessibilityLabel={`Mark ${st.full_name} wrong`}
              >
                <Ionicons name="close" size={18} color={status === "wrong" ? C.white : C.red} />
              </Pressable>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const hg = StyleSheet.create({
  hint: { fontFamily: fonts.body, fontSize: 12, color: C.muted, lineHeight: 17 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: C.bg,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  name: { fontFamily: fonts.bodyBold, fontSize: 14, color: C.ink },
  sub: { fontFamily: fonts.mono, fontSize: 10, color: C.muted },
  who: { fontFamily: fonts.bodyBold, fontSize: 12, color: C.ink, maxWidth: 90 },
  btn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1.5,
    borderColor: C.border,
    backgroundColor: C.white,
    alignItems: "center",
    justifyContent: "center",
  },
});

// ── Keep awake for active session ─────────────────────────────────────────────

function ActiveSessionKeepAwake() {
  useKeepAwake();
  return null;
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
  const [shuffling, setShuffling] = useState(false);

  // ── Word list builder ───────────────────────────────────────────────────────
  // (add-word logic lives in add-word.tsx; reloaded via useFocusEffect)

  // ── Active session ──────────────────────────────────────────────────────────
  const [manualWord, setManualWord] = useState("");
  const [chunks, setChunks] = useState<string[]>([]);
  const [chunkIndex, setChunkIndex] = useState(0);
  const [wordListIndex, setWordListIndex] = useState(0);
  const [wordSent, setWordSent] = useState(false);

  // ── Timed Sequence Auto-Cycle playback state ────────────────────────────────
  const [isPlaying, setIsPlaying] = useState(true);
  const [isCooldown, setIsCooldown] = useState(false);
  const [totalWordSeconds, setTotalWordSeconds] = useState<number>(DEFAULT_WORD_DURATION_SEC);
  const autoCycleTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const isPlayingRef = useRef(true);
  const isCooldownRef = useRef(false);
  const timerSecondsLeftRef = useRef(DEFAULT_WORD_DURATION_SEC);
  const wordListIndexRef = useRef(0);
  const sessionWordsRef = useRef<SessionWord[]>([]);

  // The countdown runs off a deadline, not a tick count: Android delays
  // intervals whenever the JS thread is busy, so counted ticks run long.
  const deadlineRef = useRef<number | null>(null);     // when the current word / break ends
  const pausedLeftMsRef = useRef<number | null>(null); // time that was left when it stopped

  function startCountdown(sec: number) {
    deadlineRef.current = Date.now() + sec * 1000;
    pausedLeftMsRef.current = null;
    timerSecondsLeftRef.current = sec;
  }

  // Read by <Countdown>, which re-renders on its own (not this whole screen)
  const getCountdownLeftMs = useCallback(() => {
    if (deadlineRef.current !== null) return deadlineRef.current - Date.now();
    if (pausedLeftMsRef.current !== null) return pausedLeftMsRef.current;
    return timerSecondsLeftRef.current * 1000;
  }, []);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    isCooldownRef.current = isCooldown;
  }, [isCooldown]);

  useEffect(() => {
    wordListIndexRef.current = wordListIndex;
  }, [wordListIndex]);

  useEffect(() => {
    sessionWordsRef.current = sessionWords;
  }, [sessionWords]);

  // Tracks the word currently active (just sent, awaiting teacher "Done" or "Clear Display").
  // null means no word is active and the teacher may type/send the next word.
  const [activeWordId, setActiveWordId] = useState<string | null>(null);

  // Tracks which words have been marked done (completed) this run.
  const [completedWordIds, setCompletedWordIds] = useState<Set<string>>(new Set());

  // The most recently *sent* word — used on the Paused card for context recovery.
  // Set in doSendWord() and restored from AsyncStorage in restoreWordPosition().
  // Distinct from manualWord (text input value) and wordListIndex (list position).
  const [lastSentWord, setLastSentWord] = useState("");

  // ── Live Session: 60-Second Hardware Safety Kill-Switch Refs ────────────────
  const liveSafetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeWordIdRef = useRef<string | null>(null);
  const lastSentWordRef = useRef<string>("");
  const completedWordIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    activeWordIdRef.current = activeWordId;
  }, [activeWordId]);

  useEffect(() => {
    lastSentWordRef.current = lastSentWord;
  }, [lastSentWord]);

  useEffect(() => {
    completedWordIdsRef.current = completedWordIds;
  }, [completedWordIds]);

  // Clean up safety timer on screen unmount
  useEffect(() => {
    return () => {
      if (liveSafetyTimerRef.current) {
        clearTimeout(liveSafetyTimerRef.current);
        liveSafetyTimerRef.current = null;
      }
    };
  }, []);

  // Hardware safety auto-clear notification toast
  const [safetyToast, setSafetyToast] = useState<{
    visible: boolean;
    message: string;
    detail?: string;
  }>({ visible: false, message: "" });

  // Tracks which words have been broadcast this session run (for dup detection)
  const sentWords = useRef<Set<string>>(new Set()).current;

  // Duplicate word modal
  const [dupWordModal, setDupWordModal] = useState(false);
  const [dupWord, setDupWord] = useState("");

  // Live Session: pick a word from the Word Bank (loaded when the sheet opens)
  const { words: bankWords, loading: loadingBank, error: bankError, reload: reloadWordBank } =
    useWordBank({ reloadOnFocus: false });
  const [wordBankSheet, setWordBankSheet] = useState(false);
  const [bankSearch, setBankSearch] = useState("");

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

  // ── Finish session modal ────────────────────────────────────────────────────
  const [finishSessionModal, setFinishSessionModal] = useState(false);
  const [finishingSession, setFinishingSession] = useState(false);
  const [finishToast, setFinishToast] = useState<{ name: string } | null>(null);

  // ── Auto-pause: app background + navigation away ────────────────────────────
  // sessionStatusRef mirrors session.status without stale-closure issues so
  // useFocusEffect / AppState cleanup callbacks always read the latest value.
  const appStateRef      = useRef(AppState.currentState);
  const sessionStatusRef = useRef<string | null>(null);
  const clearDevicesRef = useRef<(commandType?: string) => Promise<void>>(async () => {});
  const clearFailedRef = useRef(false); // last clear didn't reach the server

  // Latest chunk state for callbacks that outlive a render
  const chunksRef = useRef<string[]>([]);
  const chunkIndexRef = useRef(0);
  useEffect(() => {
    chunksRef.current = chunks;
    chunkIndexRef.current = chunkIndex;
  }, [chunks, chunkIndex]);

  // ── Device power cut / comeback during a running session ───────────────────
  const [deviceToast, setDeviceToast] = useState<{
    visible: boolean;
    message: string;
    detail?: string;
    online: boolean;
  }>({ visible: false, message: "", online: true });
  const presenceHandlerRef = useRef<(e: PresenceEvent) => void>(() => {});
  presenceHandlerRef.current = (e: PresenceEvent) => {
    if (sessionStatusRef.current !== "in_progress") return;
    const student = allStudents.find((s) => assignedIds.has(s.id) && s.device?.id === e.deviceId);
    if (!student) return;
    const code = student.device?.device_code || e.code || "Device";
    const first = student.full_name.split(" ")[0];

    if (e.type === "offline") {
      setDeviceToast({
        visible: true,
        online: false,
        message: `${code} disconnected`,
        detail: `${first}'s device went offline. Use Grade by hand until it's back.`,
      });
      logEvent("warn", "device_disconnected", `${code} (${first}) went offline during the session`, {
        session_id: id ?? null,
        device_id: e.deviceId,
      });
      return;
    }

    // Back online: what SHOULD it be showing right now?
    const chunkArr = chunksRef.current;
    const idx = chunkIndexRef.current;
    const timedPaused =
      isTimedSequence(session?.type) && (!isPlayingRef.current || isCooldownRef.current);
    const want =
      activeWordIdRef.current && chunkArr.length > 0 && !timedPaused ? chunkArr[idx] ?? "" : "";
    // After an answer upload the device clears its own display on purpose
    // (firmware v7.2): don't raise the dots again, the teacher re-sends if needed
    if (!want || e.afterAnswer || e.showing.toUpperCase() === want.toUpperCase()) {
      // Nothing to re-send — just say it's back (if it had been offline)
      if (e.wasOffline) {
        setDeviceToast({
          visible: true,
          online: true,
          message: `${code} is back online`,
          detail: `${first}'s device reconnected.`,
        });
        logEvent("info", "device_rejoined", `${code} (${first}) came back online`, {
          session_id: id ?? null,
          device_id: e.deviceId,
        });
      }
      return;
    }

    const word = lastSentWordRef.current;
    supabase
      .from("device_commands")
      .insert({
        device_id: e.deviceId,
        session_id: id,
        command_type: "display_chunk",
        payload: {
          word,
          session_word_id: asWordId(activeWordIdRef.current),
          chunk: want,
          chunk_index: idx,
          total_chunks: chunkArr.length,
        },
      })
      .then(({ error }) => {
        if (error) {
          logEvent("error", "device_command_failed", `Could not re-send "${word}" to ${code}: ${error.message}`, {
            session_id: id ?? null,
            device_id: e.deviceId,
          });
        }
      });
    setDeviceToast({
      visible: true,
      online: true,
      message: `${code} is back online`,
      detail: `Re-sent "${word}" to ${first}'s device.`,
    });
    logEvent("info", "device_rejoined", `${code} (${first}) came back — re-sent "${word}"`, {
      session_id: id ?? null,
      device_id: e.deviceId,
    });
  };
  useEffect(() => onDevicePresence((e) => presenceHandlerRef.current(e)), []);
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
        // Hardware safety: release solenoids before auto-pausing
        stopLiveSafetyTimer();
        await clearDevicesRef.current("session_paused");
        // Direct DB update + local state (ref-safe, no stale closure)
        await updateOrQueue("sessions", { status: "paused" }, { id: id! });
        setSession((prev) => (prev ? { ...prev, status: "paused" } : prev));
      }
      appStateRef.current = next;
    });
    return () => sub.remove();
  }, [id]);

  // ── Ask before leaving a live session (Android back, swipe, header back) ──
  // Tab presses don't remove this screen; they still pause via the blur cleanup.
  const navigation = useNavigation();
  usePreventRemove(session?.status === "in_progress", ({ data }) => {
    Alert.alert("Leave live session?", "The session will be paused and the display cleared.", [
      { text: "Stay", style: "cancel" },
      {
        text: "Pause & leave",
        style: "destructive",
        onPress: async () => {
          await pauseSession(true);
          navigation.dispatch(data.action);
        },
      },
    ]);
  });

  // ── Back online: re-send a clear that failed while offline ─────────────────
  // A late clear is always safe (a late WORD is not, so words are never re-sent).
  useEffect(
    () =>
      subscribeOnline((online) => {
        if (online && clearFailedRef.current && sessionStatusRef.current !== "in_progress") {
          clearDevicesRef.current();
        }
      }),
    []
  );

  // ── Delete session modal ────────────────────────────────────────────────────
  const [deleteSessionModal, setDeleteSessionModal] = useState(false);
  const [deletingSession, setDeletingSession] = useState(false);

  // ── Word delete confirmation ────────────────────────────────────────────────
  const [deleteWordModal, setDeleteWordModal] = useState(false);
  const [wordToRemove, setWordToRemove] = useState<SessionWord | null>(null);

  // ── Remove-word success toast ───────────────────────────────────────────────
  const [removeWordToast, setRemoveWordToast] = useState<{ word: string } | null>(null);

  // ── Validation toast (replaces Alert.alert for launch/send-word checks) ─────
  // Non-blocking, consistent with the rest of the app's feedback style.
  const [validationToast, setValidationToast] = useState<{
    visible: boolean; message: string; detail?: string;
  }>({ visible: false, message: "" });

  function showValidationToast(message: string, detail?: string) {
    setValidationToast({ visible: true, message, detail });
  }




  // ── Load data ───────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    if (!id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      return;
    }

    const [sessionRes, studentsRes, assignedRes, wordsRes] =
      await Promise.all([
        supabase.from("sessions").select("*").eq("id", id).single(),
        supabase
          .from("students")
          .select("id, full_name")
          .eq("teacher_id", user.id)
          .order("full_name"),
        supabase
          .from("session_students")
          .select("student_id")
          .eq("session_id", id),
        supabase
          .from("session_words")
          .select("*")
          .eq("session_id", id)
          .order("order_index"),
      ]);

    // Offline / network failure: keep what's already on screen
    if (!sessionRes.data && sessionRes.error) {
      setLoading(false);
      setRefreshing(false);
      return;
    }

    // Only the devices paired to this teacher's students (not every device)
    const studentIds = (studentsRes.data ?? []).map((s) => s.id);
    const devicesRes = studentIds.length
      ? await supabase
          .from("devices")
          .select("id, device_code, status, paired_student_id")
          .in("paired_student_id", studentIds)
      : null;
    const devicesData = devicesRes?.data ?? [];
    const merged: Student[] = (studentsRes.data ?? []).map((s) => ({
      ...s,
      device: devicesData.find((d) => d.paired_student_id === s.id) ?? null,
    }));

    const fetchedSession = sessionRes.data;
    const rawWords = (wordsRes.data ?? []) as SessionWord[];
    const cachedDurations = await loadWordDurations(id);
    // Same rule as add-word.tsx: the time shown is the time the session runs
    const fetchedWords: SessionWord[] = rawWords.map((sw) => ({
      ...sw,
      duration_seconds: resolveWordDuration(sw, cachedDurations),
    }));

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
      await restoreWordPosition(id, fetchedWords, fetchedSession);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ── Restore last-sent word from AsyncStorage ────────────────────────────────
  // Reads the per-session key saved on every broadcastChunk (or sendWord when
  // no devices are connected) so the teacher UI always reflects the last word,
  // regardless of device connectivity or app restart.
  async function restoreWordPosition(
    sessionId: string,
    words: SessionWord[],
    sessionObj?: Session | null
  ) {
    try {
      const raw = await AsyncStorage.getItem(`session_word_pos_${sessionId}`);

      // Pre-populate sentWords from DB records (live sessions track history)
      words.forEach((sw) => sentWords.add(sw.word));

      if (!raw) return;

      const pos = JSON.parse(raw) as {
        word: string;
        chunkIndex: number;
        activeWordId?: string | null;
        completedWordIds?: string[];
        sentAt?: number | null;
      };

      // Snap wordListIndex for timed sequence sessions
      const idx = words.findIndex((sw) => sw.word === pos.word);
      const activeIdx = idx !== -1 ? idx : 0;
      setWordListIndex(activeIdx);
      if (words[activeIdx]) {
        const dur = clampDuration(
          words[activeIdx].duration_seconds ?? DEFAULT_WORD_DURATION_SEC
        );
        setTotalWordSeconds(dur);
        // Seed the countdown only on a fresh start; this runs on every reload,
        // and must never reset a running or paused countdown
        if (deadlineRef.current === null && pausedLeftMsRef.current === null) {
          timerSecondsLeftRef.current = dur;
        }
      }

      // Restore braille display state
      const restoredChunks = wordToChunks(pos.word);
      setChunks(restoredChunks);
      setChunkIndex(pos.chunkIndex ?? 0);
      setWordSent(true);

      // Restore active / completed word state. If the word went up more than
      // 60 s ago, the device's own safety timer has already lowered it.
      const ageMs = pos.sentAt ? Date.now() - pos.sentAt : 0;
      const expired = !!pos.activeWordId && ageMs >= 60000;
      const restoredActiveId = expired ? null : pos.activeWordId ?? null;
      setActiveWordId(restoredActiveId);
      activeWordIdRef.current = restoredActiveId;
      if (pos.completedWordIds?.length) {
        const cSet = new Set(pos.completedWordIds);
        setCompletedWordIds(cSet);
        completedWordIdsRef.current = cSet;
      }

      const activeType = sessionObj?.type ?? session?.type;
      const activeStatus = sessionObj?.status ?? session?.status;

      // Only re-fill the manual input when not active and NOT in a live session
      if (!restoredActiveId && !isLiveSession(activeType)) {
        setManualWord(pos.word);
      }

      // Restore lastSentWord so the Paused card always shows the correct word
      setLastSentWord(pos.word);
      lastSentWordRef.current = pos.word;

      // If this is an active live session word that was restored, restart safety kill-switch
      if (
        restoredActiveId &&
        isLiveSession(activeType) &&
        activeStatus === "in_progress"
      ) {
        startLiveSafetyTimer(pos.sentAt ? Math.max(1000, 60000 - ageMs) : 60000);
      }
    } catch {
      // Silently ignore storage errors
    }
  }

  // ── Persist word position to AsyncStorage ─────────────────────────────────
  async function saveWordPosition(
    sessionId: string,
    word: string,
    chunkIndex: number,
    opts?: { activeWordId?: string | null; completedWordIds?: Set<string> },
  ) {
    try {
      await AsyncStorage.setItem(
        `session_word_pos_${sessionId}`,
        JSON.stringify({
          word,
          chunkIndex,
          activeWordId: opts?.activeWordId ?? null,
          completedWordIds: opts?.completedWordIds ? [...opts.completedWordIds] : [],
          sentAt: opts?.activeWordId ? Date.now() : null, // when the dots went up
        }),
      );
    } catch {
      // Silently ignore storage errors
    }
  }

  // ── Data loading on mount + every re-focus ──────────────────────────────────
  // FIX (nav-audit): A useEffect(() => { loadData() }, [loadData]) was removed
  // from here. It was redundant because useFocusEffect already fires loadData()
  // on the initial mount, AND again every time the screen re-gains focus (e.g.
  // after returning from add-word or switching back from another tab).
  // Having both running simultaneously on mount created a race condition:
  // two concurrent async fetches both called setLoading(true) then raced to
  // call setLoading(false) + setSession(), with the slower one silently
  // discarding the faster one's state update.
  //
  // On blur (navigating away): the cleanup fn auto-pauses an in_progress session.
  useFocusEffect(
    useCallback(() => {
      loadData();
      return () => {
        stopLiveSafetyTimer();
        if (sessionStatusRef.current === "in_progress") {
          // Hardware safety: release solenoids when leaving the screen
          clearDevicesRef.current("session_paused");
          // Fire-and-forget — no await in cleanup
          updateOrQueue("sessions", { status: "paused" }, { id: id! });
        }
      };
    }, [loadData, id])
  );

  // ── Realtime subscriptions ──────────────────────────────────────────────────
  // FIX: supabase.channel("name") returns the CACHED existing channel object if
  // a channel with that name is still alive in Supabase's internal registry
  // (removeChannel is async — the old channel may still be unsubscribing when
  // the component remounts). Calling .on() on an already-subscribed channel
  // immediately throws "cannot add postgres_changes callbacks after subscribe()".
  //
  // Solution: append Date.now() so every effect invocation gets a guaranteed
  // unique channel name. Supabase then always creates a fresh channel, making
  // the in-flight cleanup of the previous one completely irrelevant.
  //
  // The realtimeChannelRef guard has been removed — it only protected against
  // the same effect instance double-subscribing (which React Strict Mode can
  // trigger), but it did not protect against Supabase's channel cache. With
  // unique names, Strict Mode double-invocation is also safe: each run gets
  // its own name, and the cleanup correctly removes only that specific channel.
  useEffect(() => {
    if (!id) return;

    // Unique channel name per mount — never collides with a stale cached channel.
    const channelName = `session-detail-${id}-${Date.now()}`;

    const channel = supabase
      .channel(channelName)
      // Session row changes (status, started_at, finished_at)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "sessions", filter: `id=eq.${id}` },
        (payload) => {
          setSession((prev) => prev ? { ...prev, ...(payload.new as Session) } : prev);
        }
      )
      // New word attempts (student responses appear live during a session)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "word_attempts", filter: `session_id=eq.${id}` },
        (payload) => {
          const attempt = payload.new as WordAttempt;
          setLiveAttempts((prev) =>
            prev.some((a) => a.id === attempt.id) ? prev : [attempt, ...prev]
          );
        }
      )
      // One answer per student per word: a second voice answer (or the
      // transcript for a hand grade) UPDATES the existing row
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "word_attempts", filter: `session_id=eq.${id}` },
        (payload) => {
          const attempt = payload.new as WordAttempt;
          setLiveAttempts((prev) =>
            prev.some((a) => a.id === attempt.id)
              ? prev.map((a) => (a.id === attempt.id ? { ...a, ...attempt } : a))
              : [attempt, ...prev]
          );
        }
      )
      .subscribe();

    return () => {
      // Removes only THIS invocation's channel — the unique name ensures we
      // never accidentally remove a channel belonging to a newer mount.
      supabase.removeChannel(channel);
    };
  }, [id]);

  // Device connection-status changes (live dot colour and pairing updates),
  // only for the devices of this class — re-subscribes when that list changes
  const deviceIdsKey = allStudents
    .map((s) => s.device?.id)
    .filter((d): d is string => !!d)
    .sort()
    .join(",");
  useEffect(() => {
    if (!id || !deviceIdsKey) return;
    const channel = supabase
      .channel(`session-devices-${id}-${Date.now()}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "devices", filter: `id=in.(${deviceIdsKey})` },
        (payload) => {
          const updated = payload.new as {
            id: string;
            status: string;
            paired_student_id?: string | null;
            device_code?: string;
          };
          setAllStudents((prev) =>
            prev.map((s) => {
              if (updated.paired_student_id === s.id) {
                return {
                  ...s,
                  device: {
                    id: updated.id,
                    device_code: updated.device_code ?? s.device?.device_code ?? "",
                    status: updated.status,
                  },
                };
              }
              if (s.device?.id === updated.id) {
                if (updated.paired_student_id !== s.id) {
                  return { ...s, device: null };
                }
                return { ...s, device: { ...s.device, status: updated.status } };
              }
              return s;
            })
          );
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [id, deviceIdsKey]);


  // ── Earlier answers (so the feed survives an app reload) ───────────────────
  useEffect(() => {
    if (!id) return;
    supabase
      .from("word_attempts")
      .select("id, student_id, word, is_correct, response_time_ms, attempted_at, transcript, needs_review, audio_path, graded_by, session_word_id")
      .eq("session_id", id)
      .order("attempted_at", { ascending: false })
      .limit(200)
      .then(({ data }) => {
        if (!data) return;
        setLiveAttempts((prev) => {
          const seen = new Set(prev.map((a) => a.id));
          return [...prev, ...(data as WordAttempt[]).filter((a) => !seen.has(a.id))];
        });
      });
  }, [id]);

  // ── Teacher fallback grading ────────────────────────────────────────────────
  async function gradeByHand(
    student: Student,
    word: string,
    wordId: string | null,
    correct: boolean,
    existing: WordAttempt | null
  ) {
    const patch = { is_correct: correct, needs_review: false, graded_by: "teacher" };

    if (existing) {
      // Override the voice grade or "No answer" (or change your own earlier tap)
      setLiveAttempts((prev) => prev.map((a) => (a.id === existing.id ? { ...a, ...patch } : a)));
      const { error } = await updateOrQueue("word_attempts", patch, attemptMatch(existing));
      if (error) {
        setLiveAttempts((prev) => prev.map((a) => (a.id === existing.id ? existing : a)));
        showValidationToast("Couldn't save grade", error);
      }
      return;
    }

    // No answer yet → add one (id made here so an offline retry can't duplicate it)
    const wordUuid = asWordId(wordId);
    const row = {
      id: newId(),
      student_id: student.id,
      session_id: id!,
      word,
      session_word_id: wordUuid,
      response_time_ms: null,
      attempted_at: new Date().toISOString(),
      ...patch,
    };
    setLiveAttempts((prev) => [row, ...prev]);
    // One answer per student per word: if the voice grade got there first, the
    // insert is skipped and the grade below lands on that row instead
    const { error } = await insertOrQueue(
      "word_attempts",
      row,
      wordUuid ? { onConflict: "session_word_id,student_id" } : undefined
    );
    if (error) {
      setLiveAttempts((prev) => prev.filter((a) => a.id !== row.id));
      showValidationToast("Couldn't save grade", error);
      return;
    }
    if (wordUuid) {
      await updateOrQueue("word_attempts", patch, { session_word_id: wordUuid, student_id: student.id });
    }
  }

  // ── Word ended: "No answer" for assigned students who didn't answer ────────
  // Timed: when the word's time runs out. Live: Clear Display, the next word,
  // or Finish. Counts as wrong (is_correct false). Saved through the outbox
  // with an id made here, and ON CONFLICT (word, student) DO NOTHING, so a
  // retry never duplicates it and an answer already on the server is kept.
  // A later voice answer replaces it (grade-answer); a teacher's grade wins.
  const noAnswerSavedRef = useRef<Set<string>>(new Set()); // "wordId:studentId"
  async function recordNoAnswers(sw: { id: string; word: string } | null | undefined) {
    const wordId = asWordId(sw?.id);
    if (!sw || !wordId || !id) return;
    const rows = allStudents
      .filter((s) => assignedIds.has(s.id) && !!s.device)
      .filter(
        (s) =>
          !noAnswerSavedRef.current.has(`${wordId}:${s.id}`) &&
          !liveAttempts.some((a) => a.student_id === s.id && a.session_word_id === wordId)
      )
      .map((s) => ({
        id: newId(),
        student_id: s.id,
        session_id: id,
        word: sw.word.toUpperCase(),
        session_word_id: wordId,
        is_correct: false,
        needs_review: false,
        graded_by: "missed",
        response_time_ms: null,
        attempted_at: new Date().toISOString(),
      }));
    if (rows.length === 0) return;
    rows.forEach((r) => noAnswerSavedRef.current.add(`${wordId}:${r.student_id}`));
    setLiveAttempts((prev) => [...rows, ...prev]);

    let sentNow = false;
    for (const row of rows) {
      const { queued, error } = await insertOrQueue("word_attempts", row, {
        onConflict: "session_word_id,student_id",
      });
      if (error) {
        setLiveAttempts((prev) => prev.filter((a) => a.id !== row.id));
        noAnswerSavedRef.current.delete(`${wordId}:${row.student_id}`);
        logEvent("error", "no_answer_not_saved", `Couldn't save "No answer" for ${sw.word}: ${error}`, {
          session_id: id,
          meta: { session_word_id: wordId, student_id: row.student_id },
        });
      } else if (!queued) {
        sentNow = true;
      }
    }
    // An answer may have reached the server first (then the "No answer" row
    // wasn't added): show what the server has for this word
    if (sentNow) {
      const { data } = await supabase
        .from("word_attempts")
        .select("id, student_id, word, is_correct, response_time_ms, attempted_at, transcript, needs_review, audio_path, graded_by, session_word_id")
        .eq("session_word_id", wordId);
      if (data) {
        setLiveAttempts((prev) => [
          ...(data as WordAttempt[]),
          ...prev.filter((a) => a.session_word_id !== wordId),
        ]);
      }
    }
  }
  // The Timed Sequence timer runs in an interval made earlier: give it the latest
  const recordNoAnswersRef = useRef(recordNoAnswers);
  recordNoAnswersRef.current = recordNoAnswers;

  // Live: the word that ends when the next one is sent / the display is
  // cleared / the session finishes is the newest one sent
  const lastLiveWord = () => sessionWordsRef.current[sessionWordsRef.current.length - 1];

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
      const student = allStudents.find((s) => s.id === studentId);
      if (!student?.device) {
        showValidationToast(
          "No Device Paired",
          "This student cannot be selected because they do not have a paired hardware device."
        );
        return;
      }
      await supabase
        .from("session_students")
        .insert({ session_id: id, student_id: studentId });
      setAssignedIds((prev) => new Set(prev).add(studentId));
    }
  }

  async function removeWord(wordId: string, wordText?: string) {
    await supabase.from("session_words").delete().eq("id", wordId);
    setSessionWords((prev) => prev.filter((w) => w.id !== wordId));
    if (wordText) setRemoveWordToast({ word: wordText });
  }

  function deleteSession() {
    setDeleteSessionModal(true);
  }

  async function executeDeleteSession() {
    if (deletingSession) return; // already deleting (double tap)
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

  // ── Shuffle words in Timed Sequence (strictly available during 'pending') ───
  async function shuffleWords() {
    if (session?.status !== "pending" || sessionWords.length <= 1 || shuffling) {
      return;
    }

    const savedOrder = sessionWords; // put back if the new order can't be saved
    const shuffled = fisherYatesShuffle(sessionWords);
    const reindexed: SessionWord[] = shuffled.map((sw, index) => ({
      ...sw,
      order_index: index,
    }));

    // 1. Immediately update local state so teacher sees randomized order in UI
    setSessionWords(reindexed);
    sessionWordsRef.current = reindexed;

    // 2. Persist new order_index in background to Supabase
    setShuffling(true);
    const saveError = await saveWordOrder(id!, reindexed.map((sw) => sw.id));
    setShuffling(false);
    if (saveError) {
      // Back to the saved order right away (a reload can't fetch it while offline)
      setSessionWords(savedOrder);
      sessionWordsRef.current = savedOrder;
      logEvent("error", "shuffle_save_failed", `Shuffle not saved: ${saveError}`, {
        session_id: id ?? null,
      });
      showValidationToast("Couldn't save the new order", "The order is unchanged. Try shuffling again.");
    }
  }

  // ── Clear braille devices (releases physical solenoids to prevent burnout) ──
  async function clearDevices(commandType: string = "display_chunk") {
    const connectedDevices = allStudents
      .filter((s) => assignedIds.has(s.id) && !!s.device) // status may be stale: clear them all
      .map((s) => s.device!.id);

    if (connectedDevices.length === 0) return;

    const commands = connectedDevices.map((device_id) => ({
      device_id,
      session_id: id,
      command_type: commandType,
      payload: {
        word: "",
        chunk: "",
        chunk_index: 0,
        total_chunks: 1,
      },
    }));
    const { error } = await supabase.from("device_commands").insert(commands);
    clearFailedRef.current = !!error;
    if (error) {
      logEvent("error", "device_command_failed", `Could not clear devices (${commandType}): ${error.message}`, {
        session_id: id ?? null,
        meta: { command_type: commandType, devices: connectedDevices },
      });
    }
  }
  clearDevicesRef.current = clearDevices;

  // ── Live Session: Safety Kill-Switch Trigger ────────────────────────────────
  // Automatically triggers after 60s if the teacher hasn't manually clicked
  // 'Clear Display', releasing solenoids to prevent burnout and notifying the teacher.
  async function triggerSafetyAutoClear() {
    liveSafetyTimerRef.current = null;
    logEvent("warn", "safety_auto_clear", `Display auto-cleared after 60s ("${lastSentWordRef.current}")`, {
      session_id: id ?? null,
      meta: { word: lastSentWordRef.current },
    });
    await clearDevices();
    const currentActiveId = activeWordIdRef.current;
    if (currentActiveId) {
      setCompletedWordIds((prev) => {
        const next = new Set(prev).add(currentActiveId);
        completedWordIdsRef.current = next;
        return next;
      });
    }
    setActiveWordId(null);
    activeWordIdRef.current = null;
    setWordSent(false);
    setChunks([]);

    if (id && lastSentWordRef.current) {
      await saveWordPosition(id, lastSentWordRef.current, 0, {
        activeWordId: null,
        completedWordIds: completedWordIdsRef.current,
      });
    }

    setSafetyToast({
      visible: true,
      message: "Display auto-cleared for hardware safety",
      detail: "Solenoids released after 60s inactivity",
    });
  }

  function startLiveSafetyTimer(ms = 60000) {
    if (liveSafetyTimerRef.current) {
      clearTimeout(liveSafetyTimerRef.current);
    }
    liveSafetyTimerRef.current = setTimeout(() => {
      triggerSafetyAutoClear();
    }, ms);
  }

  function stopLiveSafetyTimer() {
    if (liveSafetyTimerRef.current) {
      clearTimeout(liveSafetyTimerRef.current);
      liveSafetyTimerRef.current = null;
    }
  }

  // ── Live Session: Manual Clear Display (Teacher Pacing Control) ──────────────
  // Triggered when teacher clicks 'Clear Display' when the student is done reading.
  // Instantly drops solenoids, stops the 60s timer, marks word completed, and
  // restores the text input for the next word.
  async function handleClearDisplay() {
    stopLiveSafetyTimer();
    await clearDevices();
    recordNoAnswers(lastLiveWord()); // the word is over
    if (activeWordId) {
      const newCompleted = new Set(completedWordIds).add(activeWordId);
      setCompletedWordIds(newCompleted);
      completedWordIdsRef.current = newCompleted;
    }
    setActiveWordId(null);
    activeWordIdRef.current = null;
    setWordSent(false);
    setChunks([]);
    setManualWord("");

    if (id && lastSentWord) {
      await saveWordPosition(id, lastSentWord, chunkIndex, {
        activeWordId: null,
        completedWordIds: completedWordIdsRef.current,
      });
    }
  }

  // ── Per-word duration stepper logic (strictly 5s - 60s hard-capped) ─────────
  async function updateWordDuration(wordId: string, newSec: number) {
    const clamped = clampDuration(newSec);
    const before = sessionWords.find((w) => w.id === wordId)?.duration_seconds;
    setSessionWords((prev) =>
      prev.map((w) => (w.id === wordId ? { ...w, duration_seconds: clamped } : w))
    );

    if (id) {
      const cached = await loadWordDurations(id);
      cached[wordId] = clamped;
      await saveWordDurations(id, cached);
    }

    // Offline: saved on the phone and sent when the connection is back
    const { error } = await updateOrQueue("session_words", { duration_seconds: clamped }, { id: wordId });
    if (error) {
      setSessionWords((prev) =>
        prev.map((w) => (w.id === wordId ? { ...w, duration_seconds: before } : w))
      );
      showValidationToast("Couldn't save the time", error);
    }
  }

  // ── Auto-cycle word transition helper ──────────────────────────────────────
  async function advanceToWord(newIdx: number, autoPlay = true) {
    const words = sessionWordsRef.current;
    if (newIdx < 0 || newIdx >= words.length) return;
    await clearDevices();
    const targetWord = words[newIdx];
    const dur = clampDuration(
      targetWord.duration_seconds ?? DEFAULT_WORD_DURATION_SEC
    );
    isCooldownRef.current = false;
    wordListIndexRef.current = newIdx;
    startCountdown(dur);
    setIsCooldown(false);
    setWordListIndex(newIdx);
    setTotalWordSeconds(dur);
    if (id) {
      await saveWordPosition(id, targetWord.word, 0);
    }
    await doSendWord(targetWord.word);
    if (autoPlay) {
      setIsPlaying(true);
    }
  }

  // ── Timed Sequence Auto-Cycle Interval Engine ───────────────────────────────
  useEffect(() => {
    if (
      session?.status !== "in_progress" ||
      !isTimedSequence(session?.type) ||
      !isPlaying ||
      sessionWords.length === 0
    ) {
      if (autoCycleTimer.current) {
        clearInterval(autoCycleTimer.current);
        autoCycleTimer.current = null;
      }
      return;
    }

    // (Re)start where it stopped: the time left at the pause, or on a fresh
    // start / app reload the seconds already set for this word
    if (deadlineRef.current === null) {
      deadlineRef.current =
        Date.now() + (pausedLeftMsRef.current ?? timerSecondsLeftRef.current * 1000);
      pausedLeftMsRef.current = null;
    }

    autoCycleTimer.current = setInterval(() => {
      if ((deadlineRef.current ?? 0) - Date.now() <= 0) {
        if (isCooldownRef.current) {
          // ── Cooldown phase completed: advance to next word ──
          isCooldownRef.current = false;
          setIsCooldown(false);
          const currentIdx = wordListIndexRef.current;
          const words = sessionWordsRef.current;
          const nextIdx = currentIdx + 1;

          if (nextIdx < words.length) {
            const nextDur = clampDuration(
              words[nextIdx]?.duration_seconds ?? DEFAULT_WORD_DURATION_SEC
            );
            startCountdown(nextDur); // now, so the next tick can't fire this again
            advanceToWord(nextIdx, true);
          } else {
            // Safety fallback: if no next word, auto-finish
            if (autoCycleTimer.current) {
              clearInterval(autoCycleTimer.current);
              autoCycleTimer.current = null;
            }
            executeFinishSession();
          }
        } else {
          // ── Word active duration completed ──
          clearDevices(); // Immediately de-energize solenoids

          const currentIdx = wordListIndexRef.current;
          const words = sessionWordsRef.current;
          const nextIdx = currentIdx + 1;
          recordNoAnswersRef.current(words[currentIdx]); // time's up: "No answer" for the rest

          if (nextIdx < words.length) {
            // Enter 10-second hardware cooldown phase
            isCooldownRef.current = true;
            setIsCooldown(true);
            setTotalWordSeconds(COOLDOWN_DURATION_SEC);
            startCountdown(COOLDOWN_DURATION_SEC);
          } else {
            // Final word in sequence completed active duration:
            // No cooldown needed after the last word -> Auto-finish session!
            if (autoCycleTimer.current) {
              clearInterval(autoCycleTimer.current);
              autoCycleTimer.current = null;
            }
            executeFinishSession();
          }
        }
      }
    }, 250);

    return () => {
      if (autoCycleTimer.current) {
        clearInterval(autoCycleTimer.current);
        autoCycleTimer.current = null;
      }
      // Stopped (pause, Pause Timer, background, leaving, finish): keep what was left
      if (deadlineRef.current !== null) {
        pausedLeftMsRef.current = Math.max(0, deadlineRef.current - Date.now());
        deadlineRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.status, session?.type, isPlaying, sessionWords.length]);

  // ── Session lifecycle ───────────────────────────────────────────────────────

  async function launchSession() {
    if (!isOnline()) {
      showValidationToast("You're offline", "Connect to the internet to launch.");
      return;
    }
    const validAssigned = allStudents.filter(
      (s) => assignedIds.has(s.id) && !!s.device
    );
    if (validAssigned.length === 0) {
      if (assignedIds.size === 0) {
        showValidationToast("No students assigned", "Assign at least one student before launching.");
      } else {
        showValidationToast("No device paired", "At least one selected student must have a paired hardware device.");
      }
      return;
    }
    if (isTimedSequence(session?.type) && sessionWords.length === 0) {
      showValidationToast("No words in sequence", "Add at least one word before launching.");
      return;
    }

    // At least one device must be ON (devices report themselves via presence)
    const onlineAssigned = validAssigned.filter((s) => s.device?.status === "connected");
    if (onlineAssigned.length === 0) {
      showValidationToast(
        "No devices online",
        "Turn on at least one student's device, wait for its ready sound, then launch."
      );
      return;
    }
    const offlineCodes = validAssigned
      .filter((s) => s.device?.status !== "connected")
      .map((s) => s.device?.device_code ?? "?");
    if (offlineCodes.length > 0) {
      showValidationToast(
        `${offlineCodes.join(", ")} offline`,
        "Launching anyway — they'll get the current word when they turn on."
      );
    }

    // ── Pre-flight check: block if another session is already active ──────────
    // A "pending" session can only be started when no other session (owned by
    // this teacher) is currently in_progress, paused, or active. Exclude the
    // current session itself in case of edge-case double-taps.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { count } = await supabase
        .from("sessions")
        .select("id", { count: "exact", head: true })
        .eq("teacher_id", user.id)
        .in("status", ["in_progress", "paused", "active"])
        .neq("id", id!);
      if ((count ?? 0) > 0) {
        showValidationToast(
          "Cannot start: Another session is already active. Please end it first."
        );
        return;
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    setSaving(true);
    await supabase
      .from("sessions")
      .update({ status: "in_progress", started_at: new Date().toISOString() })
      .eq("id", id!);
    await loadData();
    await clearDevices("session_started"); // start sound on every device

    // If timed sequence, start word 0 immediately with its clamped duration
    if (isTimedSequence(session?.type) && sessionWords.length > 0) {
      const firstWord = sessionWords[0];
      const dur = clampDuration(firstWord.duration_seconds ?? DEFAULT_WORD_DURATION_SEC);
      isCooldownRef.current = false;
      wordListIndexRef.current = 0;
      startCountdown(dur);
      setIsCooldown(false);
      setWordListIndex(0);
      setTotalWordSeconds(dur);
      setIsPlaying(true);
      await doSendWord(firstWord.word);
    }

    setSaving(false);
  }

  async function pauseSession(auto = false) {
    // Fix 5: eagerly update the ref so the useFocusEffect cleanup callback
    // (which fires on immediate navigation after a manual pause) reads the
    // correct status and does not double-fire the DB update.
    sessionStatusRef.current = "paused";
    setIsPlaying(false);
    stopLiveSafetyTimer();
    if (autoCycleTimer.current) {
      clearInterval(autoCycleTimer.current);
      autoCycleTimer.current = null;
    }
    await clearDevices("session_paused"); // Release solenoids + pause sound
    await updateOrQueue("sessions", { status: "paused" }, { id: id! });
    // [REALTIME] Send pause command to all devices
    if (!auto) await loadData();
    else setSession((prev) => (prev ? { ...prev, status: "paused" } : prev));
  }

  async function resumeSession() {
    if (!isOnline()) {
      showValidationToast("You're offline", "Connect to the internet to resume.");
      return;
    }
    // Pre-flight check: block if another session is already active
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { count } = await supabase
        .from("sessions")
        .select("id", { count: "exact", head: true })
        .eq("teacher_id", user.id)
        .in("status", ["in_progress", "paused", "active"])
        .neq("id", id!);
      if ((count ?? 0) > 0) {
        showValidationToast(
          "Cannot start: Another session is already active. Please end it first."
        );
        return;
      }
    }

    // Fix 6: eagerly update the ref so that any race between resume and
    // immediate navigation is handled correctly (the cleanup will see
    // in_progress and will re-pause, which is the desired behaviour).
    sessionStatusRef.current = "in_progress";
    await supabase
      .from("sessions")
      .update({ status: "in_progress" })
      .eq("id", id!);
    await loadData();
    await clearDevices("session_resumed"); // resume sound on every device

    if (isTimedSequence(session?.type) && sessionWords.length > 0) {
      const currentIdx = Math.min(sessionWords.length - 1, Math.max(0, wordListIndex));
      const currentWord = sessionWords[currentIdx];
      const dur = clampDuration(currentWord.duration_seconds ?? DEFAULT_WORD_DURATION_SEC);
      // Pick up where it was paused, with the time that was left
      if (isCooldownRef.current) {
        setIsPlaying(true); // the break continues; the display stays clear
      } else {
        if (pausedLeftMsRef.current === null && deadlineRef.current === null) {
          // nothing to pick up (e.g. the app was restarted): the whole word
          setTotalWordSeconds(dur);
          startCountdown(dur);
        }
        setIsPlaying(true);
        await doSendWord(currentWord.word);
      }
    } else if (isLiveSession(session?.type) && activeWordId && lastSentWord) {
      const liveChunks = wordToChunks(lastSentWord);
      // Resume on chunk 0 on hardware — teacher local chunk navigation is decoupled
      await broadcastChunk(liveChunks, 0, lastSentWord);
      startLiveSafetyTimer();
    }
  }

  function confirmFinish() {
    setFinishSessionModal(true);
  }

  async function executeFinishSession() {
    setFinishingSession(true);
    setIsPlaying(false);
    setIsCooldown(false);
    isCooldownRef.current = false;
    stopLiveSafetyTimer();
    if (autoCycleTimer.current) {
      clearInterval(autoCycleTimer.current);
      autoCycleTimer.current = null;
    }
    await clearDevices("session_finished"); // Release solenoids + finish sound
    if (isLiveSession(session?.type)) await recordNoAnswers(lastLiveWord()); // the last word is over
    setActiveWordId(null);
    activeWordIdRef.current = null;
    setWordSent(false);
    setChunks([]);

    const sessionName = session?.name ?? "Session";
    // Instantly transition to finished view
    setSession((prev) => (prev ? { ...prev, status: "finished" } : prev));
    sessionStatusRef.current = "finished";
    await updateOrQueue(
      "sessions",
      { status: "finished", finished_at: new Date().toISOString() },
      { id: id! }
    );
    await loadData();
    setFinishingSession(false);
    setFinishSessionModal(false);
    setFinishToast({ name: sessionName });
  }

  // ── Send word to devices ────────────────────────────────────────────────────

  async function sendWord(word: string) {
    if (!isOnline()) {
      showValidationToast("You're offline", "Connect to the internet to send words.");
      return;
    }
    // Input Validation: Enforce strict A-Z only validation to prevent symbol errors
    const sanitized = word.replace(/[^a-zA-Z]/g, "").trim().toUpperCase();
    if (!sanitized || !isValidWord(sanitized)) {
      showValidationToast("Invalid word", "Only letters A–Z are supported.");
      return;
    }
    // Duplicate check — show confirm modal instead of silently re-sending
    if (sentWords.has(sanitized)) {
      setDupWord(sanitized);
      setDupWordModal(true);
      return;
    }
    await doSendWord(sanitized);
  }

  function openWordBank() {
    setBankSearch("");
    setWordBankSheet(true);
    reloadWordBank();
  }

  // A Word Bank word goes through sendWord(), exactly like a typed one
  // (A–Z check, offline check, "Already sent" prompt)
  async function pickBankWord(word: string) {
    setWordBankSheet(false);
    // Like the typed input, which is hidden while a word is on the display
    if (activeWordIdRef.current) {
      showValidationToast("A word is still on the display", "Tap Clear Display first, then pick the next word.");
      return;
    }
    await sendWord(word);
  }

  // Internal: broadcasts the word; also called on "Re-send Anyway"
  async function doSendWord(w: string) {
    let wordId: string | null = null;

    // Database Persistence: Immediately execute Supabase INSERT into session_words table
    // tied to current session_id. This ensures words appear in the Finished summary.
    if (isLiveSession(session?.type)) {
      // Sending the next word ends the previous one (e.g. after the 60 s auto-clear)
      recordNoAnswers(lastLiveWord());
      const orderIdx = sessionWords.length;
      let insertedWord: SessionWord | null = null;

      try {
        const { data, error } = await supabase
          .from("session_words")
          .insert({
            session_id: id,
            word: w,
            order_index: orderIdx,
            duration_seconds: DEFAULT_WORD_DURATION_SEC,
          })
          .select("id, word, order_index, duration_seconds")
          .maybeSingle();

        if (error) {
          // Fallback if duration_seconds column does not exist
          const { data: fallbackData, error: fallbackError } = await supabase
            .from("session_words")
            .insert({
              session_id: id,
              word: w,
              order_index: orderIdx,
            })
            .select("id, word, order_index")
            .maybeSingle();

          if (fallbackData) {
            insertedWord = {
              id: fallbackData.id,
              word: fallbackData.word,
              order_index: fallbackData.order_index,
              duration_seconds: DEFAULT_WORD_DURATION_SEC,
            };
          } else if (fallbackError) {
            console.error("Failed to insert into session_words:", fallbackError.message);
          }
        } else if (data) {
          insertedWord = {
            id: data.id,
            word: data.word,
            order_index: data.order_index,
            duration_seconds: data.duration_seconds ?? DEFAULT_WORD_DURATION_SEC,
          };
        }
      } catch (err) {
        console.error("Error inserting into session_words:", err);
      }

      const finalWord: SessionWord = insertedWord ?? {
        id: `live_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        word: w,
        order_index: orderIdx,
        duration_seconds: DEFAULT_WORD_DURATION_SEC,
      };

      setSessionWords((prev) => [...prev, finalWord]);
      sessionWordsRef.current = [...sessionWordsRef.current, finalWord];
      wordId = finalWord.id;

      // 60-Second Safety Kill-Switch: Start hidden 60-second hardware burnout protection timer
      startLiveSafetyTimer();
    } else {
      // Timed sequence word list
      const existing = sessionWords.find((sw) => sw.word === w);
      wordId = existing?.id ?? null;
    }

    sentWords.add(w);
    setLastSentWord(w);
    lastSentWordRef.current = w;
    const newChunks = wordToChunks(w);
    setChunks(newChunks);
    setChunkIndex(0);
    setWordSent(true);

    // Clear the input and mark this word as the active one
    setManualWord("");
    if (wordId) {
      setActiveWordId(wordId);
      activeWordIdRef.current = wordId;
    }

    await saveWordPosition(id!, w, 0, {
      activeWordId: wordId,
      completedWordIds,
    });
    await broadcastChunk(newChunks, 0, w);
  }

  async function goToChunk(newIdx: number) {
    if (newIdx < 0 || newIdx >= chunks.length) return;
    setChunkIndex(newIdx);
    const word =
      isLiveSession(session?.type)
        ? lastSentWord
        : (sessionWords[wordListIndex]?.word ?? "");
    // Persist chunk position locally so resume shows the exact chunk on teacher UI
    // Decoupled from hardware: does NOT broadcast to student devices
    await saveWordPosition(id!, word, newIdx, { activeWordId, completedWordIds });
  }

  async function broadcastChunk(chunkArr: string[], idx: number, word: string) {
    const connectedDevices = allStudents
      .filter((s) => assignedIds.has(s.id) && !!s.device) // a stale "offline" must not skip a device
      .map((s) => s.device!.id);

    if (connectedDevices.length === 0) return; // no paired devices, UI still shows

    // [REALTIME] ESP32 listens to device_commands via Supabase Realtime
    const commands = connectedDevices.map((device_id) => ({
      device_id,
      session_id: id,
      command_type: "display_chunk" as const,
      payload: {
        word,
        session_word_id: asWordId(activeWordIdRef.current),
        chunk: chunkArr[idx],
        chunk_index: idx,
        total_chunks: chunkArr.length,
      },
    }));
    const { error } = await supabase.from("device_commands").insert(commands);
    if (error) {
      logEvent("error", "device_command_failed", `Could not send "${word}" to devices: ${error.message}`, {
        session_id: id ?? null,
        meta: { word, chunk: chunkArr[idx], devices: connectedDevices },
      });
    }
  }

  // ── Render helpers ──────────────────────────────────────────────────────────

  async function openStudentStats(student: Student) {
    setStatsData(null);
    setLoadingStats(true);
    setStatsModal(true);
    const { data } = await supabase
      .from("word_attempts")
      .select("id, word, is_correct, response_time_ms, attempted_at, transcript, needs_review, audio_path, graded_by, session_word_id")
      .eq("student_id", student.id)
      .eq("session_id", id!)
      .order("attempted_at", { ascending: true });
    setStatsData({ student, attempts: data ?? [] });
    setLoadingStats(false);
  }

  // Teacher manually corrects an auto-graded answer
  async function overrideAttempt(attempt: WordAttempt, correct: boolean) {
    const patch = { is_correct: correct, needs_review: false, graded_by: "teacher" };
    setStatsData((prev) =>
      prev
        ? {
            ...prev,
            attempts: prev.attempts.map((a) =>
              a.id === attempt.id ? { ...a, ...patch } : a
            ),
          }
        : prev
    );
    const { error } = await updateOrQueue("word_attempts", patch, attemptMatch(attempt));
    if (error) {
      console.error("Override failed:", error);
      if (statsData) openStudentStats(statsData.student); // reload real values
    }
  }

  const assignedStudents = allStudents.filter((s) => assignedIds.has(s.id));
  const studentName = (sid?: string | null) =>
    allStudents.find((s) => s.id === sid)?.full_name.split(" ")[0] ?? "—";
  const validPairedAssignedCount = allStudents.filter(
    (s) => assignedIds.has(s.id) && !!s.device
  ).length;

  // What's still needed before Launch Session can be tapped
  const launchMissing: string[] = [];
  if (isTimedSequence(session?.type) && sessionWords.length === 0) {
    launchMissing.push("add at least one word");
  }
  if (validPairedAssignedCount === 0) {
    launchMissing.push(
      assignedIds.size === 0
        ? "assign a student with a paired device"
        : "pair a device to an assigned student"
    );
  }
  const launchBlocked = launchMissing.length > 0;

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.center}>
          <BrailleLoader size={16} />
        </View>
      </SafeAreaView>
    );
  }

  // Guard: session couldn't be loaded (deleted externally, bad id, network error).
  // Show a recoverable error instead of a black screen.
  if (!session) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={40} color={C.muted} />
          <Text style={[styles.emptyHint, { marginTop: 10, textAlign: "center" }]}>
            Session not found.{"\n"}It may have been deleted or failed to load.
          </Text>
          <Pressable
            onPress={() => router.back()}
            style={({ pressed }) => [
              styles.launchBtn,
              { marginTop: 16, paddingHorizontal: 24 },
              pressed && { opacity: 0.8 },
            ]}
          >
            <Ionicons name="arrow-back" size={16} color="#1A1200" />
            <Text style={styles.launchBtnText}>Go Back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

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

  // ── WORD BANK SHEET (Live Session) ──────────────────────────────────────────
  const bankMatches = filterWordBank(bankWords, bankSearch);
  const WordBankSheet = (
    <Modal
      visible={wordBankSheet}
      animationType="slide"
      transparent
      onRequestClose={() => setWordBankSheet(false)}
    >
      <View style={styles.modalOverlay}>
        <Pressable style={styles.backdrop} onPress={() => setWordBankSheet(false)} />
        <View style={[styles.sheet, styles.bankSheet]}>
          <View style={styles.handle} />
          <Text style={styles.sheetTitle}>Word Bank</Text>
          <View style={styles.bankSearchRow}>
            <Ionicons name="search-outline" size={16} color={C.muted} />
            <TextInput
              style={styles.bankSearchInput}
              value={bankSearch}
              onChangeText={setBankSearch}
              placeholder="Search words..."
              placeholderTextColor={C.muted}
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="search"
            />
            {bankSearch.length > 0 && (
              <Pressable onPress={() => setBankSearch("")} hitSlop={8} accessibilityLabel="Clear search">
                <Ionicons name="close-circle" size={16} color={C.muted} />
              </Pressable>
            )}
          </View>
          {loadingBank && bankWords.length === 0 ? (
            <ActivityIndicator color={C.navy} style={{ marginTop: 24 }} />
          ) : bankMatches.length === 0 ? (
            <Text style={styles.emptyHint}>
              {bankError && bankWords.length === 0
                ? "Couldn't load the Word Bank. Check your connection and try again."
                : bankWords.length === 0
                ? "Your Word Bank is empty. Add words in the Word Bank tab."
                : "No matching words."}
            </Text>
          ) : (
            <FlatList
              data={bankMatches}
              keyExtractor={(w) => w.id}
              style={{ flex: 1 }}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ gap: 8, paddingBottom: 8 }}
              renderItem={({ item }) => {
                const sent = sentWords.has(item.word.toUpperCase());
                return (
                  <Pressable
                    onPress={() => pickBankWord(item.word)}
                    style={({ pressed }) => [styles.bankRow, pressed && { opacity: 0.7 }]}
                    accessibilityRole="button"
                    accessibilityLabel={`Send ${item.word}${sent ? ", already sent" : ""}`}
                  >
                    <Text style={styles.bankRowWord}>{item.word.toUpperCase()}</Text>
                    {item.shared && <Text style={styles.bankRowTag}>Shared</Text>}
                    {sent && <Text style={[styles.bankRowTag, { color: C.brown }]}>Sent</Text>}
                    <View style={{ flex: 1 }} />
                    <Ionicons name="send" size={14} color={C.navy} />
                  </Pressable>
                );
              }}
            />
          )}
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
          <View style={styles.sheetActions}>
            <Pressable
              onPress={executeDeleteSession}
              disabled={deletingSession}
              style={({ pressed }) => [
                styles.sheetBtn,
                styles.btnDestructive,
                deletingSession && styles.btnDestructiveDisabled,
                pressed && !deletingSession && { opacity: 0.85 },
              ]}
            >
              {deletingSession ? (
                <ActivityIndicator color={C.red} />
              ) : (
                <Text style={styles.btnDestructiveText}>Delete</Text>
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
                  {getSessionTypeLabel(session.type)}
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
            Only students with paired hardware devices can be selected for sessions.
          </Text>
          {allStudents.length === 0 ? (
            <Text style={styles.emptyHint}>
              No students yet — add them in the Students tab first.
            </Text>
          ) : (
            <View style={styles.studentGrid}>
              {allStudents.map((s) => {
                const assigned = assignedIds.has(s.id);
                const hasDevice = !!s.device;
                const statusColor = s.device
                  ? (DEVICE_COLOR[s.device.status] ?? C.muted)
                  : C.muted;
                return (
                  <Pressable
                    key={s.id}
                    onPress={() => toggleStudent(s.id)}
                    disabled={!hasDevice && !assigned}
                    style={({ pressed }) => [
                      styles.studentChip,
                      assigned && styles.studentChipActive,
                      !hasDevice && styles.studentChipDisabled,
                      pressed && (hasDevice || assigned) && { opacity: 0.8 },
                    ]}
                    accessibilityRole="checkbox"
                    accessibilityState={{
                      checked: assigned,
                      disabled: !hasDevice && !assigned,
                    }}
                    accessibilityLabel={`${s.full_name}, ${
                      !hasDevice
                        ? "No device paired, selection disabled"
                        : assigned
                        ? "Selected"
                        : "Not selected"
                    }`}
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
                        !hasDevice && styles.studentChipTextDisabled,
                      ]}
                    >
                      {s.full_name}
                    </Text>
                    {hasDevice ? (
                      <View
                        style={[
                          styles.statusDot,
                          { backgroundColor: statusColor },
                        ]}
                      />
                    ) : (
                      <View style={styles.noDeviceBadge}>
                        <Ionicons
                          name="alert-circle-outline"
                          size={11}
                          color={C.brown}
                        />
                        <Text style={styles.noDeviceBadgeText}>
                          No Device Paired
                        </Text>
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* Timed sequence builder (timed_sequence or legacy word_list) */}
          {isTimedSequence(session.type) && (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
                <Text style={styles.sectionLabel}>TIMED SEQUENCE</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  {sessionWords.length > 1 && (
                    <Pressable
                      onPress={shuffleWords}
                      disabled={shuffling}
                      hitSlop={6}
                      style={({ pressed }) => [
                        styles.shuffleHeaderBtn,
                        pressed && { opacity: 0.7 },
                        shuffling && { opacity: 0.5 },
                      ]}
                      accessibilityLabel="Shuffle word order"
                    >
                      <Ionicons name="shuffle" size={13} color={C.navy} />
                      <Text style={styles.shuffleHeaderBtnText}>
                        {shuffling ? "Shuffling..." : "Shuffle"}
                      </Text>
                    </Pressable>
                  )}
                  <View style={styles.safetyPill}>
                    <Ionicons name="shield-checkmark" size={12} color={C.green} />
                    <Text style={styles.safetyPillText}>5s – 60s limit</Text>
                  </View>
                </View>
              </View>
              <Text style={styles.sectionHint}>
                Set the active duration for each word before launching.
              </Text>

              {sessionWords.length > 0 && (
                <View style={styles.wordListContainer}>
                  {sessionWords.map((sw, i) => {
                    const dur = sw.duration_seconds ?? DEFAULT_WORD_DURATION_SEC;
                    return (
                      <View key={sw.id} style={styles.sequenceWordRow}>
                        <Text style={styles.wordIndex}>
                          {String(i + 1).padStart(2, "0")}
                        </Text>
                        <Text style={styles.sequenceWordText}>{sw.word}</Text>

                        {/* Per-word timer stepper: 5s to 60s hard-capped */}
                        <View style={styles.stepperWrap}>
                          <Pressable
                            onPress={() => updateWordDuration(sw.id, dur - 5)}
                            disabled={dur <= MIN_WORD_DURATION_SEC}
                            style={({ pressed }) => [
                              styles.stepperBtn,
                              dur <= MIN_WORD_DURATION_SEC && styles.stepperBtnDisabled,
                              pressed && { opacity: 0.6 },
                            ]}
                            hitSlop={4}
                            accessibilityLabel="Decrease duration by 5s"
                          >
                            <Ionicons
                              name="remove"
                              size={14}
                              color={dur <= MIN_WORD_DURATION_SEC ? C.border : C.navy}
                            />
                          </Pressable>
                          <View style={styles.stepperBadge}>
                            <Ionicons name="timer-outline" size={12} color={C.muted} />
                            <Text style={styles.stepperText}>{dur}s</Text>
                          </View>
                          <Pressable
                            onPress={() => updateWordDuration(sw.id, dur + 5)}
                            disabled={dur >= MAX_WORD_DURATION_SEC}
                            style={({ pressed }) => [
                              styles.stepperBtn,
                              dur >= MAX_WORD_DURATION_SEC && styles.stepperBtnDisabled,
                              pressed && { opacity: 0.6 },
                            ]}
                            hitSlop={4}
                            accessibilityLabel="Increase duration by 5s"
                          >
                            <Ionicons
                              name="add"
                              size={14}
                              color={dur >= MAX_WORD_DURATION_SEC ? C.border : C.navy}
                            />
                          </Pressable>
                        </View>

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
                    );
                  })}
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

              {/* Shuffle Words button right above the Launch Session button */}
              {sessionWords.length > 1 && (
                <Pressable
                  onPress={shuffleWords}
                  disabled={shuffling}
                  style={({ pressed }) => [
                    styles.shuffleWordsBtn,
                    pressed && { opacity: 0.85 },
                    shuffling && { opacity: 0.6 },
                  ]}
                  accessibilityLabel="Shuffle words"
                >
                  {shuffling ? (
                    <ActivityIndicator size="small" color={C.navy} />
                  ) : (
                    <Ionicons name="shuffle" size={18} color={C.navy} />
                  )}
                  <Text style={styles.shuffleWordsBtnText}>
                    {shuffling ? "Shuffling Words..." : "Shuffle Words"}
                  </Text>
                </Pressable>
              )}
            </>
          )}


          {/* Launch button */}
          <Pressable
            onPress={launchSession}
            disabled={saving || launchBlocked}
            style={({ pressed }) => [
              styles.launchBtn,
              launchBlocked && styles.launchBtnDisabled,
              saving && { opacity: 0.5 },
              pressed && !launchBlocked && { opacity: 0.85 },
            ]}
            accessibilityRole="button"
            accessibilityState={{ disabled: saving || launchBlocked }}
          >
            {saving ? (
              <ActivityIndicator color="#1A1200" />
            ) : (
              <>
                <Ionicons name="play" size={18} color={launchBlocked ? C.muted : "#1A1200"} />
                <Text style={[styles.launchBtnText, launchBlocked && { color: C.muted }]}>
                  Launch Session
                </Text>
              </>
            )}
          </Pressable>
          {launchBlocked && (
            <Text style={styles.launchHint}>
              To launch, {launchMissing.join(" and ")}.
            </Text>
          )}
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
                    if (wordToRemove) removeWord(wordToRemove.id, wordToRemove.word);
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

        {/* ── Remove-word success toast ───────────────────────────────────── */}
        <Toast
          message="Word removed from list"
          detail={removeWordToast?.word}
          visible={!!removeWordToast}
          variant="delete"
          onDismiss={() => setRemoveWordToast(null)}
        />

        {/* ── Validation toast (replaces Alert.alert for launch/word checks) ── */}
        <Toast
          message={validationToast.message}
          detail={validationToast.detail}
          visible={validationToast.visible}
          variant="delete"
          onDismiss={() => setValidationToast((t) => ({ ...t, visible: false }))}
        />

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
        <Toast
          message={validationToast.message}
          detail={validationToast.detail}
          visible={validationToast.visible}
          variant="delete"
          onDismiss={() => setValidationToast((t) => ({ ...t, visible: false }))}
        />
        <Toast
          message={safetyToast.message}
          detail={safetyToast.detail}
          visible={safetyToast.visible}
          variant="warning"
          duration={5000}
          onDismiss={() => setSafetyToast((prev) => ({ ...prev, visible: false }))}
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
            <View style={styles.infoRow}>
              <View
                style={[
                  styles.badge,
                  { backgroundColor: C.blueWash, alignSelf: "flex-start" },
                ]}
              >
                <Text style={[styles.badgeText, { color: C.navy }]}>
                  {getSessionTypeLabel(session.type)}
                </Text>
              </View>
              <View
                style={[
                  styles.badge,
                  { backgroundColor: C.greenBg, alignSelf: "flex-start" },
                ]}
              >
                <Text style={[styles.badgeText, { color: C.green }]}>
                  Finished
                </Text>
              </View>
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
                        // One result per word sent: the student's latest answer to it
                        const answers = sessionWords
                          .map((sw) => latestAttempt(attemptsForWord(statsData.attempts, sw)))
                          .filter((a): a is WordAttempt => !!a);
                        const graded  = answers.filter((a) => !a.needs_review);
                        const total   = graded.length;
                        const correct = graded.filter((a) => a.is_correct).length;
                        const pending = answers.length - graded.length;
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
                              <Text style={styles.statsChipLabel}>
                                {pending > 0 ? `Correct · ${pending} to review` : "Correct"}
                              </Text>
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
                    // The student's latest answer to THIS sending of the word
                    const attempt = latestAttempt(attemptsForWord(statsData.attempts, sw));
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

                        {/* Spoken input — recording + what Whisper heard */}
                        {attempt && attempt.graded_by !== "missed" ? (
                          <View style={{ flex: 2, flexDirection: "row", alignItems: "center", gap: 6 }}>
                            <PlayRecordingButton path={attempt.audio_path ?? null} />
                            <Text
                              numberOfLines={2}
                              style={[styles.reviewCell, {
                                flex: 1,
                                fontFamily: fonts.body,
                                color: STATUS_STYLE[attemptStatus(attempt)].fg,
                              }]}
                            >
                              {attempt.transcript
                                ? `"${cleanTranscript(attempt.transcript)}"`
                                : "(no transcript)"}
                            </Text>
                          </View>
                        ) : (
                          <View style={[styles.reviewVoicePlaceholder, { flex: 2 }]}>
                            <Ionicons name="mic-off-outline" size={11} color={C.muted} />
                            <Text style={styles.reviewVoicePlaceholderText}>
                              no answer
                            </Text>
                          </View>
                        )}

                        {/* Result + teacher override */}
                        <View style={{ flex: 1, alignItems: "center", gap: 4 }}>
                          {attempt ? (
                            <>
                              <View
                                style={[
                                  styles.resultBadge,
                                  { backgroundColor: STATUS_STYLE[attemptStatus(attempt)].bg },
                                ]}
                              >
                                <Text
                                  style={[
                                    styles.resultBadgeText,
                                    { color: STATUS_STYLE[attemptStatus(attempt)].fg },
                                  ]}
                                >
                                  {STATUS_STYLE[attemptStatus(attempt)].label}
                                </Text>
                              </View>
                              <View style={{ flexDirection: "row", gap: 6 }}>
                                <Pressable
                                  onPress={() => overrideAttempt(attempt, true)}
                                  hitSlop={6}
                                  style={({ pressed }) => [
                                    styles.overrideBtn,
                                    { borderColor: C.green },
                                    pressed && { opacity: 0.6 },
                                  ]}
                                  accessibilityLabel="Mark correct"
                                >
                                  <Ionicons name="checkmark" size={12} color={C.green} />
                                </Pressable>
                                <Pressable
                                  onPress={() => overrideAttempt(attempt, false)}
                                  hitSlop={6}
                                  style={({ pressed }) => [
                                    styles.overrideBtn,
                                    { borderColor: C.red },
                                    pressed && { opacity: 0.6 },
                                  ]}
                                  accessibilityLabel="Mark wrong"
                                >
                                  <Ionicons name="close" size={12} color={C.red} />
                                </Pressable>
                              </View>
                              {attempt.graded_by === "teacher" && (
                                <Text style={styles.teacherTag}>by teacher</Text>
                              )}
                            </>
                          ) : (
                            <View style={[styles.resultBadge, { backgroundColor: C.border }]}>
                              <Text style={[styles.resultBadgeText, { color: C.muted }]}>—</Text>
                            </View>
                          )}
                        </View>
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
      <ActiveSessionKeepAwake />
      {Header}
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Session name + purpose + status */}
        <View style={styles.activeHeader}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.sessionName}>{session.name}</Text>
            {session.purpose ? (
              <Text style={styles.activePurpose} numberOfLines={2}>
                {session.purpose}
              </Text>
            ) : null}
          </View>
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

        {/* ── LIVE SESSION: Teacher Pacing Control with 60s Safety Net ──────── */}
        {isLiveSession(session.type) && (
          <>
            {activeWordId ? (
              /* Active Word state: Input is hidden, replaced by prominent Clear Display button */
              <View style={[styles.sectionCard, styles.sectionCardActiveLive]}>
                <View style={styles.liveCardHeader}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Ionicons name="hardware-chip-outline" size={16} color={C.navy} />
                    <Text style={styles.cardLabel}>ACTIVE DISPLAY · STUDENT READING</Text>
                  </View>
                  <View style={styles.activeDisplayBadge}>
                    <Animated.View style={[styles.liveDot, { opacity: pulseAnim }]} />
                    <Text style={styles.activeDisplayBadgeText}>Displaying</Text>
                  </View>
                </View>

                {/* Hero card showing current word on device */}
                <View style={styles.activeLiveHero}>
                  <Text style={styles.activeLiveWordLabel}>WORD ON BRAILLE DISPLAY</Text>
                  <Text style={styles.activeLiveWordText}>{lastSentWord}</Text>
                  <Text style={styles.activeLiveWordSub}>
                    Solenoids are engaged. When the student is done reading, click below to clear the pins and type the next word.
                  </Text>
                </View>

                {/* Prominent Clear Display button (replaces text input) */}
                <Pressable
                  onPress={handleClearDisplay}
                  style={({ pressed }) => [
                    styles.clearDisplayBtn,
                    pressed && { opacity: 0.85 },
                  ]}
                  accessibilityLabel="Clear Display and Finish Word"
                >
                  <Ionicons name="stop-circle" size={20} color={C.white} />
                  <Text style={styles.clearDisplayBtnText}>Clear Display (Finish Word)</Text>
                </Pressable>
              </View>
            ) : (
              /* Ready for Next Word: Clean text input with strict A-Z validation */
              <View style={styles.sectionCard}>
                <View style={styles.liveCardHeader}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Ionicons name="hand-right-outline" size={16} color={C.navy} />
                    <Text style={styles.cardLabel}>LIVE SESSION · MANUAL PACING</Text>
                  </View>
                  <View style={styles.livePacingBadge}>
                    <Ionicons name="shield-checkmark" size={12} color={C.green} />
                    <Text style={styles.livePacingBadgeText}>60s Safety Net</Text>
                  </View>
                </View>

                <Text style={styles.liveControlHint}>
                  Type a word and send it to the braille display. You dictate the pace based on the student&apos;s progress.
                </Text>

                <View style={styles.sendRow}>
                  <TextInput
                    style={[styles.wordInput, { flex: 1 }]}
                    value={manualWord}
                    onChangeText={(v) => {
                      // Input Validation: Enforce strict A-Z only
                      setManualWord(v.replace(/[^a-zA-Z]/g, "").toUpperCase());
                      setWordSent(false);
                    }}
                    placeholder="TYPE WORD (A–Z)"
                    placeholderTextColor={C.muted}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    returnKeyType="send"
                    onSubmitEditing={() => {
                      if (manualWord.trim()) sendWord(manualWord);
                    }}
                  />
                  <Pressable
                    onPress={openWordBank}
                    style={({ pressed }) => [styles.bankBtn, pressed && { opacity: 0.7 }]}
                    accessibilityRole="button"
                    accessibilityLabel="Pick a word from the Word Bank"
                  >
                    <Ionicons name="library-outline" size={16} color={C.navy} />
                    <Text style={styles.bankBtnText}>Word Bank</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => sendWord(manualWord)}
                    disabled={!manualWord.trim()}
                    style={({ pressed }) => [
                      styles.sendBtn,
                      !manualWord.trim() && { opacity: 0.5 },
                      pressed && { opacity: 0.85 },
                    ]}
                    accessibilityLabel="Send word"
                  >
                    <Ionicons name="send" size={16} color="#1A1200" />
                    <Text style={styles.sendBtnText}>Send</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {/* Teacher fallback: grade the current word by hand */}
            <HandGradeCard
              word={lastSentWord}
              wordId={[...sessionWords].reverse().find((sw) => sw.word === lastSentWord)?.id ?? null}
              students={assignedStudents}
              attempts={liveAttempts}
              onGrade={gradeByHand}
            />

            {/* Words sent history + live student responses */}
            {sessionWords.length > 0 && (
              <View style={styles.sectionCard}>
                <Text style={styles.cardLabel}>WORDS SENT</Text>
                <View style={{ gap: 8 }}>
                  {[...sessionWords].reverse().map((sw, i) => {
                    const isActive = sw.id === activeWordId;
                    // Live: every sent word that's no longer on the display is done
                    const isDone = !isActive;
                    return (
                      <View
                        key={sw.id}
                        style={[
                          styles.historyRow,
                          isActive && styles.historyRowActive,
                          isDone && styles.historyRowDone,
                        ]}
                      >
                        <Text
                          style={[
                            styles.historyIndex,
                            isActive && { color: C.amber },
                            isDone && { color: C.green },
                          ]}
                        >
                          {String(sessionWords.length - i).padStart(2, "0")}
                        </Text>
                        <Text
                          style={[
                            styles.historyWord,
                            isActive && { color: C.brown },
                            isDone && { color: C.green },
                          ]}
                        >
                          {sw.word}
                        </Text>
                        {isActive && (
                          <View style={styles.activeWordBadge}>
                            <View style={styles.activeWordDot} />
                            <Text style={styles.activeWordBadgeText}>Active</Text>
                          </View>
                        )}
                        {isDone && !isActive && (
                          <View style={styles.doneWordBadge}>
                            <Ionicons name="checkmark" size={10} color={C.green} />
                            <Text style={styles.doneWordBadgeText}>Done</Text>
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
                          { backgroundColor: STATUS_STYLE[attemptStatus(a)].fg },
                        ]}
                      />
                      <Text style={hg.who} numberOfLines={1}>{studentName(a.student_id)}</Text>
                      <Text style={styles.historyWord}>{a.word}</Text>
                      <View style={{ flex: 1 }} />
                      <Text
                        style={[
                          styles.responseLabel,
                          { color: STATUS_STYLE[attemptStatus(a)].fg },
                        ]}
                      >
                        {STATUS_STYLE[attemptStatus(a)].short}
                        {a.transcript ? ` · "${cleanTranscript(a.transcript)}"` : ""}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
          </>
        )}

        {/* ── TIMED SEQUENCE: Auto-cycle playback engine ──────────── */}
        {isTimedSequence(session.type) && sessionWords.length > 0 && (
          <View style={styles.sectionCard}>
            <View style={styles.timedCardHeader}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Ionicons name="timer" size={16} color={C.navy} />
                <Text style={styles.cardLabel}>TIMED SEQUENCE · AUTO-CYCLE</Text>
              </View>
              <View
                style={[
                  styles.playbackStateBadge,
                  {
                    backgroundColor: isCooldown
                      ? C.blueWash
                      : isPlaying
                      ? C.greenBg
                      : C.brownBg,
                  },
                ]}
              >
                <View
                  style={[
                    styles.playbackStateDot,
                    {
                      backgroundColor: isCooldown
                        ? C.navy
                        : isPlaying
                        ? C.green
                        : C.amber,
                    },
                  ]}
                />
                <Text
                  style={[
                    styles.playbackStateText,
                    {
                      color: isCooldown
                        ? C.navy
                        : isPlaying
                        ? C.green
                        : C.brown,
                    },
                  ]}
                >
                  {isCooldown
                    ? "Student Break"
                    : isPlaying
                    ? "Auto-cycling"
                    : "Paused"}
                </Text>
              </View>
            </View>

            {/* Hero Word Card with Countdown & Progress */}
            {isCooldown ? (
              <View style={[styles.timedHeroBox, styles.timedHeroBoxCooldown]}>
                <View style={styles.cooldownHeaderRow}>
                  <Ionicons name="sparkles-outline" size={15} color={C.navy} />
                  <Text style={styles.cooldownBadgeText}>STUDENT BREAK</Text>
                </View>
                <Text style={styles.cooldownTitleText}>Student Break</Text>
                <Text style={styles.cooldownSubText}>
                  Get ready for the next word:{" "}
                  <Text style={styles.cooldownNextWordText}>
                    {sessionWords[wordListIndex + 1]?.word ?? "Next"}
                  </Text>
                </Text>

                <Countdown getLeftMs={getCountdownLeftMs}>
                {(timerSecondsLeft) => (<>
                {/* Visual progress bar for cooldown */}
                <View style={styles.progressBarTrack}>
                  <View
                    style={[
                      styles.progressBarFill,
                      styles.progressBarFillCooldown,
                      {
                        width: `${Math.max(
                          0,
                          Math.min(
                            100,
                            (timerSecondsLeft / COOLDOWN_DURATION_SEC) * 100
                          )
                        )}%`,
                      },
                    ]}
                  />
                </View>

                {/* Countdown counter & Solenoid safety badge */}
                <View style={styles.timerRow}>
                  <View style={styles.timerMain}>
                    <Ionicons name="time-outline" size={18} color={C.navy} />
                    <Text style={styles.timerNumber}>{timerSecondsLeft}s</Text>
                    <Text style={styles.timerUnit}>
                      remaining of {COOLDOWN_DURATION_SEC}s
                    </Text>
                  </View>

                  <View style={styles.hardwareLimitBadge}>
                    <Ionicons name="checkmark-circle-outline" size={12} color={C.green} />
                    <Text style={styles.hardwareLimitText}>Display Cleared</Text>
                  </View>
                </View>
                </>)}
                </Countdown>
              </View>
            ) : (
              <View style={styles.timedHeroBox}>
                <Text style={styles.wordDisplayIndex}>
                  Word {wordListIndex + 1} of {sessionWords.length}
                </Text>
                <Text style={styles.timedWordText}>
                  {sessionWords[wordListIndex]?.word}
                </Text>

                <Countdown getLeftMs={getCountdownLeftMs}>
                {(timerSecondsLeft) => (<>
                {/* Visual progress bar */}
                <View style={styles.progressBarTrack}>
                  <View
                    style={[
                      styles.progressBarFill,
                      {
                        width: `${Math.max(
                          0,
                          Math.min(
                            100,
                            (timerSecondsLeft / (totalWordSeconds || 1)) * 100
                          )
                        )}%`,
                      },
                    ]}
                  />
                </View>

                {/* Countdown counter & Solenoid safety badge */}
                <View style={styles.timerRow}>
                  <View style={styles.timerMain}>
                    <Ionicons name="time-outline" size={18} color={C.navy} />
                    <Text style={styles.timerNumber}>{timerSecondsLeft}s</Text>
                    <Text style={styles.timerUnit}>
                      remaining of {totalWordSeconds}s
                    </Text>
                  </View>

                  <View style={styles.hardwareLimitBadge}>
                    <Ionicons name="shield-outline" size={11} color={C.muted} />
                    <Text style={styles.hardwareLimitText}>Max 60s coil safe</Text>
                  </View>
                </View>
                </>)}
                </Countdown>

              </View>
            )}

            {/* Playback Controls Row: strictly automated flow (Pause/Resume only) */}
            <View style={styles.playbackControlsRow}>
              {/* Play / Pause Timer */}
              <Pressable
                onPress={async () => {
                  if (isPlaying) {
                    setIsPlaying(false);
                    await clearDevices(); // Drop coils while paused
                  } else {
                    setIsPlaying(true);
                    if (!isCooldown) {
                      const currentWord = sessionWords[wordListIndex];
                      if (currentWord) {
                        await doSendWord(currentWord.word);
                      }
                    }
                  }
                }}
                style={({ pressed }) => [
                  styles.playbackBtnPrimary,
                  pressed && { opacity: 0.85 },
                ]}
                accessibilityLabel={
                  isPlaying ? "Pause sequence timer" : "Resume sequence timer"
                }
              >
                <Ionicons
                  name={isPlaying ? "pause" : "play"}
                  size={20}
                  color="#1A1200"
                />
                <Text style={styles.playbackBtnPrimaryText}>
                  {isPlaying ? "Pause Timer" : "Resume Timer"}
                </Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* ── Timed Sequence: grade the current word by hand ─────────── */}
        {isTimedSequence(session.type) && (
          <HandGradeCard
            word={sessionWords[wordListIndex]?.word ?? ""}
            wordId={sessionWords[wordListIndex]?.id ?? null}
            students={assignedStudents}
            attempts={liveAttempts}
            onGrade={gradeByHand}
          />
        )}

        {/* ── Timed Sequence: live responses feed ───────────────────────── */}
        {isTimedSequence(session.type) && liveAttempts.length > 0 && (
          <View style={styles.sectionCard}>
            <Text style={styles.cardLabel}>LIVE RESPONSES</Text>
            <View style={{ gap: 8 }}>
              {liveAttempts.slice(0, 5).map((a) => (
                <View key={a.id} style={styles.historyRow}>
                  <View
                    style={[
                      styles.responseDot,
                      { backgroundColor: STATUS_STYLE[attemptStatus(a)].fg },
                    ]}
                  />
                  <Text style={hg.who} numberOfLines={1}>{studentName(a.student_id)}</Text>
                  <Text style={styles.historyWord}>{a.word}</Text>
                  <View style={{ flex: 1 }} />
                  <Text
                    style={[
                      styles.responseLabel,
                      { color: STATUS_STYLE[attemptStatus(a)].fg },
                    ]}
                  >
                    {STATUS_STYLE[attemptStatus(a)].short}
                        {a.transcript ? ` · "${cleanTranscript(a.transcript)}"` : ""}
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
                {isCooldown
                  ? "Display Cleared"
                  : `Chunk ${chunkIndex + 1} of ${chunks.length}`}
              </Text>
            </View>

            <FiveCellDisplay chunk={isCooldown ? "" : chunks[chunkIndex]} />

            {/* Chunk navigation — strictly local UI preview, decoupled from hardware */}
            {!isCooldown && chunks.length > 1 && (
              <View style={styles.chunkNavRow}>
                <Pressable
                  onPress={() => goToChunk(chunkIndex - 1)}
                  disabled={chunkIndex === 0}
                  style={({ pressed }) => [
                    styles.chunkNavBtn,
                    pressed && { opacity: 0.7 },
                    chunkIndex === 0 && { opacity: 0.3 },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Back (previous chunk)"
                >
                  <Ionicons name="arrow-back" size={16} color={C.navy} />
                  <Text style={styles.chunkNavText}>Back</Text>
                </Pressable>
                <Pressable
                  onPress={() => goToChunk(chunkIndex + 1)}
                  disabled={chunkIndex === chunks.length - 1}
                  style={({ pressed }) => [
                    styles.chunkNavBtn,
                    pressed && { opacity: 0.7 },
                    chunkIndex === chunks.length - 1 && { opacity: 0.3 },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Next chunk"
                >
                  <Text style={styles.chunkNavText}>Next</Text>
                  <Ionicons name="arrow-forward" size={16} color={C.navy} />
                </Pressable>
              </View>
            )}
            <Text style={styles.deviceHint}>
              {isCooldown
                ? "Display is cleared for a short break before the next word."
                : "Use Back / Next to preview chunks locally on your screen without interrupting student devices."}
            </Text>
          </View>
        )}
      </ScrollView>
      {WordBankSheet}
      {DupWordModal}
      {FinishSessionModal}
      {/* ── Validation toast (invalid word from send-word check) ─────────── */}
      <Toast
        message={validationToast.message}
        detail={validationToast.detail}
        visible={validationToast.visible}
        variant="delete"
        onDismiss={() => setValidationToast((t) => ({ ...t, visible: false }))}
      />
      {/* ── Finish toast ─────────────────────────────────────────────────── */}
      <Toast
        message="Session finished"
        detail={finishToast?.name}
        visible={!!finishToast}
        variant="success"
        onDismiss={() => setFinishToast(null)}
      />
      {/* ── Device online / offline toast ─────────────────────────────── */}
      <Toast
        message={deviceToast.message}
        detail={deviceToast.detail}
        visible={deviceToast.visible}
        variant={deviceToast.online ? "success" : "warning"}
        icon={deviceToast.online ? "cloud-done-outline" : "cloud-offline-outline"}
        duration={deviceToast.online ? 3500 : 6000}
        onDismiss={() => setDeviceToast((t) => ({ ...t, visible: false }))}
      />
      {/* ── Hardware Safety Kill-Switch Toast (60s inactivity) ───────────── */}
      <Toast
        message={safetyToast.message}
        detail={safetyToast.detail}
        visible={safetyToast.visible}
        variant="warning"
        duration={5000}
        onDismiss={() => setSafetyToast((prev) => ({ ...prev, visible: false }))}
      />
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
  studentChipDisabled: {
    opacity: 0.5,
    backgroundColor: C.bg,
    borderColor: C.border,
  },
  studentChipText: { fontFamily: fonts.heading, fontSize: 13, color: C.ink },
  studentChipTextDisabled: { color: C.muted },
  noDeviceBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: C.brownBg,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: "rgba(92, 56, 0, 0.15)",
  },
  noDeviceBadgeText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: C.brown,
    fontWeight: "600",
  },
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
  safetyPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: C.greenBg,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  },
  safetyPillText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: C.green,
    fontWeight: "700",
  },
  sequenceWordRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    backgroundColor: C.white,
  },
  sequenceWordText: {
    fontFamily: fonts.mono,
    fontSize: 15,
    color: C.navy,
    flex: 1,
    letterSpacing: 1,
  },
  stepperWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.bg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    padding: 2,
    gap: 2,
  },
  stepperBtn: {
    width: 24,
    height: 24,
    borderRadius: 6,
    backgroundColor: C.white,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: C.border,
  },
  stepperBtnDisabled: {
    opacity: 0.35,
    backgroundColor: "transparent",
  },
  stepperBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 6,
    minWidth: 42,
    justifyContent: "center",
  },
  stepperText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: C.navy,
    fontWeight: "700",
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
  shuffleWordsBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: C.blueWash,
    borderWidth: 1.5,
    borderColor: C.navy,
    borderRadius: 14,
    paddingVertical: 13,
    paddingHorizontal: 16,
  },
  shuffleWordsBtnText: {
    fontFamily: fonts.heading,
    fontSize: 14,
    color: C.navy,
  },
  shuffleHeaderBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: C.blueWash,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: "rgba(12,68,124,0.25)",
  },
  shuffleHeaderBtnText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    fontWeight: "700",
    color: C.navy,
  },

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
  historyRowActive: {
    backgroundColor: C.brownBg,
    borderWidth: 1.5,
    borderColor: C.amber,
  },
  historyRowDone: {
    backgroundColor: C.greenBg,
    borderWidth: 1.5,
    borderColor: C.green,
    opacity: 0.7,
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

  // Active word badge in WORDS SENT
  activeWordBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: C.amber,
    borderRadius: 100,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  activeWordDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#1A1200",
  },
  activeWordBadgeText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: "#1A1200",
    letterSpacing: 0.5,
  },

  // Completed word badge in WORDS SENT
  doneWordBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: C.greenBg,
    borderRadius: 100,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  doneWordBadgeText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: C.green,
    letterSpacing: 0.5,
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
  launchBtnDisabled: { backgroundColor: C.border },
  launchHint: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: C.muted,
    textAlign: "center",
    marginTop: -6,
    lineHeight: 18,
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
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
  },
  activePurpose: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: C.muted,
    lineHeight: 18,
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
  sectionCardError: {
    borderColor: C.red,
    backgroundColor: C.redBg,
  },
  activeWordErrorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: C.redBg,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: C.red,
  },
  activeWordErrorText: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: C.red,
    flex: 1,
    lineHeight: 17,
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
  wordInputDisabled: {
    backgroundColor: C.brownBg,
    borderColor: C.amber,
    color: C.muted,
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

  // Word Bank button (next to the typed input) + its sheet
  bankBtn: {
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    backgroundColor: C.blueWash,
    borderRadius: 12,
    paddingHorizontal: 10,
    minWidth: 64,
  },
  bankBtnText: { fontFamily: fonts.heading, fontSize: 10, color: C.navy },
  bankSheet: { height: "75%", paddingBottom: 24 },
  bankSearchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: C.bg,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bankSearchInput: { flex: 1, fontFamily: fonts.mono, fontSize: 15, color: C.ink, padding: 0 },
  bankRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: C.bg,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  bankRowWord: { fontFamily: fonts.mono, fontSize: 15, color: C.navy, letterSpacing: 1.5 },
  bankRowTag: { fontFamily: fonts.mono, fontSize: 10, color: C.muted, letterSpacing: 0.5 },

  // Done button (replaces Send while a word is active)
  doneBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: C.green,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  doneBtnText: { fontFamily: fonts.heading, fontSize: 14, color: C.white },

  // Live Session manual pacing & prominent Clear Display styles
  liveCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  livePacingBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: C.greenBg,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  },
  livePacingBadgeText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    fontWeight: "700",
    color: C.green,
  },
  liveControlHint: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: C.muted,
    lineHeight: 18,
  },
  sectionCardActiveLive: {
    borderColor: C.navy,
    borderWidth: 2,
    backgroundColor: C.white,
  },
  activeDisplayBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: C.greenBg,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  },
  activeDisplayBadgeText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    fontWeight: "700",
    color: C.green,
  },
  activeLiveHero: {
    backgroundColor: C.blueWash,
    borderRadius: 14,
    padding: 16,
    alignItems: "center",
    gap: 6,
    borderWidth: 1.5,
    borderColor: "rgba(12,68,124,0.2)",
  },
  activeLiveWordLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: C.muted,
    letterSpacing: 1.5,
  },
  activeLiveWordText: {
    fontFamily: fonts.mono,
    fontSize: 32,
    fontWeight: "700",
    color: C.navy,
    letterSpacing: 4,
  },
  activeLiveWordSub: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: C.muted,
    textAlign: "center",
    lineHeight: 18,
  },
  clearDisplayBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: C.navy,
    borderRadius: 14,
    paddingVertical: 15,
    paddingHorizontal: 20,
    shadowColor: C.navy,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 3,
  },
  clearDisplayBtnText: {
    fontFamily: fonts.heading,
    fontSize: 15,
    color: C.white,
  },

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

  // Active Timed Sequence playback card
  timedCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  playbackStateBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  },
  playbackStateDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  playbackStateText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  timedHeroBox: {
    backgroundColor: C.bg,
    borderRadius: 14,
    padding: 16,
    alignItems: "center",
    gap: 10,
    borderWidth: 1.5,
    borderColor: C.border,
  },
  timedHeroBoxCooldown: {
    backgroundColor: C.blueWash,
    borderColor: "rgba(12,68,124,0.3)",
  },
  cooldownHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: C.white,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: "rgba(12,68,124,0.2)",
  },
  cooldownBadgeText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    fontWeight: "700",
    color: C.navy,
    letterSpacing: 0.8,
  },
  cooldownTitleText: {
    fontFamily: fonts.heading,
    fontSize: 22,
    color: C.navy,
    textAlign: "center",
  },
  cooldownSubText: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: C.muted,
    textAlign: "center",
  },
  cooldownNextWordText: {
    fontFamily: fonts.mono,
    fontWeight: "700",
    color: C.navy,
  },
  timedWordText: {
    fontFamily: fonts.mono,
    fontSize: 28,
    color: C.navy,
    letterSpacing: 3,
    fontWeight: "700",
  },
  progressBarTrack: {
    width: "100%",
    height: 6,
    backgroundColor: C.border,
    borderRadius: 3,
    overflow: "hidden",
  },
  progressBarFill: {
    height: "100%",
    backgroundColor: C.amber,
    borderRadius: 3,
  },
  progressBarFillCooldown: {
    backgroundColor: C.navy,
  },
  timerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    paddingTop: 4,
  },
  timerMain: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  timerNumber: {
    fontFamily: fonts.mono,
    fontSize: 18,
    color: C.navy,
    fontWeight: "700",
  },
  timerUnit: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: C.muted,
  },
  hardwareLimitBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: C.white,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: C.border,
  },
  hardwareLimitText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: C.muted,
  },

  playbackControlsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  playbackBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    backgroundColor: C.white,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  playbackBtnDisabled: {
    opacity: 0.35,
  },
  playbackBtnText: {
    fontFamily: fonts.heading,
    fontSize: 13,
    color: C.navy,
  },
  playbackBtnPrimary: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: C.amber,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  playbackBtnPrimaryText: {
    fontFamily: fonts.heading,
    fontSize: 14,
    color: "#1A1200",
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
  playBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: C.blueWash,
    alignItems: "center",
    justifyContent: "center",
  },
  overrideBtn: {
    width: 24,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.2,
    backgroundColor: C.white,
    alignItems: "center",
    justifyContent: "center",
  },
  teacherTag: {
    fontFamily: fonts.mono,
    fontSize: 8,
    color: C.muted,
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
