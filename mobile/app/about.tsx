// mobile/app/about.tsx
// "How it works" — full-screen premium page accessible via the ? button
// on both the landing and sign-in screens.

import { useEffect, useRef } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Animated,
  Easing,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { fonts } from "../lib/theme";

// ── Palette ───────────────────────────────────────────────────────────────────
const NAVY   = "#0A1628";
const NAVY2  = "#0E1D38";
const AMBER  = "#EF9F27";
const WHITE  = "#FFFFFF";
const WHITE2 = "rgba(255,255,255,0.60)";
const WHITE3 = "rgba(255,255,255,0.20)";
const AMBER_L = "rgba(239,159,39,0.13)";
const AMBER_B = "rgba(239,159,39,0.30)";

// ── Steps data ────────────────────────────────────────────────────────────────
const STEPS = [
  {
    n: "01",
    icon: "wifi" as const,
    title: "Connect the device",
    body: "Pair the D.O.T.S braille cell with your phone over WiFi — no cables needed.",
    accent: "rgba(239,159,39,0.18)",
  },
  {
    n: "02",
    icon: "keypad" as const,
    title: "Type or pick a word",
    body: "Enter any word or pick from your word bank. It converts to braille instantly.",
    accent: "rgba(99,179,237,0.14)",
  },
  {
    n: "03",
    icon: "hand-left" as const,
    title: "Student feels it",
    body: "Six tactile pins raise one letter at a time at the student\u2019s own pace.",
    accent: "rgba(104,211,145,0.14)",
  },
  {
    n: "04",
    icon: "bar-chart" as const,
    title: "Track progress",
    body: "Accuracy and response times are recorded for every word and every student.",
    accent: "rgba(183,148,244,0.14)",
  },
] as const;

// ── Animated step card ────────────────────────────────────────────────────────
function StepCard({
  step,
  index,
}: {
  step: typeof STEPS[number];
  index: number;
}) {
  const fade  = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(24)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.delay(120 + index * 130),
      Animated.parallel([
        Animated.timing(fade,  { toValue: 1, duration: 480, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(slide, { toValue: 0, duration: 480, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]),
    ]).start();
  }, []);

  return (
    <Animated.View style={[s.card, { opacity: fade, transform: [{ translateY: slide }] }]}>
      {/* Step number badge */}
      <View style={s.cardTop}>
        <Text style={s.stepNum}>{step.n}</Text>
        <View style={[s.iconCircle, { backgroundColor: step.accent }]}>
          <Ionicons name={step.icon} size={22} color={AMBER} />
        </View>
      </View>

      <Text style={s.cardTitle}>{step.title}</Text>
      <Text style={s.cardBody}>{step.body}</Text>

      {/* Subtle amber bottom accent line */}
      <View style={s.cardLine} />
    </Animated.View>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function About() {
  const router = useRouter();
  const { width } = useWindowDimensions();

  // Header fade
  const headerFade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(headerFade, { toValue: 1, duration: 400, useNativeDriver: true }).start();
  }, []);

  return (
    <SafeAreaView style={s.safe} edges={["top", "bottom"]}>

      {/* ── Header ── */}
      <Animated.View style={[s.header, { opacity: headerFade }]}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [s.backBtn, pressed && { opacity: 0.6 }]}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={20} color={WHITE} />
          <Text style={s.backText}>Back</Text>
        </Pressable>

        <View style={s.headerCenter}>
          <View style={s.chip}>
            <Text style={s.chipText}>FOR TEACHERS</Text>
          </View>
          <Text style={s.pageTitle}>How it works</Text>
        </View>

        {/* Spacer to balance the back button */}
        <View style={{ width: 60 }} />
      </Animated.View>

      {/* ── Divider ── */}
      <View style={s.headerDivider} />

      {/* ── Content ── */}
      <ScrollView
        contentContainerStyle={[s.scroll, { paddingHorizontal: Math.min(width * 0.06, 28) }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Intro line */}
        <Animated.Text style={[s.intro, { opacity: headerFade }]}>
          Braille D.O.T.S connects a teacher's phone to a physical braille device —
          letting students learn by touch.
        </Animated.Text>

        {/* Step cards */}
        {STEPS.map((step, i) => (
          <StepCard key={step.n} step={step} index={i} />
        ))}

        {/* Footer note */}
        <View style={s.note}>
          <Ionicons name="information-circle-outline" size={16} color={AMBER} />
          <Text style={s.noteText}>
            D.O.T.S — Dynamic Output Tactile System. Designed for classroom use with
            visually impaired students.
          </Text>
        </View>

        <Text style={s.footer}>
          {"\u00A9"} {new Date().getFullYear()} Braille D.O.T.S {"\u00B7"} by metkayina
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: NAVY },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
    justifyContent: "space-between",
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    width: 60,
  },
  backText: {
    fontFamily: fonts.heading,
    fontSize: 15,
    color: WHITE,
  },
  headerCenter: {
    alignItems: "center",
    gap: 6,
    flex: 1,
  },
  chip: {
    backgroundColor: AMBER_B,
    borderRadius: 100,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: "rgba(239,159,39,0.35)",
  },
  chipText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: AMBER,
    letterSpacing: 2,
  },
  pageTitle: {
    fontFamily: fonts.heading,
    fontSize: 22,
    color: WHITE,
    textAlign: "center",
  },
  headerDivider: {
    height: 1,
    backgroundColor: "rgba(255,255,255,0.07)",
    marginHorizontal: 20,
  },

  // Content
  scroll: {
    paddingTop: 24,
    paddingBottom: 40,
    gap: 14,
  },
  intro: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: WHITE2,
    lineHeight: 22,
    marginBottom: 8,
  },

  // Step cards
  card: {
    backgroundColor: NAVY2,
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.07)",
    gap: 8,
    overflow: "hidden",
  },
  cardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  stepNum: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: AMBER,
    letterSpacing: 2,
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: {
    fontFamily: fonts.heading,
    fontSize: 18,
    color: WHITE,
    lineHeight: 26,
  },
  cardBody: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: WHITE2,
    lineHeight: 22,
  },
  cardLine: {
    position: "absolute",
    left: 0,
    bottom: 0,
    right: 0,
    height: 2,
    backgroundColor: AMBER,
    opacity: 0.2,
  },

  // Note
  note: {
    flexDirection: "row",
    gap: 10,
    backgroundColor: AMBER_L,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: "rgba(239,159,39,0.2)",
    alignItems: "flex-start",
    marginTop: 4,
  },
  noteText: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 13,
    color: WHITE2,
    lineHeight: 20,
  },

  footer: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: WHITE3,
    textAlign: "center",
    letterSpacing: 0.5,
    marginTop: 12,
  },
});
