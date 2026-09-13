// components/HowItWorksModal.tsx
// Reusable "How it works" info modal — shown when the ? button is tapped
// on the landing page or sign-in page.

import { Modal, View, Text, Pressable, ScrollView, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { fonts } from "../lib/theme";

interface Props {
  visible: boolean;
  onClose: () => void;
}

const STEPS = [
  {
    n: "01",
    iconName: "flash" as const,
    title: "Connect the device",
    body: "Pair the D.O.T.S braille cell with your phone over WiFi — no cables needed.",
  },
  {
    n: "02",
    iconName: "keypad" as const,
    title: "Type or pick a word",
    body: "Enter any word or pick from your word bank. It converts to braille instantly.",
  },
  {
    n: "03",
    iconName: "hand-left" as const,
    title: "Student feels it",
    body: "Six tactile pins raise one letter at a time at the student's own pace.",
  },
  {
    n: "04",
    iconName: "bar-chart" as const,
    title: "Track progress",
    body: "Accuracy and response times are recorded for every word and every student.",
  },
];

const NAVY  = "#0A1628";
const AMBER = "#EF9F27";
const WHITE = "#FFFFFF";

export function HowItWorksModal({ visible, onClose }: Props) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={s.overlay}>
        <View style={s.sheet}>
          {/* Header */}
          <View style={s.header}>
            <View>
              <Text style={s.chip}>FOR TEACHERS</Text>
              <Text style={s.title}>How it works</Text>
            </View>
            <Pressable
              onPress={onClose}
              style={({ pressed }) => [s.closeBtn, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={22} color={NAVY} />
            </Pressable>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} style={{ marginTop: 8 }}>
            {STEPS.map((step) => (
              <View key={step.n} style={s.step}>
                <View style={s.iconBox}>
                  <Ionicons name={step.iconName} size={20} color={AMBER} />
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <View style={s.stepTop}>
                    <Text style={s.stepNum}>{step.n}</Text>
                    <Text style={s.stepTitle}>{step.title}</Text>
                  </View>
                  <Text style={s.stepBody}>{step.body}</Text>
                </View>
              </View>
            ))}
            <View style={{ height: 24 }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: WHITE,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 8,
    maxHeight: "80%",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  chip: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: "#5C3800",
    backgroundColor: "#FAEEDA",
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 100,
    letterSpacing: 1.5,
    overflow: "hidden",
    marginBottom: 6,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 24,
    color: NAVY,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#F0F0EE",
    alignItems: "center",
    justifyContent: "center",
  },
  step: {
    flexDirection: "row",
    gap: 14,
    backgroundColor: "#F8F9FA",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1.5,
    borderColor: "#E8E8E4",
    alignItems: "flex-start",
    marginBottom: 10,
  },
  iconBox: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: "#FFF4E0",
    alignItems: "center",
    justifyContent: "center",
  },
  stepTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  stepNum: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: "#8A8A86",
  },
  stepTitle: {
    fontFamily: fonts.heading,
    fontSize: 15,
    color: NAVY,
  },
  stepBody: {
    fontFamily: fonts.body,
    fontSize: 13.5,
    lineHeight: 20,
    color: "#1A1E2A",
  },
});
