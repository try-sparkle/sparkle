// Telling "the user put their caret here" apart from "code put it here".
//
// The two compose surfaces use focus to decide who owns dictated speech (dictationStore
// .voiceSurface): whichever box the user is actually in should be the one the mic types into. But
// `onFocus` cannot tell the two apart on its own, and these textareas are focused BY CODE
// constantly — a pane becoming visible or un-minimizing, a prompt insert, an attachment drop, a
// block sent to the composer as text, the concierge box after a send or a capture-window handoff.
// Letting any of those name the voice surface silently re-aims the microphone with no voice
// gesture from the user at all, and it STICKS, because nothing moves the arbiter back
// (roborev 54222).
//
// Reading it off the gesture instead — claim on pointerdown/keydown — closes that but opens the
// mirror hole: TAB-NAVIGATING into a composer produces neither event on the box being entered
// (Tab's keydown fires on the element being LEFT), so a keyboard-only user's caret sits in one box
// while the wake word types into another (roborev 54228). Focus is the right signal; it just needs
// the provenance attached.
//
// So: route every APP-INITIATED focus through `focusQuietly` and let `onFocus` ask.
//
// A depth counter around the call is not sufficient on its own, and the reason is easy to miss. The
// focusing steps only dispatch `focus` synchronously when the document's top-level traversable HAS
// SYSTEM FOCUS; when it does not, `.focus()` merely sets the focused area and the event fires later,
// on window activation. This app focuses these boxes from an inactive window routinely (the capture
// window's handoff, a pane revealing itself behind another window), so that deferred event would
// arrive with the counter back at zero and read as the user's own — silently re-aiming the mic, the
// exact thing this module exists to stop (roborev 54239). The element is therefore TAGGED as well,
// and the tag survives until the event it belongs to actually arrives.
//
// The counter is kept alongside the tag for the synchronous case, where it is the cheaper answer,
// and because nesting must not clear the flag early.

import { isEditableElement } from "../engine/focusGuard";

let depth = 0;
/** The element the app most recently focused whose focus event has not arrived yet. ONE slot, not a
 *  set: only the latest app-initiated focus can still be in flight, and an unbounded set of tags is
 *  how this goes wrong — a tag whose event never comes would sit there forever and swallow the
 *  user's next genuine focus of that element (roborev 54245). */
let pendingEl: HTMLElement | null = null;
let watching = false;

/** Drop the pending tag as soon as focus lands anywhere else — that move superseded ours, so its
 *  event is never coming. Registered once, lazily, on the document we are actually focusing into.
 *
 *  `focusin` (bubbles) rather than `focus`, and on the document rather than the React root, so this
 *  runs AFTER the component's own onFocus has had its chance to consume the tag: React 18 listens
 *  at the root container, which is inside the document, so its handler fires first on the way up. */
function watch(doc: Document): void {
  if (watching) return;
  watching = true;
  doc.addEventListener("focusin", (e) => {
    if (pendingEl && e.target !== pendingEl) pendingEl = null;
  });
}

/** Focus `el` WITHOUT it counting as the user choosing this box. Use for EVERY focus() the app
 *  performs — including the ones the user asked for.
 *
 *  That last part is the rule, and it reads backwards until you see why: a plain `.focus()` cannot
 *  express "the user asked for this box". The motivating case was historical — the ⌘J chord
 *  un-minimizing a composer whose textarea was not rendered yet, so the caret landed a render later
 *  from some other call. No pane has a composer now (see SparkleAgentPane), so that exact sequence is
 *  gone, but the SECOND half of the problem is structural and permanent: when the caret is ALREADY in
 *  the box, `.focus()` dispatches nothing at all, so there is no event to carry a claim on. Both
 *  cases silently lose it.
 *
 *  So surfaces are NAMED BY THE CALL SITE, never inferred from the focus event. The live sites that
 *  do this are Concierge/ComposeBox's composeFocusSeq effect, MicButton (which names the surface it
 *  is arming), and LogoWaveform — each calls `setVoiceSurface` outright and then focuses quietly like
 *  everything else. (SparkleAgentPane's `onUserRequestFocus` used to be the canonical example and is
 *  no longer a caller at all; it went with that pane's composer.)
 *
 *  Safe on null, so call sites keep their optional-chaining shape. */
export function focusQuietly(el: HTMLElement | null | undefined): void {
  if (!el) return;
  // Already focused → `.focus()` is a no-op that dispatches nothing, so tagging would leave a mark
  // no event ever clears, and the user's NEXT genuine focus of this element would read as ours.
  if (el.ownerDocument?.activeElement === el) return;
  if (el.ownerDocument) watch(el.ownerDocument);
  pendingEl = el;
  depth += 1;
  try {
    el.focus();
  } finally {
    depth -= 1;
  }
}

/** Did the focus event being handled right now come from the app rather than from the user?
 *
 *  Pass the element the event landed on. CONSUMES the tag: each {@link focusQuietly} call answers
 *  for exactly one focus event, so a later, genuine focus of the same element reads as the user's.
 *
 *  Note what this does NOT try to answer: "did the user ASK for this box". That is a different
 *  question, it cannot be recovered from a focus event, and trying to carry it here as a latch was
 *  a mistake — an unfulfilled ask has no natural expiry and no target, so it ends up promoting some
 *  later, unrelated app-driven focus (roborev 54259). The places that need it say so structurally
 *  instead, at the point where the user's gesture is still identifiable: ComposeBox's composeFocusSeq
 *  effect (whose every caller is a user gesture), MicButton's arm handlers, and LogoWaveform. Each
 *  names its own surface outright.
 *
 *  This USED to say "both places", naming SparkleAgentPane's `onUserRequestFocus` as one of exactly
 *  two. That call site no longer exists — it was removed with that pane's composer, and the pane now
 *  passes Terminal no focus callbacks at all — so a reader looking for the second surface-naming site
 *  would not have found one. Cited as evidence that this design is sound, a dangling reference is
 *  worse than no example (roborev 55606). */
export function isProgrammaticFocus(el?: HTMLElement | null): boolean {
  if (el && pendingEl === el) {
    pendingEl = null;
    return true;
  }
  return depth > 0;
}

/** Test seam: forget any in-flight tag or request. Module state outlives a component tree, so a
 *  test that focuses quietly and never delivers the event would otherwise leak into the next one. */
export function resetProgrammaticFocusForTest(): void {
  pendingEl = null;
  depth = 0;
}

/** True for an element the user TYPES INTO: a text `<input>`, a `<textarea>`, or any contentEditable
 *  host (the xterm terminal's key sink is a `<textarea class="xterm-helper-textarea">`, so it
 *  qualifies).
 *
 *  This DELEGATES to `engine/focusGuard`'s `isEditableElement` rather than re-deriving the rule.
 *  It used to be a local copy that answered `true` for EVERY `<input>` — including `type="checkbox"`
 *  / `"radio"` / `"range"` / `"button"`, and including `disabled` / `readOnly` fields — none of which
 *  own a caret. The guard below reads this as "the user is typing over there, leave them alone", so
 *  a caret parked on a settings checkbox permanently suppressed the dictation caret-return: every
 *  segment still landed in the composer, but focus stayed on the checkbox, so the user's next Enter
 *  toggled the checkbox instead of sending (roborev 54718/54719). Three near-copies of this DOM
 *  predicate existed; `isEditableElement` is the one with `NON_TEXT_INPUT_TYPES`, `disabled` and
 *  `readOnly` handling and its own unit tests, so it is now the only one. `focusGuard` imports
 *  nothing, so depending on it here cannot cycle. */
export const isEditableTarget = isEditableElement;

/** {@link focusQuietly}, but a NO-OP when the caret currently sits in a DIFFERENT editable element.
 *
 *  Use for a BACKGROUND focus pull — one driven by a timer or an incoming event rather than by the
 *  user's own gesture — where bringing the caret back to `el` must never YANK it out of a field the
 *  user is actively typing in. The motivating case is dictation (sparkle-d2ec): the composer pulled
 *  focus to itself on EVERY committed segment, so while the mic was live a user typing in the
 *  terminal (or any other box) had focus ripped away every couple of seconds — the terminal and the
 *  composer both went dead to the keyboard while the mouse still worked, and only a restart (which
 *  stops dictation) recovered. Skipping the pull when another editable element holds focus keeps
 *  dictation from stealing the keyboard, while still refocusing when focus sits on a non-editable
 *  surface (a mic button, the body) — the legitimate "the mic UI took focus, bring the caret back"
 *  flow this function was added for.
 *
 *  Returns whether it actually focused. Safe on null. */
export function focusQuietlyUnlessTypingElsewhere(el: HTMLElement | null | undefined): boolean {
  if (!el) return false;
  const active = el.ownerDocument?.activeElement ?? null;
  if (active && active !== el && isEditableTarget(active)) return false;
  focusQuietly(el);
  return true;
}
