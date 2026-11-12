// mobile/app/(teacher)/sessions/new.tsx
// Dedicated screen for creating a new session.
// Three modes: Live Session, Timed Sequence, Activity. An Activity session is
// created as a pending session with type 'activity', then
// start_activity_session (migration 19) copies the activity's words into it in
// one step. If that refuses, the empty session is deleted again.
// The Activity list: published activities the teacher can see (RLS, migrations
// 24, 25): their own ("Mine") first, then other teachers' shared ones
// ("by <author> · Shared"). Hidden and draft ones aren't listed.
// Maintenance mode (migration 26): Create is greyed out with a note; the
// database refuses the insert anyway (DT002) and its message is shown.

import { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../lib/supabase";
import { colors as C, fonts } from "../../../lib/theme";
import { Toast } from "../../../components/Toast";
import {
  type SessionType,
  isTimedSequence,
  isLiveSession,
  isActivitySession,
} from "../../../lib/session-timer";
import { DIFFICULTY_META, type Difficulty } from "../../../lib/difficulty";
import { byAuthor, myUserId } from "../../../lib/activities";
import { isMaintenanceError, useMaintenance } from "../../../lib/maintenance";

// A published activity the teacher can run: shared, or their own
type PickActivity = {
  id: string;
  name: string;
  description: string | null;
  level: Difficulty | null;
  mine: boolean;
  author_name: string | null;
  words: string[]; // in order
};

const PREVIEW_WORDS = 5;

const MODES: { type: SessionType; label: string; sub: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { type: "live_session", label: "Live Session", sub: "Type words live", icon: "radio-outline" },
  { type: "timed_sequence", label: "Timed Sequence", sub: "Timed word sequence", icon: "timer-outline" },
  { type: "activity", label: "Activity", sub: "A ready-made word list · you move word by word", icon: "list-outline" },
];

const modeIs = (current: SessionType, mode: SessionType) =>
  mode === "activity"
    ? isActivitySession(current)
    : mode === "timed_sequence"
    ? isTimedSequence(current)
    : isLiveSession(current);

export default function NewSessionScreen() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [type, setType] = useState<SessionType>("live_session");
  const [saving, setSaving] = useState(false);
  // true  → an in_progress/paused session exists; creation is blocked
  const [blocked, setBlocked] = useState(false);
  const [errorToast, setErrorToast] = useState(false);
  const [createError, setCreateError] = useState<{ message: string; detail?: string } | null>(null);
  const maintenance = useMaintenance();

  /** A refused insert / start: maintenance gets its own title. */
  function showCreateError(message: string, err: { code?: string; message?: string } | null | undefined) {
    setCreateError(
      isMaintenanceError(err)
        ? { message: "Maintenance mode is on", detail: "New sessions can't be created until it ends." }
        : { message, detail: err?.message }
    );
  }

  // Activity mode
  const [activities, setActivities] = useState<PickActivity[] | null>(null); // null = not loaded yet
  const [activitiesError, setActivitiesError] = useState("");
  const [activityId, setActivityId] = useState<string | null>(null);
  const chosen = activities?.find((a) => a.id === activityId) ?? null;

  // Load the published activities the first time Activity is picked, and again
  // on coming back (e.g. from Activities after publishing one)
  useEffect(() => {
    if (!isActivitySession(type) || activities !== null) return;
    Promise.all([
      myUserId(),
      supabase
        .from("activities")
        .select("id, name, description, level, created_by, author_name, activity_words(word, position)")
        .eq("status", "published")
        .order("name"),
    ]).then(([me, { data, error }]) => {
      if (error) {
        setActivitiesError(error.message);
        setActivities([]);
        return;
      }
      setActivitiesError("");
      const list = (data ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        level: a.level as Difficulty | null,
        mine: !!me && a.created_by === me,
        author_name: a.author_name as string | null,
        words: [...((a.activity_words as { word: string; position: number }[]) ?? [])]
          .sort((x, y) => x.position - y.position)
          .map((w) => w.word),
      }));
      // their own first, each group by name (stable sort keeps the name order)
      setActivities(list.sort((x, y) => Number(y.mine) - Number(x.mine)));
    });
  }, [type, activities]);

  useFocusEffect(
    useCallback(() => {
      return () => setActivities(null); // reload next time the screen shows
    }, [])
  );

  function pickActivity(a: PickActivity) {
    setActivityId(a.id);
    if (!name.trim()) setName(a.name); // a sensible default; can be changed
  }

  /** Check whether the teacher already has an active session. */
  async function checkForActiveSession(): Promise<boolean> {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return false;
    const { count } = await supabase
      .from("sessions")
      .select("id", { count: "exact", head: true })
      .eq("teacher_id", user.id)
      .in("status", ["in_progress", "paused"]);
    return (count ?? 0) > 0;
  }

  // Pre-flight on mount — warn immediately if already blocked.
  useEffect(() => {
    checkForActiveSession().then((isBlocked) => {
      if (isBlocked) {
        setBlocked(true);
        setErrorToast(true);
      }
    });
  }, []);

  async function createSession() {
    if (!name.trim()) return;
    if (maintenance.on) {
      showCreateError("", { code: "DT002" });
      return;
    }
    setSaving(true);

    // ── Pre-flight check ─────────────────────────────────────────────────────
    const isBlocked = await checkForActiveSession();
    if (isBlocked) {
      setBlocked(true);
      setErrorToast(true);
      setSaving(false);
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    const {
      data: { user },
    } = await supabase.auth.getUser();

    // ── Activity: pending session, then copy the words in (one transaction) ──
    if (isActivitySession(type)) {
      if (!chosen) {
        setSaving(false);
        return;
      }
      const { data: created, error: insertError } = await supabase
        .from("sessions")
        .insert({
          teacher_id: user!.id,
          name: name.trim(),
          purpose: purpose.trim() || null,
          type: "activity",
        })
        .select("id")
        .single();
      if (insertError || !created) {
        setSaving(false);
        showCreateError("Couldn't create the session", insertError);
        return;
      }
      const { error: startError } = await supabase.rpc("start_activity_session", {
        p_session: created.id,
        p_activity: chosen.id,
      });
      if (startError) {
        // Don't leave an empty session behind
        await supabase.from("sessions").delete().eq("id", created.id);
        setSaving(false);
        showCreateError("Couldn't start the activity", startError);
        return;
      }
      setSaving(false);
      router.replace(`/(teacher)/sessions/${created.id}` as any);
      return;
    }

    let sessionType: string = type;
    let { data, error } = await supabase
      .from("sessions")
      .insert({
        teacher_id: user!.id,
        name: name.trim(),
        purpose: purpose.trim() || null,
        type: sessionType,
      })
      .select("id")
      .single();

    // Fallback if the database has a legacy check constraint
    if (error && error.message.includes("check")) {
      sessionType = isTimedSequence(type) ? "word_list" : "manual";
      const retry = await supabase
        .from("sessions")
        .insert({
          teacher_id: user!.id,
          name: name.trim(),
          purpose: purpose.trim() || null,
          type: sessionType,
        })
        .select("id")
        .single();
      data = retry.data;
      error = retry.error;
    }

    setSaving(false);
    if (error || !data) {
      showCreateError("Couldn't create the session", error);
      return;
    }
    router.replace(`/(teacher)/sessions/${data.id}` as any);
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={20} color={C.navy} />
          <Text style={styles.backText}>Sessions</Text>
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Page title */}
          <View style={styles.titleBlock}>
            <Text style={styles.pageTitle}>New Session</Text>
            <Text style={styles.pageSubtitle}>
              Set up the basics — you can assign students and words after.
            </Text>
          </View>

          {/* Session name */}
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

          {/* Session type */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Session type</Text>
            <View style={styles.typeList}>
              {MODES.map((m) => {
                const on = modeIs(type, m.type);
                return (
                  <Pressable
                    key={m.type}
                    onPress={() => setType(m.type)}
                    style={[styles.typeBtn, on && styles.typeBtnActive]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={`${m.label}: ${m.sub}`}
                  >
                    <Ionicons name={m.icon} size={20} color={on ? C.white : C.muted} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.typeBtnLabel, on && styles.typeBtnLabelActive]}>{m.label}</Text>
                      <Text style={[styles.typeBtnSub, on && { color: "rgba(255,255,255,0.7)" }]}>{m.sub}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Activity: pick a published activity */}
          {isActivitySession(type) && (
            <View style={styles.fieldGroup}>
              <View style={styles.labelRow}>
                <Text style={styles.label}>Activity</Text>
                <Pressable
                  onPress={() => router.push("/(teacher)/sessions/activities" as any)}
                  style={({ pressed }) => [styles.manageLink, pressed && { opacity: 0.6 }]}
                  accessibilityRole="link"
                  accessibilityLabel="Manage activities"
                  accessibilityHint="Make your own activities or copy a shared one"
                >
                  <Text style={styles.manageLinkText}>Manage activities</Text>
                  <Ionicons name="chevron-forward" size={14} color={C.navy} />
                </Pressable>
              </View>
              {activities === null ? (
                <ActivityIndicator color={C.navy} style={{ marginVertical: 12 }} />
              ) : activities.length === 0 ? (
                <Text style={styles.emptyText}>
                  {activitiesError
                    ? `Couldn't load activities: ${activitiesError}`
                    : "No activities to run yet. Make and publish your own in Manage activities, or ask another teacher to share one."}
                </Text>
              ) : (
                activities.map((a) => {
                  const on = a.id === activityId;
                  const level = a.level ? DIFFICULTY_META[a.level] : null;
                  const rest = a.words.length - PREVIEW_WORDS;
                  return (
                    <Pressable
                      key={a.id}
                      onPress={() => pickActivity(a)}
                      style={({ pressed }) => [styles.activityCard, on && styles.activityCardActive, pressed && { opacity: 0.85 }]}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={`${a.name}, ${a.mine ? "mine" : `${byAuthor(a)}, shared`}, ${level ? level.label + ", " : ""}${a.words.length} words: ${a.words
                        .slice(0, PREVIEW_WORDS)
                        .join(", ")}`}
                    >
                      <View style={styles.activityTop}>
                        <Ionicons
                          name={on ? "radio-button-on" : "radio-button-off"}
                          size={20}
                          color={on ? C.navy : C.muted}
                        />
                        <Text style={styles.activityName} numberOfLines={2}>
                          {a.name}
                        </Text>
                        {level && (
                          <View style={[styles.levelBadge, { backgroundColor: level.badgeBg, borderColor: level.badgeBorder }]}>
                            <Text style={[styles.levelBadgeText, { color: level.badgeText }]}>{level.label}</Text>
                          </View>
                        )}
                      </View>
                      <View style={styles.activityMetaRow}>
                        <View style={[styles.ownerTag, a.mine && styles.ownerTagMine]}>
                          <Ionicons
                            name={a.mine ? "person-outline" : "people-outline"}
                            size={11}
                            color={a.mine ? C.navy : C.muted}
                          />
                          <Text style={[styles.ownerTagText, a.mine && { color: C.navy }]} numberOfLines={1}>
                            {a.mine ? "Mine" : `${byAuthor(a)} · Shared`}
                          </Text>
                        </View>
                        <Text style={[styles.activityMeta, { marginLeft: 0 }]}>
                          {a.words.length} word{a.words.length === 1 ? "" : "s"}
                        </Text>
                      </View>
                      <Text style={styles.activityWords} numberOfLines={1}>
                        {a.words.slice(0, PREVIEW_WORDS).join(" · ")}
                        {rest > 0 ? `  +${rest} more` : ""}
                      </Text>
                    </Pressable>
                  );
                })
              )}
            </View>
          )}
        </ScrollView>

        {/* Sticky create button */}
        <View style={styles.footer}>
          {maintenance.on && (
            <Text style={styles.maintenanceNote} accessibilityLiveRegion="polite">
              Maintenance mode is on: new sessions can&apos;t be created until it ends.
            </Text>
          )}
          <Pressable
            onPress={createSession}
            disabled={saving || !name.trim() || blocked || maintenance.on || (isActivitySession(type) && !chosen)}
            style={({ pressed }) => [
              styles.createBtn,
              (saving || !name.trim() || blocked || maintenance.on || (isActivitySession(type) && !chosen)) && { opacity: 0.5 },
              pressed && { opacity: 0.85 },
            ]}
            accessibilityHint={
              maintenance.on
                ? "Maintenance mode is on"
                : isActivitySession(type) && !chosen
                ? "Pick an activity first"
                : undefined
            }
          >
            {saving ? (
              <ActivityIndicator color="#1A1200" />
            ) : (
              <>
                <Ionicons name="checkmark" size={18} color="#1A1200" />
                <Text style={styles.createBtnText}>Create Session</Text>
              </>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      {/* Active-session block toast — rendered outside KeyboardAvoidingView
          so it always appears over the footer bar at the bottom. */}
      <Toast
        message="Cannot create: Another session is currently active."
        visible={errorToast}
        variant="delete"
        duration={4000}
        onDismiss={() => setErrorToast(false)}
      />
      <Toast
        message={createError?.message ?? ""}
        detail={createError?.detail}
        visible={!!createError}
        variant="warning"
        duration={7000}
        onDismiss={() => setCreateError(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: C.white,
    borderBottomWidth: 1.5,
    borderBottomColor: C.border,
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  backText: {
    fontFamily: fonts.heading,
    fontSize: 15,
    color: C.navy,
  },

  scroll: {
    padding: 20,
    gap: 24,
  },

  titleBlock: { gap: 6 },
  pageTitle: { fontFamily: fonts.heading, fontSize: 28, color: C.navy },
  pageSubtitle: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: C.muted,
    lineHeight: 20,
  },

  fieldGroup: { gap: 8 },
  label: { fontFamily: fonts.heading, fontSize: 14, color: C.navy },
  optional: { fontFamily: fonts.body, fontSize: 12, color: C.muted },
  input: {
    fontFamily: fonts.body,
    fontSize: 15,
    color: C.ink,
    backgroundColor: C.white,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  multiline: { minHeight: 90, paddingTop: 14 },

  typeList: { gap: 10 },
  typeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 14,
    padding: 16,
    backgroundColor: C.white,
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
    marginTop: 2,
  },

  emptyText: { fontFamily: fonts.body, fontSize: 14, color: C.muted, lineHeight: 20 },
  activityCard: {
    gap: 4,
    borderRadius: 14,
    padding: 14,
    backgroundColor: C.white,
    borderWidth: 1.5,
    borderColor: C.border,
  },
  activityCardActive: { borderColor: C.navy, backgroundColor: C.blueWash },
  activityTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  activityName: { flex: 1, fontFamily: fonts.heading, fontSize: 15, color: C.navy },
  activityMeta: { fontFamily: fonts.body, fontSize: 12, color: C.muted, marginLeft: 30 },
  activityWords: { fontFamily: fonts.mono, fontSize: 13, color: C.ink, letterSpacing: 0.5, marginLeft: 30 },
  labelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  manageLink: { flexDirection: "row", alignItems: "center", gap: 2, minHeight: 40, paddingLeft: 12 },
  manageLinkText: { fontFamily: fonts.headingSemi, fontSize: 13, color: C.navy },
  activityMetaRow: { flexDirection: "row", alignItems: "center", gap: 8, marginLeft: 30 },
  ownerTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: C.border,
    flexShrink: 1,
  },
  maintenanceNote: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: C.brown,
    backgroundColor: C.brownBg,
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    textAlign: "center",
  },
  ownerTagMine: { borderColor: C.navy, backgroundColor: C.blueWash },
  ownerTagText: { fontFamily: fonts.mono, fontSize: 10, color: C.muted },
  levelBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 100, borderWidth: 1 },
  levelBadgeText: { fontFamily: fonts.mono, fontSize: 10 },

  footer: {
    padding: 16,
    paddingBottom: 24,
    backgroundColor: C.bg,
    borderTopWidth: 1.5,
    borderTopColor: C.border,
  },
  createBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: C.amber,
    borderRadius: 14,
    paddingVertical: 16,
  },
  createBtnText: { fontFamily: fonts.heading, fontSize: 17, color: "#1A1200" },
});
