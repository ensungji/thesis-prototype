// mobile/app/(teacher)/_layout.tsx
// Tab navigator for the authenticated teacher area.
// Auth guard: redirects to login if no active session.

import { useEffect } from "react";
import { Tabs, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { supabase } from "../../lib/supabase";
import { colors as C, fonts } from "../../lib/theme";

export default function TeacherLayout() {
  const insets = useSafeAreaInsets();
  const router  = useRouter();

  // Auth guard — redirect to login if no active session
  useEffect(() => {
    // Check on mount
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) router.replace("/");
    });

    // Listen for sign-out / session expiry
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (event === "SIGNED_OUT" || !session) {
          router.replace("/");
        }
      }
    );

    return () => subscription.unsubscribe();
  }, [router]);

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
      <Tabs.Screen
        name="wordbank"
        options={{
          title: "Word Bank",
          tabBarIcon: ({ color, size }) => <Ionicons name="bookmarks" color={color} size={size} />,
        }}
      />
      {/* Sub-screens hidden from tab bar */}
      <Tabs.Screen name="wordbank/new" options={{ href: null }} />
    </Tabs>
  );
}