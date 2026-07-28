import { describe, expect, it } from "vitest";
import {
  autoCollapseTargets,
  expandOnWorkerAttention,
  workerAttention,
  type WorkerAttention,
} from "./workerExpansion";
import type { AgentKind, AgentTabStatus } from "../types";

interface Node {
  id: string;
  kind: AgentKind;
  parentId: string | null;
}

/** `workerAttention` driven by ONE status map, the way the sidebar drives it: an id PRESENT in the
 *  map has a live PTY status and carries it; an id ABSENT has no live status of its own and reads
 *  `stopped`, exactly as the sidebar's `effectiveStatus[id] ?? "stopped"` does. Cases about the
 *  synthetic strand red — red in `statusOf` but NOT live — call `workerAttention` directly.
 *
 *  `expectsLiveStatus` defaults to TRUE here: a statusless worker is one whose reading is still
 *  coming (a mounted pane, or a strand), which is the interesting case for these rules. Pass `false`
 *  for the other one — a CLOSED pane, which expects nothing and must not hold its head open. */
const attentionFrom = (
  agents: readonly Node[],
  map: Record<string, AgentTabStatus>,
  expectsLiveStatus: (w: Node) => boolean = () => true,
) =>
  workerAttention(
    agents,
    (id) => map[id] ?? "stopped",
    (id) => map[id] !== undefined,
    expectsLiveStatus,
  );

describe("expandOnWorkerAttention — which orchestrators auto-expand", () => {
  it("expands a parent whose worker just went red", () => {
    expect(expandOnWorkerAttention({ p1: "calm" }, { p1: "needs_you" })).toEqual(["p1"]);
  });

  // TRANSITION, NOT STATE. A worker that merely REMAINS red must not re-expand: the effect runs on
  // every status/agents change, so re-asserting on a steady red would re-open a subtree the user had
  // just deliberately collapsed, on the very next render, and make the chevron feel broken.
  it("does NOT re-expand while a worker merely stays red", () => {
    expect(expandOnWorkerAttention({ p1: "needs_you" }, { p1: "needs_you" })).toEqual([]);
  });

  // The load-bearing case, inherited from the growth rule this replaced. On boot the previous
  // snapshot is empty, so EVERY parent would look like it just went red — silently expanding every
  // orchestrator with a red worker on every relaunch and making the persisted collapse choice
  // worthless. First sighting is a baseline, not a transition.
  it("does NOT expand on first observation, so a relaunch respects the persisted collapse", () => {
    expect(expandOnWorkerAttention({}, { p1: "needs_you", p2: "needs_you" })).toEqual([]);
  });

  // Expansion is automatic; COLLAPSING stays the user's gesture — see the module header.
  it("does not collapse (reports nothing) when the red clears", () => {
    expect(expandOnWorkerAttention({ p1: "needs_you" }, { p1: "calm" })).toEqual([]);
  });

  it("does not expand while a parent stays quiet", () => {
    expect(expandOnWorkerAttention({ p1: "calm" }, { p1: "calm" })).toEqual([]);
  });

  it("expands only the parent that went red, leaving its siblings alone", () => {
    expect(
      expandOnWorkerAttention({ p1: "calm", p2: "calm", p3: "needs_you" }, { p1: "calm", p2: "needs_you", p3: "needs_you" }),
    ).toEqual(["p2"]);
  });

  it("expands several parents when several went red at once", () => {
    expect(
      expandOnWorkerAttention({ p1: "calm", p2: "calm" }, { p1: "needs_you", p2: "needs_you" }).sort(),
    ).toEqual(["p1", "p2"]);
  });

  // A parent that disappears (closed) must not throw or report anything.
  it("ignores a parent present only in the previous snapshot", () => {
    expect(expandOnWorkerAttention({ p1: "needs_you" }, {})).toEqual([]);
  });
});

describe("workerAttention — the snapshot expandOnWorkerAttention compares", () => {
  const p1w1: readonly Node[] = [
    { id: "p1", kind: "build", parentId: null },
    { id: "w1", kind: "worker", parentId: "p1" },
  ];

  it("flags a parent with a red worker and records a quiet orchestrator as calm", () => {
    const agents: Node[] = [
      { id: "p1", kind: "build", parentId: null },
      { id: "w1", kind: "worker", parentId: "p1" },
      { id: "p2", kind: "build", parentId: null },
      { id: "w2", kind: "worker", parentId: "p2" },
    ];
    // p2's explicit `calm` is what lets its worker's LATER red read as a transition. Omitting a
    // calm parent is the shape of roborev 53672-High: the signal's first appearance under a parent
    // would arrive against an absent baseline and be misclassified as a first sighting.
    expect(attentionFrom(agents, { w1: "errored", w2: "working" })).toEqual({ p1: "needs_you", p2: "calm" });
  });

  // The regression above, stated end-to-end through both functions rather than as a shape.
  it("makes the FIRST red under a previously-calm parent read as a transition", () => {
    const before = attentionFrom(p1w1, { w1: "working" });
    const after = attentionFrom(p1w1, { w1: "waiting" });
    expect(expandOnWorkerAttention(before, after)).toEqual(["p1"]);
  });

  // A parent that has NEVER had a worker still gets an entry, so its first worker arriving ALREADY
  // red is a transition rather than a first sighting.
  it("gives a childless orchestrator an explicit calm", () => {
    expect(attentionFrom([{ id: "p1", kind: "build", parentId: null }], {})).toEqual({ p1: "calm" });
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
      expect(attentionFrom(p1w1, { w1: st })).toEqual({ p1: "needs_you" });
    },
  );

  it.each<AgentTabStatus>(["working", "idle", "done", "stopped", "unmerged"])(
    "treats a %s worker as calm",
    (st) => {
      expect(attentionFrom(p1w1, { w1: st })).toEqual({ p1: "calm" });
    },
  );

  it("flags a parent when ANY one of its workers is red", () => {
    const agents: Node[] = [
      { id: "p1", kind: "build", parentId: null },
      { id: "w1", kind: "worker", parentId: "p1" },
      { id: "w2", kind: "worker", parentId: "p1" },
    ];
    expect(attentionFrom(agents, { w1: "working", w2: "errored" })).toEqual({ p1: "needs_you" });
  });

  // Order is not guaranteed — the disk reconcile can adopt a worker before its parent — so seeding
  // the `calm`s must not clobber a state already accumulated.
  it("survives a red worker appearing before its parent in the array", () => {
    const agents: Node[] = [
      { id: "w1", kind: "worker", parentId: "p1" },
      { id: "p1", kind: "build", parentId: null },
    ];
    expect(attentionFrom(agents, { w1: "errored" })).toEqual({ p1: "needs_you" });
  });

  // A shell nested under a build is not a worker and must not flag its parent — otherwise the
  // subtree would pop open for a row it never renders as a worker row.
  it("does not count a non-worker child, however red", () => {
    const agents: Node[] = [
      { id: "p1", kind: "build", parentId: null },
      { id: "s1", kind: "shell", parentId: "p1" },
    ];
    expect(attentionFrom(agents, { s1: "errored" })).toEqual({ p1: "calm" });
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
  // live PTY status of its own therefore never reads `needs_you`, however red the overlaid map
  // paints it.
  //
  // UNKNOWN, not calm. Folding it into calm was right for the expand rule (which only acts on
  // `needs_you`) and wrong the moment auto-collapse started acting on `calm` — it turned "no PTY
  // reading" into "nothing needs you" and closed the subtree on it (roborev 53994).
  it("reads a red status on a never-live worker as unknown, not calm", () => {
    expect(
      workerAttention(
        p1w1,
        () => "approval",
        () => false,
        () => true,
      ),
    ).toEqual({ p1: "unknown" });
  });

  // Same for a worker the map paints GREEN but has no PTY reading for: at launch every worker looks
  // like this, and calling that calm is what let the first commit after launch shut every subtree
  // carrying a persisted auto mark.
  it("reads a worker with no live status as unknown even when it looks calm", () => {
    expect(attentionFrom(p1w1, {})).toEqual({ p1: "unknown" });
  });

  // A CLOSED pane expects no reading, so it says nothing and its head stays collapsible. Folding it
  // into `unknown` — as the first cut of the 53994 fix did — pinned that head open for the entire
  // session, because `runtimeStore` never persists `status` (roborev 54018).
  it("reads a worker whose pane is closed as calm, not unknown", () => {
    expect(attentionFrom(p1w1, {}, () => false)).toEqual({ p1: "calm" });
  });

  // Mixed subtree: one closed pane, one live and quiet. Nothing is pending, so the head is calm and
  // auto-collapse may act on it.
  it("stays calm when a statusless worker's sibling is live and quiet", () => {
    const agents: Node[] = [
      { id: "p1", kind: "build", parentId: null },
      { id: "w1", kind: "worker", parentId: "p1" }, // closed pane, no reading expected
      { id: "w2", kind: "worker", parentId: "p1" },
    ];
    const attention = attentionFrom(agents, { w2: "working" }, (w) => w.id !== "w1");
    expect(attention).toEqual({ p1: "calm" });
    expect(autoCollapseTargets(agents, attention, () => true, null)).toEqual(["p1"]);
  });

  // A live worker asking for you is a FACT; one unreadable sibling must not demote it to "no
  // information" and swallow the expand.
  it("lets a live red worker outrank an unreadable sibling", () => {
    const agents: Node[] = [
      { id: "p1", kind: "build", parentId: null },
      { id: "w1", kind: "worker", parentId: "p1" },
      { id: "w2", kind: "worker", parentId: "p1" },
    ];
    expect(attentionFrom(agents, { w1: "waiting" })).toEqual({ p1: "needs_you" });
    // ...in either array order, since the states are accumulated in one pass.
    expect(attentionFrom([...agents].reverse(), { w1: "waiting" })).toEqual({ p1: "needs_you" });
  });

  // The open/evict race, end to end: a live worker's status entry vanishes and returns. Neither
  // edge may move the subtree — the disappearance is not a reason to close, and the return is not
  // new information.
  it("does not report a transition when a status entry vanishes and returns", () => {
    const live = attentionFrom(p1w1, { w1: "waiting" });
    const evicted = attentionFrom(p1w1, {});
    expect(evicted).toEqual({ p1: "unknown" });
    expect(expandOnWorkerAttention(live, evicted)).toEqual([]);
    expect(autoCollapseTargets(p1w1, evicted, () => true, null)).toEqual([]);
  });

  it("honors the SAME red once that worker comes live", () => {
    const stranded = workerAttention(
      p1w1,
      () => "approval",
      () => false,
      () => true,
    );
    const live = workerAttention(
      p1w1,
      () => "approval",
      () => true,
      () => true,
    );
    expect(expandOnWorkerAttention(stranded, live)).toEqual(["p1"]);
  });
});

// THE OTHER HALF: putting a subtree the app opened away again. Fixture: two orchestrators, two
// workers each. `attention` is the same snapshot the expansion rule compares, so these cases are
// stated in terms of it rather than re-deriving red from statuses.
const FLEET: Node[] = [
  { id: "p1", kind: "build", parentId: null },
  { id: "w1a", kind: "worker", parentId: "p1" },
  { id: "w1b", kind: "worker", parentId: "p1" },
  { id: "p2", kind: "build", parentId: null },
  { id: "w2a", kind: "worker", parentId: "p2" },
];
const CALM: Record<string, WorkerAttention> = { p1: "calm", p2: "calm" };
const auto =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id);
const never = () => false;
const always = () => true;

describe("autoCollapseTargets — putting an auto-expanded subtree away again", () => {
  it("closes an auto-expanded head once nothing under it needs you", () => {
    expect(autoCollapseTargets(FLEET, CALM, auto("p1"), null)).toEqual(["p1"]);
  });

  it("leaves it open while a worker still needs you", () => {
    expect(autoCollapseTargets(FLEET, { p1: "needs_you", p2: "calm" }, auto("p1"), null)).toEqual([]);
  });

  // The user's own chevron is theirs to undo — nothing marks p1 here.
  it("never closes a subtree the user expanded by hand", () => {
    expect(autoCollapseTargets(FLEET, CALM, never, null)).toEqual([]);
  });

  it("leaves the head you are reading open", () => {
    expect(autoCollapseTargets(FLEET, CALM, auto("p1"), "p1")).toEqual([]);
  });

  // Collapsing here would hide the row for the agent the terminal pane is showing — the original
  // reason workers have rows at all.
  it("leaves open the head of the WORKER you are reading", () => {
    expect(autoCollapseTargets(FLEET, CALM, auto("p1"), "w1b")).toEqual([]);
  });

  it("closes the other auto-expanded heads while you read one of them", () => {
    expect(autoCollapseTargets(FLEET, CALM, auto("p1", "p2"), "w1a")).toEqual(["p2"]);
  });

  // "Never observed this pass" is not "calm": a head missing from the snapshot belongs to some other
  // project, or arrived mid-reconcile, and closing it would act on a fact this pass does not have.
  it("leaves a head absent from the attention snapshot alone", () => {
    expect(autoCollapseTargets(FLEET, { p2: "calm" }, always, null)).toEqual(["p2"]);
  });

  // The same distinction one step in: the head IS in the snapshot, but a worker under it has no PTY
  // reading. Closing on that is roborev 53994 — at launch the status map is empty, so every head
  // reads this way and every persisted auto mark would slam shut before the first status arrived.
  it("leaves an UNKNOWN head open — no reading is not a quiet reading", () => {
    expect(autoCollapseTargets(FLEET, { p1: "unknown", p2: "calm" }, always, null)).toEqual(["p2"]);
  });

  it("closes an auto-expanded head with no workers left, clearing the stale mark", () => {
    const solo: Node[] = [{ id: "p1", kind: "build", parentId: null }];
    expect(autoCollapseTargets(solo, { p1: "calm" }, auto("p1"), null)).toEqual(["p1"]);
  });

  it("never returns a worker or a non-build row", () => {
    const agents: Node[] = [
      { id: "s1", kind: "shell", parentId: null },
      { id: "w1a", kind: "worker", parentId: "p1" },
    ];
    expect(autoCollapseTargets(agents, { s1: "calm", w1a: "calm" }, always, null)).toEqual([]);
  });

  // Both halves run against the same snapshot in the same tick, so an id must never be in both.
  it("is disjoint from expandOnWorkerAttention on the same snapshot", () => {
    const prev: Record<string, WorkerAttention> = { p1: "needs_you", p2: "calm" };
    const next: Record<string, WorkerAttention> = { p1: "calm", p2: "needs_you" };
    const opening = expandOnWorkerAttention(prev, next);
    const closing = autoCollapseTargets(FLEET, next, always, null);
    expect(opening).toEqual(["p2"]);
    expect(closing).toEqual(["p1"]);
    expect(opening.filter((id) => closing.includes(id))).toEqual([]);
  });
});
