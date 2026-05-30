// mobile/app/(teacher)/sessions.tsx
// Two views in one screen:
//   "list"   — create & manage sessions
//   "active" — connect to device, type words, see braille preview
// Backend calls are commented [BACKEND]. Device comms use lib/websocket.ts.

import { useState, useRef, useEffect } from "react";
import {
  View, Text, Pressable, FlatList, TextInput, Modal,
  KeyboardAvoidingView, Platform, StyleSheet, ScrollView, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { colors as C, fonts } from "../../lib/theme";
import { BrailleCell } from "../../components/BrailleCell";
import { DeviceConnection, DeviceMessage } from "../../lib/websocket";
import { wordToLetters, getPattern } from "../../lib/braille";

// ── Types ─────────────────────────────────────────────────────────────────────

type SessionStatus = "pending" | "in_progress" | "paused" | "finished";

type Session = {
  id: string;
  name: string;
  status: SessionStatus;
  createdAt: string;
};

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<SessionStatus, { bg: string; color: string; label: string }> = {
  pending:     { bg: C.border,   color: C.muted,  label: "Pending"     },
  in_progress: { bg: C.greenBg,  color: C.green,  label: "In Progress" },
  paused:      { bg: C.brownBg,  color: C.brown,  label: "Paused"      },
  finished:    { bg: C.blueWash, color: C.navy,   label: "Finished"    },
};

function StatusBadge({ status }: { status: SessionStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <View style={[styles.badge, { backgroundColor: s.bg }]}>
      <Text style={[styles.badgeText, { color: s.color }]}>{s.label}</Text>
    </View>
  );
}

// ── Session card ──────────────────────────────────────────────────────────────

function SessionCard({ session, onPress }: { session: Session; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
    >
      <View style={{ flex: 1, gap: 6 }}>
        <Text style={styles.sessionName}>{session.name}</Text>
        <Text style={styles.sessionDate}>{session.createdAt}</Text>
      </View>
      <View style={{ alignItems: "flex-end", gap: 8 }}>
        <StatusBadge status={session.status} />
        <Ionicons name="chevron-forward" size={16} color={C.muted} />
      </View>
    </Pressable>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function SessionsScreen() {

  // ── View state ──────────────────────────────────────────────────────────────
  const [view, setView] = useState<"list" | "active">("list");
  const [activeSession, setActiveSession] = useState<Session | null>(null);

  // ── Session list state ───────────────────────────────────────────────────────
  const [sessions, setSessions] = useState<Session[]>([
    // [BACKEND] Replace with: const { data } = await supabase.from("sessions")
    //   .select().eq("teacher_id", profile.id).order("created_at", { ascending: false });
  ]);
  const [createModal, setCreateModal] = useState(false);
  const [newName, setNewName] = useState("");

  // ── Device + word state (active session) ─────────────────────────────────────
  const [ip, setIp]               = useState("");
  const [connected, setConnected] = useState(false);
  const [word, setWord]           = useState("");
  const [letters, setLetters]     = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [started, setStarted]     = useState(false);

  // Refs so WebSocket callback always sees latest values (avoids stale closures)
  const lettersRef      = useRef<string[]>([]);
  const currentIndexRef = useRef(0);
  const connectionRef   = useRef<DeviceConnection | null>(null);

  // Stable message handler ref — updated every render, called by stable callback
  const onMessageRef = useRef<(msg: DeviceMessage) => void>(() => {});
  onMessageRef.current = (msg: DeviceMessage) => {
    if (msg.type !== "button_press") return;
    const arr = lettersRef.current;
    const idx = currentIndexRef.current;
    if (msg.button === "next" && idx < arr.length - 1) {
      const next = idx + 1;
      currentIndexRef.current = next;
      setCurrentIndex(next);
      connectionRef.current?.sendLetter(arr[next]);
    }
    if (msg.button === "back" && idx > 0) {
      const prev = idx - 1;
      currentIndexRef.current = prev;
      setCurrentIndex(prev);
      connectionRef.current?.sendLetter(arr[prev]);
    }
  };

  // Create DeviceConnection once on mount, clean up on unmount
  useEffect(() => {
    connectionRef.current = new DeviceConnection(
      (msg) => onMessageRef.current(msg),
      (status) => {
        setConnected(status);
        if (!status && started) {
          Alert.alert("Disconnected", "Lost connection to the device.");
        }
      },
    );
    return () => { connectionRef.current?.disconnect(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Session list actions ──────────────────────────────────────────────────────

  function createSession() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const session: Session = {
      id: Date.now().toString(), // [BACKEND] use UUID from Supabase insert
      name: trimmed,
      status: "pending",
      createdAt: new Date().toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" }),
    };
    // [BACKEND] await supabase.from("sessions").insert({ teacher_id: profile.id, name: trimmed });
    setSessions((prev) => [session, ...prev]);
    setNewName("");
    setCreateModal(false);
  }

  function openSession(session: Session) {
    // [BACKEND] await supabase.from("sessions").update({ status: "in_progress" }).eq("id", session.id);
    setSessions((prev) =>
      prev.map((s) => s.id === session.id ? { ...s, status: "in_progress" } : s)
    );
    setActiveSession({ ...session, status: "in_progress" });
    resetDeviceState();
    setView("active");
  }

  function resetDeviceState() {
    setWord("");
    setLetters([]);
    setCurrentIndex(0);
    setStarted(false);
    currentIndexRef.current = 0;
    lettersRef.current = [];
  }

  function handleBackToList() {
    connectionRef.current?.disconnect();
    setConnected(false);
    resetDeviceState();
    // [BACKEND] await supabase.from("sessions").update({ status: "paused" }).eq("id", activeSession.id);
    if (activeSession) {
      setSessions((prev) =>
        prev.map((s) => s.id === activeSession.id ? { ...s, status: "paused" } : s)
      );
    }
    setView("list");
  }

  function finishSession() {
    Alert.alert("Finish session", "Mark this session as finished?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Finish",
        onPress: () => {
          connectionRef.current?.disconnect();
          setConnected(false);
          resetDeviceState();
          // [BACKEND] await supabase.from("sessions").update({ status: "finished" }).eq("id", activeSession.id);
          if (activeSession) {
            setSessions((prev) =>
              prev.map((s) => s.id === activeSession.id ? { ...s, status: "finished" } : s)
            );
          }
          setView("list");
        },
      },
    ]);
  }

  // ── Device actions ────────────────────────────────────────────────────────────

  function connectDevice() {
    if (!ip.trim()) {
      Alert.alert("Enter IP", "Type the device IP address shown in the serial monitor.");
      return;
    }
    connectionRef.current?.connect(ip.trim());
  }

  function startWord() {
    const parsed = wordToLetters(word);
    if (parsed.length === 0) {
      Alert.alert("Invalid word", "Please enter letters A–Z only.");
      return;
    }
    lettersRef.current = parsed;
    currentIndexRef.current = 0;
    setLetters(parsed);
    setCurrentIndex(0);
    setStarted(true);
    connectionRef.current?.sendLetter(parsed[0]);
  }

  function resetWord() {
    setWord("");
    setLetters([]);
    setCurrentIndex(0);
    setStarted(false);
    currentIndexRef.current = 0;
    lettersRef.current = [];
  }

  // ── Render: list view ─────────────────────────────────────────────────────────

  if (view === "list") {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.header}>
          <Text style={styles.title}>Sessions</Text>
          <Pressable
            onPress={() => setCreateModal(true)}
            style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityLabel="Create a new session"
          >
            <Ionicons name="add" size={18} color="#1A1200" />
            <Text style={styles.addBtnText}>New</Text>
          </Pressable>
        </View>

        <FlatList
          data={sessions}
          keyExtractor={(s) => s.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <SessionCard session={item} onPress={() => openSession(item)} />
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <BrailleCell pattern={[]} size={16} emptyColor={C.border} />
              <Text style={styles.emptyTitle}>No sessions yet</Text>
              <Text style={styles.emptyBody}>
                {"Tap "}
                <Text style={{ fontFamily: fonts.heading }}>+ New</Text>
                {" to create your first teaching session."}
              </Text>
            </View>
          }
        />

        {/* Create session modal */}
        <Modal visible={createModal} animationType="slide" transparent onRequestClose={() => setCreateModal(false)}>
          <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === "ios" ? "padding" : "height"}>
            <Pressable style={styles.modalBackdrop} onPress={() => setCreateModal(false)} />
            <View style={styles.modalSheet}>
              <View style={styles.modalHandle} />
              <Text style={styles.modalTitle}>New Session</Text>
              <Text style={styles.modalLabel}>Session name</Text>
              <TextInput
                style={styles.modalInput}
                value={newName}
                onChangeText={setNewName}
                placeholder="e.g. Monday Practice"
                placeholderTextColor={C.muted}
                autoFocus
                autoCapitalize="words"
                returnKeyType="done"
                onSubmitEditing={createSession}
                accessibilityLabel="Session name"
              />
              <View style={styles.modalActions}>
                <Pressable
                  onPress={() => { setCreateModal(false); setNewName(""); }}
                  style={({ pressed }) => [styles.modalBtn, styles.modalBtnCancel, pressed && { opacity: 0.7 }]}
                >
                  <Text style={styles.modalBtnCancelText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={createSession}
                  style={({ pressed }) => [styles.modalBtn, styles.modalBtnConfirm, pressed && { opacity: 0.85 }]}
                >
                  <Text style={styles.modalBtnConfirmText}>Create</Text>
                </Pressable>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      </SafeAreaView>
    );
  }

  // ── Render: active session view ───────────────────────────────────────────────

  const currentLetter = letters[currentIndex] ?? "";

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Active session header */}
      <View style={styles.header}>
        <Pressable
          onPress={handleBackToList}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
          accessibilityRole="button"
          accessibilityLabel="Back to sessions list"
        >
          <Ionicons name="arrow-back" size={20} color={C.navy} />
          <Text style={styles.backText}>Sessions</Text>
        </Pressable>
        <Pressable
          onPress={finishSession}
          style={({ pressed }) => [styles.finishBtn, pressed && { opacity: 0.8 }]}
          accessibilityRole="button"
        >
          <Text style={styles.finishBtnText}>Finish</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.activeScroll} showsVerticalScrollIndicator={false}>
        <Text style={styles.sessionTitle}>{activeSession?.name}</Text>

        {/* ── Connection card ──────────────────────────────────── */}
        <View style={styles.sectionCard}>
          <View style={styles.sectionCardHeader}>
            <Text style={styles.sectionCardTitle}>Device</Text>
            <View style={[styles.statusDot, { backgroundColor: connected ? C.green : C.red }]} />
            <Text style={[styles.statusLabel, { color: connected ? C.green : C.red }]}>
              {connected ? "Connected" : "Disconnected"}
            </Text>
          </View>
          <View style={styles.ipRow}>
            <TextInput
              style={[styles.input, styles.ipInput]}
              value={ip}
              onChangeText={setIp}
              placeholder="192.168.x.x"
              placeholderTextColor={C.muted}
              keyboardType="decimal-pad"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!connected}
              accessibilityLabel="Device IP address"
            />
            <Pressable
              onPress={connected ? () => { connectionRef.current?.disconnect(); } : connectDevice}
              style={({ pressed }) => [
                styles.connectBtn,
                { backgroundColor: connected ? C.redBg : C.navy },
                pressed && { opacity: 0.85 },
              ]}
              accessibilityRole="button"
            >
              <Text style={[styles.connectBtnText, { color: connected ? C.red : C.white }]}>
                {connected ? "Disconnect" : "Connect"}
              </Text>
            </Pressable>
          </View>
          <Text style={styles.ipHint}>
            Find the IP in the serial monitor after flashing the firmware.
          </Text>
        </View>

        {/* ── Word input card ───────────────────────────────────── */}
        <View style={styles.sectionCard}>
          <Text style={styles.sectionCardTitle}>Word</Text>
          <TextInput
            style={[styles.input, styles.wordInput]}
            value={word}
            onChangeText={(v) => { setWord(v.toUpperCase()); }}
            placeholder="TYPE A WORD"
            placeholderTextColor={C.muted}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!started}
            accessibilityLabel="Word to display on device"
          />
          <View style={styles.wordActions}>
            {!started ? (
              <Pressable
                onPress={startWord}
                disabled={!connected}
                style={({ pressed }) => [
                  styles.wordBtn, styles.wordBtnStart,
                  !connected && { opacity: 0.5 },
                  pressed && { opacity: 0.85 },
                ]}
                accessibilityRole="button"
                accessibilityLabel="Send word to device"
              >
                <Ionicons name="play" size={16} color="#1A1200" />
                <Text style={styles.wordBtnStartText}>Start</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={resetWord}
                style={({ pressed }) => [styles.wordBtn, styles.wordBtnReset, pressed && { opacity: 0.85 }]}
                accessibilityRole="button"
              >
                <Ionicons name="refresh" size={16} color={C.navy} />
                <Text style={styles.wordBtnResetText}>Reset</Text>
              </Pressable>
            )}
          </View>
        </View>

        {/* ── Braille display card (shown when started) ─────────── */}
        {started && letters.length > 0 && (
          <View style={styles.sectionCard}>
            <Text style={styles.sectionCardTitle}>Now Displaying</Text>

            {/* Letter progress strip */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.letterStrip}>
              {letters.map((l, i) => (
                <View
                  key={i}
                  style={[styles.letterChip, i === currentIndex && styles.letterChipActive]}
                >
                  <Text style={[styles.letterChipText, i === currentIndex && styles.letterChipTextActive]}>
                    {l}
                  </Text>
                </View>
              ))}
            </ScrollView>

            {/* Big letter + braille cell */}
            <View style={styles.displayRow}>
              <Text style={styles.bigLetter}>{currentLetter}</Text>
              <BrailleCell pattern={getPattern(currentLetter)} size={22} />
            </View>

            <View style={styles.hintRow}>
              <Ionicons name="hand-left-outline" size={14} color={C.muted} />
              <Text style={styles.hintText}>
                {`Letter ${currentIndex + 1} of ${letters.length} — student uses Next / Back on device`}
              </Text>
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },

  // Shared header
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 20, paddingVertical: 16,
    backgroundColor: C.white, borderBottomWidth: 1.5, borderBottomColor: C.border,
  },
  title:      { fontFamily: fonts.heading, fontSize: 24, color: C.navy },
  addBtn:     {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: C.amber, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8,
  },
  addBtnText: { fontFamily: fonts.heading, fontSize: 14, color: "#1A1200" },

  // Back button (active session)
  backBtn:  { flexDirection: "row", alignItems: "center", gap: 6 },
  backText: { fontFamily: fonts.heading, fontSize: 16, color: C.navy },
  finishBtn:     { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: C.greenBg },
  finishBtnText: { fontFamily: fonts.heading, fontSize: 14, color: C.green },

  // Status badge (session list)
  badge:     { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 100 },
  badgeText: { fontFamily: fonts.mono, fontSize: 10 },

  // Session card
  card: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: C.white, borderRadius: 14, padding: 16,
    borderWidth: 1.5, borderColor: C.border,
  },
  sessionName: { fontFamily: fonts.heading, fontSize: 15, color: C.navy },
  sessionDate: { fontFamily: fonts.body, fontSize: 12, color: C.muted },

  // List
  list:       { padding: 16, gap: 12, flexGrow: 1 },
  empty:      { alignItems: "center", justifyContent: "center", padding: 40, marginTop: 60, gap: 12 },
  emptyTitle: { fontFamily: fonts.heading, fontSize: 18, color: C.navy },
  emptyBody:  { fontFamily: fonts.body, fontSize: 14, color: C.ink, textAlign: "center", lineHeight: 22 },

  // Active session
  activeScroll:  { padding: 16, gap: 16, paddingBottom: 40 },
  sessionTitle:  { fontFamily: fonts.heading, fontSize: 22, color: C.navy, marginBottom: 4 },

  sectionCard: {
    backgroundColor: C.white, borderRadius: 16, padding: 16,
    borderWidth: 1.5, borderColor: C.border, gap: 12,
  },
  sectionCardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  sectionCardTitle:  { fontFamily: fonts.heading, fontSize: 16, color: C.navy, flex: 1 },
  statusDot:         { width: 8, height: 8, borderRadius: 4 },
  statusLabel:       { fontFamily: fonts.mono, fontSize: 11 },

  // IP row
  ipRow:   { flexDirection: "row", gap: 10, alignItems: "center" },
  ipInput: { flex: 1 },
  ipHint:  { fontFamily: fonts.body, fontSize: 12, color: C.muted, lineHeight: 18 },
  connectBtn: {
    paddingHorizontal: 16, paddingVertical: 14,
    borderRadius: 12, alignItems: "center", justifyContent: "center",
  },
  connectBtnText: { fontFamily: fonts.heading, fontSize: 14 },

  // Shared input
  input: {
    fontFamily: fonts.mono,
    fontSize: 15,
    color: C.ink,
    backgroundColor: C.bg,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },

  // Word card
  wordInput:        { letterSpacing: 2 },
  wordActions:      { flexDirection: "row", gap: 10 },
  wordBtn:          { flex: 1, flexDirection: "row", gap: 6, borderRadius: 12, paddingVertical: 13, alignItems: "center", justifyContent: "center" },
  wordBtnStart:     { backgroundColor: C.amber },
  wordBtnReset:     { backgroundColor: C.white, borderWidth: 1.5, borderColor: C.border },
  wordBtnStartText: { fontFamily: fonts.heading, fontSize: 15, color: "#1A1200" },
  wordBtnResetText: { fontFamily: fonts.heading, fontSize: 15, color: C.navy },

  // Braille display
  letterStrip: { flexDirection: "row" },
  letterChip: {
    width: 36, height: 36, borderRadius: 8, alignItems: "center", justifyContent: "center",
    backgroundColor: C.bg, marginRight: 6,
    borderWidth: 1.5, borderColor: C.border,
  },
  letterChipActive:     { backgroundColor: C.navy, borderColor: C.navy },
  letterChipText:       { fontFamily: fonts.mono, fontSize: 15, color: C.ink },
  letterChipTextActive: { color: C.white },
  displayRow:  { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 32, paddingVertical: 12 },
  bigLetter:   { fontFamily: fonts.heading, fontSize: 80, color: C.navy, lineHeight: 90 },
  hintRow:     { flexDirection: "row", alignItems: "center", gap: 6 },
  hintText:    { fontFamily: fonts.body, fontSize: 12, color: C.muted, flex: 1, lineHeight: 18 },

  // Modal (shared)
  modalOverlay:        { flex: 1, justifyContent: "flex-end" },
  modalBackdrop:       { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.45)" },
  modalSheet:          {
    backgroundColor: C.white, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 24, paddingBottom: 44, gap: 12,
  },
  modalHandle:         { width: 40, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: "center", marginBottom: 4 },
  modalTitle:          { fontFamily: fonts.heading, fontSize: 20, color: C.navy },
  modalLabel:          { fontFamily: fonts.heading, fontSize: 14, color: C.navy, marginTop: 4 },
  modalInput:          {
    fontFamily: fonts.body, fontSize: 16, color: C.ink,
    backgroundColor: C.bg, borderWidth: 1.5, borderColor: C.border,
    borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14,
  },
  modalActions:        { flexDirection: "row", gap: 10, marginTop: 4 },
  modalBtn:            { flex: 1, borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  modalBtnCancel:      { backgroundColor: C.bg, borderWidth: 1.5, borderColor: C.border },
  modalBtnConfirm:     { backgroundColor: C.amber },
  modalBtnCancelText:  { fontFamily: fonts.heading, fontSize: 15, color: C.navy },
  modalBtnConfirmText: { fontFamily: fonts.heading, fontSize: 15, color: "#1A1200" },
});