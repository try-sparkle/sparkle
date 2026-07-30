// The three GIT EVIDENCE readers, covered directly.
//
// They were reachable only through two surfaces whose every stall fixture seeded `branchStatus` and
// nothing else — so `workflowState` and `workflowStage` were always absent, `hasOpenPr` and
// `hasUnlandedWork` were always `undefined`, and no assertion at either surface ever landed on the
// `open-pr` cause, the `unlanded-work` cause, or the `finished` verdict (roborev 55308). That last one
// is the reading with a real cost when wrong: it is what tells a human to stop looking at an agent,
// and it is reachable only through `readOpenPr`'s merged/closed arm. A semantic change on either side
// of this boundary — Rust reporting `prState: "closed"` for an unprobed branch, or the stage window
// shifting — would have turned confident verdicts into `unknown`, or `unknown` into "genuinely done",
// with both suites green.
import { beforeEach, describe, expect, it } from "vitest";
import { correctedStatusFor, stallEvidenceFor, stallReadingFor } from "./agentGoalReading";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useProjectStore } from "../stores/projectStore";
import { useInteractionStore } from "../stores/interactionStore";
import { newGoal } from "../engine/agentGoal";
import type { AgentTab, Project } from "../types";
import type { BranchStatus, WorkflowState } from "./branchStatus";

const A = "agent-1";

const CLEAN_BS: BranchStatus = {
  ahead: 0,
  behind: 0,
  dirty: false,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  worktreeOnBranch: true,
};

const BARE_WS: WorkflowState = {
  inLocalMain: false,
  inOriginMain: false,
  inParent: false,
  aheadOfBase: 0,
  prState: null,
  prNumber: null,
  prUrl: null,
};

function seed(over: {
  branchStatus?: Record<string, BranchStatus>;
  workflowState?: Record<string, WorkflowState>;
  workflowStage?: Record<string, string>;
}) {
  useRuntimeStore.setState({
    branchStatus: over.branchStatus ?? {},
    workflowState: over.workflowState ?? {},
    workflowStage: over.workflowStage ?? {},
  } as never);
}

const NOW = 1_700_000_000_000;

/** A roster agent, so `findRosterAgent` (and therefore the status correction) can resolve it. */
function seedRoster(over: Partial<AgentTab> = {}) {
  const agent: AgentTab = {
    id: A, name: "A", kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
    // The spawn stamp is REQUIRED for the correction to apply at all — `calmNewAgent` treats a
    // missing `createdAt` as "old agent, leave it alone".
    createdAt: NOW - 10_000,
    ...over,
  };
  const project: Project = {
    id: "p1", name: "P", rootPath: "/tmp/p", defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [agent],
  };
  useProjectStore.setState({ projects: [project] } as never);
  useInteractionStore.setState({ lastAt: {} } as never);
}

beforeEach(() => {
  seed({});
  seedRoster();
});

describe("readOpenPr — the open-PR arm nothing exercised", () => {
  it("an OPEN pr is outstanding work", () => {
    seed({ workflowState: { [A]: { ...BARE_WS, prState: "open", prNumber: 4 } } });
    expect(stallEvidenceFor(A).hasOpenPr).toBe(true);
  });

  it("a MERGED pr is not — this is the arm that licenses 'genuinely done'", () => {
    seed({ workflowState: { [A]: { ...BARE_WS, prState: "merged", inOriginMain: true } } });
    expect(stallEvidenceFor(A).hasOpenPr).toBe(false);
  });

  it("a CLOSED pr is not outstanding either", () => {
    seed({ workflowState: { [A]: { ...BARE_WS, prState: "closed" } } });
    expect(stallEvidenceFor(A).hasOpenPr).toBe(false);
  });

  it("an UNPROBED branch answers nothing — absence is not 'no PR'", () => {
    // The distinction the whole surface rests on: `undefined` keeps the verdict `unknown` rather than
    // letting a row claim it is finished on evidence nobody gathered.
    expect("hasOpenPr" in stallEvidenceFor(A)).toBe(false);
  });
});

describe("readUnlanded — the band two review rounds were about", () => {
  it("committed-but-unlanded work is outstanding", () => {
    seed({ workflowStage: { [A]: "building_saved" } });
    expect(stallEvidenceFor(A).hasUnlandedWork).toBe(true);
  });

  it("a merged stage is not", () => {
    seed({ workflowStage: { [A]: "merged" } });
    expect(stallEvidenceFor(A).hasUnlandedWork).toBe(false);
  });

  it("an unread stage answers nothing", () => {
    expect("hasUnlandedWork" in stallEvidenceFor(A)).toBe(false);
  });
});

describe("readUncommitted", () => {
  it("a dirty worktree is outstanding work", () => {
    seed({ branchStatus: { [A]: { ...CLEAN_BS, dirty: true } } });
    expect(stallEvidenceFor(A).hasUncommittedChanges).toBe(true);
  });

  it("a clean one is not", () => {
    seed({ branchStatus: { [A]: CLEAN_BS } });
    expect(stallEvidenceFor(A).hasUncommittedChanges).toBe(false);
  });

  it("a PARKED worktree answers nothing — its dirt is not this agent's", () => {
    // `worktreeOnBranch: false` means the tree is on some other branch, so `dirty` describes someone
    // else's work. Reporting it would attribute a stall to the wrong agent.
    seed({ branchStatus: { [A]: { ...CLEAN_BS, dirty: true, worktreeOnBranch: false } } });
    expect("hasUncommittedChanges" in stallEvidenceFor(A)).toBe(false);
  });
});

describe("the FULL-evidence clean row — the only shape that may read 'genuinely done'", () => {
  it("reports all three as false, so stallReport can reach `finished`", () => {
    seed({
      branchStatus: { [A]: CLEAN_BS },
      workflowState: { [A]: { ...BARE_WS, prState: "merged", inOriginMain: true } },
      workflowStage: { [A]: "merged" },
    });
    expect(stallEvidenceFor(A)).toEqual({
      hasOpenPr: false,
      hasUnlandedWork: false,
      hasUncommittedChanges: false,
    });
  });
});

describe("stallReadingFor — the correction lives INSIDE, so no caller can skip it", () => {
  // roborev 55451. Moving `calmNewAgent` inside `stallReadingFor` was the fix for two surfaces
  // disagreeing about the same agent — and nothing tested it. No test called this function at all,
  // `getAgentStatus` applies the correction upstream too (so the internal call is redundant THERE),
  // and the one suite that came near it briefed its fixture, which makes `isBriefless` false and the
  // new branch unreachable. Deleting the correction left the whole suite green.
  const GOAL = newGoal("land the never-idle work", NOW - 5_000);

  it("a BRIEFLESS freshly-spawned agent with a goal reads ACTIVE, not stalled", () => {
    // `idle` → `new`, and `new` is excluded from agentStall.isQuiet — an agent that was never given a
    // turn has not stalled, it has not started. Without the correction this is `stalled`, and the
    // concierge sends someone to unstick an agent nobody has briefed yet.
    const report = stallReadingFor(A, "idle", GOAL, NOW);
    expect(report.verdict).toBe("active");
    expect(report.detail).toContain("not idle");
  });

  it("…and the SAME agent, once briefed, reads stalled — the correction is not a blanket calm", () => {
    seedRoster({ lastPrompt: "go build the thing" });
    seed({ branchStatus: { [A]: { ...CLEAN_BS, dirty: true } } });
    const report = stallReadingFor(A, "idle", GOAL, NOW);
    expect(report.verdict).toBe("stalled");
    expect(report.causes).toContain("unmet-goal");
  });

  it("an agent OFF the roster is read as-is — no correction invented for a row we cannot see", () => {
    useProjectStore.setState({ projects: [] } as never);
    seed({ branchStatus: { [A]: { ...CLEAN_BS, dirty: true } } });
    expect(stallReadingFor(A, "idle", GOAL, NOW).verdict).toBe("stalled");
  });
});

describe("correctedStatusFor — one derivation, so `status` and `stall` cannot contradict", () => {
  // roborev 55451. The roster published the RAW status beside a `stall` derived from the corrected
  // one, and `stall` is OMITTED when the verdict is `active` because "`active` is implied by
  // `status`". So a briefless agent's row said `status: "idle"`, carried an unmet goal, and had no
  // `stall` key — two contradictory claims in one object.
  const GOAL = newGoal("land the never-idle work", NOW - 5_000);

  it("reports the corrected status the stall verdict was computed from", () => {
    expect(correctedStatusFor(A, "idle", NOW)).toBe("new");
    // THE AGREEMENT, asserted as the pair: a row emitting this status and omitting `stall` on the
    // `active` rule is now consistent, because both came from the same value.
    expect(stallReadingFor(A, "idle", GOAL, NOW).verdict).toBe("active");
  });

  it("calms a `blocked` unbriefed agent too — the stall timer firing is not a wedge", () => {
    // Asserted HERE rather than through `stallReadingFor`, where it would prove nothing: `blocked` is
    // already excluded from agentStall's `isQuiet`, so that verdict is `active` corrected or not. The
    // correction's whole observable effect on this status is the value the surface REPORTS.
    expect(correctedStatusFor(A, "blocked", NOW)).toBe("new");
  });

  it("leaves a briefed agent's status alone", () => {
    seedRoster({ lastPrompt: "go build the thing" });
    expect(correctedStatusFor(A, "idle", NOW)).toBe("idle");
    expect(correctedStatusFor(A, "blocked", NOW)).toBe("blocked");
  });

  it("a real ASK is never calmed — `waiting` survives, briefed or not", () => {
    // The one exemption that outranks the whole rule: a question is a question at any age.
    expect(correctedStatusFor(A, "waiting", NOW)).toBe("waiting");
  });

  it("never invents a status for an agent this window does not have a row for", () => {
    useProjectStore.setState({ projects: [] } as never);
    expect(correctedStatusFor(A, "idle", NOW)).toBe("idle");
  });
});

describe("the unlanded rule is SHARED with the sidebar, not a second copy", () => {
  // roborev 55525. `readUnlanded` answered from the stage watermark alone while the sidebar's
  // `unlandedEvidence` had the live-`ahead` rule and its reachability veto — so for the new-work cycle
  // the sidebar said `stalled`/`unlanded-work` and this surface said `finished`, for the same agent at
  // the same moment. Both now call `engine/workflowStage.unlandedWorkEvidence`.
  const GOAL = newGoal("land the never-idle work", NOW - 5_000);

  it("the NEW-WORK CYCLE reports unlanded work here too, not `finished`", () => {
    // Merge PR #1 (the watermark latches `merged`), keep working on the same branch, commit 3 times.
    seedRoster({ lastPrompt: "go build the thing" });
    seed({
      branchStatus: { [A]: { ...CLEAN_BS, ahead: 3 } },
      workflowState: { [A]: { ...BARE_WS, prState: "merged" } },
      workflowStage: { [A]: "merged" },
    });
    expect(stallEvidenceFor(A).hasUnlandedWork).toBe(true);
    const report = stallReadingFor(A, "idle", GOAL, NOW);
    expect(report.verdict).toBe("stalled");
    expect(report.causes).toContain("unlanded-work");
  });

  it("…and a SQUASH-landed branch still reads landed here, so the veto came along as well", () => {
    // The other half of the shared rule: `ahead` never returns to zero after a squash merge, so
    // importing only the short-circuit would have handed this surface a permanent false positive.
    seedRoster({ lastPrompt: "go build the thing" });
    seed({
      branchStatus: { [A]: { ...CLEAN_BS, ahead: 3 } },
      workflowState: { [A]: { ...BARE_WS, landed: true, prState: "merged" } },
      workflowStage: { [A]: "merged" },
    });
    expect(stallEvidenceFor(A).hasUnlandedWork).toBe(false);
    expect(stallReadingFor(A, "idle", undefined, NOW).causes).not.toContain("unlanded-work");
  });

  it("an unpolled branch still answers NOTHING — the shared rule kept the undefined arm", () => {
    seedRoster({ lastPrompt: "go build the thing" });
    seed({ workflowState: { [A]: { ...BARE_WS, prState: "open" } } });
    expect("hasUnlandedWork" in stallEvidenceFor(A)).toBe(false);
  });
});
