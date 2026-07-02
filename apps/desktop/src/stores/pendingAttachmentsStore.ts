// Handoff for files dropped BEFORE their composer exists. Dropping files on the "+ New Build
// Agent" button spawns a brand-new agent and must attach the files to THAT agent's composer —
// but attachments are per-Composer local state (Composer.tsx), and the new agent's composer
// hasn't mounted yet at drop time. The drop handler (useNewBuildAgentDrop) stashes the dropped
// paths here keyed by the new agent's id; the Composer drains its entry once it's the active
// pane and loads the paths into its own attachment tiles. Transient — deliberately NOT
// persisted: a stale path surviving a relaunch would just produce a broken tile.
import { create } from "zustand";

interface PendingAttachmentsState {
  pending: Record<string, string[]>;
  /** Queue dropped file paths for an agent whose composer hasn't mounted yet. */
  add: (agentId: string, paths: string[]) => void;
  /** Take (and clear) the queued paths for an agent. Empty array when none are queued. */
  drain: (agentId: string) => string[];
}

export const usePendingAttachmentsStore = create<PendingAttachmentsState>()((set, get) => ({
  pending: {},
  add: (agentId, paths) =>
    set((s) => ({
      pending: { ...s.pending, [agentId]: [...(s.pending[agentId] ?? []), ...paths] },
    })),
  drain: (agentId) => {
    const paths = get().pending[agentId];
    if (!paths || paths.length === 0) return [];
    set((s) => {
      const { [agentId]: _drained, ...rest } = s.pending;
      return { pending: rest };
    });
    return paths;
  },
}));
