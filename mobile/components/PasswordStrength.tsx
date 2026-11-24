// mobile/components/PasswordStrength.tsx
// Password strength meter, shared by admin Reset Password and the teacher
// Register screen (same rules, same look: 3 bars + label).
//   empty → nothing · < 8 → Too short · upper + digit + symbol → Strong ·
//   upper or digit → Medium · otherwise Weak

import { View, Text, StyleSheet } from "react-native";
import { colors as C, fonts } from "../lib/theme";

export function getStrength(pw: string): { level: 0 | 1 | 2 | 3; label: string; color: string } {
  if (pw.length === 0) return { level: 0, label: "", color: C.border };
  if (pw.length < 8)   return { level: 1, label: "Too short", color: C.red };
  const strong = /[A-Z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw);
  const medium = /[A-Z]/.test(pw) || /[0-9]/.test(pw);
  if (strong) return { level: 3, label: "Strong", color: C.green };
  if (medium)  return { level: 2, label: "Medium", color: "#F59E0B" };
  return { level: 1, label: "Weak", color: C.red };
}

/** The bar under a password field. Renders nothing while the field is empty. */
export function PasswordStrengthMeter({ password }: { password: string }) {
  if (password.length === 0) return null;
  const strength = getStrength(password);
  return (
    <View
      style={styles.strengthWrap}
      accessible
      accessibilityLabel={`Password strength: ${strength.label}`}
    >
      <View style={styles.strengthBar}>
        {[1, 2, 3].map((seg) => (
          <View
            key={seg}
            style={[
              styles.strengthSeg,
              { backgroundColor: strength.level >= seg ? strength.color : C.border },
            ]}
          />
        ))}
      </View>
      <Text style={[styles.strengthLabel, { color: strength.color }]}>{strength.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  strengthWrap:  { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 2 },
  strengthBar:   { flexDirection: "row", gap: 5, flex: 1 },
  strengthSeg:   { flex: 1, height: 4, borderRadius: 2 },
  strengthLabel: { fontFamily: fonts.mono, fontSize: 10 },
});
