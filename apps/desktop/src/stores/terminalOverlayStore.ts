// terminalOverlayStore — the two live facts a concierge-owned overlay needs about a build agent's
// terminal, published by the pane that owns it.
//
// WHY A STORE AND NOT PROPS. The recommended-action pill is wired to the concierge (promptAgent,
// the delivery queue, the failure relay all live in ConciergeHost) but must RENDER inside the
// terminal stage that AgentPane owns. The two are separate subtrees under Workspace, so the pill
// reaches its home via a portal — and a portal needs the container node. `stages` is that node,
// registered by the pane; `drafts` is the emptiness signal the pill hides on, written by the
// terminal's own onData scanner.
//
// In-memory only, deliberately. A DOM node cannot be serialized, and "is the user mid-line at the
// CLI prompt" is meaningless across a relaunch — the CLI's input box starts empty.
import { create } from "zustand";

interface TerminalOverlayState {
  /** agentId -> the pane's `position: relative` terminal stage element, while it is mounted. */
  stages: Record<string, HTMLElement>;
  /** agentId -> the user has an unsubmitted, non-whitespace line pending at the CLI prompt. */
  drafts: Record<string, boolean>;
  /** Publish (or, with null, withdraw) an agent's terminal stage. Called from the stage's ref. */
  setStage: (agentId: string, el: HTMLElement | null) => void;
  /** Record whether the user is mid-compose in this agent's terminal. */
  setDraft: (agentId: string, pending: boolean) => void;
  /** Drop an agent's draft flag (its terminal was torn down). The stage is cleared separately —
   *  the terminal remounts on an account switch while the pane's stage element stays put. */
  clearDraft: (agentId: string) => void;
}

export const useTerminalOverlayStore = create<TerminalOverlayState>((set) => ({
  stages: {},
  drafts: {},
  setStage: (agentId, el) =>
    set((s) => {
      if (el === null) {
        if (!(agentId in s.stages)) return s;
        const { [agentId]: _removed, ...stages } = s.stages;
        return { stages };
      }
      if (s.stages[agentId] === el) return s; // same node — no needless subscriber wake-up
      return { stages: { ...s.stages, [agentId]: el } };
    }),
  // Written from the terminal's onData handler, i.e. once per KEYSTROKE. The unchanged-value bail
  // is what makes that affordable: a store write only happens when emptiness actually flips, so
  // typing a word costs one re-render, not one per character.
  setDraft: (agentId, pending) =>
    set((s) => {
      if (!!s.drafts[agentId] === pending) return s;
      if (!pending) {
        const { [agentId]: _removed, ...drafts } = s.drafts;
        return { drafts };
      }
      return { drafts: { ...s.drafts, [agentId]: true } };
    }),
  clearDraft: (agentId) =>
    set((s) => {
      if (!(agentId in s.drafts)) return s;
      const { [agentId]: _removed, ...drafts } = s.drafts;
      return { drafts };
    }),
}));
