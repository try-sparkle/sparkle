import { describe, expect, it } from "vitest";
import { expandOnWorkerAttention, workerAttention } from "./workerExpansion";
import type { AgentKind, AgentTabStatus } from "../types";

interface Node {
  id: string;
  kind: AgentKind;
  parentId: string | null;
}

/** `workerAttention` driven by ONE status map, the way the sidebar drives it: an id PRESENT in the
 *  map has a live PTY status and carries it; an id ABSENT has no live status of its own and reads
 *  `stopped`, exactly as the sidebar's `effectiveStatus[id] ?? "stopped"` does. Cases about the
 *  synthetic strand red — red in `statusOf` but NOT live — call `workerAttention` directly. */
const attentionFrom = (agents: readonly Node[], map: Record<string, AgentTabStatus>) =>
  workerAttention(
    agents,
    (id) => map[id] ?? "stopped",
    (id) => map[id] !== undefined,
  );

describe("expandOnWorkerAttention — which orchestrators auto-expand", () => {
  it("expands a parent whose worker just went red", () => {
    expect(expandOnWorkerAttention({ p1: false }, { p1: true })).toEqual(["p1"]);
  });

  // TRANSITION, NOT STATE. A worker that merely REMAINS red must not re-expand: the effect runs on
  // every status/agents change, so re-asserting on a steady red would re-open a subtree the user had
  // just deliberately collapsed, on the very next render, and make the chevron feel broken.
  it("does NOT re-expand while a worker merely stays red", () => {
    expect(expandOnWorkerAttention({ p1: true }, { p1: true })).toEqual([]);
  });

  // The load-bearing case, inherited from the growth rule this replaced. On boot the previous
  // snapshot is empty, so EVERY parent would look like it just went red — silently expanding every
  // orchestrator with a red worker on every relaunch and making the persisted collapse choice
  // worthless. First sighting is a baseline, not a transition.
  it("does NOT expand on first observation, so a relaunch respects the persisted collapse", () => {
    expect(expandOnWorkerAttention({}, { p1: true, p2: true })).toEqual([]);
  });

  // Expansion is automatic; COLLAPSING stays the user's gesture — see the module header.
  it("does not collapse (reports nothing) when the red clears", () => {
    expect(expandOnWorkerAttention({ p1: true }, { p1: false })).toEqual([]);
  });

  it("does not expand while a parent stays quiet", () => {
    expect(expandOnWorkerAttention({ p1: false }, { p1: false })).toEqual([]);
  });

  it("expands only the parent that went red, leaving its siblings alone", () => {
    expect(
      expandOnWorkerAttention({ p1: false, p2: false, p3: true }, { p1: false, p2: true, p3: true }),
    ).toEqual(["p2"]);
  });

  it("expands several parents when several went red at once", () => {
    expect(
      expandOnWorkerAttention({ p1: false, p2: false }, { p1: true, p2: true }).sort(),
    ).toEqual(["p1", "p2"]);
  });

  // A parent that disappears (closed) must not throw or report anything.
  it("ignores a parent present only in the previous snapshot", () => {
    expect(expandOnWorkerAttention({ p1: true }, {})).toEqual([]);
  });
});

describe("workerAttention — the snapshot expandOnWorkerAttention compares", () => {
  const p1w1: readonly Node[] = [
    { id: "p1", kind: "build", parentId: null },
    { id: "w1", kind: "worker", parentId: "p1" },
  ];

  it("flags a parent with a red worker and records a calm orchestrator as false", () => {
    const agents: Node[] = [
      { id: "p1", kind: "build", parentId: null },
      { id: "w1", kind: "worker", parentId: "p1" },
      { id: "p2", kind: "build", parentId: null },
      { id: "w2", kind: "worker", parentId: "p2" },
    ];
    // p2's explicit `false` is what lets its worker's LATER red read as a transition. Omitting a
    // calm parent is the shape of roborev 53672-High: the signal's first appearance under a parent
    // would arrive against an absent baseline and be misclassified as a first sighting.
    expect(attentionFrom(agents, { w1: "errored", w2: "working" })).toEqual({ p1: true, p2: false });
  });

  // The regression above, stated end-to-end through both functions rather than as a shape.
  it("makes the FIRST red under a previously-calm parent read as a transition", () => {
    const before = attentionFrom(p1w1, { w1: "working" });
    const after = attentionFrom(p1w1, { w1: "waiting" });
    expect(expandOnWorkerAttention(before, after)).toEqual(["p1"]);
  });

  // A parent that has NEVER had a worker still gets an entry, so its first worker arriving ALREADY
  // red is a transition rather than a first sighting.
  it("gives a childless orchestrator an explicit false", () => {
    expect(attentionFrom([{ id: "p1", kind: "build", parentId: null }], {})).toEqual({ p1: false });
  });

  // A SPAWN is not an attention event. This is the whole point of the change: gaining a (calm)
  // worker leaves the parent exactly as the user left it.
  it("spawning a calm worker does not flag the parent", () => {
    const before = attentionFrom([{ id: "p1", kind: "build", parentId: null }], {});
    const after = attentionFrom(p1w1, { w1: "working" });
    expect(expandOnWorkerAttention(before, after)).toEqual([]);
  });

  // Every red-tier status counts, because the band — not a second hand-rolled "is it red" — is what
  // decides. `blocked` is the one that separates the tier from the narrower needs-you-now set, and
  // getting that wrong is a documented past bug (engine/workerAttention.ts).
  it.each<AgentTabStatus>(["waiting", "approval", "blocked", "errored"])(
    "treats a %s worker as attention",
    (st) => {
      expect(attentionFrom(p1w1, { w1: st })).toEqual({ p1: true });
    },
  );

  it.each<AgentTabStatus>(["working", "idle", "done", "stopped", "unmerged"])(
    "treats a %s worker as calm",
    (st) => {
      expect(attentionFrom(p1w1, { w1: st })).toEqual({ p1: false });
    },
  );

  it("flags a parent when ANY one of its workers is red", () => {
    const agents: Node[] = [
      { id: "p1", kind: "build", parentId: null },
      { id: "w1", kind: "worker", parentId: "p1" },
      { id: "w2", kind: "worker", parentId: "p1" },
    ];
    expect(attentionFrom(agents, { w1: "working", w2: "errored" })).toEqual({ p1: true });
  });

  // Order is not guaranteed — the disk reconcile can adopt a worker before its parent — so seeding
  // the `false`s must not clobber a flag already accumulated.
  it("survives a red worker appearing before its parent in the array", () => {
    const agents: Node[] = [
      { id: "w1", kind: "worker", parentId: "p1" },
      { id: "p1", kind: "build", parentId: null },
    ];
    expect(attentionFrom(agents, { w1: "errored" })).toEqual({ p1: true });
  });

  // A shell nested under a build is not a worker and must not flag its parent — otherwise the
  // subtree would pop open for a row it never renders as a worker row.
  it("does not count a non-worker child, however red", () => {
    const agents: Node[] = [
      { id: "p1", kind: "build", parentId: null },
      { id: "s1", kind: "shell", parentId: "p1" },
    ];
    expect(attentionFrom(agents, { s1: "errored" })).toEqual({ p1: false });
  });

  it("gives a parentless worker no entry rather than an 'undefined' bucket", () => {
    expect(attentionFrom([{ id: "w1", kind: "worker", parentId: null }], { w1: "errored" })).toEqual(
      {},
    );
  });

  it("is empty for no agents", () => {
    expect(attentionFrom([], {})).toEqual({});
  });

  // The SYNTHETIC strand red. withUnstartedWorkerAttention paints a never-mounted worker `approval`,
  // and the open/evict ping-pong that produces that state can toggle it many times a second — each
  // cycle a fresh rising edge that would re-open a subtree the user just collapsed. A worker with no
  // live PTY status of its own is therefore calm here, however red the overlaid map paints it.
  it("ignores a red status on a worker that was never live (the synthetic strand red)", () => {
    expect(
      workerAttention(
        p1w1,
        () => "approval",
        () => false,
      ),
    ).toEqual({ p1: false });
  });

  it("honors the SAME red once that worker comes live", () => {
    const stranded = workerAttention(
      p1w1,
      () => "approval",
      () => false,
    );
    const live = workerAttention(
      p1w1,
      () => "approval",
      () => true,
    );
    expect(expandOnWorkerAttention(stranded, live)).toEqual(["p1"]);
  });
});
