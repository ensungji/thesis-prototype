// mobile/app/index.tsx
// Braille D.O.T.S — Animated splash / landing screen.
// In-app splash: icon + title + "by metkayina" with staggered fade animations.
// Logged-in users are redirected silently while the splash plays.

import { useState, useEffect, useRef } from "react";
import { useRouter } from "expo-router";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Animated,
  Easing,
  Image,
  Dimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { supabase } from "../lib/supabase";
import { fonts } from "../lib/theme";

const { width: SW } = Dimensions.get("window");

// ── Cycling braille cell D→O→T→S→D ──────────────────────────────────────────
// One 3-row × 2-col braille cell whose dot pattern smoothly transitions
// through the letters of "DOTS" on a loop — acts as the loading indicator.
const DOTS_SEQ = [
  { letter: "D", raised: [1, 4, 5] },
  { letter: "O", raised: [1, 3, 5] },
  { letter: "T", raised: [2, 3, 4, 5] },
  { letter: "S", raised: [2, 3, 4] },
];
const CELL_ROWS = [[1, 4], [2, 5], [3, 6]] as const;

function CyclingBrailleCell() {
  // One Animated.Value per dot (1-6), initialised to D's pattern
  const dotAnims = useRef(
    Array.from({ length: 6 }, (_, i) =>
      new Animated.Value(DOTS_SEQ[0].raised.includes(i + 1) ? 1 : 0.12)
    )
  ).current;

  useEffect(() => {
    let idx = 0;
    const step = () => {
      idx = (idx + 1) % DOTS_SEQ.length;
      const pattern = DOTS_SEQ[idx].raised;
      Animated.parallel(
        dotAnims.map((anim, i) =>
          Animated.timing(anim, {
            toValue: pattern.includes(i + 1) ? 1 : 0.12,
            duration: 350,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          })
        )
      ).start();
    };
    const id = setInterval(step, 750);
    return () => clearInterval(id);
  }, []);

  return (
    <View style={splash.cellWrap}>
      {CELL_ROWS.map((row, ri) => (
        <View key={ri} style={splash.charRow}>
          {row.map((dotNum) => (
            <Animated.View
              key={dotNum}
              style={[splash.cellDot, { opacity: dotAnims[dotNum - 1] }]}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

// ── Animated splash screen ────────────────────────────────────────────────────
// Shown while checking auth session. Matches the native splash exactly.
function SplashScreen() {
  const iconScale   = useRef(new Animated.Value(0.82)).current;
  const iconOpacity = useRef(new Animated.Value(0)).current;
  const glowOpacity = useRef(new Animated.Value(0)).current;
  const textOpacity = useRef(new Animated.Value(0)).current;
  const byOpacity   = useRef(new Animated.Value(0)).current;
  const dotPulse    = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    // 1. Icon scales up + fades in
    Animated.parallel([
      Animated.timing(iconScale, {
        toValue: 1,
        duration: 600,
        easing: Easing.out(Easing.back(1.3)),
        useNativeDriver: true,
      }),
      Animated.timing(iconOpacity, {
        toValue: 1,
        duration: 500,
        useNativeDriver: true,
      }),
    ]).start();

    // 2. Glow pulses in slightly after icon
    Animated.sequence([
      Animated.delay(200),
      Animated.timing(glowOpacity, {
        toValue: 1,
        duration: 600,
        useNativeDriver: true,
      }),
    ]).start();

    // 3. Title fades in
    Animated.sequence([
      Animated.delay(350),
      Animated.timing(textOpacity, {
        toValue: 1,
        duration: 500,
        useNativeDriver: true,
      }),
    ]).start();

    // 4. Byline fades in last
    Animated.sequence([
      Animated.delay(550),
      Animated.timing(byOpacity, {
        toValue: 1,
        duration: 500,
        useNativeDriver: true,
      }),
    ]).start();

    // 5. Continuous subtle dot pulse
    Animated.loop(
      Animated.sequence([
        Animated.timing(dotPulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(dotPulse, {
          toValue: 0.6,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    ).start();
  }, []);

  // Braille patterns for D-O-T-S (dots 1-6, layout: row0=[1,4] row1=[2,5] row2=[3,6])
  const DOTS_CHARS = [
    { letter: "D", raised: [1, 4, 5] },
    { letter: "O", raised: [1, 3, 5] },
    { letter: "T", raised: [2, 3, 4, 5] },
    { letter: "S", raised: [2, 3, 4] },
  ];
  const CELL_LAYOUT = [[1, 4], [2, 5], [3, 6]] as const;

  return (
    <View style={splash.root}>
      {/* App icon */}
      <Animated.View
        style={[
          splash.iconWrap,
          { opacity: iconOpacity, transform: [{ scale: iconScale }] },
        ]}
      >
        <Image
          source={require("../assets/images/icon.png")}
          style={splash.icon}
          resizeMode="cover"
        />
      </Animated.View>

      {/* Title */}
      <Animated.View style={[splash.textBlock, { opacity: textOpacity }]}>
        <Text style={splash.title}>Braille D.O.T.S</Text>
        <Text style={splash.subtitle}>DYNAMIC OUTPUT TACTILE SYSTEM</Text>
      </Animated.View>

      {/* D-O-T-S cycling braille cell (loading indicator) */}
      <Animated.View style={[{ marginTop: 32, marginBottom: 10 }, { opacity: byOpacity }]}>
        <CyclingBrailleCell />
      </Animated.View>

      {/* By line */}
      <Animated.Text style={[splash.byLine, { opacity: byOpacity }]}>
        by metkayina
      </Animated.Text>
    </View>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Intro() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  const heroFade  = useRef(new Animated.Value(0)).current;
  const heroSlide = useRef(new Animated.Value(24)).current;

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("role")
          .eq("id", session.user.id)
          .single();
        if (profile?.role === "admin") {
          router.replace("/admin" as any);
        } else {
          router.replace("/(teacher)/dashboard" as any);
        }
      } else {
        // Minimum splash display so animations play
        setTimeout(() => {
          setChecking(false);
          Animated.parallel([
            Animated.timing(heroFade, {
              toValue: 1,
              duration: 500,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: true,
            }),
            Animated.timing(heroSlide, {
              toValue: 0,
              duration: 500,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: true,
            }),
          ]).start();
        }, 1200);
      }
    });
  }, []);

  if (checking) return <SplashScreen />;

  return (
    <SafeAreaView style={page.safe} edges={["top", "bottom"]}>
      <ScrollView
        contentContainerStyle={page.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Dark hero ─────────────────────────────────────────────── */}
        <Animated.View
          style={[
            page.hero,
            { opacity: heroFade, transform: [{ translateY: heroSlide }] },
          ]}
        >
          {/* Decorative bg dots */}
          <View style={page.bgDots} pointerEvents="none">
            {Array.from({ length: 30 }).map((_, i) => (
              <View
                key={i}
                style={[page.bgDot, { opacity: 0.04 + (i % 6) * 0.016 }]}
              />
            ))}
          </View>

          {/* Icon + branding */}
          <View style={page.brandBlock}>
            {/* Braille dot grid backdrop */}
            <View style={page.brailleGrid} pointerEvents="none">
              {[0, 1, 2].map((row) => (
                <View key={row} style={page.brailleGridRow}>
                  {[0, 1, 2, 3].map((col) => (
                    <View key={col} style={page.brailleGridDot} />
                  ))}
                </View>
              ))}
            </View>
            <Image
              source={require("../assets/images/icon.png")}
              style={page.heroIcon}
              resizeMode="cover"
            />
            <Text style={page.heroTitle}>Braille D.O.T.S</Text>
            <Text style={page.heroSub}>DYNAMIC OUTPUT TACTILE SYSTEM</Text>
            <Text style={page.heroByline}>by metkayina</Text>
            <Text style={page.heroLead}>
              A teacher types a word — the device raises it as real braille
              {"\n"}pins while you track how students respond.
            </Text>
          </View>

          {/* CTA */}
          <Pressable
            onPress={() => router.push("/login")}
            style={({ pressed }) => [page.cta, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityLabel="Get started"
          >
            <Text style={page.ctaText}>Get Started →</Text>
          </Pressable>
        </Animated.View>

        {/* ── Light section: how it works ─────────────────────────── */}
        <Animated.View
          style={[
            page.lightSection,
            { opacity: heroFade, transform: [{ translateY: heroSlide }] },
          ]}
        >
          <Text style={page.sectionChip}>FOR TEACHERS</Text>
          <Text style={page.sectionTitle}>How it works</Text>

          {[
            { n: "01", icon: "⚡", title: "Connect the device",  body: "Pair the D.O.T.S braille cell with your phone over WiFi — no cables needed." },
            { n: "02", icon: "⌨",  title: "Type or pick a word", body: "Enter any word or pick from your word bank. It converts to braille instantly." },
            { n: "03", icon: "✋", title: "Student feels it",     body: "Six tactile pins raise one letter at a time at the student's own pace." },
            { n: "04", icon: "📊", title: "Track progress",       body: "Accuracy and response times are recorded for every word and every student." },
          ].map((s) => (
            <View key={s.n} style={page.step}>
              <View style={page.stepIcon}>
                <Text style={page.stepEmoji}>{s.icon}</Text>
              </View>
              <View style={{ flex: 1, gap: 3 }}>
                <View style={page.stepTopRow}>
                  <Text style={page.stepNum}>{s.n}</Text>
                  <Text style={page.stepTitle2}>{s.title}</Text>
                </View>
                <Text style={page.stepBody}>{s.body}</Text>
              </View>
            </View>
          ))}
        </Animated.View>

        <Text style={page.footer}>
          © {new Date().getFullYear()} Braille D.O.T.S · by metkayina
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Splash styles ─────────────────────────────────────────────────────────────
const NAVY   = "#0A1628";
const AMBER  = "#EF9F27";
const WHITE  = "#FFFFFF";
const WHITE2 = "rgba(255,255,255,0.55)";
const WHITE3 = "rgba(255,255,255,0.25)";

const splash = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: NAVY,
    alignItems: "center",
    justifyContent: "center",
    gap: 0,
  },
  // Braille 4-col × 3-row dot grid — sits absolutely behind the icon
  // 4 cols × 3 rows of 28px dots with 20px gaps
  // Width: 4*28 + 3*20 = 172px  Height: 3*28 + 2*20 = 124px
  // Both larger than the 120px icon so dots peek out visibly on all sides
  brailleGrid: {
    position: "absolute",
    gap: 20,
    alignItems: "center",
  },
  brailleGridRow: {
    flexDirection: "row",
    gap: 20,
  },
  brailleGridDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(239,159,39,0.28)",
  },
  iconWrap: {
    borderRadius: 28,
    overflow: "hidden",
  },
  icon: {
    width: 120,
    height: 120,
    borderRadius: 28,
  },
  textBlock: {
    alignItems: "center",
    marginTop: 28,
    gap: 6,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 28,
    color: WHITE,
    letterSpacing: 0.3,
  },
  subtitle: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: AMBER,
    letterSpacing: 3,
  },
  // Cycling braille cell
  cellWrap: {
    gap: 6,
    alignItems: "center",
  },
  charRow: {
    flexDirection: "row",
    gap: 6,
  },
  cellDot: {
    width: 11,
    height: 11,
    borderRadius: 5.5,
    backgroundColor: AMBER,
  },
  byLine: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: WHITE3,
    letterSpacing: 2,
  },
});

// ── Landing page styles ───────────────────────────────────────────────────────
const page = StyleSheet.create({
  safe:  { flex: 1, backgroundColor: NAVY },
  scroll: { paddingBottom: 0 },

  // Dark hero
  hero: {
    backgroundColor: NAVY,
    paddingHorizontal: 28,
    paddingTop: 52,
    paddingBottom: 52,
    overflow: "hidden",
    gap: 0,
  },
  bgDots: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    padding: 18,
    gap: 22,
  },
  bgDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: AMBER,
  },

  brandBlock: {
    alignItems: "center",
    gap: 10,
    marginBottom: 36,
  },
  // Braille dot grid for the landing hero (same proportions as splash)
  brailleGrid: {
    position: "absolute",
    top: -2,
    gap: 18,
    alignItems: "center",
  },
  brailleGridRow: {
    flexDirection: "row",
    gap: 18,
  },
  brailleGridDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "rgba(239,159,39,0.22)",
  },
  heroIcon: {
    width: 100,
    height: 100,
    borderRadius: 24,
  },
  heroTitle: {
    fontFamily: fonts.heading,
    fontSize: 30,
    color: WHITE,
    textAlign: "center",
    marginTop: 8,
  },
  heroSub: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: AMBER,
    letterSpacing: 3,
    textAlign: "center",
  },
  heroByline: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: WHITE3,
    letterSpacing: 2,
    textAlign: "center",
  },
  heroLead: {
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 22,
    color: WHITE2,
    textAlign: "center",
    marginTop: 8,
    paddingHorizontal: 8,
  },

  cta: {
    backgroundColor: AMBER,
    borderRadius: 14,
    paddingVertical: 17,
    alignItems: "center",
    shadowColor: AMBER,
    shadowOpacity: 0.4,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  ctaText: {
    fontFamily: fonts.heading,
    fontSize: 17,
    color: "#1A0C00",
    letterSpacing: 0.3,
  },

  // Light section
  lightSection: {
    backgroundColor: "#F8F9FA",
    paddingHorizontal: 24,
    paddingTop: 36,
    paddingBottom: 36,
    gap: 14,
  },
  sectionChip: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: "#5C3800",
    backgroundColor: "#FAEEDA",
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 100,
    letterSpacing: 1.5,
    overflow: "hidden",
  },
  sectionTitle: {
    fontFamily: fonts.heading,
    fontSize: 24,
    color: "#0C447C",
    marginBottom: 4,
  },
  step: {
    flexDirection: "row",
    gap: 14,
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1.5,
    borderColor: "#E8E8E4",
    alignItems: "flex-start",
  },
  stepIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "#E6F1FB",
    alignItems: "center",
    justifyContent: "center",
  },
  stepEmoji: { fontSize: 18 },
  stepTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 2,
  },
  stepNum: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: "#8A8A86",
  },
  stepTitle2: {
    fontFamily: fonts.heading,
    fontSize: 15,
    color: "#0C447C",
  },
  stepBody: {
    fontFamily: fonts.body,
    fontSize: 13.5,
    lineHeight: 20,
    color: "#1A1E2A",
  },

  footer: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: "#8A8A86",
    textAlign: "center",
    paddingVertical: 24,
    backgroundColor: "#F8F9FA",
  },
});