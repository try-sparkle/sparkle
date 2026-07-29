import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import {
  refreshMemoryAdmission,
  currentMemoryAdmission,
  resetMemoryAdmission,
  setMemoryAdmissionClock,
  MEMORY_ADMISSION_TTL_MS,
  MEMORY_ADMISSION_POLL_MS,
  type ConcurrencyAdmission,
} from "./memoryAdmission";

/** A narrowing admission: the machine can hold 3 right now against a static ceiling of 12. */
function admission(over: Partial<ConcurrencyAdmission> = {}): ConcurrencyAdmission {
  return {
    effective: 3,
    static_max: 12,
    static_bound: "cpu",
    bound: "pressure",
    basis: "refused: memory pressure (2.1 GiB compressed, 0.9 GiB swap in use)",
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

beforeEach(() => {
  invoke.mockReset();
  resetMemoryAdmission();
  now = 1_000_000;
  setMemoryAdmissionClock(() => now);
});

afterEach(() => {
  setMemoryAdmissionClock();
  resetMemoryAdmission();
});

describe("refreshMemoryAdmission", () => {
  it("invokes memory_admission with the camelCased inUse arg and caches the reading", async () => {
    invoke.mockResolvedValue(admission());
    await refreshMemoryAdmission(7);
    // Tauri v2 camelCases args (`in_use` on the Rust side) — same convention as config.ts's
    // `projectRoot`. Getting this wrong makes the command reject on every tick, silently.
    expect(invoke).toHaveBeenCalledWith("memory_admission", { inUse: 7 });
    expect(currentMemoryAdmission()?.effective).toBe(3);
  });

  it("a REJECTED invoke leaves the cache null and does not throw (older backends reject every tick)", async () => {
    invoke.mockRejectedValue(new Error("Command memory_admission not found"));
    await expect(refreshMemoryAdmission(2)).resolves.toBeUndefined();
    expect(currentMemoryAdmission()).toBeNull();
  });

  it("ONE failed poll does NOT drop the narrowing — the TTL owns expiry, not the error path", async () => {
    // This test previously asserted the opposite (a single rejection cleared the cache). That
    // contradicted the TTL rationale both files state: "three polls fit inside the 15s TTL, so one
    // slow or dropped sample never expires the narrowing". A dropped sample never reaches the TTL,
    // so clearing on the first error meant one IPC hiccup handed the machine back the static ceiling
    // mid-pressure (roborev 55383).
    invoke.mockResolvedValue(admission());
    await refreshMemoryAdmission(2);
    expect(currentMemoryAdmission()?.effective).toBe(3);

    invoke.mockRejectedValue(new Error("transient IPC hiccup"));
    await refreshMemoryAdmission(2);
    // Still narrowing, on the reading we already had.
    expect(currentMemoryAdmission()?.effective).toBe(3);
  });

  it("a backend that keeps failing releases the ceiling via the TTL, without any successful poll", async () => {
    invoke.mockResolvedValue(admission());
    await refreshMemoryAdmission(2);
    invoke.mockRejectedValue(new Error("backend went away for good"));

    // Poll through the whole TTL window failing every time. `at` is never refreshed by a failure, so
    // the reading ages out on schedule — this is why keeping the cache on error is safe.
    for (let t = 0; t < MEMORY_ADMISSION_TTL_MS; t += MEMORY_ADMISSION_POLL_MS) {
      await refreshMemoryAdmission(2);
      now += MEMORY_ADMISSION_POLL_MS;
    }
    expect(currentMemoryAdmission()).toBeNull();
  });

  it("a SLOW reply cannot overwrite a newer one, and cannot land stamped as fresh", async () => {
    // The out-of-order hazard (roborev 55383). Rust forks sysctl/vm_stat, which is slowest exactly
    // when memory is tight — so the stall this models is likeliest in the case that matters.
    let releaseSlow: (v: unknown) => void = () => {};
    const slow = new Promise((res) => {
      releaseSlow = res;
    });
    // Tick A stalls, carrying a NON-narrowing reading.
    invoke.mockReturnValueOnce(slow);
    const a = refreshMemoryAdmission(2);

    // Tick B answers first with a narrowing reading.
    now += MEMORY_ADMISSION_POLL_MS;
    invoke.mockResolvedValueOnce(admission({ effective: 2, bound: "pressure" }));
    await refreshMemoryAdmission(2);
    expect(currentMemoryAdmission()?.effective).toBe(2);

    // Now A finally resolves with its older, laxer view. It must be discarded.
    now += 1_000;
    releaseSlow(admission({ effective: 11, bound: "cpu" }));
    await a;
    expect(currentMemoryAdmission()?.effective).toBe(2);
  });

  it("a SUSTAINEDLY slow backend still keeps the cache fresh — overlapping polls do not starve it", async () => {
    // roborev 55425. The first sequencing guard compared against the last ISSUED request, so a reply
    // was accepted only if NO newer tick had fired meanwhile. App.tsx ticks unconditionally every 5s,
    // so with latency above the poll interval every reply is superseded before it lands and NOTHING
    // is ever cached — the TTL then expires the last good reading and the ceiling reverts to the
    // static prediction. The sampler forks sysctl/vm_stat, which is slowest exactly when memory is
    // tight, so that starved the gate precisely in the condition it exists for.
    //
    // The previous tests could not catch this: they modelled ONE stalled call, and one stall is the
    // case the broken guard handled correctly.
    // The INTERLEAVING is the whole test, and getting it wrong makes this vacuous. Firing N polls and
    // then resolving them all leaves the last one still equal to `latestRequest`, so it applies even
    // under the broken guard and the test passes against the bug. The real pattern is that a newer
    // tick is ALWAYS outstanding when a reply lands: issue, issue, resolve, issue, resolve, ...
    const resolvers: Array<(v: unknown) => void> = [];
    invoke.mockImplementation(
      () =>
        new Promise((res) => {
          resolvers.push(res);
        }),
    );

    const inFlight: Array<Promise<void>> = [];
    const tick = () => {
      inFlight.push(refreshMemoryAdmission(2));
      now += MEMORY_ADMISSION_POLL_MS;
    };

    tick(); // seq 1
    tick(); // seq 2 — now outstanding, so seq 1 is no longer "latest"
    for (let i = 0; i < 3; i += 1) {
      resolvers[i]?.(admission({ effective: 3 + i }));
      await Promise.resolve();
      tick(); // a newer request is always in flight when the next reply lands
    }
    await Promise.all(inFlight.slice(0, 3));

    // Under the old guard every one of those replies was superseded and NOTHING was ever cached.
    const got = currentMemoryAdmission();
    expect(got).not.toBeNull();
    expect(got?.effective).toBe(5); // 3 + 2, the newest reply that resolved
  });

  it("a reply in flight across resetMemoryAdmission() is dropped, not applied into the cleared cache", async () => {
    // roborev 55450. Switching the guard to `seq <= lastApplied` while reset zeroed BOTH counters
    // inverted this seam: an in-flight seq=1 reply evaluated `1 <= 0` as false, applied into the
    // freshly cleared cache, and then set lastApplied=1 — swallowing later replies too. The old
    // `seq !== latestRequest` guard dropped it. This is the isolation beforeEach/afterEach depend on,
    // and the starvation test above deliberately leaves promises unresolved, which is that shape.
    let release: (v: unknown) => void = () => {};
    invoke.mockReturnValueOnce(
      new Promise((res) => {
        release = res;
      }),
    );
    const inFlight = refreshMemoryAdmission(2);

    resetMemoryAdmission();
    expect(currentMemoryAdmission()).toBeNull();

    release(admission({ effective: 3 }));
    await inFlight;

    // Must still be null — the pre-reset reply has no business populating a cache that was cleared.
    expect(currentMemoryAdmission()).toBeNull();

    // ...and the seam is not wedged: a fresh request after the reset applies normally.
    invoke.mockResolvedValueOnce(admission({ effective: 4 }));
    await refreshMemoryAdmission(2);
    expect(currentMemoryAdmission()?.effective).toBe(4);
  });

  it("a LATE rejection cannot evict a newer good reading", async () => {
    let rejectSlow: (e: unknown) => void = () => {};
    const slow = new Promise((_res, rej) => {
      rejectSlow = rej;
    });
    invoke.mockReturnValueOnce(slow);
    const a = refreshMemoryAdmission(2);

    invoke.mockResolvedValueOnce(admission({ effective: 4 }));
    await refreshMemoryAdmission(2);
    expect(currentMemoryAdmission()?.effective).toBe(4);

    rejectSlow(new Error("the stalled call finally gave up"));
    await a;
    expect(currentMemoryAdmission()?.effective).toBe(4);
  });

  it("rejects a payload whose effective is not a finite number, rather than caching NaN", async () => {
    invoke.mockResolvedValue({ ...admission(), effective: "lots" });
    await refreshMemoryAdmission(1);
    expect(currentMemoryAdmission()).toBeNull();

    invoke.mockResolvedValue({ ...admission(), effective: Number.NaN });
    await refreshMemoryAdmission(1);
    expect(currentMemoryAdmission()).toBeNull();
  });

  it("caches null when the command resolves with nothing at all", async () => {
    invoke.mockResolvedValue(undefined);
    await refreshMemoryAdmission(1);
    expect(currentMemoryAdmission()).toBeNull();
  });
});

describe("currentMemoryAdmission staleness", () => {
  it("returns the reading right up to the TTL, then null once it expires", async () => {
    invoke.mockResolvedValue(admission());
    await refreshMemoryAdmission(1);

    now += MEMORY_ADMISSION_TTL_MS - 1;
    expect(currentMemoryAdmission()?.effective).toBe(3);

    now += 1; // exactly TTL old
    expect(currentMemoryAdmission()).toBeNull();
  });

  it("a spike does not hold the ceiling down forever — a later refresh replaces the expired one", async () => {
    invoke.mockResolvedValue(admission({ effective: 1 }));
    await refreshMemoryAdmission(1);
    now += MEMORY_ADMISSION_TTL_MS * 2;
    expect(currentMemoryAdmission()).toBeNull();

    invoke.mockResolvedValue(admission({ effective: 9, bound: "available" }));
    await refreshMemoryAdmission(1);
    expect(currentMemoryAdmission()?.effective).toBe(9);
  });

  it("a clock that jumps BACKWARD expires the reading instead of freezing it fresh", async () => {
    invoke.mockResolvedValue(admission());
    await refreshMemoryAdmission(1);
    now -= MEMORY_ADMISSION_TTL_MS * 3; // NTP correction / manual time change
    expect(currentMemoryAdmission()).toBeNull();
  });

  it("returns null before anything has ever been sampled", () => {
    expect(currentMemoryAdmission()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("poll/TTL relationship", () => {
  it("keeps TTL at >= 3x the poll interval, so one dropped sample never expires the narrowing", () => {
    // Load-bearing, and documented as such in both files: if a later tweak lowers the TTL toward
    // the poll interval, normal jitter starts flickering the ceiling. Assert the pair, not either
    // number alone.
    expect(MEMORY_ADMISSION_TTL_MS).toBeGreaterThanOrEqual(MEMORY_ADMISSION_POLL_MS * 3);
  });
});
