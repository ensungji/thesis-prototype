// mobile/app/admin/logs.tsx
// Admin → System Logs. Everything that happened across phones, server,
// database and devices, newest first. Updates live.

import { useCallback, useEffect, useState } from "react";
import { View, Text, Pressable, FlatList, StyleSheet, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { colors as C, fonts } from "../../lib/theme";
import { BrailleLoader } from "../../components/BrailleLoader";

type Log = {
  id: string;
  created_at: string;
  level: "info" | "warn" | "error";
  source: string;
  event: string;
  message: string;
  user_id: string | null;
  device_id: string | null;
  session_id: string | null;
  meta: Record<string, unknown> | null;
};

type Filter = "all" | "error" | "warn" | "grading" | "sessions" | "devices";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "error", label: "Errors" },
  { key: "warn", label: "Warnings" },
  { key: "grading", label: "Grading" },
  { key: "sessions", label: "Sessions" },
  { key: "devices", label: "Devices" },
];

const PAGE = 50;

const LEVEL_STYLE: Record<Log["level"], { fg: string; bg: string; icon: keyof typeof Ionicons.glyphMap }> = {
  info: { fg: C.navy, bg: C.blueWash, icon: "information-circle-outline" },
  warn: { fg: C.brown, bg: C.brownBg, icon: "warning-outline" },
  error: { fg: C.red, bg: C.redBg, icon: "alert-circle-outline" },
};

// Same rule as the database query, for live rows
function matches(log: Log, f: Filter) {
  switch (f) {
    case "all": return true;
    case "error": return log.level === "error";
    case "warn": return log.level === "warn";
    case "grading": return log.event.startsWith("grade") || log.event.startsWith("answer");
    case "sessions": return log.event.startsWith("session");
    case "devices": return log.event.startsWith("device");
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatTime(iso: string) {
  const d = new Date(iso);
  const h = d.getHours();
  const hh = ((h + 11) % 12) + 1;
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${MONTHS[d.getMonth()]} ${d.getDate()} · ${hh}:${mm}:${ss} ${h < 12 ? "AM" : "PM"}`;
}

function LogRow({ log }: { log: Log }) {
  const [open, setOpen] = useState(false);
  const st = LEVEL_STYLE[log.level] ?? LEVEL_STYLE.info;
  const details: [string, string][] = [];
  if (log.session_id) details.push(["session", log.session_id]);
  if (log.device_id) details.push(["device", log.device_id]);
  if (log.user_id) details.push(["user", log.user_id]);
  const meta = log.meta && Object.keys(log.meta).length > 0 ? JSON.stringify(log.meta, null, 2) : null;

  return (
    <Pressable
      onPress={() => setOpen((o) => !o)}
      style={({ pressed }) => [styles.row, { borderLeftColor: st.fg }, pressed && { opacity: 0.85 }]}
      accessibilityRole="button"
      accessibilityLabel={`${log.level} ${log.event}: ${log.message}`}
    >
      <View style={styles.rowTop}>
        <Ionicons name={st.icon} size={15} color={st.fg} />
        <Text style={[styles.event, { color: st.fg }]} numberOfLines={1}>{log.event}</Text>
        <View style={[styles.sourceTag, { backgroundColor: st.bg }]}>
          <Text style={[styles.sourceText, { color: st.fg }]}>{log.source}</Text>
        </View>
        <View style={{ flex: 1 }} />
        <Text style={styles.time}>{formatTime(log.created_at)}</Text>
      </View>
      {log.message ? (
        <Text style={styles.message} numberOfLines={open ? undefined : 2}>{log.message}</Text>
      ) : null}
      {open && (details.length > 0 || meta) ? (
        <View style={styles.details}>
          {details.map(([k, v]) => (
            <Text key={k} style={styles.detailText} selectable>{k}: {v}</Text>
          ))}
          {meta ? <Text style={styles.detailText} selectable>{meta}</Text> : null}
        </View>
      ) : null}
    </Pressable>
  );
}

export default function AdminLogs() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [errors24h, setErrors24h] = useState<number | null>(null);

  const fetchPage = useCallback(
    async (before?: string) => {
      let q = supabase
        .from("system_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(PAGE);
      if (before) q = q.lt("created_at", before);
      if (filter === "error" || filter === "warn") q = q.eq("level", filter);
      if (filter === "grading") q = q.or("event.like.grade*,event.like.answer*");
      if (filter === "sessions") q = q.like("event", "session%");
      if (filter === "devices") q = q.like("event", "device%");
      const { data, error } = await q;
      if (error) {
        setErrorText(error.message);
        return [];
      }
      setErrorText(null);
      return (data ?? []) as Log[];
    },
    [filter]
  );

  const loadCounts = useCallback(async () => {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { count } = await supabase
      .from("system_logs")
      .select("id", { count: "exact", head: true })
      .eq("level", "error")
      .gte("created_at", since);
    setErrors24h(count ?? 0);
  }, []);

  const reload = useCallback(async () => {
    const rows = await fetchPage();
    setLogs(rows);
    setHasMore(rows.length === PAGE);
    setLoading(false);
    setRefreshing(false);
    loadCounts();
  }, [fetchPage, loadCounts]);

  useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  // Live: new logs appear at the top
  useEffect(() => {
    const channel = supabase
      .channel(`admin-logs-${Date.now()}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "system_logs" },
        (payload) => {
          const log = payload.new as Log;
          if (log.level === "error") setErrors24h((n) => (n ?? 0) + 1);
          if (!matches(log, filter)) return;
          setLogs((prev) => (prev.some((l) => l.id === log.id) ? prev : [log, ...prev]));
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [filter]);

  async function loadMore() {
    if (loadingMore || !hasMore || logs.length === 0) return;
    setLoadingMore(true);
    const rows = await fetchPage(logs[logs.length - 1].created_at);
    setLogs((prev) => {
      const seen = new Set(prev.map((l) => l.id));
      return [...prev, ...rows.filter((r) => !seen.has(r.id))];
    });
    setHasMore(rows.length === PAGE);
    setLoadingMore(false);
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.7 }]}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={22} color={C.navy} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>System Logs</Text>
          <Text style={styles.subtitle}>
            {errors24h === null
              ? "Live"
              : errors24h === 0
              ? "Live · no errors in the last 24h"
              : `Live · ${errors24h} error${errors24h === 1 ? "" : "s"} in the last 24h`}
          </Text>
        </View>
      </View>

      <View style={styles.chips}>
        {FILTERS.map((f) => {
          const active = f.key === filter;
          return (
            <Pressable
              key={f.key}
              onPress={() => setFilter(f.key)}
              style={[styles.chip, active && styles.chipActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{f.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {errorText ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>Couldn&apos;t load logs: {errorText}</Text>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.center}>
          <BrailleLoader size={16} />
        </View>
      ) : (
        <FlatList
          data={logs}
          keyExtractor={(l) => l.id}
          renderItem={({ item }) => <LogRow log={item} />}
          contentContainerStyle={styles.list}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                reload();
              }}
              tintColor={C.navy}
            />
          }
          ListFooterComponent={
            loadingMore ? (
              <View style={{ paddingVertical: 16 }}>
                <BrailleLoader size={10} />
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="document-text-outline" size={36} color={C.muted} />
              <Text style={styles.emptyText}>No logs here yet</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  backBtn: { padding: 4 },
  title: { fontFamily: fonts.heading, fontSize: 22, color: C.navy },
  subtitle: { fontFamily: fonts.mono, fontSize: 11, color: C.muted, marginTop: 2 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 100,
    borderWidth: 1.5,
    borderColor: C.border,
    backgroundColor: C.white,
  },
  chipActive: { backgroundColor: C.navy, borderColor: C.navy },
  chipText: { fontFamily: fonts.headingSemi, fontSize: 13, color: C.ink },
  chipTextActive: { color: C.white },
  errorBox: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 10,
    borderRadius: 8,
    backgroundColor: C.redBg,
    borderWidth: 1,
    borderColor: C.red,
  },
  errorText: { fontFamily: fonts.body, fontSize: 12, color: C.red },
  list: { paddingHorizontal: 16, paddingBottom: 32, gap: 8 },
  row: {
    backgroundColor: C.white,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    borderLeftWidth: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 6 },
  event: { fontFamily: fonts.mono, fontSize: 12, flexShrink: 1 },
  sourceTag: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 100 },
  sourceText: { fontFamily: fonts.mono, fontSize: 9 },
  time: { fontFamily: fonts.mono, fontSize: 10, color: C.muted },
  message: { fontFamily: fonts.body, fontSize: 13, color: C.ink, lineHeight: 18 },
  details: { marginTop: 4, padding: 8, borderRadius: 6, backgroundColor: C.bg, gap: 2 },
  detailText: { fontFamily: fonts.mono, fontSize: 10, color: C.muted },
  empty: { alignItems: "center", paddingTop: 60, gap: 8 },
  emptyText: { fontFamily: fonts.body, fontSize: 14, color: C.muted },
});
