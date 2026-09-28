// mobile/lib/wordbank-toast.ts
// Tiny module-level event bus for cross-screen word bank toast coordination.
//
// Why not React context? The only producer is new.tsx (which unmounts before
// any React tree can receive context updates). A module singleton survives
// screen unmounts and lets index.tsx subscribe and display toasts on behalf
// of new.tsx.

export type WordBankToastEvent = {
  type: "added" | "deleted";
  word: string;
};

type Listener = (event: WordBankToastEvent) => void;

let _listener: Listener | null = null;

export const wordbankToastBus = {
  /** Register the single active listener (call in index.tsx useEffect). */
  on(cb: Listener) {
    _listener = cb;
  },
  /** Unregister on unmount. */
  off() {
    _listener = null;
  },
  /** Emit from anywhere — new.tsx calls this before router.back(). */
  emit(event: WordBankToastEvent) {
    _listener?.(event);
  },
};
