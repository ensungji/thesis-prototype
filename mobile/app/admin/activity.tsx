// mobile/app/admin/activity.tsx
// Admin → one activity.
//   Draft:              edit details; add words (typed, pasted list, Word Bank);
//                       time per word; reorder; remove; Publish; Delete.
//   Published / hidden: read-only words; Duplicate; Hide / Unhide.
// Every change is saved right away. The database has the final say (migration
// 16: a published activity and its words can't change), and its message is
// shown when it refuses something.

import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors as C, fonts, MIN_TOUCH } from "../../lib/theme";
import { DIFFICULTY_META } from "../../lib/difficulty";
import { MAX_WORD_DURATION_SEC, MIN_WORD_DURATION_SEC } from "../../lib/session-timer";
import { filterWordBank, useWordBank } from "../../lib/word-bank";
import {
  type Activity,
  type ActivityDetails,
  type ActivityWord,
  type DroppedWord,
  addWords,
  clampActivityDuration,
  deleteDraft,
  describeDropped,
  duplicateActivity,
  getActivity,
  parseWordList,
  removeWord,
  savePositions,
  setActivityStatus,
  setWordDuration,
  STATUS_COLORS,
  STATUS_LABEL,
  updateActivityDetails,
} from "../../lib/activities";
import { BrailleLoader } from "../../components/BrailleLoader";
import { Toast } from "../../components/Toast";
import { ActivityDetailsSheet } from "../../components/ActivityDetailsSheet";

const TIME_PRESETS = [5, 10, 15, 20, 30, 45, 60];

type ToastState = { message: string; detail?: string; variant: "success" | "delete" | "warning" } | null;
type AddNotice = { added: string[]; dropped: DroppedWord[] } | null;

export default function AdminActivity() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id, copied } = useLocalSearchParams<{ id: string; copied?: string }>();

  const [activity, setActivity] = useState<Activity | null>(null);
  const [words, setWords] = useState<ActivityWord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false); // a write is in flight
  const [toast, setToast] = useState<ToastState>(null);

  // Add words
  const [typed, setTyped] = useState("");
  const [notice, setNotice] = useState<AddNotice>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [bankOpen, setBankOpen] = useState(false);
  const [bankSearch, setBankSearch] = useState("");
  const [bankPicked, setBankPicked] = useState<Set<string>>(new Set());
  const wordBank = useWordBank({ reloadOnFocus: false });

  // Sheets
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [timeWord, setTimeWord] = useState<ActivityWord | null>(null);
  const [timeValue, setTimeValue] = useState(20);
  const [publishOpen, setPublishOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const isDraft = activity?.status === "draft";

  const load = useCallback(async () => {
    if (!id) return;
    const res = await getActivity(id);
    if (res.error !== null) setLoadError(res.error);
    else {
      setActivity(res.data.activity);
      setWords(res.data.words);
      setLoadError("");
    }
    setLoading(false);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      setNotice(null);
      load();
    }, [load])
  );

  // Opened right after Duplicate
  useEffect(() => {
    if (copied !== "1") return;
    setToast({ message: "Copy made", detail: "This is the new draft. Edit it, then publish.", variant: "success" });
    router.setParams({ copied: undefined });
  }, [copied, router]);

  const showError = (message: string, detail: string) => setToast({ message, detail, variant: "warning" });

  // ── Add words ──────────────────────────────────────────────────────────────

  async function addFromText(text: string): Promise<boolean> {
    if (!activity) return false;
    const { words: toAdd, dropped } = parseWordList(text, words.map((w) => w.word));
    if (toAdd.length === 0) {
      setNotice({ added: [], dropped });
      return dropped.length === 0; // nothing typed at all: just close
    }
    setBusy(true);
    const last = words.reduce((m, w) => Math.max(m, w.position), -1);
    const res = await addWords(activity.id, toAdd, last);
    setBusy(false);
    if (res.error !== null) {
      showError("Couldn't add the words", res.error);
      return false;
    }
    setWords((prev) => [...prev, ...res.data]);
    setNotice({ added: toAdd, dropped });
    return true;
  }

  async function addTyped() {
    if (await addFromText(typed)) setTyped("");
  }

  async function addPasted() {
    if (await addFromText(pasteText)) {
      setPasteText("");
      setPasteOpen(false);
    }
  }

  async function addFromBank() {
    const picked = wordBank.words.filter((w) => bankPicked.has(w.id)).map((w) => w.word);
    if (await addFromText(picked.join("\n"))) {
      setBankPicked(new Set());
      setBankOpen(false);
    }
  }

  // ── Word rows ──────────────────────────────────────────────────────────────

  async function move(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= words.length) return;
    const a = words[index];
    const b = words[j];
    const before = words;
    const next = [...words];
    next[index] = { ...b, position: a.position };
    next[j] = { ...a, position: b.position };
    setWords(next);
    setBusy(true);
    const res = await savePositions([next[index], next[j]]);
    setBusy(false);
    if (res.error !== null) {
      setWords(before);
      showError("Couldn't move the word", res.error);
    }
  }

  async function remove(word: ActivityWord) {
    const before = words;
    setWords(words.filter((w) => w.id !== word.id));
    setBusy(true);
    const res = await removeWord(word.id);
    setBusy(false);
    if (res.error !== null) {
      setWords(before);
      showError(`Couldn't remove ${word.word}`, res.error);
    }
  }

  function openTime(word: ActivityWord) {
    setTimeValue(word.duration_seconds);
    setTimeWord(word);
  }

  async function saveTime() {
    if (!timeWord) return;
    const sec = clampActivityDuration(timeValue);
    const word = timeWord;
    setTimeWord(null);
    if (sec === word.duration_seconds) return;
    setBusy(true);
    const res = await setWordDuration(word.id, sec);
    setBusy(false);
    if (res.error !== null) {
      showError(`Couldn't change the time for ${word.word}`, res.error);
      return;
    }
    setWords((prev) => prev.map((w) => (w.id === word.id ? { ...w, duration_seconds: sec } : w)));
  }

  // ── Activity actions ───────────────────────────────────────────────────────

  async function saveDetails(d: ActivityDetails) {
    if (!activity) return;
    setBusy(true);
    setDetailsError("");
    const res = await updateActivityDetails(activity.id, d);
    setBusy(false);
    if (res.error !== null) {
      setDetailsError(res.error);
      return;
    }
    setActivity({ ...activity, ...d });
    setDetailsOpen(false);
  }

  async function publish() {
    if (!activity) return;
    setBusy(true);
    const res = await setActivityStatus(activity.id, "published");
    setBusy(false);
    setPublishOpen(false);
    if (res.error !== null) {
      showError("Couldn't publish", res.error);
      return;
    }
    setNotice(null);
    await load();
    setToast({ message: "Published", detail: "Teachers can now run this activity.", variant: "success" });
  }

  async function toggleHidden() {
    if (!activity) return;
    const next = activity.status === "hidden" ? "published" : "hidden";
    setBusy(true);
    const res = await setActivityStatus(activity.id, next);
    setBusy(false);
    if (res.error !== null) {
      showError(next === "hidden" ? "Couldn't hide" : "Couldn't unhide", res.error);
      return;
    }
    setActivity({ ...activity, status: next });
    setToast({
      message: next === "hidden" ? "Hidden" : "Visible again",
      detail: next === "hidden" ? "Teachers no longer see it. Past sessions keep their words." : "Teachers can run it again.",
      variant: "success",
    });
  }

  async function duplicate() {
    if (!activity) return;
    setBusy(true);
    const res = await duplicateActivity(activity.id);
    setBusy(false);
    if (res.error !== null) {
      showError("Couldn't duplicate", res.error);
      return;
    }
    // the copy opens as a new screen; it shows the "Copy made" toast itself
    router.replace({ pathname: "/admin/activity" as any, params: { id: res.data, copied: "1" } });
  }

  async function confirmDelete() {
    if (!activity) return;
    setBusy(true);
    const res = await deleteDraft(activity.id);
    setBusy(false);
    setDeleteOpen(false);
    if (res.error !== null) {
      showError("Couldn't delete", res.error);
      return;
    }
    router.back();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading && !activity) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.center}>
          <BrailleLoader size={16} />
        </View>
      </SafeAreaView>
    );
  }

  if (!activity) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Header title="Activity" onBack={() => router.back()} />
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{loadError || "Couldn't load this activity."}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const level = activity.level ? DIFFICULTY_META[activity.level] : null;
  const status = STATUS_COLORS[activity.status];
  const totalSec = words.reduce((s, w) => s + w.duration_seconds, 0);
  const bankShown = filterWordBank(wordBank.words, bankSearch);
  const pastePreview = parseWordList(pasteText, words.map((w) => w.word));

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Header title={activity.name} onBack={() => router.back()}>
        <View style={[styles.status, { backgroundColor: status.bg }]}>
          <Text style={[styles.statusText, { color: status.text }]}>{STATUS_LABEL[activity.status]}</Text>
        </View>
      </Header>

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {/* Details */}
        <View style={styles.card}>
          <View style={styles.metaRow}>
            {level && (
              <View style={[styles.badge, { backgroundColor: level.badgeBg, borderColor: level.badgeBorder }]}>
                <Text style={[styles.badgeText, { color: level.badgeText }]}>{level.label}</Text>
              </View>
            )}
            <Text style={styles.meta}>
              {words.length} word{words.length === 1 ? "" : "s"} · {Math.floor(totalSec / 60)}:
              {String(totalSec % 60).padStart(2, "0")} total
            </Text>
          </View>
          {activity.description ? (
            <Text style={styles.description}>{activity.description}</Text>
          ) : (
            <Text style={[styles.description, { color: C.muted }]}>No description</Text>
          )}
          {isDraft ? (
            <SmallButton icon="pencil-outline" label="Edit details" onPress={() => { setDetailsError(""); setDetailsOpen(true); }} disabled={busy} />
          ) : (
            <Text style={styles.lockedNote}>
              <Ionicons name="lock-closed-outline" size={12} color={C.muted} />
              {" Published activities can't be edited. Duplicate it to make a changed copy."}
            </Text>
          )}
        </View>

        {/* Add words (draft) */}
        {isDraft && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Add words</Text>
            <View style={styles.addRow}>
              <TextInput
                value={typed}
                onChangeText={setTyped}
                onSubmitEditing={addTyped}
                placeholder="Type a word"
                placeholderTextColor={C.muted}
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="done"
                style={[styles.input, { flex: 1 }]}
                accessibilityLabel="Word to add"
              />
              <Pressable
                onPress={addTyped}
                disabled={busy || !typed.trim()}
                style={({ pressed }) => [styles.addBtn, (busy || !typed.trim() || pressed) && { opacity: 0.6 }]}
                accessibilityRole="button"
                accessibilityLabel="Add word"
              >
                <Text style={styles.addBtnText}>Add</Text>
              </Pressable>
            </View>
            <View style={styles.buttonRow}>
              <SmallButton icon="clipboard-outline" label="Paste a list" onPress={() => setPasteOpen(true)} disabled={busy} />
              <SmallButton
                icon="library-outline"
                label="From Word Bank"
                onPress={() => {
                  setBankSearch("");
                  setBankPicked(new Set());
                  wordBank.reload();
                  setBankOpen(true);
                }}
                disabled={busy}
              />
            </View>
            {notice && (
              <View style={[styles.notice, notice.dropped.length > 0 && styles.noticeWarn]} accessibilityLiveRegion="polite">
                {notice.added.length > 0 && (
                  <Text style={styles.noticeText}>
                    Added {notice.added.length}: {notice.added.join(", ")}
                  </Text>
                )}
                {notice.dropped.length > 0 && (
                  <Text style={styles.noticeText}>Not added: {describeDropped(notice.dropped)}</Text>
                )}
              </View>
            )}
          </View>
        )}

        {/* Words */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Words</Text>
          {words.length === 0 && (
            <Text style={styles.meta}>No words yet. Add at least one before publishing.</Text>
          )}
          {words.map((w, i) => (
            <View key={w.id} style={styles.wordRow}>
              <Text style={styles.wordIndex}>{i + 1}</Text>
              <Text style={styles.word} numberOfLines={1}>
                {w.word}
              </Text>
              {isDraft ? (
                <>
                  <Pressable
                    onPress={() => openTime(w)}
                    disabled={busy}
                    style={({ pressed }) => [styles.timeChip, pressed && { opacity: 0.7 }]}
                    accessibilityRole="button"
                    accessibilityLabel={`${w.word}: ${w.duration_seconds} seconds. Change time`}
                  >
                    <Ionicons name="time-outline" size={14} color={C.navy} />
                    <Text style={styles.timeText}>{w.duration_seconds}s</Text>
                  </Pressable>
                  <IconButton icon="arrow-up" label={`Move ${w.word} up`} onPress={() => move(i, -1)} disabled={busy || i === 0} />
                  <IconButton
                    icon="arrow-down"
                    label={`Move ${w.word} down`}
                    onPress={() => move(i, 1)}
                    disabled={busy || i === words.length - 1}
                  />
                  <IconButton icon="trash-outline" label={`Remove ${w.word}`} onPress={() => remove(w)} disabled={busy} danger />
                </>
              ) : (
                <View style={[styles.timeChip, styles.timeChipStatic]}>
                  <Ionicons name="time-outline" size={14} color={C.muted} />
                  <Text style={[styles.timeText, { color: C.ink }]}>{w.duration_seconds}s</Text>
                </View>
              )}
            </View>
          ))}
        </View>

        {/* Actions */}
        {isDraft ? (
          <View style={styles.actions}>
            <BigButton icon="cloud-upload-outline" label="Publish" kind="primary" onPress={() => setPublishOpen(true)} disabled={busy} />
            <BigButton icon="trash-outline" label="Delete draft" kind="danger" onPress={() => setDeleteOpen(true)} disabled={busy} />
          </View>
        ) : (
          <View style={styles.actions}>
            <BigButton icon="copy-outline" label="Duplicate" kind="primary" onPress={duplicate} disabled={busy} />
            <BigButton
              icon={activity.status === "hidden" ? "eye-outline" : "eye-off-outline"}
              label={activity.status === "hidden" ? "Unhide" : "Hide"}
              kind="plain"
              onPress={toggleHidden}
              disabled={busy}
            />
          </View>
        )}
      </ScrollView>

      {/* ── Edit details ──────────────────────────────────────────────────── */}
      <ActivityDetailsSheet
        visible={detailsOpen}
        title="Edit details"
        saveLabel="Save"
        initial={{ name: activity.name, description: activity.description, level: activity.level }}
        saving={busy}
        error={detailsError}
        onCancel={() => setDetailsOpen(false)}
        onSave={saveDetails}
      />

      {/* ── Paste a list ──────────────────────────────────────────────────── */}
      <Sheet visible={pasteOpen} onClose={() => !busy && setPasteOpen(false)} bottom={insets.bottom}>
        <Text style={styles.sheetTitle}>Paste a list</Text>
        <Text style={styles.sheetSub}>Separate words with commas, spaces or new lines.</Text>
        <TextInput
          value={pasteText}
          onChangeText={setPasteText}
          placeholder={"cat, dog, sun\nmoon"}
          placeholderTextColor={C.muted}
          multiline
          autoCapitalize="characters"
          autoCorrect={false}
          style={[styles.input, styles.pasteInput]}
          accessibilityLabel="Words to add"
        />
        {pasteText.trim().length > 0 && (
          <View style={[styles.notice, pastePreview.dropped.length > 0 && styles.noticeWarn]}>
            <Text style={styles.noticeText}>
              Will add {pastePreview.words.length}
              {pastePreview.words.length ? `: ${pastePreview.words.join(", ")}` : ""}
            </Text>
            {pastePreview.dropped.length > 0 && (
              <Text style={styles.noticeText}>Not added: {describeDropped(pastePreview.dropped)}</Text>
            )}
          </View>
        )}
        <SheetActions
          cancel={() => setPasteOpen(false)}
          confirm={addPasted}
          confirmLabel={busy ? "Adding…" : `Add ${pastePreview.words.length || ""}`.trim()}
          disabled={busy || pastePreview.words.length === 0}
        />
      </Sheet>

      {/* ── From Word Bank ────────────────────────────────────────────────── */}
      <Sheet visible={bankOpen} onClose={() => !busy && setBankOpen(false)} bottom={insets.bottom} tall>
        <Text style={styles.sheetTitle}>From Word Bank</Text>
        <TextInput
          value={bankSearch}
          onChangeText={setBankSearch}
          placeholder="Search"
          placeholderTextColor={C.muted}
          autoCorrect={false}
          style={styles.input}
          accessibilityLabel="Search the Word Bank"
        />
        {!!wordBank.error && <Text style={styles.errorText}>{wordBank.error}</Text>}
        <ScrollView style={{ flexGrow: 0, maxHeight: 360 }} keyboardShouldPersistTaps="handled">
          {wordBank.loading && wordBank.words.length === 0 ? (
            <View style={{ padding: 24, alignItems: "center" }}>
              <BrailleLoader size={12} />
            </View>
          ) : bankShown.length === 0 ? (
            <Text style={[styles.meta, { padding: 12 }]}>No words found.</Text>
          ) : (
            bankShown.map((w) => {
              const on = bankPicked.has(w.id);
              const already = words.some((x) => x.word === w.word.toUpperCase());
              return (
                <Pressable
                  key={w.id}
                  onPress={() =>
                    setBankPicked((prev) => {
                      const next = new Set(prev);
                      if (next.has(w.id)) next.delete(w.id);
                      else next.add(w.id);
                      return next;
                    })
                  }
                  style={({ pressed }) => [styles.bankRow, pressed && { backgroundColor: C.bg }]}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${w.word}${already ? ", already in the list" : ""}`}
                >
                  <Ionicons name={on ? "checkbox" : "square-outline"} size={22} color={on ? C.navy : C.muted} />
                  <Text style={[styles.bankWord, already && { color: C.muted }]}>{w.word.toUpperCase()}</Text>
                  {already && <Text style={styles.meta}>in list</Text>}
                  {w.shared && <Text style={styles.meta}>shared</Text>}
                </Pressable>
              );
            })
          )}
        </ScrollView>
        <SheetActions
          cancel={() => setBankOpen(false)}
          confirm={addFromBank}
          confirmLabel={busy ? "Adding…" : `Add ${bankPicked.size || ""}`.trim()}
          disabled={busy || bankPicked.size === 0}
        />
      </Sheet>

      {/* ── Word time ─────────────────────────────────────────────────────── */}
      <Sheet visible={!!timeWord} onClose={() => setTimeWord(null)} bottom={insets.bottom}>
        <Text style={styles.sheetTitle}>Time for {timeWord?.word}</Text>
        <Text style={styles.sheetSub}>
          How long the word stays on the device: {MIN_WORD_DURATION_SEC}–{MAX_WORD_DURATION_SEC} seconds.
        </Text>
        <View style={styles.stepper}>
          <IconButton
            icon="remove"
            label="One second less"
            onPress={() => setTimeValue((v) => clampActivityDuration(v - 1))}
            disabled={timeValue <= MIN_WORD_DURATION_SEC}
            big
          />
          <Text style={styles.stepperValue} accessibilityLiveRegion="polite">
            {timeValue} s
          </Text>
          <IconButton
            icon="add"
            label="One second more"
            onPress={() => setTimeValue((v) => clampActivityDuration(v + 1))}
            disabled={timeValue >= MAX_WORD_DURATION_SEC}
            big
          />
        </View>
        <View style={styles.presets}>
          {TIME_PRESETS.map((p) => (
            <Pressable
              key={p}
              onPress={() => setTimeValue(p)}
              style={[styles.preset, timeValue === p && styles.presetOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: timeValue === p }}
              accessibilityLabel={`${p} seconds`}
            >
              <Text style={[styles.presetText, timeValue === p && { color: C.white }]}>{p}s</Text>
            </Pressable>
          ))}
        </View>
        <SheetActions cancel={() => setTimeWord(null)} confirm={saveTime} confirmLabel="Save" disabled={false} />
      </Sheet>

      {/* ── Publish confirm ───────────────────────────────────────────────── */}
      <Sheet visible={publishOpen} onClose={() => !busy && setPublishOpen(false)} bottom={insets.bottom}>
        <View style={[styles.confirmIcon, { backgroundColor: C.greenBg }]}>
          <Ionicons name="cloud-upload-outline" size={30} color={C.green} />
        </View>
        <Text style={[styles.sheetTitle, { textAlign: "center" }]}>Publish {activity.name}?</Text>
        <Text style={styles.confirmBody}>
          {"Published activities can't be edited. To change one later, duplicate it."}
        </Text>
        <SheetActions
          cancel={() => setPublishOpen(false)}
          confirm={publish}
          confirmLabel={busy ? "Publishing…" : "Publish"}
          disabled={busy}
        />
      </Sheet>

      {/* ── Delete confirm ────────────────────────────────────────────────── */}
      <Sheet visible={deleteOpen} onClose={() => !busy && setDeleteOpen(false)} bottom={insets.bottom}>
        <View style={[styles.confirmIcon, { backgroundColor: C.redBg }]}>
          <Ionicons name="trash-outline" size={30} color={C.red} />
        </View>
        <Text style={[styles.sheetTitle, { textAlign: "center" }]}>Delete {activity.name}?</Text>
        <Text style={styles.confirmBody}>
          {`This draft and its ${words.length} word${words.length === 1 ? "" : "s"} will be deleted. This can't be undone.`}
        </Text>
        <SheetActions
          cancel={() => setDeleteOpen(false)}
          confirm={confirmDelete}
          confirmLabel={busy ? "Deleting…" : "Delete"}
          disabled={busy}
          danger
        />
      </Sheet>

      <Toast
        message={toast?.message ?? ""}
        detail={toast?.detail}
        visible={!!toast}
        variant={toast?.variant ?? "success"}
        duration={toast?.variant === "warning" ? 6000 : 3500}
        onDismiss={() => setToast(null)}
      />
    </SafeAreaView>
  );
}

// ── Small building blocks ─────────────────────────────────────────────────────

function Header({ title, onBack, children }: { title: string; onBack: () => void; children?: ReactNode }) {
  return (
    <View style={styles.header}>
      <Pressable
        onPress={onBack}
        style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.7 }]}
        accessibilityRole="button"
        accessibilityLabel="Back to activities"
      >
        <Ionicons name="arrow-back" size={22} color={C.navy} />
      </Pressable>
      <Text style={styles.title} numberOfLines={2}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function IconButton({
  icon,
  label,
  onPress,
  disabled,
  danger,
  big,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
  big?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.iconBtn,
        big && styles.iconBtnBig,
        danger && { backgroundColor: C.redBg },
        (disabled || pressed) && { opacity: disabled ? 0.3 : 0.7 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
    >
      <Ionicons name={icon} size={big ? 24 : 18} color={danger ? C.red : C.navy} />
    </Pressable>
  );
}

function SmallButton({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.smallBtn, (disabled || pressed) && { opacity: 0.6 }]}
      accessibilityRole="button"
    >
      <Ionicons name={icon} size={16} color={C.navy} />
      <Text style={styles.smallBtnText}>{label}</Text>
    </Pressable>
  );
}

function BigButton({
  icon,
  label,
  kind,
  onPress,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  kind: "primary" | "danger" | "plain";
  onPress: () => void;
  disabled?: boolean;
}) {
  const style = kind === "primary" ? styles.bigPrimary : kind === "danger" ? styles.bigDanger : styles.bigPlain;
  const color = kind === "primary" ? "#1A1200" : kind === "danger" ? C.red : C.navy;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.bigBtn, style, (disabled || pressed) && { opacity: 0.65 }]}
      accessibilityRole="button"
    >
      <Ionicons name={icon} size={18} color={color} />
      <Text style={[styles.bigBtnText, { color }]}>{label}</Text>
    </Pressable>
  );
}

function Sheet({
  visible,
  onClose,
  bottom,
  tall,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  bottom: number;
  tall?: boolean;
  children: ReactNode;
}) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={[styles.sheet, tall && { maxHeight: "90%" }, { paddingBottom: Math.max(bottom, 16) + 16 }]}>
          <View style={styles.handle} />
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function SheetActions({
  cancel,
  confirm,
  confirmLabel,
  disabled,
  danger,
}: {
  cancel: () => void;
  confirm: () => void;
  confirmLabel: string;
  disabled: boolean;
  danger?: boolean;
}) {
  return (
    <View style={styles.sheetActions}>
      <Pressable
        onPress={cancel}
        style={({ pressed }) => [styles.sheetBtn, styles.sheetBtnCancel, pressed && { opacity: 0.7 }]}
        accessibilityRole="button"
      >
        <Text style={styles.sheetBtnCancelText}>Cancel</Text>
      </Pressable>
      <Pressable
        onPress={confirm}
        disabled={disabled}
        style={({ pressed }) => [
          styles.sheetBtn,
          danger ? styles.sheetBtnDanger : styles.sheetBtnConfirm,
          (disabled || pressed) && { opacity: 0.6 },
        ]}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
      >
        <Text style={[styles.sheetBtnConfirmText, danger && { color: C.red }]}>{confirmLabel}</Text>
      </Pressable>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

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
  title: { flex: 1, fontFamily: fonts.heading, fontSize: 20, color: C.navy },
  status: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 100 },
  statusText: { fontFamily: fonts.mono, fontSize: 10 },
  scroll: { padding: 16, paddingTop: 4, gap: 12, paddingBottom: 48 },
  card: {
    backgroundColor: C.white,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1.5,
    borderColor: C.border,
    gap: 10,
  },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  meta: { fontFamily: fonts.body, fontSize: 13, color: C.muted },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 100, borderWidth: 1 },
  badgeText: { fontFamily: fonts.mono, fontSize: 10 },
  description: { fontFamily: fonts.body, fontSize: 14, color: C.ink, lineHeight: 20 },
  lockedNote: { fontFamily: fonts.body, fontSize: 12, color: C.muted },
  sectionTitle: { fontFamily: fonts.heading, fontSize: 16, color: C.navy },
  addRow: { flexDirection: "row", gap: 8 },
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
  addBtn: {
    minHeight: MIN_TOUCH,
    paddingHorizontal: 20,
    borderRadius: 12,
    backgroundColor: C.amber,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtnText: { fontFamily: fonts.heading, fontSize: 15, color: "#1A1200" },
  buttonRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  smallBtn: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    borderRadius: 100,
    borderWidth: 1.5,
    borderColor: C.border,
    backgroundColor: C.white,
    alignSelf: "flex-start",
  },
  smallBtnText: { fontFamily: fonts.headingSemi, fontSize: 13, color: C.navy },
  notice: { padding: 10, borderRadius: 10, backgroundColor: C.greenBg, gap: 4 },
  noticeWarn: { backgroundColor: C.brownBg },
  noticeText: { fontFamily: fonts.body, fontSize: 13, color: C.ink },
  wordRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  wordIndex: { width: 24, fontFamily: fonts.mono, fontSize: 12, color: C.muted, textAlign: "right" },
  word: { flex: 1, fontFamily: fonts.mono, fontSize: 17, color: C.ink, letterSpacing: 1 },
  timeChip: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    borderRadius: 100,
    backgroundColor: C.blueWash,
  },
  timeChipStatic: { backgroundColor: C.bg },
  timeText: { fontFamily: fonts.mono, fontSize: 13, color: C.navy },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: C.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  iconBtnBig: { width: 56, height: 56, borderRadius: 28, backgroundColor: C.blueWash },
  actions: { gap: 10 },
  bigBtn: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 14,
    borderWidth: 1.5,
  },
  bigPrimary: { backgroundColor: C.amber, borderColor: C.amber },
  bigDanger: { backgroundColor: C.redBg, borderColor: C.red },
  bigPlain: { backgroundColor: C.white, borderColor: C.border },
  bigBtnText: { fontFamily: fonts.heading, fontSize: 16 },
  errorBox: {
    margin: 16,
    padding: 12,
    borderRadius: 8,
    backgroundColor: C.redBg,
    borderWidth: 1,
    borderColor: C.red,
  },
  errorText: { fontFamily: fonts.body, fontSize: 13, color: C.red },

  // Sheets
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
  sheetSub: { fontFamily: fonts.body, fontSize: 13, color: C.muted, marginTop: -6 },
  pasteInput: { minHeight: 120, textAlignVertical: "top" },
  bankRow: {
    minHeight: MIN_TOUCH,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 8,
    borderRadius: 10,
  },
  bankWord: { flex: 1, fontFamily: fonts.mono, fontSize: 16, color: C.ink },
  stepper: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 24 },
  stepperValue: { fontFamily: fonts.heading, fontSize: 32, color: C.navy, minWidth: 90, textAlign: "center" },
  presets: { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "center" },
  preset: {
    minWidth: 52,
    minHeight: 40,
    paddingHorizontal: 10,
    borderRadius: 100,
    borderWidth: 1.5,
    borderColor: C.border,
    alignItems: "center",
    justifyContent: "center",
  },
  presetOn: { backgroundColor: C.navy, borderColor: C.navy },
  presetText: { fontFamily: fonts.mono, fontSize: 13, color: C.ink },
  confirmIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
  },
  confirmBody: { fontFamily: fonts.body, fontSize: 14, color: C.ink, textAlign: "center", lineHeight: 21 },
  sheetActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  sheetBtn: {
    flex: 1,
    minHeight: MIN_TOUCH,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    borderWidth: 1.5,
  },
  sheetBtnCancel: { backgroundColor: C.bg, borderColor: C.border },
  sheetBtnCancelText: { fontFamily: fonts.heading, fontSize: 15, color: C.navy },
  sheetBtnConfirm: { backgroundColor: C.amber, borderColor: C.amber },
  sheetBtnDanger: { backgroundColor: C.redBg, borderColor: C.red },
  sheetBtnConfirmText: { fontFamily: fonts.heading, fontSize: 15, color: "#1A1200" },
});
