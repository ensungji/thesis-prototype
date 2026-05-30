// mobile/app/index.tsx
// Braille D.O.T.S — Intro / Landing screen (React Native + Expo Router)
// One simple, scrollable page that explains the whole concept.

import { useRouter } from "expo-router";
import { View, Text, Pressable, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors as C } from "../lib/theme";
import { BrailleCell } from "../components/BrailleCell";

const STEPS = [
  { n: 1, title: "Connect the device",    body: "Pair the D.O.T.S braille cell with your phone over WiFi — no cables." },
  { n: 2, title: "Type a word",           body: "Enter any word in the app. It's converted into braille patterns." },
  { n: 3, title: "The student feels it",  body: "Six tactile pins raise one letter at a time, at the student's own pace." },
  { n: 4, title: "Track progress",        body: "Accuracy and response times are recorded for every student." },
];

export default function Intro() {
  const router = useRouter();

  // Change "/login" to your first real screen.
  // For the prototype path you can route to "/connect" instead.
  const start = () => router.push("/login");

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        {/* Brand */}
        <View style={styles.brandRow}>
          <BrailleCell pattern={[1, 2, 5]} size={11} />
          <View>
            <Text style={styles.brandName}>Braille D.O.T.S</Text>
            <Text style={styles.brandSub}>DYNAMIC OUTPUT TACTILE SYSTEM</Text>
          </View>
        </View>

        {/* Hero */}
        <View style={styles.hero}>
          <Text style={styles.badge}>FOR TEACHERS</Text>
          <Text style={styles.h1}>
            Teaching braille,{"\n"}
            <Text style={{ color: C.amber }}>one dot at a time.</Text>
          </Text>
          <Text style={styles.lead}>
            A teacher types a word, the device raises it as real braille, and the
            student reads it with their fingertips — while you track how they do.
          </Text>
        </View>

        {/* How it works */}
        <View style={{ gap: 12 }}>
          <Text style={styles.sectionLabel}>HOW IT WORKS</Text>
          <View style={styles.steps}>
            {STEPS.map((s) => (
              <View key={s.n} style={styles.step}>
                <View style={styles.stepNum}>
                  <Text style={styles.stepNumText}>{String(s.n).padStart(2, "0")}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.stepTitle}>{s.title}</Text>
                  <Text style={styles.stepBody}>{s.body}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>

        {/* CTA */}
        <Pressable
          onPress={start}
          accessibilityRole="button"
          accessibilityLabel="Get started — go to the teacher portal"
          style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}
        >
          <Text style={styles.ctaText}>Get Started</Text>
        </Pressable>

        <Text style={styles.footer}>© {new Date().getFullYear()} Braille D.O.T.S</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 24, paddingBottom: 40, gap: 28 },

  brandRow:  { flexDirection: "row", alignItems: "center", gap: 12 },
  brandName: { fontFamily: "Nunito_700Bold", fontSize: 18, color: C.navy },
  brandSub:  { fontFamily: "IBMPlexMono_400Regular", fontSize: 9, color: C.brown, letterSpacing: 0.5 },

  hero: { gap: 14 },
  badge: {
    alignSelf: "flex-start",
    fontFamily: "IBMPlexMono_400Regular",
    fontSize: 11, color: C.brown,
    backgroundColor: C.brownBg,
    paddingHorizontal: 12, paddingVertical: 5,
    borderRadius: 100, overflow: "hidden",
    letterSpacing: 1,
  },
  h1:   { fontFamily: "Nunito_700Bold", fontSize: 30, lineHeight: 38, color: C.navy },
  lead: { fontFamily: "AtkinsonHyperlegible_400Regular", fontSize: 15, lineHeight: 24, color: C.ink },

  sectionLabel: { fontFamily: "IBMPlexMono_400Regular", fontSize: 11, color: C.brown, letterSpacing: 1 },

  steps: { gap: 14 },
  step: {
    flexDirection: "row", gap: 14, alignItems: "flex-start",
    backgroundColor: C.white, borderRadius: 16, padding: 16,
    borderWidth: 1.5, borderColor: C.border,
  },
  stepNum: {
    width: 38, height: 38, borderRadius: 10,
    backgroundColor: C.blueWash, alignItems: "center", justifyContent: "center",
  },
  stepNumText: { fontFamily: "IBMPlexMono_400Regular", fontSize: 14, color: C.navy },
  stepTitle:   { fontFamily: "Nunito_700Bold", fontSize: 16, color: C.navy, marginBottom: 3 },
  stepBody:    { fontFamily: "AtkinsonHyperlegible_400Regular", fontSize: 13.5, lineHeight: 20, color: C.ink },

  cta: {
    backgroundColor: C.amber, borderRadius: 14,
    paddingVertical: 16, alignItems: "center",
    elevation: 3,
    shadowColor: C.amber, shadowOpacity: 0.4, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
  },
  ctaText: { fontFamily: "Nunito_700Bold", fontSize: 17, color: "#1A1200" },

  footer: { fontFamily: "AtkinsonHyperlegible_400Regular", fontSize: 12, color: C.muted, textAlign: "center" },
});