// The durable dead-session store: the wholesale-replace mirror of the Rust `revival_due` list, and
// its no-op guard. Both are the parts that, wrong, either churn the sidebar every 15s (a guard that
// never fires) or leave a working agent painted amber (an accumulate that never drops a respawned
// id). Pure data tests — no React, no Tauri.
import { afterEach, describe, expect, it } from "vitest";
import {
  sameCauses,
  useResurrectableDeadStore,
  durableDeadCauseForAgent,
  _resetResurrectableDeadStoreForTests,
} from "./resurrectableDeadStore";

afterEach(() => _resetResurrectableDeadStoreForTests());

describe("sameCauses — the no-op guard", () => {
  it("is true for a list identical to what is stored (ids AND causes), so a steady sweep is silent", () => {
    const prev = { a: "transport-transient", b: "process-gone" } as const;
    expect(
      sameCauses(prev, [
        { agentId: "a", cause: "transport-transient" },
        { agentId: "b", cause: "process-gone" },
      ]),
    ).toBe(true);
    // Order does not matter — it keys on the id, not position.
    expect(
      sameCauses(prev, [
        { agentId: "b", cause: "process-gone" },
        { agentId: "a", cause: "transport-transient" },
      ]),
    ).toBe(true);
  });

  it("is false when a cause CHANGED for the same agent — a real update must not be swallowed", () => {
    expect(
      sameCauses({ a: "transport-transient" }, [{ agentId: "a", cause: "unknown" }]),
    ).toBe(false);
  });

  it("is false when an agent was ADDED or REMOVED — a new death, or a respawn, must land", () => {
    expect(
      sameCauses({ a: "transport-transient" }, [
        { agentId: "a", cause: "transport-transient" },
        { agentId: "b", cause: "process-gone" },
      ]),
      "an added agent must not read as unchanged",
    ).toBe(false);
    expect(sameCauses({ a: "transport-transient" }, []), "a drop must not read as unchanged").toBe(
      false,
    );
    expect(sameCauses({}, []), "empty against empty is genuinely unchanged").toBe(true);
  });
});

describe("syncDurable — wholesale replace", () => {
  it("REPLACES the list, dropping an agent no longer due (a respawn leaving the ledger)", () => {
    const { syncDurable } = useResurrectableDeadStore.getState();
    syncDurable([
      { agentId: "a", cause: "transport-transient" },
      { agentId: "b", cause: "process-gone" },
    ]);
    expect(useResurrectableDeadStore.getState().causes).toEqual({
      a: "transport-transient",
      b: "process-gone",
    });

    // `b` came back; the next sweep's list no longer names it, so it must vanish — accumulating it
    // would keep a working agent painted amber, the one direction this signal must never fail in.
    syncDurable([{ agentId: "a", cause: "transport-transient" }]);
    expect(useResurrectableDeadStore.getState().causes).toEqual({ a: "transport-transient" });
    expect(durableDeadCauseForAgent("b")).toBeUndefined();
  });

  it("does not write a NEW object when the list is unchanged, so subscribers do not re-render", () => {
    const { syncDurable } = useResurrectableDeadStore.getState();
    syncDurable([{ agentId: "a", cause: "transport-transient" }]);
    const first = useResurrectableDeadStore.getState().causes;
    // Same list again — the no-op guard must keep the SAME reference (zustand notifies on identity).
    syncDurable([{ agentId: "a", cause: "transport-transient" }]);
    expect(useResurrectableDeadStore.getState().causes).toBe(first);
  });
});

describe("forget — the respawn clear", () => {
  it("drops one agent and leaves the rest, so a respawn stops rendering amber immediately", () => {
    const { syncDurable, forget } = useResurrectableDeadStore.getState();
    syncDurable([
      { agentId: "a", cause: "transport-transient" },
      { agentId: "b", cause: "process-gone" },
    ]);
    forget("a");
    expect(durableDeadCauseForAgent("a")).toBeUndefined();
    expect(durableDeadCauseForAgent("b")).toBe("process-gone");
  });

  it("no-ops on a miss — the ordinary first spawn has nothing to forget and must not churn state", () => {
    const before = useResurrectableDeadStore.getState().causes;
    useResurrectableDeadStore.getState().forget("never-seen");
    expect(useResurrectableDeadStore.getState().causes).toBe(before);
  });
});
