// A CONTROL GESTURE IS NOT A TEXT SELECTION.
//
// THE FOUNDER'S REPORT, verbatim: "we're gonna have to account for this when we do the drag to
// understand because if I'm dragging and scrolling the scroll bar, I don't want it to be
// implementing drag to understand. So anything where there is an action that is click drag should
// not trigger drag to understand."
//
// Dragging a scrubber handle, a column resizer or a slider sweeps the pointer across the page with
// the button held. The browser happily extends a text selection underneath that gesture — it has no
// idea the user is aiming at a control — so every selection-driven affordance in this column
// (copy-on-selection, the quote chiclet, and drag-to-understand when it lands) fires for a gesture
// that was never about the text.
//
// ── WHY AN OPT-OUT ATTRIBUTE AND NOT A SELECTOR LIST ──────────────────────────────────────────────
// The founder's explicit instruction. A hardcoded list of selectors ("the rail, the handle, the
// resizer, …") is a list the NEXT control will forget to join: it is maintained in a file its author
// never opens, and the failure is silent — the new control simply behaves wrongly, and nothing here
// changes to say so. A control declares itself instead:
//
//     <div data-control-gesture="yes">   // a press in here is a control gesture, not a selection
//
// The declaration sits on the thing it describes, so it arrives and leaves with that control.
//
// ── WHY A POINTERDOWN LATCH AND NOT A TARGET TEST ─────────────────────────────────────────────────
// `selectionchange` CARRIES NO TARGET. It is dispatched on `document` with no reference to what the
// user pressed on, so a consumer reading it cannot ask "was this gesture aimed at a control?" — the
// question has no answer at the moment it needs asking. The answer only exists at `pointerdown`,
// which is where this module records it and holds it for the length of the drag.
//
// ── ORDERING (AGENTS.md; bead sparkle-40va0) ──────────────────────────────────────────────────────
// The latch is armed from a CAPTURE-phase listener on `document`. Capture on the document runs
// before every bubbling handler in the app and before every listener on any deeper node, whatever
// order the listeners were registered in — so a consumer cannot read the latch in the window between
// the press and the arming. A bubble-phase listener here would lose that race to any handler bound
// on the control itself, which is precisely the interleaving `controlGesture.test.ts` pins.
//
// ── RELEASE ───────────────────────────────────────────────────────────────────────────────────────
// `pointerup` and `pointercancel`, plus a `blur` backstop on the window — the same backstop
// `ThreadScrubber` already uses for a release that never arrives (its `onCancel`). A latch that
// sticks would deafen every selection affordance for the rest of the session, which is far worse
// than the bug it fixes, so it releases on more paths than it strictly needs.

/** The opt-out attribute a control sets on itself. Value is the string "yes". */
export const CONTROL_GESTURE_ATTR = "data-control-gesture";

/**
 * Does this event target sit inside (or on) a control that opted out? Walks ancestors.
 *
 * The walk is a hand-rolled loop rather than `closest("[data-control-gesture]")` on purpose: the
 * nearest element CARRYING the attribute may carry a value other than "yes", and `closest` would
 * stop there and report "content" for a target that is nonetheless inside an opted-out control
 * further up. Only a "yes" ends the walk; anything else is just another node to climb past.
 */
export function isControlGestureTarget(target: EventTarget | null): boolean {
  const node = target instanceof Node ? target : null;
  let el: Element | null = node instanceof Element ? node : (node?.parentElement ?? null);
  while (el) {
    const value = el.getAttribute(CONTROL_GESTURE_ATTR);
    // Case-insensitive on the VALUE only, and only because it is free here. The ATTRIBUTE name is
    // already case-insensitive in HTML; nothing else is normalised.
    if (value !== null && value.trim().toLowerCase() === "yes") return true;
    el = el.parentElement;
  }
  return false;
}

/** Is a control gesture in flight right now? Module-level, because `selectionchange` reaches its
 *  consumers with no reference to the gesture that caused it — see this file's header. */
let active = false;

/** One entry per watched document, ref-counted: several hooks arm the same watcher and each gets its
 *  own disposer, but the listeners are installed once. */
interface Watch {
  count: number;
  remove: () => void;
}
const watches = new Map<Document, Watch>();

/**
 * Arms a document-level pointerdown/pointerup watcher. Returns a disposer.
 * While a control gesture is in flight, `isControlGestureActive()` is true.
 *
 * Safe to call from every consumer that needs the latch — the calls are ref-counted, so N consumers
 * share one set of listeners and the last disposer takes them down.
 */
export function watchControlGesture(doc: Document = document): () => void {
  const existing = watches.get(doc);
  if (existing) {
    existing.count += 1;
    return disposerFor(doc);
  }

  const onPointerDown = (e: Event) => {
    active = isControlGestureTarget(e.target);
  };
  const release = () => {
    active = false;
  };

  // CAPTURE — see ORDERING in this file's header.
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("pointerup", release, true);
  doc.addEventListener("pointercancel", release, true);
  const view = doc.defaultView;
  view?.addEventListener("blur", release);

  watches.set(doc, {
    count: 1,
    remove: () => {
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("pointerup", release, true);
      doc.removeEventListener("pointercancel", release, true);
      view?.removeEventListener("blur", release);
    },
  });
  return disposerFor(doc);
}

/** One-shot disposer: a second call is a no-op, so a double cleanup cannot tear the watcher down
 *  while another consumer is still relying on it. */
function disposerFor(doc: Document): () => void {
  let spent = false;
  return () => {
    if (spent) return;
    spent = true;
    const watch = watches.get(doc);
    if (!watch) return;
    watch.count -= 1;
    if (watch.count > 0) return;
    watch.remove();
    watches.delete(doc);
    // Disposing mid-drag must not leave the latch set for whoever arms it next — a stuck latch is
    // silent and permanent.
    active = false;
  };
}

/** Is a control gesture (a press that landed on an opted-out control) currently in flight? */
export function isControlGestureActive(): boolean {
  return active;
}
