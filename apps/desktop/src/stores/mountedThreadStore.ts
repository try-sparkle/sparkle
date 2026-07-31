// mountedThreadStore — the mounted concierge pane's view of ONE build agent's own conversation.
//
// WHY A SEPARATE STORE, AND WHY UNMOUNT IS FREE BECAUSE OF IT.
// `stores/conciergeThreadStore` is untouched by this feature: no new `ConciergeMessage` kind, no new
// persisted arm, no write of any sort. That is the whole implementation of "unmount restores the
// concierge conversation intact" — the concierge conversation is never disturbed in the first place,
// so there is nothing to restore and no restore path that can be wrong. A mode flag inside that
// store would have made the two conversations share a lifecycle and put the founder's Sparkle
// history one bug away from being clobbered by a transcript read.
//
// NOT PERSISTED, deliberately, and this is the opposite of the concierge thread's choice. This is a
// PROJECTION OF DISK — the JSONL on disk is the source of truth and it outlives any process. Caching
// it to localStorage would (a) duplicate megabytes the filesystem already holds, and (b) go STALE in
// the one way that matters: everything the founder typed straight into the agent's terminal while
// the pane was unmounted would be missing from the cache but present on disk. Re-deriving on mount
// picks that up for free. What is kept in memory across an unmount is only a paint-instantly
// snapshot; a refresh always follows.
//
// KEYED BY agentId because the founder mounts, unmounts and re-mounts across a fleet, and each
// agent's scroll position and page depth are its own.
import { create } from "zustand";

import type { TranscriptCursor, TranscriptEntry } from "../services/agentTranscript";
import { mergeEntries } from "../services/agentTranscript";

/** How many entries one agent's thread may hold in memory.
 *
 *  Generous, because paging back is the whole point and a cap that bites during ordinary scrolling
 *  would fight the feature — 600 is ~15 pages. It exists to bound a pane left mounted for hours on a
 *  working agent, where the live tail appends indefinitely. Unlike the concierge thread's cap this
 *  loses nothing: the transcript is on disk and the dropped span pages back in. */
export const MOUNTED_THREAD_MAX = 600;

/** One agent's loaded slice of transcript, plus where to read next in each direction. */
export interface MountedThread {
  /** Renderable entries, OLDEST-FIRST, already through both filter layers. */
  entries: TranscriptEntry[];
  /** Cursor for the NEXT backwards page. `null` = we have reached the start of history. */
  next: TranscriptCursor | null;
  hasMore: boolean;
  /** A first page is in flight — the pane shows a quiet placeholder rather than an empty thread,
   *  which would read as "this agent has said nothing". */
  loading: boolean;
  /** A backwards page is in flight (scroll-to-top). Distinct from `loading` so the top spinner and
   *  the first-load placeholder cannot both claim the column. */
  paging: boolean;
  /** The live-tail read position: which session file, and how far into it we have consumed. */
  tailFile: string | null;
  tailByte: number;
  /** Set when a read failed. Rendered as a quiet line, never a thrown boundary — a transcript that
   *  cannot be read is a degraded pane, not a broken app. */
  error: string | null;
}

const EMPTY: MountedThread = {
  entries: [],
  next: null,
  hasMore: false,
  loading: false,
  paging: false,
  tailFile: null,
  tailByte: 0,
  error: null,
};

interface MountedThreadState {
  /** agentId -> that agent's loaded thread. */
  threads: Record<string, MountedThread>;
  /** Patch one agent's thread. Absent keys are left alone. */
  patch: (agentId: string, next: Partial<MountedThread>) => void;
  /** Fold a freshly-read batch in, deduped and time-ordered. Used by BOTH the backwards pager and
   *  the live tail, because both are the same reader arriving at the same list. */
  appendEntries: (agentId: string, incoming: readonly TranscriptEntry[]) => void;
  /** Forget an agent's thread — it closed, or the read must start clean. */
  reset: (agentId: string) => void;
}

export const useMountedThreadStore = create<MountedThreadState>((set) => ({
  threads: {},
  patch: (agentId, next) =>
    set((s) => ({
      threads: { ...s.threads, [agentId]: { ...(s.threads[agentId] ?? EMPTY), ...next } },
    })),
  // The unchanged-length bail matters because the live tail polls on a timer and MOST ticks bring
  // nothing back. Without it every idle tick would replace the entries array identity and re-render
  // the whole thread — for an agent that is thinking, that is a repaint per second forever.
  appendEntries: (agentId, incoming) =>
    set((s) => {
      const current = s.threads[agentId] ?? EMPTY;
      const merged = mergeEntries(current.entries, incoming);
      if (merged === current.entries || merged.length === current.entries.length) return s;
      // CAP THE HEAD, not the tail. Every entry carries its verbatim `raw` JSONL, and a mounted
      // agent's thread grows for as long as the pane stays open — a long session would otherwise
      // hold tens of MB in memory for the process lifetime, and `mergeEntries` re-sorts the whole
      // array on every tail batch, so the per-tick cost grows with it too. Dropping the OLDEST is
      // what keeps the live end (the part being watched) intact; the dropped span is still on disk
      // and pages back in on demand, which is the difference from `conciergeThreadStore`'s eviction
      // — there, evicted messages are gone for good.
      const capped =
        merged.length > MOUNTED_THREAD_MAX ? merged.slice(merged.length - MOUNTED_THREAD_MAX) : merged;
      return { threads: { ...s.threads, [agentId]: { ...current, entries: capped } } };
    }),
  reset: (agentId) =>
    set((s) => {
      if (!(agentId in s.threads)) return s;
      const { [agentId]: _dropped, ...threads } = s.threads;
      return { threads };
    }),
}));

/** This agent's thread, or a stable empty one. The SAME object identity is returned for every
 *  unknown agent, so a component subscribed before its first page lands does not re-render on an
 *  unrelated agent's write. */
export function useMountedThread(agentId: string | null): MountedThread {
  return useMountedThreadStore((s) => (agentId ? (s.threads[agentId] ?? EMPTY) : EMPTY));
}

export const EMPTY_MOUNTED_THREAD = EMPTY;
