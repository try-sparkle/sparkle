// NO SUMMARY COUNT MAY PROMISE A MERGE GITHUB WOULD REFUSE — bead `sparkle-mf501`.
//
// THE REPRODUCTION, measured against `drodio/sparkle` on 2026-08-09 and used verbatim below. The
// concierge said "4 need merge in sparkle". The founder clicked through and not one of the four
// could be merged:
//
//     #1581  mergeable=MERGEABLE   mergeStateStatus=UNSTABLE   2 checks failing
//     #1560  mergeable=MERGEABLE   mergeStateStatus=UNSTABLE   2 checks failing
//     #1535  mergeable=MERGEABLE   mergeStateStatus=UNSTABLE   2 checks failing
//     #1308  mergeable=CONFLICTING mergeStateStatus=DIRTY      draft, 5 checks failing
//
// `mergeable: MERGEABLE` IS THE TRAP, and it is why these fixtures carry the real GitHub fields
// rather than a hand-set "ready" flag. It means "git would not conflict" — NOT "safe to merge" —
// and three of the four rows above wear it while their checks are red. Any predicate built on that
// field alone counts three failing PRs as ready and reproduces the bug exactly; the tests here are
// written so that such a predicate goes RED rather than green.
//
// THE COUNT WAS NOT WRONG, WHICH IS THE WHOLE DIFFICULTY. Four agents really did have committed work
// that had not reached `main`, and `engine/agentStall` records the standing ruling that un-landed
// work is a landing state rather than an alarm — 27 of 51 agents sat in it on a real fleet — so
// filtering the red ones out of the line would HIDE work the founder owes. Two different predicates
// were wearing one number. The fix splits the number instead of filtering it, and these tests pin
// both halves: the outstanding count stays whole, and the actionable count is separately true.
import { describe, expect, it } from "vitest";
import { buildDigest, type DigestReadiness } from "./conciergeDigest";
import {
  buildPrGroups,
  fleetHeadline,
  fleetTotals,
  keyOfScope,
  prReadinessSnapshot,
  type PrScope,
} from "./fleetPrs";
import { prReadyCount, type JudgedPrRow } from "./openPrs";
import type { ConciergeAgent } from "../useConciergeFeed";

const SCOPE: PrScope = { projectId: "sparkle", projectName: "sparkle", rootPath: "/sparkle" };

const row = (over: Partial<JudgedPrRow> & { number: number }): JudgedPrRow =>
  ({
    title: `PR ${over.number}`,
    headRefName: `sparkle/agent-${over.number}`,
    url: `https://github.com/drodio/sparkle/pull/${over.number}`,
    checks: "passing",
    mergeable: "mergeable",
    ...over,
  }) as JudgedPrRow;

/** The founder's fleet, field for field. Each PR is owned by one agent, matching the 1:1 the
 *  reproduction had — four agents in the "need merge" line, four open pull requests. */
const FOUNDERS_PRS: JudgedPrRow[] = [
  row({
    number: 1581,
    agentId: "a1581",
    mergeable: "mergeable",
    mergeStateStatus: "unstable",
    checks: "failing",
    failingChecks: ["CI", "Node — static"],
  }),
  row({
    number: 1560,
    agentId: "a1560",
    mergeable: "mergeable",
    mergeStateStatus: "unstable",
    checks: "failing",
    failingChecks: ["CI", "Node — static"],
  }),
  row({
    number: 1535,
    agentId: "a1535",
    mergeable: "mergeable",
    mergeStateStatus: "unstable",
    checks: "failing",
    failingChecks: ["CI", "Node — static"],
  }),
  row({
    number: 1308,
    agentId: "a1308",
    mergeable: "conflicting",
    mergeStateStatus: "dirty",
    checks: "failing",
    failingChecks: ["CI", "a", "b", "c", "d"],
  }),
];

/** The green PR the three red ones become once CI passes — the live half of the reproduction (those
 *  three were re-run via GitHub's update-branch the same morning). */
const greenRow = (number: number, agentId: string): JudgedPrRow =>
  row({ number, agentId, mergeable: "mergeable", mergeStateStatus: "clean", checks: "passing" });

const groupsFor = (prs: JudgedPrRow[]) =>
  buildPrGroups([SCOPE], new Map([[keyOfScope(SCOPE), prs]]), new Set());

/** `OpenPrMenu`'s `resolveAgent`, reduced to the join the snapshot needs: the durable owner Rust
 *  records at PR-creation time. A row with no owner resolves to null — see the fail-closed case. */
const byRecordedOwner = (pr: JudgedPrRow) => (pr.agentId ? { agentId: pr.agentId } : null);

const readinessOf = (prs: JudgedPrRow[]): DigestReadiness => {
  const snap = prReadinessSnapshot(groupsFor(prs), byRecordedOwner);
  const probed = new Set(snap.knownProjectIds);
  const ready = new Set(snap.readyAgentIds);
  return { probed: (id) => probed.has(id), agentReady: (id) => ready.has(id) };
};

const unmergedAgent = (id: string): ConciergeAgent =>
  ({
    id,
    name: id,
    projectId: "sparkle",
    projectName: "sparkle",
    kind: "build",
    status: "unmerged",
    statusColor: "#8a8a8a",
    statusLabel: "Needs merge",
    band: "done",
    inScope: true,
    muted: false,
    topLevel: true,
    representedElsewhere: false,
  }) as ConciergeAgent;

const FOUR_AGENTS = ["a1581", "a1560", "a1535", "a1308"].map(unmergedAgent);

describe("the readiness join — a red or conflicting PR is never counted as ready", () => {
  // THE GOAL ASSERTION. If a PR with failing checks or a conflict is ever counted as ready, this is
  // the test that goes red. Asserted on the ROWS' own judgement first, so a regression is localised
  // to the rule rather than to the sentence three layers up.
  it("counts none of the founder's four as ready", () => {
    expect(prReadyCount(FOUNDERS_PRS)).toBe(0);
    expect(prReadinessSnapshot(groupsFor(FOUNDERS_PRS), byRecordedOwner).readyAgentIds).toEqual([]);
  });

  // THE SPECIFIC TRAP, isolated. Three of the four report `mergeable: "mergeable"` — GitHub's answer
  // to "would git accept this merge" — and a predicate that stopped there would call all three
  // ready. This asserts the field is present AND that it does not carry the day, so the fixture
  // cannot quietly drift into one that would pass under the buggy rule.
  it("does not treat `mergeable: mergeable` beside failing checks as ready", () => {
    const unstable = FOUNDERS_PRS.filter((p) => p.mergeStateStatus === "unstable");
    expect(unstable).toHaveLength(3);
    expect(unstable.every((p) => p.mergeable === "mergeable")).toBe(true);
    expect(prReadyCount(unstable)).toBe(0);
  });

  // THE OTHER RED, kept apart from it. #1308 conflicts, which is a decision a human has to make;
  // the three above just needed CI to finish. `fleetTotals` reports them as separate numbers so a
  // reader can tell which kind of red is in front of them.
  it("separates a conflict from a failing check in the fleet totals", () => {
    const t = fleetTotals(groupsFor(FOUNDERS_PRS));
    expect(t.total).toBe(4);
    expect(t.ready).toBe(0);
    expect(t.conflicting).toBe(1);
    expect(t.checkBlocked).toBe(3);
  });

  // FAIL-CLOSED ON AN UNATTRIBUTABLE OWNER. A green PR whose owner was never recorded contributes
  // nothing, which understates what is ready — the safe direction. The opposite error is the bug.
  it("does not credit a green PR whose owner cannot be resolved", () => {
    const snap = prReadinessSnapshot(
      groupsFor([row({ number: 9, agentId: null, mergeStateStatus: "clean" })]),
      byRecordedOwner,
    );
    expect(snap.readyAgentIds).toEqual([]);
    // …and the project is still PROBED. "We looked and nothing is ready" and "we did not look" are
    // different answers, and an unresolvable owner must not silently collapse into the second.
    expect(snap.knownProjectIds).toEqual(["sparkle"]);
  });
});

describe("the concierge line — the split, not a filter", () => {
  it("states the outstanding count AND that none of it can be merged", () => {
    const g = buildDigest(FOUR_AGENTS, "unmerged", readinessOf(FOUNDERS_PRS)).groups;
    expect(g).toHaveLength(1);
    // THE OUTSTANDING HALF IS UNTOUCHED. Four agents owe work and the line still says four — the
    // ruling in `conciergeDigest`'s header (bead `sparkle-qogah`) is that a row he owes action on
    // may not be hidden, and `engine/agentStall` records why: un-landed is a landing state.
    expect(g[0]!.count).toBe(4);
    expect(g[0]!.memberIds).toHaveLength(4);
    // THE ACTIONABLE HALF IS NOW SEPARATELY TRUE.
    expect(g[0]!.readyCount).toBe(0);
    expect(g[0]!.text).toBe("4 need merge in sparkle · none ready yet");
  });

  it("counts only the agents THIS line stands for once one goes green", () => {
    // #1581's checks pass — the live case, since those three were re-run that morning.
    const prs = [greenRow(1581, "a1581"), ...FOUNDERS_PRS.slice(1)];
    const g = buildDigest(FOUR_AGENTS, "unmerged", readinessOf(prs)).groups[0]!;
    expect(g.count).toBe(4);
    expect(g.readyCount).toBe(1);
    expect(g.text).toBe("4 need merge in sparkle · 1 ready");
  });

  // THE NUMERATOR STAYS INSIDE THE DENOMINATOR. A green PR belonging to an agent this line does NOT
  // count must not inflate its ready half — otherwise "4 need merge · 1 ready" could mean "one
  // OTHER thing is ready", which is a fresh false promise wearing the fix's clothes.
  it("ignores a green PR owned by an agent outside the line", () => {
    const prs = [...FOUNDERS_PRS, greenRow(1600, "someone-else")];
    const g = buildDigest(FOUR_AGENTS, "unmerged", readinessOf(prs)).groups[0]!;
    expect(g.readyCount).toBe(0);
    expect(g.text).toBe("4 need merge in sparkle · none ready yet");
  });

  // "WE DID NOT LOOK" IS NOT "NOTHING IS READY". `gh` absent, unauthed, offline, or simply before
  // the first three-minute poll — the line must fall back to the sentence it had rather than issue
  // a denial it cannot support. This is the same defect as the false promise, pointed the other way.
  it("says nothing about readiness for a project no probe has answered for", () => {
    const unprobed: DigestReadiness = { probed: () => false, agentReady: () => true };
    const g = buildDigest(FOUR_AGENTS, "unmerged", unprobed).groups[0]!;
    expect(g.readyCount).toBeNull();
    expect(g.text).toBe("4 need merge in sparkle");
  });

  // A failed probe is exactly that case, reached through the real code path rather than a stub.
  it("treats an unreadable project as unprobed rather than as nothing-ready", () => {
    const groups = buildPrGroups([SCOPE], new Map(), new Set([keyOfScope(SCOPE)]));
    expect(prReadinessSnapshot(groups, byRecordedOwner).knownProjectIds).toEqual([]);
  });

  // The caller with no readiness at all — every other `buildDigest` call site — is unchanged.
  it("leaves the other variants and the un-supplied caller alone", () => {
    expect(buildDigest(FOUR_AGENTS, "unmerged").groups[0]!.text).toBe("4 need merge in sparkle");
    expect(buildDigest(FOUR_AGENTS, "unmerged").groups[0]!.readyCount).toBeNull();
  });
});

describe("the PR panel headline — what the click can actually do", () => {
  it("names the ready count beside the open count", () => {
    expect(fleetHeadline(fleetTotals(groupsFor(FOUNDERS_PRS)))).toBe(
      "4 open pull requests · none ready to merge",
    );
  });

  it("names the blocker when there is only one kind of it", () => {
    const checksOnly = FOUNDERS_PRS.slice(0, 3);
    expect(fleetHeadline(fleetTotals(groupsFor(checksOnly)))).toBe(
      "3 open pull requests · none ready — all waiting on checks",
    );
    const conflictOnly = [FOUNDERS_PRS[3]!];
    expect(fleetHeadline(fleetTotals(groupsFor(conflictOnly)))).toBe(
      "1 open pull request · none ready — it conflicts",
    );
  });

  it("states the ready count once something is green", () => {
    const prs = [greenRow(1581, "a1581"), greenRow(1560, "a1560"), FOUNDERS_PRS[3]!];
    expect(fleetHeadline(fleetTotals(groupsFor(prs)))).toBe(
      "3 open pull requests · 2 ready to merge",
    );
  });

  // The states that precede an answer are untouched — a headline may not claim a readiness on a
  // fleet it has not read. Same rule as the digest's `probed` gate, one surface over.
  it("still refuses to say anything at all before a probe answers", () => {
    expect(fleetHeadline(fleetTotals(buildPrGroups([SCOPE], new Map(), new Set())))).toBe(
      "Checking GitHub…",
    );
  });
});
