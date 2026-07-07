// mobile/app/(teacher)/sessions/index.tsx
// Sessions list — view and tap into sessions.

import { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  Pressable,
  FlatList,
  StyleSheet,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../lib/supabase";
import { colors as C, fonts } from "../../../lib/theme";
import { BrailleCell } from "../../../components/BrailleCell";
import { BrailleLoader } from "../../../components/BrailleLoader";
import { Toast } from "../../../components/Toast";

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
  // Paused sessions appear as "In Progress" in the list — they are still active sessions.
  // The paused state is only surfaced inside the session detail view.
  paused: { bg: C.greenBg, text: C.green, label: "In Progress" },
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
  const { deletedName } = useLocalSearchParams<{ deletedName?: string }>();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<{ name: string } | null>(null);

  // Show toast when arriving back after a deletion
  useEffect(() => {
    if (deletedName) {
      setToast({ name: deletedName });
    }
  }, [deletedName]);

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

  // Keep a stable ref to the latest loadSessions so the realtime
  // callback is never a stale closure, even when loadSessions changes.
  const loadSessionsRef = useRef(loadSessions);
  useEffect(() => {
    loadSessionsRef.current = loadSessions;
  });

  // Initial load
  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Realtime subscription — unique channel name per mount to avoid
  // "cannot add postgres_changes after subscribe()" collisions.
  useEffect(() => {
    const channelName = `sessions-realtime-${Date.now()}`;
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sessions" },
        () => loadSessionsRef.current(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []); // runs once on mount only

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
          onPress={() => router.push("/(teacher)/sessions/new" as any)}
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

      <Toast
        message="Session deleted"
        detail={toast?.name}
        visible={!!toast}
        variant="delete"
        onDismiss={() => setToast(null)}
      />
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
});
