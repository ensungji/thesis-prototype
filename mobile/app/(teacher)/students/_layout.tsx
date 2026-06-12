// mobile/app/(teacher)/students/_layout.tsx
// Tells Expo Router to treat the students folder as a Stack (not more tabs).
// Without this, [id].tsx and index.tsx show up as extra tab bar items.

import { Stack } from "expo-router";

export default function StudentsLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
