// Ephemeral hand-offs into the Think panel and the Build composer: `pending` carries the
// initial prompt (and whether to auto-send it) for the project's singleton think agent;
// `buildDraft` prefills the Build composer (text + capture attachments), consumed on
// mount/focus and NEVER auto-sent. Deliberately NOT persisted — each is consumed on the
// next render and cleared.
import { create } from "zustand";
import type { CaptureAttachment } from "../capture/types";

export interface ThinkHandoff {
  projectId: string;
  text: string;
  autoSend: boolean;
  /** Screenshots riding along from the capture modal (absent for text-only handoffs). */
  attachments?: CaptureAttachment[];
}

export interface BuildDraft {
  projectId: string;
  text: string;
  attachments: CaptureAttachment[];
}

interface HandoffState {
  pending: ThinkHandoff | null;
  setPending: (h: ThinkHandoff) => void;
  clear: () => void;
  buildDraft: BuildDraft | null;
  setBuildDraft: (d: BuildDraft) => void;
  clearBuildDraft: () => void;
}

export const useHandoffStore = create<HandoffState>((set) => ({
  pending: null,
  setPending: (h) => set({ pending: h }),
  clear: () => set({ pending: null }),
  buildDraft: null,
  setBuildDraft: (d) => set({ buildDraft: d }),
  clearBuildDraft: () => set({ buildDraft: null }),
}));
