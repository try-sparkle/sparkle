// @vitest-environment jsdom
//
// The account dropdown's SELECTED row is one of the app's few live `pillFill` surfaces, and it is
// the only site in the app that painted `C.muted` on one.
//
// That pairing cannot be fixed by re-deriving a palette value. `muted` clears the ink floor on the
// depth PLANES and on no chrome fill in either theme — every fill far enough from the planes to
// read as a fill is already past the backdrop `muted` can be read on, in dark and in light alike.
// (theme/chromeContrast.test.ts asserts exactly that, in both directions, so this is a measured
// fact rather than a claim.) The fix is therefore at the SITE: the row's three 10px secondary lines
// take the on-fill ink when the row is selected, and the plane ink when it is not.
//
// This guards the pairing, not the hex: the ink values themselves are floored in
// theme/chromeContrast.test.ts. What can regress here is a future edit re-pointing one of these
// spans back at `C.muted` for consistency with the unselected row — which is the exact reasoning
// that put it there in the first place.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountBadge } from "./AgentPane";
import { C } from "../theme/colors";
import type { Account, Identity } from "../services/accountStore";

afterEach(() => cleanup());

const acct = (id: string, nickname: string, isDefault = false): Account => ({
  id,
  nickname,
  configDir: `/tmp/${id}`,
  isDefault,
  createdAt: 0,
});
const ident = (id: string, email: string | null): Identity => ({
  id,
  email,
  organization: null,
  accountUuid: null,
});

/** Two accounts: the chosen one carries an alias (nickname ≠ email) AND is the default, so the
 *  selected row renders two of the three secondary lines; the other is signed out, so the
 *  UNSELECTED row renders the "not signed in" one. One render covers both states. */
function setup() {
  const accounts = [acct("a", "work-alias", true), acct("b", "spare")];
  const identities = [ident("a", "me@example.com")];
  render(
    <AccountBadge
      accounts={accounts}
      identities={identities}
      chosen={accounts[0]!}
      open
      onToggle={vi.fn()}
      onPick={vi.fn()}
    />,
  );
}

describe("AccountBadge — the selected row's secondary ink is the on-fill ink, never `muted`", () => {
  it("the SELECTED row (a `pillFill` backdrop) paints its 10px lines in `cream`", () => {
    setup();
    // The alias line and the "default" marker both sit on the selected row's pillFill.
    for (const text of ["work-alias", "default"]) {
      const span = screen.getByText(text);
      expect(span.style.color, `${text} is read on C.pillFill`).toBe(C.cream);
      expect(span.style.color).not.toBe(C.muted);
    }
  });

  it("an UNSELECTED row is transparent over the menu plane, so it keeps the plane ink", () => {
    setup();
    // The signed-out account is not the chosen one — its row has no fill, so `muted` is correct
    // there and must NOT be swept up by the fix above.
    const span = screen.getByText("not signed in");
    expect(span.style.color).toBe(C.muted);
  });

  it("the selected row really is the `pillFill` surface these inks were measured against", () => {
    // Without this the two assertions above could keep passing while the row's fill moved to
    // something else entirely — and the ink choice would then be justified by a surface that is
    // no longer there, which is the failure mode this whole ladder exists to stop.
    setup();
    // The alias text appears only in the selected row's secondary line, so walking up from it
    // lands on that row and nothing else.
    const selectedRow = screen.getByText("work-alias").closest("div") as HTMLElement;
    expect(selectedRow.style.background).toBe(C.pillFill);
  });
});
