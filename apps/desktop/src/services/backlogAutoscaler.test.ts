// The arithmetic is the deliverable, so every case here asserts the COMPUTED TARGET — not that
// `decideAutoscale` ran, not that some object came back. A test that only pinned the shape would be
// green against a function that returned `freeSlots` and ignored the backlog entirely.
import { beforeEach, describe, it, expect, vi } from "vitest";
import type { Bead } from "./beads";
import type { CapacityReading } from "./agentCapacity";
import type { ConcurrencyAdmission } from "./memoryAdmission";
import type { BeadClaimsReading, ClaimOutcome, ClaimStanding } from "./autoscalerClaim";
import type { NextReadyBead } from "./improveNudge";
import {
  decideAutoscale,
  sweepBacklogAutoscaler,
  shouldReportAutoscale,
  autoscaleFingerprint,
  backpressureFor,
  spawnBudgetFor,
  lastAutoscaleDecision,
  _resetBacklogAutoscalerForTests,
  AUTOSCALE_POPULATION,
  AUTOSCALE_REPORT_HEARTBEAT_MS,
  AUTOSCALE_MAX_SPAWNS_PER_PASS,
  AUTOSCALE_THROTTLED_SPAWNS_PER_PASS,
  AUTOSCALE_DEAD_AGENT_HOLD_MS,
  type AutoscaleDecision,
  type BacklogAutoscalerDeps,
  type SpawnResult,
} from "./backlogAutoscaler";

const bead = (id: string, priority?: number): Bead => ({
  id,
  title: `work on ${id}`,
  description: "",
  status: "open",
  labels: [],
  priority,
});

/** N ready beads, all the same priority, so the count is the only thing under test. */
const backlogOf = (n: number): Bead[] => Array.from({ length: n }, (_, i) => bead(`sparkle-r${i}`, 1));

const capacity = (over: Partial<CapacityReading> = {}): CapacityReading => ({
  used: 2,
  live: 2,
  limit: 8,
  basis: "CPU-bound: 18 cores × 2 agents per core",
  atCapacity: false,
  ...over,
});

describe("decideAutoscale — the clamp", () => {
  it("clamps the target to FREE CAPACITY when the backlog is larger", () => {
    // 8 slots, 5 taken → 3 free; 40 ready beads. The target is the free-slot count, not the backlog.
    const d = decideAutoscale({
      boardReadable: true,
      readyBacklog: backlogOf(40),
      capacity: capacity({ used: 5, limit: 8 }),
      floor: 0,
      backpressure: "none",
    });
    expect(d.target).toBe(3);
    expect(d.freeSlots).toBe(3);
    expect(d.readyCount).toBe(40);
    expect(d.reason).toBe("capacity-bound");
    // 37 ready beads this pass cannot staff — the number a human reads to size the shortfall.
    expect(d.deficit).toBe(37);
  });

  it("clamps the target to the READY BACKLOG when capacity is larger", () => {
    // 30 slots, 2 taken → 28 free; only 4 ready beads. The target is the backlog, not the headroom.
    const d = decideAutoscale({
      boardReadable: true,
      readyBacklog: backlogOf(4),
      capacity: capacity({ used: 2, limit: 30 }),
      floor: 0,
      backpressure: "none",
    });
    expect(d.target).toBe(4);
    expect(d.freeSlots).toBe(28);
    expect(d.readyCount).toBe(4);
    expect(d.reason).toBe("backlog-bound");
    // Everything ready is staffable, so nothing is left over.
    expect(d.deficit).toBe(0);
  });

  it("reports a tie as backlog-bound: adding capacity would buy nothing", () => {
    const d = decideAutoscale({
      boardReadable: true,
      readyBacklog: backlogOf(3),
      capacity: capacity({ used: 5, limit: 8 }),
      floor: 0,
      backpressure: "none",
    });
    expect(d.target).toBe(3);
    expect(d.deficit).toBe(0);
    expect(d.reason).toBe("backlog-bound");
  });
});

describe("decideAutoscale — zero free slots", () => {
  it("targets ZERO at capacity, with the backlog reported in full", () => {
    const d = decideAutoscale({
      boardReadable: true,
      readyBacklog: backlogOf(12),
      capacity: capacity({ used: 8, limit: 8, atCapacity: true }),
      floor: 0,
      backpressure: "none",
    });
    expect(d.target).toBe(0);
    expect(d.freeSlots).toBe(0);
    // The board WAS read, so the counts are real: 12 ready, none of them staffable.
    expect(d.readyCount).toBe(12);
    expect(d.deficit).toBe(12);
    expect(d.reason).toBe("at-capacity");
  });

  it("never computes a NEGATIVE target when a runtime narrowing puts used above limit", () => {
    // `agentCapacity` documents this state explicitly: memory pressure or the run queue lowers the
    // ceiling under a fleet already admitted, so `used > limit` is a real, rendered state. Without
    // the floor, `min(limit - used, backlog)` is negative — not a number of agents at all.
    const d = decideAutoscale({
      boardReadable: true,
      readyBacklog: backlogOf(12),
      capacity: capacity({ used: 40, limit: 21, atCapacity: true }),
      floor: 0,
      backpressure: "none",
    });
    expect(d.freeSlots).toBe(0);
    expect(d.target).toBe(0);
    expect(d.reason).toBe("at-capacity");
  });

  it("targets ZERO on an empty ready column, and says the backlog is why", () => {
    const d = decideAutoscale({
      boardReadable: true,
      readyBacklog: [],
      capacity: capacity({ used: 1, limit: 8 }),
      floor: 0,
      backpressure: "none",
    });
    expect(d.target).toBe(0);
    expect(d.readyCount).toBe(0);
    expect(d.deficit).toBe(0);
    expect(d.reason).toBe("backlog-empty");
    expect(d.nextBead).toBeNull();
  });
});

describe("decideAutoscale — an unreadable board is NOT zero backlog", () => {
  it("yields NO TARGET AT ALL, distinct from a target of zero", () => {
    const d = decideAutoscale({
      boardReadable: false,
      // A caller may hand anything here; an unreadable board must ignore it rather than count it.
      readyBacklog: backlogOf(9),
      capacity: capacity({ used: 2, limit: 8 }),
      floor: 0,
      backpressure: "none",
    });
    expect(d.target).toBeNull();
    expect(d.target).not.toBe(0);
    expect(d.readyCount).toBeNull();
    expect(d.deficit).toBeNull();
    expect(d.reason).toBe("board-unreadable");
    expect(d.nextBead).toBeNull();
    // The CAPACITY half is still known and still reported — the board is what could not be read.
    expect(d.freeSlots).toBe(6);
    expect(d.ceiling).toBe(8);
  });

  it("is distinguishable from a genuinely drained board by the SAME capacity reading", () => {
    const cap = capacity({ used: 2, limit: 8 });
    const unreadable = decideAutoscale({ boardReadable: false, readyBacklog: [], capacity: cap, floor: 0, backpressure: "none" });
    const drained = decideAutoscale({ boardReadable: true, readyBacklog: [], capacity: cap, floor: 0, backpressure: "none" });
    // Same machine, same slots — the ONLY difference is whether the board answered, and that has
    // to survive into the output or a consumer cannot tell "no work" from "no idea".
    expect(unreadable.target).toBeNull();
    expect(drained.target).toBe(0);
    expect(unreadable.reason).not.toBe(drained.reason);
  });

  it("says in words that no target is not a target of zero", () => {
    const d = decideAutoscale({ boardReadable: false, readyBacklog: [], capacity: capacity(), floor: 0, backpressure: "none" });
    expect(d.summary).toMatch(/not the same as a target of zero/i);
  });
});

describe("decideAutoscale — reported context", () => {
  it("names the next bead with the EXISTING priority ordering, P0 before P1", () => {
    const d = decideAutoscale({
      boardReadable: true,
      readyBacklog: [bead("", 1), bead("", 0), bead("")],
      capacity: capacity({ used: 0, limit: 4 }),
      floor: 0,
      backpressure: "none",
    });
    expect(d.nextBead?.id).toBe("");
  });

  it("carries the ceiling, its basis, and the population the count came from", () => {
    // This is the MEASUREMENT the dry run exists for: a human compares the ceiling against what the
    // machine's RAM should support, and needs to know which population produced `current`.
    const d = decideAutoscale({
      boardReadable: true,
      readyBacklog: backlogOf(2),
      capacity: capacity({ used: 3, limit: 6, basis: "RAM-bound: 16 GiB installed − 6 GiB reserved" }),
      floor: 0,
      backpressure: "none",
    });
    expect(d.ceiling).toBe(6);
    expect(d.current).toBe(3);
    expect(d.basis).toBe("RAM-bound: 16 GiB installed − 6 GiB reserved");
    expect(d.population).toBe(AUTOSCALE_POPULATION);
    expect(d.summary).toContain("RAM-bound: 16 GiB installed − 6 GiB reserved");
    expect(d.summary).toContain(AUTOSCALE_POPULATION);
  });

  it("says plainly that nothing starts unless a human armed it — and does NOT claim the loop is read-only", () => {
    // A PAIRED COPY RATCHET, and both halves are needed (AGENTS.md).
    //
    // The POSITIVE half: the summary must still tell a reader that nothing happens without arming.
    // Deleting that sentence would leave a log line reading "the backlog wants 4 more agents" over a
    // loop that may have started four, with nothing saying which.
    //
    // The NEGATIVE half: it must NOT still say what the dry-run phase said. That copy — "NOTHING WAS
    // STARTED: this is Phase 1, read-only" — survived Phase 2 adding a real spawn, so the one line a
    // human reads asserted, on every armed pass, the opposite of what had just happened. A fix that
    // changes WHEN something happens must update every place that described the old timing.
    const d = decideAutoscale({
      boardReadable: true,
      readyBacklog: backlogOf(5),
      capacity: capacity({ used: 0, limit: 4 }),
      floor: 0,
      backpressure: "none",
    });
    expect(d.target).toBe(4);
    expect(d.summary, "the arming condition must still be stated").toMatch(
      /nothing starts at all unless \[autoscaler\]\.armed is true/i,
    );
    expect(d.summary, "the dry-run copy must not outlive the dry run").not.toMatch(
      /read-only|NOTHING WAS STARTED/i,
    );
    // And the pacing numbers a human needs to read the line at all.
    expect(d.summary).toContain("This pass may start");
  });

  it("does not mutate the caller's snapshot array", () => {
    const backlog = [bead("", 1), bead("", 0)];
    decideAutoscale({ boardReadable: true, readyBacklog: backlog, capacity: capacity(), floor: 0, backpressure: "none" });
    expect(backlog.map((b) => b.id)).toEqual(["", ""]);
  });
});

describe("shouldReportAutoscale", () => {
  const decision = (over: Partial<AutoscaleDecision> = {}): AutoscaleDecision => ({
    ...decideAutoscale({ boardReadable: true, readyBacklog: backlogOf(3), capacity: capacity(), floor: 0, backpressure: "none" }),
    ...over,
  });

  it("reports the first decision it ever sees", () => {
    expect(shouldReportAutoscale(null, decision(), 1_000)).toBe(true);
  });

  it("stays quiet on an unchanged decision inside the heartbeat", () => {
    const d = decision();
    const prev = { fingerprint: autoscaleFingerprint(d), at: 1_000 };
    expect(shouldReportAutoscale(prev, d, 1_000 + AUTOSCALE_REPORT_HEARTBEAT_MS - 1)).toBe(false);
  });

  it("re-reports an unchanged decision at the heartbeat", () => {
    const d = decision();
    const prev = { fingerprint: autoscaleFingerprint(d), at: 1_000 };
    expect(shouldReportAutoscale(prev, d, 1_000 + AUTOSCALE_REPORT_HEARTBEAT_MS)).toBe(true);
  });

  it("reports immediately when the numbers move", () => {
    const before = decision();
    const after = decideAutoscale({
      boardReadable: true,
      readyBacklog: backlogOf(3),
      capacity: capacity({ used: 7 }),
      floor: 0,
      backpressure: "none",
    });
    const prev = { fingerprint: autoscaleFingerprint(before), at: 1_000 };
    expect(shouldReportAutoscale(prev, after, 1_001)).toBe(true);
  });
});

// ══ PHASE 4 — THE BACKPRESSURE READING ══════════════════════════════════════════════════════════
//
// Pure, so every branch is asserted without a memory sampler, a clock or a store.

describe("backpressureFor", () => {
  const admission = (over: Partial<ConcurrencyAdmission> = {}): ConcurrencyAdmission => ({
    effective: 8,
    static_max: 8,
    static_bound: "cpu",
    bound: "cpu",
    basis: "CPU-bound",
    sampled: true,
    sample: {
      total_bytes: 64,
      available_bytes: 32,
      compressed_bytes: 0,
      swap_used_bytes: 0,
      level: "normal",
    },
    ...over,
  });

  it("NOTHING MEASURED IS NOT TROUBLE — a null reading does not push back", () => {
    // `currentMemoryAdmission` returns null for three different causes (never sampled, the last
    // sample failed, the last sample expired) and its own docs say all three mean "behave exactly as
    // you did before". Reading any of them as pressure lets one failed sampler silence the loop for
    // the life of the window.
    expect(backpressureFor(null)).toBe("none");
  });

  it("an UNSAMPLED reading does not push back either", () => {
    expect(backpressureFor(admission({ sampled: false }))).toBe("none");
    expect(backpressureFor(admission({ sample: null }))).toBe("none");
  });

  it("reads the OS's own verdict rather than arithmetic of ours", () => {
    expect(backpressureFor(admission())).toBe("none");
    expect(backpressureFor(admission({ sample: { ...admission().sample!, level: "warn" } }))).toBe(
      "throttle",
    );
    expect(
      backpressureFor(admission({ sample: { ...admission().sample!, level: "critical" } })),
    ).toBe("hold");
  });

  it("a NARROWED ceiling alone is not backpressure — that fact is already in `capacity.limit`", () => {
    // `localAgentCapacity` applies the narrowing to the ceiling this module divides, so `freeSlots`
    // has already accounted for it. Re-deriving it here would double-count one fact and refuse
    // spawns the machine had already made room for.
    expect(backpressureFor(admission({ effective: 2, static_max: 8, bound: "available" }))).toBe(
      "none",
    );
  });

  it("an UNRECOGNISED level THROTTLES rather than holds", () => {
    // Deliberately against the usual fail-closed rule, and the reason is this epic's own retro: the
    // vocabulary comes from Rust and could grow a value, and treating an unknown word as an
    // emergency would convert a vocabulary change into PERMANENT IDLENESS on a never-idle epic
    // (roborev 80561). Throttling keeps the loop moving at its most conservative rate.
    const weird = admission({
      sample: { ...admission().sample!, level: "meltdown" as unknown as "critical" },
    });
    expect(backpressureFor(weird)).toBe("throttle");
  });
});

// ══ PHASE 3 + 4 — THE PACING POLICY, SEPARATE FROM THE ARITHMETIC ═══════════════════════════════

describe("spawnBudgetFor — the policy, kept apart from the arithmetic", () => {
  it("an unreadable board yields NO budget — null is not zero", () => {
    expect(spawnBudgetFor(null, 0, "none")).toBe(0);
    expect(spawnBudgetFor(null, 99, "none")).toBe(0);
  });

  it("the ordinary cap bounds a large target", () => {
    expect(spawnBudgetFor(40, 0, "none")).toBe(AUTOSCALE_MAX_SPAWNS_PER_PASS);
  });

  it("the TARGET bounds the cap — the arithmetic always wins downward", () => {
    expect(spawnBudgetFor(1, 0, "none")).toBe(1);
    expect(spawnBudgetFor(0, 0, "none")).toBe(0);
  });

  it("a floor shortfall WIDENS the pass, but never past the target", () => {
    expect(spawnBudgetFor(40, 7, "none")).toBe(7);
    expect(spawnBudgetFor(4, 7, "none")).toBe(4);
  });

  it("a floor SHORTER than the cap does not narrow it", () => {
    // The floor raises the pass to the shortfall or leaves the cap alone; it is a max, not a set.
    expect(spawnBudgetFor(40, 1, "none")).toBe(AUTOSCALE_MAX_SPAWNS_PER_PASS);
  });

  it("HOLD stops everything, whatever the floor says", () => {
    expect(spawnBudgetFor(40, 20, "hold")).toBe(0);
  });

  it("THROTTLE pins the pass at one — the floor does NOT burst past backpressure", () => {
    // The load-bearing interaction. A floor exists to keep the fleet fed, not to feed it faster
    // than the machine can carry, and letting it win here would make the one setting a human
    // reaches for during a stall the setting that makes a squeeze worse.
    expect(spawnBudgetFor(40, 20, "throttle")).toBe(AUTOSCALE_THROTTLED_SPAWNS_PER_PASS);
    // ...and it still keeps making progress. Throttle is not a stop.
    expect(spawnBudgetFor(40, 20, "throttle")).toBeGreaterThan(0);
  });
});

// ══ THE SWEEP ══════════════════════════════════════════════════════════════════════════════════

/**
 * A FAKE DURABLE CLAIM STORE, shared between as many sweeps as a case wants to run.
 *
 * SHARED IS THE POINT. Phase 3 exists because the old de-duplication was per-window; a fake that
 * each sweep owned privately would reproduce exactly the bug and pass. So one store is handed to
 * two sets of deps with two different claimant ids, which is what two Sparkle windows are.
 *
 * It implements the real compare-and-set semantics — a live claim refuses, a dead one is taken
 * over — because a fake that always granted would make every duplicate test vacuous.
 */
function fakeClaimStore() {
  // STANDING IS THREE-VALUED HERE BECAUSE IT IS THREE-VALUED IN RUST, and modelling it as a boolean
  // is what hid a real defect: with only `live`/`dead-stale` reachable, no case could seed the
  // `dead-epoch` state — a claim whose holding LAUNCH is provably gone — and the selection rule that
  // mishandled it was green for exactly that reason. A fixture that cannot express a state cannot
  // test it (bead `sparkle-knqorh`'s shape).
  const claims = new Map<
    string,
    { claimantId: string; agentId: string | null; standing: ClaimStanding }
  >();
  let readable = true;
  const view = (beadId: string) => {
    const c = claims.get(beadId)!;
    return {
      claim: {
        beadId,
        claimantId: c.claimantId,
        agentId: c.agentId,
        claimedAtMs: 0,
        heartbeatAtMs: 0,
        epoch: "e",
      },
      standing: c.standing,
      heartbeatAgeMs: 0,
    };
  };
  return {
    /** Seed a claim as if another window (or a previous launch) had left it.
     *
     *  `live: false` still means `dead-stale` — a LIVE launch that stopped checking in. Pass
     *  `standing: "dead-epoch"` for the other thing entirely: a launch that is provably GONE. */
    seed(
      beadId: string,
      claimantId: string,
      opts: { live?: boolean; standing?: ClaimStanding; agentId?: string | null } = {},
    ) {
      claims.set(beadId, {
        claimantId,
        agentId: opts.agentId ?? null,
        standing: opts.standing ?? ((opts.live ?? true) ? "live" : "dead-stale"),
      });
    },
    setReadable(v: boolean) {
      readable = v;
    },
    has: (beadId: string) => claims.has(beadId),
    isLive: (beadId: string) => claims.get(beadId)?.standing === "live",
    agentOf: (beadId: string) => claims.get(beadId)?.agentId ?? null,
    size: () => claims.size,
    reading: (): BeadClaimsReading =>
      readable
        ? { readable: true, claims: [...claims.keys()].map(view) }
        : { readable: false, claims: [] },
    acquire(beadId: string, claimantId: string): ClaimOutcome {
      const held = claims.get(beadId);
      if (held !== undefined && held.standing === "live" && held.claimantId !== claimantId) {
        return {
          acquired: false,
          claim: null,
          heldBy: view(beadId).claim,
          reason: "held-live",
          tookOver: false,
          previousHolder: null,
          detail: "held",
        };
      }
      const tookOver = held !== undefined && held.standing !== "live";
      claims.set(beadId, { claimantId, agentId: held?.agentId ?? null, standing: "live" });
      return {
        acquired: true,
        claim: view(beadId).claim,
        heldBy: null,
        reason: null,
        tookOver,
        previousHolder: null,
        detail: null,
      };
    },
    heartbeat(beadId: string, agentId?: string) {
      const c = claims.get(beadId);
      if (c === undefined) return false;
      if (agentId !== undefined) c.agentId = agentId;
      // A heartbeat refreshes the stamp, so a claim that had gone stale reads LIVE again. Modelling
      // it as a no-op would make the stale-recovery case below unable to prove it recovered.
      c.standing = "live";
      return true;
    },
    release(beadId: string) {
      claims.delete(beadId);
    },
    /** Take over a dead claim under a new claimant, KEEPING its agent — what adoption is. */
    adopt(beadId: string, claimantId: string, agentId: string) {
      claims.set(beadId, { claimantId, agentId, standing: "live" });
    },
  };
}

describe("sweepBacklogAutoscaler", () => {
  /** Every id the fake `spawn` has minted, so `liveAgentIds` can model a fleet by default. */
  function makeDeps(over: Partial<BacklogAutoscalerDeps> = {}, store = fakeClaimStore()) {
    const report = vi.fn();
    const journal = vi.fn();
    /** ORDER OF WRITES, in one list, so "journal before claim before spawn" is a single assertion
     *  rather than three timestamps a reader has to compare by eye. */
    const order: string[] = [];
    const fleet = new Set<string>();
    /** Agents this window witnesses RUNNING. A spawn puts its agent here as well as in `fleet`,
     *  because a just-started agent is both a row and a process. */
    const running = new Set<string>();
    /** Agents this window witnessed EXIT. Strong evidence — but NOT terminal on its own, because it
     *  is also `resurrectionRunner`'s input domain. */
    const exited = new Set<string>();
    /** Agents the resurrection sweep has DUE. A dead agent in here is coming back to the same bead
     *  under the same row id, so its claim must be held rather than released. */
    const resurrecting = new Set<string>();
    /** The hold window, mutable so a case can drive the bound rather than sleeping through it. */
    let holdMs = AUTOSCALE_DEAD_AGENT_HOLD_MS;
    const setHoldMs = (ms: number) => {
      holdMs = ms;
    };
    let nextAgent = 0;
    const spawn = vi.fn((b: NextReadyBead): SpawnResult => {
      order.push(`spawn:${b.id}`);
      const agentId = `agent-${(nextAgent += 1)}`;
      fleet.add(agentId);
      running.add(agentId);
      return { outcome: "spawned", agentId };
    });
    const claimantId = "autoscaler-aaaaaaaaaaaaaaaa";
    const deps: BacklogAutoscalerDeps = {
      ownsProject: () => true,
      readBoard: () => ({ boardReadable: true, readyBacklog: backlogOf(10) }),
      readCapacity: () => capacity({ used: 5, limit: 8 }),
      floor: () => 0,
      readMemoryAdmission: () => null,
      report,
      now: () => 1_000,
      // DISARMED by default, mirroring production: the store ships false and a missing config key
      // reads false. A test that wants the writing pass opts IN, exactly as a human must.
      isArmed: () => false,
      claimantId: () => claimantId,
      readClaims: () => {
        order.push("readClaims");
        return Promise.resolve(store.reading());
      },
      claimBead: (b) => {
        order.push(`claim:${b.id}`);
        return Promise.resolve(store.acquire(b.id, deps.claimantId()));
      },
      heartbeatClaim: (beadId, agentId) => {
        order.push(`heartbeat:${beadId}:${agentId ?? "none"}`);
        const ok = store.heartbeat(beadId, agentId);
        return Promise.resolve(
          ok
            ? { ok: true, reason: null, message: "" }
            : { ok: false, reason: "absent" as const, message: "no such claim" },
        );
      },
      releaseClaim: (beadId) => {
        order.push(`release:${beadId}`);
        store.release(beadId);
        return Promise.resolve({ ok: true, reason: null, message: "" });
      },
      liveAgentIds: () => fleet,
      // THREE-VALUED, and the fixture must be able to say all three or it cannot express the state
      // the last two review rounds turned on. `running` is a process this window witnesses alive,
      // `exited` one it witnessed die; an id in NEITHER set is `undefined` — unwitnessed, which is
      // what a rehydrated row from a previous launch looks like. `fleet` stays the ROW list.
      processAlive: (id: string) => (running.has(id) ? true : exited.has(id) ? false : undefined),
      resurrectionPending: (id: string) => resurrecting.has(id),
      deadAgentHoldMs: () => holdMs,
      adoptClaim: (beadId, agentId) => {
        order.push(`adopt:${beadId}:${agentId}`);
        store.adopt(beadId, claimantId, agentId);
        return Promise.resolve();
      },
      spawn,
      journal: (b, i, of) => {
        order.push(`journal:${b.id}`);
        journal(b, i, of);
      },
      ...over,
    };
    return { deps, report, spawn, journal, store, order, fleet, running, exited, resurrecting, setHoldMs };
  }

  /** Ids the fake spawn was asked to start, in order. */
  const spawnedIds = (spawn: ReturnType<typeof vi.fn>): string[] =>
    spawn.mock.calls.map((c) => (c[0] as NextReadyBead).id);

  beforeEach(() => {
    _resetBacklogAutoscalerForTests();
  });

  it("computes the target from the injected board and capacity, and reports it", async () => {
    const { deps, report } = makeDeps();
    const d = await sweepBacklogAutoscaler(deps);
    expect(d?.target).toBe(3);
    expect(report).toHaveBeenCalledTimes(1);
    expect(lastAutoscaleDecision()?.target).toBe(3);
  });

  it("does nothing at all in a window that does not own the project", async () => {
    const { deps, report } = makeDeps({ ownsProject: () => false });
    expect(await sweepBacklogAutoscaler(deps)).toBeNull();
    expect(report).not.toHaveBeenCalled();
    expect(lastAutoscaleDecision()).toBeNull();
  });

  it("does not re-report an unchanged decision on the next tick", async () => {
    const { deps, report } = makeDeps();
    await sweepBacklogAutoscaler(deps);
    await sweepBacklogAutoscaler(deps);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("reports again as soon as the decision changes", async () => {
    let used = 5;
    const { deps, report } = makeDeps({ readCapacity: () => capacity({ used, limit: 8 }) });
    await sweepBacklogAutoscaler(deps);
    used = 2;
    await sweepBacklogAutoscaler(deps);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("re-reports when the FLOOR moves, even though the arithmetic did not", async () => {
    // The floor is in the fingerprint on purpose: a human who has just set one wants the next line
    // to show it, and without it the heartbeat would sit on a ten-minute silence over a change.
    let floor = 0;
    const { deps, report } = makeDeps({ floor: () => floor });
    await sweepBacklogAutoscaler(deps);
    floor = 4;
    await sweepBacklogAutoscaler(deps);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("carries an unreadable board through the sweep as no target", async () => {
    const { deps } = makeDeps({ readBoard: () => ({ boardReadable: false, readyBacklog: [] }) });
    const d = await sweepBacklogAutoscaler(deps);
    expect(d?.target).toBeNull();
    expect(d?.reason).toBe("board-unreadable");
    expect(d?.spawnBudget).toBe(0);
  });

  // ── ARMING ────────────────────────────────────────────────────────────────────────────────────

  describe("backlogAutoscaler writes NOTHING until a human arms it", () => {
    it("computes and reports exactly as the dry run did, and touches no writer at all, while DISARMED", async () => {
      // STRICTLY STRONGER THAN "no spawn". Phase 3 added a second write — the durable claim — and a
      // claim taken from a disarmed window is a file this build was never authorised to touch. So
      // the assertion is that the pass reaches NO writer and does not even READ the claim store.
      const { deps, report, spawn, journal, order } = makeDeps();
      const d = await sweepBacklogAutoscaler(deps);
      expect(d?.target).toBe(3);
      expect(report).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
      expect(journal).not.toHaveBeenCalled();
      expect(order, "a disarmed pass must reach nothing that writes").toEqual([]);
    });

    it("still writes nothing while disarmed even with a full backlog, every slot free and a floor set", async () => {
      const { deps, spawn, journal, order } = makeDeps({
        readBoard: () => ({ boardReadable: true, readyBacklog: backlogOf(50) }),
        readCapacity: () => capacity({ used: 0, limit: 12 }),
        floor: () => 12,
      });
      const d = await sweepBacklogAutoscaler(deps);
      expect(d?.target).toBe(12);
      // The BUDGET is still computed and reported — a disarmed loop must still be able to tell a
      // human what it would do — but nothing acts on it.
      expect(d?.spawnBudget).toBe(12);
      expect(spawn).not.toHaveBeenCalled();
      expect(journal).not.toHaveBeenCalled();
      expect(order).toEqual([]);
    });

    it("ARMED, it journals BEFORE the claim and the claim BEFORE the spawn", async () => {
      // THE ORDERING IS THE SAFETY ARGUMENT, and this reds if any pair is swapped. The 236-write
      // incident was recoverable only because every write had been journalled first; with the claim
      // now ahead of the spawn there are two writes to account for, so the line precedes both.
      const { deps, order } = makeDeps({ isArmed: () => true });
      await sweepBacklogAutoscaler(deps);
      const writes = order.filter((o) => !o.startsWith("readClaims"));
      // ANTI-VACUITY: an empty list satisfies every `toMatch` below by never running one.
      expect(writes.length, "the pass must have journalled, claimed and spawned").toBeGreaterThanOrEqual(3);
      const [journalled, claimed, spawned] = writes as [string, string, string];
      expect(journalled).toMatch(/^journal:/);
      expect(claimed).toMatch(/^claim:/);
      expect(spawned).toMatch(/^spawn:/);
      // And they are about the SAME bead — an ordering that journalled one bead and spawned another
      // would satisfy a positional check while accounting for nothing.
      const beadId = journalled.slice("journal:".length);
      expect(claimed).toBe(`claim:${beadId}`);
      expect(spawned).toBe(`spawn:${beadId}`);
    });

    it("ARMED but with an UNREADABLE board, it starts nothing — unknown is not zero", async () => {
      const { deps, spawn, journal } = makeDeps({
        isArmed: () => true,
        readBoard: () => ({ boardReadable: false, readyBacklog: [] }),
      });
      await sweepBacklogAutoscaler(deps);
      expect(spawn).not.toHaveBeenCalled();
      expect(journal).not.toHaveBeenCalled();
    });

    it("ARMED but at capacity, it starts nothing", async () => {
      const { deps, spawn } = makeDeps({
        isArmed: () => true,
        readCapacity: () => capacity({ used: 8, limit: 8, atCapacity: true }),
      });
      const d = await sweepBacklogAutoscaler(deps);
      expect(d?.target).toBe(0);
      expect(spawn).not.toHaveBeenCalled();
    });

    it("ARMED but with an UNREADABLE CLAIM STORE, it starts nothing", async () => {
      // FAIL-CLOSED, and this is the one new refusal Phase 3 introduces. A spawn issued against a
      // claim store nobody could read cannot know whether a peer window is already on this bead,
      // which is the entire defect the durable claim exists to close. `readable: false` must never
      // be treated as "nothing is claimed".
      const store = fakeClaimStore();
      store.setReadable(false);
      const { deps, spawn, journal } = makeDeps({ isArmed: () => true }, store);
      const d = await sweepBacklogAutoscaler(deps);
      expect(d?.spawnBudget).toBeGreaterThan(0);
      expect(spawn).not.toHaveBeenCalled();
      expect(journal, "not even the journal line — nothing was attempted").not.toHaveBeenCalled();
    });
  });

  // ── PHASE 3 — THE DURABLE CLAIM ACROSS WINDOWS ────────────────────────────────────────────────

  describe("two windows cannot spawn against the same bead", () => {
    /** Two sets of deps over ONE store: what two Sparkle windows on one machine actually are. */
    function twoWindows(over: Partial<BacklogAutoscalerDeps> = {}) {
      const store = fakeClaimStore();
      const a = makeDeps({ isArmed: () => true, ...over }, store);
      const b = makeDeps(
        { isArmed: () => true, claimantId: () => "autoscaler-bbbbbbbbbbbbbbbb", ...over },
        store,
      );
      return { a, b, store };
    }

    it("the second window is REFUSED the bead the first took, and takes the NEXT one instead", async () => {
      // Both halves matter. Refusing the duplicate is the fix; still taking the next bead is what
      // keeps it from being a head-of-line block, which is how this epic's previous double-spawn
      // fix went wrong (roborev 80561).
      const { a, b } = twoWindows({
        readBoard: () => ({ boardReadable: true, readyBacklog: backlogOf(10) }),
        readCapacity: () => capacity({ used: 7, limit: 8 }),
      });
      await sweepBacklogAutoscaler(a.deps);
      await sweepBacklogAutoscaler(b.deps);
      expect(spawnedIds(a.spawn)).toHaveLength(1);
      expect(spawnedIds(b.spawn)).toHaveLength(1);
      expect(spawnedIds(b.spawn)[0]).not.toBe(spawnedIds(a.spawn)[0]);
    });

    it("with only ONE ready bead, the second window spawns NOTHING", async () => {
      // The narrow case with nowhere to move on to, and the one a widening mutant breaks: here the
      // duplicate must simply be refused.
      const one = [bead("sparkle-only", 1)];
      const { a, b } = twoWindows({
        readBoard: () => ({ boardReadable: true, readyBacklog: one }),
        readCapacity: () => capacity({ used: 0, limit: 8 }),
      });
      await sweepBacklogAutoscaler(a.deps);
      await sweepBacklogAutoscaler(b.deps);
      expect(spawnedIds(a.spawn)).toEqual(["sparkle-only"]);
      expect(b.spawn).not.toHaveBeenCalled();
    });

    it("a claim left by a DEAD window expires and the bead is re-staffed", async () => {
      // The expiry path, and it is not optional: a window that dies holding a claim must not park
      // that bead forever. On a never-idle epic that turns a double-book into a permanent stall,
      // which is the worse failure.
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      store.seed("sparkle-only", "autoscaler-deaddeaddeaddead", { live: false });
      const { deps, spawn } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 0, limit: 8 }),
        },
        store,
      );
      await sweepBacklogAutoscaler(deps);
      expect(spawnedIds(spawn)).toEqual(["sparkle-only"]);
    });

    it("a LIVE claim by a peer on the only ready bead parks nothing else — the pass just does not spawn", async () => {
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      store.seed("sparkle-only", "autoscaler-bbbbbbbbbbbbbbbb", { live: true, agentId: "agent-x" });
      const { deps, spawn } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 0, limit: 8 }),
        },
        store,
      );
      await sweepBacklogAutoscaler(deps);
      expect(spawn).not.toHaveBeenCalled();
      // AND WE DID NOT TOUCH SOMEBODY ELSE'S CLAIM. Reconciliation is scoped to our own claimant id;
      // releasing a peer's would re-open the double-spawn from the other direction.
      expect(store.has("sparkle-only")).toBe(true);
      expect(store.agentOf("sparkle-only")).toBe("agent-x");
    });

    it("a LOST RACE mid-pass moves on to the next bead rather than ending the pass", async () => {
      // The listing is a SNAPSHOT and a peer may win in the milliseconds since, so a refused CAS is
      // ordinary. Ending the pass there would waste the rest of the budget on every contended tick.
      const store = fakeClaimStore();
      const { deps, spawn } = makeDeps({ isArmed: () => true }, store);
      let first = true;
      const real = deps.claimBead;
      deps.claimBead = async (b) => {
        if (first) {
          first = false;
          return {
            acquired: false,
            claim: null,
            heldBy: null,
            reason: "held-live",
            tookOver: false,
            previousHolder: null,
            detail: "a peer won",
          };
        }
        return real(b);
      };
      await sweepBacklogAutoscaler(deps);
      // A LOST RACE DOES NOT SPEND THE BUDGET. `spawnBudget` is how many agents the pass may START,
      // and a refused claim started none — so the pass tries the next bead and still delivers three,
      // rather than coming up short by however many races it happened to lose. Four beads were
      // attempted, three of them on distinct spawns.
      expect(spawnedIds(spawn)).toHaveLength(3);
      expect(new Set(spawnedIds(spawn)).size).toBe(3);
    });

    it("CANNOT SPIN when every claim is refused — the candidate pool is finite", async () => {
      // The other side of "a lost race does not spend the budget". Without the attempted-set the
      // loop would re-select the same top bead forever inside one 60s tick and hang the window.
      const store = fakeClaimStore();
      const { deps, spawn } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: backlogOf(4) }),
          readCapacity: () => capacity({ used: 0, limit: 20 }),
        },
        store,
      );
      let attempts = 0;
      deps.claimBead = () => {
        attempts += 1;
        return Promise.resolve({
          acquired: false,
          claim: null,
          heldBy: null,
          reason: "held-live",
          tookOver: false,
          previousHolder: null,
          detail: "always refused",
        });
      };
      await sweepBacklogAutoscaler(deps);
      expect(spawn).not.toHaveBeenCalled();
      expect(attempts, "one attempt per ready bead, then the pass ends").toBe(4);
    });
  });

  describe("N spawns in one pass name N DIFFERENT beads", () => {
    it("spends the whole per-pass cap on distinct beads", async () => {
      // THE WHOLE POINT OF PHASE 3. Phase 2 capped the pass at ONE precisely because
      // `decideAutoscale` names a single bead and the de-duplication was per-window; with a durable
      // claim the pass re-selects after each win, so raising the cap is safe — and this is the
      // assertion that says so rather than the comment.
      const { deps, spawn } = makeDeps({
        isArmed: () => true,
        readCapacity: () => capacity({ used: 0, limit: 20 }),
      });
      const d = await sweepBacklogAutoscaler(deps);
      expect(d?.spawnBudget).toBe(AUTOSCALE_MAX_SPAWNS_PER_PASS);
      const ids = spawnedIds(spawn);
      expect(ids).toHaveLength(AUTOSCALE_MAX_SPAWNS_PER_PASS);
      expect(new Set(ids).size, "every spawn in a pass must name a different bead").toBe(ids.length);
    });

    it("every bead it starts is claimed first, and the agent is bound to the claim", async () => {
      const { deps, spawn, store, order } = makeDeps({
        isArmed: () => true,
        readCapacity: () => capacity({ used: 0, limit: 20 }),
      });
      await sweepBacklogAutoscaler(deps);
      for (const id of spawnedIds(spawn)) {
        expect(store.has(id), `${id} was spawned without a claim`).toBe(true);
        // BOUND. Until the agent is recorded the claim is never renewed, so an unbound claim on a
        // live agent expires under it and the bead gets double-booked at the backstop.
        expect(store.agentOf(id), `${id}'s claim carries no agent`).toMatch(/^agent-\d+$/);
        expect(order).toContain(`heartbeat:${id}:${store.agentOf(id)}`);
      }
    });
  });

  describe("the loop keeps making progress on the second and the tenth pass", () => {
    it("staffs the whole ready column across passes and then stops — no re-spawn, no head-of-line block", async () => {
      // TEN SWEEPS OVER A BOARD THAT DOES NOT CHANGE — the shape `sparkle-yskany` was filed for.
      // A fixture that reassigned the board between ticks would hide both failures this pins: a
      // claim that is never taken (re-spawning the same bead every minute) and a claim that is
      // never released (one agent for the life of the window, then permanent idleness).
      //
      // Capacity TRACKS the spawns, because production's does: `localAgentCapacity` counts rows and
      // a spawned row is counted immediately. Holding it constant would be the fixture varying what
      // production holds fixed, in the other direction.
      const board = backlogOf(6);
      let used = 0;
      const store = fakeClaimStore();
      const { deps, spawn } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: board }),
          readCapacity: () => capacity({ used, limit: 20 }),
        },
        store,
      );
      const realSpawn = deps.spawn;
      deps.spawn = (b) => {
        used += 1;
        return realSpawn(b);
      };
      for (let pass = 0; pass < 10; pass += 1) await sweepBacklogAutoscaler(deps);
      const ids = spawnedIds(spawn);
      expect(ids, "every ready bead is staffed exactly once").toHaveLength(6);
      expect(new Set(ids).size).toBe(6);
      // AND IT KEPT MOVING. Two passes at the cap of 3 would finish it; a head-of-line block would
      // have stopped at one and stayed there for the remaining nine.
      expect(spawn.mock.calls.length).toBeGreaterThan(1);
    });

    it("ten sweeps over an unchanged, fully-claimed board start nothing more and release nothing", async () => {
      // The steady state. A claim that is silently released each pass would re-spawn forever; one
      // that is never renewed would expire and re-spawn at the backstop.
      const board = backlogOf(2);
      let used = 0;
      const store = fakeClaimStore();
      const { deps, spawn, order } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: board }),
          readCapacity: () => capacity({ used, limit: 20 }),
        },
        store,
      );
      const realSpawn = deps.spawn;
      deps.spawn = (b) => {
        used += 1;
        return realSpawn(b);
      };
      await sweepBacklogAutoscaler(deps);
      expect(spawnedIds(spawn)).toHaveLength(2);
      order.length = 0;
      for (let pass = 0; pass < 10; pass += 1) await sweepBacklogAutoscaler(deps);
      expect(spawnedIds(spawn), "nothing more may be started").toHaveLength(2);
      expect(store.size()).toBe(2);
      expect(order.filter((o) => o.startsWith("release:")), "nothing may be released").toEqual([]);
      // ...and each live claim was RENEWED on every one of the ten passes, or it would expire under
      // the agent that is working it.
      expect(order.filter((o) => o.startsWith("heartbeat:"))).toHaveLength(20);
    });
  });

  describe("reconciling our own claims", () => {
    it("releases a claim whose bead has LEFT the ready column — the work moved on", async () => {
      const store = fakeClaimStore();
      store.seed("sparkle-done", "autoscaler-aaaaaaaaaaaaaaaa", { live: true, agentId: "agent-9" });
      const { deps, fleet } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: backlogOf(2) }),
          readCapacity: () => capacity({ used: 8, limit: 8, atCapacity: true }),
        },
        store,
      );
      fleet.add("agent-9");
      await sweepBacklogAutoscaler(deps);
      expect(store.has("sparkle-done")).toBe(false);
    });

    it("reconciles even AT CAPACITY, when no spawn is possible", async () => {
      // Housekeeping runs before the budget checks and regardless of them. Gate it behind a
      // positive budget and a full machine never releases anything, so the next pass with a free
      // slot finds a board that looks entirely claimed.
      const store = fakeClaimStore();
      store.seed("sparkle-done", "autoscaler-aaaaaaaaaaaaaaaa", { live: true, agentId: "agent-9" });
      const { deps, fleet } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: [] }),
          readCapacity: () => capacity({ used: 8, limit: 8, atCapacity: true }),
        },
        store,
      );
      fleet.add("agent-9");
      const d = await sweepBacklogAutoscaler(deps);
      expect(d?.spawnBudget).toBe(0);
      expect(store.has("sparkle-done")).toBe(false);
    });

    it("releases a claim whose AGENT has left the fleet, and the bead is re-staffed next pass", async () => {
      // The never-idle half. The bead is still ready and nobody is working it, so waiting out the
      // expiry would leave real work unstaffed for the length of the backstop.
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      store.seed("sparkle-only", "autoscaler-aaaaaaaaaaaaaaaa", { live: true, agentId: "agent-gone" });
      const { deps, spawn } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 0, limit: 8 }),
        },
        store,
      );
      // `fleet` does not contain `agent-gone` — the agent died or was closed.
      //
      // RE-STAFFED IN THE SAME PASS, not the next one. The claim listing was taken before
      // reconciliation, so a release has to be subtracted from it or the freed bead stays excluded
      // for the rest of the pass — a minute of a free slot sitting against ready work, which is
      // precisely what a never-idle loop must not do.
      await sweepBacklogAutoscaler(deps);
      expect(spawnedIds(spawn)).toEqual(["sparkle-only"]);
    });

    it("RENEWS a claim whose agent is still in the fleet, and does not re-spawn it", async () => {
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      store.seed("sparkle-only", "autoscaler-aaaaaaaaaaaaaaaa", { live: true, agentId: "agent-live" });
      const { deps, spawn, fleet, running, order } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 0, limit: 8 }),
        },
        store,
      );
      fleet.add("agent-live");
      running.add("agent-live");
      running.add("agent-live");
      await sweepBacklogAutoscaler(deps);
      expect(spawn).not.toHaveBeenCalled();
      expect(order).toContain("heartbeat:sparkle-only:agent-live");
      expect(store.has("sparkle-only")).toBe(true);
    });

    it("an UNREADABLE BOARD releases nothing — 'I could not look' is not 'the column is empty'", async () => {
      // Releasing on that reading would hand the whole in-flight fleet's beads back to the next
      // pass, which is the double-spawn arriving by the back door.
      const store = fakeClaimStore();
      store.seed("sparkle-a", "autoscaler-aaaaaaaaaaaaaaaa", { live: true, agentId: "agent-live" });
      const { deps, fleet, order } = makeDeps(
        { isArmed: () => true, readBoard: () => ({ boardReadable: false, readyBacklog: [] }) },
        store,
      );
      fleet.add("agent-live");
      await sweepBacklogAutoscaler(deps);
      expect(store.has("sparkle-a")).toBe(true);
      expect(order.filter((o) => o.startsWith("release:"))).toEqual([]);
    });

    it("an UNBOUND claim is left alone — not renewed, so it expires, and not released either", async () => {
      // The ambiguous state: a claim with no agent recorded means the spawn threw and we cannot
      // prove whether an agent exists. Renewing would park the bead forever; releasing would
      // double-book an agent that may be running. Letting it expire is the only honest answer, and
      // it is bounded.
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      store.seed("sparkle-only", "autoscaler-aaaaaaaaaaaaaaaa", { live: true, agentId: null });
      const { deps, spawn, order } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 0, limit: 8 }),
        },
        store,
      );
      await sweepBacklogAutoscaler(deps);
      expect(order.filter((o) => o.startsWith("release:"))).toEqual([]);
      expect(order.filter((o) => o.startsWith("heartbeat:"))).toEqual([]);
      expect(spawn, "and it still binds the bead this pass").not.toHaveBeenCalled();
    });

    it("never touches a PEER's claim, live or dead", async () => {
      const store = fakeClaimStore();
      store.seed("sparkle-peer", "autoscaler-bbbbbbbbbbbbbbbb", { live: false, agentId: "agent-x" });
      const { deps, order } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: [] }),
          readCapacity: () => capacity({ used: 0, limit: 8 }),
        },
        store,
      );
      await sweepBacklogAutoscaler(deps);
      expect(order.filter((o) => o.includes("sparkle-peer"))).toEqual([]);
      expect(store.has("sparkle-peer")).toBe(true);
    });
  });

  describe("A CLAIM NAMING A LIVE AGENT IS STAFFED, whatever its standing says", () => {
    // THE STANDING CAN GO STALE WHILE THE AGENT IS STILL RUNNING, and reading standing alone then
    // re-staffs a bead that already has an agent on it — the exact duplicate this phase exists to
    // prevent. Three ordinary paths produce it with the process alive and its agent rows intact:
    //   * the machine SLEEPS — `setInterval` does not fire across system sleep, so a closed lid
    //     overnight stales every claim at once while every agent row survives;
    //   * a human DISARMS and re-arms half an hour later — reconciliation sits below the arming
    //     gate, so a disarmed window renews nothing;
    //   * project ownership MOVES between windows — `ownsProject()` ends the pass before reconcile.

    it("recovers our OWN stale claim by renewing it, and does not spawn a second agent", async () => {
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      store.seed("sparkle-only", "autoscaler-aaaaaaaaaaaaaaaa", {
        live: false,
        agentId: "agent-still-running",
      });
      const { deps, spawn, fleet, running, order } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 1, limit: 8 }),
        },
        store,
      );
      fleet.add("agent-still-running");
      running.add("agent-still-running");
      await sweepBacklogAutoscaler(deps);
      expect(spawn, "the bead already has a running agent").not.toHaveBeenCalled();
      expect(order).toContain("heartbeat:sparkle-only:agent-still-running");
      // AND IT IS ACTUALLY RECOVERED — a heartbeat that left it stale would repeat this every pass
      // and, on any pass where the agent row blinked, hand the bead over.
      expect(store.isLive("sparkle-only")).toBe(true);
    });

    it("does not re-staff a PEER's stale claim whose agent is still running either", async () => {
      // Reconciliation deliberately never touches a peer's claim, so the SELECTION filter is the
      // only thing standing between a sleeping peer window and a duplicate agent.
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      store.seed("sparkle-only", "autoscaler-bbbbbbbbbbbbbbbb", {
        live: false,
        agentId: "agent-peers",
      });
      const { deps, spawn, fleet, order } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 1, limit: 8 }),
        },
        store,
      );
      fleet.add("agent-peers");
      await sweepBacklogAutoscaler(deps);
      expect(spawn).not.toHaveBeenCalled();
      expect(order.filter((o) => o.includes("sparkle-only")), "a peer's claim is untouched").toEqual([]);
    });

    it("a RESURRECTED agent we can SEE running holds its bead, even on a dead-epoch claim", async () => {
      // THE CASE WHERE PROCESS LIVENESS IS DECISIVE and every other signal points the wrong way:
      // the claim is dead-epoch (its launch really is gone) and the row+standing rule would call the
      // bead free — but `resurrectionRunner` has brought the agent back under the same row id and
      // this window can see the process. Spawning here is the duplicate, and only the process
      // reading prevents it.
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      store.seed("sparkle-only", "autoscaler-previouslaunchxx", {
        standing: "dead-epoch",
        agentId: "agent-resurrected",
      });
      const { deps, spawn, fleet, running, order } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 1, limit: 8 }),
        },
        store,
      );
      fleet.add("agent-resurrected");
      running.add("agent-resurrected");
      await sweepBacklogAutoscaler(deps);
      expect(spawn, "a running agent holds its bead whatever the claim says").not.toHaveBeenCalled();
      // No adoption either: an agent we can see running needs none — its own window is renewing it.
      expect(order.filter((o) => o.startsWith("adopt:"))).toEqual([]);
    });

    it("NO FIGHT WITH THE RESURRECTOR — a dead agent it is about to revive keeps its bead", async () => {
      // THE THIRD READER OF ONE SIGNAL. `engine/resurrection.decideResurrection`'s third gate is
      // `if (input.processAlive !== false) return "already-live"`, so `processAlive === false` is not
      // merely compatible with revival — it IS revival's input domain, and the mounted-and-exited
      // route is the common case. Revival is `claude --resume` in the agent's existing worktree
      // under the SAME row id, i.e. it continues the SAME bead.
      //
      // So releasing on a witnessed exit hands the bead to a second agent while the app's own
      // machinery is resuming the first: two worktrees, two branches, one bead.
      // `resurrectionRunner.noFight.test.ts` keeps that runner and `apiRecoveryRunner` disjoint on
      // this same signal; this is the same discipline for the autoscaler.
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      store.seed("sparkle-only", "autoscaler-aaaaaaaaaaaaaaaa", { live: true, agentId: "agent-A" });
      const { deps, spawn, fleet, exited, resurrecting, order } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 1, limit: 8 }),
        },
        store,
      );
      fleet.add("agent-A");
      exited.add("agent-A"); // its PTY died of a resurrectable cause
      resurrecting.add("agent-A"); // ...and the sweep has it DUE
      await sweepBacklogAutoscaler(deps);
      expect(spawn, "the resurrector is bringing this agent back to this bead").not.toHaveBeenCalled();
      expect(order.filter((o) => o.startsWith("release:"))).toEqual([]);
      // ...and the claim is RENEWED, so it is still held when the agent comes back to it.
      expect(order).toContain("heartbeat:sparkle-only:agent-A");
    });

    it("THE HOLD IS BOUNDED — a bead is not held forever on a resurrection that never lands", async () => {
      // THE DIRECTION EVERY PREVIOUS ROUND OF THIS PREDICATE GOT WRONG, and the reason the bound
      // exists at all: "pending" does not expire on its own. `resurrectionRunner` deliberately
      // leaves the ledger record alone when it REFUSES an agent — a retire is durable, and refused
      // agents "stay due" — so an agent that is permanently unfit (no project row), in an abandoned
      // cohort, or blocked by the mounted-pane ceiling stays pending for the life of the run. Held
      // unconditionally, its bead is renewed forever and worked by nobody.
      //
      // So the hold is a WINDOW. Inside it no duplicate can be spawned; at the edge the bead goes
      // back to the backlog, which makes the correctness of `resurrectionPending` non-critical in
      // the direction that parks work.
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      store.seed("sparkle-only", "autoscaler-aaaaaaaaaaaaaaaa", { live: true, agentId: "agent-A" });
      let clock = 1_000;
      const { deps, spawn, fleet, exited, resurrecting, order, setHoldMs } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 0, limit: 8 }),
          now: () => clock,
        },
        store,
      );
      setHoldMs(10 * 60 * 1000);
      fleet.add("agent-A");
      exited.add("agent-A");
      resurrecting.add("agent-A"); // ...and it stays "pending" forever, as a refused agent does

      // INSIDE the window: held, renewed, nothing spawned — across several passes, because a hold
      // that only worked on the first pass would look identical here without the loop.
      for (const t of [1_000, 60_000, 300_000]) {
        clock = t;
        await sweepBacklogAutoscaler(deps);
      }
      expect(spawn, "held while the window is open").not.toHaveBeenCalled();
      expect(order.filter((o) => o.startsWith("release:"))).toEqual([]);

      // AT the bound: released and re-staffed. Ties go to the backlog here, the opposite of the
      // claim store's rule, because this is a ceiling on how long work may sit unworked.
      clock = 1_000 + 10 * 60 * 1000;
      await sweepBacklogAutoscaler(deps);
      expect(order).toContain("release:sparkle-only");
      expect(spawnedIds(spawn)).toEqual(["sparkle-only"]);
    });

    it("a REVIVED agent that dies again gets a FRESH hold window", async () => {
      // Without clearing the window on a live reading, an agent that died at t=0, was revived, and
      // died again at t=40min would inherit the first window and be released almost at once — the
      // bead taken off a resurrection that had just succeeded.
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      store.seed("sparkle-only", "autoscaler-aaaaaaaaaaaaaaaa", { live: true, agentId: "agent-A" });
      let clock = 0;
      const { deps, spawn, fleet, running, exited, resurrecting, setHoldMs } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 0, limit: 8 }),
          now: () => clock,
        },
        store,
      );
      setHoldMs(10 * 60 * 1000);
      fleet.add("agent-A");
      exited.add("agent-A");
      resurrecting.add("agent-A");
      await sweepBacklogAutoscaler(deps); // window opens at 0

      // Revived: alive again, which must CLOSE the window.
      clock = 5 * 60 * 1000;
      exited.delete("agent-A");
      running.add("agent-A");
      await sweepBacklogAutoscaler(deps);

      // Dies again at 12 minutes — PAST the 10-minute bound measured from the FIRST death, so a
      // stale window releases the bead here and a fresh one holds it. The gap has to straddle the
      // bound or the case proves nothing: at 9 minutes both readings still hold, which is how this
      // test first passed against a mutant that removed the reset entirely.
      clock = 12 * 60 * 1000;
      running.delete("agent-A");
      exited.add("agent-A");
      await sweepBacklogAutoscaler(deps);
      expect(spawn, "a fresh window starts here, not an expired one").not.toHaveBeenCalled();
    });

    it("a PEER's revived-then-redead agent also gets a fresh window", async () => {
      // The selection filter is the ONLY reader that sees a peer's claims — reconciliation skips
      // them by design — so without a reset there, a peer's second death inherits the first
      // window and its bead is taken while a resurrection is in flight.
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      store.seed("sparkle-only", "autoscaler-bbbbbbbbbbbbbbbb", { live: false, agentId: "agent-P" });
      let clock = 0;
      const { deps, spawn, fleet, running, exited, resurrecting, setHoldMs } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 0, limit: 8 }),
          now: () => clock,
        },
        store,
      );
      setHoldMs(10 * 60 * 1000);
      fleet.add("agent-P");
      exited.add("agent-P");
      resurrecting.add("agent-P");
      await sweepBacklogAutoscaler(deps); // window opens at 0
      clock = 5 * 60 * 1000;
      exited.delete("agent-P");
      running.add("agent-P"); // revived
      await sweepBacklogAutoscaler(deps);
      clock = 12 * 60 * 1000; // dies again PAST the original bound
      running.delete("agent-P");
      exited.add("agent-P");
      await sweepBacklogAutoscaler(deps);
      expect(spawn, "a fresh window, not an expired one").not.toHaveBeenCalled();
    });

    it("...but once resurrection has GIVEN UP on it, the bead is freed", async () => {
      // The other direction, and without it the clause is a permanent park: an agent nothing will
      // revive must not hold its bead forever.
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      store.seed("sparkle-only", "autoscaler-aaaaaaaaaaaaaaaa", { live: true, agentId: "agent-A" });
      const { deps, spawn, fleet, exited, order } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 0, limit: 8 }),
        },
        store,
      );
      fleet.add("agent-A");
      exited.add("agent-A");
      // NOT in `resurrecting` — never eligible, or the sweep has abandoned it.
      await sweepBacklogAutoscaler(deps);
      expect(order).toContain("release:sparkle-only");
      expect(spawnedIds(spawn)).toEqual(["sparkle-only"]);
    });

    it("selection and reconciliation read the resurrection signal the SAME way", async () => {
      // The two use one condition on purpose. If only reconciliation consulted it, the claim would
      // be renewed while selection still saw the bead as free — held and re-staffed in one pass.
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      // A PEER's claim, so reconciliation never touches it and ONLY the selection filter can hold
      // the bead.
      store.seed("sparkle-only", "autoscaler-bbbbbbbbbbbbbbbb", { live: false, agentId: "agent-B" });
      const { deps, spawn, fleet, exited, resurrecting } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 1, limit: 8 }),
        },
        store,
      );
      fleet.add("agent-B");
      exited.add("agent-B");
      resurrecting.add("agent-B");
      await sweepBacklogAutoscaler(deps);
      expect(spawn).not.toHaveBeenCalled();
    });

    it("an agent we watched EXIT frees its bead, even though its ROW is still there", async () => {
      // The mirror, and the direction the row list cannot see. The claim is `dead-stale` — a peer
      // that stopped checking in — and its agent row still exists, so the row+standing rule would
      // call the bead staffed and hold it. But we watched the process EXIT, which is the strongest
      // unstaffed evidence there is; without that reading the bead sits behind a dead agent until
      // the claim expires.
      //
      // Note what is deliberately NOT overridden: a claim still standing `live` holds its bead even
      // when we saw its agent go, because a peer asserted seconds ago that it is on this work and
      // its own reconciliation is what releases it. Overriding a live peer on our own reading is how
      // two windows start fighting over one bead.
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      store.seed("sparkle-only", "autoscaler-bbbbbbbbbbbbbbbb", {
        live: false,
        agentId: "agent-died",
      });
      const { deps, spawn, fleet, exited } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 0, limit: 8 }),
        },
        store,
      );
      fleet.add("agent-died");
      exited.add("agent-died");
      await sweepBacklogAutoscaler(deps);
      expect(spawnedIds(spawn)).toEqual(["sparkle-only"]);
    });

    it("a DEAD-EPOCH claim whose agent might be RESURRECTED is adopted, not re-staffed", async () => {
      // THE AMBIGUOUS CASE, and the reason it is not decided by the row list. `resurrectionRunner`
      // revives an agent whose death cause is app-restart under the SAME row id, so after a restart
      // the previous launch's ids are all still in the row list — some ghosts, some genuinely
      // running again — and the claim stays `dead-epoch` forever, because reconciliation skips
      // foreign claims and nothing heartbeats it.
      //
      // Spawning there duplicates every resurrected agent at once. Parking there holds the bead for
      // as long as the store keeps the claim. Adoption refuses both: the claim becomes OURS this
      // pass with nothing spawned, and from the next pass the ordinary rules govern it.
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      store.seed("sparkle-only", "autoscaler-previouslaunchxx", {
        standing: "dead-epoch",
        agentId: "agent-from-the-old-launch",
      });
      const { deps, spawn, fleet, order } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 0, limit: 8 }),
        },
        store,
      );
      // The row survived the restart; this window cannot see whether a process is behind it.
      fleet.add("agent-from-the-old-launch");
      await sweepBacklogAutoscaler(deps);
      expect(spawn, "no second agent onto a possibly-resurrected one").not.toHaveBeenCalled();
      expect(order).toContain("adopt:sparkle-only:agent-from-the-old-launch");
      expect(store.isLive("sparkle-only")).toBe(true);
    });

    it("...and once the ghost ROW goes away the adopted claim is released and the bead re-staffed", async () => {
      // THE BOUNDED END of that ambiguity, and the reason adoption is not just a nicer word for
      // parking. A ghost row does not survive forever — the resurrection runner gives up, or a human
      // closes the pane — and the claim is ours by then, so reconciliation releases it on the very
      // next pass rather than leaving it foreign until the store's 7-day prune.
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      store.seed("sparkle-only", "autoscaler-previouslaunchxx", {
        standing: "dead-epoch",
        agentId: "ghost",
      });
      const { deps, spawn, fleet, order } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 0, limit: 8 }),
        },
        store,
      );
      fleet.add("ghost");
      await sweepBacklogAutoscaler(deps);
      expect(spawn).not.toHaveBeenCalled();
      // The row disappears — nothing was ever running behind it.
      fleet.delete("ghost");
      await sweepBacklogAutoscaler(deps);
      expect(order).toContain("release:sparkle-only");
      expect(spawnedIds(spawn)).toEqual(["sparkle-only"]);
    });

    it("a DEAD-EPOCH claim whose agent PROVABLY EXITED is re-staffed at once", async () => {
      // No ambiguity here, so no adoption: a witnessed exit is the strongest unstaffed evidence
      // there is and it outranks the row's continued existence.
      // THE GHOST-ROW CASE, and it is the reason the clause excludes `dead-epoch` rather than
      // trusting the row list alone.
      //
      // `liveAgentIds` is `localAgentRowIds().used`, which counts ROWS — deliberately, because the
      // `.live` subset excludes a row in a tab nobody has opened this session, which is a statement
      // about panes rather than about whether the agent exists. But rows are rehydrated from the
      // persisted project blob, so after a restart EVERY agent id the previous launch minted is
      // still in `used` while none of those processes survive. `dead-epoch` is the flock-proven
      // "that launch is gone", its claimant id is foreign (the mint is memoized per module
      // instance, so a new launch is a new claimant) and reconciliation skips it by design — so
      // without this exclusion the bead would sit out of selection until the store's 7-day prune.
      // A head-of-line block worse than the duplicate the clause was added to prevent.
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      store.seed("sparkle-only", "autoscaler-previouslaunchxx", {
        standing: "dead-epoch",
        agentId: "agent-that-exited",
      });
      const { deps, spawn, fleet, exited } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 0, limit: 8 }),
        },
        store,
      );
      fleet.add("agent-that-exited");
      exited.add("agent-that-exited");
      await sweepBacklogAutoscaler(deps);
      expect(spawnedIds(spawn)).toEqual(["sparkle-only"]);
    });

    it("ten passes after a restart re-staff the old launch's whole board, not none of it", async () => {
      // The population version of the case above: every bead the previous launch held, all at once,
      // which is what an ordinary app restart actually looks like.
      const store = fakeClaimStore();
      const board = backlogOf(3);
      for (const b of board) {
        store.seed(b.id, "autoscaler-previouslaunchxx", {
          standing: "dead-epoch",
          agentId: `ghost-for-${b.id}`,
        });
      }
      let used = 0;
      const { deps, spawn, fleet, exited } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: board }),
          readCapacity: () => capacity({ used, limit: 20 }),
        },
        store,
      );
      for (const b of board) {
        fleet.add(`ghost-for-${b.id}`);
        // Witnessed EXITS: this is the restart-storm case where nothing came back, which is the one
        // the loop must re-staff rather than adopt.
        exited.add(`ghost-for-${b.id}`);
      }
      const realSpawn = deps.spawn;
      deps.spawn = (b) => {
        used += 1;
        return realSpawn(b);
      };
      for (let pass = 0; pass < 10; pass += 1) await sweepBacklogAutoscaler(deps);
      const ids = spawnedIds(spawn);
      expect(ids, "every bead the dead launch held is re-staffed").toHaveLength(3);
      expect(new Set(ids).size).toBe(3);
    });

    it("but a stale claim whose agent is GONE is still re-staffed — this is not a licence to park", async () => {
      // The widening direction. A rule that excluded every stale claim would be the head-of-line
      // block again; it is the LIVE AGENT that makes the bead staffed, not the claim's existence.
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      store.seed("sparkle-only", "autoscaler-bbbbbbbbbbbbbbbb", {
        live: false,
        agentId: "agent-that-died",
      });
      const { deps, spawn } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 0, limit: 8 }),
        },
        store,
      );
      await sweepBacklogAutoscaler(deps);
      expect(spawnedIds(spawn)).toEqual(["sparkle-only"]);
    });

    it("ten passes over a sleeping window's stale-but-staffed board start nothing", async () => {
      // Drive it repeatedly over unchanged state: a rule that recovered the claim once and then
      // re-staled it would show up here and nowhere else.
      const store = fakeClaimStore();
      const board = backlogOf(3);
      for (const b of board) {
        store.seed(b.id, "autoscaler-aaaaaaaaaaaaaaaa", { live: false, agentId: `agent-for-${b.id}` });
      }
      const { deps, spawn, fleet } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: board }),
          readCapacity: () => capacity({ used: 3, limit: 20 }),
        },
        store,
      );
      for (const b of board) fleet.add(`agent-for-${b.id}`);
      for (let pass = 0; pass < 10; pass += 1) await sweepBacklogAutoscaler(deps);
      expect(spawn).not.toHaveBeenCalled();
      expect(store.size()).toBe(3);
    });
  });

  describe("SINGLE FLIGHT — two passes of one window must not overlap", () => {
    it("a tick that arrives while a pass is in flight is skipped, and no bead is spawned twice", async () => {
      // Making the pass async removed the serialization the synchronous sweep had for free, and the
      // claim store gives NO protection between two passes of the same window: `acquire_at` grants a
      // re-acquire by the same claimant id (deliberately, and tested on the Rust side), and the
      // candidate sets are per-pass locals. So a second pass reading the listing before the first
      // commits its CAS selects the same bead, is GRANTED it, and spawns a duplicate.
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      let releaseFirstRead: (() => void) | null = null;
      const suspended = new Promise<void>((resolve) => {
        releaseFirstRead = resolve;
      });
      const { deps, spawn } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 0, limit: 8 }),
        },
        store,
      );
      let first = true;
      const realRead = deps.readClaims;
      deps.readClaims = async () => {
        if (first) {
          first = false;
          await suspended;
        }
        return realRead();
      };

      const passA = sweepBacklogAutoscaler(deps);
      // The second tick lands while A is parked inside its claim-store read.
      const passB = await sweepBacklogAutoscaler(deps);
      expect(passB, "a skipped pass reports nothing").toBeNull();
      releaseFirstRead!();
      await passA;

      expect(spawnedIds(spawn), "exactly one agent on the one ready bead").toEqual(["sparkle-only"]);
    });

    it("the latch is released even when the pass THROWS — a wedged latch is permanent idleness", async () => {
      // Every other guard in this file fails closed. This one must fail OPEN: a latch that is never
      // released stops the loop for the life of the window, which is the failure this epic keeps
      // rediscovering.
      const store = fakeClaimStore();
      const { deps, spawn } = makeDeps(
        {
          isArmed: () => true,
          readCapacity: () => capacity({ used: 0, limit: 20 }),
        },
        store,
      );
      const realRead = deps.readClaims;
      deps.readClaims = () => Promise.reject(new Error("store exploded"));
      await expect(sweepBacklogAutoscaler(deps)).rejects.toThrow(/exploded/);
      deps.readClaims = realRead;
      const after = await sweepBacklogAutoscaler(deps);
      expect(after, "the very next pass must run").not.toBeNull();
      expect(spawnedIds(spawn).length).toBeGreaterThan(0);
    });
  });

  describe("a refused spawn gives the claim back; a thrown one does not", () => {
    it("RELEASES the claim when the spawn was REFUSED, and the next pass retries that bead", async () => {
      // A refusal PROVES nothing was created, and every one of its causes clears on its own (at
      // capacity now, a project not opened YET). Keeping the claim would retire real work on a
      // transient condition.
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      let refuse = true;
      const { deps, spawn } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 0, limit: 8 }),
          spawn: (b) => {
            if (refuse) return { outcome: "refused" };
            return { outcome: "spawned", agentId: `agent-for-${b.id}` };
          },
        },
        store,
      );
      await sweepBacklogAutoscaler(deps);
      expect(spawn).not.toHaveBeenCalled(); // the injected spawn replaced the default one
      expect(store.has("sparkle-only"), "a refusal must not leave the bead claimed").toBe(false);
      refuse = false;
      await sweepBacklogAutoscaler(deps);
      expect(store.has("sparkle-only")).toBe(true);
      expect(store.agentOf("sparkle-only")).toBe("agent-for-sparkle-only");
    });

    it("KEEPS the claim when the spawn THREW — an ambiguous write may have created an agent", async () => {
      const store = fakeClaimStore();
      const one = [bead("sparkle-only", 1)];
      const { deps } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: one }),
          readCapacity: () => capacity({ used: 0, limit: 8 }),
          spawn: () => {
            throw new Error("the call did real work before it failed");
          },
        },
        store,
      );
      await expect(sweepBacklogAutoscaler(deps)).rejects.toThrow(/real work/);
      expect(store.has("sparkle-only"), "the claim must survive an ambiguous spawn").toBe(true);
      // ...and it is UNBOUND, which is what makes it expire rather than park the bead forever.
      expect(store.agentOf("sparkle-only")).toBeNull();
    });
  });

  // ── PHASE 4 — THE FLOOR ───────────────────────────────────────────────────────────────────────

  describe("the floor", () => {
    it("a floor of ZERO — the shipped value — changes nothing", async () => {
      const { deps, spawn } = makeDeps({
        isArmed: () => true,
        floor: () => 0,
        readCapacity: () => capacity({ used: 0, limit: 20 }),
      });
      const d = await sweepBacklogAutoscaler(deps);
      expect(d?.floor).toBe(0);
      expect(d?.floorDeficit).toBe(0);
      expect(spawnedIds(spawn)).toHaveLength(AUTOSCALE_MAX_SPAWNS_PER_PASS);
    });

    it("a floor above the cap widens ONE pass to the shortfall — on distinct beads", async () => {
      const { deps, spawn } = makeDeps({
        isArmed: () => true,
        floor: () => 5,
        readCapacity: () => capacity({ used: 0, limit: 20 }),
      });
      const d = await sweepBacklogAutoscaler(deps);
      expect(d?.floorDeficit).toBe(5);
      expect(d?.spawnBudget).toBe(5);
      const ids = spawnedIds(spawn);
      expect(ids).toHaveLength(5);
      expect(new Set(ids).size, "a burst must still name distinct beads").toBe(5);
    });

    it("is HELD across repeated passes: it fills to the floor, then reverts to the ordinary cap", async () => {
      // The "drive it twice over unchanged inputs" rule, applied to the floor. A floor that
      // re-spawned every pass would run away; one that only ever fired on the first pass would not
      // be a floor at all. Capacity tracks the spawns, as production's does.
      const board = backlogOf(30);
      let used = 0;
      const store = fakeClaimStore();
      const { deps, spawn } = makeDeps(
        {
          isArmed: () => true,
          floor: () => 5,
          readBoard: () => ({ boardReadable: true, readyBacklog: board }),
          readCapacity: () => capacity({ used, limit: 30 }),
        },
        store,
      );
      const realSpawn = deps.spawn;
      deps.spawn = (b) => {
        used += 1;
        return realSpawn(b);
      };
      const first = await sweepBacklogAutoscaler(deps);
      expect(first?.spawnBudget).toBe(5);
      expect(spawnedIds(spawn)).toHaveLength(5);
      // SECOND PASS, SAME BOARD: the floor is met, so the budget falls back to the ordinary cap.
      const second = await sweepBacklogAutoscaler(deps);
      expect(second?.floorDeficit).toBe(0);
      expect(second?.spawnBudget).toBe(AUTOSCALE_MAX_SPAWNS_PER_PASS);
      expect(spawnedIds(spawn)).toHaveLength(5 + AUTOSCALE_MAX_SPAWNS_PER_PASS);
      // AND IT COMES BACK when the fleet drains below the floor again.
      used = 1;
      const third = await sweepBacklogAutoscaler(deps);
      expect(third?.floorDeficit).toBe(4);
      expect(third?.spawnBudget).toBe(4);
    });

    it("never exceeds min(free capacity, ready backlog) — the ceiling still binds", async () => {
      const { deps, spawn } = makeDeps({
        isArmed: () => true,
        floor: () => 50,
        readBoard: () => ({ boardReadable: true, readyBacklog: backlogOf(30) }),
        readCapacity: () => capacity({ used: 6, limit: 8 }),
      });
      const d = await sweepBacklogAutoscaler(deps);
      expect(d?.target).toBe(2);
      expect(d?.spawnBudget).toBe(2);
      expect(spawnedIds(spawn)).toHaveLength(2);
    });

    it("is SILENT on an empty ready column — never idle means never idle while there is work", async () => {
      const { deps, spawn } = makeDeps({
        isArmed: () => true,
        floor: () => 5,
        readBoard: () => ({ boardReadable: true, readyBacklog: [] }),
        readCapacity: () => capacity({ used: 0, limit: 20 }),
      });
      const d = await sweepBacklogAutoscaler(deps);
      expect(d?.floorDeficit).toBe(0);
      expect(d?.spawnBudget).toBe(0);
      expect(spawn).not.toHaveBeenCalled();
    });

    it("a floor NEVER arms anything", async () => {
      // The independence, asserted at the sweep. If a floor could imply arming, setting one would
      // be an undocumented way to turn a spawner on.
      const { deps, spawn, order } = makeDeps({
        isArmed: () => false,
        floor: () => 12,
        readCapacity: () => capacity({ used: 0, limit: 20 }),
      });
      await sweepBacklogAutoscaler(deps);
      expect(spawn).not.toHaveBeenCalled();
      expect(order).toEqual([]);
    });
  });

  // ── PHASE 4 — BACKPRESSURE ────────────────────────────────────────────────────────────────────

  describe("backpressure", () => {
    const sampleAt = (level: "normal" | "warn" | "critical"): ConcurrencyAdmission => ({
      effective: 20,
      static_max: 20,
      static_bound: "cpu",
      bound: "cpu",
      basis: "CPU-bound",
      sampled: true,
      sample: {
        total_bytes: 64,
        available_bytes: 8,
        compressed_bytes: 0,
        swap_used_bytes: 0,
        level,
      },
    });

    it("HOLD starts nothing, even with a huge backlog, free slots and a floor set", async () => {
      const { deps, spawn, journal } = makeDeps({
        isArmed: () => true,
        floor: () => 10,
        readCapacity: () => capacity({ used: 0, limit: 20 }),
        readMemoryAdmission: () => sampleAt("critical"),
      });
      const d = await sweepBacklogAutoscaler(deps);
      expect(d?.backpressure).toBe("hold");
      expect(d?.target, "the arithmetic is unchanged — only the policy refuses").toBe(10);
      expect(d?.spawnBudget).toBe(0);
      expect(spawn).not.toHaveBeenCalled();
      expect(journal).not.toHaveBeenCalled();
    });

    it("THROTTLE keeps making progress at ONE per pass — it is not a stop", async () => {
      const { deps, spawn } = makeDeps({
        isArmed: () => true,
        floor: () => 10,
        readCapacity: () => capacity({ used: 0, limit: 20 }),
        readMemoryAdmission: () => sampleAt("warn"),
      });
      const d = await sweepBacklogAutoscaler(deps);
      expect(d?.backpressure).toBe("throttle");
      expect(d?.spawnBudget).toBe(AUTOSCALE_THROTTLED_SPAWNS_PER_PASS);
      expect(spawnedIds(spawn)).toHaveLength(1);
    });

    it("a NORMAL sample does not push back", async () => {
      const { deps, spawn } = makeDeps({
        isArmed: () => true,
        readCapacity: () => capacity({ used: 0, limit: 20 }),
        readMemoryAdmission: () => sampleAt("normal"),
      });
      const d = await sweepBacklogAutoscaler(deps);
      expect(d?.backpressure).toBe("none");
      expect(spawnedIds(spawn)).toHaveLength(AUTOSCALE_MAX_SPAWNS_PER_PASS);
    });

    it("a machine that RECOVERS starts spawning again — a hold is not a latch", async () => {
      // Ten passes: five held, five clear. A hold implemented as a latch would leave the fleet
      // stopped for the rest of the window, which is the permanent-idleness failure again.
      let level: "normal" | "critical" = "critical";
      let used = 0;
      const store = fakeClaimStore();
      const { deps, spawn } = makeDeps(
        {
          isArmed: () => true,
          readBoard: () => ({ boardReadable: true, readyBacklog: backlogOf(30) }),
          readCapacity: () => capacity({ used, limit: 30 }),
          readMemoryAdmission: () => sampleAt(level),
        },
        store,
      );
      const realSpawn = deps.spawn;
      deps.spawn = (b) => {
        used += 1;
        return realSpawn(b);
      };
      for (let i = 0; i < 5; i += 1) await sweepBacklogAutoscaler(deps);
      expect(spawn, "nothing may start while the machine is critical").not.toHaveBeenCalled();
      level = "normal";
      for (let i = 0; i < 5; i += 1) await sweepBacklogAutoscaler(deps);
      const ids = spawnedIds(spawn);
      expect(ids.length).toBe(5 * AUTOSCALE_MAX_SPAWNS_PER_PASS);
      expect(new Set(ids).size, "and still on distinct beads").toBe(ids.length);
    });
  });
});
