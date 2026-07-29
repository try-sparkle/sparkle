import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { localAgentCapacity, atCapacitySentence, pollMemoryAdmission } from "./agentCapacity";
import {
  refreshMemoryAdmission,
  resetMemoryAdmission,
  setMemoryAdmissionClock,
  MEMORY_ADMISSION_TTL_MS,
  type ConcurrencyAdmission,
} from "./memoryAdmission";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { markProjectVisited, resetVisitedProjects } from "./sessionProjects";

// The STATIC ceiling for every test below. Deliberately not equal to any sampled number that
// follows, so an assertion on the narrowed limit cannot pass by accident.
const STATIC_LIMIT = 12;
const STATIC_BASIS = "CPU-bound: 6 cores × 2 agents per core";
const MEMORY_BASIS = "refused: memory pressure (2.1 GiB compressed, 0.9 GiB swap in use)";

function seedMachine(agentCount: number): void {
  useProjectStore.setState({
    selectedProjectId: "p1",
    projects: [
      {
        id: "p1",
        agents: Array.from({ length: agentCount }, (_, i) => ({
          id: `a${i}`,
          kind: "build",
          runtime: "local",
        })),
      },
    ],
  } as never);
  markProjectVisited("p1");
  useRuntimeStore.setState({
    openAgentIds: Array.from({ length: agentCount }, (_, i) => `a${i}`),
  } as never);
  useSettingsStore.setState({
    maxConcurrentWorkers: STATIC_LIMIT,
    effectiveMaxConcurrentWorkers: STATIC_LIMIT,
    machineMaxConcurrentWorkers: STATIC_LIMIT,
    concurrencyBasis: STATIC_BASIS,
    concurrencyBound: "cpu",
  } as never);
}

function admission(over: Partial<ConcurrencyAdmission> = {}): ConcurrencyAdmission {
  return {
    effective: 3,
    static_max: STATIC_LIMIT,
    static_bound: "cpu",
    bound: "pressure",
    basis: MEMORY_BASIS,
    sampled: true,
    sample: {
      total_bytes: 17_179_869_184,
      available_bytes: 1_073_741_824,
      compressed_bytes: 2_254_857_830,
      swap_used_bytes: 966_367_641,
      level: "critical",
    },
    ...over,
  };
}

let now = 1_000_000;

/** Push one reading through the REAL refresh path (mocked invoke), so the test exercises the
 *  wiring the app uses rather than reaching into the cache. */
async function sample(over: Partial<ConcurrencyAdmission> = {}): Promise<void> {
  invoke.mockResolvedValue(admission(over));
  await refreshMemoryAdmission(0);
}

beforeEach(() => {
  invoke.mockReset();
  resetMemoryAdmission();
  resetVisitedProjects();
  now = 1_000_000;
  setMemoryAdmissionClock(() => now);
  seedMachine(2);
});

afterEach(() => {
  setMemoryAdmissionClock();
  resetMemoryAdmission();
  resetVisitedProjects();
});

describe("localAgentCapacity — the static baseline (unchanged behavior)", () => {
  it("reports the enforced cap and its basis when nothing has been sampled", () => {
    const cap = localAgentCapacity();
    expect(cap.limit).toBe(STATIC_LIMIT);
    expect(cap.basis).toBe(STATIC_BASIS);
    expect(cap.used).toBe(2);
    expect(cap.atCapacity).toBe(false);
  });
});

describe("localAgentCapacity — narrowed by the live memory reading", () => {
  it("a FRESH narrowing reading lowers the limit AND names memory as the cause", async () => {
    // Baseline first, so the assertions below are provably about the change and not about a
    // number that was already 3. This is the vacuous-test guard: 12 → 3, cores → memory.
    expect(localAgentCapacity().limit).toBe(STATIC_LIMIT);
    expect(localAgentCapacity().basis).toBe(STATIC_BASIS);

    await sample({ effective: 3 });

    const cap = localAgentCapacity();
    expect(cap.limit).toBe(3);
    expect(cap.basis).toBe(MEMORY_BASIS);
    // And the narrowing is what a refusal would actually be built from — the sentence the gates
    // show must carry the lowered number and the memory cause, not the static pair.
    const sentence = atCapacitySentence(cap, "No.");
    expect(sentence).toContain("of its 3 agent slots");
    expect(sentence).toContain(MEMORY_BASIS);
  });

  it("flips atCapacity ON for a machine that is under the static ceiling but out of memory", async () => {
    seedMachine(4); // 4 of 12 statically — nowhere near full
    expect(localAgentCapacity().atCapacity).toBe(false);

    await sample({ effective: 3 });

    // 4 rows against a sampled ceiling of 3: the spawn gates must now refuse. This is the whole
    // point of the feature — a refusal that the static prediction would never have produced.
    expect(localAgentCapacity().atCapacity).toBe(true);
  });

  it("a STALE reading does not narrow — the ceiling comes back once the sample expires", async () => {
    await sample({ effective: 3 });
    expect(localAgentCapacity().limit).toBe(3);

    now += MEMORY_ADMISSION_TTL_MS; // the moment of pressure has passed
    const cap = localAgentCapacity();
    expect(cap.limit).toBe(STATIC_LIMIT);
    expect(cap.basis).toBe(STATIC_BASIS);
  });

  it("a reading with sampled:false does not narrow — unmeasured is not squeezed", async () => {
    // Same low `effective` as the narrowing case; ONLY the flag differs, so this cannot pass by
    // reading a number that was never low.
    await sample({ effective: 3, sampled: false, sample: null });
    const cap = localAgentCapacity();
    expect(cap.limit).toBe(STATIC_LIMIT);
    expect(cap.basis).toBe(STATIC_BASIS);
  });

  it("NEVER raises the limit, even when the payload claims effective > static_max", async () => {
    // A backend bug, a version skew, or a tampered payload. The frontend re-imposes the min rather
    // than trusting the Rust invariant, because the ceiling exists to stop the machine being
    // jetsam-killed and a lifted one is unrecoverable.
    await sample({ effective: 999, static_max: 999 });
    const cap = localAgentCapacity();
    expect(cap.limit).toBe(STATIC_LIMIT);
    // A non-binding reading must not relabel a CPU-bound machine as memory-bound either.
    expect(cap.basis).toBe(STATIC_BASIS);
  });

  it("clamps a zero/negative effective to 1 rather than refusing everything outright", async () => {
    await sample({ effective: 0 });
    expect(localAgentCapacity().limit).toBe(1);

    await sample({ effective: -5 });
    expect(localAgentCapacity().limit).toBe(1);
  });

  it("floors a fractional effective instead of reporting a half slot", async () => {
    await sample({ effective: 3.9 });
    expect(localAgentCapacity().limit).toBe(3);
  });

  it("a REJECTED invoke leaves capacity exactly as it was, and does not throw", async () => {
    invoke.mockRejectedValue(new Error("Command memory_admission not found"));
    await expect(refreshMemoryAdmission(0)).resolves.toBeUndefined();

    const cap = localAgentCapacity();
    expect(cap.limit).toBe(STATIC_LIMIT);
    expect(cap.basis).toBe(STATIC_BASIS);
    expect(cap.used).toBe(2);
    expect(cap.atCapacity).toBe(false);
  });

  it("a rejection AFTER a narrowing reading does NOT immediately release the ceiling", async () => {
    // Was the opposite assertion. One failed poll releasing the ceiling mid-pressure is the defect
    // roborev 55383 found: the TTL rationale in both files promises tolerance of a dropped sample,
    // and clearing on the first error meant there was none.
    await sample({ effective: 3 });
    expect(localAgentCapacity().limit).toBe(3);

    invoke.mockRejectedValue(new Error("transient hiccup"));
    await refreshMemoryAdmission(0);
    expect(localAgentCapacity().limit).toBe(3);

    // It releases on the TTL instead — the timescale that was designed for this.
    now += MEMORY_ADMISSION_TTL_MS;
    expect(localAgentCapacity().limit).toBe(STATIC_LIMIT);
  });

  it("keeps the static basis when the sampled one is blank — a causeless number beats a wrong cause", async () => {
    await sample({ effective: 3, basis: "   " });
    const cap = localAgentCapacity();
    expect(cap.limit).toBe(3);
    expect(cap.basis).toBe(STATIC_BASIS);
  });
});

describe("pollMemoryAdmission — which count reaches Rust", () => {
  // The defect this pins (roborev 55383): the poll sent `used` (every row) where Rust's arithmetic
  // needs the RESIDENT count. Rust computes `in_use + available/per_agent`, adding `in_use` back
  // because running agents are already subtracted from `available_bytes` — true only of agents that
  // hold memory. Dormant rows credited with a per-agent share inflate the ceiling, permissively.
  //
  // This lived inline in App.tsx and so was untestable; that is why it shipped wrong. The assertion
  // is only meaningful because the fixture makes used !== live.

  /** 9 rows, of which only 3 have a mounted pane. */
  function seedWithDormantRows(): void {
    useProjectStore.setState({
      selectedProjectId: "p1",
      projects: [
        {
          id: "p1",
          agents: Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, kind: "build", runtime: "local" })),
        },
      ],
    } as never);
    markProjectVisited("p1");
    // Only the first three are open, so live = 3 while used = 9.
    useRuntimeStore.setState({ openAgentIds: ["a0", "a1", "a2"] } as never);
  }

  it("sends the RESIDENT count, not the row count", async () => {
    seedWithDormantRows();
    invoke.mockResolvedValue(admission());

    const cap = localAgentCapacity();
    expect(cap.used).toBe(9);
    expect(cap.live).toBe(3);

    await pollMemoryAdmission();

    // 3, not 9. Both numbers are real and present in this fixture, so an implementation sending
    // either one passes its own reading of the contract — which is what makes this assertion worth
    // having rather than tautological.
    expect(invoke).toHaveBeenCalledWith("memory_admission", { inUse: 3 });
  });

  it("the inflation it prevents: dormant rows would have credited memory they never took", async () => {
    seedWithDormantRows();
    invoke.mockResolvedValue(admission());
    await pollMemoryAdmission();

    const sent = invoke.mock.calls[0]?.[1] as { inUse: number };
    const cap = localAgentCapacity();
    // The gap IS the bug's magnitude: Rust would have added 6 agents' worth of budget back onto the
    // measured headroom, which is what stopped the available bound from ever narrowing.
    expect(cap.used - sent.inUse).toBe(6);
    expect(sent.inUse).toBeLessThan(cap.used);
  });
});
