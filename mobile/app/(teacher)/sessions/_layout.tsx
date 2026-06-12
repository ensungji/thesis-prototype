// mobile/app/(teacher)/sessions/_layout.tsx
// Stack navigator for the sessions section — prevents [id] showing as a tab.

import { Stack } from "expo-router";

export default function SessionsLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}