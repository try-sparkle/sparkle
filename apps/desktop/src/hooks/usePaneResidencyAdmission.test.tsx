// @vitest-environment jsdom
//
// THE WIRING, NOT THE ARITHMETIC (bead `sparkle-ftapmp`). `paneResidencyAdmission.test.ts` proves
// the decision; this file proves the three things only the hook can get wrong, each of which would
// leave the gate looking correct while doing nothing (or something worse):
//
//   • it reads the REAL memory cache through `agentCapacity.residentAdmissionCeiling`, so a fix that
//     forgot to translate, or wired the wrong number, shows up here rather than in a shim;
//   • it is STICKY — once a pane is admitted it stays admitted while it is in the list, because a
//     `Terminal` unmount KILLS ITS PTY;
//   • it RE-RENDERS when the reading moves, which is the difference between "deferred for a few
//     seconds" and "silently never mounts".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { usePaneResidencyAdmission } from "./usePaneResidencyAdmission";
import { localAgentCapacity, pollMemoryAdmission } from "../services/agentCapacity";
import {
  refreshMemoryAdmission,
  resetMemoryAdmission,
  setMemoryAdmissionClock,
  MEMORY_ADMISSION_POLL_MS,
  MEMORY_ADMISSION_TTL_MS,
  type ConcurrencyAdmission,
} from "../services/memoryAdmission";
import { useSettingsStore } from "../stores/settingsStore";
import { resetMountedPaneCount } from "../services/paneResidencyAdmission";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { markProjectVisited, resetVisitedProjects } from "../services/sessionProjects";

const STATIC_LIMIT = 12;
const NO_PRIORITY: readonly (string | null)[] = [null, null];

/**
 * Make `ids` REAL local build rows in a visited project.
 *
 * Every test below needs this, and the reason is the point (roborev 81145, High): the gate rules
 * only on local `build`/`worker` rows, because a cloud agent runs in a server sandbox and a shell is
 * not a model process — neither consumes the memory being rationed. Ids that name no row are
 * EXEMPT, so a fixture of bare strings against an empty project store measures the exempt path
 * while claiming to measure the gate.
 *
 * `openAgentIds` stays EMPTY by default, so `localAgentCapacity().live` is 0 and the
 * `residentsElsewhere` term contributes nothing unless a test asks for it.
 */
function seedLocalRows(ids: readonly string[], open: readonly string[] = []): void {
  useProjectStore.setState({
    selectedProjectId: "p1",
    projects: [
      {
        id: "p1",
        agents: ids.map((id) => ({ id, kind: "build", runtime: "local" })),
      },
    ],
  } as never);
  markProjectVisited("p1");
  useRuntimeStore.setState({ openAgentIds: [...open] } as never);
}

function admission(over: Partial<ConcurrencyAdmission> = {}): ConcurrencyAdmission {
  return {
    effective: STATIC_LIMIT,
    static_max: STATIC_LIMIT,
    static_bound: "cpu",
    bound: "available",
    basis: "refused: only 2.0 GiB of memory is available right now",
    memory_admitted: STATIC_LIMIT,
    memory_basis: "refused: only 2.0 GiB of memory is available right now",
    sampled: true,
    sample: null,
    ...over,
  };
}

/** Push one reading through the real refresh path. `inUse` is what production sends (`live`); the
 *  ceiling this hook reads is `memory_admitted`, which is already in residents, so the value here
 *  only has to be a plausible resident count. */
async function sample(memoryAdmitted: number, inUse: number): Promise<void> {
  invoke.mockResolvedValue(admission({ effective: memoryAdmitted, memory_admitted: memoryAdmitted }));
  await act(async () => {
    await refreshMemoryAdmission(inUse);
  });
}

let now = 1_000_000;

beforeEach(() => {
  // FAKE TIMERS, because the heartbeat below is the subject of two tests and waiting five real
  // seconds for each is not a test, it is a stall. `shouldAdvanceTime` keeps
  // `@testing-library`'s own async helpers working under them.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  invoke.mockReset();
  resetMemoryAdmission();
  resetVisitedProjects();
  resetMountedPaneCount();
  useProjectStore.setState({ selectedProjectId: null, projects: [] } as never);
  useRuntimeStore.setState({ openAgentIds: [] } as never);
  // The ids every test below hands the hook, as real local rows. A test that needs a different
  // fleet re-seeds.
  seedLocalRows(["a", "b", "c", "d", "e"]);
  now = 1_000_000;
  setMemoryAdmissionClock(() => now);
  useSettingsStore.setState({
    maxConcurrentWorkers: STATIC_LIMIT,
    effectiveMaxConcurrentWorkers: STATIC_LIMIT,
    machineMaxConcurrentWorkers: STATIC_LIMIT,
    concurrencyBasis: "CPU-bound: 6 cores × 2 agents per core",
    concurrencyBound: "cpu",
  } as never);
});

afterEach(() => {
  cleanup();
  resetVisitedProjects();
  resetMountedPaneCount();
  vi.useRealTimers();
  setMemoryAdmissionClock();
  resetMemoryAdmission();
});

describe("usePaneResidencyAdmission", () => {
  it("defers NOTHING on an unmeasured machine", () => {
    const { result } = renderHook(() =>
      usePaneResidencyAdmission(["a", "b", "c", "d", "e"], NO_PRIORITY),
    );
    expect(result.current.deferred).toEqual([]);
    expect(result.current.admitted.size).toBe(5);
  });

  it("defers NOTHING when a reading arrives in which memory did not narrow", async () => {
    // The paired case for the one below, and the property that keeps this gate off healthy machines:
    // a static ceiling is a prediction, not a measurement of residency. Only `memory_admitted`
    // differs between this test and the next.
    await sample(STATIC_LIMIT, 2);
    const { result } = renderHook(() =>
      usePaneResidencyAdmission(["a", "b", "c", "d", "e"], NO_PRIORITY),
    );
    expect(result.current.deferred).toEqual([]);
  });

  it("holds panes back once memory genuinely narrows", async () => {
    await sample(3, 2);
    const { result } = renderHook(() =>
      usePaneResidencyAdmission(["a", "b", "c", "d", "e"], NO_PRIORITY),
    );
    expect(result.current.admitted.size).toBe(3);
    expect(result.current.deferred).toEqual(["d", "e"]);
  });

  it("RELEASES the deferred panes when the next reading grants room — no re-render needed", async () => {
    // THE RECOVERABILITY PROPERTY. A deferral nothing can clear is a hang wearing a gate's clothes,
    // and nothing in the component tree changes when a module-level cache is refreshed — the
    // subscription in `memoryAdmission` is the only thing that can re-render this.
    await sample(2, 2);
    const { result } = renderHook(() =>
      usePaneResidencyAdmission(["a", "b", "c", "d"], NO_PRIORITY),
    );
    expect(result.current.deferred).toEqual(["c", "d"]);

    // The machine recovers. Note the caller does NOTHING: no prop changes, no re-render is forced.
    await sample(STATIC_LIMIT, 2);
    expect(result.current.deferred).toEqual([]);
    expect(result.current.admitted.size).toBe(4);
  });

  it("releases them when the reading merely goes STALE, on an UNCHANGED candidate list", async () => {
    // Expiry is a function of the clock, so nothing notifies at the moment it happens. The first
    // version of this test rerendered with a DIFFERENT id list, which re-ran the memo for a reason
    // unrelated to staleness and hid the defect it was meant to pin (roborev 81141, High): the
    // verdict was memoized on keys that do not move when a reading ages, so an ordinary re-render
    // returned the cached verdict and the panes stayed held. Rerendering with the SAME ids is the
    // only form that pins the property, because it leaves the ceiling as the one thing that moved.
    await sample(2, 2);
    const ids = ["a", "b", "c", "d"];
    const { result, rerender } = renderHook(() => usePaneResidencyAdmission(ids, NO_PRIORITY));
    expect(result.current.deferred).toEqual(["c", "d"]);

    now += MEMORY_ADMISSION_TTL_MS;
    rerender(); // nothing about the caller changed — only the clock
    expect(result.current.deferred).toEqual([]);
  });

  it("RE-ASKS ON ITS OWN while deferring, so a SILENT sampler cannot strand a pane", async () => {
    // THE STARVATION SHAPE, and the worst failure this gate can have (roborev 81141, High). A
    // sampler whose promise neither resolves nor rejects — the one `memoryAdmission` documents as
    // slowest exactly when memory is tight — emits no version bump ever. With no bump and no other
    // render, a deferred pane would never mount however long the reading had been expired: the
    // "silently never mounts" failure the design forbids.
    await sample(2, 2);
    const ids = ["a", "b", "c", "d"];
    const { result } = renderHook(() => usePaneResidencyAdmission(ids, NO_PRIORITY));
    expect(result.current.deferred).toEqual(["c", "d"]);

    // Time passes and NOTHING else happens: no poll, no reply, no rejection, no caller re-render.
    now += MEMORY_ADMISSION_TTL_MS;
    await act(async () => {
      vi.advanceTimersByTime(MEMORY_ADMISSION_POLL_MS + 1);
    });

    expect(result.current.deferred).toEqual([]);
  });

  it("creates NO heartbeat timer while nothing is deferred", async () => {
    // The paired case: the timer must cost nothing on a healthy machine, which is every machine
    // where memory has not narrowed. A pump that ran unconditionally would re-render `Workspace` —
    // the app's top render driver — every five seconds forever.
    await sample(STATIC_LIMIT, 2);
    renderHook(() => usePaneResidencyAdmission(["a", "b", "c"], NO_PRIORITY));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is STICKY — a pane already admitted stays admitted when the ceiling drops", async () => {
    // A `Terminal` unmount KILLS ITS PTY. A gate that re-derived its answer from the budget alone
    // would evict `c` here and destroy that agent's live session to save memory it had already spent.
    await sample(3, 2);
    const { result } = renderHook(() =>
      usePaneResidencyAdmission(["a", "b", "c", "d"], NO_PRIORITY),
    );
    expect([...result.current.admitted].sort()).toEqual(["a", "b", "c"]);

    await sample(1, 3); // the machine tightens hard
    expect([...result.current.admitted].sort()).toEqual(["a", "b", "c"]);
    expect(result.current.deferred).toEqual(["d"]);
  });

  it("does NOT keep an id sticky once it has left the candidate list", async () => {
    // The paired case for stickiness. Without pruning, closing and reopening an agent would let it
    // skip the budget on the way back — and a "close them all, reopen them all" gesture would
    // re-admit the whole fleet past the ceiling.
    await sample(2, 2);
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => usePaneResidencyAdmission(ids, NO_PRIORITY),
      { initialProps: { ids: ["a", "b", "c"] } },
    );
    expect([...result.current.admitted].sort()).toEqual(["a", "b"]);

    rerender({ ids: ["c"] }); // a and b closed; only c remains, and it takes the budget
    expect([...result.current.admitted].sort()).toEqual(["c"]);

    rerender({ ids: ["a", "b", "c"] }); // they come back — c is the sticky one now, not a and b
    expect(result.current.admitted.has("c")).toBe(true);
    expect(result.current.admitted.size).toBe(2);
    expect(result.current.deferred.length).toBe(1);
  });

  it("never defers the pane a stage is SHOWING", async () => {
    await sample(1, 4);
    const { result } = renderHook(() =>
      usePaneResidencyAdmission(["a", "b", "c", "d"], ["d", null]),
    );
    expect(result.current.admitted.has("d")).toBe(true);
    expect(result.current.deferred).not.toContain("d");
  });
});

describe("usePaneResidencyAdmission — the sentence travels with the number", () => {
  it("carries the MEMORY basis in the shape where the ROW ceiling did not narrow", async () => {
    // roborev 81141, High, and the fixture is the point. The banner used to read
    // `localAgentCapacity().basis`, which explains the ROW ceiling and is only replaced by a memory
    // sentence when the ROW comparison narrowed. That is a DIFFERENT condition from the one this
    // gate fires on, and the two come apart in exactly the bead's own shape — so the fixture has to
    // be that shape or the test proves nothing.
    //
    // Ten rows, two of them resident, memory admitting seven: the residents ceiling is a live 7,
    // while the row ceiling is `10 + (7 - 2) = 15`, above the static 12, i.e. NOT narrowed. So
    // `localAgentCapacity().basis` is still the CPU string here and the bar would have read "at the
    // number of agents its memory can hold (CPU-bound: 6 cores × 2 agents per core)".
    useProjectStore.setState({
      selectedProjectId: "p1",
      projects: [
        {
          id: "p1",
          agents: Array.from({ length: 10 }, (_, i) => ({
            id: `row${i}`,
            kind: "build",
            runtime: "local",
          })),
        },
      ],
    } as never);
    markProjectVisited("p1");
    useRuntimeStore.setState({ openAgentIds: ["row0", "row1"] } as never);
    await sample(7, 2);

    // PRECONDITION, not an assumption: the row ceiling really did not narrow, so the CPU string is
    // what the old wiring would have produced.
    expect(localAgentCapacity().basis).toBe("CPU-bound: 6 cores × 2 agents per core");

    const { result } = renderHook(() => usePaneResidencyAdmission(["a", "b", "c", "d"], NO_PRIORITY));
    expect(result.current.basis).toContain("memory");
    expect(result.current.basis).not.toContain("CPU-bound");
  });

  it("is null when there is no ceiling — a causeless bar beats a wrong cause", () => {
    const { result } = renderHook(() => usePaneResidencyAdmission(["a", "b"], NO_PRIORITY));
    expect(result.current.basis).toBeNull();
  });
});

describe("usePaneResidencyAdmission — which rows the gate rules on", () => {
  it("NEVER defers a pane the ceiling does not count — cloud and shell rows are exempt", async () => {
    // roborev 81145, High. `Workspace`'s `live` memo applies no `kind`/`runtime` filter while the
    // ceiling counts local `build`/`worker` only, so an unfiltered gate held cloud and shell panes
    // back for RAM they never take. It was also the ONLY population the gate could defer before the
    // feedback loop was broken — the gate was pointed at exactly the wrong rows.
    useProjectStore.setState({
      selectedProjectId: "p1",
      projects: [
        {
          id: "p1",
          agents: [
            { id: "local1", kind: "build", runtime: "local" },
            { id: "local2", kind: "build", runtime: "local" },
            { id: "cloud1", kind: "build", runtime: "cloud" },
            { id: "shell1", kind: "shell", runtime: "local" },
          ],
        },
      ],
    } as never);
    markProjectVisited("p1");
    useRuntimeStore.setState({ openAgentIds: [] } as never);
    await sample(1, 0); // room for exactly one resident

    const { result } = renderHook(() =>
      usePaneResidencyAdmission(["local1", "local2", "cloud1", "shell1"], NO_PRIORITY),
    );
    // The two non-local panes mount whatever memory says…
    expect(result.current.admitted.has("cloud1")).toBe(true);
    expect(result.current.admitted.has("shell1")).toBe(true);
    expect(result.current.deferred).not.toContain("cloud1");
    expect(result.current.deferred).not.toContain("shell1");
    // …and the gate still bites on the population it is actually rationing.
    expect(result.current.deferred).toEqual(["local2"]);
  });
});

describe("usePaneResidencyAdmission — the deferral survives the poll that follows it", () => {
  // ── THE FEEDBACK LOOP (roborev 81145, High) ─────────────────────────────────────────────────
  //
  // `pollMemoryAdmission` used to send `localAgentCapacity().live` — `openAgentIds ∩ visited` — as
  // Rust's `in_use`, and Rust answers `min(static_max, in_use + available/per_agent, by_level)` with
  // `by_level ∈ {∞, in_use}`, while a reading at or above `static_max` is discarded as "no opinion".
  // So every surviving ceiling was `>= in_use`, and `in_use` counted the very rows the gate was
  // about to defer. Verified exhaustively over the reachable state space: with the candidates
  // restricted to local rows there were ZERO states in which a pane could be deferred.
  //
  // These tests drive the REAL poll path — `pollMemoryAdmission()`, not a hand-seeded
  // `refreshMemoryAdmission(inUse)` — with a backend that answers the way Rust does, as a FUNCTION
  // of the `in_use` it is given. That is what makes them a measurement rather than a fiction, and it
  // is why the second poll is the assertion that matters: under the old wiring the first poll defers
  // and the second one releases, forever, because the fleet reports itself as already resident.

  const STATIC = 9;

  /**
   * Answer the way the machine does, not the way a fixture wishes it would.
   *
   * `sampled_admission` returns `in_use + available_bytes/per_agent`, and on a real machine the
   * available bytes SHRINK as agents become resident — so what is actually constant is the TOTAL
   * the RAM can hold. Modelling a constant HEADROOM instead would describe a machine whose free
   * memory never moves however many agents start, which is a fiction that makes any gate look leaky.
   */
  function respondWithTotalCapacity(total: number): void {
    invoke.mockImplementation((_cmd: string, args: unknown) => {
      const inUse = (args as { inUse: number }).inUse;
      const headroom = Math.max(0, total - inUse);
      const admitted = Math.max(1, Math.min(STATIC, inUse + headroom));
      return Promise.resolve(
        admission({
          effective: admitted,
          memory_admitted: admitted,
          static_max: STATIC,
          basis: `refused: room for ${headroom} more on top of the ${inUse} running`,
          memory_basis: `refused: room for ${headroom} more on top of the ${inUse} running`,
        }),
      );
    });
  }

  beforeEach(() => {
    useSettingsStore.setState({
      maxConcurrentWorkers: STATIC,
      effectiveMaxConcurrentWorkers: STATIC,
      machineMaxConcurrentWorkers: STATIC,
      concurrencyBasis: "CPU-bound: 6 cores × 2 agents per core",
      concurrencyBound: "cpu",
    } as never);
  });

  const ALL = ["r0", "r1", "r2", "r3", "r4", "r5"];
  const OPEN_AT_FIRST = ["r0", "r1", "r2"];

  it("defers when a tab click doubles the fleet, AND STILL DEFERS after the next poll", async () => {
    // THE PRODUCTION SEQUENCE, which is the only one that can tell the two wirings apart.
    //
    // Steady state first: three rows open and mounted on a machine whose RAM holds three. Then the
    // user clicks a tab and three dormant rows want panes — the exact "a dormant row becomes
    // resident the moment its tab is clicked, with no gate in between" the old comment described.
    seedLocalRows(ALL, OPEN_AT_FIRST);
    respondWithTotalCapacity(3);
    await act(async () => {
      await pollMemoryAdmission();
    });

    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => usePaneResidencyAdmission(ids, NO_PRIORITY),
      { initialProps: { ids: [...OPEN_AT_FIRST] } },
    );
    expect(result.current.deferred).toEqual([]); // steady state: three mounted, three allowed

    // The click.
    seedLocalRows(ALL, ALL);
    rerender({ ids: [...ALL] });
    expect(result.current.admitted.size).toBe(3);
    expect(result.current.deferred).toEqual(["r3", "r4", "r5"]);

    // ── THE ASSERTION THAT SEPARATES THE TWO WIRINGS ──────────────────────────────────────────
    // The old poll sent `live` — `openAgentIds ∩ visited`, now 6 — so the sampler was told six
    // agents were already resident on a machine holding three, answered with a ceiling of 6, and
    // every deferred pane was released. Forever, on every poll. The gate now publishes what it
    // MOUNTED (3), the poll sends that, and the reading measures residency instead of intent.
    await act(async () => {
      await pollMemoryAdmission();
    });
    expect(invoke).toHaveBeenLastCalledWith("memory_admission", { inUse: 3 });
    expect(result.current.deferred).toEqual(["r3", "r4", "r5"]);
  });

  it("sends the LOCAL mounted count to the sampler, never the exempt panes with it", async () => {
    // ── THE EXEMPTION AXIS OF THE SAME DENOMINATION BUG (roborev 81148, High) ─────────────────
    //
    // `in_use` is local `build`/`worker` only — that is the population `static_max` and
    // `memory_admitted` are built on. Publishing the UNION of the gated set and the exempt set sent
    // cloud and shell panes as local residents, which raises the residents ceiling by one per exempt
    // pane. Self-reinforcing, too: mounting more exempt panes raises it further, and past
    // `static_max` the reading is discarded outright and the gate switches itself off entirely.
    //
    // Three local rows and four exempt ones, on a machine holding three. `inUse` must be 3, not 7.
    useProjectStore.setState({
      selectedProjectId: "p1",
      projects: [
        {
          id: "p1",
          agents: [
            { id: "l0", kind: "build", runtime: "local" },
            { id: "l1", kind: "build", runtime: "local" },
            { id: "l2", kind: "build", runtime: "local" },
            { id: "c0", kind: "build", runtime: "cloud" },
            { id: "c1", kind: "build", runtime: "cloud" },
            { id: "s0", kind: "shell", runtime: "local" },
            { id: "s1", kind: "shell", runtime: "local" },
          ],
        },
      ],
    } as never);
    markProjectVisited("p1");
    useRuntimeStore.setState({ openAgentIds: ["l0", "l1", "l2"] } as never);
    respondWithTotalCapacity(3);
    await act(async () => {
      await pollMemoryAdmission();
    });

    const mixed = ["l0", "l1", "l2", "c0", "c1", "s0", "s1"];
    const { result } = renderHook(() => usePaneResidencyAdmission(mixed, NO_PRIORITY));
    // Every exempt pane mounted, and the three local ones fit.
    expect(result.current.admitted.size).toBe(7);
    expect(result.current.deferred).toEqual([]);

    await act(async () => {
      await pollMemoryAdmission();
    });
    // THE ASSERTION. The union would have sent 7 — which on a `static_max` of 9 is two short of
    // switching the gate off, and with two more shells open would reach it.
    expect(invoke).toHaveBeenLastCalledWith("memory_admission", { inUse: 3 });
  });

  it("keeps deferring a LOCAL pane across polls while exempt panes are open beside it", async () => {
    // The paired case, and the one that shows what the union actually cost: a fleet the gate should
    // still be biting on. Four local rows on a machine holding three, with three exempt panes open
    // beside them. Publishing 4 + 3 = 7 as `in_use` returns a ceiling of 7, the deferral evaporates
    // on the second poll, and past `static_max` the reading is discarded and the gate goes off.
    useProjectStore.setState({
      selectedProjectId: "p1",
      projects: [
        {
          id: "p1",
          agents: [
            { id: "l0", kind: "build", runtime: "local" },
            { id: "l1", kind: "build", runtime: "local" },
            { id: "l2", kind: "build", runtime: "local" },
            { id: "l3", kind: "build", runtime: "local" },
            { id: "c0", kind: "build", runtime: "cloud" },
            { id: "s0", kind: "shell", runtime: "local" },
            { id: "s1", kind: "shell", runtime: "local" },
          ],
        },
      ],
    } as never);
    markProjectVisited("p1");
    useRuntimeStore.setState({ openAgentIds: ["l0", "l1", "l2"] } as never);
    respondWithTotalCapacity(3);
    await act(async () => {
      await pollMemoryAdmission();
    });

    const mixed = ["l0", "l1", "l2", "l3", "c0", "s0", "s1"];
    const { result } = renderHook(() => usePaneResidencyAdmission(mixed, NO_PRIORITY));
    expect(result.current.deferred).toEqual(["l3"]);

    await act(async () => {
      await pollMemoryAdmission();
    });
    expect(invoke).toHaveBeenLastCalledWith("memory_admission", { inUse: 3 });
    expect(result.current.deferred).toEqual(["l3"]);
  });

  it("RELEASES across the same two polls once the machine has room — the paired case", async () => {
    // Without this the test above passes for a gate that defers unconditionally, which is the
    // "silently never mounts" failure. Identical fleet, identical gesture, identical poll path; the
    // ONLY difference is how much RAM the machine has.
    seedLocalRows(ALL, OPEN_AT_FIRST);
    respondWithTotalCapacity(STATIC);
    await act(async () => {
      await pollMemoryAdmission();
    });

    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => usePaneResidencyAdmission(ids, NO_PRIORITY),
      { initialProps: { ids: [...OPEN_AT_FIRST] } },
    );
    seedLocalRows(ALL, ALL);
    rerender({ ids: [...ALL] });
    expect(result.current.deferred).toEqual([]);

    await act(async () => {
      await pollMemoryAdmission();
    });
    expect(result.current.deferred).toEqual([]);
    expect(result.current.admitted.size).toBe(ALL.length);
  });
});
