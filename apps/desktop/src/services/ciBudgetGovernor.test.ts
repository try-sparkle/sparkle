import { describe, it, expect } from "vitest";
import {
  admitCiWork,
  CiBudgetGovernor,
  UNKNOWN_LOAD,
  type CiLoad,
  type Scheduler,
} from "./ciBudgetGovernor";

// Let queued microtasks settle so an ADMITTED `run` reaches its `work()` (acquire resolves, then
// `await` yields once before the work is invoked). A real macrotask tick covers any depth.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A scheduler whose lease callbacks fire only when the test says so — makes slot expiry (and thus
 *  "a slot frees") deterministic, so the drain is observed on purpose rather than on a wall clock. */
function manualScheduler() {
  const leases: Array<() => void> = [];
  const scheduler: Scheduler = (_ms, cb) => {
    leases.push(cb);
    return () => {
      const i = leases.indexOf(cb);
      if (i >= 0) leases.splice(i, 1);
    };
  };
  return {
    scheduler,
    /** Fire the oldest live lease — i.e. one in-flight CI run "completes" and frees its slot. */
    fireOne() {
      const cb = leases.shift();
      if (!cb) throw new Error("no lease to fire");
      cb();
    },
    get liveLeases() {
      return leases.length;
    },
  };
}

const freeLoad: CiLoad = { releaseInProgress: false };

// ── The PURE decision (the mutation target) ─────────────────────────────────────────────────────
describe("admitCiWork — the pure admission rules", () => {
  it("grants under budget with no release running", () => {
    expect(admitCiWork({ inFlight: 0, budget: 6, load: freeLoad })).toBe("grant");
    expect(admitCiWork({ inFlight: 5, budget: 6, load: freeLoad })).toBe("grant");
  });

  it("Rule 2 — HOLDS at the budget cap (removing the `inFlight >= budget` check would let this through)", () => {
    expect(admitCiWork({ inFlight: 6, budget: 6, load: freeLoad })).toBe("hold");
    expect(admitCiWork({ inFlight: 7, budget: 6, load: freeLoad })).toBe("hold");
  });

  it("Rule 1 — RELEASE PRIORITY holds even with the budget wide open and slots free", () => {
    expect(admitCiWork({ inFlight: 0, budget: 6, load: { releaseInProgress: true } })).toBe("hold");
  });

  it("Rule 0 — budget 0 disables the governor entirely (always grants, even 'over' 0 and during a release)", () => {
    expect(admitCiWork({ inFlight: 99, budget: 0, load: { releaseInProgress: true } })).toBe("grant");
  });

  it("NO saturation rule — an all-busy pool alone (release off, under budget) still GRANTS, so the autoscaler's demand signal isn't suppressed", () => {
    // Deleting Rule 3 was deliberate: withholding pushes when the pool is busy starves the
    // queue-depth autoscaler. Only the budget cap and a live release may hold.
    expect(admitCiWork({ inFlight: 1, budget: 6, load: { releaseInProgress: false } })).toBe("grant");
  });

  it("FAIL-SAFE — an UNKNOWN release signal never holds on rule 1, but the budget cap still binds", () => {
    // Unknown release, under budget → grant (not frozen by a transient gh fail).
    expect(admitCiWork({ inFlight: 0, budget: 2, load: UNKNOWN_LOAD })).toBe("grant");
    // …yet the numeric cap is still enforced, so an unknown signal can never flood past `budget`.
    expect(admitCiWork({ inFlight: 2, budget: 2, load: UNKNOWN_LOAD })).toBe("hold");
  });
});

// ── The real governor object, driven end to end ─────────────────────────────────────────────────
describe("CiBudgetGovernor — budget holds and drains (side effect: did the work RUN?)", () => {
  it("holds the (N+1)th ship until a slot frees, then runs it", async () => {
    const m = manualScheduler();
    const gov = new CiBudgetGovernor({
      budget: 2,
      leaseMs: 1000,
      loadProbe: () => freeLoad,
      scheduler: m.scheduler,
    });

    const ran: string[] = [];
    const work = (id: string) => async () => {
      ran.push(id);
      return { pushed: true };
    };

    void gov.run(work("a"));
    void gov.run(work("b"));
    await tick();
    // Two slots, two ships — both pushed.
    expect(ran).toEqual(["a", "b"]);
    expect(gov.inFlightCount).toBe(2);

    // The 3rd is at the cap → HELD. The side effect (its work / its push) must NOT have happened.
    void gov.run(work("c"));
    await tick();
    expect(ran).toEqual(["a", "b"]);
    expect(ran).not.toContain("c");
    expect(gov.queueLength).toBe(1);

    // A slot frees (one CI run completes) → the queued ship drains and finally pushes.
    m.fireOne();
    await tick();
    expect(ran).toEqual(["a", "b", "c"]);
    expect(gov.queueLength).toBe(0);
  });

  it("a release in progress pauses the fleet; ending it drains the queue", async () => {
    let releasing = true;
    const gov = new CiBudgetGovernor({
      budget: 6, // budget is wide open — only the release signal is holding the fleet
      leaseMs: 1000,
      loadProbe: () => ({ releaseInProgress: releasing }),
      scheduler: manualScheduler().scheduler,
    });

    let pushed = false;
    void gov.run(async () => {
      pushed = true;
      return { pushed: true };
    });
    await tick();
    // Held by RELEASE PRIORITY despite free slots — fleet work did NOT push.
    expect(pushed).toBe(false);
    expect(gov.queueLength).toBe(1);
    expect(gov.inFlightCount).toBe(0);

    // Release finishes; a pipeline-health tick calls pump() → the ship proceeds.
    releasing = false;
    gov.pump();
    await tick();
    expect(pushed).toBe(true);
    expect(gov.queueLength).toBe(0);
  });

  it("FAIL-SAFE — an unreadable load probe degrades to the budget cap, never a flood or a freeze", async () => {
    const m = manualScheduler();
    const gov = new CiBudgetGovernor({
      budget: 1,
      leaseMs: 1000,
      loadProbe: () => {
        throw new Error("gh unreachable"); // safeLoad() must fold this to UNKNOWN_LOAD
      },
      scheduler: m.scheduler,
    });

    const ran: string[] = [];
    const work = (id: string) => async () => {
      ran.push(id);
      return { pushed: true };
    };

    void gov.run(work("a"));
    await tick();
    expect(ran).toEqual(["a"]); // not frozen: a single slot is granted under unknown load

    void gov.run(work("b"));
    await tick();
    expect(ran).toEqual(["a"]); // not flooded: the budget cap still holds the 2nd

    m.fireOne();
    await tick();
    expect(ran).toEqual(["a", "b"]);
  });

  it("work that triggers NO CI (no-remote land) frees its slot immediately, holding nothing", async () => {
    const gov = new CiBudgetGovernor({
      budget: 1,
      leaseMs: 1_000_000, // long lease: if the slot were held, the 2nd ship could never run here
      loadProbe: () => freeLoad,
      scheduler: manualScheduler().scheduler,
    });

    const ran: string[] = [];
    // First ship SUCCEEDS but reports it triggered no CI → slot must be released without a lease.
    await gov.run(
      async () => {
        ran.push("land");
        return { pushed: false };
      },
      (r) => r.pushed,
    );
    expect(gov.inFlightCount).toBe(0);

    // With the slot freed, a second CI-triggering ship proceeds despite the huge lease.
    void gov.run(async () => {
      ran.push("push");
      return { pushed: true };
    });
    await tick();
    expect(ran).toEqual(["land", "push"]);
  });

  it("a push that THROWS frees its slot at once (no CI fired)", async () => {
    const gov = new CiBudgetGovernor({
      budget: 1,
      leaseMs: 1_000_000,
      loadProbe: () => freeLoad,
      scheduler: manualScheduler().scheduler,
    });

    await expect(
      gov.run(async () => {
        throw new Error("push rejected");
      }),
    ).rejects.toThrow("push rejected");
    expect(gov.inFlightCount).toBe(0);

    const ran: string[] = [];
    void gov.run(async () => {
      ran.push("next");
      return { pushed: true };
    });
    await tick();
    expect(ran).toEqual(["next"]); // the failed ship did not strand its slot
  });

  it("budget 0 is a pass-through: every ship runs at once, none queued", async () => {
    const gov = new CiBudgetGovernor({
      budget: 0,
      leaseMs: 1000,
      loadProbe: () => ({ releaseInProgress: true }), // even a hostile signal
      scheduler: manualScheduler().scheduler,
    });
    const ran: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        gov.run(async () => {
          ran.push(n);
          return { pushed: true };
        }),
      ),
    );
    expect(ran.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(gov.queueLength).toBe(0);
  });
});
