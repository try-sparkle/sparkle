// interactionStore — per-agent timestamp of the user's LAST interaction with an agent, so the
// sidebar's elapsed timer measures "how long has this agent run without me touching it" and resets
// the instant I touch it again. Two interaction sources feed it:
//   - composer Send (AgentPane) — also recorded in promptHistory; the timer takes the max of the
//     two, so a Send always resets even if a terminal keystroke was throttled away just before it.
//   - raw terminal keystrokes (Terminal.onData) — the common case the prompt-only anchor missed,
//     which is why the timer "wasn't resetting" when the user drove the agent from the terminal.
// Agent OUTPUT never calls touch() (xterm's onData fires for user input only), so the agent working
// does not reset the timer — only the user does. In-memory only: elapsed-since-interaction is a
// live, session-scoped notion and meaningless across a relaunch.
import { create } from "zustand";

// Throttle window: while the user types continuously, collapse the keystroke storm into at most one
// store write per this interval. The FIRST keystroke after an idle gap is always older than the
// window, so it writes immediately (the timer snaps to 0); subsequent rapid keystrokes are skipped
// but keep the value within ~1s of now, which is all the second-granularity display needs.
export const TOUCH_THROTTLE_MS = 900;

/** Pure decision: should this touch write a new timestamp, given the previously stored one? Writes
 *  when there is no prior value or it's older than the throttle window. Exported for unit tests. */
export function shouldRecordTouch(prev: number | undefined, now: number): boolean {
  return prev === undefined || now - prev >= TOUCH_THROTTLE_MS;
}

interface InteractionState {
  /** agentId -> epoch ms of the user's most recent interaction with that agent. */
  lastAt: Record<string, number>;
  /** Record an interaction now (throttled). Pass an explicit `now` only in tests. */
  touch: (agentId: string, now?: number) => void;
}

export const useInteractionStore = create<InteractionState>((set, get) => ({
  lastAt: {},
  touch: (agentId, now = Date.now()) => {
    if (!shouldRecordTouch(get().lastAt[agentId], now)) return;
    set((s) => ({ lastAt: { ...s.lastAt, [agentId]: now } }));
  },
}));
