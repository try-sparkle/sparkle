// DRAG-TO-UNDERSTAND, RUNG ONE — the pure decision half (epic sparkle-0kbf4s).
//
// THE FOUNDER'S OBJECTIVE, verbatim: "The objective is that a user is never confused. They always
// understand what to do. They understand how a feature works, they know how to use it."
//
// THE MECHANISM HE ASKED FOR: "the CLICK AND DRAG IS A VERY UNDERUTILIZED ACTION. There really has
// never been a concept that you can click and drag over ANYTHING without having to click a button
// first… And when you do that, a system will intelligently read and understand what you just
// clicked and dragged and then interact with you around it in a smart way. Meaning if I click and
// drag some text and I highlight some text, the system can anticipate that I probably just want to
// copy that text. And so I click and drag some text and it gives me a little copy icon."
//
// This module answers ONE question — *was that gesture an invitation to help?* — as a pure function
// over a Selection and the element the press landed on, so the rule is testable without a DOM
// gesture and without jsdom's selection gaps (docs/jsdom-test-caveats.md).
//
// ── WHY THIS OFFERS AND NEVER ACTS ────────────────────────────────────────────────────────────────
// The epic names the failure mode directly: "picking the RIGHT default action, because a wrong guess
// is worse than no guess — it trains the user that the feature is unreliable and they stop using it.
// Design the fallback: when confidence is low, offer rather than assume." So rung one paints a copy
// affordance and waits to be clicked. It never writes the clipboard on the strength of a drag.
//
// That is also what keeps it clear of the two surfaces that DO act on their own selections — the
// terminal (auto-copy + SelectionPopup) and the concierge thread (useCopyOnSelection). Both were
// tuned over several roborev rounds against a real founder bug report, and neither is re-litigated
// here: they declare themselves with SELECTION_AFFORDANCE_ATTR and this stands down.
import { isControlGestureTarget } from "./Concierge/controlGesture";

/**
 * The opt-out a surface sets on itself to say "I already answer my own text selections; the global
 * affordance must not double up on me."
 *
 *     <div data-selection-affordance="own">   // terminal pane, concierge column
 *
 * AN ATTRIBUTE, NOT A SELECTOR LIST HERE — the founder's explicit instruction, recorded in
 * controlGesture.ts: "a hardcoded list of selectors is a list the NEXT control will forget to join:
 * it is maintained in a file its author never opens, and the failure is silent." The declaration
 * travels with the surface that owns it, so a surface that grows its own affordance later opts out
 * by editing itself rather than by editing this file.
 */
export const SELECTION_AFFORDANCE_ATTR = "data-selection-affordance";

/** The one value that means "this subtree owns its selections". */
export const SELECTION_AFFORDANCE_OWN = "own";

/**
 * Does this node sit inside (or on) a surface that already owns its own selection affordance?
 *
 * A hand-rolled ancestor walk rather than `closest("[data-selection-affordance]")`, for the same
 * reason `isControlGestureTarget` hand-rolls its own: the nearest element CARRYING the attribute may
 * carry some other value, and `closest` would stop there and report "not owned" for a node that is
 * nonetheless inside an owning surface further up. Only the "own" value ends the walk.
 */
export function ownsSelectionAffordance(target: EventTarget | null): boolean {
  const node = target instanceof Node ? target : null;
  let el: Element | null = node instanceof Element ? node : (node?.parentElement ?? null);
  while (el) {
    const value = el.getAttribute(SELECTION_AFFORDANCE_ATTR);
    // Case-insensitive on the VALUE only, matching controlGesture's treatment of its own attribute.
    if (value !== null && value.trim().toLowerCase() === SELECTION_AFFORDANCE_OWN) return true;
    el = el.parentElement;
  }
  return false;
}

/** What a qualifying gesture yields: the words the user swept, and nothing else. */
export interface UnderstandGesture {
  /** The selected text, exactly as `Selection.toString()` rendered it. Never blank. */
  text: string;
}

export interface UnderstandGestureInput {
  /** The live selection at the moment the gesture ended. */
  selection: Selection | null;
  /** What the press that began this gesture landed on — `null` when no press was seen. */
  pressTarget: EventTarget | null;
  /** Was a control gesture (scrubber, resizer, slider) in flight? See controlGesture.ts. */
  controlGestureActive?: boolean;
}

/**
 * Is this finished gesture an invitation to help — and if so, over what text?
 *
 * Returns `null` for everything that is not, which is most gestures. Each refusal below is a rule
 * somebody paid for; none of them is defensive coding.
 */
export function understandGesture({
  selection,
  pressTarget,
  controlGestureActive = false,
}: UnderstandGestureInput): UnderstandGesture | null {
  // A PLAIN CLICK IS NOT A DRAG. A click collapses the selection, and firing an affordance for one
  // would put a chip on screen every time the user clicked anything at all — the single fastest way
  // to make this feature something people want turned off.
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

  // A CONTROL DRAG IS NOT A TEXT SELECTION. The founder, verbatim (bead sparkle-bjbhw6, DEFECT 4):
  // "we're gonna have to account for this when we do the drag to understand because if I'm dragging
  // and scrolling the scroll bar, I don't want it to be implementing drag to understand. So anything
  // where there is an action that is click drag should not trigger drag to understand."
  //
  // Asked TWICE, of two different sources, because they answer at different moments. The press
  // target is what this gesture actually began on; the latch covers a gesture already in flight
  // whose press this caller never saw. Either one is disqualifying.
  if (controlGestureActive) return null;
  if (isControlGestureTarget(pressTarget)) return null;

  // THE SURFACE ALREADY ANSWERS FOR ITSELF — don't put a second affordance over the terminal's
  // popup or a second clipboard story over the concierge's. Keyed on the PRESS rather than on the
  // selection's endpoints, because the press is the only part of the gesture whose location is
  // unambiguous: a drag that overshoots out of a surface still belongs to the surface it began in.
  if (ownsSelectionAffordance(pressTarget)) return null;

  const text = selection.toString();
  // WHITESPACE IS AN ACCIDENT OF DRAGGING, never an intent. `useCopyOnSelection` learned the same
  // thing: "a blank clipboard and a 'Copied' toast for it are both worse than doing nothing."
  if (!text.trim()) return null;

  return { text };
}
