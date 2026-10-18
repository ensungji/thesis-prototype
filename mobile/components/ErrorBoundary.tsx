// mobile/components/ErrorBoundary.tsx
// Catches uncaught render errors anywhere in the child tree.
// Without this, any thrown error during render = white/black screen with no
// recovery path. This component shows a styled fallback card instead.
//
// Usage: Wrap the root <Stack> in app/_layout.tsx with <ErrorBoundary>.
// React requires class components for error boundaries (no hooks equivalent).

import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

type Props = { children: React.ReactNode };
type State = { hasError: boolean; message: string };

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: unknown): State {
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred.";
    return { hasError: true, message };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    // In production you'd send to a crash-reporting service here.
    console.error("[ErrorBoundary] Uncaught render error:", error, info);
  }

  recover = () => {
    this.setState({ hasError: false, message: "" });
  };

  goHome = () => {
    this.setState({ hasError: false, message: "" });
    // Navigate to a known-good route. router is a singleton in Expo Router.
    router.navigate("/(teacher)/dashboard");
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <SafeAreaView style={s.safe}>
        <View style={s.card}>
          <View style={s.iconWrap}>
            <Ionicons name="warning-outline" size={36} color="#B45309" />
          </View>

          <Text style={s.title}>Something went wrong</Text>
          <Text style={s.body}>
            An unexpected error occurred. Your session data is safe — tap below
            to recover.
          </Text>

          {/* Error detail — only visible in dev builds */}
          {__DEV__ && (
            <View style={s.devBox}>
              <Text style={s.devText} numberOfLines={6}>
                {this.state.message}
              </Text>
            </View>
          )}

          <Pressable
            onPress={this.recover}
            style={({ pressed }) => [s.btn, s.btnPrimary, pressed && { opacity: 0.8 }]}
          >
            <Ionicons name="refresh" size={18} color="#1A1200" />
            <Text style={s.btnPrimaryText}>Try Again</Text>
          </Pressable>

          <Pressable
            onPress={this.goHome}
            style={({ pressed }) => [s.btn, s.btnSecondary, pressed && { opacity: 0.7 }]}
          >
            <Ionicons name="home-outline" size={18} color="#0C447C" />
            <Text style={s.btnSecondaryText}>Go to Dashboard</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }
}

const s = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#F4F6FB",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    padding: 28,
    alignItems: "center",
    gap: 12,
    borderWidth: 1.5,
    borderColor: "#E2E8F0",
    shadowColor: "#0C447C",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.10,
    shadowRadius: 16,
    elevation: 6,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 18,
    backgroundColor: "#FEF3C7",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  title: {
    fontFamily: "Nunito_700Bold",
    fontSize: 22,
    color: "#0C447C",
    textAlign: "center",
  },
  body: {
    fontFamily: "AtkinsonHyperlegible_400Regular",
    fontSize: 14,
    color: "#64748B",
    textAlign: "center",
    lineHeight: 22,
  },
  devBox: {
    width: "100%",
    backgroundColor: "#FEF2F2",
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: "#FECACA",
    marginTop: 4,
  },
  devText: {
    fontFamily: "IBMPlexMono_400Regular",
    fontSize: 11,
    color: "#DC2626",
    lineHeight: 16,
  },
  btn: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 14,
    paddingVertical: 14,
    marginTop: 4,
  },
  btnPrimary: { backgroundColor: "#F5B800" },
  btnPrimaryText: { fontFamily: "Nunito_700Bold", fontSize: 16, color: "#1A1200" },
  btnSecondary: {
    backgroundColor: "#EFF6FF",
    borderWidth: 1.5,
    borderColor: "#BFDBFE",
  },
  btnSecondaryText: { fontFamily: "Nunito_700Bold", fontSize: 16, color: "#0C447C" },
});
