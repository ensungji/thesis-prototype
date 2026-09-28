// mobile/app/admin/index.tsx
// Admin dashboard — view, create, edit, and deactivate teacher accounts.

import { useState, useCallback } from "react";
import {
  View,
  Text,
  Pressable,
  FlatList,
  Modal,
  StyleSheet,
  RefreshControl,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { colors as C, fonts } from "../../lib/theme";
import { BrailleLoader } from "../../components/BrailleLoader";
import { Toast } from "../../components/Toast";

// ── Types ─────────────────────────────────────────────────────────────────────

type Teacher = {
  id: string;
  email: string;
  full_name: string;
  role: string;
  title: string | null;
  institution: string | null;
  is_active: boolean;
  created_at: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getInitials(name: string): string {
  return name
    .trim()
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

// ── Teacher card ──────────────────────────────────────────────────────────────

function TeacherCard({
  teacher,
  onPress,
}: {
  teacher: Teacher;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
      accessibilityRole="button"
    >
      <View
        style={[
          styles.avatar,
          !teacher.is_active && { backgroundColor: C.muted },
        ]}
      >
        <Text style={styles.avatarText}>
          {getInitials(teacher.full_name || teacher.email)}
        </Text>
      </View>
      <View style={styles.cardInfo}>
        <View style={styles.cardNameRow}>
          <Text style={styles.teacherName}>{teacher.full_name || "—"}</Text>
          <View
            style={[
              styles.badge,
              { backgroundColor: teacher.is_active ? C.greenBg : C.redBg },
            ]}
          >
            <Text
              style={[
                styles.badgeText,
                { color: teacher.is_active ? C.green : C.red },
              ]}
            >
              {teacher.is_active ? "Active" : "Inactive"}
            </Text>
          </View>
        </View>
        <Text style={styles.teacherEmail}>{teacher.email}</Text>
        {(teacher.title || teacher.institution) && (
          <Text style={styles.teacherMeta} numberOfLines={1}>
            {[teacher.title, teacher.institution].filter(Boolean).join(" · ")}
          </Text>
        )}
      </View>
      <Ionicons name="chevron-forward" size={16} color={C.muted} />
    </Pressable>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    created?: string;
    updated?: string;
  }>();

  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Sign-out confirm sheet
  const [signOutModal, setSignOutModal] = useState(false);
  const [signingOut, setSigningOut]     = useState(false);

  // Options sheet
  const [optionsModal, setOptionsModal] = useState(false);
  const [selected, setSelected] = useState<Teacher | null>(null);

  // Custom confirm sheet (replaces Alert.alert)
  const [confirmModal, setConfirmModal] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<Teacher | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Toast
  type ToastState = { message: string; detail?: string; variant: "success" | "delete" } | null;
  const [toast, setToast] = useState<ToastState>(null);

  // ── Load ───────────────────────────────────────────────────────────────────

  const loadTeachers = useCallback(async () => {
    const { data } = await supabase
      .from("profiles")
      .select("*")
      .eq("role", "teacher")
      .order("full_name");
    setTeachers(data ?? []);
    setLoading(false);
    setRefreshing(false);
  }, []);

  // On focus: load data + toast params, subscribe to realtime.
  // On blur:  unsubscribe so we never accumulate duplicate channels.
  useFocusEffect(
    useCallback(() => {
      loadTeachers();

      if (params.created) {
        setToast({ message: "Account created", detail: params.created, variant: "success" });
        router.setParams({ created: undefined });
      }
      if (params.updated) {
        setToast({ message: "Profile updated", detail: params.updated, variant: "success" });
        router.setParams({ updated: undefined });
      }

      // Realtime — re-fetch the full list on any change to the profiles table.
      // Unique name per mount — prevents Supabase channel cache collisions.
      const channel = supabase
        .channel(`admin-profiles-realtime-${Date.now()}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "profiles" },
          () => loadTeachers(),
        )
        .subscribe();

      return () => {
        supabase.removeChannel(channel);
      };
    }, [loadTeachers, params.created, params.updated, router]),
  );

  // ── Toggle active — opens custom confirm sheet ──────────────────────────────

  function requestToggle(teacher: Teacher) {
    setOptionsModal(false);
    // Small delay so the options sheet finishes closing before confirm opens
    setTimeout(() => {
      setConfirmTarget(teacher);
      setConfirmModal(true);
    }, 280);
  }

  async function confirmToggle() {
    if (!confirmTarget) return;
    setConfirming(true);
    const newState = !confirmTarget.is_active;
    await supabase
      .from("profiles")
      .update({ is_active: newState })
      .eq("id", confirmTarget.id);
    setConfirming(false);
    setConfirmModal(false);
    loadTeachers();
    setToast({
      message: newState ? "Teacher activated" : "Teacher deactivated",
      detail: confirmTarget.full_name || confirmTarget.email,
      variant: newState ? "success" : "delete",
    });
    setConfirmTarget(null);
  }

  // ── Sign out ───────────────────────────────────────────────────────────────

  function signOut() {
    setSignOutModal(true);
  }

  async function confirmSignOut() {
    setSigningOut(true);
    await supabase.auth.signOut();
    // router.replace("/") is handled automatically by the auth listener in _layout
    setSigningOut(false);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.center}>
          <BrailleLoader size={16} />
        </View>
      </SafeAreaView>
    );
  }

  const activeCount   = teachers.filter((t) => t.is_active).length;
  const inactiveCount = teachers.length - activeCount;

  // For the confirm sheet
  const isDeactivating = confirmTarget?.is_active ?? true;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Admin Panel</Text>
          <Text style={styles.subtitle}>Braille D.O.T.S</Text>
        </View>
        <Pressable
          onPress={signOut}
          style={({ pressed }) => [
            styles.signOutBtn,
            pressed && { opacity: 0.7 },
          ]}
          accessibilityRole="button"
        >
          <Ionicons name="log-out-outline" size={18} color={C.red} />
          <Text style={styles.signOutText}>Sign Out</Text>
        </Pressable>
      </View>

      {/* Summary row */}
      <View style={styles.summaryRow}>
        <View style={[styles.summaryCard, { backgroundColor: C.greenBg }]}>
          <Text style={[styles.summaryValue, { color: C.green }]}>
            {activeCount}
          </Text>
          <Text style={styles.summaryLabel}>Active</Text>
        </View>
        <View style={[styles.summaryCard, { backgroundColor: C.redBg }]}>
          <Text style={[styles.summaryValue, { color: C.red }]}>
            {inactiveCount}
          </Text>
          <Text style={styles.summaryLabel}>Inactive</Text>
        </View>
        <View style={[styles.summaryCard, { backgroundColor: C.blueWash }]}>
          <Text style={[styles.summaryValue, { color: C.navy }]}>
            {teachers.length}
          </Text>
          <Text style={styles.summaryLabel}>Total</Text>
        </View>
      </View>

      {/* Teacher list */}
      <FlatList
        data={teachers}
        keyExtractor={(t) => t.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              loadTeachers();
            }}
            tintColor={C.navy}
          />
        }
        renderItem={({ item }) => (
          <TeacherCard
            teacher={item}
            onPress={() => {
              setSelected(item);
              setOptionsModal(true);
            }}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No teachers yet</Text>
            <Text style={styles.emptyBody}>
              Tap + Add to create the first teacher account.
            </Text>
          </View>
        }
      />

      {/* FAB — Add Teacher */}
      <Pressable
        onPress={() => router.push("/admin/add-teacher" as any)}
        style={({ pressed }) => [
          styles.fab,
          { bottom: Math.max(insets.bottom, 16) + 16 },
          pressed && { opacity: 0.85 },
        ]}
        accessibilityRole="button"
        accessibilityLabel="Add teacher"
      >
        <Ionicons name="add" size={24} color="#1A1200" />
        <Text style={styles.fabText}>Add Teacher</Text>
      </Pressable>

      {/* Toast */}
      <Toast
        message={toast?.message ?? ""}
        detail={toast?.detail}
        visible={!!toast}
        variant={toast?.variant ?? "success"}
        onDismiss={() => setToast(null)}
      />

      {/* ── Sign-out confirm sheet ────────────────────────────────────────── */}
      <Modal
        visible={signOutModal}
        animationType="slide"
        transparent
        onRequestClose={() => !signingOut && setSignOutModal(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable
            style={styles.backdrop}
            onPress={() => !signingOut && setSignOutModal(false)}
          />
          <View style={[styles.confirmSheet, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}>
            <View style={styles.handle} />

            {/* Icon */}
            <View style={[styles.confirmIconWrap, { backgroundColor: C.redBg }]}>
              <Ionicons name="log-out-outline" size={32} color={C.red} />
            </View>

            <Text style={styles.confirmTitle}>Sign Out?</Text>
            <Text style={styles.confirmBody}>
              You will be returned to the login screen. Any unsaved changes will be lost.
            </Text>

            <View style={[styles.confirmActions, { marginTop: 8 }]}>
              <Pressable
                onPress={() => setSignOutModal(false)}
                disabled={signingOut}
                style={({ pressed }) => [
                  styles.confirmBtn,
                  styles.confirmBtnCancel,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={styles.confirmBtnCancelText}>Cancel</Text>
              </Pressable>

              <Pressable
                onPress={confirmSignOut}
                disabled={signingOut}
                style={({ pressed }) => [
                  styles.confirmBtn,
                  styles.confirmBtnDanger,
                  (signingOut || pressed) && { opacity: 0.75 },
                ]}
              >
                <Ionicons name="log-out-outline" size={16} color={C.red} />
                <Text style={[styles.confirmBtnActionText, { color: C.red }]}>
                  {signingOut ? "Signing out…" : "Yes, Sign Out"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Options sheet ─────────────────────────────────────────────────── */}
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
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>
              {selected?.full_name || selected?.email}
            </Text>
            <Text style={styles.sheetSub}>{selected?.email}</Text>

            {/* Edit Info */}
            <Pressable
              onPress={() => {
                setOptionsModal(false);
                router.push({
                  pathname: "/admin/edit-teacher" as any,
                  params: {
                    id: selected?.id,
                    full_name: selected?.full_name ?? "",
                    title: selected?.title ?? "",
                    institution: selected?.institution ?? "",
                  },
                });
              }}
              style={({ pressed }) => [
                styles.optionBtn,
                pressed && { backgroundColor: C.bg },
              ]}
            >
              <View style={[styles.optionIcon, { backgroundColor: C.blueWash }]}>
                <Ionicons name="pencil-outline" size={18} color={C.navy} />
              </View>
              <Text style={styles.optionText}>Edit Info</Text>
              <Ionicons name="chevron-forward" size={16} color={C.muted} />
            </Pressable>

            {/* Reset Password */}
            <Pressable
              onPress={() => {
                setOptionsModal(false);
                router.push({
                  pathname: "/admin/reset-password" as any,
                  params: {
                    id: selected?.id,
                    full_name: selected?.full_name ?? "",
                    email: selected?.email ?? "",
                  },
                });
              }}
              style={({ pressed }) => [
                styles.optionBtn,
                pressed && { backgroundColor: C.bg },
              ]}
            >
              <View style={[styles.optionIcon, { backgroundColor: "#FFF4E0" }]}>
                <Ionicons name="lock-closed-outline" size={18} color="#B45309" />
              </View>
              <Text style={styles.optionText}>Reset Password</Text>
              <Ionicons name="chevron-forward" size={16} color={C.muted} />
            </Pressable>

            {/* Toggle active/inactive — opens custom confirm sheet */}
            <Pressable
              onPress={() => selected && requestToggle(selected)}
              style={({ pressed }) => [
                styles.optionBtn,
                pressed && { backgroundColor: C.bg },
              ]}
            >
              <View
                style={[
                  styles.optionIcon,
                  {
                    backgroundColor: selected?.is_active ? C.redBg : C.greenBg,
                  },
                ]}
              >
                <Ionicons
                  name={
                    selected?.is_active
                      ? "ban-outline"
                      : "checkmark-circle-outline"
                  }
                  size={18}
                  color={selected?.is_active ? C.red : C.green}
                />
              </View>
              <Text
                style={[
                  styles.optionText,
                  { color: selected?.is_active ? C.red : C.green },
                ]}
              >
                {selected?.is_active ? "Deactivate" : "Activate"}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={C.muted} />
            </Pressable>

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

      {/* ── Confirm sheet (activate / deactivate) ─────────────────────────── */}
      <Modal
        visible={confirmModal}
        animationType="slide"
        transparent
        onRequestClose={() => !confirming && setConfirmModal(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable
            style={styles.backdrop}
            onPress={() => !confirming && setConfirmModal(false)}
          />
          <View style={[styles.confirmSheet, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}>
            <View style={styles.handle} />

            {/* Icon */}
            <View
              style={[
                styles.confirmIconWrap,
                { backgroundColor: isDeactivating ? C.redBg : C.greenBg },
              ]}
            >
              <Ionicons
                name={isDeactivating ? "ban-outline" : "checkmark-circle-outline"}
                size={32}
                color={isDeactivating ? C.red : C.green}
              />
            </View>

            {/* Title */}
            <Text style={styles.confirmTitle}>
              {isDeactivating ? "Deactivate Teacher?" : "Activate Teacher?"}
            </Text>

            {/* Teacher name pill */}
            <View style={styles.confirmNamePill}>
              <View style={[styles.confirmPillAvatar, !confirmTarget?.is_active && { backgroundColor: C.muted }]}>
                <Text style={styles.confirmPillAvatarText}>
                  {confirmTarget ? getInitials(confirmTarget.full_name || confirmTarget.email) : ""}
                </Text>
              </View>
              <View>
                <Text style={styles.confirmPillName}>
                  {confirmTarget?.full_name || confirmTarget?.email}
                </Text>
                <Text style={styles.confirmPillEmail}>{confirmTarget?.email}</Text>
              </View>
            </View>

            {/* Description */}
            <Text style={styles.confirmBody}>
              {isDeactivating
                ? "This teacher will no longer be able to sign in. Their students and sessions will remain intact and can be restored by reactivating the account."
                : "This teacher will regain full access to their account, students, and sessions immediately."}
            </Text>

            {/* Actions */}
            <View style={styles.confirmActions}>
              <Pressable
                onPress={() => setConfirmModal(false)}
                disabled={confirming}
                style={({ pressed }) => [
                  styles.confirmBtn,
                  styles.confirmBtnCancel,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={styles.confirmBtnCancelText}>Cancel</Text>
              </Pressable>

              <Pressable
                onPress={confirmToggle}
                disabled={confirming}
                style={({ pressed }) => [
                  styles.confirmBtn,
                  isDeactivating ? styles.confirmBtnDanger : styles.confirmBtnSuccess,
                  (confirming || pressed) && { opacity: 0.75 },
                ]}
              >
                <Ionicons
                  name={isDeactivating ? "ban-outline" : "checkmark-circle-outline"}
                  size={16}
                  color={isDeactivating ? C.red : C.green}
                />
                <Text
                  style={[
                    styles.confirmBtnActionText,
                    { color: isDeactivating ? C.red : C.green },
                  ]}
                >
                  {confirming
                    ? isDeactivating ? "Deactivating…" : "Activating…"
                    : isDeactivating ? "Yes, Deactivate" : "Yes, Activate"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

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
  title: { fontFamily: fonts.heading, fontSize: 22, color: C.navy },
  subtitle: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: C.brown,
    letterSpacing: 0.5,
  },
  signOutBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: C.redBg,
  },
  signOutText: { fontFamily: fonts.heading, fontSize: 13, color: C.red },

  summaryRow: { flexDirection: "row", gap: 10, padding: 16, paddingBottom: 4 },
  summaryCard: {
    flex: 1,
    borderRadius: 12,
    padding: 12,
    alignItems: "center",
    gap: 2,
  },
  summaryValue: { fontFamily: fonts.heading, fontSize: 24 },
  summaryLabel: { fontFamily: fonts.body, fontSize: 11, color: C.ink },

  list: { padding: 16, gap: 12, paddingBottom: 100 },

  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: C.white,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1.5,
    borderColor: C.border,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: C.navy,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontFamily: fonts.heading, fontSize: 16, color: C.white },
  cardInfo: { flex: 1, gap: 3 },
  cardNameRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  teacherName: {
    fontFamily: fonts.heading,
    fontSize: 15,
    color: C.navy,
    flex: 1,
  },
  teacherEmail: { fontFamily: fonts.body, fontSize: 12, color: C.muted },
  teacherMeta: { fontFamily: fonts.body, fontSize: 11, color: C.muted },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 100 },
  badgeText: { fontFamily: fonts.mono, fontSize: 9 },

  empty: {
    alignItems: "center",
    justifyContent: "center",
    padding: 40,
    marginTop: 40,
    gap: 8,
  },
  emptyTitle: { fontFamily: fonts.heading, fontSize: 18, color: C.navy },
  emptyBody: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: C.muted,
    textAlign: "center",
  },

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

  // ── Shared modal primitives ─────────────────────────────────────────────────
  modalOverlay: { flex: 1, justifyContent: "flex-end" },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: C.border,
    alignSelf: "center",
    marginBottom: 4,
  },

  // ── Options sheet ───────────────────────────────────────────────────────────
  sheet: {
    backgroundColor: C.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    gap: 14,
  },
  sheetTitle: { fontFamily: fonts.heading, fontSize: 20, color: C.navy },
  sheetSub: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: C.muted,
    marginTop: -8,
  },
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
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    backgroundColor: C.bg,
    borderWidth: 1.5,
    borderColor: C.border,
  },
  cancelBtnText: { fontFamily: fonts.heading, fontSize: 15, color: C.navy },

  // ── Confirm sheet ───────────────────────────────────────────────────────────
  confirmSheet: {
    backgroundColor: C.white,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 24,
    gap: 16,
    alignItems: "center",
  },
  confirmIconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 8,
  },
  confirmTitle: {
    fontFamily: fonts.heading,
    fontSize: 22,
    color: C.navy,
    textAlign: "center",
  },

  // Teacher name pill inside confirm sheet
  confirmNamePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: C.bg,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignSelf: "stretch",
  },
  confirmPillAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.navy,
    alignItems: "center",
    justifyContent: "center",
  },
  confirmPillAvatarText: { fontFamily: fonts.heading, fontSize: 14, color: C.white },
  confirmPillName: { fontFamily: fonts.heading, fontSize: 15, color: C.navy },
  confirmPillEmail: { fontFamily: fonts.body, fontSize: 12, color: C.muted },

  confirmBody: {
    fontFamily: fonts.body,
    fontSize: 13.5,
    color: C.ink,
    textAlign: "center",
    lineHeight: 21,
    paddingHorizontal: 4,
  },

  // Action buttons row
  confirmActions: {
    flexDirection: "row",
    gap: 10,
    alignSelf: "stretch",
    marginTop: 4,
  },
  confirmBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 14,
    paddingVertical: 14,
    borderWidth: 1.5,
  },
  confirmBtnCancel: {
    backgroundColor: C.bg,
    borderColor: C.border,
  },
  confirmBtnDanger: {
    backgroundColor: C.redBg,
    borderColor: C.red,
  },
  confirmBtnSuccess: {
    backgroundColor: C.greenBg,
    borderColor: C.green,
  },
  confirmBtnCancelText: {
    fontFamily: fonts.heading,
    fontSize: 15,
    color: C.navy,
  },
  confirmBtnActionText: {
    fontFamily: fonts.heading,
    fontSize: 15,
  },
});
