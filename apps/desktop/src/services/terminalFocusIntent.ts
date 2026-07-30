// DID THE USER PUT THE CARET IN THIS TERMINAL, or did the app?
//
// `engine/terminalEscape` needs this and nothing else can answer it: "the caret is in a terminal" is
// the app's RESTING state, because `AgentPane`'s auto-focus effect hands the caret to the terminal
// whenever a pane is visible and its PTY is ready. Provenance is the only thing that separates "I am
// working in this process" from "the app put me here and I never asked".
//
// ══ MARK THE PROGRAMMATIC CALL SITES; TREAT EVERYTHING ELSE AS THE USER ═════════════════════════
// The inverse — enumerate the deliberate gestures (pointer down, Tab, the ⌘J chord, a click on the
// pane, a drag that ends in focus, …) — is a list that is wrong the moment someone adds a fifth way
// in, and wrong in the DANGEROUS direction: an unlisted gesture reads as "automatic", so a single
// Escape typed by a user working in vim would drop the cable. Marking the automatic paths inverts
// that: anything unaccounted-for reads as deliberate, which costs at most one extra Escape.
//
// THERE IS MORE THAN ONE SUCH SITE, and an earlier version of this comment claimed otherwise —
// which was not merely inaccurate, it under-sold the cost of missing one. `AgentPane` and
// `SparkleAgentPane` both park the caret in their terminal on `visible && ptyReady`; the second was
// unmarked, so that pane got the INVERSE ladder (first Escape did not release, and rung 2 was
// unreachable while its terminal held the caret) rather than just an extra press (roborev 55722).
// `Terminal`'s `arrowFromComposer`/`enterFromComposer` and the drop-focus path write to the PTY but
// do not move the caret into it, so they are deliberately not marked.
//
// This is the same philosophy as `services/programmaticFocus.ts` ("give focus a provenance"), and
// deliberately NOT that module: its `isProgrammaticFocus` CONSUMES its tag on read and is built
// around a single focusin for a known element, while the terminal's auto-focus goes through xterm's
// own `term.focus()` and lands on a hidden textarea this app never holds a handle to.
//
// The CLASSIFICATION itself is not ours — `voice/dictationFocus.classifyFocusOwner` owns it, and there
// must be exactly one answer to "is this node a terminal" in the app. This module adds only the
// orthogonal fact that classifier cannot know: WHO moved the caret there.
//
// ══ THE MARK IS BOUNDED, BECAUSE THE FOCUSIN IT EXPECTS MAY NEVER COME ══════════════════════════
// `term.focus()` on an already-focused terminal dispatches nothing, so a mark set for a no-op focus
// would sit there and mislabel the NEXT focusin — which could be a real click, arbitrarily later.
// The mark therefore self-clears on a macrotask, the same technique the repo's other focus trackers
// use for events that may not arrive.
//
// No `focusout` handling, and that is a deliberate omission rather than a gap: leaving a terminal for
// a non-focusable target often raises no event at all, so a stale `deliberate` is unavoidable — and
// harmless, because every consumer reads `focusOwnerNow()` LIVE at the moment of the press. With
// the caret outside a terminal the flag is never consulted.
import { classifyFocusOwner } from "../voice/dictationFocus";

/** Set by the pane's auto-focus, cleared by the focusin it causes (or by the timer, if none comes). */
let autoFocusPending = false;
let autoFocusTimer: ReturnType<typeof setTimeout> | null = null;

/** Whether the caret's CURRENT presence in a terminal was user-initiated. */
let deliberate = false;

/**
 * Announce that the app — not the user — is about to move the caret into a terminal.
 *
 * Call IMMEDIATELY before the focus call, so the focusin it produces is the next one observed.
 */
export function markTerminalAutoFocus(): void {
  autoFocusPending = true;
  if (autoFocusTimer !== null) clearTimeout(autoFocusTimer);
  autoFocusTimer = setTimeout(() => {
    autoFocusPending = false;
    autoFocusTimer = null;
  }, 0);
}

/** Read and clear the pending auto-focus mark. */
function consumeAutoFocusMark(): boolean {
  const pending = autoFocusPending;
  autoFocusPending = false;
  if (autoFocusTimer !== null) {
    clearTimeout(autoFocusTimer);
    autoFocusTimer = null;
  }
  return pending;
}

/** Did the USER move the caret into the terminal it is currently in? */
export function terminalFocusWasDeliberate(): boolean {
  return deliberate;
}

/**
 * The user just INTERACTED with a terminal — a pointer press inside it, or a keystroke xterm reported
 * through `onData`. Promotes provenance to deliberate.
 *
 * ══ WHY A FOCUS EVENT ALONE IS NOT ENOUGH (roborev 55722) ═══════════════════════════════════════
 * `AgentPane` parks the caret in the terminal on `visible && ptyReady`, which marks it automatic. From
 * then on the textarea is ALREADY the active element, so:
 *
 *   - a click inside it raises no `focusin` — focus is not moving, and
 *   - every keystroke is swallowed by xterm's own handler (`cancel()` calls `stopPropagation()`), so no
 *     window-level listener ever sees it.
 *
 * Provenance decided purely at focus time therefore stayed "automatic" for the whole session in which
 * the user was actually working in that terminal — the exact misclassification that makes the wrong
 * Escape ladder apply. `onData` is the honest signal: xterm fires it for USER input only, never for
 * programmatic writes.
 *
 * Idempotent and cheap on purpose: it is called once per keystroke, so it must cost nothing once the
 * verdict is already `true`.
 */
export function noteTerminalInteraction(): void {
  if (deliberate) return;
  deliberate = true;
  // A real interaction also settles any pending auto-focus mark: whatever the app was about to claim
  // about this caret, the user has now overruled it.
  consumeAutoFocusMark();
}

/**
 * Install the focus-provenance tracker. Returns an uninstall function.
 *
 * CAPTURE PHASE, on the document: a focusin must be judged before any component that stops
 * propagation can hide it, exactly as the cable's own pointer gesture does.
 */
export function installTerminalFocusIntentTracker(
  doc: Document | undefined = globalThis.document,
): () => void {
  if (!doc) return () => {};
  const onFocusIn = (e: Event) => {
    if (classifyFocusOwner(e.target as Element | null) !== "terminal") {
      // The caret is somewhere else now. Whatever intent brought it into a terminal is spent.
      deliberate = false;
      consumeAutoFocusMark();
      return;
    }
    deliberate = !consumeAutoFocusMark();
  };
  doc.addEventListener("focusin", onFocusIn, true);
  // Seed from the live DOM: at install time the caret may ALREADY be in a terminal (a relaunch that
  // restores focus, a pane that mounted before this ran) with no transition left to observe. Such a
  // caret was not placed by any gesture this tracker saw, so it reads as automatic — the direction
  // that preserves the historical Escape behavior.
  deliberate = false;
  return () => {
    doc.removeEventListener("focusin", onFocusIn, true);
    consumeAutoFocusMark();
  };
}

/** Test seam: forget both the mark and the verdict. */
export function resetTerminalFocusIntent(): void {
  deliberate = false;
  consumeAutoFocusMark();
}
