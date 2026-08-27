// ══ WHEN A CONTAINER IS A CLICK TARGET, ITS INTERACTIVE DESCENDANTS ARE NOT ═════════════════════
//
// THE DEFECT THIS EXISTS TO END (bead `sparkle-92md3i`). Two changes that were each correct on
// their own, each with a green suite, collided the moment they were merged: one made a card BODY a
// click target so a press anywhere on it collapses the card; the other added LINKS inside that
// body. Neither branch could see the defect, because neither branch contained both halves — a
// press on a link then navigated AND collapsed the card in one gesture. The other branch's own
// idempotence test is what caught it, failing because the first press had removed the element the
// second press needed.
//
// ══ WHY THIS AND NOT `stopPropagation` ON THE LINK ══════════════════════════════════════════════
// A per-descendant `stopPropagation` is a rule the NEXT contributor must remember, on a file they
// may never open — and the descendant is frequently not theirs to edit at all: a link rendered by
// `<Markdown>` on behalf of a caller, or whatever a `footer` prop happens to contain. That is the
// same shape as the original bug, deferred. So the check belongs on the CONTAINER, once, where it
// is right by default for every descendant that has not been written yet.
//
// It does not REPLACE the existing `stopPropagation` wrappers on a container that has them: a
// component that portals its menu out of the DOM (React bubbles through the COMPONENT tree, not
// the DOM tree) is not a DOM descendant at all, so this cannot see it. The two are complementary —
// this one is the default that holds when nobody remembered.

/**
 * Elements whose activation is the WHOLE point of the gesture, so a container-level handler must
 * not also fire. Kept to things that genuinely consume a click:
 *
 *   * `a[href]` — a bare `<a>` with no `href` is not a link and is not focusable; it is styled text.
 *   * the native form controls, plus `summary` (the disclosure control of `<details>`) and `label`
 *     (a click on one is forwarded to the control it names).
 *   * the ARIA roles that announce themselves as operable, for a control built on a `<span>`.
 *   * `contenteditable`, where a click places a caret.
 */
const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "label",
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="textbox"]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
].join(",");

/**
 * Did this click land on an interactive descendant of `boundary`?
 *
 * `true` means the gesture already has an owner and the container must stay out of it. `false`
 * means the press landed on inert body and the container's own handler is the only thing that can
 * answer it.
 *
 * ══ THE BOUNDARY IS NOT OPTIONAL DECORATION ═══════════════════════════════════════════════════
 * Pass `e.currentTarget`. Two reasons, both of which produce a WRONG answer without it:
 *
 *   1. `closest()` walks the whole ancestor chain, so a card mounted inside somebody else's
 *      `<button>` would report every press on its inert body as interactive and the card would
 *      never open again.
 *   2. The container ITSELF may match the selector — a clickable row that carries `role="button"`
 *      is the common case. It is not its own interactive descendant, so it is excluded by identity
 *      rather than by containment.
 *
 * ══ WHAT IT DELIBERATELY DOES NOT DO ══════════════════════════════════════════════════════════
 * It does not consult `disabled`. A disabled control still swallows the gesture as far as the user
 * is concerned, and a container that collapsed out from under a press on a greyed-out button would
 * read as the same bug.
 */
export function isInteractiveClickTarget(
  target: EventTarget | null,
  boundary: EventTarget | null,
): boolean {
  // `EventTarget` covers `window` and `document` too, and a text node is never the target of a
  // click in a browser — but a hand-built event in a test can carry anything, so this narrows
  // rather than casts.
  if (!(target instanceof Element)) return false;
  const hit = target.closest(INTERACTIVE_SELECTOR);
  if (hit === null) return false;
  if (!(boundary instanceof Element)) return true;
  // THE CONTAINMENT RULE. `closest` walks the whole document, so the owner it found may live
  // OUTSIDE the container entirely — a card mounted inside somebody else's `<button>`. That press
  // is not ours to stay out of, and treating it as one would report every press on the card's own
  // inert body as interactive, so the card would never open again. `hit` is the NEAREST
  // interactive ancestor, so once it is outside the boundary there is nothing interactive between
  // the target and the boundary at all.
  if (!boundary.contains(hit)) return false;
  // THE IDENTITY RULE. The container is not a descendant of itself — see the boundary note above.
  // It must be asked AFTER containment, since `contains` counts an element as containing itself.
  if (hit === boundary) return false;
  return true;
}
