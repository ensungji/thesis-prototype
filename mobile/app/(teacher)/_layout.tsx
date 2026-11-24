// mobile/app/(teacher)/_layout.tsx
// Tab navigator for the authenticated teacher area.
// Auth guard: redirects to the welcome screen if no active session; an admin
// is sent to /admin (lib/route-for-session), a deactivated user is signed out.
// Maintenance mode (migration 26): a banner sits just above the tab bar on
// every teacher screen while it's on.

import { useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { Tabs, useRouter } from "expo-router";
import { BottomTabBar } from "@react-navigation/bottom-tabs";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { supabase } from "../../lib/supabase";
import { colors as C, fonts } from "../../lib/theme";
import { MaintenanceBanner } from "../../components/MaintenanceBanner";
import { ADMIN_HOME, rememberedRole, routeForSession } from "../../lib/route-for-session";

export default function TeacherLayout() {
  const insets = useSafeAreaInsets();
  const router  = useRouter();
  // Covers the tabs until we know this isn't an admin (no flash of teacher
  // screens). Offline with nothing known: shown, as before.
  const [checked, setChecked] = useState(false);

  // Role guard: admins never stay in the teacher screens
  useEffect(() => {
    let active = true;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.replace("/");
        return;
      }
      // Fast path: the role this phone saw last time
      if ((await rememberedRole(session.user.id)) === "admin") {
        router.replace(ADMIN_HOME as any);
        return;
      }
      // Then the server: admin → /admin; deactivated → signed out (the
      // listener below goes to "/"); offline → stay (never signs out)
      const { route, reason } = await routeForSession();
      if (!active) return;
      if (route === ADMIN_HOME) {
        router.replace(ADMIN_HOME as any);
        return;
      }
      if (reason !== "inactive" && reason !== "no-session") setChecked(true);
    })().catch(() => active && setChecked(true));
    return () => {
      active = false;
    };
  }, [router]);

  // Auth guard — back to the welcome screen on sign-out / session expiry
  useEffect(() => {

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
    <>
    <Tabs
      tabBar={(props) => (
        <>
          <MaintenanceBanner />
          <BottomTabBar {...props} />
        </>
      )}
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
    {!checked && <View style={[StyleSheet.absoluteFill, { backgroundColor: C.bg }]} pointerEvents="auto" />}
    </>
  );
}