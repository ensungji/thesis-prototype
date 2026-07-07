// mobile/app/admin/edit-teacher.tsx
// Dedicated screen — edit an existing teacher's profile info.
// Receives teacher data via route params: id, full_name, title, institution.

import { useState } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { colors as C, fonts } from "../../lib/theme";

export default function EditTeacherScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id, full_name, title: initialTitle, institution: initialInstitution } =
    useLocalSearchParams<{
      id: string;
      full_name: string;
      title?: string;
      institution?: string;
    }>();

  const [name, setName] = useState(full_name ?? "");
  const [title, setTitle] = useState(initialTitle ?? "");
  const [institution, setInstitution] = useState(initialInstitution ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!name.trim()) {
      setError("Full name is required.");
      return;
    }
    setSaving(true);
    setError(null);

    const { error: dbError } = await supabase
      .from("profiles")
      .update({
        full_name: name.trim(),
        title: title.trim() || null,
        institution: institution.trim() || null,
      })
      .eq("id", id!);

    setSaving(false);
    if (dbError) {
      setError(dbError.message ?? "Failed to save changes.");
      return;
    }

    // Go back with the teacher's name so the list can show a success toast
    router.replace({
      pathname: "/admin" as any,
      params: { updated: name.trim() },
    });
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
        >
          <Ionicons name="arrow-back" size={20} color={C.navy} />
          <Text style={styles.backText}>Admin</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingBottom: Math.max(insets.bottom, 16) + 16 },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <Text style={styles.pageTitle}>Edit Teacher</Text>
        <Text style={styles.pageSub}>
          Update profile information for this teacher account.
        </Text>

        <View style={styles.form}>
          {/* Full name */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Full name</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              autoCapitalize="words"
              returnKeyType="next"
            />
          </View>

          {/* Title (optional) */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>
              Title <Text style={styles.optional}>(optional)</Text>
            </Text>
            <TextInput
              style={styles.input}
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. Special Education Teacher"
              placeholderTextColor={C.muted}
              autoCapitalize="words"
              returnKeyType="next"
            />
          </View>

          {/* Institution (optional) */}
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>
              Institution <Text style={styles.optional}>(optional)</Text>
            </Text>
            <TextInput
              style={styles.input}
              value={institution}
              onChangeText={setInstitution}
              placeholder="e.g. Philippine School for the Deaf"
              placeholderTextColor={C.muted}
              autoCapitalize="words"
              returnKeyType="done"
              onSubmitEditing={handleSave}
            />
          </View>

          {/* Error */}
          {error && (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle-outline" size={16} color={C.red} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}
        </View>

        {/* Save */}
        <Pressable
          onPress={handleSave}
          disabled={saving}
          style={({ pressed }) => [
            styles.saveBtn,
            saving && { opacity: 0.6 },
            pressed && !saving && { opacity: 0.85 },
          ]}
        >
          {saving ? (
            <ActivityIndicator color={C.white} />
          ) : (
            <>
              <Ionicons name="checkmark" size={18} color={C.white} />
              <Text style={styles.saveBtnText}>Save Changes</Text>
            </>
          )}
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: C.white,
    borderBottomWidth: 1.5,
    borderBottomColor: C.border,
  },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 6 },
  backText: { fontFamily: fonts.heading, fontSize: 16, color: C.navy },

  scroll: {
    padding: 16,
    paddingTop: 20,
    gap: 16,
  },

  pageTitle: { fontFamily: fonts.heading, fontSize: 22, color: C.navy },
  pageSub: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: C.muted,
    lineHeight: 19,
    marginTop: -6,
  },

  form: { gap: 12 },

  fieldGroup: { gap: 5 },
  label: { fontFamily: fonts.heading, fontSize: 13, color: C.navy },
  optional: { fontFamily: fonts.body, fontSize: 11, color: C.muted },
  input: {
    fontFamily: fonts.body,
    fontSize: 15,
    color: C.ink,
    backgroundColor: C.white,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },

  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: C.redBg,
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: C.red,
  },
  errorText: { fontFamily: fonts.body, fontSize: 13, color: C.red, flex: 1 },

  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: C.navy,
    borderRadius: 14,
    paddingVertical: 15,
    marginTop: 4,
  },
  saveBtnText: { fontFamily: fonts.heading, fontSize: 15, color: C.white },
});
