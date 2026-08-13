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
