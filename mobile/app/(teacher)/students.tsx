// mobile/app/(teacher)/students.tsx
// Fully functional with local state — Supabase calls commented [BACKEND].

import { useState } from "react";
import {
  View, Text, Pressable, FlatList, TextInput,
  Modal, KeyboardAvoidingView, Platform, StyleSheet, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { colors as C, fonts } from "../../lib/theme";
import { BrailleCell } from "../../components/BrailleCell";

type Student = {
  id: string;
  name: string;
  devicePaired: boolean;
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

// ── Student card ──────────────────────────────────────────────────────────────
function StudentCard({ student, onRemove }: {
  student: Student;
  onRemove: () => void;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{getInitials(student.name)}</Text>
      </View>
      <View style={styles.cardInfo}>
        <Text style={styles.studentName}>{student.name}</Text>
        <View style={[styles.badge, student.devicePaired ? styles.badgePaired : styles.badgeNone]}>
          <Text style={[styles.badgeText, student.devicePaired ? styles.badgeTextPaired : styles.badgeTextNone]}>
            {student.devicePaired ? "Device paired" : "No device"}
          </Text>
        </View>
      </View>
      <Pressable
        onPress={onRemove}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${student.name}`}
        style={({ pressed }) => [styles.removeBtn, pressed && { opacity: 0.6 }]}
      >
        <Ionicons name="trash-outline" size={18} color={C.red} />
      </Pressable>
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────
export default function StudentsScreen() {
  const [students, setStudents] = useState<Student[]>([
    // [BACKEND] Replace this empty array with a Supabase fetch:
    // const { data } = await supabase.from("students").select().eq("teacher_id", profile.id);
  ]);
  const [modalVisible, setModalVisible] = useState(false);
  const [newName, setNewName] = useState("");

  function openModal() {
    setNewName("");
    setModalVisible(true);
  }

  function closeModal() {
    setNewName("");
    setModalVisible(false);
  }

  function addStudent() {
    const trimmed = newName.trim();
    if (!trimmed) return;

    const student: Student = {
      id: Date.now().toString(), // [BACKEND] replace with the UUID returned by Supabase insert
      name: trimmed,
      devicePaired: false,
    };

    // [BACKEND] await supabase.from("students").insert({ teacher_id: profile.id, full_name: trimmed });
    setStudents((prev) => [...prev, student]);
    closeModal();
  }

  function removeStudent(id: string, name: string) {
    Alert.alert("Remove student", `Remove ${name} from your roster?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          // [BACKEND] await supabase.from("students").delete().eq("id", id);
          setStudents((prev) => prev.filter((s) => s.id !== id));
        },
      },
    ]);
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Students</Text>
        <Pressable
          onPress={openModal}
          accessibilityRole="button"
          accessibilityLabel="Add a student"
          style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.85 }]}
        >
          <Ionicons name="add" size={18} color="#1A1200" />
          <Text style={styles.addBtnText}>Add</Text>
        </Pressable>
      </View>

      {/* Student list */}
      <FlatList
        data={students}
        keyExtractor={(s) => s.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <StudentCard
            student={item}
            onRemove={() => removeStudent(item.id, item.name)}
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

      {/* Add student — bottom sheet modal */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent
        onRequestClose={closeModal}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <Pressable style={styles.modalBackdrop} onPress={closeModal} />
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Add Student</Text>
            <Text style={styles.modalLabel}>Full name</Text>
            <TextInput
              style={styles.modalInput}
              value={newName}
              onChangeText={setNewName}
              placeholder="e.g. Juan dela Cruz"
              placeholderTextColor={C.muted}
              autoFocus
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={addStudent}
              accessibilityLabel="Student full name"
            />
            <View style={styles.modalActions}>
              <Pressable
                onPress={closeModal}
                style={({ pressed }) => [
                  styles.modalBtn, styles.modalBtnCancel, pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={styles.modalBtnCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={addStudent}
                style={({ pressed }) => [
                  styles.modalBtn, styles.modalBtnConfirm, pressed && { opacity: 0.85 },
                ]}
              >
                <Text style={styles.modalBtnConfirmText}>Add Student</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },

  // Header
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

  // List
  list: { padding: 16, gap: 12, flexGrow: 1 },

  // Student card
  card: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: C.white, borderRadius: 14, padding: 14,
    borderWidth: 1.5, borderColor: C.border,
  },
  avatar:     {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: C.navy, alignItems: "center", justifyContent: "center",
  },
  avatarText:       { fontFamily: fonts.heading, fontSize: 16, color: C.white },
  cardInfo:         { flex: 1, gap: 4 },
  studentName:      { fontFamily: fonts.heading, fontSize: 15, color: C.navy },
  badge:            { alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 100 },
  badgePaired:      { backgroundColor: C.greenBg },
  badgeNone:        { backgroundColor: C.brownBg },
  badgeText:        { fontFamily: fonts.mono, fontSize: 10 },
  badgeTextPaired:  { color: C.green },
  badgeTextNone:    { color: C.brown },
  removeBtn:        { padding: 6 },

  // Empty state
  empty: {
    alignItems: "center", justifyContent: "center",
    padding: 40, marginTop: 60, gap: 12,
  },
  emptyTitle: { fontFamily: fonts.heading, fontSize: 18, color: C.navy },
  emptyBody:  { fontFamily: fonts.body, fontSize: 14, color: C.ink, textAlign: "center", lineHeight: 22 },

  // Modal
  modalOverlay:  { flex: 1, justifyContent: "flex-end" },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.45)" },
  modalSheet: {
    backgroundColor: C.white, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 24, paddingBottom: 44, gap: 12,
  },
  modalHandle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: C.border, alignSelf: "center", marginBottom: 4,
  },
  modalTitle: { fontFamily: fonts.heading, fontSize: 20, color: C.navy },
  modalLabel: { fontFamily: fonts.heading, fontSize: 14, color: C.navy, marginTop: 4 },
  modalInput: {
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