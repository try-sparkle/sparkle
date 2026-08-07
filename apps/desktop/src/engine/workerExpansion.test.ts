import { describe, expect, it } from "vitest";
import { attentionWorkersOf } from "./workerExpansion";
import type { AgentKind, AgentTabStatus } from "../types";

interface Node {
  id: string;
  kind: AgentKind;
  parentId: string | null;
}

// THE PEEK'S CONTENT. `attentionWorkersOf` names the workers a CLOSED head should peek for, and it
// is the ONLY thing that decides whether a peek appears at all — the render calls it and shows a line
// iff the result is non-empty. There was briefly a second gate in the component (a per-head "does
// this subtree read needs_you" memo) which could only ever agree with this; while both existed
// neither could be shown to matter, because mutating either left the other masking it and the
// "green never peeks" test passed against both mutants. One mechanism, one thing to test.
const PEEK: Node[] = [
  { id: "p1", kind: "build", parentId: null },
  { id: "w1", kind: "worker", parentId: "p1" },
  { id: "w2", kind: "worker", parentId: "p1" },
  { id: "p2", kind: "build", parentId: null },
  { id: "w3", kind: "worker", parentId: "p2" },
];
const peekIds = (map: Record<string, AgentTabStatus>, head = "p1") =>
  attentionWorkersOf(PEEK, head, (id) => map[id] ?? "stopped", (id) => map[id] !== undefined).map(
    (w) => w.id,
  );

describe("attentionWorkersOf — who the peek names", () => {
  it("names only the red workers under the head asked about", () => {
    expect(peekIds({ w1: "waiting", w2: "working", w3: "errored" })).toEqual(["w1"]);
  });

  it("names every red worker, so the caller can show a COUNT rather than one arbitrary name", () => {
    expect(peekIds({ w1: "waiting", w2: "errored" })).toEqual(["w1", "w2"]);
  });

  // The rule that keeps the peek from becoming a second expansion: a settled fleet peeks NOTHING,
  // however many workers it has.
  it("names nobody when every worker is green or gray", () => {
    expect(peekIds({ w1: "working", w2: "done" })).toEqual([]);
    expect(peekIds({ w1: "idle", w2: "stopped" })).toEqual([]);
  });

  it("ignores a red worker belonging to a DIFFERENT head", () => {
    expect(peekIds({ w3: "errored" })).toEqual([]);
    expect(peekIds({ w3: "errored" }, "p2")).toEqual(["w3"]);
  });

  // Same liveness rule as the snapshot: a synthetic red on a never-live worker would make the peek
  // flicker at the rate of the open/evict race.
  it("does not name a worker with no live status, however red it reads", () => {
    expect(attentionWorkersOf(PEEK, "p1", () => "errored", () => false)).toEqual([]);
  });

  // Every status in the needs_you band peeks, because the shared BAND decides — not a second
  // hand-rolled "is it red" list that could drift from the dots and the filter chips.
  it.each<AgentTabStatus>(["waiting", "approval", "blocked", "errored"])(
    "peeks for a %s worker",
    (st) => {
      expect(peekIds({ w1: st })).toEqual(["w1"]);
    },
  );

  // …and no CALM status does. `unmerged` is deliberately absent from this list — it is an ASK, and
  // it has its own block below.
  it.each<AgentTabStatus>(["working", "idle", "done", "stopped", "new"])(
    "does not peek for a %s worker",
    (st) => {
      expect(peekIds({ w1: st })).toEqual([]);
    },
  );
});

// ── `unmerged` is an ASK, and under a collapsed head it had no surface at all ──────────────────
//
// THE BUG THIS BLOCK PINS. Worker rows default to COLLAPSED, so by default a worker has no row.
// The peek was the only escape hatch and it admitted the `needs_you` band alone — and `unmerged`
// bands `done` (buildSections). The parent's dot was the last chance and it absorbed the signal
// too (workerRollup counted gray workers as nothing). Net: an orchestrator with three workers each
// holding an un-landed PR rendered as ONE collapsed gray row. Three things the user owes, zero
// pixels — and he cannot know what he was not shown.
//
// Founder's product rule, verbatim (bead sparkle-qogah.3, P0): "We should never hide a row that
// needs action from me." "Needs merge" is named in that rule as an action he owes. So it peeks.
describe("attentionWorkersOf — a worker that needs MERGE reaches the peek", () => {
  it("names an `unmerged` worker under a collapsed head", () => {
    expect(peekIds({ w1: "unmerged" })).toEqual(["w1"]);
  });

  it("names it alongside the reds, in list order", () => {
    expect(peekIds({ w1: "unmerged", w2: "waiting" })).toEqual(["w1", "w2"]);
  });

  // NO CAP. Founder's rule again: "If uncapping makes a surface tall, that is CORRECT. Scroll it;
  // do not hide it." Whatever the caller does with the list, this function hands back every worker
  // that owes something — a cap here would be the bug wearing a justification.
  it("names EVERY unmerged worker, never a truncated sample", () => {
    const many = [
      { id: "h", kind: "build" as const, parentId: null },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `m${i}`,
        kind: "worker" as const,
        parentId: "h",
      })),
    ];
    const ids = attentionWorkersOf(many, "h", () => "unmerged", () => false).map((a) => a.id);
    expect(ids).toHaveLength(8);
  });

  // The `kind: "worker"` predicate, which nothing pinned before: the fixture had no non-worker
  // CHILD to catch it, so deleting that check left the whole suite green. A nested shell never
  // renders as a child row, so peeking for one would name a row the subtree cannot show — and it
  // would do so for the gray `unmerged` case too, which is why it is worth a test now.
  it("never names a child that is not a worker, however loudly it reads", () => {
    const nested = [
      { id: "h", kind: "build" as const, parentId: null },
      { id: "sh", kind: "shell" as const, parentId: "h" },
    ];
    expect(attentionWorkersOf(nested, "h", () => "unmerged", () => true)).toEqual([]);
    expect(attentionWorkersOf(nested, "h", () => "errored", () => true)).toEqual([]);
  });

  it("still ignores an unmerged worker belonging to a DIFFERENT head", () => {
    expect(peekIds({ w3: "unmerged" })).toEqual([]);
    expect(peekIds({ w3: "unmerged" }, "p2")).toEqual(["w3"]);
  });

  // THE STRANDED CASE, and the reason the liveness guard is not applied to this arm. `isLive` exists
  // to reject a SYNTHETIC red — `withUnstartedWorkerAttention` paints a worker whose worktree is cut
  // but whose pane never mounted, an internal open/evict race. `unmerged` cannot be synthesized that
  // way: engine/unmergedAttention derives it from the workflow STAGE (git branch/PR evidence) and
  // explicitly escalates agents that are `stopped`, i.e. exactly the ones with no PTY reading. A
  // worker with an un-landed PR and no live pane is the MOST stranded thing on the fleet, not the
  // least trustworthy — gating it on liveness would have left the headline bug unfixed for it.
  it("names an unmerged worker with NO live status — the stranded case", () => {
    expect(attentionWorkersOf(PEEK, "p1", (id) => (id === "w1" ? "unmerged" : "stopped"), () => false).map(
      (a) => a.id,
    )).toEqual(["w1"]);
  });
});

// ── the `questions` band is an ASK too, and it arrived after this gate was written ─────────────
//
// `questions` is BLUE — an ask you can answer rather than an alarm — so it is neither the red band
// this peek was built around nor the gray `unmerged` that was patched in afterwards, and it fell
// through both. Under a collapsed head (the default) a questioning worker therefore had no row, no
// peek line, and a parent dot filed under a different chip: precisely the invisibility `unmerged`
// had, reopened for the newest band on the day it shipped. Enumerating askers by COLOUR is what
// keeps reopening it — the question is whether the fold HIDES something owed, not how loud it is.
describe("attentionWorkersOf — a questioning worker under a folded head", () => {
  it("names a worker in the questions band", () => {
    expect(peekIds({ w1: "questions" })).toEqual(["w1"]);
  });

  it("names it alongside a red sibling rather than instead of one", () => {
    expect(peekIds({ w1: "questions", w2: "blocked" }).sort()).toEqual(["w1", "w2"]);
  });

  // The liveness guard DOES apply here, unlike `unmerged`. A blue is a live screen reading like the
  // reds are — only `unmerged` comes from durable git evidence — so a never-live blue is the same
  // synthetic-signal risk the guard exists for.
  it("does not name a questioning worker with no live reading", () => {
    expect(
      attentionWorkersOf(PEEK, "p1", (id) => (id === "w1" ? "questions" : "stopped"), () => false),
    ).toEqual([]);
  });
});
