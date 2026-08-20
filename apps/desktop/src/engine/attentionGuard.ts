// "MAY THE APP MOVE THE FOUNDER'S ATTENTION RIGHT NOW?" — the one predicate every jump the app
// starts by itself has to pass.
//
// ══ THE BUG THIS EXISTS FOR ═════════════════════════════════════════════════════════════════════
// Founder, verbatim: *"If my mouse is currently actively clicked into a terminal, I would like you
// to not change my focus to a new build agent that you spin up … This should include a mounted
// concierge."*
//
// The steal is not a stray `focus()` call — it is the SELECTION. `services/landInAgent` selects the
// new agent, which stops the pane he is typing in from being the visible one; the DOM then drops his
// caret, and the new pane's `AgentPane` auto-focus takes it when its PTY comes up. Keystrokes aimed
// at his shell land somewhere else. That is why the fix suppresses the attention move itself rather
// than guarding the focus call at the end of it.
//
// ══ WHY THIS IS NOT THE VETO THAT WAS ALREADY TRIED AND REVERTED ════════════════════════════════
// `services/terminalMidCommand`'s header records an over-correction worth not repeating: a veto
// keyed on terminal FOCUS ALONE declined essentially every legitimate compose-focus pull, because in
// a terminal-first shell the xterm key sink holds the caret whenever the user is not typing into
// something else.
//
// This is a DIFFERENT question over the same DOM, and the difference is what makes focus-alone the
// right answer here:
//   * that veto gated a pull the USER had asked for (a drop pill's "go to compose", the empty-agent
//     spawn's caret) — declining it broke something the user had just clicked;
//   * this gates only a jump the APP started on its own, and every caller declares which it is
//     (`attention: "user"` is the default and is never held). A click still jumps. Nothing the user
//     asks for is ever declined here.
// So the cost of a false positive is bounded at "the app did not move me", which is the outcome the
// founder is asking for anyway.
//
// ══ SCOPE ══════════════════════════════════════════════════════════════════════════════════════
// Live focus, not the last click. The founder said "actively clicked into", which is a statement
// about where the caret IS — and a terminal is the one surface that answers it reliably in this
// webview, because xterm holds a real caret (`.xterm-helper-textarea`) where a plain <button> leaves
// `activeElement` on `<body>` (see engine/columnZoom's header for the measurement).
//
// MAIN WINDOW ONLY, today. A terminal torn off into its own OS window lives in a separate WebView, so
// this document cannot see its caret; covering that needs a cross-window claim (the Tauri-event +
// localStorage pattern `services/satelliteWindows` uses) and is deliberately a follow-up.
import { classifyFocusOwner } from "../voice/dictationFocus";
import { isTypingInProgress } from "./focusGuard";

/** WHY the app may not move the view right now — a named reason rather than a bare `false`, so a
 *  caller can log it and a test reads an outcome instead of inferring one from a spy count (the same
 *  shape `applyPaneFocus` and `RevealOutcome` already use). */
export type AttentionHold =
  /** The caret is inside a terminal surface — a live PTY that owns the keyboard. */
  | "terminal"
  /** The caret is in an editable field holding UNSENT text (the mounted concierge's compose box is
   *  the case the founder named; it is a textarea, not a terminal, so the clause above misses it).
   *  This is `engine/focusGuard`'s standing rule — "never out from under a half-typed message" —
   *  which already governs every automatic focus grab; the attention move simply never consulted it.
   *  An EMPTY focused box is NOT a hold: that is the app's steady state, and holding on it would
   *  mean a spawn asked for from the concierge never lands you anywhere. */
  | "unsent-text";

/**
 * What is holding the founder's attention, or `null` when nothing is and the app may move the view.
 *
 * Reads the LIVE caret once. Callers that make several decisions off one answer (a spawn settles
 * `select:false`, the project switch and the landing separately) must read it ONCE and pass it down
 * — two reads of a moving value in one decision is how a guard ends up describing one element and
 * acting on another (`voice/dictationFocus` makes the same argument for `terminalAgentIdOf`).
 *
 * Safe outside a DOM (returns `null`), so non-React callers and node-environment tests can call it.
 */
export function attentionHold(
  doc: Document | undefined = typeof document !== "undefined" ? document : undefined,
): AttentionHold | null {
  if (!doc) return null;
  // ══ `hasFocus()` IS DELIBERATELY *NOT* CONSULTED ════════════════════════════════════════════
  // It was, for one review round, on the reasoning that `activeElement` survives the window losing
  // OS focus and so decays into a last-click heuristic. That was wrong twice over.
  //
  // WHAT `activeElement` ACTUALLY MEANS while the window is inactive is *where the keyboard will
  // land the moment it is re-activated* — which makes it a BETTER predictor for this decision, not a
  // staler one. The failure it re-opened is the founder's own complaint merely deferred by one
  // window activation: leave the caret in a terminal, cmd-tab away while a long concierge turn runs,
  // and the spawn lands unhindered — board down, side switched, row selected, and on the promptless
  // path the caret pulled into the composer — so he tabs back into a different pane with his next
  // keystrokes going somewhere he never put them.
  //
  // The protection it was added for is also gone: it existed so `captureSends` (which runs from the
  // capture webview, i.e. always while this document is unfocused) would not be held permanently,
  // and that path no longer consults this guard at all — see the note at its `landInAgent` call for
  // why gating it was a defect rather than a scope choice. EVERY remaining caller
  // (`conciergeTools/lifecycle`, `conciergeTools/plans`) runs in the main window and reads its own
  // live caret, where the "last-click" objection simply does not apply.
  //
  // TERMINAL FIRST, and the order is not cosmetic: a focused xterm's helper textarea IS a TEXTAREA,
  // so it would fall through the second clause — but with an ALWAYS-EMPTY value, because xterm
  // forwards the keystroke to the PTY and the half-typed command lives in the shell's line buffer,
  // not in the DOM (services/terminalMidCommand's header). Reading it second would answer "nothing
  // is held" for the exact surface this guard is about.
  if (classifyFocusOwner(doc.activeElement) === "terminal") return "terminal";
  if (isTypingInProgress(doc)) return "unsent-text";
  return null;
}

/** Sugar for the callers that only need the yes/no. Same read, same caveat about reading once. */
export function mayTakeAttention(doc?: Document): boolean {
  return attentionHold(doc) === null;
}
