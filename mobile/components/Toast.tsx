// mobile/components/Toast.tsx
// Lightweight animated toast — themed with app colors.
// variant="delete"  → red-accented delete confirmation
// variant="success" → amber/green success (default)

import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors as C, fonts } from "../lib/theme";

type Props = {
  message: string;
  /** Optional bold detail shown on a second line (e.g. the session name). */
  detail?: string;
  visible: boolean;
  variant?: "success" | "delete" | "warning";
  /** Auto-dismiss after this many ms. Defaults to 3500. */
  duration?: number;
  onDismiss: () => void;
};

export function Toast({
  message,
  detail,
  visible,
  variant = "success",
  duration = 3500,
  onDismiss,
}: Props) {
  const translateY = useRef(new Animated.Value(120)).current;
  const opacity    = useRef(new Animated.Value(0)).current;
  const progress   = useRef(new Animated.Value(1)).current;
  // Holds the auto-dismiss timer so we can clear it before starting a new one.
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!visible) return;

    // Cancel any in-flight dismiss timer before starting a fresh one.
    // This is what prevents rapid-fire toasts from being dismissed early.
    if (timerRef.current) clearTimeout(timerRef.current);

    progress.setValue(1);

    Animated.parallel([
      Animated.spring(translateY, {
        toValue: 0,
        useNativeDriver: true,
        tension: 55,
        friction: 9,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start();

    Animated.timing(progress, {
      toValue: 0,
      duration,
      useNativeDriver: false,
    }).start();

    timerRef.current = setTimeout(slideOut, duration);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  // Re-run (and reset the timer) whenever visible, message, or detail changes.
  // This handles rapid successive toasts where visible stays `true`.
  }, [visible, message, detail]);

  function slideOut() {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 120,
        duration: 260,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => {
      translateY.setValue(120);
      opacity.setValue(0);
      onDismiss();
    });
  }

  if (!visible) return null;

  const isDelete    = variant === "delete";
  const isWarning   = variant === "warning";
  const accentColor = isDelete ? C.red : isWarning ? C.amber : C.green;
  const iconName    = isDelete ? "trash" : isWarning ? "shield-checkmark" : "checkmark-circle";
  // Icon pill: a tinted wash of the accent colour
  const iconBg      = isDelete ? C.redBg : isWarning ? C.brownBg : C.greenBg;

  return (
    <Animated.View
      style={[styles.wrapper, { transform: [{ translateY }], opacity }]}
      pointerEvents="none"
    >
      <View style={styles.toast}>
        {/* Left accent stripe */}
        <View style={[styles.accentBar, { backgroundColor: accentColor }]} />

        {/* Icon pill */}
        <View style={[styles.iconWrap, { backgroundColor: iconBg }]}>
          <Ionicons name={iconName} size={18} color={accentColor} />
        </View>

        {/* Text */}
        <View style={styles.textBlock}>
          <Text style={styles.label}>{message}</Text>
          {detail ? (
            <Text style={styles.detail} numberOfLines={1}>
              {detail}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Draining progress bar */}
      <View style={styles.progressTrack}>
        <Animated.View
          style={[
            styles.progressBar,
            {
              backgroundColor: accentColor,
              width: progress.interpolate({
                inputRange: [0, 1],
                outputRange: ["0%", "100%"],
              }),
            },
          ]}
        />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: "absolute",
    bottom: 28,
    left: 16,
    right: 16,
    zIndex: 999,
    borderRadius: 16,
    overflow: "hidden",
    // White card with a navy-themed shadow — fits the app's card language
    backgroundColor: C.white,
    borderWidth: 1.5,
    borderColor: C.border,
    shadowColor: C.navy,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.14,
    shadowRadius: 16,
    elevation: 10,
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingRight: 16,
    paddingVertical: 14,
  },
  accentBar: {
    width: 4,
    alignSelf: "stretch",
    borderRadius: 2,
    marginLeft: 4,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  textBlock: {
    flex: 1,
    gap: 2,
  },
  label: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: C.muted,
    lineHeight: 16,
  },
  detail: {
    fontFamily: fonts.heading,
    fontSize: 15,
    color: C.navy,
    lineHeight: 20,
  },
  progressTrack: {
    height: 3,
    backgroundColor: C.border,
    width: "100%",
  },
  progressBar: {
    height: 3,
  },
});
