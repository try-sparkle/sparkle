import { describe, it, expect, vi } from "vitest";
import {
  selectDrainDispatch,
  runDrainerBridgePass,
  MAX_INFLIGHT_DRAIN_PASSES,
  type DrainQueueEntry,
  type DrainerBridgeDeps,
  type DrainerSnapshot,
} from "./drainerBridge";

const entry = (beadId: string, priority = "1"): DrainQueueEntry => ({
  beadId,
  title: `fix ${beadId}`,
  priority,
  task: `Fix agent-feedback bead ${beadId}`,
  goal: "landed",
});

/** A deps double whose `dispatch`/`ack` are spies, so tests assert the SIDE EFFECT (the spawn call)
 *  rather than a return value. `dispatch` reports the pass STARTED by default. */
function makeDeps(over: Partial<DrainerBridgeDeps> & { snapshot?: Partial<DrainerSnapshot> } = {}) {
  const claimed = over.claimed ?? new Set<string>();
  const snapshot: DrainerSnapshot = {
    enabled: true,
    maxWorkers: 3,
    entries: [entry("sparkle-a")],
    ...over.snapshot,
  };
  const dispatch = vi.fn(async (_e: DrainQueueEntry) => true);
  const ack = vi.fn(async (_e: DrainQueueEntry) => {});
  const deps: DrainerBridgeDeps = {
    isEnabled: over.isEnabled ?? (() => true),
    readQueue: over.readQueue ?? (async () => snapshot),
    holdReason: over.holdReason ?? (() => null),
    running: over.running ?? (() => 0),
    claimed,
    dispatch: over.dispatch ?? dispatch,
    ack: over.ack ?? ack,
  };
  return { deps, dispatch, ack, claimed, snapshot };
}

describe("selectDrainDispatch (the pure decision)", () => {
  it("picks the worst-first eligible bead when enabled with a free slot and a queue", () => {
    // entries arrive worst-first from Rust; the first eligible one is chosen.
    const pick = selectDrainDispatch({
      enabled: true,
      entries: [entry("sparkle-p0", "0"), entry("sparkle-p2", "2")],
      running: 0,
      claimed: new Set(),
      maxWorkers: 3,
    });
    expect(pick?.beadId).toBe("sparkle-p0");
  });

  it("returns null when disabled (the kill-switch)", () => {
    expect(
      selectDrainDispatch({
        enabled: false,
        entries: [entry("sparkle-a")],
        running: 0,
        claimed: new Set(),
        maxWorkers: 3,
      }),
    ).toBeNull();
  });

  it("returns null when the queue is empty (backlog at/below floor ⇒ nothing spooled)", () => {
    expect(
      selectDrainDispatch({
        enabled: true,
        entries: [],
        running: 0,
        claimed: new Set(),
        maxWorkers: 3,
      }),
    ).toBeNull();
  });

  it("respects the cap: at the effective ceiling it dispatches nothing (Nth+1 refused)", () => {
    // The effective cap is min(maxWorkers, the singleton). With one already running, the ceiling is
    // reached and a second bead is NOT selected — even though maxWorkers=3 and beads are queued.
    expect(MAX_INFLIGHT_DRAIN_PASSES).toBe(1);
    expect(
      selectDrainDispatch({
        enabled: true,
        entries: [entry("sparkle-a"), entry("sparkle-b")],
        running: 1,
        claimed: new Set(),
        maxWorkers: 3,
      }),
    ).toBeNull();
  });

  it("does not double-dispatch a bead already claimed this session", () => {
    // sparkle-a is already claimed; the next eligible bead (sparkle-b) is chosen instead.
    const pick = selectDrainDispatch({
      enabled: true,
      entries: [entry("sparkle-a"), entry("sparkle-b")],
      running: 0,
      claimed: new Set(["sparkle-a"]),
      maxWorkers: 3,
    });
    expect(pick?.beadId).toBe("sparkle-b");
  });

  it("a zero cap (maxWorkers 0) dispatches nothing", () => {
    expect(
      selectDrainDispatch({
        enabled: true,
        entries: [entry("sparkle-a")],
        running: 0,
        claimed: new Set(),
        maxWorkers: 0,
      }),
    ).toBeNull();
  });
});

describe("runDrainerBridgePass (asserts the spawn SIDE EFFECT)", () => {
  it("enabled + a queued bead ⇒ a worker IS spawned for that bead, and the request is acked", async () => {
    const { deps, dispatch, ack } = makeDeps();
    const out = await runDrainerBridgePass(deps);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]?.beadId).toBe("sparkle-a");
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack.mock.calls[0]?.[0]?.beadId).toBe("sparkle-a"); // request removed so it isn't re-dispatched
    expect(out.dispatched).toBe("sparkle-a");
  });

  it("disabled (frontend kill-switch) ⇒ NO spawn (paired with the enabled case)", async () => {
    const { deps, dispatch, ack } = makeDeps({ isEnabled: () => false });
    const out = await runDrainerBridgePass(deps);
    expect(dispatch).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(out.dispatched).toBeNull();
  });

  it("Rust kill-switch (snapshot.enabled=false) ⇒ NO spawn even with a bead queued", async () => {
    // A non-empty queue on purpose: this proves the snap.enabled guard is load-bearing, not merely
    // shadowed by the empty-queue path. A disabled snapshot must refuse a queued bead.
    const { deps, dispatch, ack } = makeDeps({
      snapshot: { enabled: false, entries: [entry("sparkle-a")] },
    });
    await runDrainerBridgePass(deps);
    expect(dispatch).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  it("empty queue (backlog at/below floor) ⇒ NO spawn", async () => {
    const { deps, dispatch } = makeDeps({ snapshot: { entries: [] } });
    await runDrainerBridgePass(deps);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("cap already full (running at the ceiling) ⇒ NO spawn", async () => {
    const { deps, dispatch } = makeDeps({ running: () => 1 });
    await runDrainerBridgePass(deps);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("a shared hold (e.g. pane-busy / offline) ⇒ NO spawn even with a bead queued", async () => {
    // The interactive Improve-Sparkle pane and the drain pass share one worktree; a non-null
    // holdReason (pane-busy, offline, consent-off, ...) must stop the dispatch outright.
    const { deps, dispatch, ack } = makeDeps({ holdReason: () => "pane-busy" });
    const out = await runDrainerBridgePass(deps);
    expect(dispatch).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(out.dispatched).toBeNull();
  });

  it("does not double-spawn the same bead across two passes", async () => {
    // One shared claimed set + one shared snapshot; the started pass keeps the bead claimed, so a
    // second pass (with the singleton still busy AND the bead claimed) does not dispatch it again.
    const claimed = new Set<string>();
    const snapshot: DrainerSnapshot = { enabled: true, maxWorkers: 3, entries: [entry("sparkle-a")] };
    let running = 0;
    const dispatch = vi.fn(async () => {
      running = 1; // the started worker now occupies the singleton
      return true;
    });
    const deps: DrainerBridgeDeps = {
      isEnabled: () => true,
      readQueue: async () => snapshot,
      holdReason: () => null,
      running: () => running,
      claimed,
      dispatch,
      ack: async () => {},
    };
    await runDrainerBridgePass(deps);
    await runDrainerBridgePass(deps);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("when the dispatch does NOT start (singleton busy/refused), the claim is released and the file is left", async () => {
    const claimed = new Set<string>();
    const dispatch = vi.fn(async () => false); // refused
    const ack = vi.fn(async () => {});
    const { deps } = makeDeps({ claimed, dispatch, ack });
    const out = await runDrainerBridgePass(deps);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(ack).not.toHaveBeenCalled(); // request left in place to retry
    expect(claimed.has("sparkle-a")).toBe(false); // claim released for a later pass
    expect(out.dispatched).toBeNull();
  });

  it("a failing readQueue is fail-closed: no spawn", async () => {
    const { deps, dispatch } = makeDeps({
      readQueue: async () => {
        throw new Error("store queued");
      },
    });
    await runDrainerBridgePass(deps);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
