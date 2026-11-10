// mobile/components/ActivityDetailsSheet.tsx
// Bottom sheet with an activity's name, description and level.
// Used to create an activity (admin Activities list) and to edit a draft's
// details (activity editor).

import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors as C, fonts, MIN_TOUCH } from "../lib/theme";
import { DIFFICULTIES, DIFFICULTY_META, type Difficulty } from "../lib/difficulty";
import type { ActivityDetails } from "../lib/activities";

const NAME_MAX = 100;
const DESCRIPTION_MAX = 1000;

type Props = {
  visible: boolean;
  title: string;
  saveLabel: string;
  initial?: ActivityDetails | null;
  saving: boolean;
  error?: string;
  onCancel: () => void;
  onSave: (details: ActivityDetails) => void;
};

export function ActivityDetailsSheet({ visible, title, saveLabel, initial, saving, error, onCancel, onSave }: Props) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [level, setLevel] = useState<Difficulty | null>(null);

  // Fill the form each time the sheet opens
  useEffect(() => {
    if (!visible) return;
    setName(initial?.name ?? "");
    setDescription(initial?.description ?? "");
    setLevel(initial?.level ?? null);
  }, [visible, initial]);

  const trimmed = name.trim();
  const canSave = trimmed.length > 0 && !saving;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={() => !saving && onCancel()}>
      <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Pressable style={styles.backdrop} onPress={() => !saving && onCancel()} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}>
          <View style={styles.handle} />
          <Text style={styles.title}>{title}</Text>

          <Text style={styles.label}>Name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. Animals, week 1"
            placeholderTextColor={C.muted}
            maxLength={NAME_MAX}
            style={styles.input}
            accessibilityLabel="Activity name"
            autoFocus={!initial}
          />

          <Text style={styles.label}>Description (optional)</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="What this activity practises"
            placeholderTextColor={C.muted}
            maxLength={DESCRIPTION_MAX}
            multiline
            style={[styles.input, styles.multiline]}
            accessibilityLabel="Activity description"
          />

          <Text style={styles.label}>Level (optional)</Text>
          <View style={styles.chips}>
            {DIFFICULTIES.map((d) => {
              const on = level === d;
              const meta = DIFFICULTY_META[d];
              return (
                <Pressable
                  key={d}
                  onPress={() => setLevel(on ? null : d)}
                  style={[styles.chip, on && { backgroundColor: meta.chipBg, borderColor: meta.chipBg }]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`Level ${meta.label}${on ? ", selected. Tap again to clear" : ""}`}
                >
                  <Text style={[styles.chipText, on && { color: meta.chipText }]}>{meta.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {!!error && <Text style={styles.error}>{error}</Text>}

          <View style={styles.actions}>
            <Pressable
              onPress={onCancel}
              disabled={saving}
              style={({ pressed }) => [styles.btn, styles.btnCancel, pressed && { opacity: 0.7 }]}
              accessibilityRole="button"
            >
              <Text style={styles.btnCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() =>
                onSave({ name: trimmed, description: description.trim() || null, level })
              }
              disabled={!canSave}
              style={({ pressed }) => [styles.btn, styles.btnSave, (!canSave || pressed) && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSave }}
            >
              <Text style={styles.btnSaveText}>{saving ? "Saving…" : saveLabel}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.45)" },
  sheet: {
    backgroundColor: C.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    gap: 8,
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: "center", marginBottom: 4 },
  title: { fontFamily: fonts.heading, fontSize: 20, color: C.navy, marginBottom: 4 },
  label: { fontFamily: fonts.mono, fontSize: 11, color: C.brown, marginTop: 6 },
  input: {
    minHeight: MIN_TOUCH,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontFamily: fonts.body,
    fontSize: 16,
    color: C.ink,
    backgroundColor: C.bg,
  },
  multiline: { minHeight: 80, textAlignVertical: "top" },
  chips: { flexDirection: "row", gap: 8 },
  chip: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 18,
    justifyContent: "center",
    borderRadius: 100,
    borderWidth: 1.5,
    borderColor: C.border,
    backgroundColor: C.white,
  },
  chipText: { fontFamily: fonts.headingSemi, fontSize: 14, color: C.ink },
  error: { fontFamily: fonts.body, fontSize: 13, color: C.red, marginTop: 4 },
  actions: { flexDirection: "row", gap: 10, marginTop: 12 },
  btn: {
    flex: 1,
    minHeight: MIN_TOUCH,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    borderWidth: 1.5,
  },
  btnCancel: { backgroundColor: C.bg, borderColor: C.border },
  btnCancelText: { fontFamily: fonts.heading, fontSize: 15, color: C.navy },
  btnSave: { backgroundColor: C.amber, borderColor: C.amber },
  btnSaveText: { fontFamily: fonts.heading, fontSize: 15, color: "#1A1200" },
});
