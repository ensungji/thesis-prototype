// mobile/components/BrailleLoader.tsx
// Loading indicator that spells D → O → T → S in real braille patterns.
// Each letter transitions smoothly — dots raise and lower as the pattern changes.

import { useState, useEffect, useRef } from "react";
import { View, Text, Animated } from "react-native";
import { colors as C, fonts } from "../lib/theme";

// Braille dot index mapping (0–5):
//   0 = dot 1 (top-left)    3 = dot 4 (top-right)
//   1 = dot 2 (mid-left)    4 = dot 5 (mid-right)
//   2 = dot 3 (bot-left)    5 = dot 6 (bot-right)

const LETTERS = [
  { char: "D", raised: new Set([0, 3, 4]) },      // dots 1,4,5
  { char: "O", raised: new Set([0, 2, 4]) },      // dots 1,3,5
  { char: "T", raised: new Set([1, 2, 3, 4]) },   // dots 2,3,4,5
  { char: "S", raised: new Set([1, 2, 3]) },      // dots 2,3,4
];

const ROWS = [[0, 3], [1, 4], [2, 5]] as const;

interface BrailleLoaderProps {
  /** Dot diameter in px. Default 14. */
  size?: number;
  /** Dot color. Default amber. */
  color?: string;
  /** Show the current letter below the cell. Default false. */
  showLabel?: boolean;
}

export function BrailleLoader({
  size      = 14,
  color     = C.amber,
  showLabel = false,
}: BrailleLoaderProps) {
  const [letterIdx, setLetterIdx] = useState(0);

  const dotAnims = useRef(
    Array.from({ length: 6 }, (_, i) =>
      new Animated.Value(LETTERS[0].raised.has(i) ? 1 : 0)
    )
  ).current;

  // Cycle letters every 700ms
  useEffect(() => {
    const interval = setInterval(() => {
      setLetterIdx(prev => (prev + 1) % LETTERS.length);
    }, 700);
    return () => clearInterval(interval);
  }, []);

  // Animate dots to new pattern when letter changes
  useEffect(() => {
    const { raised } = LETTERS[letterIdx];
    Animated.parallel(
      dotAnims.map((anim, i) =>
        Animated.timing(anim, {
          toValue:  raised.has(i) ? 1 : 0,
          duration: 220,
          useNativeDriver: true,
        })
      )
    ).start();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [letterIdx]);

  const gap = Math.round(size * 0.55);

  return (
    <View style={{ alignItems: "center", gap: Math.round(size * 1.1) }}>
      {/* Braille cell */}
      <View style={{ gap, alignItems: "center" }}>
        {ROWS.map((row, r) => (
          <View key={r} style={{ flexDirection: "row", gap }}>
            {row.map(idx => {
              const scale = dotAnims[idx].interpolate({
                inputRange:  [0, 1],
                outputRange: [0.35, 1],
              });
              const opacity = dotAnims[idx].interpolate({
                inputRange:  [0, 1],
                outputRange: [0.18, 1],
              });
              return (
                <Animated.View
                  key={idx}
                  style={{
                    width:           size,
                    height:          size,
                    borderRadius:    size / 2,
                    backgroundColor: color,
                    transform:       [{ scale }],
                    opacity,
                  }}
                />
              );
            })}
          </View>
        ))}
      </View>

      {/* Optional letter label */}
      {showLabel && (
        <Text
          style={{
            fontFamily:    fonts.mono,
            fontSize:      Math.round(size * 0.9),
            color,
            opacity:       0.55,
            letterSpacing: 2,
          }}
        >
          {LETTERS[letterIdx].char}
        </Text>
      )}
    </View>
  );
}