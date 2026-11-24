// mobile/components/WordBankScopeChips.tsx
// "All" / "Mine" chips for the shared Word Bank (migration 29). Same chips in
// the Word Bank tab, Add Word's Word Bank tab, the Live session's Word Bank
// sheet and the activity editor's From Word Bank.

import { View, Text, Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { colors as C, fonts } from "../lib/theme";
import type { WordBankItem, WordBankScope } from "../lib/word-bank";

type Props = {
  scope: WordBankScope;
  onChange: (scope: WordBankScope) => void;
  /** All words (each once): shows the counts on the chips. */
  words?: WordBankItem[];
};

export function WordBankScopeChips({ scope, onChange, words }: Props) {
  const mineCount = words?.filter((w) => w.mine).length;
  const options: { key: WordBankScope; label: string; count?: number; hint: string }[] = [
    { key: "all", label: "All", count: words?.length, hint: "Every teacher's words" },
    { key: "mine", label: "Mine", count: mineCount, hint: "Only the words you added" },
  ];
  return (
    <View style={styles.row} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = scope === o.key;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && { opacity: 0.8 }]}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityHint={o.hint}
          >
            <Text style={[styles.text, on && styles.textOn]}>
              {o.label}
              {o.count != null ? ` ${o.count}` : ""}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Small "Shared" tag for a word another teacher added. */
export function SharedTag({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.tag, style]} accessibilityLabel="Shared: added by another teacher">
      <Text style={styles.tagText}>Shared</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8 },
  chip: {
    minHeight: 36,
    paddingHorizontal: 14,
    justifyContent: "center",
    borderRadius: 100,
    borderWidth: 1.5,
    borderColor: C.border,
    backgroundColor: C.white,
  },
  chipOn: { backgroundColor: C.navy, borderColor: C.navy },
  text: { fontFamily: fonts.heading, fontSize: 12, color: C.muted },
  textOn: { color: C.white },
  tag: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 100,
    backgroundColor: C.blueWash,
    alignSelf: "center",
  },
  tagText: { fontFamily: fonts.mono, fontSize: 10, color: C.navy, letterSpacing: 0.5 },
});
