// portBroker service — the payload contract with `port_broker.rs`, and the two behaviours that are
// this module's own rather than the Rust core's: a refusal is an ANSWER (not a thrown error), and a
// gate lock is given back on the throw path.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  SPARKLE_DEV_GATE,
  acquireGateLock,
  acquirePort,
  brokerStatus,
  gateLockStatus,
  leakedLeases,
  pinnedGateName,
  releaseGateLock,
  releasePort,
  renewPort,
  withGateLock,
  type BrokerStatus,
  type GateLockOutcome,
  type LeaseView,
} from "./portBroker";

const HOLDER: GateLockOutcome["lock"] = {
  name: SPARKLE_DEV_GATE,
  agentId: "agent-1",
  pid: 4242,
  acquiredAtMs: 1_800_000_000_000,
  ttlSecs: 1800,
};

const REFUSED: GateLockOutcome = {
  acquired: false,
  state: "refused",
  lock: HOLDER,
  reclaimedFrom: null,
  message: "`-1420` is held by agent agent-1 (pid 4242), taken 12s ago with a 1800s TTL.",
};

const TAKEN: GateLockOutcome = {
  acquired: true,
  state: "acquired",
  lock: { ...HOLDER, agentId: "agent-2" },
  reclaimedFrom: null,
  message: "",
};

function lease(over: Partial<LeaseView>): LeaseView {
  return {
    port: 45000,
    agentId: "a",
    kind: "preview",
    pid: 1,
    acquiredAtMs: 0,
    heartbeatAtMs: 0,
    expired: false,
    bound: false,
    ...over,
  };
}

beforeEach(() => {
  invoke.mockReset();
});

describe("the command payloads are the frozen contract with port_broker.rs", () => {
  it("names every field the Rust side reads, in the camelCase Tauri converts", async () => {
    invoke.mockResolvedValue({});
    await acquirePort("/repo", "agent-1");
    expect(invoke).toHaveBeenCalledWith("port_broker_acquire", {
      projectRoot: "/repo",
      agentId: "agent-1",
      // Defaulted HERE rather than left undefined: a `kind` is half a lease's identity, so an
      // omitted one would make a preview's re-ask look like a different resource and hand out a
      // second port.
      kind: "preview",
    });

    await renewPort("/repo", 45000, "agent-1");
    expect(invoke).toHaveBeenCalledWith("port_broker_renew", {
      projectRoot: "/repo",
      port: 45000,
      agentId: "agent-1",
    });

    await releasePort("/repo", 45000, "agent-1");
    expect(invoke).toHaveBeenCalledWith("port_broker_release", {
      projectRoot: "/repo",
      port: 45000,
      agentId: "agent-1",
    });

    await brokerStatus("/repo");
    expect(invoke).toHaveBeenCalledWith("port_broker_status", { projectRoot: "/repo" });

    await releaseGateLock("/repo", "browser", "agent-1");
    expect(invoke).toHaveBeenCalledWith("gate_lock_release", {
      projectRoot: "/repo",
      name: "browser",
      agentId: "agent-1",
    });
  });

  // AN OMITTED OPTIONAL CROSSES AS AN EXPLICIT `null`, never as an absent key. A Rust `Option`
  // deserializes from `null` and from a missing field alike, but the app's own IPC tracing and its
  // payload assertions read the object, and an absent key there is indistinguishable from a caller
  // that forgot the argument.
  it("sends an explicit null for an omitted ttl and an omitted name", async () => {
    invoke.mockResolvedValue({});
    await acquireGateLock("/repo", "browser", "agent-1");
    expect(invoke).toHaveBeenCalledWith("gate_lock_acquire", {
      projectRoot: "/repo",
      name: "browser",
      agentId: "agent-1",
      ttlSecs: null,
    });

    await gateLockStatus("/repo");
    expect(invoke).toHaveBeenCalledWith("gate_lock_status", { projectRoot: "/repo", name: null });

    await gateLockStatus("/repo", "browser");
    expect(invoke).toHaveBeenCalledWith("gate_lock_status", {
      projectRoot: "/repo",
      name: "browser",
    });
  });
});

describe("a refusal is an answer, not an error", () => {
  it("resolves with the holder rather than throwing, so a caller can say WHO has it", async () => {
    invoke.mockResolvedValue(REFUSED);
    const outcome = await acquireGateLock("/repo", SPARKLE_DEV_GATE, "agent-2");
    expect(outcome.acquired).toBe(false);
    expect(outcome.lock.agentId).toBe("agent-1");
    expect(outcome.message).toContain("agent-1");
  });
});

describe("withGateLock", () => {
  it("runs the body while holding the lock and gives it back", async () => {
    const calls: string[] = [];
    invoke.mockImplementation((cmd: string) => {
      calls.push(cmd);
      if (cmd === "gate_lock_acquire") return Promise.resolve(TAKEN);
      return Promise.resolve({ outcome: "released", holder: null });
    });

    const out = await withGateLock("/repo", SPARKLE_DEV_GATE, "agent-2", async () => {
      // THE SIDE EFFECT THAT MATTERS: the body runs while the lock is held and before the release.
      expect(calls).toEqual(["gate_lock_acquire"]);
      return "ran";
    });

    expect(out).toBe("ran");
    expect(calls).toEqual(["gate_lock_acquire", "gate_lock_release"]);
  });

  // THE PATH A HAND-WRITTEN acquire/release PAIR FORGETS. A gate lock protects a PINNED resource,
  // which by construction has no alternative for anyone else to move to — so a lock leaked on a
  // throw wedges the whole fleet until the TTL runs out.
  it("releases the lock when the body THROWS, and still reports the body's error", async () => {
    const calls: string[] = [];
    invoke.mockImplementation((cmd: string) => {
      calls.push(cmd);
      if (cmd === "gate_lock_acquire") return Promise.resolve(TAKEN);
      return Promise.resolve({ outcome: "released", holder: null });
    });

    await expect(
      withGateLock("/repo", SPARKLE_DEV_GATE, "agent-2", async () => {
        throw new Error("the dev server died");
      }),
    ).rejects.toThrow("the dev server died");

    expect(calls).toEqual(["gate_lock_acquire", "gate_lock_release"]);
  });

  it("does not run the body when the lock is refused, and hands the refusal to onRefused", async () => {
    const calls: string[] = [];
    let ran = false;
    let refusedWith: GateLockOutcome | null = null;
    invoke.mockImplementation((cmd: string) => {
      calls.push(cmd);
      return Promise.resolve(REFUSED);
    });

    const out = await withGateLock(
      "/repo",
      SPARKLE_DEV_GATE,
      "agent-2",
      async () => {
        ran = true;
        return "should not happen";
      },
      { onRefused: (o) => (refusedWith = o) },
    );

    expect(out).toBeNull();
    expect(ran).toBe(false);
    // AND NOTHING WAS RELEASED. A release on the refused path would remove the HOLDER'S record —
    // the Rust side refuses it, but issuing it at all would be this module asking for that.
    expect(calls).toEqual(["gate_lock_acquire"]);
    expect(refusedWith).not.toBeNull();
    expect(refusedWith!.lock.agentId).toBe("agent-1");
  });

  // A cleanup failure must not replace the caller's real result. `release` is best-effort because
  // the TTL clears the lock either way, and a thrown cleanup detail is one nobody can act on.
  it("returns the body's value even when the release itself fails", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "gate_lock_acquire") return Promise.resolve(TAKEN);
      return Promise.reject(new Error("registry unreadable"));
    });
    await expect(
      withGateLock("/repo", SPARKLE_DEV_GATE, "agent-2", async () => "ran"),
    ).resolves.toBe("ran");
  });
});

describe("leakedLeases", () => {
  // EXPIRED AND BOUND ARE DIFFERENT COLUMNS, and reading either alone is wrong in a different
  // direction: an expired lease whose port is still BOUND is a live-but-quiet holder that must
  // never be disturbed; an unexpired one that happens to be unbound is a server still starting up.
  it("reports only the expired leases whose port is actually free", () => {
    const status: BrokerStatus = {
      registry: "/repo/.git/sparkle-port-broker",
      enabled: true,
      rangeStart: 45000,
      rangeEnd: 45099,
      leaseTtlSecs: 900,
      heartbeatSecs: 60,
      leases: [
        lease({ port: 45000, agentId: "gone", expired: true, bound: false }),
        lease({ port: 45001, agentId: "quiet", expired: true, bound: true }),
        lease({ port: 45002, agentId: "starting", expired: false, bound: false }),
        lease({ port: 45003, agentId: "healthy", expired: false, bound: true }),
      ],
      gateLocks: [],
    };
    expect(leakedLeases(status).map((l) => l.agentId)).toEqual(["gone"]);
  });
});

describe("the names that must match the Rust side", () => {
  it("spells a pinned port's gate the way port_broker::pinned_gate_name does", () => {
    expect(pinnedGateName(5173)).toBe("port-5173");
    expect(SPARKLE_DEV_GATE).toBe("-1420");
  });
});
