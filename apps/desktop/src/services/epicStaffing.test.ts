// epicStaffing — the release seam's epic question (bead `sparkle-hrzitj`, failure 5).
//
// ── WHAT EVERY CASE HERE ASSERTS, AND WHY IT IS THE SIDE EFFECT ──────────────────────────────────
// The defect was SILENCE: retiring an orchestrator off an epic with 57 open children produced no
// record anywhere. So a test that asserts "the epic row exists" or "the agent was bound" pins a
// PRECONDITION that was already true on the day the bug shipped and proves nothing. Every case
// below asserts the thing that did not happen: a record landed in the ledger, and
// `unstaffedEpicsFromReleases()` — the input the `unstaffed-epic-alarm` nudge composes — changed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearEpicStaffingRecord,
  decideEpicStaffingOnRelease,
  describeEpicStaffingRecord,
  epicStaffingRecords,
  mergeUnstaffedEpicCount,
  noteEpicRelease,
  resetEpicStaffingLedger,
  unstaffedEpicsFromReleases,
  type EpicStaffingDeps,
} from "./epicStaffing";
import type { Bead } from "./beads";
import type { AgentTab } from "../types";

const NOW = 1_700_000_000_000;

const bead = (over: Partial<Bead> & { id: string }): Bead => ({
  title: over.id,
  description: "",
  status: "open",
  labels: [],
  parent: null,
  commentCount: 0,
  ...over,
});

const buildAgent = (over: Partial<AgentTab> & { id: string }): AgentTab =>
  ({ name: over.id, kind: "build", ...over }) as AgentTab;

/** An epic with three children, two of them still open — the shape the bead measured, shrunk. */
const EPIC_WITH_OPEN_WORK: Bead[] = [
  bead({ id: "e1", title: "Ship the thing", type: "epic" }),
  bead({ id: "e1.1", parent: "e1", status: "open" }),
  bead({ id: "e1.2", parent: "e1", status: "in_progress" }),
  bead({ id: "e1.3", parent: "e1", status: "closed" }),
];

/** The orchestrator that just marked its goal met, plus whatever else the case needs. */
function deps(over: Partial<EpicStaffingDeps> & { agents?: AgentTab[]; beads?: Bead[] | undefined }): EpicStaffingDeps {
  const agents = over.agents ?? [buildAgent({ id: "a1", epicId: "e1" })];
  const hasBeads = Object.prototype.hasOwnProperty.call(over, "beads");
  const beads = hasBeads ? over.beads : EPIC_WITH_OPEN_WORK;
  return {
    now: () => NOW,
    locate: (id) => {
      const agent = agents.find((a) => a.id === id);
      return agent ? { agent, agents, projectId: "p1" } : undefined;
    },
    beadsFor: () => beads,
    boundAgents: (list, epicId) => list.filter((a) => a.kind === "build" && a.epicId === epicId),
    // Nobody else is observed by default; the per-case overrides below say otherwise.
    aliveFor: () => undefined,
    statusFor: () => undefined,
    attentionFor: () => undefined,
    deathRecordedFor: () => false,
    lastHookEventFor: () => undefined,
    ...over,
  };
}

beforeEach(() => {
  resetEpicStaffingLedger();
});

describe("decideEpicStaffingOnRelease", () => {
  const base = {
    releasedAgentId: "a1",
    projectId: "p1",
    cause: "goal-met" as const,
    epicId: "e1",
    at: NOW,
  };

  it("RECORDS UNSTAFFED when the leaver was the only orchestrator and children are still open", () => {
    const out = decideEpicStaffingOnRelease({ ...base, openChildren: 57, otherStaffing: false });
    expect(out.kind).toBe("unstaffed");
    if (out.kind !== "unstaffed") throw new Error("unreachable");
    expect(out.record.openChildren).toBe(57);
    expect(out.record.state).toBe("unstaffed");
    expect(out.record.at).toBe(NOW);
  });

  it("says EPIC-COMPLETE — and produces no record — when no children remain open", () => {
    expect(decideEpicStaffingOnRelease({ ...base, openChildren: 0, otherStaffing: false })).toEqual({
      kind: "epic-complete",
      epicId: "e1",
      openChildren: 0,
    });
  });

  it("says STILL-STAFFED when another orchestrator is on it, even with open children", () => {
    expect(decideEpicStaffingOnRelease({ ...base, openChildren: 57, otherStaffing: true })).toEqual({
      kind: "still-staffed",
      epicId: "e1",
    });
  });

  it("STILL-STAFFED outranks an unreadable board — a live successor needs no child count", () => {
    expect(decideEpicStaffingOnRelease({ ...base, openChildren: null, otherStaffing: true }).kind).toBe(
      "still-staffed",
    );
  });

  it("FAILS CLOSED on an unreadable board: could-not-tell, WITH a record, never epic-complete", () => {
    const out = decideEpicStaffingOnRelease({ ...base, openChildren: null, otherStaffing: false });
    expect(out.kind).toBe("could-not-tell");
    if (out.kind !== "could-not-tell") throw new Error("unreachable");
    expect(out.record.openChildren).toBeNull();
    expect(out.record.state).toBe("could-not-tell");
  });

  it("FAILS CLOSED when other-staffing could not be established", () => {
    const out = decideEpicStaffingOnRelease({ ...base, openChildren: 3, otherStaffing: null });
    expect(out.kind).toBe("could-not-tell");
  });

  it("says nothing at all for an agent bound to no epic", () => {
    expect(
      decideEpicStaffingOnRelease({ ...base, epicId: undefined, openChildren: 3, otherStaffing: false }),
    ).toEqual({ kind: "not-bound" });
  });
});

describe("noteEpicRelease — the ledger, which is what the alarm reads", () => {
  it("THE MEASURED FAILURE: an orchestrator marking its goal met leaves a recorded unstaffed epic", () => {
    expect(unstaffedEpicsFromReleases().count).toBe(0);

    const out = noteEpicRelease("a1", "goal-met", deps({}));

    expect(out.kind).toBe("unstaffed");
    expect(unstaffedEpicsFromReleases()).toEqual({
      epicIds: ["e1"],
      couldNotTellEpicIds: [],
      count: 1,
    });
    const rec = epicStaffingRecords()[0]!;
    // TWO OPEN CHILDREN, not three: the closed one is done work and must not be counted as a
    // reason to restaff. This is `beads.openChildCount`'s answer, reached through the seam.
    expect(rec.openChildren).toBe(2);
    expect(rec.releasedAgentId).toBe("a1");
    expect(rec.cause).toBe("goal-met");
  });

  it("records the same way on RETIRE, and says which cause it was", () => {
    noteEpicRelease("a1", "retired", deps({}));
    expect(epicStaffingRecords()[0]?.cause).toBe("retired");
    expect(unstaffedEpicsFromReleases().count).toBe(1);
  });

  it("does NOT count the leaver as its own successor — the gate that would never fire", () => {
    // `a1` is bound to `e1` and is alive and working. If the released agent were left in the
    // bound set, this would read `still-staffed` and NOTHING would ever be recorded.
    const out = noteEpicRelease(
      "a1",
      "goal-met",
      deps({ aliveFor: () => true, lastHookEventFor: () => NOW - 1000 }),
    );
    expect(out.kind).toBe("unstaffed");
    expect(unstaffedEpicsFromReleases().count).toBe(1);
  });

  it("RECORDS NOTHING when a second bound orchestrator is alive and working", () => {
    const agents = [buildAgent({ id: "a1", epicId: "e1" }), buildAgent({ id: "a2", epicId: "e1" })];
    const out = noteEpicRelease(
      "a1",
      "goal-met",
      deps({ agents, aliveFor: (id) => id === "a2", lastHookEventFor: () => NOW - 1000 }),
    );
    expect(out).toEqual({ kind: "still-staffed", epicId: "e1" });
    expect(unstaffedEpicsFromReleases().count).toBe(0);
  });

  it("RETRACTS an earlier alarm when a later release finds the epic staffed again", () => {
    noteEpicRelease("a1", "goal-met", deps({}));
    expect(unstaffedEpicsFromReleases().count).toBe(1);

    const agents = [buildAgent({ id: "a1", epicId: "e1" }), buildAgent({ id: "a2", epicId: "e1" })];
    noteEpicRelease(
      "a2",
      "goal-met",
      deps({ agents, aliveFor: (id) => id === "a1", lastHookEventFor: () => NOW - 1000 }),
    );
    expect(unstaffedEpicsFromReleases().count).toBe(0);
  });

  it("AN UNREADABLE BOARD IS SURFACED, not silently treated as an empty epic", () => {
    const out = noteEpicRelease("a1", "goal-met", deps({ beads: undefined }));
    expect(out.kind).toBe("could-not-tell");
    expect(unstaffedEpicsFromReleases()).toEqual({
      epicIds: [],
      couldNotTellEpicIds: ["e1"],
      count: 1,
    });
    expect(epicStaffingRecords()[0]?.openChildren).toBeNull();
  });

  it("records NOTHING for an epic whose children have all closed", () => {
    const done = [
      bead({ id: "e1", title: "Ship the thing", type: "epic" }),
      bead({ id: "e1.1", parent: "e1", status: "closed" }),
    ];
    expect(noteEpicRelease("a1", "goal-met", deps({ beads: done }))).toEqual({
      kind: "epic-complete",
      epicId: "e1",
      openChildren: 0,
    });
    expect(unstaffedEpicsFromReleases().count).toBe(0);
  });

  it("records nothing for an agent bound to no epic", () => {
    const agents = [buildAgent({ id: "a1" })];
    expect(noteEpicRelease("a1", "goal-met", deps({ agents })).kind).toBe("not-bound");
    expect(unstaffedEpicsFromReleases().count).toBe(0);
  });

  // NEVER THROWS, AND NEVER GOES QUIET (roborev 78693). Both halves are the assertion.
  //
  // This test used to assert `{ kind: "not-bound" }`, which PINNED THE DEFECT: a throwing reader
  // produced no ledger record, nothing in `unstaffedEpicsFromReleases()`, and a positive claim
  // ("this agent carried no epic") the code cannot make once the epic HAS been resolved. It was
  // strictly worse than the `beads === undefined` path beside it, which records `could-not-tell` —
  // and because the test asserted that outcome, a mutation making the reader throw kept the whole
  // suite green while the feature was inert. Assert the SIDE EFFECT — the epic is surfaced — not
  // merely that the call returned.
  it("NEVER THROWS, and a throwing reader still SURFACES the epic as could-not-tell", () => {
    const out = noteEpicRelease(
      "a1",
      "goal-met",
      deps({
        beadsFor: () => {
          throw new Error("board blew up");
        },
      }),
    );
    expect(out.kind).toBe("could-not-tell");
    // THE SIDE EFFECT: it reached the ledger, so a reader asking "what is unstaffed" is told.
    const records = epicStaffingRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ epicId: "e1", state: "could-not-tell", openChildren: null });
    expect(unstaffedEpicsFromReleases().count).toBe(1);
  });

  // THE MIRROR, on a DIFFERENT reader — the fix must not be special-cased to `beadsFor`. A throwing
  // liveness reader lands in the same catch and must be surfaced identically.
  it("a throwing LIVENESS reader is surfaced the same way, not swallowed", () => {
    const agents = [buildAgent({ id: "a1", epicId: "e1" }), buildAgent({ id: "a2", epicId: "e1" })];
    const out = noteEpicRelease(
      "a1",
      "goal-met",
      deps({
        agents,
        aliveFor: () => {
          throw new Error("liveness blew up");
        },
      }),
    );
    expect(out.kind).toBe("could-not-tell");
    expect(unstaffedEpicsFromReleases().count).toBe(1);
  });

  // AND THE ARM THAT MUST STAY `not-bound`: the two cases that genuinely establish it return before
  // anything can throw, so widening the catch must not have widened these.
  it("still answers not-bound when the agent truly carries no epic", () => {
    const agents = [buildAgent({ id: "a1" })];
    const out = noteEpicRelease(
      "a1",
      "goal-met",
      deps({
        agents,
        beadsFor: () => {
          throw new Error("board blew up");
        },
      }),
    );
    expect(out).toEqual({ kind: "not-bound" });
    expect(unstaffedEpicsFromReleases().count).toBe(0);
  });

  it("a second release against the same epic REPLACES the record rather than double-counting", () => {
    noteEpicRelease("a1", "goal-met", deps({}));
    const agents = [buildAgent({ id: "a1", epicId: "e1" }), buildAgent({ id: "a2", epicId: "e1" })];
    noteEpicRelease("a2", "retired", deps({ agents }));
    expect(unstaffedEpicsFromReleases().count).toBe(1);
    expect(epicStaffingRecords()[0]?.releasedAgentId).toBe("a2");
  });

  it("clearEpicStaffingRecord retracts and says whether it did", () => {
    noteEpicRelease("a1", "goal-met", deps({}));
    expect(clearEpicStaffingRecord("e1")).toBe(true);
    expect(unstaffedEpicsFromReleases().count).toBe(0);
    expect(clearEpicStaffingRecord("e1")).toBe(false);
  });
});

describe("describeEpicStaffingRecord", () => {
  it("names the epic AND the open-child count — the count is the reason to act", () => {
    noteEpicRelease("a1", "goal-met", deps({}));
    const line = describeEpicStaffingRecord(epicStaffingRecords()[0]!);
    expect(line).toContain("e1");
    expect(line).toContain("2 open children");
    expect(line).toContain("UNSTAFFED");
  });

  it("an unreadable board says the count is UNKNOWN rather than printing a number", () => {
    noteEpicRelease("a1", "goal-met", deps({ beads: undefined }));
    const line = describeEpicStaffingRecord(epicStaffingRecords()[0]!);
    expect(line).toContain("UNKNOWN");
    expect(line).not.toMatch(/\b0 open children\b/);
  });
});

describe("the clock is the caller's", () => {
  it("stamps the record with the injected now, so the reading carries its own age", () => {
    const spy = vi.fn(() => 42);
    noteEpicRelease("a1", "goal-met", deps({ now: spy }));
    expect(epicStaffingRecords()[0]?.at).toBe(42);
    expect(spy).toHaveBeenCalled();
  });
});

describe("mergeUnstaffedEpicCount — the alarm composition", () => {
  // The release arg is REQUIRED rather than defaulted (roborev 79589): the ledger is fleet-wide and
  // the board count is one project, so a caller that folds them must say WHICH project's releases
  // it means. A default made the unscoped read the easy one to reach for, and that is the defect.
  const releases = (projectId = "p1") => unstaffedEpicsFromReleases(projectId);

  it("raises a board count of ZERO to the release ledger's count — the window the board misses", () => {
    noteEpicRelease("a1", "goal-met", deps({}));
    expect(mergeUnstaffedEpicCount(0, releases())).toBe(1);
  });

  it("keeps the LARGER of the two and never sums — the populations overlap with no id to join on", () => {
    noteEpicRelease("a1", "goal-met", deps({}));
    expect(mergeUnstaffedEpicCount(4, releases())).toBe(4);
  });

  it("PRESERVES null: an unreadable board must not be handed a number we could not have measured", () => {
    noteEpicRelease("a1", "goal-met", deps({}));
    expect(mergeUnstaffedEpicCount(null, releases())).toBeNull();
  });

  it("is the identity on an empty ledger", () => {
    expect(mergeUnstaffedEpicCount(3, releases())).toBe(3);
    expect(mergeUnstaffedEpicCount(0, releases())).toBe(0);
  });

  // ── ANOTHER PROJECT'S EPIC IS NOT THIS BOARD'S EMERGENCY (roborev 79589). ────────────────────
  // `locate` scans EVERY project, so a release anywhere fills this ledger. Folded in unscoped, one
  // foreign release took the loudest push on the Sparkle board — an alarm about an epic that agent
  // cannot see, which never self-clears, because the retraction only fires when THAT epic is
  // restaffed or drained. Asserted from both sides so the filter cannot pass by matching nothing.
  it("EXCLUDES a release recorded for another project", () => {
    noteEpicRelease("a1", "goal-met", deps({}));  // recorded against "p1"
    expect(unstaffedEpicsFromReleases("p1").count, "same project: seen").toBe(1);
    expect(unstaffedEpicsFromReleases("other").count, "foreign project: not seen").toBe(0);
    expect(mergeUnstaffedEpicCount(0, releases("other"))).toBe(0);
  });

  it("still reads FLEET-WIDE when no project is named", () => {
    noteEpicRelease("a1", "goal-met", deps({}));
    expect(unstaffedEpicsFromReleases().count).toBe(1);
  });
});
