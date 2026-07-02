// @vitest-environment jsdom
// Pure picker + baseline-flag tests for the auto-decompose watcher (spec §7, plan Task 5).
// The pickers decide WHICH epics the watcher may touch; every safety exclusion (children,
// guard labels, closed status, non-epics) is pinned here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bucketBeads, type Bead, type Board } from "./beads";
import {
  DECOMPOSE_EXEMPT_LABEL,
  DECOMPOSE_FAILED_LABEL,
  DECOMPOSED_LABEL,
  DECOMPOSING_LABEL,
  hasDecomposeBaseline,
  markDecomposeBaseline,
  maybeRunDecomposeWatcher,
  pickBaselineExemptEpics,
  pickEpicsToDecompose,
  pickStuckDecomposing,
  runDecomposeSweep,
  __resetDecomposeWatcherStateForTests,
  type DecomposeSweepDeps,
} from "./epicDecompose";

function bead(partial: Partial<Bead> & { id: string }): Bead {
  return {
    title: partial.id,
    description: "",
    status: "open",
    labels: [],
    parent: null,
    ...partial,
  };
}

function boardOf(...beads: Bead[]): Board {
  return bucketBeads(beads);
}

describe("pickEpicsToDecompose", () => {
  it("includes a virgin childless open epic", () => {
    const epic = bead({ id: "e1", type: "epic" });
    expect(pickEpicsToDecompose(boardOf(epic)).map((b) => b.id)).toEqual(["e1"]);
  });

  it("includes a childless in_progress epic", () => {
    const epic = bead({ id: "e1", type: "epic", status: "in_progress" });
    expect(pickEpicsToDecompose(boardOf(epic)).map((b) => b.id)).toEqual(["e1"]);
  });

  it("excludes an epic with a parent-linked child", () => {
    const epic = bead({ id: "e1", type: "epic" });
    const child = bead({ id: "t1", type: "task", parent: "e1" });
    expect(pickEpicsToDecompose(boardOf(epic, child))).toEqual([]);
  });

  it("excludes an epic with an id-prefixed child (bd hierarchical ids)", () => {
    const epic = bead({ id: "", type: "epic" });
    const child = bead({ id: ".1", type: "task" });
    expect(pickEpicsToDecompose(boardOf(epic, child))).toEqual([]);
  });

  it("excludes an epic whose only children are closed", () => {
    // Children in ANY column still count as children — a fully-done epic must not re-decompose.
    const epic = bead({ id: "e1", type: "epic" });
    const child = bead({ id: "t1", type: "task", parent: "e1", status: "closed" });
    expect(pickEpicsToDecompose(boardOf(epic, child))).toEqual([]);
  });

  it.each([
    DECOMPOSING_LABEL,
    DECOMPOSED_LABEL,
    DECOMPOSE_FAILED_LABEL,
    DECOMPOSE_EXEMPT_LABEL,
  ])("excludes an epic labeled %s", (label) => {
    const epic = bead({ id: "e1", type: "epic", labels: [label] });
    expect(pickEpicsToDecompose(boardOf(epic))).toEqual([]);
  });

  it("excludes non-epics and untyped beads", () => {
    const task = bead({ id: "t1", type: "task" });
    const untyped = bead({ id: "u1" });
    expect(pickEpicsToDecompose(boardOf(task, untyped))).toEqual([]);
  });

  it("excludes closed epics (finished work never triggers AI calls)", () => {
    const done = bead({ id: "e1", type: "epic", status: "closed" });
    const delivered = bead({ id: "e2", type: "epic", status: "closed", labels: ["delivered"] });
    expect(pickEpicsToDecompose(boardOf(done, delivered))).toEqual([]);
  });

  it("picks only the qualifying epics from a mixed board", () => {
    const virgin = bead({ id: "e1", type: "epic" });
    const labeled = bead({ id: "e2", type: "epic", labels: [DECOMPOSED_LABEL] });
    const withChild = bead({ id: "e3", type: "epic" });
    const child = bead({ id: "t3", type: "task", parent: "e3" });
    const picked = pickEpicsToDecompose(boardOf(virgin, labeled, withChild, child));
    expect(picked.map((b) => b.id)).toEqual(["e1"]);
  });
});

describe("pickBaselineExemptEpics", () => {
  it("targets exactly the epics the sweep would otherwise decompose", () => {
    // The baseline exempts every epic that WOULD auto-decompose, so the two pickers must agree.
    const virgin = bead({ id: "e1", type: "epic" });
    const exempt = bead({ id: "e2", type: "epic", labels: [DECOMPOSE_EXEMPT_LABEL] });
    const withChild = bead({ id: "e3", type: "epic" });
    const child = bead({ id: "t3", type: "task", parent: "e3" });
    const board = boardOf(virgin, exempt, withChild, child);
    expect(pickBaselineExemptEpics(board).map((b) => b.id)).toEqual(["e1"]);
    expect(pickBaselineExemptEpics(board)).toEqual(pickEpicsToDecompose(board));
  });
});

describe("pickStuckDecomposing (boot reclaim)", () => {
  it("picks every epic still carrying the decomposing label, regardless of status or children", () => {
    const stuckOpen = bead({ id: "e1", type: "epic", labels: [DECOMPOSING_LABEL] });
    const stuckClosed = bead({ id: "e2", type: "epic", status: "closed", labels: [DECOMPOSING_LABEL] });
    const child = bead({ id: "t1", type: "task", parent: "e1" });
    const stuckWithChild = bead({ id: "e3", type: "epic", labels: [DECOMPOSING_LABEL] });
    const childOf3 = bead({ id: "e3.1", type: "task" });
    const clean = bead({ id: "e4", type: "epic" });
    const picked = pickStuckDecomposing(boardOf(stuckOpen, stuckClosed, child, stuckWithChild, childOf3, clean));
    expect(picked.map((b) => b.id).sort()).toEqual(["e1", "e2", "e3"]);
  });

  it("ignores non-epics even when labeled", () => {
    const task = bead({ id: "t1", type: "task", labels: [DECOMPOSING_LABEL] });
    expect(pickStuckDecomposing(boardOf(task))).toEqual([]);
  });
});

describe("decompose baseline flag", () => {
  beforeEach(() => localStorage.clear());

  it("is unset for a fresh project, set after marking, and scoped per project", () => {
    expect(hasDecomposeBaseline("p1")).toBe(false);
    markDecomposeBaseline("p1");
    expect(hasDecomposeBaseline("p1")).toBe(true);
    expect(hasDecomposeBaseline("p2")).toBe(false);
    expect(localStorage.getItem("sparkle-decompose-baseline-p1")).not.toBeNull();
  });
});

// ── sweep IO ───────────────────────────────────────────────────────────────────────────────────

/** Fake sweep deps recording every call into one ordered `calls` log, so tests can assert both
 *  what happened and the ORDER it happened in (guard label before AI, serial epics, …). */
function makeSweepDeps(over: Partial<DecomposeSweepDeps> = {}) {
  const calls: string[] = [];
  const labelBead = vi.fn(async (_p: string, action: "add" | "remove", id: string, label: string) => {
    calls.push(`label:${action}:${id}:${label}`);
  });
  const decomposeEpic = vi.fn(async ({ epic }: { projectPath: string; epic: Bead }) => {
    calls.push(`decompose:${epic.id}`);
    return { taskIds: [] };
  });
  const logError = vi.fn();
  const deps: DecomposeSweepDeps = { labelBead, decomposeEpic, logError, ...over };
  return { deps, calls, labelBead, decomposeEpic, logError };
}

describe("runDecomposeSweep", () => {
  it("guards each epic with `decomposing` BEFORE the AI call, then swaps to `decomposed`", async () => {
    const { deps, calls } = makeSweepDeps();
    const epic = bead({ id: "e1", type: "epic" });
    await runDecomposeSweep(deps, "/repo", boardOf(epic));
    expect(calls).toEqual([
      `label:add:e1:${DECOMPOSING_LABEL}`,
      "decompose:e1",
      `label:add:e1:${DECOMPOSED_LABEL}`,
      `label:remove:e1:${DECOMPOSING_LABEL}`,
    ]);
  });

  it("skips an epic (no AI call) when the guard-label write fails, and continues to the next", async () => {
    const { deps, decomposeEpic } = makeSweepDeps({
      labelBead: vi.fn(async (_p, action, id) => {
        if (action === "add" && id === "e1") throw new Error("bd down");
      }),
    });
    const e1 = bead({ id: "e1", type: "epic" });
    const e2 = bead({ id: "e2", type: "epic" });
    await runDecomposeSweep(deps, "/repo", boardOf(e1, e2));
    expect(decomposeEpic).toHaveBeenCalledTimes(1);
    expect(decomposeEpic.mock.calls[0]![0].epic.id).toBe("e2");
  });

  it("labels `decompose-failed` (and logs) when decomposition throws, then continues", async () => {
    const { deps, calls, logError } = makeSweepDeps({
      decomposeEpic: vi.fn(async ({ epic }: { projectPath: string; epic: Bead }) => {
        if (epic.id === "e1") throw new Error("AI unhappy");
        return { taskIds: [] };
      }),
    });
    const e1 = bead({ id: "e1", type: "epic" });
    const e2 = bead({ id: "e2", type: "epic" });
    await runDecomposeSweep(deps, "/repo", boardOf(e1, e2));
    expect(calls).toContain(`label:add:e1:${DECOMPOSE_FAILED_LABEL}`);
    expect(calls).toContain(`label:remove:e1:${DECOMPOSING_LABEL}`);
    expect(calls).toContain(`label:add:e2:${DECOMPOSED_LABEL}`);
    expect(logError).toHaveBeenCalled();
  });

  it("processes epics serially — the second AI call starts only after the first fully settles", async () => {
    const { deps, calls } = makeSweepDeps();
    const e1 = bead({ id: "e1", type: "epic" });
    const e2 = bead({ id: "e2", type: "epic" });
    await runDecomposeSweep(deps, "/repo", boardOf(e1, e2));
    // e1's full add→decompose→swap sequence completes before e2's guard is even written.
    expect(calls.indexOf(`label:add:e2:${DECOMPOSING_LABEL}`)).toBeGreaterThan(
      calls.indexOf(`label:remove:e1:${DECOMPOSING_LABEL}`),
    );
  });

  it("does NOT mark decompose-failed when a SUCCESSFUL decompose's `decomposed` label write fails", async () => {
    // roborev 25168/25169: a bookkeeping-label failure after the children were created must not
    // masquerade as a decompose failure (false red badge / a retry that duplicates children).
    const calls: string[] = [];
    const labelBead = vi.fn(async (_p: string, action: "add" | "remove", id: string, label: string) => {
      calls.push(`label:${action}:${id}:${label}`);
      if (action === "add" && label === DECOMPOSED_LABEL) throw new Error("bd hiccup");
    });
    const decomposeEpic = vi.fn(async () => ({ taskIds: [] }));
    const deps: DecomposeSweepDeps = { labelBead, decomposeEpic, logError: vi.fn() };
    await runDecomposeSweep(deps, "/repo", boardOf(bead({ id: "e1", type: "epic" })));
    expect(decomposeEpic).toHaveBeenCalledTimes(1);
    expect(calls).not.toContain(`label:add:e1:${DECOMPOSE_FAILED_LABEL}`);
    // The `decomposing` guard is deliberately left in place for boot reclaim / the next cycle.
    expect(calls).toContain(`label:add:e1:${DECOMPOSING_LABEL}`);
  });

  it("re-checks the AI gate before each epic — a mid-sweep toggle-off stops further AI calls", async () => {
    // roborev 25169: the sweep is serial with one AI call per epic and can run for minutes.
    const { deps, decomposeEpic } = makeSweepDeps();
    let enabled = true;
    vi.mocked(decomposeEpic).mockImplementation(async () => {
      enabled = false; // flip the master gate off the instant the first epic decomposes
      return { taskIds: [] };
    });
    const board = boardOf(bead({ id: "e1", type: "epic" }), bead({ id: "e2", type: "epic" }));
    await runDecomposeSweep(deps, "/repo", board, () => enabled);
    expect(decomposeEpic).toHaveBeenCalledTimes(1); // e2 skipped
  });
});

describe("maybeRunDecomposeWatcher", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetDecomposeWatcherStateForTests();
  });

  const opts = (board: Board, over: Partial<{ isMain: boolean; projectId: string }> = {}) => ({
    isMain: true,
    projectId: "p1",
    projectPath: "/repo",
    board,
    ...over,
  });

  it("does nothing in a non-main window", async () => {
    const { deps, labelBead, decomposeEpic } = makeSweepDeps();
    const board = boardOf(bead({ id: "e1", type: "epic" }));
    await maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => true }, opts(board, { isMain: false }));
    expect(labelBead).not.toHaveBeenCalled();
    expect(decomposeEpic).not.toHaveBeenCalled();
  });

  it("does nothing while AI features are off", async () => {
    const { deps, labelBead, decomposeEpic } = makeSweepDeps();
    const board = boardOf(bead({ id: "e1", type: "epic" }));
    await maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => false }, opts(board));
    expect(labelBead).not.toHaveBeenCalled();
    expect(decomposeEpic).not.toHaveBeenCalled();
  });

  it("clears surviving `decomposing` labels on its first run per project (boot reclaim)", async () => {
    markDecomposeBaseline("p1");
    const { deps, calls } = makeSweepDeps();
    const stuck = bead({ id: "e1", type: "epic", labels: [DECOMPOSING_LABEL] });
    await maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => true }, opts(boardOf(stuck)));
    expect(calls).toContain(`label:remove:e1:${DECOMPOSING_LABEL}`);
    // Reclaim is boot-time only: a second cycle does not re-clear.
    calls.length = 0;
    await maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => true }, opts(boardOf(stuck)));
    expect(calls).not.toContain(`label:remove:e1:${DECOMPOSING_LABEL}`);
  });

  it("runs the one-time baseline exempt sweep INSTEAD of decomposing on an un-baselined project", async () => {
    const { deps, calls, decomposeEpic } = makeSweepDeps();
    const preexisting = bead({ id: "e1", type: "epic" });
    await maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => true }, opts(boardOf(preexisting)));
    expect(calls).toContain(`label:add:e1:${DECOMPOSE_EXEMPT_LABEL}`);
    expect(decomposeEpic).not.toHaveBeenCalled();
    expect(hasDecomposeBaseline("p1")).toBe(true);
  });

  it("does not mark the baseline when an exempt-label write fails (so it retries next cycle)", async () => {
    const { deps } = makeSweepDeps({
      labelBead: vi.fn(async (_p, _a, id) => {
        if (id === "e1") throw new Error("bd down");
      }),
    });
    const e1 = bead({ id: "e1", type: "epic" });
    await maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => true }, opts(boardOf(e1)));
    expect(hasDecomposeBaseline("p1")).toBe(false);
  });

  it("decomposes on a baselined project", async () => {
    markDecomposeBaseline("p1");
    const { deps, decomposeEpic } = makeSweepDeps();
    const fresh = bead({ id: "e1", type: "epic" });
    await maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => true }, opts(boardOf(fresh)));
    expect(decomposeEpic).toHaveBeenCalledTimes(1);
  });

  it("exempts (never decomposes) a pre-existing stuck-`decomposing` epic when the baseline flag was lost", async () => {
    // roborev 25168/25169 + spec §7 rule 2: the localStorage baseline flag can be lost (reinstall,
    // profile clear, second machine) while bd labels persist in the repo. A pre-existing epic then
    // shows up un-baselined AND still carrying `decomposing`. It must be exempted, never
    // retroactively auto-decomposed.
    const { deps, decomposeEpic, calls } = makeSweepDeps();
    // Cycle 1: reclaim clears the stale label, but the watcher bails without marking the baseline.
    const stuck = bead({ id: "e1", type: "epic", labels: [DECOMPOSING_LABEL] });
    await maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => true }, opts(boardOf(stuck)));
    expect(calls).toContain(`label:remove:e1:${DECOMPOSING_LABEL}`);
    expect(decomposeEpic).not.toHaveBeenCalled();
    expect(hasDecomposeBaseline("p1")).toBe(false);

    // Cycle 2: the poll now shows e1 without the label → it gets EXEMPTED, not decomposed.
    calls.length = 0;
    await maybeRunDecomposeWatcher(
      { ...deps, aiEnabled: () => true },
      opts(boardOf(bead({ id: "e1", type: "epic" }))),
    );
    expect(calls).toContain(`label:add:e1:${DECOMPOSE_EXEMPT_LABEL}`);
    expect(decomposeEpic).not.toHaveBeenCalled();
    expect(hasDecomposeBaseline("p1")).toBe(true);
  });

  it("is re-entrancy-safe: a poll landing mid-sweep is a no-op for that project", async () => {
    markDecomposeBaseline("p1");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const decomposeEpic = vi.fn(async () => {
      await gate;
      return { taskIds: [] };
    });
    const { deps } = makeSweepDeps({ decomposeEpic });
    const board = boardOf(bead({ id: "e1", type: "epic" }));
    const first = maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => true }, opts(board));
    const second = maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => true }, opts(board));
    release();
    await Promise.all([first, second]);
    expect(decomposeEpic).toHaveBeenCalledTimes(1);
  });
});
