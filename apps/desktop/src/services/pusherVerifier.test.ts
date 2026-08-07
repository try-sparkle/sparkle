// THE RE-READ'S RULES — what counts as an affirmative contradiction, and what merely counts as
// "we could not tell".
//
// The whole file is arranged around one asymmetry: `refuted` is a licence to go SILENT about a
// finding, so it must require positive evidence, while `holds` and `unreadable` both cost nothing.
// Half the cases below therefore assert that something did NOT get refuted, which reads as
// over-testing right up until an offline machine mutes every conflicting PR in the fleet at once.

import { describe, expect, it, vi } from "vitest";
import type { PusherClaim } from "@sparkle/core";
import { claimKey } from "@sparkle/core";
import {
  makePusherVerifier,
  verifyGoalUnmet,
  verifyHasNoUnlandedWork,
  verifyHoldsUnlandedWork,
  verifyPrOpen,
  type PusherVerifierDeps,
} from "./pusherVerifier";
import type { AgentGoal } from "../engine/agentGoal";
import type { BranchStatus, WorkflowState } from "./branchStatus";
import type { PrRow } from "./openPrs";

const T0 = 1_700_000_000_000;

const prRow = (number: number, over: Partial<PrRow> = {}): PrRow => ({
  number,
  title: "some work",
  headRefName: "sparkle/some-work",
  url: `https://github.com/drodio/sparkle/pull/${number}`,
  checks: "passing",
  mergeable: "mergeable",
  ...over,
});

const branch = (over: Partial<BranchStatus> = {}): BranchStatus => ({
  ahead: 0,
  behind: 0,
  dirty: false,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  ...over,
});

const workflow = (over: Partial<WorkflowState> = {}): WorkflowState => ({
  inLocalMain: false,
  inOriginMain: false,
  inParent: false,
  aheadOfBase: 0,
  prState: null,
  prNumber: null,
  prUrl: null,
  ...over,
});

const goal = (over: Partial<AgentGoal> = {}): AgentGoal => ({
  text: "do the thing",
  setAt: T0,
  ttlMs: 4 * 3600_000,
  continues: 0,
  totalContinues: 0,
  ...over,
});

describe("verifyPrOpen", () => {
  it("refutes a PR that no repo lists as open", () => {
    expect(verifyPrOpen(1406, [{ rows: [prRow(1358)], saturated: false }])).toBe("refuted");
  });

  it("holds a PR that is still listed", () => {
    expect(verifyPrOpen(1358, [{ rows: [prRow(1358)], saturated: false }])).toBe("holds");
  });

  it("refuses to answer when NOBODY could be asked", () => {
    // The whole fleet offline, or `gh` unauthenticated. Absence from a list that was never read is
    // not absence — and refuting here would hide every conflicting PR the moment GitHub blinked.
    expect(verifyPrOpen(1358, [{ rows: null, saturated: false }])).toBe("unreadable");
    expect(verifyPrOpen(1358, [])).toBe("unreadable");
  });

  it("refuses to answer when a list was TRUNCATED", () => {
    // `listSaturated` means rows fell off the cap, so "not in the list" is not evidence. This is the
    // one that would otherwise fail silently and often, on any repo with more than 100 open PRs.
    expect(verifyPrOpen(1406, [{ rows: [prRow(1358)], saturated: true }])).toBe("unreadable");
  });

  it("treats a match in ANY repo as still-open, because PR numbers collide across repositories", () => {
    // Rust keys its conflict flags by PR NUMBER ALONE, so which repo a flag belongs to is a fact
    // this side does not have. The weaker answer is the safe one: the worst it does is keep
    // reporting something the founder can act on, while the strict reading would silently drop a
    // genuinely conflicting PR because a sibling repo merged its same-numbered one.
    const readings = [
      { rows: [prRow(12)], saturated: false },
      { rows: [prRow(999)], saturated: false },
    ];
    expect(verifyPrOpen(12, readings)).toBe("holds");
  });

  it("ignores a failed repo when another repo answered cleanly", () => {
    // A partial fleet still supports a refutation, as long as nothing that answered was truncated.
    expect(
      verifyPrOpen(1406, [
        { rows: null, saturated: false },
        { rows: [prRow(1358)], saturated: false },
      ]),
    ).toBe("refuted");
  });
});

describe("verifyHoldsUnlandedWork", () => {
  it("refutes when the branch is clean and its work is contained in origin/main", () => {
    expect(
      verifyHoldsUnlandedWork({
        branch: branch({ ahead: 3, dirty: false }),
        workflow: workflow({ inOriginMain: true }),
      }),
    ).toBe("refuted");
  });

  it("refutes a squash-merged branch, which ancestry alone cannot see", () => {
    expect(
      verifyHoldsUnlandedWork({
        branch: branch({ ahead: 3, dirty: false }),
        workflow: workflow({ landed: true }),
      }),
    ).toBe("refuted");
  });

  it("does NOT refute a landed branch that still has uncommitted files", () => {
    // The trap this pair exists for: `WorkflowState` knows about COMMITS and nothing about the
    // working tree, so refuting on ancestry alone tells a partner to stop worrying about work that
    // is genuinely sitting unsaved. Same shape of wrong answer as the merged PR, one field over.
    expect(
      verifyHoldsUnlandedWork({
        branch: branch({ ahead: 0, dirty: true }),
        workflow: workflow({ inOriginMain: true }),
      }),
    ).toBe("holds");
  });

  it("holds when the branch really is ahead", () => {
    expect(verifyHoldsUnlandedWork({ branch: branch({ ahead: 2 }) })).toBe("holds");
  });

  it("declines on a PARKED worktree rather than guessing", () => {
    // `worktreeOnBranch === false` means the dirt belongs to whatever branch got checked out into
    // this tree. `unlandedWorkOf` already declines there; this asserts the verifier inherits it
    // rather than re-deriving a second, disagreeing rule.
    expect(
      verifyHoldsUnlandedWork({ branch: branch({ ahead: 4, worktreeOnBranch: false }) }),
    ).toBe("unreadable");
  });

  it("declines when nothing could be read", () => {
    expect(verifyHoldsUnlandedWork({})).toBe("unreadable");
  });
});

describe("verifyHasNoUnlandedWork — the retire claim", () => {
  it("refutes on an OPEN PR, which a clean branch read cannot see", () => {
    // The founder's actual case. An agent waiting to merge its own PR has pushed everything, so the
    // branch reads `ahead: 0, dirty: false` and the retire claim sails through. Twice on
    // 2026-08-07; retiring either would have destroyed work.
    expect(
      verifyHasNoUnlandedWork({
        branch: branch({ ahead: 0, dirty: false }),
        workflow: workflow({ prState: "open", prNumber: 1421 }),
      }),
    ).toBe("refuted");
  });

  it("refutes on commits the branch is still holding", () => {
    expect(verifyHasNoUnlandedWork({ branch: branch({ ahead: 2 }) })).toBe("refuted");
  });

  it("refutes on uncommitted files", () => {
    expect(verifyHasNoUnlandedWork({ branch: branch({ dirty: true }) })).toBe("refuted");
  });

  it("holds only on an affirmatively clean tree", () => {
    expect(
      verifyHasNoUnlandedWork({
        branch: branch({ ahead: 0, dirty: false }),
        workflow: workflow({ prState: "merged" }),
      }),
    ).toBe("holds");
  });

  it("holds for a MERGED branch that still reads ahead of the ref it was cut from", () => {
    // The mirror of the ordering bug on the other claim. `ahead` is measured against the cut base,
    // so it stays >0 after a merge — reading it before ancestry would make `done-not-retired` go
    // permanently silent for exactly the agents whose work has shipped, which is who it cleans up.
    expect(
      verifyHasNoUnlandedWork({
        branch: branch({ ahead: 3, dirty: false }),
        workflow: workflow({ inOriginMain: true, prState: "merged" }),
      }),
    ).toBe("holds");
  });

  it("declines when the branch could not be read — an unread repo is not a clean one", () => {
    // The most consequential `unreadable` in the file: `retirableAgents` needs an affirmative
    // `false`, so declining suppresses the retire claim. Answering `holds` here would recommend
    // discarding an agent nobody looked at.
    expect(verifyHasNoUnlandedWork({ workflow: workflow() })).toBe("unreadable");
  });
});

describe("verifyGoalUnmet", () => {
  it("refutes a goal that is already marked met", () => {
    expect(verifyGoalUnmet(goal({ metAt: T0 }), {})).toBe("refuted");
  });

  it("refutes a `landed` goal whose work is on origin/main", () => {
    expect(
      verifyGoalUnmet(goal({ verify: { kind: "landed" } }), { workflow: workflow({ inOriginMain: true }) }),
    ).toBe("refuted");
  });

  it("holds a `landed` goal whose work is affirmatively NOT there", () => {
    expect(
      verifyGoalUnmet(goal({ verify: { kind: "landed" } }), { workflow: workflow({ inOriginMain: false }) }),
    ).toBe("holds");
  });

  it("declines a `human` goal — no machine answers it, and that is the kind's purpose", () => {
    expect(
      verifyGoalUnmet(goal({ verify: { kind: "human" } }), { workflow: workflow({ inOriginMain: true }) }),
    ).toBe("unreadable");
  });

  it("declines a `command` goal — nothing in the app runs a goal's cmd yet", () => {
    expect(
      verifyGoalUnmet(goal({ verify: { kind: "command", cmd: "pnpm verify" } }), {
        workflow: workflow({ inOriginMain: true }),
      }),
    ).toBe("unreadable");
  });

  it("infers `landed` from a goal that STATED no check but reads as a landing question", () => {
    // Through `inferGoalVerify`, the same inference the goal machinery itself uses — so a goal it
    // would close from git is one this stops reporting as blocked, rather than the two surfaces
    // disagreeing about the same sentence.
    expect(
      verifyGoalUnmet(goal({ text: "land PR #1421 to main" }), { workflow: workflow({ landed: true }) }),
    ).toBe("refuted");
  });

  it("declines when there is no goal at all", () => {
    expect(verifyGoalUnmet(undefined, { workflow: workflow({ inOriginMain: true }) })).toBe("unreadable");
  });

  it("declines when the branch could not be read", () => {
    expect(verifyGoalUnmet(goal({ verify: { kind: "landed" } }), {})).toBe("unreadable");
  });
});

describe("makePusherVerifier", () => {
  function deps(over: Partial<PusherVerifierDeps> = {}): PusherVerifierDeps {
    return {
      scopes: () => [{ projectId: "p", rootPath: "/repo" }],
      scopeForAgent: () => ({ projectId: "p", rootPath: "/repo" }),
      goalFor: () => goal({ verify: { kind: "landed" } }),
      openPrs: async () => [prRow(1358)],
      branchStatus: async () => branch(),
      workflowState: async () => workflow(),
      ...over,
    };
  }

  const key = (c: PusherClaim) => claimKey(c);

  it("answers every claim it was given", async () => {
    const verify = makePusherVerifier(deps());
    const claims: PusherClaim[] = [
      { kind: "pr-open", pr: 1358 },
      { kind: "pr-open", pr: 1406 },
      { kind: "agent-has-no-unlanded-work", agentId: "a1" },
      { kind: "goal-unmet", agentId: "a1" },
    ];
    const verdicts = await verify(claims);
    expect(verdicts.get(key(claims[0]!))).toBe("holds");
    expect(verdicts.get(key(claims[1]!))).toBe("refuted");
    expect(verdicts.get(key(claims[2]!))).toBe("holds");
    expect(verdicts.get(key(claims[3]!))).toBe("holds");
  });

  it("reads each repo ONCE however many PR claims it carries", async () => {
    // A per-claim fan-out over a 100-PR fleet would be a hundred round-trips inside a one-minute
    // tick. Asserted on the call count, which is the thing that would regress.
    const openPrs = vi.fn(async () => [prRow(1358)]);
    const verify = makePusherVerifier(deps({ openPrs }));
    await verify([
      { kind: "pr-open", pr: 1358 },
      { kind: "pr-open", pr: 1406 },
      { kind: "pr-open", pr: 1407 },
    ]);
    expect(openPrs).toHaveBeenCalledTimes(1);
  });

  it("reads each agent ONCE for both of its claims", async () => {
    const branchStatus = vi.fn(async () => branch());
    const verify = makePusherVerifier(deps({ branchStatus }));
    await verify([
      { kind: "agent-has-no-unlanded-work", agentId: "a1" },
      { kind: "goal-unmet", agentId: "a1" },
    ]);
    expect(branchStatus).toHaveBeenCalledTimes(1);
  });

  it("does not ask GitHub at all when no claim is about a PR", async () => {
    const openPrs = vi.fn(async () => [prRow(1358)]);
    const verify = makePusherVerifier(deps({ openPrs }));
    await verify([{ kind: "agent-has-no-unlanded-work", agentId: "a1" }]);
    expect(openPrs).not.toHaveBeenCalled();
  });

  it("turns a THROWING probe into unreadable, never into a refutation", async () => {
    const verify = makePusherVerifier(
      deps({
        openPrs: async () => {
          throw new Error("gh: not authenticated");
        },
        branchStatus: async () => {
          throw new Error("no such worktree");
        },
        workflowState: async () => {
          throw new Error("no such worktree");
        },
      }),
    );
    const claims: PusherClaim[] = [
      { kind: "pr-open", pr: 1358 },
      { kind: "agent-has-no-unlanded-work", agentId: "a1" },
      { kind: "goal-unmet", agentId: "a1" },
    ];
    const verdicts = await verify(claims);
    for (const claim of claims) expect(verdicts.get(key(claim))).toBe("unreadable");
  });

  it("declines every claim about an agent whose repo cannot be located", async () => {
    // An agent in a project with no checkout — a cloud agent, or a record with an empty root. It
    // must read as unknown, not as a clean tree, or "safe to retire" fires on nothing at all.
    const verify = makePusherVerifier(deps({ scopeForAgent: () => undefined }));
    const claim: PusherClaim = { kind: "agent-has-no-unlanded-work", agentId: "a1" };
    expect((await verify([claim])).get(key(claim))).toBe("unreadable");
  });

  it("skips a project with no rootPath rather than probing it", async () => {
    const openPrs = vi.fn(async () => [prRow(1358)]);
    const verify = makePusherVerifier(
      deps({ scopes: () => [{ projectId: "p", rootPath: null }], openPrs }),
    );
    const claim: PusherClaim = { kind: "pr-open", pr: 1358 };
    expect(openPrs).not.toHaveBeenCalled();
    // ...and with nothing asked, nothing is answered.
    expect((await verify([claim])).get(key(claim))).toBe("unreadable");
  });

  it("returns an empty map for an empty claim list, doing no I/O", async () => {
    const openPrs = vi.fn(async () => [prRow(1358)]);
    const verify = makePusherVerifier(deps({ openPrs }));
    expect((await verify([])).size).toBe(0);
    expect(openPrs).not.toHaveBeenCalled();
  });
});
