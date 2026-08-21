// THE GAP BETWEEN "CLOSE PLANNING BOARD" AND THE FILTER — pinned in BOTH hosts.
//
// Founder, 2026-08-20: *"Let's have a little bit more space between closed planning board and the
// filter."*
//
// WHY A SOURCE SCAN RATHER THAN A RENDER. The value's whole risk is DRIFT between two files, and a
// render test can only ever see the host it mounted. `Workspace.planBoardSpansPair.test.tsx` and
// `SatelliteApp.test.tsx` each pin their own half and both stayed green through the last drift —
// which is exactly the hole `BoardFilterBar.tsx`'s header warns about. The fact that has to be
// asserted is "neither host hard-codes its own number", and that is a statement about the SOURCE.
//
// This mirrors `Workspace.planBoardSpansPair.test.tsx`'s own `assertPinnedNeedle` approach, which
// already reads Workspace.tsx off disk for the same reason.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLAN_BOARD_HEADER_COLUMN_GAP,
  PLAN_BOARD_HEADER_ROW_GAP,
} from "./planBoardHeader";

const SRC = join(__dirname, "..");
const HOSTS: ReadonlyArray<readonly [string, string]> = [
  ["Workspace.tsx", join(SRC, "components", "Workspace.tsx")],
  ["SatelliteApp.tsx", join(SRC, "satellite", "SatelliteApp.tsx")],
];

/**
 * The plan-board header element's OPENING TAG only — `gap: 8` is a common string elsewhere in both
 * files, so a fixed-size window is both too small (each host carries ~40 lines of comment between
 * the testid and the style) and too blunt (it would run on into unrelated styles). Bounding on the
 * first child element is exact.
 */
function headerBlock(source: string): string {
  const at = source.indexOf('data-testid="plan-board-header"');
  expect(at).toBeGreaterThan(-1);
  const end = source.indexOf("<HeaderLink", at);
  expect(end).toBeGreaterThan(at);
  return source.slice(at, end);
}

describe("the plan board header's horizontal gap is declared once and read by both hosts", () => {
  it("is WIDER than the band's own 8px rhythm — otherwise the founder's ask did nothing", () => {
    // THE ASSERTION THAT FLIPS. Before the change both hosts declared `gap: 8`, so the seam and the
    // vertical rhythm were the same number. A test that only checked "the two hosts agree" would
    // have passed then too.
    expect(PLAN_BOARD_HEADER_COLUMN_GAP).toBeGreaterThan(PLAN_BOARD_HEADER_ROW_GAP);
  });

  for (const [name, path] of HOSTS) {
    it(`${name} reads the shared constant instead of hard-coding a number`, () => {
      const block = headerBlock(readFileSync(path, "utf8"));
      expect(block).toContain("columnGap: PLAN_BOARD_HEADER_COLUMN_GAP");
      expect(block).toContain("rowGap: PLAN_BOARD_HEADER_ROW_GAP");
      // The shape that is now forbidden: a single-axis `gap` puts the widened seam on the wrapped
      // row's vertical rhythm too, which is not what was asked for.
      expect(block).not.toMatch(/\bgap: \d/);
    });
  }
});
