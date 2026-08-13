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
import { fireEvent } from "@testing-library/react";
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
 * OPEN A ROW'S DETAIL CARD — a RIGHT click on the ROW, never on its NAME.
 *
 * The row has a THIRD gesture and it is not evenly distributed: `contextmenu` opens the card
 * (`AgentRow`'s `openCard`) EXCEPT over the agent name, which claims it for rename and stops it
 * propagating (`FittedAgentName`; founder, 2026-08-12: *"double click mounts. right click to
 * rename."*). Two dozen tests reached the card with `fireEvent.contextMenu(screen.getByText(name))`
 * — convenient, and aimed at the one part of the row that no longer opens it.
 *
 * So this takes ANY element inside the row and dispatches on the ROW, which is where a user aiming
 * at the card would press. Passing the row itself is a no-op (`closest` matches self), so it is safe
 * to use everywhere and there is one fewer rule for the next test to get wrong.
 */
export function openAgentCard(elInRow: HTMLElement): void {
  fireEvent.contextMenu(elInRow.closest('[data-hint="agent"]') ?? elInRow);
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
