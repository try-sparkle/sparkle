// The rolling summary of concierge turns that have fallen OUT of the verbatim continuity window.
//
// Kept in its own persisted key rather than inside `conciergeThreadStore` on purpose: that store's
// `partialize` is a carefully-scoped allowlist over message KINDS, and folding a derived string into
// it would mean a bug in the summariser could corrupt the visible thread on the way to disk. These
// are two different assets with two different failure modes — the thread is the record, this is a
// lossy derivative of it that is always safe to throw away and regenerate.
import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Regenerate only once this many messages have fallen out of the window since the last summary.
 *
 *  This is the whole cost control. Summarising per turn would put a second model call behind every
 *  message the founder sends; summarising per N turns puts one behind every Nth. 20 is ~10
 *  exchanges — one window's worth — so each summary covers a contiguous, non-overlapping slice. */
export const SUMMARY_REGEN_EVERY = 20;

/** Hard cap on the stored summary. `buildContinuityBlock` clips again on the way into the prompt;
 *  this bounds what reaches localStorage, whose quota is shared with the thread itself. */
export const SUMMARY_MAX_LEN = 4_000;

export interface ConciergeThreadSummaryState {
  /** The summary prose, or "" when none has been generated yet. */
  text: string;
  /** The id of the NEWEST message this summary covers. Null when there is no summary.
   *
   *  An id rather than a count or a timestamp: counts drift when the thread is trimmed from the
   *  front, and two messages can share a millisecond. The id is the only thing that answers "where
   *  did the last summary stop" after an eviction. */
  throughMessageId: string | null;
  generatedAt: number;
  set(next: { text: string; throughMessageId: string }): void;
  clear(): void;
}

export const useConciergeThreadSummaryStore = create<ConciergeThreadSummaryState>()(
  persist(
    (set) => ({
      text: "",
      throughMessageId: null,
      generatedAt: 0,
      set: ({ text, throughMessageId }) =>
        set({
          text: text.slice(0, SUMMARY_MAX_LEN),
          throughMessageId,
          generatedAt: Date.now(),
        }),
      // Paired with `clearConciergeThread` / the identity reset: a summary that outlived the
      // conversation it summarises would hand a new signed-in human the previous one's context,
      // which is the invisible variant of the amnesia bug and strictly worse than the visible one.
      clear: () => set({ text: "", throughMessageId: null, generatedAt: 0 }),
    }),
    {
      name: "sparkle-concierge-thread-summary",
      partialize: (s) => ({
        text: s.text,
        throughMessageId: s.throughMessageId,
        generatedAt: s.generatedAt,
      }),
    },
  ),
);
