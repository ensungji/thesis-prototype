// mobile/components/BrailleCell.tsx
// The app's visual motif — six dots in the standard braille cell arrangement.
// Used for on-screen letter previews and as decorative branding.
//
// Dot numbering matches the physical device:
//   1  4
//   2  5
//   3  6

import { View } from "react-native";
import { colors } from "../lib/theme";

interface BrailleCellProps {
  /** Which dots (1–6) are raised. e.g. [1, 2, 5] = letter H. */
  pattern: number[];
  /** Diameter of each dot in px. Default 12. */
  size?: number;
  /** Color of raised dots. Default amber. */
  color?: string;
  /** Color of lowered (empty) dots. Default semi-transparent amber. */
  emptyColor?: string;
}

const LAYOUT = [
  [1, 4],
  [2, 5],
  [3, 6],
] as const;

export function BrailleCell({
  pattern,
  size = 12,
  color = colors.amber,
  emptyColor = "rgba(239,159,39,0.22)",
}: BrailleCellProps) {
  const gap = size * 0.4;

  return (
    <View accessible={false} style={{ gap }}>
      {LAYOUT.map((row, r) => (
        <View key={r} style={{ flexDirection: "row", gap }}>
          {row.map((n) => (
            <View
              key={n}
              style={{
                width: size,
                height: size,
                borderRadius: size / 2,
                backgroundColor: pattern.includes(n) ? color : emptyColor,
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}