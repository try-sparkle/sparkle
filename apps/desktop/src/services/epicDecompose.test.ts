// @vitest-environment jsdom
// Pure picker + sweep tests for the auto-decompose watcher (spec §7, plan Task 5).
// The pickers decide WHICH epics the watcher may touch; every safety exclusion (children,
// pipeline labels, closed status, non-epics) is pinned here — and, above all, the money/safety
// invariant (bead sparkle-ynn8): the watcher spends ONLY on an epic that carries the EXPLICIT
// `decompose:requested` opt-in. An epic with NO decompose label is a strict no-op (no paid call).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bucketBeads, type Bead, type Board } from "./beads";
import {
  DECOMPOSE_FAILED_LABEL,
  DECOMPOSE_REQUESTED_LABEL,
  DECOMPOSED_LABEL,
  DECOMPOSING_LABEL,
  maybeRunDecomposeWatcher,
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

/** A childless open epic that has explicitly opted in — the ONLY shape the watcher spends on. */
function requestedEpic(id: string, over: Partial<Bead> = {}): Bead {
  return bead({ id, type: "epic", labels: [DECOMPOSE_REQUESTED_LABEL], ...over });
}

function boardOf(...beads: Bead[]): Board {
  return bucketBeads(beads);
}

describe("pickEpicsToDecompose", () => {
  it("includes a childless open epic that carries the explicit opt-in", () => {
    expect(pickEpicsToDecompose(boardOf(requestedEpic("e1"))).map((b) => b.id)).toEqual(["e1"]);
  });

  it("includes a requested childless in_progress epic", () => {
    expect(
      pickEpicsToDecompose(boardOf(requestedEpic("e1", { status: "in_progress" }))).map((b) => b.id),
    ).toEqual(["e1"]);
  });

  it("EXCLUDES a childless epic with NO decompose label (absent opt-in ⇒ no paid call)", () => {
    // The money/safety invariant (bead sparkle-ynn8): a label-less childless epic must never be
    // picked — removing a stale label or reopening a childless epic must not trigger AI spend.
    const virgin = bead({ id: "e1", type: "epic" });
    expect(pickEpicsToDecompose(boardOf(virgin))).toEqual([]);
  });

  it("excludes a requested epic with a parent-linked child", () => {
    const epic = requestedEpic("e1");
    const child = bead({ id: "t1", type: "task", parent: "e1" });
    expect(pickEpicsToDecompose(boardOf(epic, child))).toEqual([]);
  });

  it("excludes a requested epic with an id-prefixed child (bd hierarchical ids)", () => {
    const epic = requestedEpic("");
    const child = bead({ id: ".1", type: "task" });
    expect(pickEpicsToDecompose(boardOf(epic, child))).toEqual([]);
  });

  it("excludes a requested epic whose only children are closed", () => {
    // Children in ANY column still count as children — a fully-done epic must not re-decompose.
    const epic = requestedEpic("e1");
    const child = bead({ id: "t1", type: "task", parent: "e1", status: "closed" });
    expect(pickEpicsToDecompose(boardOf(epic, child))).toEqual([]);
  });

  it.each([DECOMPOSING_LABEL, DECOMPOSED_LABEL, DECOMPOSE_FAILED_LABEL])(
    "excludes a requested epic already in the pipeline (labeled %s)",
    (label) => {
      const epic = requestedEpic("e1", { labels: [DECOMPOSE_REQUESTED_LABEL, label] });
      expect(pickEpicsToDecompose(boardOf(epic))).toEqual([]);
    },
  );

  it("excludes non-epics and untyped beads even when they carry the opt-in", () => {
    const task = bead({ id: "t1", type: "task", labels: [DECOMPOSE_REQUESTED_LABEL] });
    const untyped = bead({ id: "u1", labels: [DECOMPOSE_REQUESTED_LABEL] });
    expect(pickEpicsToDecompose(boardOf(task, untyped))).toEqual([]);
  });

  it("excludes closed epics even when requested (finished work never triggers AI calls)", () => {
    const done = requestedEpic("e1", { status: "closed" });
    const delivered = requestedEpic("e2", {
      status: "closed",
      labels: [DECOMPOSE_REQUESTED_LABEL, "delivered"],
    });
    expect(pickEpicsToDecompose(boardOf(done, delivered))).toEqual([]);
  });

  it("picks only the qualifying (opted-in) epics from a mixed board", () => {
    const requested = requestedEpic("e1");
    const notRequested = bead({ id: "e2", type: "epic" }); // no opt-in → skipped
    const alreadyDone = requestedEpic("e3", { labels: [DECOMPOSE_REQUESTED_LABEL, DECOMPOSED_LABEL] });
    const withChild = requestedEpic("e4");
    const child = bead({ id: "t4", type: "task", parent: "e4" });
    const picked = pickEpicsToDecompose(
      boardOf(requested, notRequested, alreadyDone, withChild, child),
    );
    expect(picked.map((b) => b.id)).toEqual(["e1"]);
  });
});

describe("pickStuckDecomposing (crash recovery)", () => {
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
  it("guards each epic with `decomposing` BEFORE the AI call, then swaps to `decomposed` and consumes the opt-in", async () => {
    const { deps, calls } = makeSweepDeps();
    await runDecomposeSweep(deps, "/repo", boardOf(requestedEpic("e1")));
    expect(calls).toEqual([
      `label:add:e1:${DECOMPOSING_LABEL}`,
      "decompose:e1",
      `label:add:e1:${DECOMPOSED_LABEL}`,
      `label:remove:e1:${DECOMPOSING_LABEL}`,
      `label:remove:e1:${DECOMPOSE_REQUESTED_LABEL}`,
    ]);
  });

  it("does not touch a childless epic that never opted in (no guard label, no AI call)", async () => {
    const { deps, labelBead, decomposeEpic } = makeSweepDeps();
    await runDecomposeSweep(deps, "/repo", boardOf(bead({ id: "e1", type: "epic" })));
    expect(labelBead).not.toHaveBeenCalled();
    expect(decomposeEpic).not.toHaveBeenCalled();
  });

  it("skips an epic (no AI call) when the guard-label write fails, and continues to the next", async () => {
    const { deps, decomposeEpic } = makeSweepDeps({
      labelBead: vi.fn(async (_p, action, id) => {
        if (action === "add" && id === "e1") throw new Error("bd down");
      }),
    });
    await runDecomposeSweep(deps, "/repo", boardOf(requestedEpic("e1"), requestedEpic("e2")));
    expect(decomposeEpic).toHaveBeenCalledTimes(1);
    expect(decomposeEpic.mock.calls[0]![0].epic.id).toBe("e2");
  });

  it("labels `decompose-failed` (and logs), KEEPS the opt-in for retry, then continues", async () => {
    const { deps, calls, logError } = makeSweepDeps({
      decomposeEpic: vi.fn(async ({ epic }: { projectPath: string; epic: Bead }) => {
        if (epic.id === "e1") throw new Error("AI unhappy");
        return { taskIds: [] };
      }),
    });
    await runDecomposeSweep(deps, "/repo", boardOf(requestedEpic("e1"), requestedEpic("e2")));
    expect(calls).toContain(`label:add:e1:${DECOMPOSE_FAILED_LABEL}`);
    expect(calls).toContain(`label:remove:e1:${DECOMPOSING_LABEL}`);
    // The opt-in is deliberately kept on failure so clearing the failed badge re-picks the epic.
    expect(calls).not.toContain(`label:remove:e1:${DECOMPOSE_REQUESTED_LABEL}`);
    expect(calls).toContain(`label:add:e2:${DECOMPOSED_LABEL}`);
    expect(logError).toHaveBeenCalled();
  });

  it("processes epics serially — the second AI call starts only after the first fully settles", async () => {
    const { deps, calls } = makeSweepDeps();
    await runDecomposeSweep(deps, "/repo", boardOf(requestedEpic("e1"), requestedEpic("e2")));
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
    await runDecomposeSweep(deps, "/repo", boardOf(requestedEpic("e1")));
    expect(decomposeEpic).toHaveBeenCalledTimes(1);
    expect(calls).not.toContain(`label:add:e1:${DECOMPOSE_FAILED_LABEL}`);
    // The `decomposing` guard is deliberately left in place for crash recovery / the next cycle.
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
    const board = boardOf(requestedEpic("e1"), requestedEpic("e2"));
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
    const board = boardOf(requestedEpic("e1"));
    await maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => true }, opts(board, { isMain: false }));
    expect(labelBead).not.toHaveBeenCalled();
    expect(decomposeEpic).not.toHaveBeenCalled();
  });

  it("decomposes a requested epic on a main window", async () => {
    const { deps, decomposeEpic } = makeSweepDeps();
    await maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => true }, opts(boardOf(requestedEpic("e1"))));
    expect(decomposeEpic).toHaveBeenCalledTimes(1);
  });

  it("does NOT decompose a childless epic that never opted in (no paid call)", async () => {
    const { deps, decomposeEpic, labelBead } = makeSweepDeps();
    const virgin = bead({ id: "e1", type: "epic" });
    await maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => true }, opts(boardOf(virgin)));
    expect(decomposeEpic).not.toHaveBeenCalled();
    expect(labelBead).not.toHaveBeenCalled();
  });

  it("fires no AI call while AI features are off (even for a requested epic)", async () => {
    const { deps, decomposeEpic } = makeSweepDeps();
    const board = boardOf(requestedEpic("e1"));
    await maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => false }, opts(board));
    expect(decomposeEpic).not.toHaveBeenCalled();
  });

  it("crash-recovers a stale `decomposing` label EVEN while AI features are off (a free bd write)", async () => {
    // bead sparkle-ynn8: clearing a stranded label spends nothing, so it must not be gated behind
    // the master AI switch — the old order (AI gate first) left crashed labels stuck when AI was off.
    const { deps, calls, decomposeEpic } = makeSweepDeps();
    const stuck = bead({ id: "e1", type: "epic", labels: [DECOMPOSING_LABEL] });
    await maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => false }, opts(boardOf(stuck)));
    expect(calls).toContain(`label:remove:e1:${DECOMPOSING_LABEL}`);
    expect(decomposeEpic).not.toHaveBeenCalled();
  });

  it("clears surviving `decomposing` labels on its first run per project, not on the second", async () => {
    const { deps, calls } = makeSweepDeps();
    const stuck = bead({ id: "e1", type: "epic", labels: [DECOMPOSING_LABEL] });
    await maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => true }, opts(boardOf(stuck)));
    expect(calls).toContain(`label:remove:e1:${DECOMPOSING_LABEL}`);
    // Reclaim is boot-time only: a second cycle does not re-clear.
    calls.length = 0;
    await maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => true }, opts(boardOf(stuck)));
    expect(calls).not.toContain(`label:remove:e1:${DECOMPOSING_LABEL}`);
  });

  it("does not mark the project reclaimed when a stale-label removal fails (so it retries next cycle)", async () => {
    // The failing labelBead throws AND records, so we can see the retry attempt on cycle 2.
    const labelBead = vi.fn(async (_p: string, action: "add" | "remove", id: string, label: string) => {
      if (id === "e1") throw new Error("bd down");
      return `label:${action}:${id}:${label}` as unknown as void;
    });
    const { deps } = makeSweepDeps({ labelBead });
    const stuck = bead({ id: "e1", type: "epic", labels: [DECOMPOSING_LABEL] });
    await maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => false }, opts(boardOf(stuck)));
    expect(labelBead).toHaveBeenCalledWith("/repo", "remove", "e1", DECOMPOSING_LABEL);
    // Second cycle still attempts the removal (reclaim was not marked done).
    labelBead.mockClear();
    await maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => false }, opts(boardOf(stuck)));
    expect(labelBead).toHaveBeenCalledWith("/repo", "remove", "e1", DECOMPOSING_LABEL);
  });

  it("is re-entrancy-safe: a poll landing mid-sweep is a no-op for that project", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const decomposeEpic = vi.fn(async () => {
      await gate;
      return { taskIds: [] };
    });
    const { deps } = makeSweepDeps({ decomposeEpic });
    const board = boardOf(requestedEpic("e1"));
    const first = maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => true }, opts(board));
    const second = maybeRunDecomposeWatcher({ ...deps, aiEnabled: () => true }, opts(board));
    release();
    await Promise.all([first, second]);
    expect(decomposeEpic).toHaveBeenCalledTimes(1);
  });
});
