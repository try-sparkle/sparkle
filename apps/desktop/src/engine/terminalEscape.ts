// WHAT SHOULD AN ESCAPE PRESSED INSIDE A LIVE TERMINAL DO TO THE CABLE?
//
// The founder's gesture, verbatim: *"I really want escape to be the unmount gesture, so … when I'm in
// terminal, let's make it so that if I press escape twice, it unmounts the concierge."*
//
// ══ WHY THIS CANNOT LIVE IN A `window` LISTENER, WHICH IS WHERE IT WAS FIRST BUILT ══════════════
// An Escape typed into a focused xterm NEVER REACHES `window`. xterm's own keydown handler runs on
// `.xterm-helper-textarea` (the event target) and, for Escape specifically, calls `cancel(ev, true)` —
// verified in the shipped bundle:
//
//     case 27: o.key = ESC, …, o.cancel = !0
//     i.cancel && this.cancel(e, !0)
//     cancel(e,t){ if(this.options.cancelEvents||t) return e.preventDefault(), e.stopPropagation(), !1 }
//
// So propagation stops at the textarea. The first version of this feature put the decision in
// `Workspace`'s `window` keydown listener, where it was simply unreachable — and every test passed
// because they fired `keyDown(window, …)` directly at a stub textarea with no xterm handler, bypassing
// the exact mechanism that blocks it (roborev 55722).
//
// It also means the "bug" the first commit claimed to fix — one Escape both signalling the process AND
// unbinding the cable — NEVER EXISTED. The event never arrived, so the cable never reacted.
//
// The decision therefore belongs to `Terminal.tsx`'s `attachCustomKeyEventHandler`, which runs BEFORE
// xterm cancels the event and is the only layer that sees the key at all. That handler returns `true`
// for Escape, so the byte still reaches the PTY exactly as before — this module only decides what the
// CABLE does alongside it.
//
// ══ PROVENANCE, THEN A ONE-PRESS TOLL ══════════════════════════════════════════════════════════
// The caret is in a terminal BY DEFAULT: `AgentPane` parks it there whenever a pane is visible and its
// PTY is ready. So "in a terminal" is the app's resting state and cannot be the whole test — keying on
// it alone retired Escape-to-unbind for the normal case, which is founder-confirmed behavior
// (roborev 55614).
//
//   - The APP parked the caret and the user has not touched that terminal → Escape keeps its
//     long-standing meaning and releases on the FIRST press.
//   - The USER is working in that terminal (they clicked into it, or they have typed at it) → the
//     first Escape is the process's alone, and the SECOND releases. The toll is paid once per
//     sequence, not per press, so the gesture is two presses rather than two-per-rung.
//
// Pure, so the precedence is unit-tested without React, a DOM or a live PTY — this directory's
// convention (cf. `dictationPauseReason`, `unbindsOnKey`).

export interface TerminalEscapeInput {
  /**
   * Is the user WORKING in this terminal, as opposed to the app having parked the caret there?
   *
   * Upgraded by real interaction — a pointer press inside the surface, or the first byte xterm's
   * `onData` reports (which fires only for user input). A focus transition alone is not enough: once
   * the textarea is already the active element, a click inside it raises no `focusin` and the user's
   * typing is swallowed by xterm before any window listener sees it, so provenance decided purely at
   * focus time stays wrong for the whole session (roborev 55722).
   */
  deliberate: boolean;
  /**
   * Has the one-press toll already been paid in this sequence?
   *
   * Cleared by anything that ends the gesture — a pointer press, a non-Escape key, focus leaving the
   * window — and by a wall-clock expiry, so a lone Escape now and another minutes later are two first
   * presses rather than one gesture.
   */
  tollPaid: boolean;
}

/** What the CABLE does about this press. The PTY always gets the byte either way. */
export type TerminalEscapeAction =
  | "process-only" // the running program's press; the cable does not move
  | "release"; // also unbind the concierge from the row it is patched into

/**
 * Decide, for an Escape pressed inside a live terminal.
 *
 * Note the shape: only ONE arm withholds the release, so this is narrow by construction. A bug in the
 * deliberateness signal degrades toward "Escape releases the cable" — the behavior that shipped for
 * years — rather than toward a key that silently does nothing.
 */
export function terminalEscapeAction(i: TerminalEscapeInput): TerminalEscapeAction {
  if (!i.deliberate) return "release";
  if (i.tollPaid) return "release";
  return "process-only";
}

/**
 * May the cable's SECOND rung — clearing the active build row — claim a press while the caret is in a
 * terminal? Never.
 *
 * Gated on presence alone rather than on provenance, deliberately. Rung 1 needs provenance so that
 * "Escape twice unmounts" works while the parked-caret ladder keeps working; rung 2 needs nothing of
 * the sort, because no press count should ever blank the terminal column of the agent holding the
 * caret. That is roborev 55373's destructive outcome, and three Escapes inside five seconds is an
 * ordinary gesture for a vim user (roborev 55722).
 *
 * Belt-and-braces in practice: an Escape from a focused xterm never reaches the `window` listener that
 * consults this at all. It still matters for the corner case where the caret sits on the surface
 * wrapper rather than on xterm's textarea, where no xterm handler cancels the event.
 */
export function terminalBlocksSelectionRelease(inTerminal: boolean): boolean {
  return inTerminal;
}
