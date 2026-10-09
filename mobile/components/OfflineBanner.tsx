// mobile/components/OfflineBanner.tsx
// Thin bar at the top of every screen:
//   - red   "Offline · N changes waiting"   while Supabase can't be reached
//   - green "Back online · syncing N…"      after reconnecting (hides when done)
// Doesn't block touches (pointerEvents="none").

import { useEffect, useRef, useState } from "react";
import { Animated, Text, View, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useOnline } from "../lib/network";
import { usePendingCount } from "../lib/outbox";
import { startAppLogging } from "../lib/logger";
import { colors as C, fonts } from "../lib/theme";

export function OfflineBanner() {
  const online = useOnline();
  const pending = usePendingCount();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<"hidden" | "offline" | "back">("hidden");
  const wasOffline = useRef(false);
  const slide = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    startAppLogging(); // records how long the phone was offline
  }, []);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    if (!online) {
      wasOffline.current = true;
      setMode("offline");
    } else if (wasOffline.current || pending > 0) {
      wasOffline.current = false;
      setMode("back");
      if (pending === 0) t = setTimeout(() => setMode("hidden"), 2500);
    }
    return () => {
      if (t) clearTimeout(t);
    };
  }, [online, pending]);

  useEffect(() => {
    Animated.timing(slide, {
      toValue: mode === "hidden" ? 0 : 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [mode, slide]);

  const offline = mode === "offline";
  const plural = pending === 1 ? "change" : "changes";
  const detail = offline
    ? pending > 0
      ? `· ${pending} ${plural} waiting to sync`
      : "· Devices paused · changes will sync later"
    : pending > 0
      ? `· Syncing ${pending} ${plural}…`
      : "· All changes saved";

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.wrap,
        {
          paddingTop: insets.top + 6,
          backgroundColor: offline ? C.red : C.green,
          opacity: slide,
          transform: [
            { translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [-80, 0] }) },
          ],
        },
      ]}
      accessibilityLiveRegion="polite"
      accessibilityLabel={offline ? "You are offline" : "Back online"}
    >
      <View style={styles.row}>
        <Ionicons
          name={offline ? "cloud-offline-outline" : "cloud-done-outline"}
          size={15}
          color={C.white}
        />
        <Text style={styles.title}>{offline ? "Offline" : "Back online"}</Text>
        <Text style={styles.detail} numberOfLines={1}>
          {detail}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1000,
    elevation: 10,
    paddingBottom: 8,
    paddingHorizontal: 16,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  title: { fontFamily: fonts.heading, fontSize: 13, color: C.white },
  detail: { fontFamily: fonts.body, fontSize: 12, color: C.white, flexShrink: 1, opacity: 0.9 },
});