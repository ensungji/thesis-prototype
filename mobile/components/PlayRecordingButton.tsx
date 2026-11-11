// mobile/components/PlayRecordingButton.tsx
// Plays a student's recording from the private "answers" bucket through a
// short-lived signed URL. Listening only: it never changes a grade.
// Used by the session screen (answers card, results) and the review screen.

import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { supabase } from "../lib/supabase";
import { colors as C } from "../lib/theme";

// A signed link to a recording works this long (the "answers" bucket is
// private; the storage policy lets a teacher sign only their own students')
export const RECORDING_URL_TTL_SEC = 60;

/**
 * The newest recording for one student + word: the last try in answer_attempts
 * (also when the word is locked as correct, so word_attempts keeps the older
 * recording). null when there's none, e.g. before migration 20.
 */
export async function latestRecordingPath(sessionWordId: string, studentId: string): Promise<string | null> {
  const { data } = await supabase
    .from("answer_attempts")
    .select("audio_path")
    .eq("session_word_id", sessionWordId)
    .eq("student_id", studentId)
    .not("audio_path", "is", null)
    .order("attempt_no", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.audio_path as string | undefined) ?? null;
}

/**
 * With resolvePath, the path is looked up when tapped (e.g. the newest try),
 * falling back to `path`. size "large" gives a 44 pt touch target.
 */
export function PlayRecordingButton({
  path,
  resolvePath,
  label = "recording",
  size = "small",
}: {
  path: string | null;
  resolvePath?: () => Promise<string | null>;
  label?: string;
  size?: "small" | "large";
}) {
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const playerRef = useRef<AudioPlayer | null>(null);
  const playable = !!path || !!resolvePath;
  const large = size === "large";

  useEffect(() => {
    return () => {
      playerRef.current?.remove();
      playerRef.current = null;
    };
  }, []);

  async function toggle() {
    if (!playable) return;
    if (playing && playerRef.current) {
      playerRef.current.pause();
      setPlaying(false);
      return;
    }
    setLoading(true);
    const target = (resolvePath ? await resolvePath().catch(() => null) : null) ?? path;
    const { data } = target
      ? await supabase.storage.from("answers").createSignedUrl(target, RECORDING_URL_TTL_SEC)
      : { data: null };
    setLoading(false);
    if (!data?.signedUrl) return;

    playerRef.current?.remove();
    const player = createAudioPlayer({ uri: data.signedUrl });
    playerRef.current = player;
    player.addListener("playbackStatusUpdate", (st) => {
      if (st.didJustFinish) setPlaying(false);
    });
    player.play();
    setPlaying(true);
  }

  return (
    <Pressable
      onPress={toggle}
      disabled={!playable || loading}
      hitSlop={8}
      style={({ pressed }) => [
        styles.btn,
        large && styles.btnLarge,
        !playable && { opacity: 0.3 },
        pressed && { opacity: 0.7 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={playing ? `Stop ${label}` : `Play ${label}`}
    >
      {loading ? (
        <ActivityIndicator size="small" color={C.navy} />
      ) : (
        <Ionicons name={playing ? "stop" : "play"} size={large ? 18 : 12} color={C.navy} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: C.blueWash,
    alignItems: "center",
    justifyContent: "center",
  },
  btnLarge: { width: 44, height: 44, borderRadius: 22 },
});
