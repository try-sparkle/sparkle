// THE PROPERTY: the mapping decides nothing, and never turns "we did not look" into an answer.
//
// This file is the seam between the app and `@sparkle/core`'s arithmetic, so its failures are of a
// kind the pure tests structurally cannot catch: a field read from the wrong place, or an absent
// reading mapped to a concrete value. The second is the dangerous one — `hasUnlandedWork: false` is
// what makes an agent "safe to retire", so inventing it tells the founder to discard work.
import { describe, it, expect } from "vitest";
import {
  PASS_HOLD_TEXT,
  buildFleetSnapshots,
  buildStandingDuties,
  snapshotOfAgent,
  unlandedWorkOf,
} from "./pusherSnapshots";
import { overdueDuties } from "@sparkle/core";
import type { FleetSnapshotInput } from "./pusherSnapshots";
import type { AgentTab, Project } from "../types";
import type { BranchStatus } from "./branchStatus";

const T0 = 1_700_000_000_000;

const agent = (over: Partial<AgentTab> = {}): AgentTab =>
  ({
    id: "a",
    name: "Agent A",
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    ...over,
  }) as AgentTab;

const project = (agents: AgentTab[], id = "p"): Project =>
  ({ id, name: id, rootPath: "/tmp", defaultBranch: "main", createdAt: "", agents, selectedAgentId: null }) as Project;

const branch = (over: Partial<BranchStatus> = {}): BranchStatus => ({
  ahead: 0,
  behind: 0,
  dirty: false,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  ...over,
});

function input(over: Partial<FleetSnapshotInput> = {}): FleetSnapshotInput {
  return {
    projects: [project([agent()])],
    branchStatus: {},
    quotaFor: () => undefined,
    failureFor: () => undefined,
    now: T0,
    ...over,
  };
}

describe("unlandedWorkOf — the fail-closed rule with teeth", () => {
  // The claim built on `false` is "safe to retire". Inventing it discards an agent's commits.
  it("says UNKNOWN when the branch was never polled", () => {
    expect(unlandedWorkOf(undefined)).toBeUndefined();
  });

  it("says clean only on affirmative evidence", () => {
    expect(unlandedWorkOf(branch())).toBe(false);
  });

  it("says holding work for unpushed commits", () => {
    expect(unlandedWorkOf(branch({ ahead: 3 }))).toBe(true);
  });

  it("says holding work for an uncommitted tree", () => {
    expect(unlandedWorkOf(branch({ dirty: true }))).toBe(true);
  });

  // A parked tree's dirt belongs to another branch, so `dirty` cannot be attributed here — and
  // mixing one trustworthy field with one untrustworthy one to reach "safe to retire" is not a
  // trade worth making. It declines to answer instead.
  it("declines to answer for a worktree parked off its own branch", () => {
    expect(unlandedWorkOf(branch({ worktreeOnBranch: false }))).toBeUndefined();
    expect(unlandedWorkOf(branch({ ahead: 5, worktreeOnBranch: false }))).toBeUndefined();
  });

  it("answers normally when the tree is confirmed on its branch", () => {
    expect(unlandedWorkOf(branch({ worktreeOnBranch: true }))).toBe(false);
  });
});

describe("the mapping", () => {
  it("omits every optional the app could not supply, rather than defaulting it", () => {
    const s = snapshotOfAgent(agent(), input());
    expect(s.quota).toBeUndefined();
    expect(s.failure).toBeUndefined();
    expect(s.escalation).toBeUndefined();
    expect(s.goalMetAt).toBeUndefined();
    expect(s.hasUnlandedWork).toBeUndefined();
  });

  it("carries the quota wall through verbatim, resetParsed included", () => {
    const msg = "You've hit your weekly limit · resets Aug 4 at 11pm (America/Bogota)";
    const s = snapshotOfAgent(
      agent(),
      input({ quotaFor: () => ({ message: msg, resetAt: T0 + 1000, resetParsed: true, at: T0 }) }),
    );
    expect(s.quota).toEqual({ message: msg, resetAt: T0 + 1000, resetParsed: true });
  });

  // Grouping is on these exact bytes; normalising here would destroy the evidence that one host
  // event killed several agents at once.
  it("carries the failure banner through UNNORMALISED", () => {
    const msg = "API Error: Unable to connect to API (ENOTFOUND)";
    const s = snapshotOfAgent(agent(), input({ failureFor: () => ({ message: msg, at: T0 - 5 }) }));
    expect(s.failure).toEqual({ message: msg, at: T0 - 5 });
  });

  it("maps an escalated goal, with its reason", () => {
    const s = snapshotOfAgent(
      agent({ goal: { text: "x", setAt: T0, ttlMs: 1, escalatedAt: T0, escalationReason: "gave up" } } as Partial<AgentTab>),
      input(),
    );
    expect(s.escalation).toEqual({ reason: "gave up" });
  });

  it("maps an escalated goal with NO reason as escalated-but-unexplained", () => {
    const s = snapshotOfAgent(
      agent({ goal: { text: "x", setAt: T0, ttlMs: 1, escalatedAt: T0 } } as Partial<AgentTab>),
      input(),
    );
    expect(s.escalation).toEqual({});
  });

  it("does not report an unescalated goal as escalated", () => {
    const s = snapshotOfAgent(
      agent({ goal: { text: "x", setAt: T0, ttlMs: 1 } } as Partial<AgentTab>),
      input(),
    );
    expect(s.escalation).toBeUndefined();
  });

  it("maps a met goal", () => {
    const s = snapshotOfAgent(
      agent({ goal: { text: "x", setAt: T0, ttlMs: 1, metAt: T0 } } as Partial<AgentTab>),
      input(),
    );
    expect(s.goalMetAt).toBe(T0);
  });

  it("uses the SHARED display-name rule, so the report names what the sidebar shows", () => {
    const s = snapshotOfAgent(agent({ name: "Cockpit Resize", namePinned: true } as Partial<AgentTab>), input());
    expect(s.label).toBe("Cockpit Resize");
  });
});

describe("buildFleetSnapshots", () => {
  it("tags each agent with its project", () => {
    const snaps = buildFleetSnapshots(
      input({
        projects: [project([agent({ id: "a" })], "p1"), project([agent({ id: "b" })], "p2")],
      }),
    );
    expect(snaps.map((s) => [s.agentId, s.projectId])).toEqual([
      ["a", "p1"],
      ["b", "p2"],
    ]);
  });

  // A worker is retired by its orchestrator, not by the founder — reporting one as safe to retire
  // would route the action to the wrong person.
  it("covers build agents only", () => {
    const snaps = buildFleetSnapshots(
      input({
        projects: [
          project([
            agent({ id: "build", kind: "build" }),
            agent({ id: "worker", kind: "worker", parentId: "build" }),
            agent({ id: "shell", kind: "shell" }),
          ]),
        ],
      }),
    );
    expect(snaps.map((s) => s.agentId)).toEqual(["build"]);
  });

  it("reads each agent's OWN branch status, not the first one it finds", () => {
    const snaps = buildFleetSnapshots(
      input({
        projects: [project([agent({ id: "a" }), agent({ id: "b" })])],
        branchStatus: { a: branch({ ahead: 2 }), b: branch() },
      }),
    );
    expect(snaps.find((s) => s.agentId === "a")!.hasUnlandedWork).toBe(true);
    expect(snaps.find((s) => s.agentId === "b")!.hasUnlandedWork).toBe(false);
  });

  it("passes the clock through to the quota lookup", () => {
    const seen: number[] = [];
    buildFleetSnapshots(
      input({
        now: T0 + 42,
        quotaFor: (_id, now) => {
          seen.push(now);
          return undefined;
        },
      }),
    );
    expect(seen).toEqual([T0 + 42]);
  });
});

describe("standing duties", () => {
  const HOUR = 60 * 60 * 1000;

  it("reports the hourly pass as overdue once it has missed two slots", () => {
    const duties = buildStandingDuties({
      improvementLastRunAt: T0 - 9 * HOUR,
      improvementIntervalMs: HOUR,
      improvementHeldBy: PASS_HOLD_TEXT["pane-busy"],
    });
    const [overdue] = overdueDuties(duties, T0);
    expect(overdue!.duty.name).toContain("logs + beads backlog");
    expect(overdue!.duty.heldBy).toContain("does not clear itself");
  });

  // An unseeded scheduler must not read as "the product stopped working".
  it("omits lastRunAt when the scheduler has not seeded, so it can never fire", () => {
    const duties = buildStandingDuties({
      improvementLastRunAt: null,
      improvementIntervalMs: HOUR,
    });
    expect(duties[0]!.lastRunAt).toBeUndefined();
    expect(overdueDuties(duties, T0)).toEqual([]);
  });

  it("says nothing while the pass is on time", () => {
    const duties = buildStandingDuties({
      improvementLastRunAt: T0 - 10 * 60_000,
      improvementIntervalMs: HOUR,
    });
    expect(overdueDuties(duties, T0)).toEqual([]);
  });

  it("carries no holder when nothing is holding it", () => {
    const duties = buildStandingDuties({ improvementLastRunAt: T0, improvementIntervalMs: HOUR });
    expect(duties[0]!.heldBy).toBeUndefined();
  });

  // The self-sustaining hold is the one worth naming in the copy, because a reader who does not
  // know it is self-sustaining will wait for it to clear.
  it("spells out that the busy-pane hold does not clear itself", () => {
    expect(PASS_HOLD_TEXT["pane-busy"]).toMatch(/does not clear itself/);
  });

  // EXHAUSTIVE. Typing the record on `PassHoldReason` makes a missing arm a compile error, and this
  // pins that nothing is an empty string — under `noUncheckedIndexedAccess` a gap would degrade to
  // the report saying "Nothing reports why." about a hold whose cause was known (roborev 57323).
  it("has non-empty text for every hold reason", () => {
    for (const [reason, text] of Object.entries(PASS_HOLD_TEXT)) {
      expect(text, reason).not.toBe("");
    }
    expect(Object.keys(PASS_HOLD_TEXT).sort()).toEqual([
      "already-running",
      "clock-unseeded",
      "consent-off",
      "offline",
      "pane-busy",
    ]);
  });
});
