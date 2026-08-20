// THE TWO HALVES, COMPOSED — `agentsForEpicSlices` feeding `rollUpEpicGoal`, over one nested
// fixture, exactly as `EpicGoalRowForEpic` runs them.
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────────────────
// The contract between the two was enforced by a docstring and nothing else, and that gap shipped
// two inert fixes in a row (roborev 65849, then 65874). Each suite hand-built the OTHER half's
// input: `epicGoalRollup.test.ts` invented rosters the documented caller cannot produce, and
// `epicLadder.test.ts` asserted list MEMBERSHIP and never asked what the list did downstream. So
// both were green while the seam was broken — the first fix could not reach the agent it was
// written for, and the second admitted an agent the matcher could not consume and, purely by being
// present, flipped `started` and turned every unmatched slice into a `stranded` false alarm.
//
// Every assertion here is on the PAINTED RESULT — the per-slice state a person would read — never
// on membership. A mutation of either half has to change one of these.
import { describe, expect, it } from "vitest";

import { rollUpEpicGoal } from "../engine/epicGoalRollup";
import { DEFAULT_GOAL_TTL_MS, type AgentGoal } from "../engine/agentGoal";
import { agentsForEpicSlices, type LadderAgent } from "./epicLadder";
import { childrenOf, type Bead } from "./beads";

const NOW = 1_700_000_000_000;

const bead = (over: Partial<Bead> & { id: string }): Bead => ({
  title: over.id,
  description: "",
  status: "open",
  labels: [],
  ...over,
});

/** e1 has two children: an ordinary task, and a SUB-EPIC that has two tasks of its own.
 *
 *  ⚠️ `t9` IS DELIBERATELY FLAT-IDDED AND `parent`-LINKED (roborev 65885). Epic membership in this
 *  repo is EITHER edge — `buildEpicIndex` links by `parent` OR by dotted prefix — because a bead
 *  reparented with `bd update <id> --parent <epic>` keeps its original flat id. An all-dotted
 *  fixture leaves that half of the rule unexercised, which is how a walk that read only the id
 *  string passed both suites while dropping every reparented child's agent. */
const BEADS: Bead[] = [
  bead({ id: "e1", type: "epic" }),
  bead({ id: "e1.t1", parent: "e1" }),
  bead({ id: "e1.sub", type: "epic", parent: "e1" }),
  bead({ id: "e1.sub.t2", parent: "e1.sub" }),
  // …and the MIRROR of `t9`: a dotted id with NO `parent` field, which is what bd writes when it
  // derives the id itself. Only the prefix arm of the walk can reach this one, exactly as only the
  // parent arm can reach `t9` — so the fixture exercises both halves of the membership union and
  // neither arm can be deleted without a test going red.
  bead({ id: "e1.sub.t3" }),
  // A SECOND sub-epic, reached ONLY by the parent edge, so the reparented worker below has a slice
  // nobody else covers and its attribution is its own claim (roborev 65895). Sharing `e1.sub` with
  // the deep worker made that shape inert: deleting the parent arm entirely left every assertion
  // green.
  bead({ id: "e1.sub2", type: "epic", parent: "e1" }),
  bead({ id: "t9", parent: "e1.sub2" }),
  // An UNRELATED epic with a real chain, so the climb actually runs and must terminate outside e1's
  // children — an over-reaching `parent` walk has something to over-reach with.
  bead({ id: "other", type: "epic" }),
  bead({ id: "o1", parent: "other" }),
  // A SELF-PARENTED bead. Without the `seen` cycle guard the walk never terminates; a shared store
  // can certainly hold one, and no fixture exercised it.
  bead({ id: "loop", parent: "loop" }),
];

const live = (over: Partial<AgentGoal> = {}): AgentGoal => ({
  text: "the thing is done and verifiable",
  setAt: NOW - 60_000,
  ttlMs: DEFAULT_GOAL_TTL_MS,
  continues: 0,
  totalContinues: 0,
  ...over,
});

/** The shape `prepareHandoff` stamps: the epic id in BOTH fields. */
const orchestrator = (epicId: string, goal = live()) => ({
  id: `o-${epicId}`,
  epicId,
  beadId: epicId,
  goal,
});
const worker = (beadId: string, goal = live()) => ({ id: `w-${beadId}`, beadId, goal });

/** The same fixture with one child CLOSED.
 *
 *  ⚠️ EVERY ATTRIBUTION TEST MUST RUN OVER THIS, not over the pristine `BEADS` (roborev 65891).
 *  `started` is bead-derived: with every bead `open`, nothing can EVER be `stranded`, so a test
 *  asserting `stranded === 0` is true no matter what `agentsForEpicSlices` returns — `slicesUnder`
 *  could return `[]` for every agent and it would still pass. An assertion that was already true
 *  before the change is exactly the vacuous shape this file exists to prevent, and it got
 *  reintroduced here by a FIX rather than by new code. Closing one child is what makes an
 *  unattributed slice paint `stranded`, i.e. what makes the other slices' `open` mean something. */
const MOVED: Bead[] = BEADS.map((b) => (b.id === "e1.t1" ? { ...b, status: "closed" as const } : b));

/** The real pipeline, run the way the connected component runs it. */
function paint(roster: readonly (LadderAgent & { goal?: AgentGoal })[], epicId = "e1") {
  const r = rollUpEpicGoal(
    childrenOf(BEADS, epicId),
    agentsForEpicSlices(roster, BEADS, epicId),
    NOW,
  );
  return {
    ...r,
    stateOf: (id: string) => r.slices.find((s) => s.beadId === id)?.state,
  };
}

/** The same, over {@link MOVED} — the fixture in which an unattributed slice can actually show. */
function paintMoved(roster: readonly (LadderAgent & { goal?: AgentGoal })[], epicId = "e1") {
  const r = rollUpEpicGoal(
    childrenOf(MOVED, epicId),
    agentsForEpicSlices(roster, MOVED, epicId),
    NOW,
  );
  return {
    ...r,
    stateOf: (id: string) => r.slices.find((s) => s.beadId === id)?.state,
  };
}

describe("agentsForEpicSlices → rollUpEpicGoal", () => {
  it("ALL THREE agent shapes at once: nothing with a live agent beneath it reads stranded", () => {
    // Mounted together on purpose. Any one of these alone can pass against a rule keyed to the
    // wrong field — it is having all three present, and every slice accounted for, that makes the
    // assertion mean the attribution is right.
    const r = paintMoved([
      orchestrator("e1"), //        carries the WHOLE epic, not a slice
      worker("t9"), //              a REPARENTED flat-id child, under a sub-epic NOBODY else covers
      worker("e1.sub.t2"), //       DEEP under the sub-epic — two rungs from e1
    ]);
    // Named PER SLICE rather than as a blanket count, so each attribution is its own claim.
    expect(r.stateOf("e1.t1")).toBe("done");
    expect(r.stateOf("e1.sub")).toBe("open");
    expect(r.stateOf("e1.sub.t2")).toBe("open");
    // …and the slice NOBODY covers reads stranded, which is what makes the two `open`s above a
    // statement about attribution rather than about `started` being false.
    // `t9`'s own sub-epic, reachable only through the parent edge — deleting that arm strands it.
    expect(r.stateOf("e1.sub2")).toBe("open");
    expect(r.stateOf("e1.sub.t3")).toBe("stranded");
    expect(r.stranded).toBe(1);
    expect(r.readyToClose).toBe(false);
  });

  it("a DEEP worker alone covers BOTH its own slice and its sub-epic ancestor", () => {
    // The regression roborev 65874 measured: with only this agent, the widened list flipped
    // `started` to true while matching NOTHING, so every child painted stranded — including the
    // sub-epic the worker is demonstrably working under.
    //
    // Note `e1.sub.t2` is itself a slice of e1: `buildEpicIndex` links a bead to EVERY dotted
    // prefix, so a grandchild is a child too. That is why one agent covers two slices, and why
    // only `e1.t1` — which genuinely has nobody — is stranded.
    // `e1.t1` is CLOSED here so the epic has bead-side evidence that work began — without it,
    // nothing is stranded at all and this test could not tell the covered slices from the
    // uncovered one.
    const moved: Bead[] = BEADS.map((b) =>
      b.id === "e1.t1" ? { ...b, status: "closed" as const } : b,
    );
    const r = rollUpEpicGoal(
      childrenOf(moved, "e1"),
      agentsForEpicSlices([worker("e1.sub.t2")], moved, "e1"),
      NOW,
    );
    const stateOf = (id: string) => r.slices.find((s) => s.beadId === id)?.state;
    expect(stateOf("e1.sub")).toBe("open");
    expect(stateOf("e1.sub.t2")).toBe("open");
    expect(stateOf("e1.t1")).toBe("done");
    // The fixture's OTHER sub-epic task has nobody on it, and correctly reads stranded — which is
    // what makes the two `open`s above mean something rather than being a blanket suppression.
    // Both slices nobody covers read stranded — `e1.sub.t3` and the second sub-epic — which is what
    // makes the two `open`s above a statement about attribution rather than about `started`.
    expect(stateOf("e1.sub.t3")).toBe("stranded");
    expect(stateOf("e1.sub2")).toBe("stranded");
    expect(r.stranded).toBe(2);
  });

  it("a sub-epic's ORCHESTRATOR carries that slice", () => {
    const moved: Bead[] = BEADS.map((b) =>
      b.id === "e1.t1" ? { ...b, status: "closed" as const } : b,
    );
    const r = rollUpEpicGoal(
      childrenOf(moved, "e1"),
      agentsForEpicSlices([orchestrator("e1.sub")], moved, "e1"),
      NOW,
    );
    const stateOf = (id: string) => r.slices.find((s) => s.beadId === id)?.state;
    expect(stateOf("e1.sub")).toBe("open");
    // …but NOT the sub-epic's own child: an orchestrator carries the sub-epic, and nobody has
    // picked up the task beneath it yet.
    expect(stateOf("e1.sub.t2")).toBe("stranded");
  });

  it("an epic-level orchestrator carries NO slice, and does NOT make every child look abandoned", () => {
    // roborev 65885. Its beadId is the epic id, which matches no child — correct, it carries the
    // whole epic. But counting it as evidence that work BEGAN painted every child "nothing is
    // carrying this slice" during the ordinary window between dispatching an orchestrator and that
    // orchestrator spawning its first worker: a red mark on every freshly-started epic. The
    // previous version of this test asserted exactly that, i.e. it pinned the defect as intent.
    const r = paint([orchestrator("e1")]);
    expect(r.slices.every((s) => s.state === "open")).toBe(true);
    expect(r.stranded).toBe(0);
  });

  it("…and the PAIRED case: once a bead has moved, a slice nobody carries IS stranded", () => {
    // The capability the rule protects — a genuinely unowned slice stays distinguishable from a
    // fresh one — rather than the label. Without this, suppressing `stranded` everywhere would pass.
    const moved: Bead[] = BEADS.map((b) =>
      b.id === "e1.t1" ? { ...b, status: "closed" as const } : b,
    );
    const r = rollUpEpicGoal(
      childrenOf(moved, "e1"),
      agentsForEpicSlices([orchestrator("e1")], moved, "e1"),
      NOW,
    );
    expect(r.slices.find((s) => s.beadId === "e1.sub")?.state).toBe("stranded");
    expect(r.slices.find((s) => s.beadId === "e1.t1")?.state).toBe("done");
  });

  it("a DOTTED-id child with no `parent` field is reached too — the other half of the union", () => {
    // The mirror of the test below. `e1.sub.t3` carries no `parent`, so only the prefix arm of the
    // walk resolves it; deleting that arm strands the sub-epic while a worker sits under it.
    const moved: Bead[] = BEADS.map((b) =>
      b.id === "e1.t1" ? { ...b, status: "closed" as const } : b,
    );
    const r = rollUpEpicGoal(
      childrenOf(moved, "e1"),
      agentsForEpicSlices([worker("e1.sub.t3")], moved, "e1"),
      NOW,
    );
    expect(r.slices.find((s) => s.beadId === "e1.sub")?.state).toBe("open");
    expect(r.slices.find((s) => s.beadId === "e1.sub.t3")?.state).toBe("open");
  });

  it("a REPARENTED flat-id child's worker still reaches its sub-epic slice", () => {
    // roborev 65885: the parent-edge half of membership. `t9` has no dot in its id, so a
    // prefix-only walk saw nothing, dropped this agent from the list entirely, and the sub-epic it
    // is demonstrably working under reverted to looking unowned.
    const moved: Bead[] = BEADS.map((b) =>
      b.id === "e1.t1" ? { ...b, status: "closed" as const } : b,
    );
    const r = rollUpEpicGoal(
      childrenOf(moved, "e1"),
      agentsForEpicSlices([worker("t9")], moved, "e1"),
      NOW,
    );
    // `e1.sub2` is reachable ONLY through the parent edge, and nobody else covers it — so this is
    // the flat-id shape's own claim rather than one another agent already satisfies.
    expect(r.slices.find((s) => s.beadId === "e1.sub2")?.state).toBe("open");
    // `t9` is NOT itself a slice of e1: the `parent` edge is not transitive (only the dotted-id
    // half is), so it is a child of e1.sub2 alone. What matters is that its worker was not dropped
    // and reaches the e1.sub2 slice above.
    expect(r.slices.find((s) => s.beadId === "t9")).toBeUndefined();
    expect(agentsForEpicSlices([worker("t9")], moved, "e1")[0]?.sliceIds).toEqual(["e1.sub2"]);
  });

  it("with NOBODY on the epic, nothing is stranded — an untouched backlog epic is just open", () => {
    const r = paint([]);
    expect(r.slices.every((s) => s.state === "open")).toBe(true);
    expect(r.stranded).toBe(0);
  });

  it("a deep worker that GAVE UP drops its sub-epic slice, rather than merely leaving it open", () => {
    const gone = worker("e1.sub.t2", live({ escalatedAt: NOW - 1, escalationReason: "stuck" }));
    const r = paint([gone, worker("e1.t1")]);
    // BOTH slices it covered are dropped — the task it abandoned, and the sub-epic that task was
    // the only work under.
    for (const id of ["e1.sub.t2", "e1.sub"]) {
      expect(r.slices.find((s) => s.beadId === id)).toMatchObject({ state: "dropped", reason: "stuck" });
    }
    expect(r.stateOf("e1.t1")).toBe("open");
  });

  it("an agent on an UNRELATED epic reaches none of it", () => {
    // THE FILE'S ONLY NEGATIVE-ATTRIBUTION GUARD, and it has to run over MOVED to have any force
    // (roborev 65891): over the pristine fixture nothing can be stranded, so "no slice was wrongly
    // attributed" and "attribution is switched off entirely" look identical. The risk it guards
    // grew when `slicesUnder` became a transitive climb over `parent` edges — a chain that wrongly
    // reached into another epic's children would show up exactly here.
    // Both agents sit on REAL beads with a real parent chain, so the climb genuinely runs and has
    // to terminate outside e1's children (roborev 65895). With unknown ids it exited immediately
    // and an over-reaching walk had nothing to over-reach with.
    const r = paintMoved([orchestrator("other"), worker("o1")]);
    for (const id of ["e1.sub", "e1.sub2", "e1.sub.t2", "e1.sub.t3"]) {
      expect(r.stateOf(id)).toBe("stranded");
    }
    expect(r.stateOf("e1.t1")).toBe("done");
  });

  it("a SELF-PARENTED bead terminates rather than hanging, and reaches no slice", () => {
    // The cycle guard. Nothing exercised it, so removing `seen.has(id)` was undetectable — and its
    // failure mode is a hang, not a wrong answer.
    expect(agentsForEpicSlices([worker("loop")], MOVED, "e1")).toEqual([]);
  });

  it("closing every child is what makes the epic closable, whoever is left on it", () => {
    const closed: Bead[] = BEADS.map((b) =>
      b.id === "e1" ? b : { ...b, status: "closed" as const },
    );
    const r = rollUpEpicGoal(
      childrenOf(closed, "e1"),
      agentsForEpicSlices([], closed, "e1"),
      NOW,
    );
    expect(r.readyToClose).toBe(true);
  });
});
