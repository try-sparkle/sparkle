// EVERY PERMISSION MODE'S CHROME BAR MUST READ AS CLAUDE CODE — the regression that made a
// large fraction of the fleet undrivable (2026-08-20).
//
// `claudeCodeScreen`'s family C was a list of MODE LITERALS. Claude Code has five permission modes
// and the list named two of them, so the three it did not name scored ZERO on family C. With only
// the composer box left, the score is 1 against a threshold of 2, and the consequences are all
// fail-CLOSED: `terminalWriteRefusal` answers `alternate-screen`, the picker cannot be read, and
// the row renders "Needs you" over a pane the human sees nothing in.
//
// ══ WHY THIS IS A TABLE AND NOT FIVE ASSERTIONS ════════════════════════════════════════════════
// The defect was not "a literal is wrong". It was "the SET of literals is incomplete, and nothing
// noticed because the two that survived were the two most sessions run in". A test that pinned only
// the broken modes would go green on the fix and stay silent the next time Claude Code adds a sixth
// mode — which is the same rot one release later. Driving every captured bar through one table means
// adding a mode to `capturedScreens.fixture.ts` without teaching the detector about it is a FAILING
// test, not a silent hole.
import { describe, expect, it } from "vitest";
import { claudeCodeMarkerFamilies, isClaudeCodeScreen } from "./claudeCodeScreen";
import {
  ACCEPT_EDITS_COMPOSER_2_1_237,
  BYPASS_COMPOSER_2_1_237,
  MANUAL_MODE_COMPOSER_2_1_237,
  PLAN_MODE_COMPOSER_2_1_237,
  PLAN_MODE_SETTLED_2_1_237,
} from "./capturedScreens.fixture";

/** Every mode bar Claude Code 2.1.237 draws, as captured. `wasBlind` records which ones the
 *  pre-fix detector refused — kept in the table so the next reader can see that the two survivors
 *  are exactly why this went unnoticed, rather than having to dig it out of git history. */
const MODE_SCREENS: ReadonlyArray<{ name: string; screen: string; wasBlind: boolean }> = [
  { name: "manual mode on", screen: MANUAL_MODE_COMPOSER_2_1_237, wasBlind: false },
  { name: "bypass permissions on", screen: BYPASS_COMPOSER_2_1_237, wasBlind: false },
  { name: "plan mode on", screen: PLAN_MODE_COMPOSER_2_1_237, wasBlind: true },
  { name: "plan mode on (settled, no /effort row)", screen: PLAN_MODE_SETTLED_2_1_237, wasBlind: true },
  { name: "accept edits on", screen: ACCEPT_EDITS_COMPOSER_2_1_237, wasBlind: true },
];

describe("isClaudeCodeScreen — Claude Code 2.1.237 permission-mode chrome bars", () => {
  for (const { name, screen } of MODE_SCREENS) {
    it(`recognises a live composer whose bar reads "${name}"`, () => {
      expect(isClaudeCodeScreen(screen)).toBe(true);
    });

    // THE COUNT, NOT ONLY THE BOOLEAN — `claudeCodeMarkerFamilies`' own doc requires this. A change
    // that made the mode bar count as the COMPOSER BOX rather than as chrome would still satisfy
    // `isClaudeCodeScreen`, from a single piece of evidence, which is the collapse that module
    // forbids. Two INDEPENDENT families is the property under test.
    it(`scores two independent marker families on the "${name}" bar`, () => {
      expect(claudeCodeMarkerFamilies(screen)).toBeGreaterThanOrEqual(2);
    });
  }

  // THE GUARD THIS FIX MUST NOT WEAKEN. The whole point of the threshold is that a pager showing a
  // document is not written into, and widening family C is exactly the change that could erode it.
  // A mode bar quoted in prose, with no composer box under it, must still be refused.
  it("still refuses a document that merely QUOTES a mode bar", () => {
    const quoted = [
      "Notes on the new permission modes:",
      "",
      "  Claude Code now prints `⏵⏵ accept edits on (shift+tab to cycle)` at the bottom of the",
      "  screen, replacing the older `⏸ manual mode on · ? for shortcuts` bar.",
      "",
      "(END)",
    ].join("\n");
    expect(isClaudeCodeScreen(quoted)).toBe(false);
  });
});
