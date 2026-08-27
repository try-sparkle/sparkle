/** BORROWING A NODE'S INLINE STYLE — capture the DECLARATION, and yield to whoever else writes it.
 *
 * ══ BUG ONE: THE SHORTHAND HOLDING A `var()` (bead `sparkle-8qd0ey`) ═══════════════════════════
 * Transient UI effects — a flash, a drag ghost, a measurement probe — borrow a node's inline style,
 * paint over it, and put it back. The obvious way to save it is to read the properties you are
 * about to write:
 *
 *     const prev = el.style.backgroundColor;   // ❌
 *     el.style.backgroundColor = FLASH;
 *     …later…  el.style.backgroundColor = prev;
 *
 * That round trip DESTROYS the declaration whenever the node is painted with a CSS **shorthand
 * holding a `var()`** — which, in a themed app, is every themed node. A shorthand carrying a
 * `var()` gives each of its longhands a *pending-substitution* value, and per CSSOM a longhand read
 * of a pending-substitution value serializes as the **EMPTY STRING**:
 *
 *     <button style="background: var(--c-epic-card-fill)">
 *     el.style.getPropertyValue("background")        -> "var(--c-epic-card-fill)"
 *     el.style.getPropertyValue("background-color")  -> ""          <- the snapshot, in full
 *
 * So the save reads `""`, the restore writes `""`, and the node's own colour is gone — and in a
 * real engine, writing a rival longhand over the shorthand and then removing it takes the
 * shorthand's colour with it. React never repaints it, because the `background` PROP never changed.
 * That shipped as the founder's *"when i click on 'column' view i get a gray bar all the way
 * across"* — the `<button>` sitting on the UA `ButtonFace` default, permanently, until unmount
 * (`sparkle-huw924.15`; measured in real WebKit and real Chromium).
 *
 * The defect is invisible in review because the capture and the restore look perfectly symmetric.
 * The only tell is that the node paints with a shorthand rather than a longhand — a fact that lives
 * in a DIFFERENT file from the borrow.
 *
 * ── WHY cssText, AND NOT "SAVE BOTH FORMS" ──
 * Saving the shorthand *and* its longhand fixes the one pair you thought of. It does not fix the
 * next borrow, because the enumeration is the flaw: you cannot know which of `background`,
 * `background-image`, `border`, `font`, `inset`, `transition` or `mask` the node happened to be
 * authored with, and a property you did not enumerate is a property you silently drop.
 *
 * `cssText` is the declaration **as authored** — every property, shorthands unexpanded, `var()`
 * references intact, in source order. Reading it captures the node's whole inline style without
 * naming a single property.
 *
 * ══ BUG TWO: THE NODE IS REACT'S, AND A WHOLESALE RESTORE STEALS IT BACK ═══════════════════════
 * Re-declaring that snapshot UNCONDITIONALLY trades the first bug for its mirror image, and this
 * one is worse because it reverts a write React believes it has already made.
 *
 * React writes inline styles by DIFFING `lastProps.style` against `nextProps.style`. So if a
 * re-render lands inside the borrowed window and we then re-declare the pre-borrow text, React's
 * bookkeeping says the new value is on the node and the DOM says otherwise — and because the next
 * render diffs against that same bookkeeping, **React never writes it again**. The node is stuck at
 * a stale value indefinitely. It is the same DOM/vdom desync as bug one, reached from the far side.
 *
 * That window is not exotic; here it is 1.2 seconds wide and the beads store polls every 5s.
 * Concretely: a row renders `background: selected ? … : "transparent"` and friends, the flash
 * borrows it while selected, the user clicks a sibling, React paints this row unselected — and the
 * restore puts the *selected* look back for good.
 *
 * ── SO THE RESTORE IS CONDITIONAL ──
 * The borrow records the declaration it LEAVES BEHIND. At restore time, that record either still
 * matches the node or it does not, and the two cases want opposite things:
 *
 *   * **Unchanged** — nobody else wrote. Re-declare the authored text wholesale. This is the common
 *     path and it is exactly the bug-one fix: no property is named, so none can be forgotten.
 *   * **Changed** — somebody else wrote, and in this app that is React, which cannot recover from
 *     being reverted. So the borrower's own writes are withdrawn *individually* and everything else
 *     is left strictly alone. Which properties were "the borrower's own" is not hand-listed either:
 *     it is derived by diffing the painted declaration against the authored one through the CSSOM.
 *     A property whose value is no longer the one the borrow left is skipped — that is precisely the
 *     property the other writer claimed, and it is not ours to put back.
 *
 * ── WHAT WOULD BE BETTER STILL ──
 * The real fix for a React-owned node is not to write inline styles on it at all: set a data
 * attribute and let a stylesheet rule paint it, so there is nothing to borrow or restore. That is a
 * larger change than the callers here can absorb, and it is the direction to take this if a third
 * borrow site appears.
 *
 * ══ USING IT ═══════════════════════════════════════════════════════════════════════════════════
 *     const restore = borrowInlineStyle(el, (style) => {
 *       style.setProperty("background", FLASH_FILL);   // paint over it however you like
 *     });
 *     …later…
 *     restore();                                       // yours withdrawn, everyone else's kept
 *
 * The paint is a CALLBACK rather than something you do after the call returns, because the borrow
 * has to record the declaration it left behind and it cannot know when you have finished writing.
 * Passing it in is what makes that record impossible to forget.
 *
 * Two rules for the borrowed window:
 *
 *   1. **Write the SHORTHAND** (`setProperty("background", …)`, not `backgroundColor`). A shorthand
 *      write replaces the node's own shorthand rather than shadowing it with a rival longhand, so
 *      the node reads coherently *during* the borrow too, not merely after it — and on the
 *      interference path a longhand of yours cannot be withdrawn to a shorthand-with-`var()` value,
 *      because that value serializes as `""` (bug one, from inside the remedy for bug two).
 *   2. **A write meant to OUTLIVE the effect does not belong inside the window.** On the
 *      no-interference path the restore re-declares the authored text and drops it.
 */

/** Snapshot `el`'s inline style declaration, run `paint` against it, and return the function that
 *  withdraws the paint.
 *
 *  The returned restore is idempotent, it restores the ABSENCE of a `style` attribute as faithfully
 *  as it restores a present one, and it defers to any writer that touched the node during the
 *  window — see the header. */
export function borrowInlineStyle(
  el: HTMLElement,
  paint: (style: CSSStyleDeclaration) => void,
): () => void {
  // THE WHOLE OF THE BUG-ONE FIX IS THIS ONE READ. `cssText` is the authored declaration; every
  // per-property alternative re-introduces the enumeration whose gaps are the bug. Do not
  // "simplify" it into a list of longhands — see the header.
  const authored = el.style.cssText;
  // A node with no `style` attribute and a node with `style=""` both read `cssText === ""`, and
  // assigning `""` back would materialize the attribute on the first. Restoring the attribute's
  // absence keeps the borrow observationally invisible to anything reading attributes (a CSS
  // `[style]` selector, a snapshot test, a mutation observer counting attribute changes).
  const hadAttribute = el.hasAttribute("style");
  // The authored text, PARSED, so the withdrawal path can ask it for a property's prior value
  // without doing string surgery on the declaration. A detached node keeps this out of the
  // document entirely — nothing observes it, and it is never attached.
  const priorStyle = el.ownerDocument.createElement("span").style;
  priorStyle.cssText = authored;

  paint(el.style);

  // The declaration EXACTLY as the borrow leaves it. Anything different at restore time was written
  // by somebody else, and that somebody wins — see bug two.
  const painted = el.style.cssText;
  // What the paint actually wrote, derived from the CSSOM rather than hand-listed: every property
  // now declared whose value differs from the authored one. (A property the paint REMOVED is not
  // recoverable this way and is not restored on the interference path; the wholesale path gets it.)
  const written: { name: string; value: string }[] = [];
  for (let i = 0; i < el.style.length; i++) {
    const name = el.style.item(i);
    const value = el.style.getPropertyValue(name);
    if (value !== priorStyle.getPropertyValue(name)) written.push({ name, value });
  }

  return () => {
    if (el.style.cssText === painted) {
      // NOBODY ELSE WROTE. Put the whole declaration back — the bug-one fix, naming no property.
      el.style.cssText = authored;
      // Assigning `""` above MATERIALIZES the attribute on a node that never carried one, so the
      // absence is restored as a second step rather than as an `else`. (Written as two independent
      // statements on purpose: an `if/else` pair cannot be mutation-tested a line at a time,
      // because commenting either branch orphans the other and the file stops parsing.)
      if (!hadAttribute) el.removeAttribute("style");
      return;
    }
    // SOMEBODY ELSE WROTE — React, which cannot recover from being reverted. Withdraw only what
    // this borrow put there, and only where it is still standing.
    for (const { name, value } of written) {
      // Not ours any more: the other writer claimed this property. Leave it exactly as it is.
      if (el.style.getPropertyValue(name) !== value) continue;
      const prior = priorStyle.getPropertyValue(name);
      if (prior === "") el.style.removeProperty(name);
      else el.style.setProperty(name, prior, priorStyle.getPropertyPriority(name));
    }
    // The node carried no `style` attribute before the borrow and carries nothing now — so the
    // other writer's contribution was itself withdrawn, and the attribute should go too.
    if (!hadAttribute && el.style.length === 0) el.removeAttribute("style");
  };
}
