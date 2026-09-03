// The arithmetic is the deliverable, so every case here asserts the COMPUTED TARGET — not that
// `decideAutoscale` ran, not that some object came back. A test that only pinned the shape would be
// green against a function that returned `freeSlots` and ignored the backlog entirely.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
    const deps: BacklogAutoscalerDeps = {
      ownsProject: () => true,
      readBoard: () => ({ boardReadable: true, readyBacklog: backlogOf(10) }),
      readCapacity: () => capacity({ used: 5, limit: 8 }),
      report,
      now: () => 1_000,
      ...over,
    };
    return { deps, report };
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
});

// ── PHASE-1 RATCHET: this module must not learn to WRITE ──────────────────────────────────────────
//
// AGENTS.md: DEPLOYING A HOOK IS RUNNING IT. Phase 1 needs no arming marker because it performs no
// write; the moment a write appears, that argument evaporates and the arming gate becomes mandatory.
// So this pins the premise rather than trusting a header comment: a Phase-2 edit that adds a spawn
// has to DELETE this test, which is a reviewable act, instead of quietly landing a writer.
describe("backlogAutoscaler stays read-only", () => {
  const SOURCE = readFileSync(fileURLToPath(new URL("./backlogAutoscaler.ts", import.meta.url)), "utf8");

  /** Code lines only. The header talks ABOUT spawning at length; prose is not a call. */
  const CODE = SOURCE.split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

  it("reads its own source, not an empty string", () => {
    // Anti-vacuity: a scanner that silently read nothing would pass every `not.toMatch` below. Both
    // anchors sit DEEP in the file — one in the pure decision, one in the production wiring — so a
    // truncated or misresolved read cannot forge them.
    expect(CODE).toContain("export function decideAutoscale");
    expect(CODE).toContain("startBacklogAutoscaler");
    expect(CODE.length).toBeGreaterThan(2000);
  });

  it.each([
    ["a Tauri command", /\binvoke\s*[<(]/],
    ["a PTY write", /pty_write/],
    ["a build-agent spawn", /spawnBuildAgent/],
    ["a drain-slot worker", /runDrainSlot/],
    ["an improvement pass", /runImprovementPass/],
    ["a zustand write", /\.setState\s*\(/],
    ["a bd write", /\bbd (create|update|close|comment)\b/],
  ])("calls no %s", (_what, pattern) => {
    expect(CODE).not.toMatch(pattern);
  });

  it("imports nothing that can write", () => {
    const imports = CODE.split("\n").filter((l) => l.startsWith("import "));
    expect(imports.length).toBeGreaterThan(4);
    for (const line of imports) {
      expect(line).not.toMatch(/@tauri-apps\/api/);
      expect(line).not.toMatch(/drainSlotRunner|improvementPass|conciergeTools|peerMessaging/);
    }
  });
});
