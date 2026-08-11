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
  dirtyOf,
  sessionEndedOf,
  snapshotOfAgent,
  unlandedWorkOf,
} from "./pusherSnapshots";
import { diedHoldingWork, overdueDuties } from "@sparkle/core";
import type { FleetSnapshotInput } from "./pusherSnapshots";
import type { AgentTab, AgentTabStatus, LastObserved, Project } from "../types";
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

const PROJECT_ID = "p";
const project = (agents: AgentTab[], id = PROJECT_ID): Project =>
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
    // Default FALSE — the honest reading for an app with no captured-receipt producer yet, and the
    // one that keeps `retirableAgents` fail-closed unless a case opts in.
    retroSettledFor: () => false,
    // Default UNDEFINED — "no pane in this window is watching", which is the honest reading for most
    // of the fleet and the one that keeps `diedHoldingWork` fail-closed unless a case opts in.
    sessionEndedFor: () => undefined,
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

describe("sessionEndedOf — an absent status is not a running agent", () => {
  const A = "a";
  /** The three maps the mount passes, defaulted to "this window knows nothing about anyone". */
  const ended = (
    status: Record<string, AgentTabStatus> = {},
    lastObserved: Record<string, LastObserved> = {},
    open: string[] = [],
  ) => sessionEndedOf(A, status, lastObserved, new Set(open));

  // `runtimeStore.status` has ONE writer (a mounted pane), so no entry means nothing in this window
  // is watching. Reading that as "still running" would silence the class; reading it as "ended"
  // would report every unobserved agent as dead.
  it("says UNKNOWN when no pane has ever reported a status and nothing was captured", () => {
    expect(ended()).toBeUndefined();
  });

  // The projection of `hookEventToStatus({event:"SessionEnd"}) === "done"`, which that engine pins.
  it("says ended for the status the SessionEnd hook produces", () => {
    expect(ended({ a: "done" })).toBe(true);
  });

  it("says NOT ended for a live agent", () => {
    expect(ended({ a: "working" })).toBe(false);
    expect(ended({ a: "idle" })).toBe(false);
  });

  // The trap: `stopped` reads like a session end but is also the DEFAULT a roster substitutes for an
  // agent it has no reading for, and what a closed red row is demoted to. A default may not stand in
  // for an observation.
  it("does not treat a live `stopped` as an observed session end", () => {
    expect(ended({ a: "stopped" })).toBe(false);
  });

  // THE CLOSED-ROW CASE (roborev 61854). `close()` deletes the live entry AND removes the id from
  // `openAgentIds`, and only a mounted pane writes a status — so a closed row's live reading is gone
  // permanently, while the sidebar re-polls the CLOSED rows and puts `dirty` straight back. Reading
  // the live map alone leaves this class permanently blind to the agent about to be retired.
  it("still reports a session end for a row that was CLOSED after finishing", () => {
    expect(ended({}, { a: { status: "done", at: T0 } })).toBe(true);
  });

  // THE FALSE POSITIVE THE LIVENESS GATE EXISTS TO STOP (roborev 61893). `lastObserved` is NOT
  // cleared when a row is re-opened, and it is persisted — so a resumed agent keeps a stale `done`
  // capture indefinitely. If a pane is open in ANOTHER window, this window cannot observe it, and
  // trusting the capture would report a currently-working agent as having died holding work.
  it("makes NO claim about a row that is open in another window, however stale the capture", () => {
    expect(ended({}, { a: { status: "done", at: T0 } }, ["a"])).toBeUndefined();
  });

  // The control for the case above: the ONLY difference is whether a pane is open somewhere.
  it("…and the open set is the only thing separating that from the closed-row answer", () => {
    const captured = { a: { status: "done" as AgentTabStatus, at: T0 } };
    expect(ended({}, captured, ["a"])).toBeUndefined();
    expect(ended({}, captured, [])).toBe(true);
  });

  // A capture from a previous life must never outrank a pane that is live again.
  it("prefers the LIVE reading over the captured one", () => {
    expect(ended({ a: "working" }, { a: { status: "done", at: T0 } })).toBe(false);
    expect(ended({ a: "done" }, { a: { status: "working", at: T0 } })).toBe(true);
  });

  // From a CAPTURE, a non-`done` value does not even earn `false`: closing a row mid-work captures
  // `working`, and the close may have killed the PTY, so "still running" is an overclaim about a
  // process nobody watched die. Live `working` is an observation and does say `false`.
  it("says UNKNOWN — not `false` — for a non-done capture, where a LIVE reading says false", () => {
    expect(ended({}, { a: { status: "working", at: T0 } })).toBeUndefined();
    expect(ended({}, { a: { status: "stopped", at: T0 } })).toBeUndefined();
    expect(ended({ a: "working" })).toBe(false);
  });

  // Another agent's capture must not answer for this one.
  it("reads the capture keyed by the agent it was asked about", () => {
    expect(ended({}, { b: { status: "done", at: T0 } })).toBeUndefined();
  });
});

describe("dirtyOf — the SAFETY reading, which filters where unlandedWorkOf does not", () => {
  it("says UNKNOWN when the branch was never polled", () => {
    expect(dirtyOf(undefined)).toBeUndefined();
  });

  it("carries the raw dirty flag and the true count", () => {
    expect(dirtyOf(branch({ dirty: true, dirtyCount: 3 }))).toEqual({ dirty: true, dirtyCount: 3 });
  });

  it("says clean on an affirmatively clean tree", () => {
    expect(dirtyOf(branch())).toEqual({ dirty: false });
  });

  // A build predating `dirtyCount` sends `dirty: true` with no count. Absent must stay absent — the
  // report says "did not record how many" rather than printing a 0 nobody measured.
  it("omits the count rather than defaulting it to zero", () => {
    expect(dirtyOf(branch({ dirty: true }))).toEqual({ dirty: true });
    expect(dirtyOf(branch({ dirty: true })!)!.dirtyCount).toBeUndefined();
  });

  // THE DIVERGENCE FROM `unlandedWorkOf`, ASSERTED SIDE BY SIDE. Parking carries the uncommitted
  // files along, so they are still on disk and a tear-down still destroys them — attribution
  // declines to answer, safety must not. Both read the SAME BranchStatus here, so a "simplification"
  // that routed one through the other would fail this.
  it("still reports a parked worktree as dirty, where unlandedWorkOf declines to answer", () => {
    const parked = branch({ dirty: true, dirtyCount: 2, worktreeOnBranch: false });
    expect(unlandedWorkOf(parked)).toBeUndefined();
    expect(dirtyOf(parked)).toEqual({ dirty: true, dirtyCount: 2 });
  });
});

describe("the mapping", () => {
  it("omits every optional the app could not supply, rather than defaulting it", () => {
    const s = snapshotOfAgent(agent(), input(), PROJECT_ID);
    expect(s.quota).toBeUndefined();
    expect(s.failure).toBeUndefined();
    expect(s.escalation).toBeUndefined();
    expect(s.goalMetAt).toBeUndefined();
    expect(s.hasUnlandedWork).toBeUndefined();
    expect(s.sessionEnded).toBeUndefined();
    expect(s.dirty).toBeUndefined();
    expect(s.dirtyCount).toBeUndefined();
  });

  it("carries the quota wall through verbatim, resetParsed included", () => {
    const msg = "You've hit your weekly limit · resets Aug 4 at 11pm (America/Bogota)";
    const s = snapshotOfAgent(
      agent(),
      input({ quotaFor: () => ({ message: msg, resetAt: T0 + 1000, resetParsed: true, at: T0 }) }), PROJECT_ID);
    expect(s.quota).toEqual({ message: msg, resetAt: T0 + 1000, resetParsed: true });
  });

  // Grouping is on these exact bytes; normalising here would destroy the evidence that one host
  // event killed several agents at once.
  it("carries the failure banner through UNNORMALISED", () => {
    const msg = "API Error: Unable to connect to API (ENOTFOUND)";
    const s = snapshotOfAgent(agent(), input({ failureFor: () => ({ message: msg, at: T0 - 5 }) }), PROJECT_ID);
    expect(s.failure).toEqual({ message: msg, at: T0 - 5 });
  });

  it("maps an escalated goal, with its reason", () => {
    const s = snapshotOfAgent(
      agent({ goal: { text: "x", setAt: T0, ttlMs: 1, escalatedAt: T0, escalationReason: "gave up" } } as Partial<AgentTab>),
      input(), PROJECT_ID);
    expect(s.escalation).toEqual({ reason: "gave up" });
  });

  it("maps an escalated goal with NO reason as escalated-but-unexplained", () => {
    const s = snapshotOfAgent(
      agent({ goal: { text: "x", setAt: T0, ttlMs: 1, escalatedAt: T0 } } as Partial<AgentTab>),
      input(), PROJECT_ID);
    expect(s.escalation).toEqual({});
  });

  it("does not report an unescalated goal as escalated", () => {
    const s = snapshotOfAgent(
      agent({ goal: { text: "x", setAt: T0, ttlMs: 1 } } as Partial<AgentTab>),
      input(), PROJECT_ID);
    expect(s.escalation).toBeUndefined();
  });

  it("maps a met goal", () => {
    const s = snapshotOfAgent(
      agent({ goal: { text: "x", setAt: T0, ttlMs: 1, metAt: T0 } } as Partial<AgentTab>),
      input(), PROJECT_ID);
    expect(s.goalMetAt).toBe(T0);
  });

  it("maps a dirty branch reading onto the uncommitted-work fields", () => {
    const s = snapshotOfAgent(
      agent(),
      input({
        branchStatus: { a: branch({ dirty: true, dirtyCount: 3 }) },
        sessionEndedFor: () => true,
      }),
      PROJECT_ID,
    );
    expect(s.dirty).toBe(true);
    expect(s.dirtyCount).toBe(3);
    expect(s.sessionEnded).toBe(true);
    // THE SIDE EFFECT, not the field: this exact mapping is what makes the core class fire. A
    // snapshot whose fields are individually right but which the evaluator rejects would pass every
    // assertion above and warn about nothing.
    expect(diedHoldingWork([s]).map((x) => x.agentId)).toEqual(["a"]);
  });

  // THE FAIL-CLOSED SEAM. An unpolled branch must map to ABSENT, never to `false` — and never to a
  // manufactured `true`, which would send the founder to rescue a worktree holding nothing.
  it("maps an ABSENT branch reading to undefined rather than to either answer", () => {
    const s = snapshotOfAgent(agent(), input({ sessionEndedFor: () => true }), PROJECT_ID);
    expect(s.dirty).toBeUndefined();
    expect(s.dirtyCount).toBeUndefined();
    expect(diedHoldingWork([s])).toEqual([]);
  });

  // The other half of the same rule, one field over: no pane reporting is not "still running".
  it("maps an unobserved session to undefined, so the class stays silent", () => {
    const s = snapshotOfAgent(
      agent(),
      input({ branchStatus: { a: branch({ dirty: true, dirtyCount: 3 }) } }),
      PROJECT_ID,
    );
    expect(s.sessionEnded).toBeUndefined();
    expect(diedHoldingWork([s])).toEqual([]);
  });

  it("does not manufacture a count the branch reading did not carry", () => {
    const s = snapshotOfAgent(
      agent(),
      input({ branchStatus: { a: branch({ dirty: true }) }, sessionEndedFor: () => true }),
      PROJECT_ID,
    );
    expect(s.dirty).toBe(true);
    expect(s.dirtyCount).toBeUndefined();
    // Still actionable — the class fires and names the agent; only the number is unknown.
    expect(diedHoldingWork([s]).map((x) => x.agentId)).toEqual(["a"]);
  });

  // THE SCENARIO THE FALLBACK EXISTS FOR, end to end: the row was closed (so the LIVE status is gone
  // for good) but the sidebar's closed-row poll has put `dirty` back. Before the fallback this pair
  // was permanently `sessionEnded: undefined` + `dirty: true` and the class said nothing — about the
  // one agent somebody is about to retire.
  it("warns about a CLOSED row whose branch poll still reports uncommitted work", () => {
    const s = snapshotOfAgent(
      agent(),
      input({
        branchStatus: { a: branch({ dirty: true, dirtyCount: 3 }) },
        // What the mount passes once the live entry is gone: only the captured one is left.
        sessionEndedFor: (id) =>
          sessionEndedOf(id, {}, { [id]: { status: "done", at: T0 } }, new Set()),
      }),
      PROJECT_ID,
    );
    expect(s.sessionEnded).toBe(true);
    expect(diedHoldingWork([s]).map((x) => x.agentId)).toEqual(["a"]);
  });

  it("asks about the agent it is mapping, not the first id it finds", () => {
    const seen: string[] = [];
    buildFleetSnapshots(
      input({
        projects: [project([agent({ id: "a" }), agent({ id: "b" })])],
        sessionEndedFor: (id) => {
          seen.push(id);
          return undefined;
        },
      }),
    );
    expect(seen).toEqual(["a", "b"]);
  });

  it("uses the SHARED display-name rule, so the report names what the sidebar shows", () => {
    const s = snapshotOfAgent(agent({ name: "Cockpit Resize", namePinned: true } as Partial<AgentTab>), input(), PROJECT_ID);
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
    expect(PASS_HOLD_TEXT["pane-wedged"]).toMatch(/will not clear itself/);
  });

  // The escalated arm has to carry the two things the ordinary one cannot: that the duty has been
  // off for a long time, and what to DO. Without an action it is a louder version of the same
  // sentence nobody acted on, which is the failure it was added for.
  it("tells the reader how long the duty has been off, and what to do about it", () => {
    expect(PASS_HOLD_TEXT["pane-wedged"]).toMatch(/three hours/);
    expect(PASS_HOLD_TEXT["pane-wedged"]).toMatch(/interrupt or restart/);
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
      "pane-wedged",
    ]);
  });
});
