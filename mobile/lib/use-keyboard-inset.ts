// mobile/lib/use-keyboard-inset.ts
// Keeps a text field above the on-screen keyboard inside a ScrollView.
//
// Why not KeyboardAvoidingView: Expo SDK 54 runs Android edge-to-edge, where
// softwareKeyboardLayoutMode "resize" usually doesn't shrink the window, and
// KeyboardAvoidingView compares its frame relative to its PARENT with the
// keyboard's position on the SCREEN, so under a header it needs a hand-tuned
// offset per screen. Here both are measured in window coordinates:
//
//   overlap = (bottom of the container on screen) − (top of the keyboard)
//
// The container gets that much bottom padding (the ScrollView inside it
// shrinks), then the focused field is scrolled up until it sits 16 px above
// the keyboard. If the phone did resize the window, the overlap is 0 and only
// the scrolling happens. Works the same on iOS (keyboardWillShow).
//
// Usage:
//   const kb = useKeyboardInset();
//   <View ref={kb.containerRef} style={{ flex: 1, paddingBottom: kb.inset }}>
//     <ScrollView ref={kb.scrollRef} onScroll={kb.onScroll} scrollEventThrottle={16}>
//       <View ref={rowRef}>
//         <TextInput onFocus={() => kb.reveal(rowRef.current)} onBlur={() => kb.reveal(null)} />

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Keyboard,
  Platform,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
  type View,
} from "react-native";

const GAP = 16; // space between the field and the keyboard

type Measurable = Pick<View, "measureInWindow">;

export function useKeyboardInset() {
  const containerRef = useRef<View>(null);
  const scrollRef = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  const keyboardTop = useRef<number | null>(null); // window y of the keyboard's top edge; null = hidden
  const target = useRef<Measurable | null>(null);
  const [inset, setInset] = useState(0);

  /** Scroll so `view` (the focused field, or the row holding it) is above the keyboard. */
  const reveal = useCallback((view: Measurable | null) => {
    target.current = view;
    const top = keyboardTop.current;
    if (!view || top == null) return; // keyboard not up yet: the show handler calls this again
    view.measureInWindow((_x, y, _w, h) => {
      const below = y + h - (top - GAP);
      if (below > 0) scrollRef.current?.scrollTo({ y: scrollY.current + below, animated: true });
    });
  }, []);

  useEffect(() => {
    const ios = Platform.OS === "ios";
    const show = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", (e) => {
      const top = e.endCoordinates.screenY;
      keyboardTop.current = top;
      const node = containerRef.current;
      if (!node) return;
      node.measureInWindow((_x, y, _w, h) => {
        setInset(Math.max(0, Math.round(y + h - top)));
        // after the ScrollView has shrunk (iOS: after the keyboard animation)
        setTimeout(() => reveal(target.current), ios ? 280 : 60);
      });
    });
    const hide = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => {
      keyboardTop.current = null; // the field may stay focused: shown again → revealed again
      setInset(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [reveal]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollY.current = e.nativeEvent.contentOffset.y;
  }, []);

  return { containerRef, scrollRef, onScroll, inset, reveal };
}
