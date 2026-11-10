// mobile/app/admin/activities.tsx
// Admin → Activities: every activity, filtered by status, and "New Activity".
// Tapping one opens the editor (draft) or the read-only view (published /
// hidden) in activity.tsx. Admin only: the admin layout sends anyone else
// away, and RLS only lets admins read drafts and hidden activities.

import { useCallback, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors as C, fonts, MIN_TOUCH } from "../../lib/theme";
import { DIFFICULTY_META } from "../../lib/difficulty";
import {
  type Activity,
  type ActivityDetails,
  type ActivityStatus,
  createActivity,
  listActivities,
  STATUS_COLORS,
  STATUS_LABEL,
} from "../../lib/activities";
import { BrailleLoader } from "../../components/BrailleLoader";
import { ActivityDetailsSheet } from "../../components/ActivityDetailsSheet";

type Filter = "all" | ActivityStatus;
const FILTERS: Filter[] = ["all", "draft", "published", "hidden"];
const FILTER_LABEL: Record<Filter, string> = { all: "All", ...STATUS_LABEL };

function ActivityRow({ activity, onPress }: { activity: Activity; onPress: () => void }) {
  const level = activity.level ? DIFFICULTY_META[activity.level] : null;
  const status = STATUS_COLORS[activity.status];
  const words = `${activity.word_count} word${activity.word_count === 1 ? "" : "s"}`;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
      accessibilityRole="button"
      accessibilityLabel={`${activity.name}, ${level ? level.label + ", " : ""}${words}, ${STATUS_LABEL[activity.status]}`}
    >
      <View style={styles.cardInfo}>
        <Text style={styles.cardName} numberOfLines={2}>
          {activity.name}
        </Text>
        <View style={styles.metaRow}>
          {level && (
            <View style={[styles.badge, { backgroundColor: level.badgeBg, borderColor: level.badgeBorder }]}>
              <Text style={[styles.badgeText, { color: level.badgeText }]}>{level.label}</Text>
            </View>
          )}
          <Text style={styles.meta}>{words}</Text>
        </View>
      </View>
      <View style={[styles.status, { backgroundColor: status.bg }]}>
        <Text style={[styles.statusText, { color: status.text }]}>{STATUS_LABEL[activity.status]}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={C.muted} />
    </Pressable>
  );
}

export default function AdminActivities() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [activities, setActivities] = useState<Activity[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const load = useCallback(async () => {
    const res = await listActivities();
    if (res.error !== null) setError(res.error);
    else {
      setActivities(res.data);
      setError("");
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  // Reload whenever the screen comes back (after editing, publishing, deleting)
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  async function create(details: ActivityDetails) {
    setCreating(true);
    setCreateError("");
    const res = await createActivity(details);
    setCreating(false);
    if (res.error !== null) {
      setCreateError(res.error);
      return;
    }
    setCreateOpen(false);
    router.push({ pathname: "/admin/activity" as any, params: { id: res.data } });
  }

  const shown = filter === "all" ? activities : activities.filter((a) => a.status === filter);
  const count = (f: Filter) => (f === "all" ? activities.length : activities.filter((a) => a.status === f).length);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.7 }]}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="arrow-back" size={22} color={C.navy} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Activities</Text>
          <Text style={styles.subtitle}>Word lists teachers can run</Text>
        </View>
      </View>

      <View style={styles.chips}>
        {FILTERS.map((f) => {
          const on = filter === f;
          return (
            <Pressable
              key={f}
              onPress={() => setFilter(f)}
              style={[styles.chip, on && styles.chipActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
            >
              <Text style={[styles.chipText, on && styles.chipTextActive]}>
                {FILTER_LABEL[f]} {count(f)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {!!error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{`Couldn't load activities: ${error}`}</Text>
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <BrailleLoader size={16} />
        </View>
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(a) => a.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load();
              }}
              tintColor={C.navy}
            />
          }
          renderItem={({ item }) => (
            <ActivityRow
              activity={item}
              onPress={() => router.push({ pathname: "/admin/activity" as any, params: { id: item.id } })}
            />
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>
                {filter === "all" ? "No activities yet" : `No ${FILTER_LABEL[filter].toLowerCase()} activities`}
              </Text>
              {filter === "all" && (
                <Text style={styles.emptyBody}>Tap New Activity to make the first word list.</Text>
              )}
            </View>
          }
        />
      )}

      <Pressable
        onPress={() => {
          setCreateError("");
          setCreateOpen(true);
        }}
        style={({ pressed }) => [
          styles.fab,
          { bottom: Math.max(insets.bottom, 16) + 16 },
          pressed && { opacity: 0.85 },
        ]}
        accessibilityRole="button"
        accessibilityLabel="New activity"
      >
        <Ionicons name="add" size={24} color="#1A1200" />
        <Text style={styles.fabText}>New Activity</Text>
      </Pressable>

      <ActivityDetailsSheet
        visible={createOpen}
        title="New activity"
        saveLabel="Create"
        saving={creating}
        error={createError}
        onCancel={() => setCreateOpen(false)}
        onSave={create}
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
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  backBtn: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: "center", justifyContent: "center" },
  title: { fontFamily: fonts.heading, fontSize: 22, color: C.navy },
  subtitle: { fontFamily: fonts.mono, fontSize: 11, color: C.muted, marginTop: 2 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  chip: {
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: 14,
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
  list: { padding: 16, paddingTop: 4, gap: 10, paddingBottom: 110 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: C.white,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1.5,
    borderColor: C.border,
  },
  cardInfo: { flex: 1, gap: 6 },
  cardName: { fontFamily: fonts.heading, fontSize: 16, color: C.navy },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  meta: { fontFamily: fonts.body, fontSize: 13, color: C.muted },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 100, borderWidth: 1 },
  badgeText: { fontFamily: fonts.mono, fontSize: 10 },
  status: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 100 },
  statusText: { fontFamily: fonts.mono, fontSize: 10 },
  empty: { alignItems: "center", padding: 40, marginTop: 24, gap: 8 },
  emptyTitle: { fontFamily: fonts.heading, fontSize: 18, color: C.navy },
  emptyBody: { fontFamily: fonts.body, fontSize: 14, color: C.muted, textAlign: "center" },
  fab: {
    position: "absolute",
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: C.amber,
    borderRadius: 100,
    paddingHorizontal: 24,
    paddingVertical: 14,
    elevation: 4,
    shadowColor: C.amber,
    shadowOpacity: 0.4,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  fabText: { fontFamily: fonts.heading, fontSize: 15, color: "#1A1200" },
});
