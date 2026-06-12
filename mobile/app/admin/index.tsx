// mobile/app/admin/index.tsx
// Admin dashboard — view, create, edit, and deactivate teacher accounts.

import { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  Pressable,
  FlatList,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { colors as C, fonts } from "../../lib/theme";
import { BrailleLoader } from "../../components/BrailleLoader";

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
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Options sheet
  const [optionsModal, setOptionsModal] = useState(false);
  const [selected, setSelected] = useState<Teacher | null>(null);

  // Add teacher modal
  const [addModal, setAddModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPass, setNewPass] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newInstitution, setNewInstitution] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Edit teacher modal
  const [editModal, setEditModal] = useState(false);
  const [editName, setEditName] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editInstitution, setEditInstitution] = useState("");

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

  useEffect(() => {
    loadTeachers();
  }, [loadTeachers]);

  // ── Add teacher ────────────────────────────────────────────────────────────

  async function addTeacher() {
    if (!newName.trim() || !newEmail.trim() || !newPass.trim()) {
      setAddError("Name, email and password are required.");
      return;
    }
    if (newPass.trim().length < 6) {
      setAddError("Password must be at least 6 characters.");
      return;
    }
    setSaving(true);
    setAddError(null);

    const { data, error } = await supabase.functions.invoke("create-teacher", {
      body: {
        email: newEmail.trim().toLowerCase(),
        password: newPass.trim(),
        full_name: newName.trim(),
        title: newTitle.trim() || null,
        institution: newInstitution.trim() || null,
      },
    });

    setSaving(false);
    if (error || data?.error) {
      setAddError(error?.message ?? data?.error ?? "Failed to create teacher.");
      return;
    }
    setAddModal(false);
    resetAddForm();
    loadTeachers();
  }

  function resetAddForm() {
    setNewName("");
    setNewEmail("");
    setNewPass("");
    setNewTitle("");
    setNewInstitution("");
    setAddError(null);
  }

  // ── Edit teacher ───────────────────────────────────────────────────────────

  function openEdit(teacher: Teacher) {
    setEditName(teacher.full_name ?? "");
    setEditTitle(teacher.title ?? "");
    setEditInstitution(teacher.institution ?? "");
    setOptionsModal(false);
    setTimeout(() => setEditModal(true), 300);
  }

  async function saveEdit() {
    if (!selected) return;
    setSaving(true);
    await supabase
      .from("profiles")
      .update({
        full_name: editName.trim(),
        title: editTitle.trim() || null,
        institution: editInstitution.trim() || null,
      })
      .eq("id", selected.id);
    setSaving(false);
    setEditModal(false);
    loadTeachers();
  }

  // ── Toggle active ──────────────────────────────────────────────────────────

  async function toggleActive(teacher: Teacher) {
    const newState = !teacher.is_active;
    setOptionsModal(false);
    Alert.alert(
      newState ? "Activate Teacher" : "Deactivate Teacher",
      `${newState ? "Activate" : "Deactivate"} ${teacher.full_name || teacher.email}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Confirm",
          onPress: async () => {
            await supabase
              .from("profiles")
              .update({ is_active: newState })
              .eq("id", teacher.id);
            loadTeachers();
          },
        },
      ],
    );
  }

  // ── Sign out ───────────────────────────────────────────────────────────────

  async function signOut() {
    await supabase.auth.signOut();
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

  const activeCount = teachers.filter((t) => t.is_active).length;
  const inactiveCount = teachers.length - activeCount;

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
        onPress={() => {
          resetAddForm();
          setAddModal(true);
        }}
        style={({ pressed }) => [styles.fab, pressed && { opacity: 0.85 }]}
        accessibilityRole="button"
        accessibilityLabel="Add teacher"
      >
        <Ionicons name="add" size={24} color="#1A1200" />
        <Text style={styles.fabText}>Add Teacher</Text>
      </Pressable>

      {/* ── Options sheet ───────────────────────────────────────────────── */}
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
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>
              {selected?.full_name || selected?.email}
            </Text>
            <Text style={styles.sheetSub}>{selected?.email}</Text>

            <Pressable
              onPress={() => selected && openEdit(selected)}
              style={({ pressed }) => [
                styles.optionBtn,
                pressed && { backgroundColor: C.bg },
              ]}
            >
              <View
                style={[styles.optionIcon, { backgroundColor: C.blueWash }]}
              >
                <Ionicons name="pencil-outline" size={18} color={C.navy} />
              </View>
              <Text style={styles.optionText}>Edit Info</Text>
              <Ionicons name="chevron-forward" size={16} color={C.muted} />
            </Pressable>

            <Pressable
              onPress={() => selected && toggleActive(selected)}
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

      {/* ── Add Teacher modal ────────────────────────────────────────────── */}
      <Modal
        visible={addModal}
        animationType="slide"
        transparent
        onRequestClose={() => setAddModal(false)}
      >
        <KeyboardAvoidingView style={styles.keyboardSheet} behavior="padding">
          <Pressable
            style={styles.backdrop}
            onPress={() => setAddModal(false)}
          />
          <View style={[styles.sheet, { maxHeight: "90%" }]}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Add Teacher</Text>
            <ScrollView
              showsVerticalScrollIndicator={false}
              style={{ maxHeight: 480 }}
              contentContainerStyle={{ gap: 12 }}
            >
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Full name</Text>
                <TextInput
                  style={styles.input}
                  value={newName}
                  onChangeText={setNewName}
                  placeholder="e.g. Maria Santos"
                  placeholderTextColor={C.muted}
                  autoCapitalize="words"
                />
              </View>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Email</Text>
                <TextInput
                  style={styles.input}
                  value={newEmail}
                  onChangeText={setNewEmail}
                  placeholder="teacher@email.com"
                  placeholderTextColor={C.muted}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Temporary password</Text>
                <View style={styles.passRow}>
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    value={newPass}
                    onChangeText={setNewPass}
                    placeholder="Min. 6 characters"
                    placeholderTextColor={C.muted}
                    secureTextEntry={!showPass}
                    autoCapitalize="none"
                  />
                  <Pressable
                    onPress={() => setShowPass((v) => !v)}
                    style={styles.showBtn}
                  >
                    <Text style={styles.showBtnText}>
                      {showPass ? "Hide" : "Show"}
                    </Text>
                  </Pressable>
                </View>
              </View>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>
                  Title <Text style={styles.optional}>(optional)</Text>
                </Text>
                <TextInput
                  style={styles.input}
                  value={newTitle}
                  onChangeText={setNewTitle}
                  placeholder="e.g. Special Education Teacher"
                  placeholderTextColor={C.muted}
                  autoCapitalize="words"
                />
              </View>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>
                  Institution <Text style={styles.optional}>(optional)</Text>
                </Text>
                <TextInput
                  style={styles.input}
                  value={newInstitution}
                  onChangeText={setNewInstitution}
                  placeholder="e.g. Philippine School for the Deaf"
                  placeholderTextColor={C.muted}
                  autoCapitalize="words"
                />
              </View>
              {addError && (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{addError}</Text>
                </View>
              )}
            </ScrollView>
            <View style={styles.sheetActions}>
              <Pressable
                onPress={() => setAddModal(false)}
                style={({ pressed }) => [
                  styles.sheetBtn,
                  styles.btnCancel,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={styles.btnCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={addTeacher}
                disabled={saving}
                style={({ pressed }) => [
                  styles.sheetBtn,
                  styles.btnConfirm,
                  pressed && { opacity: 0.85 },
                ]}
              >
                {saving ? (
                  <ActivityIndicator color="#1A1200" />
                ) : (
                  <Text style={styles.btnConfirmText}>Create Account</Text>
                )}
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Edit Teacher modal ───────────────────────────────────────────── */}
      <Modal
        visible={editModal}
        animationType="slide"
        transparent
        onRequestClose={() => setEditModal(false)}
      >
        <KeyboardAvoidingView style={styles.keyboardSheet} behavior="padding">
          <Pressable
            style={styles.backdrop}
            onPress={() => setEditModal(false)}
          />
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Edit Teacher</Text>
            <View style={{ gap: 12 }}>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>Full name</Text>
                <TextInput
                  style={styles.input}
                  value={editName}
                  onChangeText={setEditName}
                  autoCapitalize="words"
                />
              </View>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>
                  Title <Text style={styles.optional}>(optional)</Text>
                </Text>
                <TextInput
                  style={styles.input}
                  value={editTitle}
                  onChangeText={setEditTitle}
                  placeholder="e.g. Special Education Teacher"
                  placeholderTextColor={C.muted}
                  autoCapitalize="words"
                />
              </View>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>
                  Institution <Text style={styles.optional}>(optional)</Text>
                </Text>
                <TextInput
                  style={styles.input}
                  value={editInstitution}
                  onChangeText={setEditInstitution}
                  placeholder="e.g. Philippine School for the Deaf"
                  placeholderTextColor={C.muted}
                  autoCapitalize="words"
                />
              </View>
            </View>
            <View style={styles.sheetActions}>
              <Pressable
                onPress={() => setEditModal(false)}
                style={({ pressed }) => [
                  styles.sheetBtn,
                  styles.btnCancel,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={styles.btnCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={saveEdit}
                disabled={saving}
                style={({ pressed }) => [
                  styles.sheetBtn,
                  styles.btnConfirm,
                  pressed && { opacity: 0.85 },
                ]}
              >
                {saving ? (
                  <ActivityIndicator color="#1A1200" />
                ) : (
                  <Text style={styles.btnConfirmText}>Save</Text>
                )}
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
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
    bottom: 32,
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

  // Modal shared
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
    gap: 14,
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
  sheetSub: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: C.muted,
    marginTop: -8,
  },

  // Options
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

  // Form
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
  passRow: { flexDirection: "row", gap: 8 },
  showBtn: {
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: C.border,
    backgroundColor: C.bg,
    justifyContent: "center",
  },
  showBtnText: { fontFamily: fonts.heading, fontSize: 13, color: C.navy },
  errorBox: {
    backgroundColor: C.redBg,
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: C.red,
  },
  errorText: { fontFamily: fonts.body, fontSize: 13, color: C.red },

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
