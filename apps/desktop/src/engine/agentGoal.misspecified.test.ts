import { describe, expect, it } from "vitest";
import {
  GOAL_REWRITE_INSTRUCTION,
  type MergeAuthorityEvidence,
  mergeIntentMarker,
  newGoal,
  unsatisfiableGoalRemedy,
} from "./agentGoal";

// bead sparkle-hrzitj, failure 4 — "Babysit #69 burned 14 auto-continues against 'Land PR #91 on
// main' - structurally impossible, because that repo is merge-protected and only the founder may
// merge. An unreachable goal is not a stall; it is a mis-specified goal."
//
// The goal text observed on that row, verbatim from the bead.
const OBSERVED = "Land PR #91 on main";

const NOW = 1_700_000_000_000;
const PROTECTED: MergeAuthorityEvidence = {
  mergeProtectedRepo: true,
  repo: "plow-pbc/tkmx-client",
};
const UNPROTECTED: MergeAuthorityEvidence = { mergeProtectedRepo: false, repo: "drodio/sparkle" };
/** Nobody could tell — a cold slug cache, an unknown root, a non-GitHub remote. */
const UNKNOWN: MergeAuthorityEvidence = { mergeProtectedRepo: undefined, repo: null };

describe("mergeIntentMarker", () => {
  it("flags the exact goal text observed in the wild", () => {
    expect(mergeIntentMarker(OBSERVED)).toBeDefined();
  });

  it.each([
    ["Land PR #91 on main", "land pr"],
    ["merge PR #2946", "merge pr"],
    ["Merge the pull request once CI is green", "merge the pull request"],
    ["the fix is merged into main", "merged into main"],
    ["land the branch on main", "land the branch on main"],
  ])("flags %j via marker %j", (text, marker) => {
    expect(mergeIntentMarker(text)).toBe(marker);
  });

  it.each([
    // The PR NUMBER sits between the verb and its object, so the flat phrase list cannot reach it.
    "merge #2946",
    "get PR #91 merged",
    "PR #91 landed",
  ])("flags %j through the numbered pattern", (text) => {
    expect(mergeIntentMarker(text)).toBeDefined();
  });

  it("is insensitive to case and surrounding whitespace", () => {
    expect(mergeIntentMarker("   LAND   PR   #91 on main ")).toBe("land pr");
  });

  it.each([
    // Real goals an agent CAN finish on its own in any repo. Flagging one of these would silence a
    // stall, which is the expensive direction (see MergeAuthorityEvidence).
    "PR #91 is open, green and ready for a human to merge",
    "open a PR for the retry fix",
    "get PR #91 reviewed and every High closed",
    "nested groups parse and parser.test.ts passes",
    "the never-idle check reports a verdict on a cold board",
  ])("leaves %j alone", (text) => {
    expect(mergeIntentMarker(text)).toBeUndefined();
  });
});

describe("unsatisfiableGoalRemedy", () => {
  const goal = (text: string) => newGoal(text, NOW);

  it("classifies the measured goal as unsatisfiable in a merge-protected repo", () => {
    expect(unsatisfiableGoalRemedy(goal(OBSERVED), PROTECTED)).toBeDefined();
  });

  it("names the repo it cannot merge in", () => {
    expect(unsatisfiableGoalRemedy(goal(OBSERVED), PROTECTED)).toContain("plow-pbc/tkmx-client");
  });

  it("quotes the goal so the human knows which sentence to rewrite", () => {
    expect(unsatisfiableGoalRemedy(goal(OBSERVED), PROTECTED)).toContain(OBSERVED);
  });

  // ── FAIL CLOSED THE SAFE WAY. Only a POSITIVE reading classifies; every other reading leaves the
  // goal ORDINARY, because a false "unsatisfiable" silences a real stall.
  it("leaves the goal ordinary when the repo is provably NOT merge-protected", () => {
    expect(unsatisfiableGoalRemedy(goal(OBSERVED), UNPROTECTED)).toBeUndefined();
  });

  it("leaves the goal ordinary when nobody could tell whether the repo is protected", () => {
    expect(unsatisfiableGoalRemedy(goal(OBSERVED), UNKNOWN)).toBeUndefined();
  });

  it("leaves the goal ordinary when no evidence was gathered at all", () => {
    expect(unsatisfiableGoalRemedy(goal(OBSERVED), undefined)).toBeUndefined();
  });

  it("leaves a non-merge goal alone even in a merge-protected repo", () => {
    const ordinary = goal("PR #91 is open, green and ready for a human to merge");
    expect(unsatisfiableGoalRemedy(ordinary, PROTECTED)).toBeUndefined();
  });

  it("answers undefined for an agent with no goal", () => {
    expect(unsatisfiableGoalRemedy(undefined, PROTECTED)).toBeUndefined();
  });
});

// ── THE REMEDY COPY IS CODE (AGENTS.md, "User-facing copy is code"). ────────────────────────────
// A remedy message is an instruction somebody follows, and it must be safe under the SAME condition
// that produced it. The condition here is "retrying cannot work", so a sentence prescribing a retry
// prescribes exactly the fourteen-auto-continue loop this classification exists to stop.
//
// PAIRED, because neither half catches both failures: the NEGATIVE alone passes over copy trimmed to
// silence (deleting a lie is not stating the truth), and the POSITIVE alone passes over copy that
// says "rewrite the goal, or just restart it".
describe("the remedy string", () => {
  const remedy = unsatisfiableGoalRemedy(newGoal(OBSERVED, NOW), PROTECTED) ?? "";

  const RETRY_PRESCRIPTION = /\b(try again|restart|restarting|retry|retrying|resume|resuming)\b/i;

  it("NEGATIVE — never prescribes a retry, restart or resume", () => {
    expect(remedy, "a remedy that says restart prescribes the loop it exists to stop").not.toMatch(
      RETRY_PRESCRIPTION,
    );
  });

  it("POSITIVE — tells the reader to rewrite the goal", () => {
    expect(remedy, "silence leaves the reader with the same wrong inference").toContain(
      GOAL_REWRITE_INSTRUCTION,
    );
  });

  it("POSITIVE — says a person may do the merge instead", () => {
    expect(remedy, "a prohibition with no alternative is the shape people route around").toMatch(
      /only a person may|hand the merge to a person/i,
    );
  });
});
