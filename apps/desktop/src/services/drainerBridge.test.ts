import { describe, it, expect, vi } from "vitest";
import {
  planDrainDispatch,
  runDrainerBridgePass,
  type DrainQueueEntry,
  type DrainerBridgeDeps,
  type DrainerSnapshot,
} from "./drainerBridge";
import { drainSlotAgentId } from "./drainSlotRunner";

const entry = (beadId: string, priority = "1"): DrainQueueEntry => ({
  beadId,
  title: `fix ${beadId}`,
  priority,
  task: `Fix agent-feedback bead ${beadId}`,
  goal: "landed",
});

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A deps double whose `dispatch`/`ack` are spies, so tests assert the SIDE EFFECT (the spawn calls)
 *  rather than a return value. `dispatch` reports the worker RAN by default. */
function makeDeps(
  over: Partial<DrainerBridgeDeps> & {
    snapshot?: Partial<DrainerSnapshot>;
    accounts?: number;
  } = {},
) {
  const claimed = over.claimed ?? new Set<string>();
  const snapshot: DrainerSnapshot = {
    enabled: true,
    maxWorkers: 5,
    maxConcurrency: 5,
    entries: [entry("sparkle-a"), entry("sparkle-b"), entry("sparkle-c")],
    ...over.snapshot,
  };
  const dispatch = vi.fn(async (_e: DrainQueueEntry, _slot: string) => true);
  const ack = vi.fn(async (_e: DrainQueueEntry) => {});
  const deps: DrainerBridgeDeps = {
    isEnabled: over.isEnabled ?? (() => true),
    readQueue: over.readQueue ?? (async () => snapshot),
    holdReason: over.holdReason ?? (() => null),
    busySlots: over.busySlots ?? (() => new Set<string>()),
    availableAccounts: over.availableAccounts ?? (async () => over.accounts ?? 5),
    claimed,
    dispatch: over.dispatch ?? dispatch,
    ack: over.ack ?? ack,
  };
  return { deps, dispatch, ack, claimed, snapshot };
}

describe("planDrainDispatch (the pure bounded-fleet decision)", () => {
  const base = {
    enabled: true,
    claimed: new Set<string>(),
    busySlots: new Set<string>(),
    maxWorkers: 5,
    maxConcurrency: 5,
    availableAccounts: 5,
  };

  it("fills N distinct beads onto N distinct slots, worst-first", () => {
    const plan = planDrainDispatch({
      ...base,
      entries: [entry("p0", "0"), entry("p1", "1"), entry("p2", "2")],
      maxConcurrency: 3,
    });
    expect(plan.map((a) => a.entry.beadId)).toEqual(["p0", "p1", "p2"]); // worst-first order
    // Distinct slots — a distinct slot means a distinct worktree AND a distinct rotated account.
    const slots = plan.map((a) => a.slot);
    expect(new Set(slots).size).toBe(3);
    expect(slots).toEqual([drainSlotAgentId(0), drainSlotAgentId(1), drainSlotAgentId(2)]);
  });

  it("holds the (N+1)th: with a fleet of 2, only 2 of 3 queued beads are planned", () => {
    const plan = planDrainDispatch({
      ...base,
      maxConcurrency: 2,
      entries: [entry("a"), entry("b"), entry("c")],
    });
    expect(plan).toHaveLength(2);
    expect(plan.map((a) => a.entry.beadId)).toEqual(["a", "b"]); // "c" is held
  });

  it("disabled (kill-switch) ⇒ nothing planned", () => {
    expect(planDrainDispatch({ ...base, enabled: false, entries: [entry("a")] })).toEqual([]);
  });

  it("empty queue ⇒ nothing planned", () => {
    expect(planDrainDispatch({ ...base, entries: [] })).toEqual([]);
  });

  it("is bounded by the STRICTEST of maxWorkers / maxConcurrency / availableAccounts", () => {
    const entries = [entry("a"), entry("b"), entry("c"), entry("d")];
    // maxWorkers binds
    expect(planDrainDispatch({ ...base, entries, maxWorkers: 1, maxConcurrency: 5, availableAccounts: 5 })).toHaveLength(1);
    // maxConcurrency binds
    expect(planDrainDispatch({ ...base, entries, maxWorkers: 5, maxConcurrency: 2, availableAccounts: 5 })).toHaveLength(2);
    // availableAccounts binds — never spawn more workers than accounts to rotate across
    expect(planDrainDispatch({ ...base, entries, maxWorkers: 5, maxConcurrency: 5, availableAccounts: 3 })).toHaveLength(3);
    // a zero bound ⇒ nothing
    expect(planDrainDispatch({ ...base, entries, availableAccounts: 0 })).toEqual([]);
  });

  it("does not re-dispatch a bead already claimed this session", () => {
    const plan = planDrainDispatch({
      ...base,
      claimed: new Set(["a"]),
      entries: [entry("a"), entry("b")],
      maxConcurrency: 5,
    });
    // "a" is skipped; "b" takes the FIRST free slot (slot 0), not slot 1.
    expect(plan.map((a) => a.entry.beadId)).toEqual(["b"]);
    expect(plan[0]?.slot).toBe(drainSlotAgentId(0));
  });

  it("free-slot bound: a busy slot reduces this pass's capacity", () => {
    // Fleet of 3, slot 0 already in flight ⇒ only slots 1 and 2 are free ⇒ 2 beads planned onto them.
    const plan = planDrainDispatch({
      ...base,
      maxConcurrency: 3,
      busySlots: new Set([drainSlotAgentId(0)]),
      entries: [entry("a"), entry("b"), entry("c")],
    });
    expect(plan).toHaveLength(2);
    expect(plan.map((a) => a.slot)).toEqual([drainSlotAgentId(1), drainSlotAgentId(2)]);
  });

  it("never plans two workers onto the same bead or the same slot", () => {
    const plan = planDrainDispatch({
      ...base,
      maxConcurrency: 4,
      // a duplicate bead in one snapshot must not be double-assigned
      entries: [entry("a"), entry("a"), entry("b")],
    });
    const beads = plan.map((a) => a.entry.beadId);
    const slots = plan.map((a) => a.slot);
    expect(new Set(beads).size).toBe(beads.length); // beads distinct
    expect(new Set(slots).size).toBe(slots.length); // slots distinct
    expect(beads).toEqual(["a", "b"]);
  });
});

describe("runDrainerBridgePass (asserts the parallel spawn SIDE EFFECT)", () => {
  it("enabled + N free slots + M>N beads ⇒ N workers spawned on DISTINCT beads AND slots, each acked", async () => {
    const { deps, dispatch, ack } = makeDeps({
      snapshot: { maxConcurrency: 3, maxWorkers: 5, entries: [entry("a"), entry("b"), entry("c"), entry("d")] },
      accounts: 5,
    });
    const out = await runDrainerBridgePass(deps);
    // THE core assertion: 3 spawns (fleet of 3), on distinct beads and distinct slots.
    expect(dispatch).toHaveBeenCalledTimes(3);
    const beads = dispatch.mock.calls.map((c) => c[0].beadId);
    const slots = dispatch.mock.calls.map((c) => c[1]);
    expect(beads).toEqual(["a", "b", "c"]); // worst-first; "d" held (fleet full)
    expect(new Set(slots).size).toBe(3); // distinct slots ⇒ distinct rotated accounts
    expect(out.dispatched).toEqual(["a", "b", "c"]);
    await flush();
    expect(ack).toHaveBeenCalledTimes(3); // each request removed so it isn't re-dispatched
  });

  it("disabled (frontend kill-switch) ⇒ ZERO spawns", async () => {
    const { deps, dispatch, ack } = makeDeps({ isEnabled: () => false });
    const out = await runDrainerBridgePass(deps);
    expect(dispatch).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(out.dispatched).toEqual([]);
  });

  it("Rust kill-switch (snapshot.enabled=false) ⇒ ZERO spawns even with beads queued", async () => {
    const { deps, dispatch } = makeDeps({ snapshot: { enabled: false, entries: [entry("a")] } });
    await runDrainerBridgePass(deps);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("a hold (consent-off / offline) ⇒ ZERO spawns", async () => {
    const { deps, dispatch } = makeDeps({ holdReason: () => "offline" });
    const out = await runDrainerBridgePass(deps);
    expect(dispatch).not.toHaveBeenCalled();
    expect(out.dispatched).toEqual([]);
  });

  it("empty queue (backlog at/below floor) ⇒ ZERO spawns", async () => {
    const { deps, dispatch } = makeDeps({ snapshot: { entries: [] } });
    await runDrainerBridgePass(deps);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("busy slots reduce the fleet: with 2 of 3 slots busy, only 1 worker is spawned", async () => {
    const { deps, dispatch } = makeDeps({
      snapshot: { maxConcurrency: 3, maxWorkers: 5, entries: [entry("a"), entry("b")] },
      busySlots: () => new Set([drainSlotAgentId(0), drainSlotAgentId(1)]),
    });
    await runDrainerBridgePass(deps);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[1]).toBe(drainSlotAgentId(2)); // the one free slot
  });

  it("no two workers claim the same bead across two passes", async () => {
    // One shared claimed set + one shared snapshot; the first pass claims its beads, so a second pass
    // (fleet still full, beads still claimed) dispatches nothing new.
    const claimed = new Set<string>();
    const snapshot: DrainerSnapshot = {
      enabled: true,
      maxWorkers: 5,
      maxConcurrency: 2,
      entries: [entry("a"), entry("b")],
    };
    const busy = new Set<string>();
    const dispatch = vi.fn(async (_e: DrainQueueEntry, slot: string) => {
      busy.add(slot); // the worker now occupies its slot
      return true;
    });
    const deps: DrainerBridgeDeps = {
      isEnabled: () => true,
      readQueue: async () => snapshot,
      holdReason: () => null,
      busySlots: () => busy,
      availableAccounts: async () => 5,
      claimed,
      dispatch,
      ack: async () => {},
    };
    await runDrainerBridgePass(deps);
    await flush();
    await runDrainerBridgePass(deps);
    await flush();
    // Only the two beads, once each — the second pass adds nothing (both claimed AND both slots busy).
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls.map((c) => c[0].beadId).sort()).toEqual(["a", "b"]);
  });

  it("a worker that does NOT run releases its claim and leaves the request unacked", async () => {
    const claimed = new Set<string>();
    const dispatch = vi.fn(async () => false); // bailed (consent/park/timeout)
    const ack = vi.fn(async () => {});
    const { deps } = makeDeps({ claimed, dispatch, ack, snapshot: { maxConcurrency: 1, entries: [entry("a")] } });
    await runDrainerBridgePass(deps);
    await flush();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(ack).not.toHaveBeenCalled(); // request left in place to retry
    expect(claimed.has("a")).toBe(false); // claim released for a later pass
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
