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
// Pure — it imports nothing of its own — so pulling the refusal classifier in here costs
// nothing and lets the wording coupling below be asserted on the sentence this module really
// produces, rather than on a copy of it hand-typed into the classifier's own tests.
import { refusalAudience } from "../components/Concierge/refusalAudience";

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

/** A machine where `live` is a STRICT subset of `used`: `rows` local build rows, only the first
 *  `resident` of them open in this window. `seedMachine` opens every row, so it cannot express the
 *  population split the run-queue bug lives in. */
function seedDormant(rows: number, resident: number): void {
  seedMachine(rows);
  useRuntimeStore.setState({
    openAgentIds: Array.from({ length: resident }, (_, i) => `a${i}`),
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

describe("localAgentCapacity — narrowed by the live CPU run queue", () => {
  const LOAD_BASIS =
    "refused: the CPU run queue is 387.0 deep across 18 cores (21.5× per core, refusing past 2.0×)";
  const THROTTLE_BASIS =
    "throttled: the CPU run queue is 47.0 deep across 18 cores (2.6× per core, throttling past 2.0×)";

  it("applies a run-queue narrowing that carries NO memory sample at all", async () => {
    // THE REGRESSION THIS FILE EXISTS TO PIN (roborev 68367, High). The Rust `sample_now()` forks
    // four processes and returns None if any fails — and the machine this bound was built for is
    // one that cannot fork (46 shell launches dead with SIGBUS at load 387). So the realistic
    // saturated-machine payload is `sample: null`, and the gate has to honour it anyway.
    expect(localAgentCapacity().limit).toBe(STATIC_LIMIT); // baseline: provably not already 2

    await sample({ effective: 2, bound: "load", basis: LOAD_BASIS, sample: null, sampled: true });

    const cap = localAgentCapacity();
    // The run-queue ceiling binds with no memory reading behind it…
    expect(cap.limit).toBe(2);
    // …and the refusal names the run queue, not memory and not cores.
    expect(cap.basis).toBe(LOAD_BASIS);
  });

  it("names the run queue even when its ceiling is not below the static cap", async () => {
    // THE PINNED-CAP HOLE (bead `sparkle-iyxxin`). A run-queue refusal holds the line at what is
    // ALREADY RUNNING, so on a fleet that is already past the enforced cap its number lands at or
    // above `staticLimit` and the `narrowed < staticLimit` guard threw the basis away. The refusal
    // still happened — `used >= limit` — but it cited the STATIC ceiling, so a human on a machine at
    // 21.5x per-core load was told their ceiling is "6 cores × 2 agents per core" and sent to think
    // about hardware they cannot change, when the answer is to wait. Naming the wrong dimension is
    // the exact bug `basis` exists to close, and it has already sent one human chasing memory that
    // was 94% free.
    seedMachine(14); // 14 rows against a static cap of 12 — already over
    await sample({ effective: 14, bound: "load", basis: LOAD_BASIS, sample: null, sampled: true });

    const cap = localAgentCapacity();
    expect(cap.atCapacity).toBe(true);
    expect(cap.basis).toBe(LOAD_BASIS);
    expect(cap.limit).toBe(STATIC_LIMIT); // still never RAISED — the min holds
  });

  it("ADMITS while the run queue is only throttling, even with dormant rows in the count", async () => {
    // ── THE HARD-STOP REGRESSION (bead `sparkle-e57k99.1`) ────────────────────────────────────
    //
    // The run-queue ceiling is computed FROM the live count this module sends, so it is denominated
    // in RESIDENT agents, while the gate compares ROWS. `live` is a strict subset of `used`, so
    // `used >= min(static, effective)` was a tautology: past 2.0x per core the machine admitted
    // ZERO, permanently, at whatever fleet size was running when the line was crossed.
    //
    // The setup makes the two populations DIFFER, which is what the old arithmetic needed to be
    // caught: 5 rows, 3 of them resident (2 sit in a project tab this window never opened). A
    // throttling reading grants one on top of the residents — `effective = live + 1 = 4`. Under the
    // old code `limit` became `min(12, 4) = 4` and `used(5) >= 4` refused; the fleet could never
    // grow again. It must now admit, because the queue said "one more", not "no more".
    seedDormant(5, 3);
    expect(localAgentCapacity().atCapacity).toBe(false); // baseline: not already refusing

    await sample({
      effective: 4,
      load_headroom: 1, // the trickle: one more on top of the 3 residents the reading was built on
      bound: "load",
      basis: THROTTLE_BASIS,
      sample: null,
      sampled: true,
    });

    const cap = localAgentCapacity();
    expect(cap.used).toBe(5);
    expect(cap.live).toBe(3);
    expect(cap.atCapacity).toBe(false); // ← the tautology is gone
    expect(cap.limit).toBe(6); // the headroom of 1 carried across to rows: used + 1
    expect(cap.basis).toBe(THROTTLE_BASIS); // and the run queue still explains the ceiling
  });

  it("keeps the MEMORY ceiling while the run queue is throttling — `bound` is not a partition", async () => {
    // ── THE REGRESSION THE THROTTLE PATH INTRODUCED (roborev, High) ───────────────────────────
    //
    // `bound === "load"` does NOT mean memory declined to narrow. Rust's `load_binds` is true
    // whenever the run queue has an opinion and memory is not already holding at or below it, so
    // this branch is reached with a REAL RAM-derived ceiling in hand — and `effective` is the min of
    // the two, which cannot be decomposed back. A branch that computes its own ceiling from headroom
    // alone has silently dropped the memory one, re-opening the jetsam path the sampler exists to
    // close.
    //
    // The numbers are the reviewed failure: memory admits 6, the fleet holds 10 rows / 3 resident,
    // and the queue is merely throttling. Without the memory clamp `limit` is `used + 1 = 11` and
    // the gate admits; RAM said room for 6.
    seedDormant(10, 3);
    await sample({
      effective: 4, // min(memory 6, load 3+1)
      load_headroom: 1,
      memory_admitted: 6, // ← what RAM alone allows
      memory_basis: MEMORY_BASIS, // ← and the sentence that goes with it
      bound: "load",
      basis: THROTTLE_BASIS,
      sample: null,
      sampled: true,
    });

    const cap = localAgentCapacity();
    expect(cap.limit).toBe(6); // the memory ceiling, not `used + headroom` (11) and not the static 12
    expect(cap.atCapacity).toBe(true); // 10 rows against a RAM ceiling of 6
    // …AND IT NAMES THE TERM THAT BOUND (roborev, High). The reading is attributed to the queue —
    // Rust only sets `bound = load` when the queue's ceiling is below memory's — but the two arrive
    // here in different denominations, so memory is what produced `limit`. Quoting the run queue
    // would tell a human to wait for it to drain while RAM is the constraint: an instruction they
    // can follow forever without effect.
    expect(cap.basis).toBe(MEMORY_BASIS);
    expect(cap.basis).not.toBe(THROTTLE_BASIS);
  });

  it("does NOT clamp to memory when memory is not narrowing — the throttle still admits", async () => {
    // THE PAIRED CASE. Without it the test above passes for a gate that simply always refuses on a
    // load reading, which is the latch this whole change removed. Identical in every respect except
    // that `memory_admitted` is the static ceiling, i.e. RAM had no opinion.
    seedDormant(5, 3);
    await sample({
      effective: 4,
      load_headroom: 1,
      memory_admitted: STATIC_LIMIT, // ← memory did not narrow
      memory_basis: MEMORY_BASIS, // present but must NOT be quoted: memory is not what bound
      bound: "load",
      basis: THROTTLE_BASIS,
      sample: null,
      sampled: true,
    });

    const cap = localAgentCapacity();
    expect(cap.limit).toBe(6); // used(5) + headroom(1); the memory clamp is a no-op here
    expect(cap.atCapacity).toBe(false); // ← still admits, so the clamp did not become a latch
    // THE PAIRED ATTRIBUTION. Memory did not bind, so the run queue keeps the sentence — without
    // this, a gate that ALWAYS preferred the memory basis would pass the assertion above.
    expect(cap.basis).toBe(THROTTLE_BASIS);
  });

  it("REFUSES on the same fleet when the run queue is at its hard stop", async () => {
    // THE PAIRED CASE, and the reason the test above is not "the gate stopped gating". Identical
    // fleet, identical population split; the only difference is that the reading grants no headroom
    // (`effective === live`), which is what the Rust side returns past `LOAD_HARD_STOP_PER_CORE`.
    // Without this pair, a gate that simply always admitted would pass the test above.
    seedDormant(5, 3);

    await sample({
      effective: 3,
      load_headroom: 0, // the hard stop: no room on top of what is already resident
      bound: "load",
      basis: LOAD_BASIS,
      sample: null,
      sampled: true,
    });

    const cap = localAgentCapacity();
    expect(cap.atCapacity).toBe(true);
    expect(cap.limit).toBe(5); // held at the rows already taken — no sixth
    expect(cap.basis).toBe(LOAD_BASIS);
  });

  it("leaves the static basis alone when the same non-narrowing reading is a MEMORY one", async () => {
    // THE PAIRED CASE, identical in every respect but the dimension. Without it the test above
    // passes for a gate that simply always adopts the sampled basis — which would relabel a
    // CPU-bound machine as memory-bound the moment any reading arrived, the mirror image of the bug.
    seedMachine(14);
    await sample({ effective: 14, bound: "pressure", basis: MEMORY_BASIS, sampled: true });

    const cap = localAgentCapacity();
    expect(cap.atCapacity).toBe(true);
    expect(cap.basis).toBe(STATIC_BASIS); // memory narrowed nothing, so it explains nothing
  });

  it("still declines to narrow when NOTHING measured — sampled:false is not a load reading", async () => {
    // The paired case, so the test above cannot pass for a gate that simply ignores `sampled`.
    expect(localAgentCapacity().limit).toBe(STATIC_LIMIT);
    await sample({ effective: 2, bound: "load", basis: LOAD_BASIS, sample: null, sampled: false });
    // An unmeasured machine is not a squeezed one.
    expect(localAgentCapacity().limit).toBe(STATIC_LIMIT);
    expect(localAgentCapacity().basis).toBe(STATIC_BASIS);
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

describe("atCapacitySentence — the numbers it states must not contradict each other", () => {
  it("does not claim more slots taken than the ceiling it names", async () => {
    // THE DEFECT (bead `sparkle-e57k99.1`). `limit` is `min(staticLimit, effective)` and a runtime
    // narrowing routinely lands it BELOW the row count — the run queue holds at `live` plus a
    // trickle, and `live` is a strict subset of `used`. The sentence then read "has 9 of its 3
    // agent slots taken": two numbers in one clause that cannot both be true, shown at the exact
    // moment a human is trying to work out what is wrong with their machine.
    seedMachine(9);
    expect(localAgentCapacity().limit).toBe(STATIC_LIMIT); // baseline: provably not already 3
    await sample({ effective: 3 });

    const cap = localAgentCapacity();
    expect(cap.used).toBe(9);
    expect(cap.limit).toBe(3);

    const sentence = atCapacitySentence(cap, "No.");
    expect(sentence).not.toContain("9 of its 3");
    // What it says instead is still both true numbers, just not as a slots-taken fraction.
    expect(sentence).toContain("holding 9 agents against 3 agent slots");
    expect(sentence).toContain(MEMORY_BASIS);
  });

  it("keeps the slots wording while the count actually fits under the ceiling", () => {
    // THE PAIRED CASE. Without it, deleting the fraction branch outright would pass the test above,
    // and the ordinary refusal — much the commoner one — would lose the framing users read daily.
    seedMachine(2);
    const cap = localAgentCapacity();
    expect(cap.used).toBeLessThanOrEqual(cap.limit); // precondition, not an assumption
    expect(atCapacitySentence(cap, "No.")).toContain(`has 2 of its ${STATIC_LIMIT} agent slots taken`);
  });

  it("stays classifiable as an internal gate in BOTH wordings", async () => {
    // THE COUPLING, pinned on the produced sentence rather than a hand-typed copy of it.
    // `refusalAudience` decides whether a refusal is machinery the concierge routes around or red
    // text the founder has to read, and it decides by matching `/\bagent slots?\b/i`. Rewording
    // either branch out of that lexicon reclassifies every capacity refusal as founder-facing, and
    // nothing else in the tree would go red for it — the classifier's own tests assert against
    // strings typed by hand into that file.
    seedMachine(9);
    await sample({ effective: 3 });
    const over = localAgentCapacity();
    expect(over.used).toBeGreaterThan(over.limit); // precondition: this IS the over-ceiling branch
    expect(refusalAudience(atCapacitySentence(over, "I can't start another agent right now."))).toBe(
      "internal",
    );

    resetMemoryAdmission();
    seedMachine(2);
    const under = localAgentCapacity();
    expect(under.used).toBeLessThanOrEqual(under.limit);
    expect(refusalAudience(atCapacitySentence(under, "I can't start another agent right now."))).toBe(
      "internal",
    );
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
