// The seam between a file dropped on an agent's TERMINAL and the compose box that will carry it.
//
// WHY A STORE AND NOT A DIRECT CALL. The drop is detected per-pane (hooks/useTerminalDrop, mounted
// inside AgentPane and live only while that pane is VISIBLE), but the staged-attachment list lives
// in the concierge column (hooks/useConciergeAttachments, mounted in ConciergeHost). Those two are
// on opposite sides of the tree with no common owner below the app root, so the drop hands its
// paths off here and the compose box picks them up.
//
// FEEDING ONE MECHANISM, NOT A SECOND ONE. Everything queued here ends up in the SAME
// `attachments` list the compose box's Screenshot / Image / Files buttons fill, and renders as the
// same removable chips. A terminal drop is another way to REACH that list, never a parallel one —
// so removal, the send-time drain, and the put-it-back-on-failure path are all inherited rather
// than reimplemented.
//
// WHICH AGENT. There is exactly ONE compose box and it is aimed at the agent whose pane is showing
// (ConciergeHost's routing target). A terminal drop can only be claimed by the VISIBLE pane — that
// is what `enabled` in useTerminalDrop enforces — so the agent dropped ON and the agent the box is
// aimed AT are the same agent by construction. `agentId` rides along so the pickup can log and
// assert that, not so it can re-route: nothing here picks a destination.
//
// Pickup is SYNCHRONOUS with the drop (zustand notifies subscribers inside `set`), so the aim
// cannot move between queueing and draining.
//
// Transient — deliberately NOT persisted, for the same reason as pendingAttachmentsStore: a stale
// path surviving a relaunch would just produce a broken chip, and a silently re-armed attachment is
// worse than a lost one.
import { create } from "zustand";

/** One terminal drop, waiting for the compose box to pick it up. */
export interface TerminalDropBatch {
  /** The agent whose pane was dropped on — the visible one (see the header). */
  agentId: string;
  /** Absolute paths, exactly as the OS handed them over. */
  paths: string[];
}

interface TerminalDropState {
  /** Batches awaiting pickup, oldest first. Normally drained the instant it is written; it is a
   *  QUEUE rather than a single slot so a drop that lands before the concierge column has mounted
   *  (or during a re-render) waits instead of overwriting an earlier one. */
  queue: TerminalDropBatch[];
  /** Hand off files dropped on `agentId`'s terminal. Empty path lists are ignored, so subscribers
   *  are never woken for nothing. */
  enqueue: (agentId: string, paths: string[]) => void;
  /** Take (and clear) every queued batch. Empty array when nothing is waiting. */
  drain: () => TerminalDropBatch[];
}

export const useTerminalDropStore = create<TerminalDropState>()((set, get) => ({
  queue: [],
  enqueue: (agentId, paths) => {
    if (paths.length === 0) return;
    set((s) => ({ queue: [...s.queue, { agentId, paths }] }));
  },
  drain: () => {
    const queued = get().queue;
    if (queued.length === 0) return [];
    set({ queue: [] });
    return queued;
  },
}));
