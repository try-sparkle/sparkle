// The arithmetic is the deliverable, so every case here asserts the COMPUTED TARGET — not that
// `decideAutoscale` ran, not that some object came back. A test that only pinned the shape would be
// green against a function that returned `freeSlots` and ignored the backlog entirely.
import { describe, it, expect, vi } from "vitest";
import type { Bead } from "./beads";
import type { CapacityReading } from "./agentCapacity";
import {
  decideAutoscale,
  sweepBacklogAutoscaler,
  shouldReportAutoscale,
  autoscaleFingerprint,
  lastAutoscaleDecision,
  _resetBacklogAutoscalerForTests,
  AUTOSCALE_POPULATION,
  AUTOSCALE_REPORT_HEARTBEAT_MS,
  type AutoscaleDecision,
  type BacklogAutoscalerDeps,
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
    const unreadable = decideAutoscale({ boardReadable: false, readyBacklog: [], capacity: cap });
    const drained = decideAutoscale({ boardReadable: true, readyBacklog: [], capacity: cap });
    // Same machine, same slots — the ONLY difference is whether the board answered, and that has
    // to survive into the output or a consumer cannot tell "no work" from "no idea".
    expect(unreadable.target).toBeNull();
    expect(drained.target).toBe(0);
    expect(unreadable.reason).not.toBe(drained.reason);
  });

  it("says in words that no target is not a target of zero", () => {
    const d = decideAutoscale({ boardReadable: false, readyBacklog: [], capacity: capacity() });
    expect(d.summary).toMatch(/not the same as a target of zero/i);
  });
});

describe("decideAutoscale — reported context", () => {
  it("names the next bead with the EXISTING priority ordering, P0 before P1", () => {
    const d = decideAutoscale({
      boardReadable: true,
      readyBacklog: [bead("", 1), bead("", 0), bead("")],
      capacity: capacity({ used: 0, limit: 4 }),
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
    });
    expect(d.ceiling).toBe(6);
    expect(d.current).toBe(3);
    expect(d.basis).toBe("RAM-bound: 16 GiB installed − 6 GiB reserved");
    expect(d.population).toBe(AUTOSCALE_POPULATION);
    expect(d.summary).toContain("RAM-bound: 16 GiB installed − 6 GiB reserved");
    expect(d.summary).toContain(AUTOSCALE_POPULATION);
  });

  it("says plainly that nothing was started", () => {
    const d = decideAutoscale({
      boardReadable: true,
      readyBacklog: backlogOf(5),
      capacity: capacity({ used: 0, limit: 4 }),
    });
    expect(d.target).toBe(4);
    expect(d.summary).toMatch(/NOTHING WAS STARTED/);
  });

  it("does not mutate the caller's snapshot array", () => {
    const backlog = [bead("", 1), bead("", 0)];
    decideAutoscale({ boardReadable: true, readyBacklog: backlog, capacity: capacity() });
    expect(backlog.map((b) => b.id)).toEqual(["", ""]);
  });
});

describe("shouldReportAutoscale", () => {
  const decision = (over: Partial<AutoscaleDecision> = {}): AutoscaleDecision => ({
    ...decideAutoscale({ boardReadable: true, readyBacklog: backlogOf(3), capacity: capacity() }),
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
    });
    const prev = { fingerprint: autoscaleFingerprint(before), at: 1_000 };
    expect(shouldReportAutoscale(prev, after, 1_001)).toBe(true);
  });
});

describe("sweepBacklogAutoscaler", () => {
  function makeDeps(over: Partial<BacklogAutoscalerDeps> = {}) {
    const report = vi.fn();
    const spawn = vi.fn(() => "spawned" as const);
    const journal = vi.fn();
    const deps: BacklogAutoscalerDeps = {
      ownsProject: () => true,
      readBoard: () => ({ boardReadable: true, readyBacklog: backlogOf(10) }),
      readCapacity: () => capacity({ used: 5, limit: 8 }),
      report,
      now: () => 1_000,
      // DISARMED by default, mirroring production: the store ships false and a missing config key
      // reads false. A test that wants the spawning pass opts IN, exactly as a human must.
      isArmed: () => false,
      spawn,
      journal,
      ...over,
    };
    return { deps, report, spawn, journal };
  }

  it("computes the target from the injected board and capacity, and reports it", () => {
    _resetBacklogAutoscalerForTests();
    const { deps, report } = makeDeps();
    const d = sweepBacklogAutoscaler(deps);
    expect(d?.target).toBe(3);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0].target).toBe(3);
    expect(lastAutoscaleDecision()?.target).toBe(3);
  });

  it("does nothing at all in a window that does not own the project", () => {
    _resetBacklogAutoscalerForTests();
    const { deps, report } = makeDeps({ ownsProject: () => false });
    expect(sweepBacklogAutoscaler(deps)).toBeNull();
    expect(report).not.toHaveBeenCalled();
    expect(lastAutoscaleDecision()).toBeNull();
  });

  it("does not re-report an unchanged decision on the next tick", () => {
    _resetBacklogAutoscalerForTests();
    const { deps, report } = makeDeps();
    sweepBacklogAutoscaler(deps);
    sweepBacklogAutoscaler(deps);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("reports again as soon as the decision changes", () => {
    _resetBacklogAutoscalerForTests();
    let used = 5;
    const { deps, report } = makeDeps({ readCapacity: () => capacity({ used, limit: 8 }) });
    sweepBacklogAutoscaler(deps);
    used = 6;
    const second = sweepBacklogAutoscaler(deps);
    expect(second?.target).toBe(2);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[1]?.[0].target).toBe(2);
  });

  it("carries an unreadable board through the sweep as no target", () => {
    _resetBacklogAutoscalerForTests();
    const { deps, report } = makeDeps({
      readBoard: () => ({ boardReadable: false, readyBacklog: [] }),
    });
    const d = sweepBacklogAutoscaler(deps);
    expect(d?.target).toBeNull();
    expect(report.mock.calls[0]?.[0].reason).toBe("board-unreadable");
  });

  // ── PHASE-2: THE WRITER EXISTS NOW, SO THE RATCHET MOVES FROM "NONE" TO "NOT WHILE DISARMED" ─────
  //
  // Phase 1's ratchet read this module's SOURCE and asserted it called and imported nothing that could
  // write. That was the right guard while no writer existed, and Phase 2 necessarily deletes it — the
  // deletion being a reviewable act was the whole point of writing it that way.
  //
  // What replaces it is strictly stronger, because it is BEHAVIOURAL rather than textual: a source
  // scan can only see the calls it thought to pattern-match, while these drive the real
  // `sweepBacklogAutoscaler` and assert the SIDE EFFECT. AGENTS.md: DEPLOYING A HOOK IS RUNNING IT —
  // this loop already ticks every 60s in every mounted window, so "merged but not yet armed" is the
  // state it will spend almost all of its life in, and that state must be indistinguishable from
  // Phase 1.
  describe("backlogAutoscaler spawns NOTHING until a human arms it", () => {
    it("computes and reports exactly as Phase 1 did, and calls no spawn, while DISARMED", () => {
      _resetBacklogAutoscalerForTests();
      const { deps, report, spawn, journal } = makeDeps(); // isArmed: () => false
      const d = sweepBacklogAutoscaler(deps);

      // Phase 1's behaviour, unchanged: the arithmetic still happens and the line is still logged.
      expect(d?.target).toBe(3);
      expect(report).toHaveBeenCalledTimes(1);
      // ...and NOTHING was started. Both, because a journal entry with no spawn is a readable
      // over-count while a spawn with no journal entry is an agent nobody can account for.
      expect(spawn).not.toHaveBeenCalled();
      expect(journal).not.toHaveBeenCalled();
    });

    it("still spawns nothing while disarmed even with a full backlog and every slot free", () => {
      // The paired case: the first could pass for a implementation that never spawns under ANY
      // condition, which is also what a broken Phase 2 looks like. This one maximises every input the
      // spawning branch reads, so only the arming flag can be what is holding it back.
      _resetBacklogAutoscalerForTests();
      const { deps, spawn } = makeDeps({
        readCapacity: () => capacity({ used: 0, limit: 8 }),
      });
      const d = sweepBacklogAutoscaler(deps);
      expect(d?.target).toBe(8);
      expect(d?.nextBead).not.toBeNull();
      expect(spawn).not.toHaveBeenCalled();
    });

    it("ARMED, it starts work on the selected bead and journals BEFORE the attempt", () => {
      _resetBacklogAutoscalerForTests();
      const order: string[] = [];
      const spawn = vi.fn((): "spawned" => {
      order.push("spawn");
      return "spawned";
    });
      const journal = vi.fn(() => void order.push("journal"));
      const { deps } = makeDeps({ isArmed: () => true, spawn, journal });

      const d = sweepBacklogAutoscaler(deps);

      expect(spawn).toHaveBeenCalledTimes(1);
      expect((spawn.mock.calls[0] as unknown as [{ id: string }])[0].id).toBe(d?.nextBead?.id);
      // The ordering IS the recovery property, not a detail: journalled first, always.
      expect(order).toEqual(["journal", "spawn"]);
    });

    it("ARMED but with an UNREADABLE board, it spawns nothing — unknown is not zero", () => {
      // `target: null` means "we could not read the board", which is a different fact from "there is
      // no work". A spawn issued here is a spawn against an unknown backlog.
      _resetBacklogAutoscalerForTests();
      const { deps, spawn } = makeDeps({
        isArmed: () => true,
        readBoard: () => ({ boardReadable: false, readyBacklog: [] }),
      });
      const d = sweepBacklogAutoscaler(deps);
      expect(d?.target).toBeNull();
      expect(spawn).not.toHaveBeenCalled();
    });

    it("ARMED but at capacity, it spawns nothing", () => {
      _resetBacklogAutoscalerForTests();
      const { deps, spawn } = makeDeps({
        isArmed: () => true,
        readCapacity: () => capacity({ used: 8, limit: 8 }),
      });
      const d = sweepBacklogAutoscaler(deps);
      expect(d?.target).toBe(0);
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  // ── THE STEADY STATE: THE BOARD DOES *NOT* CHANGE BETWEEN TICKS ────────────────────────────────
  //
  // Caught by review (roborev 80524) against the first version of this file, and the miss is worth
  // recording because the tests were what hid it: every multi-tick case below reassigns `board`
  // between sweeps, which is the one shape the real steady state never takes. Nothing in the spawn
  // path marks the bead `in_progress` or writes a claim — `spawnBuildAgentInProject` mints its own
  // `sparkle-auto` telemetry bead and never touches the target — so the bead is still open and
  // unblocked 60 seconds later, and `selectNextReadyBead` is deterministic. An armed loop with free
  // slots therefore started an agent on THE SAME BEAD every minute: 8 agents in 8 minutes, which is
  // exactly the "one unit of work becomes N worktrees doing identical work" outcome
  // `PHASE2_MAX_SPAWNS_PER_PASS`'s own doc says must not happen.
  //
  // The per-pass cap never addressed this. It bounds ONE tick; the duplication is ACROSS ticks.
  describe("does not re-spawn on a bead it already started", () => {
    it("never starts the SAME bead twice, and moves on to the next one", () => {
      // THE PROPERTY IS DE-DUPLICATION, NOT SILENCE. An earlier version of this test asserted "two
      // sweeps produce exactly ONE spawn", which pinned a HEAD-OF-LINE BLOCK as if it were the
      // intent: the guard sat after selection, so once the top bead was started every later tick
      // re-selected it, hit the guard and returned — one agent for the life of the window, against a
      // machine with seven free slots. Caught by review (roborev 80561). The board is deliberately
      // NOT reassigned here, because that is the steady state a spawn does not change.
      _resetBacklogAutoscalerForTests();
      const spawn = vi.fn(() => "spawned" as const);
      const { deps } = makeDeps({
        isArmed: () => true,
        spawn,
        readCapacity: () => capacity({ used: 0, limit: 8 }),
      });

      sweepBacklogAutoscaler(deps);
      sweepBacklogAutoscaler(deps);
      sweepBacklogAutoscaler(deps);

      const picked = spawn.mock.calls.map((c) => (c as unknown as [{ id: string }])[0].id);
      expect(picked).toHaveLength(3);
      expect(new Set(picked).size, "three sweeps, three DIFFERENT beads").toBe(3);
    });

    it("staffs the whole ready column and then stops — it does not idle early, nor loop forever", () => {
      // Both failure directions in one case. Ten ready beads and ample capacity must yield ten
      // distinct spawns (the head-of-line block gave ONE); the eleventh sweep must yield nothing,
      // because every ready bead now has an agent — a real steady state, not an error.
      _resetBacklogAutoscalerForTests();
      const spawn = vi.fn(() => "spawned" as const);
      const { deps } = makeDeps({
        isArmed: () => true,
        spawn,
        readCapacity: () => capacity({ used: 0, limit: 40 }),
        readBoard: () => ({ boardReadable: true, readyBacklog: backlogOf(10) }),
      });

      for (let i = 0; i < 11; i += 1) sweepBacklogAutoscaler(deps);

      const picked = spawn.mock.calls.map((c) => (c as unknown as [{ id: string }])[0].id);
      expect(picked).toHaveLength(10);
      expect(new Set(picked).size, "every spawn on a distinct bead").toBe(10);
    });

    it("RETRIES a bead whose spawn was REFUSED, because nothing was created", () => {
      // `spawnBuildAgentInProject` refuses on four documented paths — no project row, at capacity, a
      // torn-out project, and a project the human has not opened this session — and its contract for
      // all four is that NO AGENT EXISTS. Recording the bead there would retire real work on a
      // transient condition: "at capacity" and "not opened yet" both clear on their own. The likely
      // production FIRST tick is one of those, so getting this wrong leaves the feature inert behind
      // a single warn line (roborev 80561).
      _resetBacklogAutoscalerForTests();
      const spawn = vi.fn(() => "refused" as const);
      const { deps } = makeDeps({
        isArmed: () => true,
        spawn,
        readCapacity: () => capacity({ used: 0, limit: 8 }),
      });

      sweepBacklogAutoscaler(deps);
      sweepBacklogAutoscaler(deps);

      const picked = spawn.mock.calls.map((c) => (c as unknown as [{ id: string }])[0].id);
      expect(picked).toHaveLength(2);
      expect(picked[0], "the SAME bead is tried again, not skipped").toBe(picked[1]);
    });

    it("suppresses the bead even when the spawn THREW — a failed attempt may still have created an agent", () => {
      // The ordering the comment beside `spawnedBeads.add` claims: recorded BEFORE the attempt.
      // `spawnBuildAgentInProject` does real work before it can fail, so a throw does not prove
      // nothing was created — and re-selecting the bead next tick would then double-book it.
      // Over-suppressing costs one bead a human can re-queue; under-suppressing costs a rival
      // worktree on the same work. Without this case the ordering is unpinned and a later edit can
      // silently move the record after the spawn.
      _resetBacklogAutoscalerForTests();
      const spawn = vi.fn((): "spawned" | "refused" => {
        throw new Error("spawn blew up after creating the row");
      });
      const { deps } = makeDeps({
        isArmed: () => true,
        spawn,
        readCapacity: () => capacity({ used: 0, limit: 8 }),
      });

      expect(() => sweepBacklogAutoscaler(deps)).toThrow();
      // The second sweep moves ON rather than retrying: one attempt was already made on that bead,
      // and it may have created an agent. It still throws, because this fixture always throws — the
      // assertion is about WHICH bead is attempted, not about the loop surviving.
      expect(() => sweepBacklogAutoscaler(deps)).toThrow();

      const picked = spawn.mock.calls.map((c) => (c as unknown as [{ id: string }])[0].id);
      expect(picked).toHaveLength(2);
      expect(picked[0], "a THROWN spawn is never retried on the same bead").not.toBe(picked[1]);
    });

    it("but DOES start the next bead once the first leaves the ready column", () => {
      // The paired positive, and it is what stops the fix above from being "never spawn twice".
      // Suppression must be keyed on the BEAD, not on having spawned before.
      _resetBacklogAutoscalerForTests();
      const first = { id: "b-1", title: "first", priority: 0 } as unknown as Bead;
      const second = { id: "b-2", title: "second", priority: 0 } as unknown as Bead;
      let board: Bead[] = [first, second];
      const spawn = vi.fn(() => "spawned" as const);
      const { deps } = makeDeps({
        isArmed: () => true,
        spawn,
        readCapacity: () => capacity({ used: 0, limit: 8 }),
        readBoard: () => ({ boardReadable: true, readyBacklog: board }),
      });

      sweepBacklogAutoscaler(deps); // starts b-1
      sweepBacklogAutoscaler(deps); // b-1 still on the board -> suppressed
      board = [second]; // b-1 closes and leaves the ready column
      sweepBacklogAutoscaler(deps); // starts b-2

      const picked = spawn.mock.calls.map((c) => (c as unknown as [{ id: string }])[0].id);
      expect(picked).toEqual(["b-1", "b-2"]);
    });
  });

  // ── THE EPIC'S OWN ACCEPTANCE CRITERION, WORD FOR WORD ───────────────────────────────────────────
  //
  // `sparkle-n2feho.1`: "a test proves the loop takes the NEXT ITEM AFTER CLOSING ONE".
  //
  // That sentence is why one tick is not enough. A single-tick test proves the loop can start
  // something once, which a hard-coded pick would also satisfy; the claim is about what the loop does
  // on its SECOND pass, once the first item is gone. So this drives two real ticks over a board that
  // changes between them, exactly as the ready column changes when a bead is closed.
  describe("the loop takes the NEXT item after the first is closed", () => {
    it("second tick selects the second bead, and P0s are exhausted before P1s across the pair", () => {
      _resetBacklogAutoscalerForTests();
      // Deliberately out of priority order in the array, so passing requires the SELECTOR to order
      // them rather than the fixture happening to be pre-sorted.
      const p1 = { id: "b-p1", title: "a P1", priority: 1 } as unknown as Bead;
      const first = { id: "b-p0-first", title: "first P0", priority: 0 } as unknown as Bead;
      const second = { id: "b-p0-second", title: "second P0", priority: 0 } as unknown as Bead;

      let board: Bead[] = [p1, first, second];
      const spawn = vi.fn(() => "spawned" as const);
      const { deps } = makeDeps({
        isArmed: () => true,
        spawn,
        readCapacity: () => capacity({ used: 7, limit: 8 }), // one free slot per tick
        readBoard: () => ({ boardReadable: true, readyBacklog: board }),
        // The throttle is keyed on the decision fingerprint and a clock; advance it so the second
        // tick is a genuinely new pass rather than a suppressed duplicate.
        now: () => 1_000,
      });

      sweepBacklogAutoscaler(deps);

      // THE FIRST ITEM IS CLOSED — the real event this models. A closed bead leaves the ready column.
      board = [p1, second];
      sweepBacklogAutoscaler(deps);

      const picked = spawn.mock.calls.map((c) => (c as unknown as [{ id: string }])[0].id);
      expect(picked).toEqual(["b-p0-first", "b-p0-second"]);
      // ...and the P1 was never reached while a P0 remained, which is the other half of the epic's
      // sentence ("P0s are exhausted before P1s").
      expect(picked).not.toContain("b-p1");
    });
  });
});
