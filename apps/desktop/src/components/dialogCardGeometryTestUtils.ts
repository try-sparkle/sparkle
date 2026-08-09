// Shared assertion for the ONE rule every self-painted dialog card obeys, stated once so five test
// files cannot each drift their own version of it.
//
// ── WHY THIS EXISTS RATHER THAN A SOURCE SWEEP ────────────────────────────────────────────────
// It replaces a `modalChrome.test.ts` sweep that tried to answer "does THIS element carry that
// declaration?" by reading source text. That sweep went through seven rounds of review and every
// round found a real hole one level down:
//
//   file-scoped        → an unrelated `maxHeight` elsewhere in the file satisfied the check
//   ±8-line window     → a longer card hid the banned declaration; a COMMENT could hide the bound
//   opener-pattern     → grouped styles (`const styles = { card: {…}, body: {…} }`) matched the
//                        outer object, so a sibling's ceiling passed and a sibling's correct
//                        scroll failed
//   line-granular      → a one-line object nets to zero and is walked past — the very shape the
//                        doc comment cited as fixed
//   column-aware in    → still line-granular on the way OUT, so a sibling sharing the closing line
//                        leaks in, untrimmed
//
// The pattern is the point: each fix to the scoping introduced a new false green one level down,
// and twice the fixture written to prove the fix used a shape that could not reproduce the bug.
// Hand-rolled brace counting is the wrong tool for "which element carries this style" — the DOM
// already knows, exactly, with no parsing.
//
// The trade is honest and worth naming: a render assertion covers only components someone wrote a
// test for, where the sweep nominally covered files nobody has written yet. `modalChrome.test.ts`
// keeps that half as a plain MEMBERSHIP check — a new file painting a dialog card reds until it is
// added here — which needs no parsing and cannot false-positive.

/** What a bounded dialog card looks like in the DOM. */
export interface CardGeometry {
  /** The card: the painted, floating surface. */
  card: HTMLElement;
  /** The element that actually scrolls. MUST NOT be the card — see below. */
  scrollport: HTMLElement | null;
}

/**
 * Assert a dialog card is bounded to the viewport and that its scroll lives on a DESCENDANT.
 *
 * The second half is the one that shipped a bug. A card that is itself the scrollport scrolls its
 * OWN top chrome out of view, and `AccountLoginModal`'s only dismiss control is the `Done` button in
 * its header — so on exactly the short window the ceiling exists for, the user scrolls to reach the
 * content and the way out leaves the screen. `maxHeight` alone is not enough either: a ceiling with
 * nowhere to scroll clips the overflow, which makes the controls unreachable rather than off-screen.
 */
export function expectBoundedCard({ card, scrollport }: CardGeometry): void {
  const maxHeight = card.style.maxHeight;
  if (!/(vh|%)$/.test(maxHeight)) {
    throw new Error(
      `dialog card is not bounded to the viewport: maxHeight=${JSON.stringify(maxHeight)}. ` +
        `A centred card with no relative ceiling overflows the window in BOTH directions, and ` +
        `nothing scrolls back to what went off the top. Use MODAL_MAX_HEIGHT from ModalShell.`,
    );
  }
  if (card.style.overflowY === "auto" || card.style.overflow === "auto") {
    throw new Error(
      `the CARD is the scrollport — its own header scrolls away with the content. Put ` +
        `overflowY:"auto" + minHeight:0 on a body region beneath the pinned chrome instead ` +
        `(see ModalShell, or PromoteToCloudDialog).`,
    );
  }
  if (scrollport == null) {
    throw new Error(
      `dialog card is bounded but nothing scrolls, so the overflow is CLIPPED — the controls are ` +
        `unreachable rather than off-screen, which is not an improvement.`,
    );
  }
  if (scrollport === card) {
    throw new Error(`the scrollport must be a DESCENDANT of the card, not the card itself.`);
  }
  if (scrollport.style.overflowY !== "auto") {
    throw new Error(
      `the named scrollport does not scroll: overflowY=${JSON.stringify(scrollport.style.overflowY)}.`,
    );
  }
  // ── THE VERTICAL SHRINK CHAIN ───────────────────────────────────────────────────────────────
  // `min-height: auto` is a flex item's default and refuses to shrink below its content — but ONLY
  // on the item's MAIN axis. So the declaration that makes a card's ceiling bind is `min-height: 0`
  // on every item in the chain whose parent is a COLUMN flex container, and it is not necessarily
  // the scrollport itself.
  //
  // `SettingsDialog` is the case that proves it and the case an earlier version of this helper got
  // wrong. Its chain is card(column) > bodyRow(row) > pane(scrollport). What binds the ceiling is
  // `bodyRow`'s `min-height: 0`; the pane is a ROW item, so its own `min-height: auto` already
  // resolves to 0 on the cross axis, and its `min-width: 0` is a horizontal-overflow guard with no
  // bearing on height at all. Asserting the pane's `minWidth` — as this helper briefly did — let
  // `bodyRow`'s `minHeight: 0` be deleted with the suite still green, while the pane scrolled a
  // region the card had already clipped. That is an assertion sitting ADJACENT to the mechanism
  // rather than on it, which is the failure this whole file exists to stop.
  //
  // Walking the chain and reading each parent's own `flexDirection` asks the DOM instead of guessing
  // — no caller has to declare an axis, and a dialog that grows another wrapper is covered for free.
  // CONTAINMENT FIRST. The walk below terminates on `node === card` OR on running out of parents,
  // and without this it cannot tell those apart: a scrollport that is not inside the card (a portal,
  // a wrapper hoisted above it, or simply two `getByTestId` queries that no longer share an
  // ancestor — which is exactly how callers obtain the pair) makes the loop climb to <html>, break,
  // and report success having asserted nothing.
  if (!card.contains(scrollport)) {
    throw new Error(
      `the scrollport must be a DESCENDANT of the card; it is not, so nothing here constrains it.`,
    );
  }

  let checked = 0;
  for (let node: HTMLElement | null = scrollport; node && node !== card; node = node.parentElement) {
    const parent = node.parentElement;
    if (!parent) break;
    // Default `flex-direction` is `row`; only a column parent imposes the height constraint.
    if (parent.style.flexDirection !== "column") continue;
    checked++;
    const value = node.style.minHeight;
    if (value === "" || parseFloat(value) !== 0) {
      throw new Error(
        `<${node.tagName.toLowerCase()}${node.dataset.testid ? ` data-testid="${node.dataset.testid}"` : ""}> ` +
          `is a COLUMN flex item between the card and its scrollport, so it needs minHeight:0 or ` +
          `the card's ceiling never binds and the scrollport scrolls an already-clipped region: ` +
          `minHeight=${JSON.stringify(value)}.`,
      );
    }
  }

  // A WALK THAT INSPECTED NOTHING IS NOT A PASS. jsdom loads no stylesheet, so only INLINE
  // `flexDirection` is visible here: a card that moves its column declaration to a class or a
  // styled-component would make the loop above check zero nodes and report success — an assertion
  // that cannot fail, which is the shape this whole file exists to prevent. Every bounded card in
  // this app stacks its chrome in a column, so zero is a broken query or a changed layout, not a
  // legitimate state.
  if (checked === 0) {
    throw new Error(
      `no COLUMN flex item was found between the card and its scrollport, so nothing pins the ` +
        `ceiling and this assertion checked nothing. Either the layout changed, or the column ` +
        `declaration is no longer inline (jsdom cannot see a stylesheet).`,
    );
  }
}
