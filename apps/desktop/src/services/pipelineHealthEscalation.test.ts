// pipelineHealthEscalation — the EDGE is the whole feature. These tests assert the SIDE EFFECTS
// (which channel was called, with what text), never merely that a handler exists, and they drive the
// real detector so a mutation to the gate or the routing reds one of them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PipelineHealth } from "../stores/pipelineHealthStore";
import {
  WARNING_DEBOUNCE_MS,
  __resetPipelineEscalationForTests,
  composeEscalationMessage,
  detectEscalations,
  escalatePipelineHealth,
  remediationFor,
  type EscalationDeps,
  type EscalationEvent,
} from "./pipelineHealthEscalation";

vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

/** Build a one-component snapshot with the given roborev state. */
function snap(state: PipelineHealth["overall"], detail = "detail text"): PipelineHealth {
  return {
    overall: state,
    components: [{ id: "roborev", name: "Code review (roborev)", state, detail }],
  };
}

/** A snapshot with two components in specified states. */
function twoSnap(
  roborev: PipelineHealth["overall"],
  ci: PipelineHealth["overall"],
): PipelineHealth {
  return {
    overall: "warning",
    components: [
      { id: "roborev", name: "Code review (roborev)", state: roborev, detail: "rr" },
      { id: "ci_runners", name: "CI test runners", state: ci, detail: "ci" },
    ],
  };
}

interface Recorder {
  concierge: string[];
  woke: string[];
  beads: EscalationEvent[];
  deps: EscalationDeps;
  now: number;
}

/** A recorder whose channels all SUCCEED, with a controllable clock. */
function recorder(now = 1_000_000): Recorder {
  const r: Recorder = {
    concierge: [],
    woke: [],
    beads: [],
    now,
    deps: undefined as unknown as EscalationDeps,
  };
  r.deps = {
    now: () => r.now,
    notifyConcierge: (t) => {
      r.concierge.push(t);
      return true;
    },
    wakeImprove: async (t) => {
      r.woke.push(t);
      return true;
    },
    fileDurableBead: async (ev) => {
      r.beads.push(ev);
    },
  };
  return r;
}

beforeEach(() => __resetPipelineEscalationForTests());
afterEach(() => __resetPipelineEscalationForTests());

describe("detectEscalations (pure edges)", () => {
  it("emits nothing on the FIRST reading (prev null) — a bad component at startup is steady state", () => {
    expect(detectEscalations(null, snap("blocking"))).toEqual([]);
  });

  it("green→blocking is a worse edge; blocking→blocking (steady) is not", () => {
    const up = detectEscalations(snap("healthy"), snap("blocking"));
    expect(up).toHaveLength(1);
    expect(up[0]!.severity).toBe("blocking");

    expect(detectEscalations(snap("blocking"), snap("blocking"))).toEqual([]);
  });

  it("warning→blocking escalates (worse), but blocking→warning (partial thaw) does NOT alarm", () => {
    expect(detectEscalations(snap("warning"), snap("blocking"))[0]!.severity).toBe("blocking");
    expect(detectEscalations(snap("blocking"), snap("warning"))).toEqual([]);
  });

  it("crossing INTO unknown never alarms, and out of unknown into warning DOES", () => {
    expect(detectEscalations(snap("healthy"), snap("unknown"))).toEqual([]);
    expect(detectEscalations(snap("blocking"), snap("unknown"))).toEqual([]);
    expect(detectEscalations(snap("unknown"), snap("warning"))[0]!.severity).toBe("warning");
  });

  it("bad→good is a recovery (from warning AND from blocking)", () => {
    expect(detectEscalations(snap("warning"), snap("healthy"))[0]!.severity).toBe("recovery");
    expect(detectEscalations(snap("blocking"), snap("not_applicable"))[0]!.severity).toBe("recovery");
  });

  it("skips a component with no baseline in prev (never alarms on first sighting)", () => {
    const prev = snap("healthy"); // only roborev
    const next = twoSnap("healthy", "blocking"); // ci_runners is new
    expect(detectEscalations(prev, next)).toEqual([]);
  });
});

describe("composeEscalationMessage + remediationFor", () => {
  it("names the component, the new severity, and the remediation on a blocking alarm", () => {
    const ev = detectEscalations(snap("healthy"), snap("blocking", "roborev daemon down"))[0]!;
    const msg = composeEscalationMessage(ev);
    expect(msg).toContain("Code review (roborev)");
    expect(msg).toContain("BLOCKING");
    expect(msg).toContain("roborev daemon down");
    expect(msg).toContain("scripts/roborev-maintenance.sh --watchdog");
  });

  it("has a codified remediation for every known pipeline component id", () => {
    for (const id of ["roborev", "ci_runners", "release_runner", "knightwatch", "release_publication"]) {
      expect(remediationFor(id), id).not.toBeNull();
    }
    expect(remediationFor("nope")).toBeNull();
  });

  it("a recovery message says RECOVERED and needs no remediation", () => {
    const ev = detectEscalations(snap("blocking"), snap("healthy", "back up"))[0]!;
    const msg = composeEscalationMessage(ev);
    expect(msg).toContain("RECOVERED");
    expect(msg).not.toContain("Remediation:");
  });
});

describe("escalatePipelineHealth — routing + gating side effects", () => {
  it("green→blocking fires EXACTLY ONE escalation to BOTH channels, naming component+severity+remediation", async () => {
    const r = recorder();
    const res = await escalatePipelineHealth(snap("healthy"), snap("blocking", "wedged"), r.deps);

    expect(res.delivered).toHaveLength(1);
    expect(r.concierge).toHaveLength(1);
    expect(r.woke).toHaveLength(1);
    // The wake (Improve-Sparkle) AND the concierge both carry the actionable body.
    for (const t of [r.concierge[0]!, r.woke[0]!]) {
      expect(t).toContain("Code review (roborev)");
      expect(t).toContain("BLOCKING");
      expect(t).toContain("scripts/roborev-maintenance.sh --watchdog");
    }
    // Both channels succeeded → NO fail-safe bead.
    expect(r.beads).toHaveLength(0);
  });

  it("a bad→bad steady state does NOT re-fire (edge-triggered, not steady-state)", async () => {
    const r = recorder();
    await escalatePipelineHealth(snap("blocking"), snap("blocking"), r.deps);
    expect(r.concierge).toHaveLength(0);
    expect(r.woke).toHaveLength(0);
  });

  it("a WARNING is debounced: a second warning edge for the same component inside the window is suppressed", async () => {
    const r = recorder();
    // First warning edge fires.
    await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);
    expect(r.woke).toHaveLength(1);

    // A second warning edge for the same component, still inside the debounce window. (No recovery
    // is driven here on purpose — the flap that crosses one is the separate test below, and it is
    // the case this one used to CLAIM in a comment while never exercising it.)
    r.now += WARNING_DEBOUNCE_MS - 1;
    const res = await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);
    expect(res.delivered).toHaveLength(0);
    expect(res.debounced).toHaveLength(1);
    expect(r.woke).toHaveLength(1); // still just the first

    // Past the window, it fires again.
    r.now += 2;
    await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);
    expect(r.woke).toHaveLength(2);
  });

  it("BLOCKING is NEVER debounced, even back-to-back within the warning window", async () => {
    const r = recorder();
    await escalatePipelineHealth(snap("healthy"), snap("blocking"), r.deps);
    r.now += 1000; // well inside WARNING_DEBOUNCE_MS
    await escalatePipelineHealth(snap("healthy"), snap("blocking"), r.deps);
    expect(r.woke).toHaveLength(2);
  });

  it("UNKNOWN does not alarm — a crossing into unknown reaches neither channel", async () => {
    const r = recorder();
    await escalatePipelineHealth(snap("healthy"), snap("unknown"), r.deps);
    expect(r.concierge).toHaveLength(0);
    expect(r.woke).toHaveLength(0);
    expect(r.beads).toHaveLength(0);
  });

  it("bad→green fires a RECOVERY notice (and never files a bead)", async () => {
    const r = recorder();
    const res = await escalatePipelineHealth(snap("blocking"), snap("healthy", "back up"), r.deps);
    expect(res.delivered).toHaveLength(1);
    expect(res.delivered[0]!.severity).toBe("recovery");
    expect(r.concierge[0]).toContain("RECOVERED");
    expect(r.woke[0]).toContain("RECOVERED");
    expect(r.beads).toHaveLength(0); // recovery never files a bead
  });

  // ── THE FLAP: green→warning→green→warning on the poll interval ────────────────────────────────
  // This is the condition WARNING_DEBOUNCE_MS exists for, and the one the gate could not suppress:
  // the flap crosses a RECOVERY every cycle, and the recovery used to clear the debounce, so the
  // next warning always re-fired. Both channels alternated alarm/all-clear 61s apart in production,
  // each wake costing a full agent turn. Drive the real edges, on the real cadence.
  const POLL_MS = 61_000;

  it("a flapping component goes SILENT after its first announced cycle — both channels", async () => {
    const r = recorder();
    // Cycle 1: announced in full, so a reader learns of the degradation and its clearing.
    await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);
    r.now += POLL_MS;
    await escalatePipelineHealth(snap("warning"), snap("healthy"), r.deps);
    expect(r.woke).toHaveLength(2); // 1 warning + 1 recovery
    expect(r.concierge).toHaveLength(2);

    // Cycles 2..10, all well inside the 30-minute window: NOTHING more is delivered. Neither the
    // warning (debounced) nor its recovery (an all-clear for an alarm nobody was told about).
    for (let i = 0; i < 9; i++) {
      r.now += POLL_MS;
      const up = await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);
      expect(up.delivered).toHaveLength(0);
      expect(up.debounced).toHaveLength(1);
      r.now += POLL_MS;
      const down = await escalatePipelineHealth(snap("warning"), snap("healthy"), r.deps);
      expect(down.delivered).toHaveLength(0);
    }
    expect(r.woke).toHaveLength(2); // still just the first cycle
    expect(r.concierge).toHaveLength(2);
    expect(r.beads).toHaveLength(0); // a debounced alarm is not a failed delivery
  });

  it("a warning fires again once the window elapses, even though recoveries intervened", async () => {
    const r = recorder();
    await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);
    // Flap through the whole window; every cycle after the first is silent.
    for (let i = 0; i < 5; i++) {
      r.now += POLL_MS;
      await escalatePipelineHealth(snap("warning"), snap("healthy"), r.deps);
      r.now += POLL_MS;
      await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);
    }
    expect(r.woke).toHaveLength(2); // the first warning + the first recovery, nothing since

    // Past the window, a genuinely new warning is NOT swallowed.
    r.now += WARNING_DEBOUNCE_MS;
    const res = await escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps);
    expect(res.delivered).toHaveLength(1);
    expect(res.delivered[0]!.severity).toBe("warning");
    expect(r.woke).toHaveLength(3);
  });

  it("a recovery with no SUPPRESSED warning behind it always fires — the startup baseline case", async () => {
    // The first poll establishes a baseline without alerting, so a component already warning at
    // launch has no delivered alarm. Its recovery is what tells the improvement pass that an open
    // pipeline-health bead can be closed, so it must not be swallowed.
    const r = recorder();
    const res = await escalatePipelineHealth(snap("warning"), snap("healthy"), r.deps);
    expect(res.delivered).toHaveLength(1);
    expect(res.delivered[0]!.severity).toBe("recovery");
    expect(r.woke[0]).toContain("RECOVERED");
  });

  it("the debounce is PER COMPONENT: one flapping component does not silence another's alarm", async () => {
    const r = recorder();
    // roborev flaps into its debounce.
    await escalatePipelineHealth(twoSnap("healthy", "healthy"), twoSnap("warning", "healthy"), r.deps);
    r.now += POLL_MS;
    await escalatePipelineHealth(twoSnap("warning", "healthy"), twoSnap("healthy", "healthy"), r.deps);
    r.now += POLL_MS;
    await escalatePipelineHealth(twoSnap("healthy", "healthy"), twoSnap("warning", "healthy"), r.deps);
    expect(r.woke).toHaveLength(2); // roborev's first warning + first recovery only

    // ci_runners' FIRST warning still gets through, inside roborev's window.
    r.now += POLL_MS;
    const res = await escalatePipelineHealth(
      twoSnap("warning", "healthy"),
      twoSnap("warning", "warning"),
      r.deps,
    );
    expect(res.delivered).toHaveLength(1);
    expect(res.delivered[0]!.componentId).toBe("ci_runners");
    expect(r.woke).toHaveLength(3);
  });

  it("FAIL-SAFE: when the durable inbox wake fails, the alarm still files a durable bead", async () => {
    const r = recorder();
    // Both real-time channels fail: concierge unmounted (false), inbox doorbell rejects.
    r.deps = {
      now: () => r.now,
      notifyConcierge: () => false,
      wakeImprove: async () => {
        throw new Error("inbox down");
      },
      fileDurableBead: async (ev) => {
        r.beads.push(ev);
      },
    };
    await escalatePipelineHealth(snap("healthy"), snap("blocking"), r.deps);
    // The real-time push failed on both channels, but the durable bead is filed — nothing is lost.
    expect(r.beads).toHaveLength(1);
    expect(r.beads[0]!.componentId).toBe("roborev");
    expect(r.beads[0]!.severity).toBe("blocking");
  });

  it("does NOT file a fail-safe bead when the durable wake SUCCEEDED even if the concierge failed", async () => {
    const r = recorder();
    r.deps = {
      now: () => r.now,
      notifyConcierge: () => false, // concierge unmounted
      wakeImprove: async () => true, // durable channel landed
      fileDurableBead: async (ev) => {
        r.beads.push(ev);
      },
    };
    await escalatePipelineHealth(snap("healthy"), snap("blocking"), r.deps);
    expect(r.beads).toHaveLength(0); // inbox is durable; no bead needed
  });

  it("does not throw when a channel throws — a watchdog never takes the poll down", async () => {
    const r = recorder();
    r.deps = {
      now: () => r.now,
      notifyConcierge: () => {
        throw new Error("boom");
      },
      wakeImprove: async () => true,
      fileDurableBead: async () => {},
    };
    await expect(
      escalatePipelineHealth(snap("healthy"), snap("warning"), r.deps),
    ).resolves.toBeDefined();
  });
});
