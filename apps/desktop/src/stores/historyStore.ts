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
  /** Fire-and-forget capture; never throws into the caller. */
  record: (e: HistoryEntry) => Promise<void>;
  /** Update the query immediately and schedule a debounced search. */
  setQuery: (q: string) => void;
  /** Run a search now. Blank query clears results without hitting the backend. */
  search: (q: string) => Promise<void>;
  /** Load the active retention tier from the (stubbed) credit system. */
  loadEntitlement: () => Promise<void>;
  /** Prune history older than the entitlement window (no-op on `indefinite`). */
  prune: () => Promise<void>;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  query: "",
  results: [],
  entitlement: "24h",
  searching: false,

  record: async (e) => {
    try {
      await recordHistory(e);
    } catch {
      // Capture is best-effort: a failed write must never surface to the chat / agent flow.
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
