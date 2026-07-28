// Ephemeral hand-off into the Think panel: `pending` carries the initial prompt (and whether to
// auto-send it) for the project's singleton think agent. Deliberately NOT persisted — it is
// consumed on the next render and cleared.
//
// `buildDraft` USED TO LIVE HERE and does not any more. It prefilled the per-agent Build composer,
// which db29f0a48 deleted; the field outlived its only reader and quietly swallowed every capture
// sent from the helper island. Capture drafts now go to stores/composeHandoffStore, whose `take()`
// is a clearing read and whose consumer (ConciergeHost) logs each delivery — both directly because
// of how this one failed. Do not reintroduce a draft field here.
import { create } from "zustand";
import type { CaptureAttachment } from "../capture/types";

export interface ThinkHandoff {
  projectId: string;
  text: string;
  autoSend: boolean;
  /** Screenshots riding along from the capture modal (absent for text-only handoffs). */
  attachments?: CaptureAttachment[];
}

interface HandoffState {
  pending: ThinkHandoff | null;
  setPending: (h: ThinkHandoff) => void;
  clear: () => void;
}

export const useHandoffStore = create<HandoffState>((set) => ({
  pending: null,
  setPending: (h) => set({ pending: h }),
  clear: () => set({ pending: null }),
}));
