// mobile/components/Countdown.tsx
// A countdown that re-renders ONLY itself. The session screen owns the timing
// (a deadline, not a tick count) and this component just reads it a few times
// a second, so a 4,000-line screen no longer re-renders every second.

import { useEffect, useState, type ReactNode } from "react";

type Props = {
  /** Milliseconds left right now (read on every tick). */
  getLeftMs: () => number;
  /** Renders the countdown; `seconds` is rounded up, like the old timer. */
  children: (seconds: number) => ReactNode;
  /** How often to re-read the time. */
  tickMs?: number;
};

const toSeconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));

export function Countdown({ getLeftMs, children, tickMs = 250 }: Props) {
  const [seconds, setSeconds] = useState(() => toSeconds(getLeftMs()));

  useEffect(() => {
    const read = () => setSeconds(toSeconds(getLeftMs())); // same value → no re-render
    read();
    const t = setInterval(read, tickMs);
    return () => clearInterval(t);
  }, [getLeftMs, tickMs]);

  return <>{children(seconds)}</>;
}
