import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import {
  localAgentCapacity,
  atCapacitySentence,
  pollMemoryAdmission,
  residentAdmissionCeiling,
} from "./agentCapacity";
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
 *  wiring the app uses rather than reaching into the cache.
 *
 *  IT GOES THROUGH `pollMemoryAdmission`, NOT `refreshMemoryAdmission(0)` (bead `sparkle-ftapmp`).
 *  Every ceiling on the payload is denominated in RESIDENT agents and is only meaningful relative to
 *  the `in_use` that produced it, so a helper that hardcoded `0` was seeding a reading no production
 *  poll can ever produce — one measured from an empty machine and then read against a fleet. The
 *  gate now recovers the headroom by subtracting exactly what was sent, so the fixture has to send
 *  what production sends: `localAgentCapacity().live`, which is what `pollMemoryAdmission` does. */
async function sample(over: Partial<ConcurrencyAdmission> = {}): Promise<void> {
  invoke.mockResolvedValue(admission(over));
  await pollMemoryAdmission();
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
    // ── AND THE MEMORY TERM IS TRANSLATED TO ROWS FIRST (bead `sparkle-ftapmp`) ───────────────
    //
    // The numbers moved when the denomination was fixed, and the movement IS the fix. This fixture
    // used to read `memory_admitted: 6` and assert `limit === 6` / at capacity — i.e. a ceiling
    // MEASURED FROM 3 RESIDENTS spent directly against 10 ROWS. The 7 dormant rows hold no process,
    // so they cannot be what memory is short of; what the reading actually says is "room for
    // `memory_admitted - in_use` more residents", and that displacement is what carries across.
    //
    // Here memory admits 4 against the 3 residents it measured — room for ONE more — so the memory
    // ceiling is 10 + 1 = 11 rows, while the queue's trickle of 3 would allow 13. Memory is still
    // the binding term, which is what this test exists to prove; it simply binds at the honest
    // number instead of one that counted every dormant row twice.
    seedDormant(10, 3);
    await sample({
      effective: 4, // min(memory 4, load 3+3)
      load_headroom: 3,
      memory_admitted: 4, // ← what RAM alone allows, in RESIDENTS
      memory_basis: MEMORY_BASIS, // ← and the sentence that goes with it
      bound: "load",
      basis: THROTTLE_BASIS,
      sample: null,
      sampled: true,
    });

    const cap = localAgentCapacity();
    expect(cap.used).toBe(10);
    expect(cap.live).toBe(3);
    expect(cap.limit).toBe(11); // the memory term (10 + 1), not the queue's 13 and not the static 12
    // …AND IT NAMES THE TERM THAT BOUND (roborev, High). The reading is attributed to the queue —
    // Rust only sets `bound = load` when the queue's ceiling is below memory's — but the two arrive
    // here in different denominations, so memory is what produced `limit`. Quoting the run queue
    // would tell a human to wait for it to drain while RAM is the constraint: an instruction they
    // can follow forever without effect.
    expect(cap.basis).toBe(MEMORY_BASIS);
    expect(cap.basis).not.toBe(THROTTLE_BASIS);
  });

  it("still REFUSES on the load path when memory grants NO headroom at all", async () => {
    // THE PAIRED CASE FOR THE CLAMP, and the one that keeps the jetsam guard real after the
    // denomination fix (bead `sparkle-ftapmp`). Identical fleet and an identical throttling queue;
    // the ONLY difference is that memory admits exactly the residents it measured, i.e. room for
    // zero more. Without this, "translate the memory ceiling into rows" would be indistinguishable
    // from "drop the memory clamp", which is the regression the test above was written against.
    seedDormant(10, 3);
    expect(localAgentCapacity().atCapacity).toBe(false); // baseline: provably not already refusing

    await sample({
      effective: 3,
      load_headroom: 3, // the queue would happily allow three more
      memory_admitted: 3, // ← RAM: nothing on top of the 3 already resident
      memory_basis: MEMORY_BASIS,
      bound: "load",
      basis: THROTTLE_BASIS,
      sample: null,
      sampled: true,
    });

    const cap = localAgentCapacity();
    expect(cap.limit).toBe(10); // held at the rows already taken — memory grants no eleventh
    expect(cap.atCapacity).toBe(true);
    expect(cap.basis).toBe(MEMORY_BASIS);
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

  it("HOLDS the anchor on the load path while the fleet grows INTO its ceiling", async () => {
    // ── THE HOLD DIRECTION OF THE LOAD BRANCH (roborev 81187, High) ───────────────────────────
    //
    // The retake threshold on this branch is `min(memoryRoom, load_headroom)`, which is 1 in the
    // ordinary throttling case. Narrowing it from the widest allowance fixed a false refusal, and it
    // also made this direction easy to break: set that room to 0 and the anchor tracks `used` on
    // every call, so `byLoad = used + 1` and `used >= used + 1` is never true — row after row
    // admitted up to the static ceiling on a reading that granted exactly ONE. That is the
    // cancellation of `sparkle-e57k99.1` back on the jetsam path.
    //
    // NOTHING PINNED IT, because every other load-branch test here calls `localAgentCapacity()` just
    // ONCE after sampling, and the first call after a new `seq` anchors at the current count
    // whatever room it is passed — so the room argument was unobservable in all of them. The
    // discriminator is a SECOND call against the SAME reading with the fleet one larger.
    seedDormant(5, 3);
    await sample({
      effective: 4, // min(memory 12, load 3+1)
      load_headroom: 1, // throttling: one more on top of the 3 residents
      memory_admitted: STATIC_LIMIT, // RAM is NOT the constraint, which is why `bound` is load
      memory_basis: MEMORY_BASIS,
      bound: "load",
      basis: THROTTLE_BASIS,
      sample: null,
      sampled: true,
    });
    // First call: anchor 5, the queue grants a sixth row.
    expect(localAgentCapacity().limit).toBe(6);
    expect(localAgentCapacity().atCapacity).toBe(false);

    // The sixth row appears — and NO new reading arrives. The one seat the queue granted is now
    // taken, so the same reading must refuse a seventh.
    seedDormant(6, 3);
    const cap = localAgentCapacity();
    expect(cap.limit).toBe(6); // held at 5 + 1, NOT re-granted as 6 + 1
    expect(cap.atCapacity).toBe(true);
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

// ══ THE ONE-WAY RATCHET (bead `sparkle-ftapmp`) ═════════════════════════════════════════════════
//
// Seeded from the state MEASURED on the founder's machine on 2026-09-04, at the moment the sixth
// consecutive spawn refusal of that session landed:
//
//   128 GiB installed, 26 GiB free
//   60 local build/worker ROWS registered across all projects
//   21 of them RESIDENT (`live`) — and `ps -Ao rss,comm | grep -i "[c]laude"` found 20 real
//     processes holding 5.8 GiB between them, so `live` is a good proxy for true residency and
//     `used` is not
//   `memory_admitted` 39 — Rust's `in_use + available/per_agent`, i.e. 21 residents + room for 18
//   the app refused, citing "holding 60 agents against 39 agent slots"
//
// The defect was that 39 counts RESIDENTS and 60 counts ROWS. A retire lowers BOTH — measured, two
// refusals 90s apart with one retire between moved used 60→59 and limit 39→38, gap fixed at 21 — so
// the fleet could only ever get more blocked, and no action available to anyone closed it.
describe("localAgentCapacity — the measured 60-row / 21-resident machine", () => {
  // Above `memory_admitted` on purpose: this machine's refusal quoted 39, so the static ceiling was
  // not what bound, and a fixture where the static cap did the refusing would prove nothing about
  // the memory term.
  const MEASURED_STATIC = 81;
  const MEASURED_BASIS = "CPU-bound: 40 cores × 2 agents per core";
  /** The memory sentence Rust composes for an `available`-bound reading, with the real numbers. */
  const MEASURED_MEMORY_BASIS =
    "refused: only 26.0 GiB of memory is available right now ÷ 3379 MiB per agent = room for 18 " +
    "more on top of the 21 running — the static ceiling of 81 assumes memory this machine does not " +
    "currently have free";

  /** `rows` local build rows, the first `resident` of them with a mounted pane. */
  function seedMeasured(rows: number, resident: number): void {
    seedDormant(rows, resident);
    useSettingsStore.setState({
      maxConcurrentWorkers: MEASURED_STATIC,
      effectiveMaxConcurrentWorkers: MEASURED_STATIC,
      machineMaxConcurrentWorkers: MEASURED_STATIC,
      concurrencyBasis: MEASURED_BASIS,
      concurrencyBound: "cpu",
    } as never);
  }

  /** The exact payload `memory_admission` returned at the refusal, parameterised only by what
   *  memory admits — so the admitting and the refusing cases differ in ONE number. */
  async function sampleMeasured(memoryAdmitted: number): Promise<void> {
    await sample({
      effective: memoryAdmitted,
      static_max: MEASURED_STATIC,
      static_bound: "cpu",
      bound: "available",
      basis: MEASURED_MEMORY_BASIS,
      memory_admitted: memoryAdmitted,
      memory_basis: MEASURED_MEMORY_BASIS,
      sampled: true,
      sample: {
        total_bytes: 137_438_953_472,
        available_bytes: 27_917_287_424,
        compressed_bytes: 0,
        swap_used_bytes: 0,
        level: "normal",
      },
    });
  }

  it("ADMITS at the measured state — 60 rows, 21 residents, memory admitting 39", async () => {
    seedMeasured(60, 21);
    const before = localAgentCapacity();
    // Baseline, so the assertions below are provably about the reading and not about a machine that
    // was never full: nothing has been sampled yet, so the static ceiling stands and 60 < 81.
    expect(before.used).toBe(60);
    expect(before.live).toBe(21);
    expect(before.limit).toBe(MEASURED_STATIC);

    await sampleMeasured(39);

    const cap = localAgentCapacity();
    expect(cap.used).toBe(60);
    expect(cap.live).toBe(21);
    // 39 residents admitted against the 21 measured = room for 18 more. Carried across to rows:
    // 60 + 18 = 78, under the static 81, so THAT is the enforced ceiling.
    expect(cap.limit).toBe(78);
    // THE FINISH LINE OF THE BEAD: a spawn succeeds while memory reports free slots.
    expect(cap.atCapacity).toBe(false);
    // And the ceiling still names the term that produced it.
    expect(cap.basis).toBe(MEASURED_MEMORY_BASIS);
  });

  it("REFUSES on the same fleet when memory grants no room on top of the residents", async () => {
    // THE PAIRED NEGATIVE, and the reason the test above is not "the gate stopped gating". Identical
    // 60 rows and identical 21 residents; the ONLY difference is that memory admits exactly the
    // residents it measured. A gate that simply admitted everything would pass the test above.
    seedMeasured(60, 21);
    await sampleMeasured(21);

    const cap = localAgentCapacity();
    expect(cap.limit).toBe(60); // held at the rows already taken — no sixty-first
    expect(cap.atCapacity).toBe(true);
  });

  it("REFUSES on a genuinely full machine — every row resident and memory holding at that", async () => {
    // The other shape of "genuinely full": no dormant rows at all, so `used === live` and the
    // translation is the identity. If the fix had been "ignore the memory ceiling when rows exceed
    // it", this would admit.
    seedMeasured(60, 60);
    await sampleMeasured(60);

    const cap = localAgentCapacity();
    expect(cap.used).toBe(60);
    expect(cap.live).toBe(60);
    expect(cap.limit).toBe(60);
    expect(cap.atCapacity).toBe(true);
  });

  it("RETIRING AN AGENT NOW CLOSES THE GAP — the one-way ratchet is gone", async () => {
    // THE BEAD'S OWN EVIDENCE, replayed. Two refusals 90 seconds apart with one retire between them:
    // used 60→59 AND limit 39→38, gap fixed at exactly 21. Retiring lowered both sides because the
    // retired agent was resident, so it left `live` too — which is why no amount of retiring could
    // ever help. Here the same retire has to move the machine strictly TOWARDS admitting.
    seedMeasured(60, 21);
    await sampleMeasured(39);
    const before = localAgentCapacity();

    // One resident agent retired: it leaves BOTH lists, and the next poll re-measures from 20.
    seedMeasured(59, 20);
    await sampleMeasured(38); // 20 residents + the same room for 18
    const after = localAgentCapacity();

    expect(after.used).toBe(before.used - 1);
    // The gap the bead measured — `used - limit` — must SHRINK, not hold. Under the old arithmetic
    // it was 21 before and 21 after.
    expect(before.used - before.limit).toBe(-18);
    expect(after.used - after.limit).toBe(-18);
    // Stated as the property rather than the pair of numbers: retiring never leaves the machine
    // further from admitting than it was.
    expect(after.used - after.limit).toBeLessThanOrEqual(before.used - before.limit);
  });

  it("SPENDS the headroom rather than re-spending it as the fleet grows", async () => {
    // ── THE CANCELLATION (roborev 81142, High) ────────────────────────────────────────────────
    //
    // Displacing by the LIVE `used` puts it on BOTH sides of `used >= limit`: the comparison is
    // `used >= min(staticLimit, used + h)`, which reduces to `h <= 0 || used >= staticLimit`. So a
    // reading granting room for 18 more would admit row after row all the way to the static ceiling
    // of 81, spending the same 18 seats over and over — the jetsam path the sampler exists to close,
    // reopened by the fix for the ratchet.
    //
    // The headroom is a per-SAMPLE grant, so the count it is added to is frozen at the sample. Here
    // that is 60 rows + 18 = 78, and the fleet growing INTO that ceiling — with the reading
    // unchanged — has to flip the verdict.
    seedMeasured(60, 21);
    await sampleMeasured(39);
    expect(localAgentCapacity().atCapacity).toBe(false); // baseline: 60 rows, room for 18

    // 77 rows and the SAME reading: still one seat left.
    seedMeasured(77, 21);
    expect(localAgentCapacity().limit).toBe(78);
    expect(localAgentCapacity().atCapacity).toBe(false);

    // 78: the 18 seats the reading granted are taken.
    seedMeasured(78, 21);
    const cap = localAgentCapacity();
    expect(cap.limit).toBe(78); // NOT 78 + 18 — the ceiling did not move with the fleet
    expect(cap.atCapacity).toBe(true);
  });

  it("ADMITS when the reading landed before the project list had hydrated", async () => {
    // ── THE OTHER DIRECTION OF THE ANCHOR (roborev 81146, High) ───────────────────────────────
    //
    // The pair for the test above, and the reason a one-sided mutation set is not enough for a
    // predicate that both blocks and allows. Freezing the count stops it cancelling; freezing it at
    // the WRONG moment is the original bug back on a shorter clock.
    //
    // Reachable on an ordinary launch: `localAgentRowIds().used` reads the project store with no
    // visited filter, so it is 0 until the list hydrates from Rust, while `pollMemoryAdmission()`
    // fires on mount and sends `live = 0`. Any render in that gap anchors `rows = 0`, and `limit`
    // becomes the bare headroom — 18 here. The 60 rows arriving a moment later would then read as
    // AT CAPACITY, citing memory, for up to a poll interval.
    seedMeasured(0, 0); // the unhydrated store
    await sampleMeasured(18); // 18 residents admitted against the 0 measured: room for 18
    // A render happens in the gap and takes the anchor. This is the call that used to poison the
    // whole poll window.
    expect(localAgentCapacity().used).toBe(0);

    // …and now the project list arrives.
    seedMeasured(60, 21);
    const cap = localAgentCapacity();
    expect(cap.used).toBe(60);
    // Under a one-directional anchor this was `limit = 0 + 18 = 18` and `60 >= 18` → refused.
    expect(cap.limit).toBe(78);
    expect(cap.atCapacity).toBe(false);
  });

  it("ADMITS on the LOAD branch too when the reading landed before hydration", async () => {
    // ── THE RETAKE HAS TO BE ASKED WITH THE ENFORCED ALLOWANCE (roborev 81181, High) ───────────
    //
    // The pair above goes through `sampleMeasured`, which sends `bound: "available"` and no
    // `load_headroom` — and THERE `memory_admitted === effective`, so the widest allowance and the
    // narrowest are the same number and a `max` is indistinguishable from a `min`. The retake was
    // therefore pinned only in the one regime where the choice does not matter, and was inert in the
    // regime this machine actually lives in.
    //
    // On a load-attributed reading the enforced ceiling is `min(anchor + memoryHeadroom,
    // anchor + load_headroom)`, and `load_headroom` is 0 or 1 BY CONSTRUCTION while
    // `memory_admitted` is `static_max` whenever RAM is not the constraint — which is exactly when
    // Rust attributes a reading to the queue. Asked with the max, the anchor was held until the
    // count passed `anchor + 81` while the gate refused at `anchor + 1`.
    seedMeasured(0, 0); // the unhydrated store
    await sample({
      effective: 1, // the queue holds at what is running (0) plus its trickle
      load_headroom: 1, // THROTTLING — this box's normal 2.6-5.9x per-core band, not the hard stop
      memory_admitted: MEASURED_STATIC, // RAM is not the constraint, which is why `bound` is load
      memory_basis: MEASURED_MEMORY_BASIS,
      static_max: MEASURED_STATIC,
      static_bound: "cpu",
      bound: "load",
      basis: "throttled: the CPU run queue is 47.0 deep across 18 cores (2.6× per core…)",
      sampled: true,
      sample: null,
    });
    // The render in the hydration gap that takes the anchor.
    expect(localAgentCapacity().used).toBe(0);

    // …and the project list arrives.
    seedMeasured(60, 21);
    const cap = localAgentCapacity();
    expect(cap.used).toBe(60);
    // Held at 0, this was `min(81, 0 + 81, 0 + 1) = 1` — at capacity on 60 rows, quoting the
    // throttle sentence. Retaken, the queue grants one more on top of the 60 rows that exist.
    expect(cap.limit).toBe(61);
    expect(cap.atCapacity).toBe(false);
  });

  it("does NOT let a fleet that grew underneath it talk a FULL machine into admitting", async () => {
    // The paired case for the retake, and the one that keeps it from becoming "use the live count".
    // Same overshoot, but the reading grants ZERO headroom — so the retaken ceiling is the count
    // itself and `used >= limit` still refuses. A retake may only ever restore the honest ceiling,
    // never manufacture room the machine does not have.
    seedMeasured(0, 0);
    await sampleMeasured(0); // memory admits nothing on top of the 0 it measured
    expect(localAgentCapacity().used).toBe(0);

    seedMeasured(60, 21);
    const cap = localAgentCapacity();
    expect(cap.limit).toBe(60);
    expect(cap.atCapacity).toBe(true);
  });

  it("gives the SAME verdict when the same inputs are driven TWICE", async () => {
    // Bead `sparkle-yskany`: four tests on the sibling epic pinned the defect rather than the intent
    // because their fixtures varied something production holds constant. A capacity reading is a
    // pure function of (rows, residents, reading), so driving it twice with nothing changed must
    // produce a byte-identical verdict — no counter, no accumulation, no dependence on how many
    // times a poll has run.
    seedMeasured(60, 21);
    await sampleMeasured(39);
    const first = localAgentCapacity();

    // The identical poll again — same fleet, same payload, same clock.
    await sampleMeasured(39);
    const second = localAgentCapacity();

    expect(second).toEqual(first);
    // And a bare re-read with no poll in between is the same reading too.
    expect(localAgentCapacity()).toEqual(first);
  });

  it("the refusal claims NOTHING about whether the dormant rows are running", async () => {
    // ── THE COPY (bead `sparkle-ftapmp`, part 3), AND IT HAS NOW BEEN WRONG BOTH WAYS ──────────
    //
    // The clause said the rows in unopened tabs were "most are already running, they're just not on
    // screen" — measured false at 60 rows and 20 processes, and it is why this arithmetic read as
    // defensible to every reviewer who looked at it. But that sentence was itself the fix for BUG 1
    // of the ceiling audit, which retracted the OPPOSITE claim ("each one starts as soon as you
    // do") on the observation that closed-tab projects were running their full roster.
    //
    // Both are true of different rows, and `live` — "has a mounted pane IN THIS WINDOW" — separates
    // neither. So the honest clause asserts NOTHING about process state and says what it does
    // measure. Asserted here as a pair: the two retracted claims are absent, AND the true statement
    // is present, because deleting a claim is not the same fact as stating the truth and a
    // negative-only ratchet is green over copy trimmed to silence.
    seedMeasured(60, 21);
    await sampleMeasured(21); // the refusing state, so there is a sentence to read
    const cap = localAgentCapacity();
    expect(cap.atCapacity).toBe(true); // precondition, not an assumption

    const sentence = atCapacitySentence(cap, "I can't start another agent right now.");
    // NEITHER retracted claim.
    expect(sentence).not.toContain("already running,");
    expect(sentence).not.toMatch(/most are already running/i);
    expect(sentence).not.toMatch(/starts as soon as you do/i);
    expect(sentence).not.toMatch(/haven't opened yet/i);
    // …and the true statement, which is what `live` measures plus what the count is OF.
    expect(sentence).toContain("21 of them showing in this window");
    expect(sentence).toContain("aren't open here");
    expect(sentence).toContain("can't tell which of those still hold a running process");
    expect(sentence).toContain("the count is of slots, not of processes");
    // THE CLASSIFIER COUPLING SURVIVES THE REWORD. `components/Concierge/refusalAudience` decides
    // whether a capacity refusal is machinery the concierge routes around or red text the founder
    // has to read, and it decides by matching `/\bagent slots?\b/i`. Rewording this sentence out of
    // that lexicon would silently reclassify every capacity refusal as founder-facing, and nothing
    // else in the tree would go red for it.
    expect(refusalAudience(sentence)).toBe("internal");
  });
});

describe("residentAdmissionCeiling — the residency counterpart to `limit`", () => {
  it("is null when nothing has been sampled — an unmeasured machine holds nothing back", () => {
    expect(residentAdmissionCeiling()).toBeNull();
  });

  it("is null when memory did NOT narrow, even though a reading arrived", async () => {
    // The paired case, and the one that keeps the mount gate off healthy machines: a static ceiling
    // is a PREDICTION, not a measurement of residency, and deferring panes on the strength of it
    // would fire when nothing is wrong. Without this, the test below passes for a gate that treats
    // every reading as a narrowing one.
    await sample({ effective: STATIC_LIMIT, memory_admitted: STATIC_LIMIT, sampled: true });
    expect(residentAdmissionCeiling()).toBeNull();
  });

  it("is the memory ceiling in RESIDENTS once memory narrows", async () => {
    await sample({ effective: 3, memory_admitted: 3, sampled: true });
    // 3 — the residents number verbatim, NOT the row-denominated `limit` beside it.
    expect(residentAdmissionCeiling()).toBe(3);
  });

  it("never exceeds the enforced cap, whatever the payload claims", async () => {
    // A backend bug, a version skew or a tampered payload. Same one-directional contract `limit`
    // has: sampling may only ever LOWER a ceiling (sparkle-01xv / sparkle-asz5).
    //
    // THE FIXTURE HAS TO REACH THE CLAMP, and the first version of this test did not (roborev 81139,
    // High). It passed `memory_admitted: 999, static_max: 999`, which satisfies the EARLIER
    // `admitted >= static_max` guard and returns `null` — so a `ceiling === null || ceiling <= 12`
    // assertion was carried entirely by the null disjunct, and deleting the `Math.min` left it
    // green. The clamp is only reachable when the payload narrows RELATIVE TO ITS OWN `static_max`
    // and still exceeds the frontend's enforced cap, so `static_max` must be strictly larger.
    await sample({ effective: 999, memory_admitted: 999, static_max: 1000, sampled: true });
    // Exactly the cap — no disjunction, so the assertion cannot be satisfied by a null.
    expect(residentAdmissionCeiling()).toBe(STATIC_LIMIT);
  });

  it("is null for a reading that measured nothing — sampled:false is not a squeezed machine", async () => {
    await sample({ effective: 3, memory_admitted: 3, sampled: false, sample: null });
    expect(residentAdmissionCeiling()).toBeNull();
  });

  it("is null again once the reading goes stale", async () => {
    await sample({ effective: 3, memory_admitted: 3, sampled: true });
    expect(residentAdmissionCeiling()).toBe(3);
    now += MEMORY_ADMISSION_TTL_MS;
    expect(residentAdmissionCeiling()).toBeNull();
  });
});
