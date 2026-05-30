// mobile/app/(teacher)/_layout.tsx
// Tab navigator for the authenticated teacher area.
// All four tabs are defined here; screens that aren't built yet show a placeholder.
//
// TODO: add auth guard here once AsyncStorage APK is ready:
//   useEffect(() => {
//     supabase.auth.getSession().then(({ data: { session } }) => {
//       if (!session) router.replace("/");
//     });
//   }, []);

import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors as C, fonts } from "../../lib/theme";

export default function TeacherLayout() {
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: C.navy,
        tabBarInactiveTintColor: C.muted,
        tabBarStyle: {
          backgroundColor: C.white,
          borderTopColor: C.border,
          borderTopWidth: 1.5,
          height: 62 + insets.bottom,
          paddingBottom: 10 + insets.bottom,
          paddingTop: 6,
        },
        tabBarLabelStyle: {
          fontFamily: fonts.heading,
          fontSize: 11,
        },
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{
          title: "Dashboard",
          tabBarIcon: ({ color, size }) => <Ionicons name="home" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="students"
        options={{
          title: "Students",
          tabBarIcon: ({ color, size }) => <Ionicons name="people" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="sessions"
        options={{
          title: "Sessions",
          tabBarIcon: ({ color, size }) => <Ionicons name="book" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="analytics"
        options={{
          title: "Analytics",
          tabBarIcon: ({ color, size }) => <Ionicons name="bar-chart" color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}