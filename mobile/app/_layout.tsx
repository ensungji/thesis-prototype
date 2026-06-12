import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Stack } from "expo-router";
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
import { View, ActivityIndicator } from "react-native";

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Nunito_700Bold,
    Nunito_600SemiBold,
    AtkinsonHyperlegible_400Regular,
    AtkinsonHyperlegible_700Bold,
    IBMPlexMono_400Regular,
  });

  if (!fontsLoaded) {
    return (
      <GestureHandlerRootView style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator size="large" color="#0C447C" />
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false }} />
    </GestureHandlerRootView>
  );
}