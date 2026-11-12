// mobile/components/MaintenanceBanner.tsx
// Teacher area: a bar just above the tab bar while maintenance mode is on
// (migration 26), with the admin's message. Teachers can still look at
// everything; new sessions and activity changes are paused, running sessions
// can finish. Hidden when maintenance is off.

import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { MAINTENANCE_DEFAULT_TEXT, useMaintenance } from "../lib/maintenance";
import { colors as C, fonts } from "../lib/theme";

export function MaintenanceBanner() {
  const m = useMaintenance();
  if (!m.on) return null;
  const text = m.message || MAINTENANCE_DEFAULT_TEXT;
  return (
    <View
      style={styles.wrap}
      accessible
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`Maintenance mode. ${text}`}
    >
      <Ionicons name="construct-outline" size={16} color={C.brown} />
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>Maintenance mode</Text>
        <Text style={styles.text} numberOfLines={3}>
          {text}
        </Text>
        {!!m.message && <Text style={styles.sub}>{MAINTENANCE_DEFAULT_TEXT}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: C.brownBg,
    borderTopWidth: 1.5,
    borderTopColor: C.amberSoft,
  },
  title: { fontFamily: fonts.heading, fontSize: 13, color: C.brown },
  text: { fontFamily: fonts.body, fontSize: 13, color: C.ink },
  sub: { fontFamily: fonts.body, fontSize: 11, color: C.brown, marginTop: 2 },
});
