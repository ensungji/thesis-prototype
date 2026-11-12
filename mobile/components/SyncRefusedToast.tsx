// mobile/components/SyncRefusedToast.tsx
// Shows a warning on any screen when the server refuses a change that was
// waiting in the offline outbox (e.g. a hand grade on a voice answer while the
// session is still running: the grading lock of migration 22). The change has
// been dropped; this tells the teacher it didn't save and why.

import { useEffect, useState } from "react";
import { subscribeRefused, type RefusedChange } from "../lib/outbox";
import { Toast } from "./Toast";

function describe(r: RefusedChange): string {
  if (r.code === "DT001") return "This word was already answered correctly by voice.";
  if (r.code === "DT002") return "Maintenance mode is on. Try again when it ends.";
  return r.message || "The server refused it.";
}

export function SyncRefusedToast() {
  const [refused, setRefused] = useState<RefusedChange | null>(null);

  useEffect(() => subscribeRefused(setRefused), []);

  return (
    <Toast
      message={refused?.table === "word_attempts" ? "A grade wasn't saved" : "A change wasn't saved"}
      detail={refused ? describe(refused) : undefined}
      visible={!!refused}
      variant="warning"
      duration={7000}
      onDismiss={() => setRefused(null)}
    />
  );
}
