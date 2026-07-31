// WHICH repo the concierge's single PR chip lists, across both pairs.
//
// The app used to carry an `OpenPrMenu` in EACH project tab strip, each scoped to its own side. One
// chip means one of those scopes wins, and the naive answer — the project store's
// `selectedProjectId` — is documented by `ProjectTabsBar` as the RIGHT pair's: selecting on the left
// writes only `uiStore.leftProjectId` and deliberately does not move the global id. Reading it alone
// made the left pair's pull requests unreachable from anywhere, and produced NO affordance at all
// when nothing was selected on the right (roborev 56141).
//
// This is the precedence, tested as the pure function it is — no host mount, no stores.
import { describe, expect, it } from "vitest";
import { prChipProject } from "./ConciergeHost";

const P = (id: string) => ({ id });
const [mobile, sparkle, docs] = [P("mobile"), P("sparkle"), P("docs")];
const open = [mobile, sparkle, docs];

describe("prChipProject", () => {
  it("prefers the global selection — the right answer whenever there is one pair", () => {
    expect(prChipProject(open, "sparkle", "mobile")).toBe(sparkle);
  });

  // The case that used to yield NO PR affordance in the whole app: only a left-pair project is open,
  // so the global selection is null and reading it alone returns null.
  it("falls back to the LEFT pair's slot when nothing is selected on the right", () => {
    expect(prChipProject(open, null, "mobile")).toBe(mobile);
  });

  // The strip validated its selection against the projects it actually held (`resolveSideSelection`).
  // Without that the chip can list a project that has no tab anywhere — closed, or moved away.
  it("ignores a selection that is not open, on either side", () => {
    expect(prChipProject([sparkle], "mobile", null)).toBe(sparkle);
    expect(prChipProject([sparkle], null, "mobile")).toBe(sparkle);
  });

  it("still finds a repo when neither slot names an open project", () => {
    expect(prChipProject(open, null, null)).toBe(mobile);
    expect(prChipProject(open, "gone", "also-gone")).toBe(mobile);
  });

  // Nothing open is the one case with no answer, and it must be null rather than a stale project —
  // the chip renders nothing at all, which is correct for a shell with no repo to ask about.
  it("returns null only when nothing is open", () => {
    expect(prChipProject([], "sparkle", "mobile")).toBeNull();
  });

  // The precedence must be an ORDER, not a preference for whichever happens to be first in the list.
  it("takes the global selection even when the left slot sorts earlier", () => {
    expect(prChipProject([mobile, sparkle], "sparkle", "mobile")).toBe(sparkle);
  });
});
