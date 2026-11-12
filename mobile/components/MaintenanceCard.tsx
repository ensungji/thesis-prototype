// mobile/components/MaintenanceCard.tsx
// Admin panel: maintenance mode switch (migration 26).
//   Off → switch → sheet with an optional message for teachers → Turn on
//   On  → "On since <time> by <name>", the message, Edit message, switch → Turn off
// The database sets started_at / set_by and logs on / off to system_logs
// (maintenance_on / maintenance_off), so the app only sends on/off + message.

import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { colors as C, fonts, MIN_TOUCH } from "../lib/theme";
import { MAINTENANCE_DEFAULT_TEXT, setMaintenance, useMaintenance } from "../lib/maintenance";

const MAX_MESSAGE = 300;

type SheetMode = "on" | "off" | "edit" | null;

function sinceLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
}

export function MaintenanceCard({
  onDone,
}: {
  /** Toast in the admin panel: success, or the error */
  onDone: (message: string, detail: string, ok: boolean) => void;
}) {
  const m = useMaintenance();
  const insets = useSafeAreaInsets();
  const [sheet, setSheet] = useState<SheetMode>(null);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [setByName, setSetByName] = useState<string | null>(null);

  // Who turned it on (admins can read every profile)
  useEffect(() => {
    if (!m.on || !m.setBy) {
      setSetByName(null);
      return;
    }
    supabase
      .from("profiles")
      .select("full_name, email")
      .eq("id", m.setBy)
      .maybeSingle()
      .then(({ data }) => setSetByName(data?.full_name?.trim() || data?.email || null));
  }, [m.on, m.setBy]);

  function open(mode: Exclude<SheetMode, null>) {
    setText(mode === "off" ? "" : m.message ?? "");
    setSheet(mode);
  }

  async function confirm() {
    if (!sheet) return;
    const turnOn = sheet !== "off";
    setSaving(true);
    const error = await setMaintenance(turnOn, turnOn ? text : m.message);
    setSaving(false);
    const mode = sheet;
    setSheet(null);
    if (error) {
      onDone("Couldn't change maintenance mode", error, false);
      return;
    }
    if (mode === "on") onDone("Maintenance mode is on", "Teachers see the banner now. Running sessions can finish.", true);
    else if (mode === "off") onDone("Maintenance mode is off", "Teachers can start sessions and edit activities again.", true);
    else onDone("Message saved", "Teachers see the new message now.", true);
  }

  return (
    <View style={[styles.card, m.on && styles.cardOn]}>
      <View style={styles.row}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.label}>MAINTENANCE MODE</Text>
          <Text style={styles.status} numberOfLines={1}>
            {!m.loaded
              ? "Loading…"
              : m.on
              ? `On since ${sinceLabel(m.startedAt)}${setByName ? ` · by ${setByName}` : ""}`
              : "Off · teachers can use everything"}
          </Text>
        </View>
        <Switch
          value={m.on}
          onValueChange={(v) => open(v ? "on" : "off")}
          disabled={!m.loaded || saving}
          trackColor={{ true: C.amber, false: C.border }}
          thumbColor={C.white}
          accessibilityLabel="Maintenance mode"
        />
      </View>
      {m.on && (
        <View style={styles.row}>
          <Text style={styles.message} numberOfLines={2}>
            {m.message ? `“${m.message}”` : "No message · teachers see the standard text"}
          </Text>
          <Pressable
            onPress={() => open("edit")}
            style={({ pressed }) => [styles.editBtn, pressed && { opacity: 0.7 }]}
            accessibilityRole="button"
            accessibilityLabel="Edit the maintenance message"
          >
            <Ionicons name="pencil-outline" size={14} color={C.navy} />
            <Text style={styles.editText}>Edit</Text>
          </Pressable>
        </View>
      )}

      <Modal visible={!!sheet} animationType="slide" transparent onRequestClose={() => !saving && setSheet(null)}>
        <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <Pressable style={styles.backdrop} onPress={() => !saving && setSheet(null)} />
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>
              {sheet === "on"
                ? "Turn on maintenance mode?"
                : sheet === "off"
                ? "Turn off maintenance mode?"
                : "Maintenance message"}
            </Text>
            <Text style={styles.sheetBody}>
              {sheet === "off"
                ? "Teachers can create and start sessions and change activities again. The banner goes away."
                : sheet === "on"
                ? "Teachers can still sign in and view everything, and sessions already running can finish. Until you turn it off they can't create or start sessions, or create, edit, publish or share activities. Admins aren't affected."
                : "Teachers see this in the banner right away."}
            </Text>
            {sheet !== "off" && (
              <>
                <TextInput
                  value={text}
                  onChangeText={(t) => setText(t.slice(0, MAX_MESSAGE))}
                  placeholder={`Message for teachers (optional), e.g. "Updating the devices, back at 3 pm"`}
                  placeholderTextColor={C.muted}
                  multiline
                  maxLength={MAX_MESSAGE}
                  style={styles.input}
                  accessibilityLabel="Message for teachers"
                />
                <Text style={styles.counter}>
                  {text.trim() ? `${text.length} / ${MAX_MESSAGE}` : `Empty: teachers see "${MAINTENANCE_DEFAULT_TEXT}"`}
                </Text>
              </>
            )}
            <View style={styles.actions}>
              <Pressable
                onPress={() => setSheet(null)}
                disabled={saving}
                style={({ pressed }) => [styles.btn, styles.btnCancel, pressed && { opacity: 0.7 }]}
                accessibilityRole="button"
              >
                <Text style={styles.btnCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={confirm}
                disabled={saving}
                style={({ pressed }) => [styles.btn, styles.btnConfirm, (saving || pressed) && { opacity: 0.6 }]}
                accessibilityRole="button"
                accessibilityState={{ disabled: saving }}
              >
                <Text style={styles.btnConfirmText}>
                  {saving ? "Saving…" : sheet === "on" ? "Turn on" : sheet === "off" ? "Turn off" : "Save"}
                </Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 8,
    padding: 12,
    borderRadius: 12,
    backgroundColor: C.white,
    borderWidth: 1.5,
    borderColor: C.border,
    gap: 6,
  },
  cardOn: { backgroundColor: C.brownBg, borderColor: C.amber },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  label: { fontFamily: fonts.mono, fontSize: 10, color: C.brown, letterSpacing: 0.5 },
  status: { fontFamily: fonts.heading, fontSize: 14, color: C.navy },
  message: { flex: 1, fontFamily: fonts.body, fontSize: 12, color: C.ink },
  editBtn: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    borderRadius: 100,
    borderWidth: 1.5,
    borderColor: C.border,
    backgroundColor: C.white,
  },
  editText: { fontFamily: fonts.headingSemi, fontSize: 12, color: C.navy },
  overlay: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.45)" },
  sheet: {
    backgroundColor: C.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    gap: 12,
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: "center" },
  sheetTitle: { fontFamily: fonts.heading, fontSize: 20, color: C.navy },
  sheetBody: { fontFamily: fonts.body, fontSize: 14, color: C.ink, lineHeight: 21 },
  input: {
    minHeight: 90,
    borderWidth: 1.5,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontFamily: fonts.body,
    fontSize: 15,
    color: C.ink,
    backgroundColor: C.bg,
    textAlignVertical: "top",
  },
  counter: { fontFamily: fonts.body, fontSize: 11, color: C.muted, marginTop: -6 },
  actions: { flexDirection: "row", gap: 10, marginTop: 4 },
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
  btnConfirm: { backgroundColor: C.amber, borderColor: C.amber },
  btnConfirmText: { fontFamily: fonts.heading, fontSize: 15, color: "#1A1200" },
});
