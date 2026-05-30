// mobile/lib/theme.ts
// Design tokens — single source of truth for every screen.
// Import from here instead of defining colors inline.

export const colors = {
  // Primary
  navy: "#0C447C",
  navyLight: "#1A5FA0",

  // Accent — international accessibility amber
  amber: "#EF9F27",
  amberSoft: "#FAC775",

  // Text
  ink: "#1A1E2A",
  muted: "#8A8A86",

  // Backgrounds
  bg: "#F8F9FA",
  white: "#FFFFFF",

  // Tinted washes
  blueWash: "#E6F1FB",
  brownBg: "#FAEEDA",
  border: "#E8E8E4",

  // Status
  green: "#3B6D11",
  greenBg: "#EAF3DE",
  red: "#A32D2D",
  redBg: "#F9E4E4",

  // Labels / mono text
  brown: "#5C3800",
} as const;

// Exact font family strings loaded in _layout.tsx.
// Only add entries here if you also load the weight in _layout.tsx.
export const fonts = {
  heading: "Nunito_700Bold",           // section heads, step titles, button labels
  headingSemi: "Nunito_600SemiBold",   // lighter headers
  body: "AtkinsonHyperlegible_400Regular",  // paragraphs, descriptions
  bodyBold: "AtkinsonHyperlegible_700Bold", // emphasis in body copy
  mono: "IBMPlexMono_400Regular",      // labels, badges, braille notation
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 100,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

// Minimum touch target (WCAG 2.1 — this app targets low-vision users).
export const MIN_TOUCH = 48;