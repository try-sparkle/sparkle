// librarianStore — the live output of the background "librarian + skeptic" grounding service.
// The Think interview never blocks on Chief; this store is where each agent's two background
// lanes land as they resolve. Keyed by agentId so a project's singleton Think agent (and any
// future multi-agent use) each own an independent set of lanes. Deliberately NOT persisted —
// grounding is recomputed per interview turn, so a stale snapshot would be worse than empty.
import { create } from "zustand";

/** One surfaced finding: a terse line plus any doc names it cited (markdown link targets). */
export interface LibrarianItem {
  text: string;
  docRefs: string[];
  ts: number;
}

/** Both background lanes for one agent, plus when they last changed and the live status.
 *  `grounding` = the librarian's relevant prior decisions/docs/collisions; `challenges` = the
 *  skeptic's strongest counter-case. */
export interface LibrarianLanes {
  grounding: LibrarianItem[];
  challenges: LibrarianItem[];
  updatedAt: number;
  status: "idle" | "thinking" | "error";
}

interface LibrarianState {
  byAgent: Record<string, LibrarianLanes | undefined>;
  setLane(agentId: string, lane: "grounding" | "challenges", items: LibrarianItem[]): void;
  setStatus(agentId: string, status: LibrarianLanes["status"]): void;
  clear(agentId: string): void;
}

/** A fresh, empty set of lanes (status idle). Used as the default for an unseen agent and as the
 *  base we mutate when the first lane/status lands. `updatedAt: 0` marks "never updated". */
export function emptyLanes(): LibrarianLanes {
  return { grounding: [], challenges: [], updatedAt: 0, status: "idle" };
}

export const useLibrarianStore = create<LibrarianState>((set) => ({
  byAgent: {},
  setLane: (agentId, lane, items) =>
    set((state) => {
      const prev = state.byAgent[agentId] ?? emptyLanes();
      return {
        byAgent: {
          ...state.byAgent,
          [agentId]: { ...prev, [lane]: items, updatedAt: Date.now() },
        },
      };
    }),
  setStatus: (agentId, status) =>
    set((state) => {
      const prev = state.byAgent[agentId] ?? emptyLanes();
      return { byAgent: { ...state.byAgent, [agentId]: { ...prev, status } } };
    }),
  clear: (agentId) =>
    set((state) => {
      // Drop the key entirely so `lanesFor` falls back to fresh empty lanes.
      const next = { ...state.byAgent };
      delete next[agentId];
      return { byAgent: next };
    }),
}));

/** Read an agent's lanes, defaulting to empty lanes when it has none yet. Safe to call from a
 *  render (returns a stable-shaped object even for an unknown agent). */
export function lanesFor(agentId: string): LibrarianLanes {
  return useLibrarianStore.getState().byAgent[agentId] ?? emptyLanes();
}
