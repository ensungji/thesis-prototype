// mobile/components/activities/ActivityListScreen.tsx
// The Activities list, used by two routes:
//   admin    app/admin/activities.tsx: read-only overview of every activity
//            (drafts too), filtered by status, each "by <author> ·
//            Shared/Private · <status>". No New Activity: teachers make them.
//            Tapping one opens it read-only with Hide / Unhide.
//   teacher  app/(teacher)/sessions/activities.tsx: two tabs.
//              Mine    the teacher's own, any status, filtered by status
//                      (Hidden = hidden by an admin); New Activity
//              Shared  other teachers' shared published activities,
//                      "<name> · by <author>" (read-only, Duplicate)
// Tapping one opens ActivityEditorScreen (editor for the teacher's own draft,
// read-only otherwise). RLS decides what each user gets (migrations 24, 25).

import { useCallback, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors as C, fonts, MIN_TOUCH } from "../../lib/theme";
import { DIFFICULTY_META } from "../../lib/difficulty";
import {
  type ActivitiesArea,
  type Activity,
  type ActivityDetails,
  type ActivityStatus,
  ACTIVITY_ROUTE,
  byAuthor,
  createActivity,
  listActivities,
  myUserId,
  ownerStatusLabel,
  STATUS_COLORS,
  STATUS_LABEL,
} from "../../lib/activities";
import { BrailleLoader } from "../../components/BrailleLoader";
import { ActivityDetailsSheet } from "../../components/ActivityDetailsSheet";
import { MAINTENANCE_BLOCKED_HINT, useMaintenance } from "../../lib/maintenance";

type Filter = "all" | ActivityStatus;
const FILTERS: Filter[] = ["all", "draft", "published", "hidden"];
const FILTER_LABEL: Record<Filter, string> = { all: "All", ...STATUS_LABEL };

type Tab = "mine" | "shared";

type RowVariant = "mine" | "shared" | "admin";

function ActivityRow({
  activity,
  onPress,
  variant,
}: {
  activity: Activity;
  onPress: () => void;
  /** mine: status badge + Shared / Private; shared: "· by <author>";
   *  admin: "by <author> · Shared/Private · <status>" */
  variant: RowVariant;
}) {
  const level = activity.level ? DIFFICULTY_META[activity.level] : null;
  const status = STATUS_COLORS[activity.status];
  const words = `${activity.word_count} word${activity.word_count === 1 ? "" : "s"}`;
  const sharing = activity.shared ? "Shared" : "Private";
  // a draft is always private, so the tag only says something once published
  const showSharing = variant === "mine" && activity.status !== "draft";
  const adminLine = `${byAuthor(activity)} · ${sharing} · ${STATUS_LABEL[activity.status]}`;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
      accessibilityRole="button"
      accessibilityLabel={[
        activity.name,
        variant === "shared" ? byAuthor(activity) : undefined,
        level?.label,
        words,
        showSharing ? sharing : undefined,
        variant === "mine" ? ownerStatusLabel(activity.status) : undefined,
        variant === "admin" ? adminLine : undefined,
      ]
        .filter(Boolean)
        .join(", ")}
    >
      <View style={styles.cardInfo}>
        <Text style={styles.cardName} numberOfLines={2}>
          {activity.name}
          {variant === "shared" && <Text style={styles.cardBy}>{` · ${byAuthor(activity)}`}</Text>}
        </Text>
        <View style={styles.metaRow}>
          {level && (
            <View style={[styles.badge, { backgroundColor: level.badgeBg, borderColor: level.badgeBorder }]}>
              <Text style={[styles.badgeText, { color: level.badgeText }]}>{level.label}</Text>
            </View>
          )}
          <Text style={styles.meta}>{words}</Text>
          {showSharing && (
            <View style={styles.privateBadge}>
              <Ionicons name={activity.shared ? "people-outline" : "lock-closed-outline"} size={10} color={C.muted} />
              <Text style={styles.privateText}>{sharing}</Text>
            </View>
          )}
        </View>
        {variant === "admin" && (
          <Text style={styles.owner} numberOfLines={1}>
            {adminLine}
          </Text>
        )}
      </View>
      {variant === "mine" && (
        <View style={[styles.status, { backgroundColor: status.bg }]}>
          <Text style={[styles.statusText, { color: status.text }]}>{ownerStatusLabel(activity.status)}</Text>
        </View>
      )}
      <Ionicons name="chevron-forward" size={16} color={C.muted} />
    </Pressable>
  );
}

export function ActivityListScreen({ area }: { area: ActivitiesArea }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isAdmin = area === "admin";
  const [me, setMe] = useState<string | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [tab, setTab] = useState<Tab>("mine");
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const maintenance = useMaintenance();

  const load = useCallback(async () => {
    const [uid, res] = await Promise.all([myUserId(), listActivities()]);
    setMe(uid);
    if (res.error !== null) setError(res.error);
    else {
      setActivities(res.data);
      setError("");
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  const openActivity = (id: string) => router.push({ pathname: ACTIVITY_ROUTE[area] as any, params: { id } });

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
    openActivity(res.data);
  }

  // Teacher tabs: Mine = made by this teacher (any status); Shared = the rest
  // (RLS only returns other teachers' shared published ones). An admin sees one list.
  const mine = activities.filter((a) => !!me && a.created_by === me);
  const shared = activities.filter((a) => !me || a.created_by !== me);
  const onShared = !isAdmin && tab === "shared";
  const pool = isAdmin ? activities : onShared ? shared : mine;
  const showFilters = !onShared;
  // only a teacher makes activities (migration 25), on their Mine tab;
  // not during maintenance mode (migration 26: the banner says why)
  const canCreate = !isAdmin && !onShared;
  const frozen = !isAdmin && maintenance.on;
  const shown = !showFilters || filter === "all" ? pool : pool.filter((a) => a.status === filter);
  const count = (f: Filter) => (f === "all" ? pool.length : pool.filter((a) => a.status === f).length);

  const emptyTitle = onShared
    ? "Nothing shared yet"
    : filter !== "all"
    ? `No ${FILTER_LABEL[filter].toLowerCase()} activities`
    : isAdmin
    ? "No activities yet"
    : "You haven't made an activity yet";
  const emptyBody = onShared
    ? "Activities other teachers publish and share show up here. Duplicate one to make your own copy."
    : filter !== "all"
    ? ""
    : isAdmin
    ? "Teachers make activities. Every one shows up here, drafts included."
    : "Tap New Activity to make a word list. It stays private until you publish it and share it.";

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
          <Text style={styles.subtitle}>
            {isAdmin ? "Every teacher's word lists · you can hide or unhide published ones" : "Word lists you can run as a session"}
          </Text>
        </View>
      </View>

      {!isAdmin && (
        <View style={styles.tabs} accessibilityRole="tablist">
          {(["mine", "shared"] as Tab[]).map((t) => {
            const on = tab === t;
            const n = t === "mine" ? mine.length : shared.length;
            return (
              <Pressable
                key={t}
                onPress={() => setTab(t)}
                style={[styles.tab, on && styles.tabActive]}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${t === "mine" ? "Mine" : "Shared"}, ${n}`}
              >
                <Text style={[styles.tabText, on && styles.tabTextActive]}>
                  {t === "mine" ? "Mine" : "Shared"} {n}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {showFilters && (
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
      )}

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
          contentContainerStyle={[styles.list, !canCreate && { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}
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
              onPress={() => openActivity(item.id)}
              variant={isAdmin ? "admin" : onShared ? "shared" : "mine"}
            />
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{emptyTitle}</Text>
              {!!emptyBody && <Text style={styles.emptyBody}>{emptyBody}</Text>}
            </View>
          }
        />
      )}

      {canCreate && (
        <Pressable
          onPress={() => {
            setCreateError("");
            setCreateOpen(true);
          }}
          disabled={frozen}
          style={({ pressed }) => [
            styles.fab,
            // the teacher screen sits above the tab bar, which already clears the inset
            { bottom: 16 },
            frozen && { opacity: 0.45 },
            pressed && { opacity: 0.85 },
          ]}
          accessibilityRole="button"
          accessibilityState={{ disabled: frozen }}
          accessibilityHint={frozen ? MAINTENANCE_BLOCKED_HINT : undefined}
          accessibilityLabel="New activity"
        >
          <Ionicons name="add" size={24} color="#1A1200" />
          <Text style={styles.fabText}>New Activity</Text>
        </Pressable>
      )}

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
  tabs: {
    flexDirection: "row",
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 4,
    borderRadius: 12,
    backgroundColor: C.border,
  },
  tab: { flex: 1, minHeight: MIN_TOUCH, alignItems: "center", justifyContent: "center", borderRadius: 9 },
  tabActive: { backgroundColor: C.white },
  tabText: { fontFamily: fonts.headingSemi, fontSize: 14, color: C.muted },
  tabTextActive: { color: C.navy },
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
  cardBy: { fontFamily: fonts.body, fontSize: 14, color: C.muted },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  meta: { fontFamily: fonts.body, fontSize: 13, color: C.muted },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 100, borderWidth: 1 },
  badgeText: { fontFamily: fonts.mono, fontSize: 10 },
  owner: { fontFamily: fonts.body, fontSize: 12, color: C.muted },
  privateBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: C.border,
  },
  privateText: { fontFamily: fonts.mono, fontSize: 10, color: C.muted },
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
