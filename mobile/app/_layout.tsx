import { useEffect, useRef, useCallback } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Stack, useRouter } from "expo-router";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { useFonts } from "expo-font";
import {
  Nunito_700Bold,
  Nunito_600SemiBold,
} from "@expo-google-fonts/nunito";
import {
  AtkinsonHyperlegible_400Regular,
  AtkinsonHyperlegible_700Bold,
} from "@expo-google-fonts/atkinson-hyperlegible";
import {
  IBMPlexMono_400Regular,
} from "@expo-google-fonts/ibm-plex-mono";
import { Alert, View, ActivityIndicator } from "react-native";
import { supabase } from "../lib/supabase";
import { getDeviceId } from "../lib/device-id";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { OfflineBanner } from "../components/OfflineBanner";
export default function RootLayout() {
  const router = useRouter();
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [fontsLoaded] = useFonts({
    Nunito_700Bold,
    Nunito_600SemiBold,
    AtkinsonHyperlegible_400Regular,
    AtkinsonHyperlegible_700Bold,
    IBMPlexMono_400Regular,
  });

  // ── Realtime boot-out: detect when another device overrides this session ──
  //
  // Subscribes to Postgres changes on the user's profiles row.
  // If active_device_id changes and no longer matches this device's ID,
  // we immediately:
  //   1. Send clearDevices commands to de-energize all connected solenoids
  //   2. Sign the user out
  //   3. Route back to the login screen
  //
  // This prevents two devices from simultaneously sending WebSocket commands
  // to the same set of Braille hardware.

  const clearAllDevicesForUser = useCallback(async (userId: string) => {
    // Fetch all students with connected devices belonging to this teacher
    const { data: students } = await supabase
      .from("students")
      .select("id, devices(id, status)")
      .eq("teacher_id", userId);

    if (!students) return;

    const connectedDeviceIds: string[] = [];
    for (const student of students) {
      const devices = (student as any).devices;
      if (Array.isArray(devices)) {
        for (const d of devices) {
          if (d.status === "connected") connectedDeviceIds.push(d.id);
        }
      }
    }

    if (connectedDeviceIds.length === 0) return;

    // Send empty display commands to de-energize all solenoids immediately
    const commands = connectedDeviceIds.map((device_id) => ({
      device_id,
      session_id: null,
      command_type: "display_chunk",
      payload: { word: "", chunk: "", chunk_index: 0, total_chunks: 1 },
    }));
    await supabase.from("device_commands").insert(commands);
  }, []);

  useEffect(() => {
    let mounted = true;

    async function setupRealtimeGuard() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user || !mounted) return;

      const userId = session.user.id;
      const localDeviceId = await getDeviceId();

      // Clean up any previous channel
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }

      const channel = supabase
        .channel(`profile-override:${userId}`)
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "profiles",
            filter: `id=eq.${userId}`,
          },
          async (payload) => {
            const newDeviceId = payload.new?.active_device_id;

            // If the active_device_id changed and is no longer ours, we've been kicked
            if (newDeviceId && newDeviceId !== localDeviceId) {
              console.warn(
                "[BootOut] Another device took over. De-energizing hardware and signing out."
              );

              // 1. Immediately clear all connected Braille devices
              await clearAllDevicesForUser(userId);

              // 2. Sign out (triggers auth listeners in (teacher)/_layout)
              await supabase.auth.signOut();

              // 3. Explicit navigation to login in case auth listener doesn't fire fast enough
              if (mounted) {
                Alert.alert(
                  "Session Ended",
                  "Another device has taken over this account. You have been signed out and all devices have been de-energized.",
                  [{ text: "OK" }]
                );
                router.replace("/login" as any);
              }
            }
          }
        )
        .subscribe();

      channelRef.current = channel;
    }

    setupRealtimeGuard();

    // Re-run when auth state changes (e.g. sign-in → subscribe, sign-out → clean up)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event) => {
        if (event === "SIGNED_IN") {
          setupRealtimeGuard();
        } else if (event === "SIGNED_OUT") {
          if (channelRef.current) {
            supabase.removeChannel(channelRef.current);
            channelRef.current = null;
          }
        }
      }
    );

    return () => {
      mounted = false;
      subscription.unsubscribe();
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [router, clearAllDevicesForUser]);

  if (!fontsLoaded) {
    return (
      <GestureHandlerRootView style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator size="large" color="#0C447C" />
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary>
        <Stack screenOptions={{ headerShown: false }} />
      <OfflineBanner />
      </ErrorBoundary>
    </GestureHandlerRootView>
  );
}