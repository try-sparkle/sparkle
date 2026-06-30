import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { SuggestionKind } from "../services/suggestions/types";

// Personal-history store for the suggested-action-buttons feature. Every time the user takes an
// action while an agent is blocked-on-them (a manual send OR a suggestion click), we log a compact
// event. The engine feeds the most-relevant recent events to Haiku as few-shot context and uses
// them to re-rank. Capped + persisted to localStorage, mirroring the other app stores.
export const MAX_EVENTS = 200;

export interface SuggestionEvent {
  ts: number;
  contextTags: string[];
  label: string;
  value: string;
  kind: SuggestionKind;
}

interface SuggestionStoreState {
  events: SuggestionEvent[];
  recordEvent: (e: Omit<SuggestionEvent, "ts">) => void;
  recentEvents: (limit?: number) => SuggestionEvent[];
  topByContext: (tags: string[], limit: number) => SuggestionEvent[];
}

export const useSuggestionStore = create<SuggestionStoreState>()(
  persist(
    (set, get) => ({
      events: [],
      recordEvent: (e) =>
        set((s) => {
          const next = [...s.events, { ...e, ts: Date.now() }];
          return { events: next.slice(-MAX_EVENTS) };
        }),
      recentEvents: (limit = 30) => get().events.slice(-limit).reverse(),
      topByContext: (tags, limit) => {
        const wanted = new Set(tags);
        // Group identical (label,value) actions; score = overlap*10 + frequency.
        const groups = new Map<string, { ev: SuggestionEvent; count: number; overlap: number }>();
        for (const ev of get().events) {
          // Structured key so distinct fields can't collide via a bare-space join
          // (e.g. {"a b","c"} vs {"a","b c"}).
          const key = JSON.stringify([ev.label, ev.value]);
          const overlap = ev.contextTags.filter((t) => wanted.has(t)).length;
          const g = groups.get(key);
          if (g) {
            g.count += 1;
            g.overlap = Math.max(g.overlap, overlap);
            // Keep the MOST RECENT occurrence as the representative so its ts / contextTags
            // (used by the engine for few-shot recency) aren't stale. Events are iterated
            // oldest-first, so a later hit is always newer.
            g.ev = ev;
          } else {
            groups.set(key, { ev, count: 1, overlap });
          }
        }
        return [...groups.values()]
          .sort((a, b) => b.overlap * 10 + b.count - (a.overlap * 10 + a.count))
          .slice(0, limit)
          .map((g) => g.ev);
      },
    }),
    { name: "sparkle-suggestions", storage: createJSONStorage(() => localStorage), version: 1 },
  ),
);
