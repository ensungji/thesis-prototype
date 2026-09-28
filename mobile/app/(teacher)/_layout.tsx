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
        listeners={() => ({
          tabPress: (e) => {
            // FIX (nav-audit): Without this listener, pressing the Students tab
            // from another tab lands on whatever screen is at the top of the
            // students stack (e.g. a student detail), not the list root.
            // e.preventDefault() suppresses that default jump-to-current-top
            // behaviour, and router.navigate() resets the stack to the index.
            // router.navigate (Expo Router) is used — NOT navigation.navigate
            // (raw React Navigation) — to keep Expo Router's URL state in sync.
            e.preventDefault();
            router.navigate("/(teacher)/students");
          },
        })}
      />
      <Tabs.Screen
        name="sessions"
        options={{
          title: "Sessions",
          tabBarIcon: ({ color, size }) => <Ionicons name="book" color={color} size={size} />,
        }}
        listeners={() => ({
          tabPress: (e) => {
            // FIX (prev-session): Without this listener, pressing the Sessions
            // tab from another tab lands on sessions/[id] if that was previously
            // pushed onto the stack (e.g. via a Recent Sessions deep link from
            // the dashboard), hiding the session list and the Add Session button.
            // router.navigate (Expo Router) is used — NOT navigation.navigate
            // (raw React Navigation) — to prevent state divergence that caused
            // the "Word Bank → Sessions → black screen" crash.
            e.preventDefault();
            router.navigate("/(teacher)/sessions");
          },
        })}
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
        listeners={() => ({
          tabPress: (e) => {
            // FIX (nav-audit): Without this listener, pressing the Word Bank
            // tab from another tab lands on wordbank/new if the user previously
            // tapped "+" inside the word bank, instead of returning to the
            // word bank list. Same fix pattern as Students and Sessions tabs.
            e.preventDefault();
            router.navigate("/(teacher)/wordbank");
          },
        })}
      />
    </Tabs>
  );
}