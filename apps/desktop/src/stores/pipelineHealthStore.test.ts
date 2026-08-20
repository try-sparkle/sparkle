// pipelineHealthStore — the poll's contract, and the state→tone mapping the icon paints from.
//
// The bug this store exists for (bead sparkle-m6jov5) is a SILENT outage, so the two properties that
// matter most are: a failed poll must NOT clear a known-bad reading (the icon must not blink to
// "all clear" on a dropped IPC), and a wedged/blocking component must surface as amber/red rather
// than vanish. Both are asserted here as side effects on the published store.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type PipelineHealth,
  __resetPipelineHealthForTests,
  __setPipelineProbeForTests,
  refreshPipelineHealth,
  setPipelineRoot,
  toneForState,
  usePipelineHealthStore,
} from "./pipelineHealthStore";

afterEach(() => {
  __resetPipelineHealthForTests();
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
