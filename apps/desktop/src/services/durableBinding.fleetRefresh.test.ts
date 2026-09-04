// @vitest-environment jsdom
//
// THE ACCEPTANCE ITEM, END TO END (bead `sparkle-n2feho.9`; the goal `sparkle-n2feho.1` states
// verbatim as "the epic-orchestrator binding SURVIVES A FLEET REFRESH").
//
// ══ WHY THIS IS NOT A HAND-BUILT FIXTURE ══════════════════════════════════════════════════════
// A test that constructs a `BeadComment[]` by hand and parses it proves the parser, and proves
// NOTHING about the acceptance — it never touches the writer, never touches the binding, and never
// destroys anything. Three real units run here, wired to each other and not to mocks:
//
//   • `sendToBuild` in `mode: "task"` — the REAL handoff, which both stamps `AgentTab.epicId` (the
//     binding) and writes the durable record. The record this test recovers is the one production
//     wrote, captured off the `commentBead` boundary.
//   • `stores/projectStore.removeAgent` — the REAL row-destruction path, not a hand-edited array.
//     It destroys the row AND tombstones the id in `removedIds`, which is what makes the loss
//     irreversible and so what makes "survives a refresh" a real question.
//   • `planView.orchestratorForEpic` + `durableBinding.resolveOrchestratorBinding` +
//     `conciergeTools/plans.getPlan` — the reader and the surface a person actually reads.
//
// Only the `bd` transport, the runtime store and the UI store are mocked; every seam this bead is
// about is live, so the test fails if EITHER half regresses.
import { describe, it, expect, beforeEach, vi } from "vitest";

// STRICT-ISH FACTORY, spreading the original: `isEpic`, `childrenOf`, `columnFor` and
// `HANDED_TO_BUILD_LABEL` must stay REAL — they are the membership resolver and the label constant
// that the production gates read, and faking either would let this test pass over a broken one.
// Only the four functions that shell out to `bd` are replaced.
const labelBeadMock = vi.fn(async () => {});
const commentBeadMock = vi.fn(async () => {});
const listBeadsMock = vi.fn(async () => beadSnapshot);
const beadShowMock = vi.fn(async (_p: string, id: string) => beadSnapshot.find((b) => b.id === id) ?? null);
const blockedBeadIdsMock = vi.fn(async () => new Set<string>());
vi.mock("./beads", async (orig) => ({
  ...(await orig<typeof import("./beads")>()),
  labelBead: (...a: unknown[]) => labelBeadMock(...(a as [])),
  commentBead: (...a: unknown[]) => commentBeadMock(...(a as [])),
  listBeads: (...a: unknown[]) => listBeadsMock(...(a as [])),
  beadShow: (...a: unknown[]) => (beadShowMock as never as (...x: unknown[]) => unknown)(...a),
  blockedBeadIds: (...a: unknown[]) => blockedBeadIdsMock(...(a as [])),
}));
vi.mock("../stores/runtimeStore", () => ({
  useRuntimeStore: { getState: () => ({ open: vi.fn(), status: {}, openAgentIds: [] }) },
}));
vi.mock("../stores/uiStore", () => ({
  useUiStore: {
    getState: () => ({
      setActiveSpecial: vi.fn(),
      requestRevealAgent: vi.fn(),
      requestComposeFocus: vi.fn(),
      setWorkMode: vi.fn(),
      pairAssignment: {},
    }),
  },
}));

import { sendToBuild } from "./sendToBuild";
import { useProjectStore } from "../stores/projectStore";
import { orchestratorForEpic } from "./planView";
import { resolveOrchestratorBinding, type DurableBindingDeps } from "./durableBinding";
import {
  getPlan,
  DURABLE_BINDING_READ_CAP,
  DURABLE_BINDING_BUDGET_MS,
  DURABLE_BINDING_READ_WIDTH,
} from "./conciergeTools/plans";
import { HANDED_TO_BUILD_LABEL, type Bead } from "./beads";
import type { BeadComment } from "./beadsCommands";
import type { Project } from "../types";

const bead = (over: Partial<Bead> & { id: string }): Bead => ({
  title: over.id,
  description: "",
  status: "open",
  labels: [],
  parent: null,
  commentCount: 0,
  ...over,
});

/** The board snapshot. A MUTABLE module-level array so each test can VARY the labels — the
 *  `handed-to-build` bit is the field under test on the cheap-gate side, and a fixture that pinned
 *  it could not express the paired negative. */
let beadSnapshot: Bead[] = [];

function mkProject(over: Partial<Project> & { id: string }): Project {
  return {
    name: "P",
    rootPath: "/repo",
    defaultBranch: null,
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    freshBuildAgentId: null,
    agents: [],
    ...over,
  };
}

const store = () => useProjectStore.getState();
const agentsOf = () => store().projects.find((p) => p.id === "p1")?.agents ?? [];

/** The comment thread as `beads_detail` would return it — built from the text PRODUCTION WROTE,
 *  captured off the `commentBead` boundary, never authored by this test. */
function threadFromWriter(): BeadComment[] {
  return commentBeadMock.mock.calls.map((call, i) => ({
    id: `c${i}`,
    author: null,
    text: (call as unknown as [string, string, string])[2],
    createdAt: null,
  }));
}

function depsFor(thread: BeadComment[]): DurableBindingDeps & { readComments: ReturnType<typeof vi.fn> } {
  const readComments = vi.fn(async () => thread);
  return { readComments } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState({ projects: [mkProject({ id: "p1" })], removedIds: {} } as never);
  beadSnapshot = [
    bead({ id: "e1", title: "The epic", type: "epic" }),
    bead({ id: "e1.t1", title: "The task", parent: "e1" }),
    bead({ id: "e1.t2", title: "An untouched task", parent: "e1" }),
  ];
});

describe("the binding survives a fleet refresh (bead sparkle-n2feho.9)", () => {
  it("recovers WHICH orchestrator in WHICH project after removeAgent destroys the row", async () => {
    // 1 ── THE REAL HANDOFF. `mode: "task"` binds a task-level orchestrator and writes the record.
    const agentId = sendToBuild({
      projectId: "p1",
      epicId: "e1.t1",
      prdPath: null,
      mode: "task",
    });
    // The binding, as the real store now holds it.
    expect(agentsOf().find((a) => a.id === agentId)?.epicId).toBe("e1.t1");
    // ...and the durable record production wrote, on the bead it was handed.
    expect(commentBeadMock).toHaveBeenCalledTimes(1);
    expect(commentBeadMock.mock.calls[0]).toEqual(["/repo", "e1.t1", expect.any(String)]);
    const thread = threadFromWriter();

    // 2 ── WHILE THE ROW IS ALIVE, the live tier answers and NOTHING is read.
    const aliveDeps = depsFor(thread);
    const live = orchestratorForEpic(beadSnapshot, agentsOf(), "e1.t1");
    expect(live?.id).toBe(agentId);
    await expect(
      resolveOrchestratorBinding(
        {
          projectPath: "/repo",
          beadId: "e1.t1",
          live: live ? { id: live.id, name: live.name } : null,
          handedToBuild: true,
        },
        aliveDeps,
      ),
    ).resolves.toMatchObject({ source: "live", agentId });
    expect(aliveDeps.readComments).not.toHaveBeenCalled();

    // 3 ── THE FLEET REFRESH: the REAL row-destruction path.
    store().removeAgent("p1", agentId);
    expect(agentsOf().find((a) => a.id === agentId)).toBeUndefined();
    // TOMBSTONED, which is what makes the loss irreversible — no rehydrate can bring the row (and
    // so the binding) back. Asserted so this test cannot silently degrade into "we spliced an
    // array": if `removeAgent` ever stopped tombstoning, the premise of this whole file would be
    // false and the recovery below would be proving something easier than it claims.
    expect(store().removedIds?.[agentId]).toBeGreaterThan(0);
    expect(orchestratorForEpic(beadSnapshot, agentsOf(), "e1.t1")).toBeNull();

    // 4 ── AND THE BINDING IS STILL THERE — reported as RECOVERED, not as a running agent.
    const deps = depsFor(thread);
    const recovered = await resolveOrchestratorBinding(
      { projectPath: "/repo", beadId: "e1.t1", live: null, handedToBuild: true },
      deps,
    );
    expect(recovered).toMatchObject({
      source: "durable",
      agentId,
      projectId: "p1",
    });
    // Stated on its own: a caller must not be able to read this as "somebody is on it now".
    expect(recovered?.source).not.toBe("live");
  });

  // THE PAIRED NEGATIVE, which is not optional. One test proving recovery is ambiguous on its own —
  // absence passes for a fixed AND an unfixed reader — so the two live in one file and are read
  // together.
  it("an agent that never carried a binding acquires no false one, and an unhanded bead is null", async () => {
    // A build agent exists in the project and was NEVER handed anything.
    const stray = store().addAgent("p1", { kind: "build" })!;
    expect(agentsOf().find((a) => a.id === stray)?.epicId).toBeUndefined();
    expect(orchestratorForEpic(beadSnapshot, agentsOf(), "e1.t1")).toBeNull();

    // Destroying it changes nothing, because there was nothing to survive.
    store().removeAgent("p1", stray);

    // A bead with no handoff record: the cheap gate answers first and no read is even attempted.
    const unhanded = depsFor([]);
    expect(
      await resolveOrchestratorBinding(
        { projectPath: "/repo", beadId: "e1.t2", live: null, handedToBuild: false },
        unhanded,
      ),
    ).toBeNull();
    expect(unhanded.readComments).not.toHaveBeenCalled();

    // ...and even if the label were somehow present, an empty thread still resolves to null rather
    // than to the nearest record on some other bead.
    const empty = depsFor([]);
    expect(
      await resolveOrchestratorBinding(
        { projectPath: "/repo", beadId: "e1.t2", live: null, handedToBuild: true },
        empty,
      ),
    ).toBeNull();
    expect(empty.readComments).toHaveBeenCalledTimes(1);
  });
});

describe("get_plan is the surface that reports it (bead sparkle-n2feho.9, part C)", () => {
  it("reports the destroyed orchestrator as source:'durable' on the child it was handed", async () => {
    const agentId = sendToBuild({ projectId: "p1", epicId: "e1.t1", prdPath: null, mode: "task" });
    const thread = threadFromWriter();
    // The label the handoff stamps rides on the polled snapshot; this is the cheap gate `getPlan`
    // reads before it will spend a detail call. Written here rather than asserted off `labelBead`
    // because the snapshot is what the BOARD would hold a tick later.
    expect(labelBeadMock).toHaveBeenCalledWith("/repo", "add", "e1.t1", HANDED_TO_BUILD_LABEL);
    beadSnapshot = beadSnapshot.map((b) =>
      b.id === "e1.t1" ? { ...b, labels: [HANDED_TO_BUILD_LABEL] } : b,
    );

    // ── BEFORE the refresh: live, and the epic knows it (part D — the ladder arm).
    const beforeDeps = depsFor(thread);
    const before = await getPlan("/repo", "p1", "e1", beforeDeps);
    expect(before.ok).toBe(true);
    if (!before.ok || !before.data) throw new Error("expected a plan");
    expect(before.data.children.find((c) => c.id === "e1.t1")?.binding).toMatchObject({
      source: "live",
      agentId,
    });
    // PART D, IN THE SAME BREATH: a task-level orchestrator that has spawned NO worker used to make
    // the epic read `orchestrator: None`, because the raw predicate compares `epicId` against the
    // EPIC and this agent carries the TASK. The ladder arm resolves it up one rung.
    expect(before.data.plan.orchestrator).not.toBeNull();
    // The live tier spends no detail read at all.
    expect(beforeDeps.readComments).not.toHaveBeenCalled();

    // ── THE REFRESH.
    store().removeAgent("p1", agentId);

    const afterDeps = depsFor(thread);
    const after = await getPlan("/repo", "p1", "e1", afterDeps);
    if (!after.ok || !after.data) throw new Error("expected a plan");
    const child = after.data.children.find((c) => c.id === "e1.t1");
    expect(child?.binding).toMatchObject({ source: "durable", agentId, projectId: "p1" });
    // The LIVE-only field goes back to null, and that is correct — nobody is on it. The recovery is
    // reported ALONGSIDE it, in a shape that says so, rather than by resurrecting a name into a
    // field that means "somebody is building this".
    expect(after.data.plan.orchestrator).toBeNull();
    // Exactly ONE detail read: the labelled, unbound child. Not the epic, not the sibling.
    expect(afterDeps.readComments).toHaveBeenCalledTimes(1);
    expect(afterDeps.readComments).toHaveBeenCalledWith("/repo", "e1.t1");
    // And the untouched sibling acquires nothing.
    expect(after.data.children.find((c) => c.id === "e1.t2")?.binding).toBeNull();
  });

  // THE COST CONTRACT, asserted rather than argued. `beads_detail` pulls a whole comment thread
  // from the contended single-writer store, and three call sites refuse to put it on a poll; the
  // ceiling is what makes `get_plan`'s bound provable for a pathological plan rather than merely
  // likely. Without a test the branch is dormant code that nobody would notice going wrong.
  it("clips the durable lookups at DURABLE_BINDING_READ_CAP on a pathologically large plan", async () => {
    const many = Array.from({ length: DURABLE_BINDING_READ_CAP + 4 }, (_, i) =>
      bead({
        id: `e1.k${i}`,
        parent: "e1",
        labels: [HANDED_TO_BUILD_LABEL],
      }),
    );
    beadSnapshot = [bead({ id: "e1", type: "epic" }), ...many];
    const deps = depsFor([]);
    const got = await getPlan("/repo", "p1", "e1", deps);
    if (!got.ok || !got.data) throw new Error("expected a plan");
    expect(got.data.children).toHaveLength(DURABLE_BINDING_READ_CAP + 4);
    expect(deps.readComments).toHaveBeenCalledTimes(DURABLE_BINDING_READ_CAP);
  });

  // THE OTHER HALF OF THE COST CONTRACT. `get_plan` already spends three `bd` invocations and the
  // concierge bridge kills the whole tool call at 50s, so an unbounded recovery pass against a
  // contended store could turn a working plan read into an opaque transport error — for the sake of
  // a HINT. The budget makes that impossible, and the LIVE tier must survive it: a live binding
  // costs nothing to compute, so losing one to a wall-clock expiry would be pure damage.
  it("abandons the recovery pass on its budget WITHOUT losing the free live tier", async () => {
    const agentId = sendToBuild({ projectId: "p1", epicId: "e1.t1", prdPath: null, mode: "task" });
    // t1 keeps its LIVE orchestrator; t2 is handed-to-build with nobody on it, so only t2 reads.
    beadSnapshot = beadSnapshot.map((b) =>
      b.id === "e1.t2" ? { ...b, labels: [HANDED_TO_BUILD_LABEL] } : b,
    );
    const hang = { readComments: vi.fn(() => new Promise<BeadComment[]>(() => {})) };

    vi.useFakeTimers();
    try {
      const pending = getPlan("/repo", "p1", "e1", hang as never);
      await vi.advanceTimersByTimeAsync(DURABLE_BINDING_BUDGET_MS + 10);
      const got = await pending;
      if (!got.ok || !got.data) throw new Error("expected a plan");
      // The plan still came back — the whole point of bounding it.
      expect(got.data.children).toHaveLength(2);
      // The live tier is intact, even though the bounded pass never finished.
      expect(got.data.children.find((c) => c.id === "e1.t1")?.binding).toMatchObject({
        source: "live",
        agentId,
      });
      // ...and the abandoned one reads "we did not find out", not a fabricated answer.
      expect(got.data.children.find((c) => c.id === "e1.t2")?.binding).toBeNull();
      expect(hang.readComments).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── THE CONVOY (roborev 80885, HIGH) ─────────────────────────────────────────────────────────
  // A COUNT ceiling and a DEADLINE together still allow all of them to be STARTED at once, and
  // starting 12 does not run 12: every `beads_detail` is a `bd` child through a process-wide
  // 2-permit limiter whose 30s deadline covers QUEUE time. Ten of them would sit in a queue the
  // board's own 5s poll then lines up behind. This asserts the PEAK, which is the only number that
  // says anything about that queue — a total count cannot distinguish 12-at-once from 2-at-a-time.
  it("never has more than DURABLE_BINDING_READ_WIDTH detail reads in flight at once", async () => {
    const many = Array.from({ length: DURABLE_BINDING_READ_CAP }, (_, i) =>
      bead({ id: `e1.k${i}`, parent: "e1", labels: [HANDED_TO_BUILD_LABEL] }),
    );
    beadSnapshot = [bead({ id: "e1", type: "epic" }), ...many];

    let inFlight = 0;
    let peak = 0;
    const readComments = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Two turns of the microtask queue, so a `Promise.all` fan-out would genuinely overlap here
      // and be caught. Without a real suspension every read would resolve before the next begins
      // and the peak would read 1 whatever the code does — the vacuous version of this test.
      await Promise.resolve();
      await Promise.resolve();
      inFlight--;
      return [];
    });

    const got = await getPlan("/repo", "p1", "e1", { readComments } as never);
    if (!got.ok || !got.data) throw new Error("expected a plan");
    // Every one of them was still READ — the width bounds the rate, not the work.
    expect(readComments).toHaveBeenCalledTimes(DURABLE_BINDING_READ_CAP);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(DURABLE_BINDING_READ_WIDTH);
  });

  it("spends NO detail read on a plan whose tasks were never handed to Build", async () => {
    const deps = depsFor([]);
    const got = await getPlan("/repo", "p1", "e1", deps);
    if (!got.ok || !got.data) throw new Error("expected a plan");
    expect(got.data.binding).toBeNull();
    expect(got.data.children.every((c) => c.binding === null)).toBe(true);
    expect(deps.readComments).not.toHaveBeenCalled();
  });
});
