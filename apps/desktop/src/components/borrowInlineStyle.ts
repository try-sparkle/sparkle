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
 *     is left strictly alone. A property whose value is no longer the one the borrow left is
 *     skipped — that is precisely the property the other writer claimed, and it is not ours to put
 *     back.
 *
 * ══ BUG THREE: "WHICH PROPERTIES WERE MINE" CANNOT BE ANSWERED BY ENUMERATING THE DECLARATION ══
 * That withdrawal needs the borrower's OWN property names, and the obvious way to get them is to
 * diff the painted declaration against the authored one — walk `el.style.item(i)` and keep what
 * changed. That is bug one again, wearing the remedy for bug two as a disguise, because
 * **`item()` enumerates LONGHANDS**: the pending-substitution values a `var()` shorthand puts on
 * its longhands read as `""` on BOTH sides of that diff. Two ways it goes wrong, and the shipped
 * caller sits on the first:
 *
 *   1. **`var()` shorthand painted over a `var()` shorthand → the paint is never withdrawn.**
 *      `EpicRow` is authored `background: var(--c-epic-card-fill)` and the flash paints
 *      `var(--c-epic-pill-fill)`. Both are pending-substitution, so every `background-*` longhand
 *      reads `""` on the node AND on the authored copy, the diff records nothing, and the
 *      interference path has nothing to take back. The row keeps the flash fill for good — and
 *      React will not repaint it, because its `background` prop never changed.
 *   2. **`var()` shorthand painted over with a plain value → the authored declaration is
 *      destroyed.** The painted longhands ARE recorded, their authored counterparts read `""`, so
 *      the withdrawal removes them and leaves `background` undeclared instead of restoring the
 *      `var()`. That is the original gray bar (`sparkle-huw924.15`) rebuilt inside its own fix.
 *
 * Note what does NOT help: writing the shorthand. How a property was written has no bearing on how
 * the declaration is enumerated, so the old rule 1 could not protect this path — the CSSOM answers
 * in longhands no matter how you asked.
 *
 * ── SO THE PAINT IS RECORDED AS IT WRITES, IN THE CALLER'S OWN NAMES ──
 * `paint` is handed a RECORDING view of the declaration, which notes every property name it is
 * asked to set or remove and then forwards the write untouched. The withdrawal then works in the
 * names the caller actually used — and a shorthand name round-trips perfectly even when its
 * longhands do not: `getPropertyValue("background")` gives back the `var()` text a longhand read
 * cannot see, and `removeProperty("background")` clears the whole shorthand. Nothing is enumerated,
 * so there is nothing for the enumeration to lose. It also picks up what the diff structurally
 * could not: a property the paint REMOVED is a name like any other, and comes back.
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
 * The paint is a CALLBACK rather than something you do after the call returns for two reasons: the
 * borrow has to record the declaration it left behind, and it has to see the writes as they happen.
 * Neither is knowable from outside, and passing the paint in is what makes both impossible to
 * forget.
 *
 * Three rules for the borrowed window:
 *
 *   1. **Prefer the SHORTHAND** (`setProperty("background", …)`, not `backgroundColor`). A
 *      shorthand write replaces the node's own shorthand rather than shadowing it with a rival
 *      longhand, so the node reads coherently *during* the borrow too, not merely after it.
 *      RECORDING THE NAME IS ONLY HALF OF WHAT A LONGHAND NEEDS: the withdrawal still has to find
 *      the value to put back, and `priorStyle.getPropertyValue("background-color")` under an
 *      authored `background: var(…)` reads `""` — pending substitution again, from the value side
 *      this time. So a write whose property has no authored value of its own is withdrawn through
 *      the OVERLAPPING-DECLARATION path below rather than by a plain `removeProperty` — which would
 *      delete an authored declaration in either direction: a rival longhand takes its shorthand's
 *      colour with it, and a shorthand removal clears the whole family including an authored
 *      longhand. That path exists and is tested; the preference stands because it is the shape a
 *      themed node is usually authored with, so the withdrawal is a plain value put back.
 *   2. **A write meant to OUTLIVE the effect does not belong inside the window.** On the
 *      no-interference path the restore re-declares the authored text and drops it.
 *   3. **Write properties, not `cssText`.** Assigning the whole declaration names no property, so
 *      nothing is recorded for it — and enumerating what is declared afterwards would be the lossy
 *      longhand read this helper exists to avoid, turning an unnameable write into a list of
 *      longhand REMOVALS that destroys the authored shorthand. So a `cssText` paint is simply not
 *      withdrawn on the interference path: the paint outliving the effect is a leak, shredding the
 *      node's authored declaration is data loss, and between the two the leak is the one that can
 *      be seen and fixed. (The undisturbed path still re-declares the authored text, as ever.)
 */

/** The CSS property name for a camelCased CSSOM attribute — `backgroundColor` → `background-color`,
 *  `webkitMaskImage` → `-webkit-mask-image`, `cssFloat` → `float`. A custom property is spelled the
 *  same both ways and passes through untouched. */
function cssName(attribute: string): string {
  if (attribute.startsWith("--")) return attribute;
  if (attribute === "cssFloat") return "float";
  const hyphenated = attribute.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  // A VENDOR PREFIX IS A LEADING HYPHEN THE CAMELCASE FORM CANNOT SPELL: the CSSOM attribute is
  // `webkitMaskImage`, and the property is `-webkit-mask-image`, not `webkit-mask-image`.
  return /^(?:webkit|moz|ms|o)-/.test(hyphenated) ? `-${hyphenated}` : hyphenated;
}

/** `style`, with every property name it is asked to write noted in `touched` on the way through.
 *
 *  IT RECORDS NAMES, NOT VALUES, AND IT CHANGES NOTHING ELSE — every write is forwarded to the real
 *  declaration untouched and every read comes straight off it, so a paint cannot tell it apart from
 *  the node's own `style`. The names are the whole point: they are what lets the withdrawal ask the
 *  CSSOM about `background` rather than about `background-color`, which is the difference between
 *  restoring a `var()` shorthand and destroying it (see bug three in the header). */
function recordingStyle(style: CSSStyleDeclaration, touched: Set<string>): CSSStyleDeclaration {
  return new Proxy(style, {
    get(target, property) {
      if (property === "setProperty") {
        return (name: string, value: string, priority?: string) => {
          touched.add(name);
          target.setProperty(name, value, priority);
        };
      }
      if (property === "removeProperty") {
        // A REMOVAL IS A WRITE. The old diff could not see one at all — the property is simply gone
        // from the painted declaration, so nothing enumerates it — and it therefore never came back
        // on the interference path.
        return (name: string) => {
          touched.add(name);
          return target.removeProperty(name);
        };
      }
      const value: unknown = Reflect.get(target, property);
      // A CSSOM METHOD MUST RUN AGAINST THE REAL DECLARATION, not against the proxy, or it re-enters
      // these traps with `this` pointing at something that is not a `CSSStyleDeclaration`.
      return typeof value === "function" ? (value as (...a: never[]) => unknown).bind(target) : value;
    },
    set(target, property, value) {
      // `style.color = …`, the other way a paint writes. `cssText` is deliberately NOT recorded:
      // it names no property, and enumerating the declaration afterwards to find out what it wrote
      // would hand the withdrawal a list of longhands to REMOVE — the exact destruction of the
      // authored shorthand this file exists to prevent. Recording nothing leaves that paint
      // standing on the interference path, which is rule 3's stated bargain: a visible leak beats
      // silent data loss.
      if (typeof property === "string" && property !== "cssText") touched.add(cssName(property));
      // Assigned on the TARGET rather than through `Reflect.set(target, property, value, receiver)`:
      // with the proxy as receiver the CSSOM setter would come back through this trap.
      (target as unknown as Record<string, unknown>)[property as string] = value;
      return true;
    },
  });
}

/** One declaration exactly as it was AUTHORED — shorthand unexpanded, `var()` intact. */
interface AuthoredDeclaration {
  readonly name: string;
  readonly value: string;
  readonly priority: string;
}

/** The authored declarations, parsed out of the `cssText` STRING rather than read back through the
 *  CSSOM. That is the point: the string is the only place a shorthand still exists by name, since
 *  every enumeration of the parsed declaration answers in longhands. (An inline style cannot carry
 *  an unescaped `;` inside a value, so splitting on it is safe for everything a borrow target is
 *  authored with.) */
function authoredDeclarations(authored: string): AuthoredDeclaration[] {
  const parsed: AuthoredDeclaration[] = [];
  for (const part of authored.split(";")) {
    const at = part.indexOf(":");
    if (at === -1) continue;
    const name = part.slice(0, at).trim();
    let value = part.slice(at + 1).trim();
    let priority = "";
    if (/!\s*important$/i.test(value)) {
      value = value.replace(/!\s*important$/i, "").trim();
      priority = "important";
    }
    if (name !== "") parsed.push({ name, value, priority });
  }
  return parsed;
}

/** The property names `name: value` occupies once the CSSOM has had it — a shorthand's longhands in
 *  an engine that expands them, and just the name itself for a longhand (or in jsdom, which keeps
 *  shorthands whole; that answer is correct there, because there the properties really are
 *  independent). This is the one thing longhand enumeration is actually good FOR: asked of a
 *  scratch declaration holding ONE declaration, it is a membership test rather than a lossy read of
 *  the node. */
function expansionOf(el: HTMLElement, name: string, value: string): Set<string> {
  const probe = el.ownerDocument.createElement("span").style;
  probe.setProperty(name, value);
  const names = new Set<string>();
  for (let i = 0; i < probe.length; i++) names.add(probe.item(i));
  return names;
}

/** Every authored declaration whose property family OVERLAPS `name` — in BOTH directions.
 *
 *  WHY THIS EXISTS: the withdrawal reads the value to put back with
 *  `priorStyle.getPropertyValue(name)`, and that read is `""` for both of the shapes below, for the
 *  same pending-substitution reason as bug three — now on the VALUE side. A withdrawal that takes
 *  `""` to mean "this was never authored" reaches a bare `removeProperty(name)`, and in both shapes
 *  that removal destroys an authored declaration:
 *
 *    * **The paint wrote a LONGHAND under an authored shorthand** (`background-color` over
 *      `background: var(…)`). Removing the rival longhand takes the shorthand's colour with it.
 *    * **The paint wrote a SHORTHAND over an authored longhand** (`background` over
 *      `background-color: #c0392b`, the ordinary React `style={{ backgroundColor }}` shape).
 *      `removeProperty("background")` clears the WHOLE family, the authored longhand included.
 *
 *  Both are `sparkle-huw924.15` from different sides, so the question is asked symmetrically: does
 *  this authored declaration cover `name`, or does `name` cover it? */
function authoredDeclarationsTouching(
  el: HTMLElement,
  declarations: readonly AuthoredDeclaration[],
  name: string,
  value: string,
): AuthoredDeclaration[] {
  const painted = expansionOf(el, name, value);
  // Written as three statements rather than one `||` chain so each direction can be mutated — and
  // therefore proved covered — on its own line; a continuation line of an expression cannot be.
  return declarations.filter((declaration) => {
    if (declaration.name === name) return true;
    if (painted.has(declaration.name)) return true;
    return expansionOf(el, declaration.name, declaration.value).has(name);
  });
}

/** Every property those declarations and `name` between them occupy — the family whose values have
 *  to be untouched before a withdrawal may re-declare into it. */
function familyOf(
  el: HTMLElement,
  declarations: readonly AuthoredDeclaration[],
  name: string,
  value: string,
): string[] {
  const family = expansionOf(el, name, value);
  for (const declaration of declarations) {
    for (const property of expansionOf(el, declaration.name, declaration.value)) family.add(property);
  }
  return [...family];
}

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

  // THE NAMES THE PAINT WRITES, RECORDED AS IT WRITES THEM. Deriving them afterwards by diffing the
  // declaration cannot work — see bug three — because that diff can only speak in longhands.
  const touched = new Set<string>();
  paint(recordingStyle(el.style, touched));

  // The declaration EXACTLY as the borrow leaves it. Anything different at restore time was written
  // by somebody else, and that somebody wins — see bug two.
  const painted = el.style.cssText;
  // Each recorded name paired with the value the paint left under it, read in the SAME name it was
  // written with. That pairing is what tells "still mine" from "claimed by the other writer" later;
  // a removal reads `""` here, which is exactly what it should be compared against.
  const authoredNow = authoredDeclarations(authored);
  const written = [...touched].map((name) => {
    const value = el.style.getPropertyValue(name);
    // ONLY the names with no authored value of their own need the recovery machinery, and whether
    // they do is knowable now — so the common path (a shorthand painted over a shorthand) computes
    // nothing extra, and the family snapshot below is taken while it still describes the paint.
    if (priorStyle.getPropertyValue(name) !== "") return { name, value, recovery: undefined };
    const declarations = authoredDeclarationsTouching(el, authoredNow, name, value);
    const siblings = familyOf(el, declarations, name, value).map((property) => ({
      name: property,
      value: el.style.getPropertyValue(property),
    }));
    return { name, value, recovery: { declarations, siblings } };
  });

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
    // A `cssText` paint recorded no name at all, so this loop simply has nothing to withdraw for
    // it — see rule 3, and `recordingStyle`'s note on why guessing would be worse.
    for (const { name, value, recovery } of written) {
      // Not ours any more: the other writer claimed this property. Leave it exactly as it is.
      if (el.style.getPropertyValue(name) !== value) continue;
      const prior = priorStyle.getPropertyValue(name);
      if (prior !== "") {
        el.style.setProperty(name, prior, priorStyle.getPropertyPriority(name));
        continue;
      }
      // `""` DOES NOT MEAN "NOT AUTHORED" — see `authoredDeclarationsTouching`. Re-declaring into a
      // property family is a WIDE write, though: it lands on every longhand in it, so it must not
      // happen while somebody else holds one. A sibling that has moved since the paint belongs to
      // the other writer, and reverting it is bug two — the worse of the two — so this borrow's
      // property is left standing instead. A visible leak beats a silent revert React cannot undo.
      const claimed = recovery?.siblings.some(
        (sibling) => sibling.name !== name && el.style.getPropertyValue(sibling.name) !== sibling.value,
      );
      if (claimed === true) continue;
      el.style.removeProperty(name);
      for (const declaration of recovery?.declarations ?? []) {
        el.style.setProperty(declaration.name, declaration.value, declaration.priority);
      }
    }
    // The node carried no `style` attribute before the borrow and carries nothing now — so the
    // other writer's contribution was itself withdrawn, and the attribute should go too.
    if (!hadAttribute && el.style.length === 0) el.removeAttribute("style");
  };
}
