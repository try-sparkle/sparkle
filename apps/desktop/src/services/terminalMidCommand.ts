// "Is the caret in a terminal whose CLI line already holds something the user typed?" — the terminal's
// answer to `isTypingInProgress`, which cannot answer it.
//
// ══ WHY A TERMINAL NEEDS A SEPARATE PREDICATE AT ALL ═══════════════════════════════════════════════
// `engine/focusGuard`'s `isTypingInProgress` reads `activeElement.value`, and for a focused xterm that
// value is ALWAYS EMPTY: xterm cancels the keystroke and forwards it to the PTY, so the half-typed
// command lives in the shell's line buffer, not in the DOM (`.xterm-helper-textarea` is written only
// on blur and on CR/ETX). A guard resting on it therefore declines nothing for the one surface
// sparkle-d2ec is actually about.
//
// ══ AND WHY NOT "A TERMINAL IS ALWAYS MID-INPUT" ═══════════════════════════════════════════════════
// That was the previous cut, and it over-corrected. In a terminal-first shell the xterm key sink holds
// the caret whenever the user is not typing into something else, so a veto keyed on terminal FOCUS
// alone declines essentially every legitimate compose-focus pull: `ConciergeHost`'s capture-window
// handoff (which stages a draft and then cannot deliver the caret to it — leaving the user's next
// Enter pointed at a shell, where it EXECUTES the pending line), the empty-agent spawn, the drop
// pill's "go to compose". It also justified itself with "there is no way to ask a terminal otherwise",
// which is not true: the app already computes the answer (roborev 59610).
//
// `Terminal.tsx`'s `onData` scanner publishes `terminalOverlayStore.drafts[agentId]` on every
// keystroke — "the user has an unsubmitted, non-whitespace line pending at the CLI prompt" — and the
// terminal-anchored action pill already hides on it. `onData` sees USER input only, never the agent's
// output, so it is exactly the signal wanted: unsent text the user would lose the place of.
import { classifyFocusOwner, terminalAgentIdOf } from "../voice/dictationFocus";
import { useTerminalOverlayStore } from "../stores/terminalOverlayStore";

/**
 * True when `active` sits in a terminal AND that terminal's CLI prompt holds unsent input.
 *
 * FAIL-SAFE ON AN UNIDENTIFIABLE TERMINAL. `classifyFocusOwner` matches xterm's own classes as well
 * as our `[data-terminal-surface]` wrapper, so a terminal mounted without the wrapper (or before its
 * agent id resolves) classifies as a terminal while carrying no id to look a draft up by. That state
 * is answered "mid-command", not "idle": declining a pull costs a caret that did not move, taking one
 * costs the user's keystrokes going somewhere they are not looking, and the second is the bug.
 */
export function terminalHoldsUnsentInput(active: Element | null | undefined): boolean {
  if (classifyFocusOwner(active) !== "terminal") return false;
  const agentId = terminalAgentIdOf(active);
  if (!agentId) return true;
  return Boolean(useTerminalOverlayStore.getState().drafts[agentId]);
}
