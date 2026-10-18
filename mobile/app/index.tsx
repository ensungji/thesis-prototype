// mobile/app/index.tsx
// Braille D.O.T.S — Splash + Landing screen.

import { useState, useEffect, useRef } from "react";
import { useRouter } from "expo-router";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Animated,
  Easing,
  Image,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { fonts } from "../lib/theme";


// ── Palette ───────────────────────────────────────────────────────────────────
const NAVY    = "#0A1628";
const AMBER   = "#EF9F27";
const AMBER_D = "#C47F10";
const WHITE   = "#FFFFFF";
const WHITE2  = "rgba(255,255,255,0.55)";
const WHITE3  = "rgba(255,255,255,0.20)";

// ── Cycling braille cell D-O-T-S ──────────────────────────────────────────────
const DOTS_SEQ = [
  { letter: "D", raised: [1, 4, 5] },
  { letter: "O", raised: [1, 3, 5] },
  { letter: "T", raised: [2, 3, 4, 5] },
  { letter: "S", raised: [2, 3, 4] },
];
const CELL_ROWS = [[1, 4], [2, 5], [3, 6]] as const;

function CyclingBrailleCell() {
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

// ── Splash screen ─────────────────────────────────────────────────────────────
function SplashScreen() {
  const iconScale   = useRef(new Animated.Value(0.82)).current;
  const iconOpacity = useRef(new Animated.Value(0)).current;
  const textOpacity = useRef(new Animated.Value(0)).current;
  const byOpacity   = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(iconScale, {
        toValue: 1, duration: 600,
        easing: Easing.out(Easing.back(1.3)),
        useNativeDriver: true,
      }),
      Animated.timing(iconOpacity, {
        toValue: 1, duration: 500,
        useNativeDriver: true,
      }),
    ]).start();

    Animated.sequence([
      Animated.delay(350),
      Animated.timing(textOpacity, { toValue: 1, duration: 500, useNativeDriver: true }),
    ]).start();

    Animated.sequence([
      Animated.delay(550),
      Animated.timing(byOpacity, { toValue: 1, duration: 500, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <View style={splash.root}>
      <Animated.View style={[splash.iconWrap, { opacity: iconOpacity, transform: [{ scale: iconScale }] }]}>
        <Image source={require("../assets/images/icon.png")} style={splash.icon} resizeMode="cover" />
      </Animated.View>
      <Animated.View style={[splash.textBlock, { opacity: textOpacity }]}>
        <Text style={splash.title}>Braille D.O.T.S</Text>
        <Text style={splash.subtitle}>DYNAMIC OUTPUT TACTILE SYSTEM</Text>
      </Animated.View>
      <Animated.View style={[{ marginTop: 36, marginBottom: 10 }, { opacity: byOpacity }]}>
        <CyclingBrailleCell />
      </Animated.View>
      <Animated.Text style={[splash.byLine, { opacity: byOpacity }]}>by metkayina</Animated.Text>
    </View>
  );
}

// ── Landing page (animated) ───────────────────────────────────────────────────
function LandingPage({ onHelp, onStart }: { onHelp: () => void; onStart: () => void }) {
  const { width, height } = useWindowDimensions();

  // Staggered entry animations
  const brandFade   = useRef(new Animated.Value(0)).current;
  const brandSlide  = useRef(new Animated.Value(18)).current;
  const divFade     = useRef(new Animated.Value(0)).current;
  const divScale    = useRef(new Animated.Value(0.4)).current;
  const tagFade     = useRef(new Animated.Value(0)).current;
  const tagSlide    = useRef(new Animated.Value(18)).current;
  const ctaFade     = useRef(new Animated.Value(0)).current;
  const ctaSlide    = useRef(new Animated.Value(18)).current;
  const footFade    = useRef(new Animated.Value(0)).current;

  // Pulsing CTA glow
  const ctaGlow     = useRef(new Animated.Value(0.30)).current;
  // Floating ambient dots opacity
  const ambientAnim = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const ease = Easing.out(Easing.cubic);
    const seq = (fade: Animated.Value, slide: Animated.Value | null, delay: number) => {
      const anims: Animated.CompositeAnimation[] = [
        Animated.timing(fade, { toValue: 1, duration: 520, easing: ease, useNativeDriver: true }),
      ];
      if (slide) anims.push(Animated.timing(slide, { toValue: 0, duration: 520, easing: ease, useNativeDriver: true }));
      Animated.sequence([Animated.delay(delay), Animated.parallel(anims)]).start();
    };

    seq(brandFade, brandSlide, 0);

    // Amber divider line grows in
    Animated.sequence([
      Animated.delay(180),
      Animated.parallel([
        Animated.timing(divFade,  { toValue: 1, duration: 400, useNativeDriver: true }),
        Animated.timing(divScale, { toValue: 1, duration: 400, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]),
    ]).start();

    seq(tagFade, tagSlide, 280);
    seq(ctaFade, ctaSlide, 420);
    seq(footFade, null, 560);

    // CTA subtle glow pulse
    Animated.loop(
      Animated.sequence([
        Animated.timing(ctaGlow, { toValue: 0.55, duration: 1600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(ctaGlow, { toValue: 0.30, duration: 1600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    ).start();

    // Ambient braille dots breathe
    Animated.loop(
      Animated.sequence([
        Animated.timing(ambientAnim, { toValue: 0.65, duration: 3000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(ambientAnim, { toValue: 0.40, duration: 3000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    ).start();
  }, []);

  const PX = Math.min(width * 0.07, 32);

  return (
    <View style={[land.root, { paddingHorizontal: PX }]}>
      {/* Ambient background braille dots */}
      <Animated.View style={[land.ambientGrid, { opacity: ambientAnim }]} pointerEvents="none">
        {Array.from({ length: 4 }).map((_, r) => (
          <View key={r} style={land.ambientRow}>
            {Array.from({ length: 6 }).map((_, c) => (
              <View key={c} style={land.ambientDot} />
            ))}
          </View>
        ))}
      </Animated.View>

      {/* ? button top-right */}
      <View style={land.topBar}>
        <Pressable
          onPress={onHelp}
          style={({ pressed }) => [land.helpBtn, pressed && { opacity: 0.6 }]}
          accessibilityRole="button"
          accessibilityLabel="How it works"
        >
          <Ionicons name="help-circle" size={30} color={AMBER} />
        </Pressable>
      </View>

      {/* ── Branding ── */}
      <Animated.View style={[land.brand, { opacity: brandFade, transform: [{ translateY: brandSlide }] }]}>
        <Image source={require("../assets/images/icon.png")} style={land.icon} resizeMode="cover" />
        <Text style={land.appName}>Braille D.O.T.S</Text>
        <Text style={land.appSub}>DYNAMIC OUTPUT TACTILE SYSTEM</Text>
        <Text style={land.byLine}>by metkayina</Text>
      </Animated.View>

      {/* ── Amber divider ── */}
      <Animated.View style={[land.dividerWrap, { opacity: divFade, transform: [{ scaleX: divScale }] }]}>
        <View style={land.divider} />
      </Animated.View>

      {/* ── Tagline ── */}
      <Animated.View style={[land.taglineWrap, { opacity: tagFade, transform: [{ translateY: tagSlide }] }]}>
        <Text style={[land.tagline, { fontSize: Math.min(width * 0.082, 32) }]}>
          Braille learning,{"\n"}made simple.
        </Text>
        <Text style={land.tagSub}>For teachers of visually impaired students.</Text>
      </Animated.View>

      {/* ── CTA ── */}
      <Animated.View style={[land.ctaWrap, { opacity: ctaFade, transform: [{ translateY: ctaSlide }] }]}>
        {/* Pulsing glow behind button */}
        <Animated.View style={[land.ctaGlow, { opacity: ctaGlow }]} />
        <Pressable
          onPress={onStart}
          style={({ pressed }) => [land.cta, pressed && { backgroundColor: AMBER_D }]}
          accessibilityRole="button"
          accessibilityLabel="Get started"
        >
          <Text style={land.ctaText}>Get Started</Text>
          <Ionicons name="arrow-forward" size={18} color="#1A0C00" style={{ marginLeft: 8 }} />
        </Pressable>
      </Animated.View>

      {/* ── Footer ── */}
      <Animated.Text style={[land.footer, { opacity: footFade }]}>
        {"\u00A9"} {new Date().getFullYear()} Braille D.O.T.S {"\u00B7"} by metkayina
      </Animated.Text>
    </View>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function Intro() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(async ({ data: { session } }) => {
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
          // 2500 ms — gives DB + assets time to fully initialize
          setTimeout(() => setReady(true), 2500);
        }
      })
      .catch((err) => {
        console.warn("Auth session check failed on startup:", err);
        setReady(true);
      });
  }, []);

  if (!ready) return <SplashScreen />;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: NAVY }} edges={["top", "bottom"]}>
      <LandingPage
        onHelp={() => router.push("/about" as any)}
        onStart={() => router.push("/login")}
      />
    </SafeAreaView>
  );
}

// ── Splash styles ─────────────────────────────────────────────────────────────
const splash = StyleSheet.create({
  root: {
    flex: 1, backgroundColor: NAVY,
    alignItems: "center", justifyContent: "center",
  },
  iconWrap: { borderRadius: 28, overflow: "hidden" },
  icon:     { width: 120, height: 120, borderRadius: 28 },
  textBlock: { alignItems: "center", marginTop: 28, gap: 6 },
  title:    { fontFamily: fonts.heading, fontSize: 28, color: WHITE, letterSpacing: 0.3 },
  subtitle: { fontFamily: fonts.mono, fontSize: 9, color: AMBER, letterSpacing: 3 },
  cellWrap: { gap: 6, alignItems: "center" },
  charRow:  { flexDirection: "row", gap: 6 },
  cellDot:  { width: 11, height: 11, borderRadius: 5.5, backgroundColor: AMBER },
  byLine:   { fontFamily: fonts.mono, fontSize: 11, color: WHITE3, letterSpacing: 2 },
});

// ── Landing styles ────────────────────────────────────────────────────────────
const land = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: NAVY,
    alignItems: "center",
    justifyContent: "center",
  },

  // Ambient background
  ambientGrid: {
    position: "absolute",
    top: "20%",
    gap: 18,
    alignItems: "center",
  },
  ambientRow:  { flexDirection: "row", gap: 18 },
  ambientDot:  {
    width: 5, height: 5, borderRadius: 2.5,
    backgroundColor: "rgba(239,159,39,0.25)",
  },

  // Top bar
  topBar: {
    position: "absolute",
    top: 8, right: 0,
    padding: 4,
  },
  helpBtn: { padding: 6 },

  // Branding
  brand: {
    alignItems: "center",
    gap: 6,
    marginBottom: 28,
  },
  icon: { width: 90, height: 90, borderRadius: 22, marginBottom: 4 },
  appName: {
    fontFamily: fonts.heading,
    fontSize: 26,
    color: WHITE,
    letterSpacing: 0.3,
    textAlign: "center",
  },
  appSub: {
    fontFamily: fonts.mono,
    fontSize: 8.5,
    color: AMBER,
    letterSpacing: 3,
    textAlign: "center",
  },
  byLine: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: WHITE3,
    letterSpacing: 2,
    textAlign: "center",
  },

  // Amber divider
  dividerWrap: {
    width: "60%",
    marginBottom: 28,
  },
  divider: {
    height: 1.5,
    backgroundColor: AMBER,
    borderRadius: 2,
    opacity: 0.5,
  },

  // Tagline
  taglineWrap: {
    alignItems: "center",
    marginBottom: 36,
    paddingHorizontal: 8,
  },
  tagline: {
    fontFamily: fonts.heading,
    color: WHITE,
    lineHeight: 44,
    letterSpacing: -0.3,
    textAlign: "center",
  },
  tagSub: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: WHITE2,
    textAlign: "center",
    marginTop: 10,
    lineHeight: 20,
  },

  // CTA
  ctaWrap: {
    width: "100%",
    alignItems: "center",
    marginBottom: 24,
  },
  ctaGlow: {
    position: "absolute",
    width: "90%",
    height: 56,
    borderRadius: 16,
    backgroundColor: AMBER,
    top: 4,
  },
  cta: {
    width: "100%",
    backgroundColor: AMBER,
    borderRadius: 16,
    paddingVertical: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    elevation: 8,
    shadowColor: AMBER,
    shadowOpacity: 0.4,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
  },
  ctaText: {
    fontFamily: fonts.heading,
    fontSize: 17,
    color: "#1A0C00",
    letterSpacing: 0.3,
  },

  // Footer
  footer: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: WHITE3,
    textAlign: "center",
    letterSpacing: 0.5,
  },
});
