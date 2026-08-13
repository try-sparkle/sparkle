// THE TWO ROW GESTURES, AS THE BROWSER ACTUALLY DELIVERS THEM.
//
// A build row means two different things depending on how you press it (`engine/cable`'s
// `mountsOnRowActivation`): a single click seats the agent, a double click patches the cable. Tests
// across half a dozen files drive both, and getting the SEQUENCE wrong is how a test comes to prove
// something no user can reach — the failure this repo's AGENTS.md calls its #1 fleet-wide finding.
//
// Two mistakes are easy and neither is loud:
//
//   • `fireEvent.click(row)` defaults to `detail: 0`, which is NOT a mouse press. Zero means "no
//     pointer sequence" — an assistive-tech activation or a synthetic jump — and that class DOES
//     mount. A test written that way asserts the AT path while reading as though it asserted the
//     mouse one.
//   • `fireEvent.doubleClick(row)` alone dispatches `dblclick` with no clicks before it. A real
//     double press delivers click, click, THEN dblclick, and the two clicks are exactly where a
//     race between "select" and "mount" would show up. Skipping them hides it.
//
// So both live here, once, spelled the way the DOM spells them.
import { fireEvent, screen } from "@testing-library/react";
import { FOLD_DOUBLE_PRESS_GRACE_MS } from "../components/AgentRow";

/** One plain mouse press. `detail: 1` is what a real single click carries. */
export function singleClickRow(row: HTMLElement): void {
  fireEvent.click(row, { detail: 1 });
}

/** A real double press: two clicks with rising `detail`, then the `dblclick` the browser raises. */
export function doubleClickRow(row: HTMLElement): void {
  fireEvent.click(row, { detail: 1 });
  fireEvent.click(row, { detail: 2 });
  fireEvent.doubleClick(row, { detail: 2 });
}

/**
 * RIGHT-CLICK A ROW — which opens its CONTEXT MENU, and nothing else.
 *
 * The row's third gesture used to have two different answers depending on where it landed: over the
 * agent name it began an inline rename instantly, and anywhere else it threw the detail card across
 * the pane. Founder, 2026-08-13: *"Renaming of the builder row should now go into right click of the
 * builder row. It should be an option in the right click menu."* So there is ONE answer now, the
 * menu, everywhere on the row — and both of the old outcomes are items inside it.
 *
 * Takes ANY element inside the row and dispatches on the ROW itself, which is where a user aiming at
 * the menu presses. Passing the row is a no-op (`closest` matches self).
 *
 * `at` is the cursor position the menu anchors to. Omit it for the KEYBOARD path: Shift+F10 and the
 * Menu key raise `contextmenu` with no coordinates, which the row reads as "anchor to my own rect".
 */
export function openRowMenu(elInRow: HTMLElement, at?: { clientX: number; clientY: number }): void {
  fireEvent.contextMenu(elInRow.closest('[data-hint="agent"]') ?? elInRow, at);
}

/** The row context menu, if one is open. `null` is the ordinary resting state, so it is a query. */
export function rowMenu(): HTMLElement | null {
  return screen.queryByTestId("row-context-menu");
}

/**
 * OPEN A ROW'S DETAIL CARD — now a right click on the ROW followed by its "Open details…" item.
 *
 * ~30 cases across six files reach the card through this helper, and what they want is the CARD, not
 * the gesture that produces it. That gesture has changed twice: it was a left click, then a bare
 * right click on the row (except over the name, which claimed it for rename), and it is now an item
 * in the row's context menu. Each time, the tests that spelled the gesture out by hand had to be
 * rewritten; the ones that called this helper did not.
 *
 * So the contract here is the OUTCOME — "this row's detail card is open" — and the steps are an
 * implementation detail of the helper. `AgentSidebar.rowContextMenu.test.tsx` pins that it still
 * delivers what its name promises, because every caller depends on that silently.
 */
export function openAgentCard(elInRow: HTMLElement): void {
  openRowMenu(elInRow);
  fireEvent.click(screen.getByTestId("row-menu-open-details"));
}

/**
 * START A ROW'S INLINE RENAME — now the menu's Rename item, for the same reason as above.
 *
 * Rename has had three homes in as many days: a double click on the name (which killed the mount
 * over the row's largest target), a bare right click on the name (which gave one row two different
 * right-click answers), and now a menu item. Tests that want the EDITOR should say so and let this
 * carry whatever the gesture currently is.
 */
export function renameViaRowMenu(elInRow: HTMLElement): void {
  openRowMenu(elInRow);
  fireEvent.click(screen.getByTestId("row-menu-rename"));
}

/**
 * WAIT OUT THE FOLD'S DOUBLE-PRESS GRACE — see `AgentRow.FOLD_DOUBLE_PRESS_GRACE_MS`.
 *
 * Folding a subtree is DEFERRED by one double-click interval, because the click that folds may turn
 * out to be the first half of a double press that mounts the concierge (roborev 63145, finding 3).
 * There is no way to know at the moment the click arrives, so the fold waits to see whether a
 * `dblclick` follows and cancels it.
 *
 * The consequence for tests is that a fold is no longer readable on the line after the click. Both
 * directions need this, and the second is the one that is easy to get wrong:
 *
 *   • asserting a fold DID happen — prefer `await waitFor(() => expect(...))`, which also keeps the
 *     deferred store write inside React's `act`.
 *   • asserting a fold did NOT happen — `await settleFold()` first. Without it, "no fold" is
 *     indistinguishable from "not yet", and the test passes against a version that folds late.
 */
export function settleFold(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, FOLD_DOUBLE_PRESS_GRACE_MS + 60));
}
