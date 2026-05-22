import { useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Alert,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";

// ── Design Tokens ─────────────────────────────────────────
const C = {
  navy: "#0C447C",
  navyMid: "#378ADD",
  navyLight: "#E6F1FB",
  amber: "#EF9F27",
  amberMid: "#FAC775",
  amberLight: "#FAEEDA",
  white: "#F8F9FA",
  surface: "#FFFFFF",
  bgAlt: "#E8E8E4",
  green: "#3B6D11",
  greenMid: "#97C459",
  greenLight: "#EAF3DE",
  red: "#A32D2D",
  redMid: "#E24B4A",
  redLight: "#FCEBEB",
  gray: "#5F5E5A",
  grayMid: "#B4B2A9",
  grayLight: "#F1EFE8",
  dotEmpty: "#C5D8EC",
};

const F = {
  heading: "Nunito_700Bold",
  headingSemi: "Nunito_600SemiBold",
  body: "AtkinsonHyperlegible_400Regular",
  bodyBold: "AtkinsonHyperlegible_700Bold",
  mono: "IBMPlexMono_400Regular",
};

// ── Braille Patterns A–Z ──────────────────────────────────
const BRAILLE: Record<string, number[]> = {
  A: [1],
  B: [1, 2],
  C: [1, 4],
  D: [1, 4, 5],
  E: [1, 5],
  F: [1, 2, 4],
  G: [1, 2, 4, 5],
  H: [1, 2, 5],
  I: [2, 4],
  J: [2, 4, 5],
  K: [1, 3],
  L: [1, 2, 3],
  M: [1, 3, 4],
  N: [1, 3, 4, 5],
  O: [1, 3, 5],
  P: [1, 2, 3, 4],
  Q: [1, 2, 3, 4, 5],
  R: [1, 2, 3, 5],
  S: [2, 3, 4],
  T: [2, 3, 4, 5],
  U: [1, 3, 6],
  V: [1, 2, 3, 6],
  W: [2, 4, 5, 6],
  X: [1, 3, 4, 6],
  Y: [1, 3, 4, 5, 6],
  Z: [1, 3, 5, 6],
};

// ── Braille Cell ──────────────────────────────────────────
function BrailleCell({ letter }: { letter: string }) {
  const dots = BRAILLE[letter] ?? [];
  return (
    <View style={s.brailleWrapper}>
      <Text style={s.sectionLabel}>Braille Pattern</Text>
      <View style={s.brailleGrid}>
        <View style={s.brailleCol}>
          {[1, 2, 3].map((dot) => (
            <View
              key={dot}
              style={[s.dot, dots.includes(dot) && s.dotRaised]}
            />
          ))}
        </View>
        <View style={s.brailleCol}>
          {[4, 5, 6].map((dot) => (
            <View
              key={dot}
              style={[s.dot, dots.includes(dot) && s.dotRaised]}
            />
          ))}
        </View>
      </View>
      <Text style={s.monoText}>
        {dots.length > 0 ? `dots  ${dots.join("  ·  ")}` : "no dots raised"}
      </Text>
    </View>
  );
}

// ── Letter Progress Strip ─────────────────────────────────
function LetterStrip({
  letters,
  current,
}: {
  letters: string[];
  current: number;
}) {
  return (
    <View style={s.stripRow}>
      {letters.map((l, i) => (
        <View
          key={i}
          style={[
            s.stripTile,
            i === current && s.stripTileActive,
            i < current && s.stripTileDone,
          ]}
        >
          <Text
            style={[
              s.stripLetter,
              i === current && s.stripLetterActive,
              i < current && s.stripLetterDone,
            ]}
          >
            {l}
          </Text>
        </View>
      ))}
    </View>
  );
}

function SectionLabel({ text }: { text: string }) {
  return <Text style={s.sectionLabel}>{text}</Text>;
}

function Divider() {
  return <View style={s.divider} />;
}

// ── Main Screen ───────────────────────────────────────────
export default function Index() {
  const [ip, setIp] = useState("192.168.4.1"); // ESP32 AP mode — always this IP
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [word, setWord] = useState("");
  const [letters, setLetters] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [started, setStarted] = useState(false);
  const ws = useRef<WebSocket | null>(null);

  const currentLetter = started && letters.length > 0 ? letters[index] : null;

  // ── WebSocket ───────────────────────────────────────────
  const handleConnect = useCallback(() => {
    if (!ip.trim()) {
      Alert.alert("No IP entered", "Enter the ESP32 IP address first.");
      return;
    }
    if (connected) {
      ws.current?.close();
      setConnected(false);
      return;
    }
    setConnecting(true);
    const socket = new WebSocket(`ws://${ip.trim()}:81`);

    socket.onopen = () => {
      setConnected(true);
      setConnecting(false);
    };
    socket.onclose = () => {
      setConnected(false);
      setConnecting(false);
    };
    socket.onerror = () => {
      setConnected(false);
      setConnecting(false);
      Alert.alert(
        "Connection failed",
        `Could not reach ESP32 at ${ip.trim()}:81\n\nMake sure your phone is connected to the BrailleDOTS WiFi hotspot.`,
      );
    };

    // Listen for messages from the device
    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);

        // Device sends status after every navigation (button press)
        // Use this to keep the app UI in sync with the physical device
        if (msg.type === "status") {
          setIndex(msg.index);
        }

        // Device sends this when ANSWER button is pressed physically
        if (msg.type === "button" && msg.button === "answer") {
          Alert.alert("Answer", "Student pressed the Answer button.");
        }
      } catch {}
    };

    ws.current = socket;
  }, [ip, connected]);

  // Send the FULL word to the ESP32 at once.
  // The device stores it, shows the first letter, and handles
  // NEXT/BACK navigation locally via physical buttons.
  function sendWord(fullWord: string) {
    const msg = JSON.stringify({ type: "word", word: fullWord });
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(msg);
    console.log("→ ESP32:", msg);
  }

  function handleStart() {
    const cleaned = word
      .trim()
      .toUpperCase()
      .replace(/[^A-Z]/g, "");
    if (!cleaned) {
      Alert.alert("Empty word", "Please type a word first.");
      return;
    }
    if (!connected) {
      Alert.alert("Not connected", "Connect to the ESP32 device first.");
      return;
    }
    const arr = cleaned.split("");
    setLetters(arr);
    setIndex(0);
    setStarted(true);
    sendWord(cleaned); // Send whole word — device handles letter-by-letter display
  }

  // These update the app UI only.
  // Physical buttons on the device navigate the solenoids.
  // The device sends back status updates to keep index in sync.
  function handleNext() {
    setIndex((prev) => (prev >= letters.length - 1 ? prev : prev + 1));
  }

  function handleBack() {
    setIndex((prev) => (prev <= 0 ? prev : prev - 1));
  }

  function handleReset() {
    setWord("");
    setLetters([]);
    setIndex(0);
    setStarted(false);
  }

  // ── Render ──────────────────────────────────────────────
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        style={s.screen}
        contentContainerStyle={s.scroll}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Header ── */}
        <View style={s.headerBar}>
          <View style={s.headerLeft}>
            <Text style={s.appName}>Braille D.O.T.S</Text>
            <Text style={s.appSub}>Dynamic Output Tactile System</Text>
          </View>
          <View style={[s.statusBadge, connected ? s.badgeGreen : s.badgeGray]}>
            <View style={[s.statusDot, connected ? s.dotGreen : s.dotGray]} />
            <Text style={[s.statusText, connected ? s.textGreen : s.textGray]}>
              {connected ? "Live" : "Offline"}
            </Text>
          </View>
        </View>

        {/* ── Amber accent bar ── */}
        <View style={s.accentBar} />

        {/* ── Device Connection Card ── */}
        <View style={s.card}>
          <View style={s.cardHeader}>
            <View style={s.cardHeaderDot} />
            <Text style={s.cardTitle}>ESP32 Device</Text>
          </View>

          <SectionLabel text="Device IP Address" />
          <TextInput
            style={s.input}
            placeholder="192.168.4.1"
            placeholderTextColor={C.grayMid}
            value={ip}
            onChangeText={setIp}
            keyboardType="numeric"
            editable={!connected}
            autoCorrect={false}
          />

          <TouchableOpacity
            style={[s.btn, connected ? s.btnDanger : s.btnPrimary]}
            onPress={handleConnect}
            disabled={connecting}
            activeOpacity={0.85}
          >
            {connecting ? (
              <ActivityIndicator color={C.surface} />
            ) : (
              <Text style={s.btnText}>
                {connected ? "Disconnect" : "Connect to Device"}
              </Text>
            )}
          </TouchableOpacity>

          {connected && (
            <View style={s.connectedPill}>
              <Text style={s.connectedPillText}>✓ Connected — {ip}:81</Text>
            </View>
          )}
        </View>

        {/* ── Word Input Card ── */}
        <View style={s.card}>
          <View style={s.cardHeader}>
            <View style={s.cardHeaderDot} />
            <Text style={s.cardTitle}>Word to Display</Text>
          </View>

          <SectionLabel text="Enter a word" />
          <TextInput
            style={[s.input, s.inputWord]}
            placeholder="e.g. BEAUTIFUL"
            placeholderTextColor={C.grayMid}
            value={word}
            onChangeText={(t) => {
              setWord(t);
              if (started) handleReset();
            }}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!started}
          />

          {!started ? (
            <TouchableOpacity
              style={[s.btn, s.btnAmber]}
              onPress={handleStart}
              activeOpacity={0.85}
            >
              <Text style={s.btnTextDark}>▶ Start Session</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[s.btn, s.btnOutline]}
              onPress={handleReset}
              activeOpacity={0.85}
            >
              <Text style={s.btnTextOutline}>✕ Reset Session</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ── Active Display Card ── */}
        {started && currentLetter && (
          <View style={[s.card, s.cardActive]}>
            <View style={s.cardHeader}>
              <View style={[s.cardHeaderDot, { backgroundColor: C.amber }]} />
              <Text style={s.cardTitle}>Now Displaying</Text>
              <Text style={s.cardCounter}>
                {index + 1} / {letters.length}
              </Text>
            </View>

            {/* Letter strip */}
            <LetterStrip letters={letters} current={index} />

            <Divider />

            {/* Big letter */}
            <View style={s.bigLetterBox}>
              <Text style={s.bigLetter}>{currentLetter}</Text>
            </View>

            {/* Word label */}
            <Text style={s.wordLabel}>{word.trim().toUpperCase()}</Text>

            <Divider />

            {/* Braille preview */}
            <BrailleCell letter={currentLetter} />

            <Divider />

            {/* Hardware hint */}
            <View style={s.hintBox}>
              <Text style={s.hintText}>
                Use the physical device buttons to navigate ← →
              </Text>
            </View>
          </View>
        )}

        <View style={{ height: 48 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ── StyleSheet ────────────────────────────────────────────
const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.white },
  scroll: { paddingHorizontal: 20, paddingBottom: 40 },

  headerBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingTop: 56,
    paddingBottom: 16,
  },
  headerLeft: { flex: 1 },
  appName: { fontFamily: F.heading, fontSize: 22, color: C.navy },
  appSub: { fontFamily: F.body, fontSize: 12, color: C.gray, marginTop: 2 },

  accentBar: {
    height: 4,
    backgroundColor: C.amber,
    borderRadius: 99,
    marginBottom: 24,
  },

  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
  },
  badgeGreen: { backgroundColor: C.greenLight, borderColor: C.greenMid },
  badgeGray: { backgroundColor: C.grayLight, borderColor: C.grayMid },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  dotGreen: { backgroundColor: C.green },
  dotGray: { backgroundColor: C.grayMid },
  statusText: { fontFamily: F.bodyBold, fontSize: 12 },
  textGreen: { color: C.green },
  textGray: { color: C.gray },

  card: {
    backgroundColor: C.surface,
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: C.bgAlt,
    shadowColor: C.navy,
    shadowOpacity: 0.06,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 8,
    elevation: 2,
  },
  cardActive: { borderColor: C.navyMid, borderWidth: 1.5 },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
  },
  cardHeaderDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: C.navy,
  },
  cardTitle: { fontFamily: F.heading, fontSize: 16, color: C.navy, flex: 1 },
  cardCounter: { fontFamily: F.bodyBold, fontSize: 13, color: C.gray },

  sectionLabel: {
    fontFamily: F.bodyBold,
    fontSize: 12,
    color: C.gray,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: 8,
  },

  input: {
    backgroundColor: C.white,
    color: C.navy,
    fontFamily: F.body,
    fontSize: 15,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: C.bgAlt,
    marginBottom: 14,
    minHeight: 48,
  },
  inputWord: {
    fontFamily: F.mono,
    fontSize: 22,
    letterSpacing: 4,
    color: C.navy,
  },

  btn: {
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: "center",
    minHeight: 48,
    justifyContent: "center",
  },
  btnPrimary: { backgroundColor: C.navy },
  btnAmber: { backgroundColor: C.amber },
  btnDanger: {
    backgroundColor: C.redLight,
    borderWidth: 1.5,
    borderColor: C.redMid,
  },
  btnOutline: { borderWidth: 1.5, borderColor: C.grayMid },

  btnText: { fontFamily: F.bodyBold, fontSize: 14, color: C.surface },
  btnTextDark: { fontFamily: F.bodyBold, fontSize: 14, color: C.navy },
  btnTextOutline: { fontFamily: F.bodyBold, fontSize: 14, color: C.gray },

  connectedPill: {
    marginTop: 12,
    backgroundColor: C.greenLight,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: C.greenMid,
  },
  connectedPillText: { fontFamily: F.bodyBold, fontSize: 12, color: C.green },

  stripRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 4 },
  stripTile: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: C.grayLight,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: C.bgAlt,
  },
  stripTileActive: { backgroundColor: C.navy, borderColor: C.navy },
  stripTileDone: { backgroundColor: C.navyLight, borderColor: C.navyMid },
  stripLetter: { fontFamily: F.bodyBold, fontSize: 13, color: C.gray },
  stripLetterActive: { color: C.surface },
  stripLetterDone: { color: C.navy },

  bigLetterBox: { alignItems: "center", paddingVertical: 8 },
  bigLetter: {
    fontFamily: F.heading,
    fontSize: 140,
    color: C.navy,
    lineHeight: 160,
  },
  wordLabel: {
    fontFamily: F.mono,
    fontSize: 13,
    color: C.gray,
    textAlign: "center",
    letterSpacing: 3,
    marginTop: -8,
    marginBottom: 4,
  },

  divider: { height: 1, backgroundColor: C.bgAlt, marginVertical: 18 },

  brailleWrapper: { alignItems: "center" },
  brailleGrid: { flexDirection: "row", gap: 18, marginVertical: 16 },
  brailleCol: { gap: 14 },
  dot: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.dotEmpty },
  dotRaised: { backgroundColor: C.navy },
  monoText: { fontFamily: F.mono, fontSize: 13, color: C.gray, letterSpacing: 1 },

  hintBox: {
    backgroundColor: C.amberLight,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: C.amberMid,
  },
  hintText: {
    fontFamily: F.body,
    fontSize: 13,
    color: C.navy,
    textAlign: "center",
    lineHeight: 20,
  },
});