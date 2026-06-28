// scrollIntentStore — a tiny cross-component channel for "scroll this agent's terminal to a
// prompt." History-search navigation sets an intent for the agent it's jumping to; AgentPane
// consumes it once that agent's terminal is mounted + PTY-ready, then scrolls to the prompt's
// xterm marker. In-memory only: a scroll target is meaningless across a relaunch, and the xterm
// markers it resolves against are session-only anyway (they die with the terminal instance).
import { create } from "zustand";

interface ScrollIntentState {
  /** agentId -> the promptHistory entry id its terminal should scroll to next. */
  intents: Record<string, string>;
  /** Queue a scroll for an agent (overwrites any pending one — the latest click wins). */
  request: (agentId: string, promptId: string) => void;
  /** Take + clear the pending scroll for an agent (null if none). */
  consume: (agentId: string) => string | null;
}

/** Apply a pending scroll intent: when the pane is the visible, ready terminal AND an intent is
 *  set, scroll to the prompt and clear the intent (so it can't re-fire). Pure given its deps, so
 *  the gate + consume contract is unit-testable without rendering the (heavy) AgentPane. Returns
 *  what happened — "skipped" when not ready, else the scroll outcome. */
export function applyScrollIntent(opts: {
  intent: string | undefined;
  visible: boolean;
  ready: boolean;
  scrollToPrompt: (promptId: string) => "scrolled" | "missing" | undefined;
  consume: () => void;
}): "scrolled" | "missing" | "skipped" {
  const { intent, visible, ready, scrollToPrompt, consume } = opts;
  if (!intent || !visible || !ready) return "skipped";
  const result = scrollToPrompt(intent) ?? "missing"; // ref absent → treat as missing
  consume(); // best-effort: a missing marker is still "handled" (don't let it re-fire forever)
  return result;
}

export const useScrollIntentStore = create<ScrollIntentState>((set, get) => ({
  intents: {},
  request: (agentId, promptId) =>
    set((s) => ({ intents: { ...s.intents, [agentId]: promptId } })),
  consume: (agentId) => {
    const promptId = get().intents[agentId];
    if (promptId === undefined) return null;
    set((s) => {
      const { [agentId]: _removed, ...rest } = s.intents;
      return { intents: rest };
    });
    return promptId;
  },
}));
