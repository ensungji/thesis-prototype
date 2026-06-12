// mobile/app/(teacher)/students/index.tsx
// Student list — tap card to view detail + options inside.

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
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../../lib/supabase";
import { colors as C, fonts } from "../../../lib/theme";
import { BrailleCell } from "../../../components/BrailleCell";
import { BrailleLoader } from "../../../components/BrailleLoader";

type Device = {
  id: string;
  device_code: string;
  status: string;
  paired_student_id: string;
};

type Student = {
  id: string;
  full_name: string;
  created_at: string;
  device: Device | null;
};

function getInitials(name: string): string {
  return name
    .trim()
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

const DEVICE_STATUS: Record<
  string,
  { bg: string; text: string; label: string }
> = {
  connected: { bg: C.greenBg, text: C.green, label: "Connected" },
  offline: { bg: C.redBg, text: C.red, label: "Offline" },
  pending: { bg: C.blueWash, text: C.navy, label: "Pending" },
};

// ── Student card — clean, no action buttons. Options live inside detail. ──────

function StudentCard({
  student,
  onPress,
}: {
  student: Student;
  onPress: () => void;
}) {
  const ds = student.device
    ? (DEVICE_STATUS[student.device.status] ?? DEVICE_STATUS.pending)
    : null;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
      accessibilityRole="button"
      accessibilityLabel={`View ${student.full_name}`}
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{getInitials(student.full_name)}</Text>
      </View>
      <View style={styles.cardInfo}>
        <Text style={styles.studentName}>{student.full_name}</Text>
        {student.device ? (
          <View style={styles.deviceRow}>
            <Text style={styles.deviceCode}>{student.device.device_code}</Text>
            <View style={[styles.badge, { backgroundColor: ds!.bg }]}>
              <Text style={[styles.badgeText, { color: ds!.text }]}>
                {ds!.label}
              </Text>
            </View>
          </View>
        ) : (
          <Text style={styles.noDevice}>No device paired</Text>
        )}
      </View>
      <Ionicons name="chevron-forward" size={18} color={C.muted} />
    </Pressable>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function StudentsScreen() {
  const router = useRouter();

  const [students, setStudents] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [addModal, setAddModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);

  const loadStudents = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const { data: studentsData } = await supabase
      .from("students")
      .select("id, full_name, created_at")
      .eq("teacher_id", user.id)
      .order("full_name");

    if (!studentsData) {
      setLoading(false);
      setRefreshing(false);
      return;
    }

    const ids = studentsData.map((s) => s.id);
    const { data: devicesData } =
      ids.length > 0
        ? await supabase
            .from("devices")
            .select("*")
            .in("paired_student_id", ids)
        : { data: [] };

    setStudents(
      studentsData.map((s) => ({
        ...s,
        device: devicesData?.find((d) => d.paired_student_id === s.id) ?? null,
      })),
    );

    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    loadStudents();
    const channel = supabase
      .channel("students-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "students" },
        loadStudents,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "devices" },
        loadStudents,
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadStudents]);

  // Reload whenever the screen comes back into focus (covers the delete case)
  useFocusEffect(
    useCallback(() => {
      loadStudents();
    }, [loadStudents]),
  );

  async function addStudent() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setSaving(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("students")
      .insert({ teacher_id: user!.id, full_name: trimmed });
    setSaving(false);
    if (error) return;
    setNewName("");
    setAddModal(false);
    loadStudents();
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
        <Text style={styles.title}>Students</Text>
        <Pressable
          onPress={() => {
            setNewName("");
            setAddModal(true);
          }}
          style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.85 }]}
          accessibilityRole="button"
        >
          <Ionicons name="add" size={18} color="#1A1200" />
          <Text style={styles.addBtnText}>Add</Text>
        </Pressable>
      </View>

      <FlatList
        data={students}
        keyExtractor={(s) => s.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              loadStudents();
            }}
            tintColor={C.navy}
          />
        }
        renderItem={({ item }) => (
          <StudentCard
            student={item}
            onPress={() => router.push(`/(teacher)/students/${item.id}` as any)}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <BrailleCell pattern={[]} size={16} emptyColor={C.border} />
            <Text style={styles.emptyTitle}>No students yet</Text>
            <Text style={styles.emptyBody}>
              {"Tap "}
              <Text style={{ fontFamily: fonts.heading }}>+ Add</Text>
              {" to register your first student."}
            </Text>
          </View>
        }
      />

      {/* Add student modal */}
      <Modal
        visible={addModal}
        animationType="slide"
        transparent
        onRequestClose={() => setAddModal(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable
            style={styles.backdrop}
            onPress={() => setAddModal(false)}
          />
          <KeyboardAvoidingView style={styles.keyboardSheet} behavior="padding">
            <View style={styles.sheet}>
              <View style={styles.handle} />
              <Text style={styles.sheetTitle}>Add Student</Text>
              <Text style={styles.sheetLabel}>Full name</Text>
              <TextInput
                style={styles.sheetInput}
                value={newName}
                onChangeText={setNewName}
                placeholder="e.g. Juan dela Cruz"
                placeholderTextColor={C.muted}
                autoFocus
                autoCapitalize="words"
                returnKeyType="done"
                onSubmitEditing={addStudent}
              />
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
                  onPress={addStudent}
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
                    <Text style={styles.btnConfirmText}>Add Student</Text>
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
  cardInfo: { flex: 1, gap: 4 },
  studentName: { fontFamily: fonts.heading, fontSize: 15, color: C.navy },
  deviceRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  deviceCode: { fontFamily: fonts.mono, fontSize: 11, color: C.muted },
  noDevice: { fontFamily: fonts.body, fontSize: 12, color: C.muted },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 100 },
  badgeText: { fontFamily: fonts.mono, fontSize: 9 },

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

  modalOverlay: { flex: 1, justifyContent: "flex-end" },
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
    gap: 10,
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
  sheetLabel: {
    fontFamily: fonts.heading,
    fontSize: 14,
    color: C.navy,
    marginTop: 4,
  },
  sheetInput: {
    fontFamily: fonts.body,
    fontSize: 16,
    color: C.ink,
    backgroundColor: C.bg,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  sheetActions: { flexDirection: "row", gap: 10, marginTop: 4 },
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
