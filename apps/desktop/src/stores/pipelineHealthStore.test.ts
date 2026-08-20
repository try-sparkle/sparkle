// pipelineHealthStore — the poll's contract, and the state→tone mapping the icon paints from.
//
// The bug this store exists for (bead sparkle-m6jov5) is a SILENT outage, so the two properties that
// matter most are: a failed poll must NOT clear a known-bad reading (the icon must not blink to
// "all clear" on a dropped IPC), and a wedged/blocking component must surface as amber/red rather
// than vanish. Both are asserted here as side effects on the published store.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type PipelineHealth,
  __resetPipelineHealthForTests,
  __setPipelineProbeForTests,
  refreshPipelineHealth,
  setPipelineRoot,
  toneForState,
  usePipelineHealthStore,
} from "./pipelineHealthStore";
import {
  __resetPipelineEscalationForTests,
  __setPipelineEscalationDepsForTests,
  type EscalationDeps,
} from "../services/pipelineHealthEscalation";

vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  __resetPipelineHealthForTests();
  __resetPipelineEscalationForTests();
});

/** Let an in-flight poll (including the eager one setPipelineRoot fires) settle: drain the probe's
 *  microtask AND the reducer's `finally` that clears the in-flight guard. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const HEALTHY: PipelineHealth = {
  overall: "healthy",
  components: [
    { id: "roborev", name: "Code review (roborev)", state: "healthy", detail: "running" },
  ],
};

const WEDGED: PipelineHealth = {
  overall: "warning",
  components: [
    {
      id: "roborev",
      name: "Code review (roborev)",
      state: "warning",
      detail: "roborev daemon is registered but not responding — it appears wedged.",
    },
  ],
};

describe("toneForState", () => {
  it("maps each state to the icon tone: blocking→red, warning/unknown→amber, healthy→green, off→muted", () => {
    expect(toneForState("blocking")).toBe("red");
    expect(toneForState("warning")).toBe("amber");
    expect(toneForState("unknown")).toBe("amber");
    expect(toneForState("healthy")).toBe("green");
    expect(toneForState("not_applicable")).toBe("muted");
  });
});

describe("refreshPipelineHealth", () => {
  it("publishes a healthy reading and, on the next poll, a wedged one — the side effect the icon reads", async () => {
    __setPipelineProbeForTests(async () => HEALTHY);
    setPipelineRoot("/repo"); // eager poll with HEALTHY
    await flush();
    expect(usePipelineHealthStore.getState().health).toEqual(HEALTHY);
    expect(usePipelineHealthStore.getState().error).toBeNull();

    // A later poll finds roborev wedged — the store must now carry the WARNING reading.
    __setPipelineProbeForTests(async () => WEDGED);
    await refreshPipelineHealth();
    expect(usePipelineHealthStore.getState().health?.overall).toBe("warning");
    expect(usePipelineHealthStore.getState().health?.components[0]?.detail).toContain("wedged");
  });

  it("a failed poll KEEPS the last reading and only records the error — it never blinks to all-clear", async () => {
    __setPipelineProbeForTests(async () => WEDGED);
    setPipelineRoot("/repo"); // eager poll with WEDGED
    await flush();
    expect(usePipelineHealthStore.getState().health?.overall).toBe("warning");

    // The next poll throws (a dropped IPC). The wedged reading must SURVIVE — clearing it would
    // recreate the silent-outage invisibility this store exists to fix.
    __setPipelineProbeForTests(async () => {
      throw new Error("ipc dropped");
    });
    await refreshPipelineHealth();
    expect(usePipelineHealthStore.getState().health?.overall).toBe("warning");
    expect(usePipelineHealthStore.getState().error).toContain("ipc dropped");
  });

  it("does not poll when no root is set", async () => {
    const probe = vi.fn(async () => HEALTHY);
    __setPipelineProbeForTests(probe);
    // No setPipelineRoot → activeRoot is null.
    await refreshPipelineHealth();
    expect(probe).not.toHaveBeenCalled();
    expect(usePipelineHealthStore.getState().health).toBeNull();
  });

  it("setPipelineRoot to the same value does not re-poll, but a new value does", async () => {
    const probe = vi.fn(async () => HEALTHY);
    __setPipelineProbeForTests(probe);
    setPipelineRoot("/repo"); // eager poll #1
    setPipelineRoot("/repo"); // same → no new poll
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    setPipelineRoot("/other"); // changed → eager poll #2
    await flush();
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe("refreshPipelineHealth → real-time escalation (driven through the real store transition)", () => {
  let woke: string[];
  let told: string[];

  beforeEach(() => {
    woke = [];
    told = [];
    const deps: EscalationDeps = {
      now: () => Date.now(),
      notifyConcierge: (t) => {
        told.push(t);
        return true;
      },
      wakeImprove: async (t) => {
        woke.push(t);
        return true;
      },
      fileDurableBead: async () => {},
    };
    __setPipelineEscalationDepsForTests(deps);
  });

  it("a green→blocking transition across two REAL polls escalates once, naming the component+remediation", async () => {
    __setPipelineProbeForTests(async () => HEALTHY);
    setPipelineRoot("/repo"); // eager poll #1 = HEALTHY (baseline, no alert)
    await flush();
    expect(woke).toHaveLength(0);
    expect(told).toHaveLength(0);

    // The next real poll finds roborev BLOCKING — the store publishes it AND escalates the edge.
    const BLOCKED: PipelineHealth = {
      overall: "blocking",
      components: [
        { id: "roborev", name: "Code review (roborev)", state: "blocking", detail: "daemon down" },
      ],
    };
    __setPipelineProbeForTests(async () => BLOCKED);
    await refreshPipelineHealth();
    await flush(); // let the fire-and-forget escalation settle

    expect(usePipelineHealthStore.getState().health?.overall).toBe("blocking");
    expect(woke).toHaveLength(1);
    expect(told).toHaveLength(1);
    expect(woke[0]).toContain("Code review (roborev)");
    expect(woke[0]).toContain("BLOCKING");
    expect(woke[0]).toContain("scripts/roborev-maintenance.sh --watchdog");
  });

  it("a steady blocking state across polls does NOT re-escalate", async () => {
    const BLOCKED: PipelineHealth = {
      overall: "blocking",
      components: [
        { id: "roborev", name: "Code review (roborev)", state: "blocking", detail: "down" },
      ],
    };
    __setPipelineProbeForTests(async () => BLOCKED);
    setPipelineRoot("/repo"); // baseline poll (blocking, but first reading → no alert)
    await flush();
    expect(woke).toHaveLength(0);

    await refreshPipelineHealth(); // still blocking — steady state, no edge
    await flush();
    expect(woke).toHaveLength(0);
  });

  it("a failed poll does not escalate (the prior reading survives, no transition is observed)", async () => {
    const WARN: PipelineHealth = {
      overall: "warning",
      components: [
        { id: "roborev", name: "Code review (roborev)", state: "warning", detail: "wedged" },
      ],
    };
    __setPipelineProbeForTests(async () => WARN);
    setPipelineRoot("/repo"); // baseline warning (first reading → no alert)
    await flush();

    __setPipelineProbeForTests(async () => {
      throw new Error("ipc dropped");
    });
    await refreshPipelineHealth();
    await flush();
    // The catch path never reaches escalation, so nothing was pushed on a dropped poll.
    expect(woke).toHaveLength(0);
    expect(told).toHaveLength(0);
  });
});
