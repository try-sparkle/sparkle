// historyStore — the frontend face of the durable history store (Rust `history_*` commands).
// Holds the current search query, debounced results, and the active retention entitlement. It
// owns no persistence of its own; the Rust SQLite DB is the source of truth. Capture (record) is
// fire-and-forget so a storage hiccup can never break a chat or an agent turn.
import { create } from "zustand";
import {
  recordHistory,
  searchHistory,
  pruneHistory,
  type HistoryEntry,
  type HistoryHit,
  type RecordOutcome,
  type RetentionTier,
} from "../services/history";
import { getRetentionEntitlement } from "../services/credits";

/** Retention window per tier, in ms. `indefinite` → null (no prune cutoff). */
export function windowMsForTier(t: RetentionTier): number | null {
  switch (t) {
    case "24h":
      return 86_400_000;
    case "7d":
      return 604_800_000;
    case "30d":
      return 2_592_000_000;
    case "90d":
      return 7_776_000_000;
    case "1y":
      return 31_536_000_000;
    case "indefinite":
      return null;
  }
}

// Debounce window for type-to-search. Module-level (not in state) so it survives re-renders and
// isn't part of the serializable store shape.
const SEARCH_DEBOUNCE_MS = 200;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

interface HistoryState {
  query: string;
  results: HistoryHit[];
  entitlement: RetentionTier;
  searching: boolean;
  /** Fire-and-forget capture; never throws into the caller.
   *
   *  It DOES return, though: the {@link RecordOutcome} says whether the row landed, was a benign
   *  identical re-capture, or COLLIDED — an existing row under the same id holding different text,
   *  which means the incoming words were thrown away. A caller that wants to know can await it; one
   *  that doesn't can keep ignoring it exactly as before. A failed write still reports the neutral
   *  outcome rather than throwing, because this runs inside a zustand listener chain. */
  record: (e: HistoryEntry) => Promise<RecordOutcome>;
  /** Update the query immediately and schedule a debounced search. */
  setQuery: (q: string) => void;
  /** Run a search now. Blank query clears results without hitting the backend. */
  search: (q: string) => Promise<void>;
  /** Load the active retention tier from the (stubbed) credit system. */
  loadEntitlement: () => Promise<void>;
  /** Prune history older than the entitlement window.
   *
   *  `indefinite` skips the AGE bound only — it is no longer a full no-op. The concierge row-count
   *  cap runs on every prune regardless of tier (`prune_in_with_max` in src-tauri/src/history.rs),
   *  because count and age are independent bounds and concierge conversation is exempt from the age
   *  one. So a prune at the `indefinite` tier can still delete rows and report a non-zero count. */
  prune: () => Promise<void>;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  query: "",
  results: [],
  entitlement: "24h",
  searching: false,

  record: async (e) => {
    try {
      return await recordHistory(e);
    } catch {
      // Capture is best-effort: a failed write must never surface to the chat / agent flow. The
      // neutral verdict is the honest one here — nothing was written, and nothing is known to have
      // been overwritten either, so this must not read as a collision.
      return { inserted: false, collided: false };
    }
  },

  setQuery: (q) => {
    set({ query: q });
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      // Read the current query from state (the single source of truth) rather than the value
      // captured at scheduling time, so the search always reflects the latest input.
      void get().search(get().query);
    }, SEARCH_DEBOUNCE_MS);
  },

  search: async (q) => {
    if (!q.trim()) {
      set({ results: [], searching: false });
      return;
    }
    set({ searching: true });
    try {
      const results = await searchHistory(q);
      set({ results, searching: false });
    } catch {
      set({ results: [], searching: false });
    }
  },

  loadEntitlement: async () => {
    const entitlement = await getRetentionEntitlement();
    set({ entitlement });
  },

  prune: async () => {
    const window = windowMsForTier(get().entitlement);
    const cutoff = window === null ? null : Date.now() - window;
    await pruneHistory(cutoff);
  },
}));
