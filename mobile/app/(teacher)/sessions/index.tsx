// mobile/app/(teacher)/sessions/index.tsx
// Sessions list — create, view, and tap into sessions.

import { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  Pressable,
  FlatList,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../lib/supabase";
import { colors as C, fonts } from "../../../lib/theme";
import { BrailleCell } from "../../../components/BrailleCell";
import { BrailleLoader } from "../../../components/BrailleLoader";

// ── Types ─────────────────────────────────────────────────────────────────────

type SessionType = "manual" | "word_list";
type SessionStatus = "pending" | "in_progress" | "paused" | "finished";

type Session = {
  id: string;
  name: string;
  purpose: string | null;
  type: SessionType;
  status: SessionStatus;
  created_at: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS: Record<
  SessionStatus,
  { bg: string; text: string; label: string }
> = {
  pending: { bg: C.border, text: C.muted, label: "Pending" },
  in_progress: { bg: C.greenBg, text: C.green, label: "In Progress" },
  paused: { bg: C.brownBg, text: C.brown, label: "Paused" },
  finished: { bg: C.blueWash, text: C.navy, label: "Finished" },
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ── Session card ──────────────────────────────────────────────────────────────

function SessionCard({
  session,
  onPress,
}: {
  session: Session;
  onPress: () => void;
}) {
  const s = STATUS[session.status];
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
      accessibilityRole="button"
    >
      <View style={{ flex: 1, gap: 6 }}>
        <Text style={styles.sessionName}>{session.name}</Text>
        {session.purpose && (
          <Text style={styles.sessionPurpose}>{session.purpose}</Text>
        )}
        <View style={styles.cardMeta}>
          <View style={[styles.badge, { backgroundColor: s.bg }]}>
            <Text style={[styles.badgeText, { color: s.text }]}>{s.label}</Text>
          </View>
          <View style={[styles.badge, { backgroundColor: C.bg }]}>
            <Text style={[styles.badgeText, { color: C.muted }]}>
              {session.type === "word_list" ? "Word List" : "Manual"}
            </Text>
          </View>
          <Text style={styles.dateText}>{formatDate(session.created_at)}</Text>
        </View>
      </View>
      <Ionicons name="chevron-forward" size={18} color={C.muted} />
    </Pressable>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function SessionsScreen() {
  const router = useRouter();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createModal, setCreateModal] = useState(false);

  // Create form state
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [type, setType] = useState<SessionType>("manual");
  const [saving, setSaving] = useState(false);

  const loadSessions = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from("sessions")
      .select("id, name, purpose, type, status, created_at")
      .eq("teacher_id", user.id)
      .order("created_at", { ascending: false });
    setSessions(data ?? []);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    loadSessions();
    const channel = supabase
      .channel("sessions-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sessions" },
        loadSessions,
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadSessions]);

  function openCreate() {
    setName("");
    setPurpose("");
    setType("manual");
    setCreateModal(true);
  }

  async function createSession() {
    if (!name.trim()) return;
    setSaving(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from("sessions")
      .insert({
        teacher_id: user!.id,
        name: name.trim(),
        purpose: purpose.trim() || null,
        type,
      })
      .select("id")
      .single();
    setSaving(false);
    if (error || !data) return;
    setCreateModal(false);
    loadSessions();
    router.push(`/(teacher)/sessions/${data.id}` as any);
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.center}>
          <BrailleLoader size={16} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Sessions</Text>
        <Pressable
          onPress={openCreate}
          style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.85 }]}
          accessibilityRole="button"
        >
          <Ionicons name="add" size={18} color="#1A1200" />
          <Text style={styles.addBtnText}>New</Text>
        </Pressable>
      </View>

      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              loadSessions();
            }}
            tintColor={C.navy}
          />
        }
        renderItem={({ item }) => (
          <SessionCard
            session={item}
            onPress={() => router.push(`/(teacher)/sessions/${item.id}` as any)}
          />
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
      <Modal
        visible={createModal}
        animationType="slide"
        transparent
        onRequestClose={() => setCreateModal(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable
            style={styles.backdrop}
            onPress={() => setCreateModal(false)}
          />
          <KeyboardAvoidingView
            style={styles.keyboardSheet}
            behavior={Platform.OS === "ios" ? "padding" : "padding"}
          >
            <View style={styles.sheet}>
              <View style={styles.handle} />
              <Text style={styles.sheetTitle}>New Session</Text>

              <ScrollView
                showsVerticalScrollIndicator={false}
                style={{ maxHeight: 420 }}
                contentContainerStyle={{ gap: 14 }}
              >
                {/* Name */}
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Session name</Text>
                  <TextInput
                    style={styles.input}
                    value={name}
                    onChangeText={setName}
                    placeholder="e.g. Monday Practice"
                    placeholderTextColor={C.muted}
                    autoFocus
                    autoCapitalize="words"
                    returnKeyType="next"
                  />
                </View>

                {/* Purpose */}
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>
                    Purpose <Text style={styles.optional}>(optional)</Text>
                  </Text>
                  <TextInput
                    style={[styles.input, styles.multiline]}
                    value={purpose}
                    onChangeText={setPurpose}
                    placeholder="e.g. Introduce letters A–E to Grade 1 learners"
                    placeholderTextColor={C.muted}
                    multiline
                    numberOfLines={3}
                    textAlignVertical="top"
                  />
                </View>

                {/* Type selector */}
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Session type</Text>
                  <View style={styles.typeRow}>
                    <Pressable
                      onPress={() => setType("manual")}
                      style={[
                        styles.typeBtn,
                        type === "manual" && styles.typeBtnActive,
                      ]}
                    >
                      <Ionicons
                        name="create-outline"
                        size={18}
                        color={type === "manual" ? C.white : C.muted}
                      />
                      <View>
                        <Text
                          style={[
                            styles.typeBtnLabel,
                            type === "manual" && styles.typeBtnLabelActive,
                          ]}
                        >
                          Manual
                        </Text>
                        <Text
                          style={[
                            styles.typeBtnSub,
                            type === "manual" && {
                              color: "rgba(255,255,255,0.7)",
                            },
                          ]}
                        >
                          Type words live
                        </Text>
                      </View>
                    </Pressable>
                    <Pressable
                      onPress={() => setType("word_list")}
                      style={[
                        styles.typeBtn,
                        type === "word_list" && styles.typeBtnActive,
                      ]}
                    >
                      <Ionicons
                        name="list-outline"
                        size={18}
                        color={type === "word_list" ? C.white : C.muted}
                      />
                      <View>
                        <Text
                          style={[
                            styles.typeBtnLabel,
                            type === "word_list" && styles.typeBtnLabelActive,
                          ]}
                        >
                          Word List
                        </Text>
                        <Text
                          style={[
                            styles.typeBtnSub,
                            type === "word_list" && {
                              color: "rgba(255,255,255,0.7)",
                            },
                          ]}
                        >
                          Pre-built list
                        </Text>
                      </View>
                    </Pressable>
                  </View>
                </View>
              </ScrollView>

              <View style={styles.sheetActions}>
                <Pressable
                  onPress={() => setCreateModal(false)}
                  style={({ pressed }) => [
                    styles.sheetBtn,
                    styles.btnCancel,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={styles.btnCancelText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={createSession}
                  disabled={saving || !name.trim()}
                  style={({ pressed }) => [
                    styles.sheetBtn,
                    styles.btnConfirm,
                    (pressed || !name.trim()) && { opacity: 0.7 },
                  ]}
                >
                  {saving ? (
                    <ActivityIndicator color="#1A1200" />
                  ) : (
                    <Text style={styles.btnConfirmText}>Create</Text>
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

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 16,
    backgroundColor: C.white,
    borderBottomWidth: 1.5,
    borderBottomColor: C.border,
  },
  title: { fontFamily: fonts.heading, fontSize: 24, color: C.navy },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: C.amber,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  addBtnText: { fontFamily: fonts.heading, fontSize: 14, color: "#1A1200" },

  list: { padding: 16, gap: 12, flexGrow: 1 },

  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: C.white,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1.5,
    borderColor: C.border,
  },
  sessionName: { fontFamily: fonts.heading, fontSize: 15, color: C.navy },
  sessionPurpose: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: C.muted,
    lineHeight: 18,
  },
  cardMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 100 },
  badgeText: { fontFamily: fonts.mono, fontSize: 10 },
  dateText: { fontFamily: fonts.body, fontSize: 11, color: C.muted },

  empty: {
    alignItems: "center",
    justifyContent: "center",
    padding: 40,
    marginTop: 60,
    gap: 12,
  },
  emptyTitle: { fontFamily: fonts.heading, fontSize: 18, color: C.navy },
  emptyBody: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: C.ink,
    textAlign: "center",
    lineHeight: 22,
  },

  // Modal
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
    gap: 16,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: C.border,
    alignSelf: "center",
  },
  sheetTitle: { fontFamily: fonts.heading, fontSize: 20, color: C.navy },

  fieldGroup: { gap: 6 },
  label: { fontFamily: fonts.heading, fontSize: 14, color: C.navy },
  optional: { fontFamily: fonts.body, fontSize: 12, color: C.muted },
  input: {
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
  multiline: { minHeight: 80, paddingTop: 13 },

  // Type selector
  typeRow: { flexDirection: "row", gap: 10 },
  typeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 14,
    padding: 14,
    backgroundColor: C.bg,
    borderWidth: 1.5,
    borderColor: C.border,
  },
  typeBtnActive: { backgroundColor: C.navy, borderColor: C.navy },
  typeBtnLabel: { fontFamily: fonts.heading, fontSize: 14, color: C.ink },
  typeBtnLabelActive: { color: C.white },
  typeBtnSub: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: C.muted,
    marginTop: 1,
  },

  sheetActions: { flexDirection: "row", gap: 10 },
  sheetBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  btnCancel: { backgroundColor: C.bg, borderWidth: 1.5, borderColor: C.border },
  btnConfirm: { backgroundColor: C.amber },
  btnCancelText: { fontFamily: fonts.heading, fontSize: 15, color: C.navy },
  btnConfirmText: { fontFamily: fonts.heading, fontSize: 15, color: "#1A1200" },
});
