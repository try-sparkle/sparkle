import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import {
  localAgentProcessIds,
  currentAgentRss,
  buildConcurrencySample,
  recordPeakConcurrency,
  refreshPeakRecord,
  currentPeakRecord,
  peakSummary,
  resetPeakConcurrency,
  type PeakRecord,
} from "./peakConcurrency";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAgentWatchdogStore } from "../stores/agentWatchdogStore";
import type { WatchdogReport, WatchdogVerdict } from "./agentMemoryWatchdog";
import { resetMemoryAdmission } from "./memoryAdmission";
import { markProjectVisited, resetVisitedProjects } from "./sessionProjects";
// THE SAME BYTES THE RUST AND SHELL SUITES PARSE. The contract names this file as the canonical
// instance precisely so the three halves cannot drift apart silently — a hand-written literal here
// would pass forever against a serde shape nobody else produces (`sparkle-16y6h`).
import fixture from "../../../../scripts/tests/fixtures/peak-concurrency.json";

const FIXTURE = fixture as unknown as PeakRecord;

// The static ceiling for every test below, seeded the way agentCapacity.test.ts does it.
const STATIC_LIMIT = 12;
const STATIC_BASIS = "CPU-bound: 6 cores × 2 agents per core";

interface SeedAgent {
  id: string;
  kind: "build" | "worker" | "shell";
  runtime?: "local" | "cloud";
  parentId?: string | null;
}

/** Seed one visited project with exactly these rows, and `open` as the mounted subset. */
function seed(agents: SeedAgent[], open: string[]): void {
  useProjectStore.setState({
    selectedProjectId: "p1",
    projects: [
      {
        id: "p1",
        agents: agents.map((a) => ({ runtime: "local", parentId: null, ...a })),
      },
    ],
  } as never);
  markProjectVisited("p1");
  useRuntimeStore.setState({ openAgentIds: open } as never);
  useSettingsStore.setState({
    maxConcurrentWorkers: STATIC_LIMIT,
    effectiveMaxConcurrentWorkers: STATIC_LIMIT,
    machineMaxConcurrentWorkers: STATIC_LIMIT,
    concurrencyBasis: STATIC_BASIS,
    concurrencyBound: "cpu",
  } as never);
}

function verdict(over: Partial<WatchdogVerdict> & Pick<WatchdogVerdict, "agent_id">): WatchdogVerdict {
  return {
    root_pid: 1234,
    rss_bytes: 1_073_741_824,
    proc_count: 2,
    level: "ok",
    kill_offered: false,
    auto_kill: false,
    message: "",
    ...over,
  };
}

/** Push a watchdog report into the store the way `refreshAgentWatchdog` does on the shared tick.
 *
 * Through the store's own `setReport`, NOT `setState({ report })`. The action is what advances the
 * `seq` that marks a report as a distinct reading, and consumers dedupe folds on it — seeding
 * around the action would leave `seq` frozen at 0 and make every "is this a new report" assertion
 * vacuous while looking perfectly reasonable. */
function seedWatchdog(verdicts: WatchdogVerdict[]): void {
  const report: WatchdogReport = {
    verdicts,
    sample: null,
    coalition_bytes: 0,
    unavailable: false,
  };
  useAgentWatchdogStore.getState().setReport(report);
}

beforeEach(() => {
  invoke.mockReset();
  resetPeakConcurrency();
  resetVisitedProjects();
  // agentCapacity consults the memory-admission cache; a leaked narrowing reading from another
  // suite would move `limit` out from under the assertions here.
  resetMemoryAdmission();
  useAgentWatchdogStore.setState({ report: null });
  seed(
    [
      { id: "b1", kind: "build" },
      { id: "w1", kind: "worker", parentId: "b1" },
    ],
    ["b1", "w1"],
  );
});

afterEach(() => {
  resetPeakConcurrency();
  resetVisitedProjects();
  resetMemoryAdmission();
  useAgentWatchdogStore.setState({ report: null });
});

describe("COUNTS AGENT ROWS, NOT EVERY ROW", () => {
  it("carries exactly the LOCAL build + worker ids, and neither the cloud row nor the shell", () => {
    seed(
      [
        { id: "build-local", kind: "build" },
        { id: "worker-local", kind: "worker", parentId: "build-local" },
        { id: "build-cloud", kind: "build", runtime: "cloud" },
        { id: "shell-local", kind: "shell" },
      ],
      ["build-local", "worker-local", "build-cloud", "shell-local"],
    );

    const ids = localAgentProcessIds();

    // BY ID, not by count. A length assertion alone passes against an implementation that dropped
    // the worker and kept the shell — the exact substitution this list must never make. Rust
    // intersects this with its live PTY sessions, so a shell id in here would be counted as an
    // agent process and inflate the headline the founder means to quote publicly.
    expect(ids).toContain("build-local");
    expect(ids).toContain("worker-local");
    expect(ids).not.toContain("build-cloud");
    expect(ids).not.toContain("shell-local");
    expect(ids).toEqual(["build-local", "worker-local"]);

    // And the payload carries that same list — not a re-derived one.
    expect(buildConcurrencySample().agentIds).toEqual(["build-local", "worker-local"]);
  });
});

describe("`live` AND `used` ARE NOT INTERCHANGEABLE", () => {
  // The precedent is `pollMemoryAdmission` (roborev 55383): a count sent from an inline App.tsx
  // effect shipped as `used` where `live` was required, and nothing could catch it because the only
  // available assertion was that SOME number was forwarded. Here BOTH are carried, so the guard has
  // to be that each lands in its own field — with values that differ, or a swap passes.
  function seedWithDormantRows(): void {
    // 9 local build rows; only 3 have a mounted pane. Rows in an unvisited project tab hold a slot
    // with no pane and no PTY — `live < used` is normal, not a bug.
    seed(
      Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, kind: "build" as const })),
      ["a0", "a1", "a2"],
    );
  }

  it("puts live in `live` and used in `used`, with distinct values so a swap fails", () => {
    seedWithDormantRows();
    const sample = buildConcurrencySample();

    expect(sample.live).toBe(3);
    expect(sample.used).toBe(9);
    // Stated explicitly: the two must not be the same number in this fixture, or the assertions
    // above would hold just as well for an implementation that sent one value twice.
    expect(sample.live).not.toBe(sample.used);
    // `used` is the row count, and it is what `agentIds` enumerates.
    expect(sample.agentIds).toHaveLength(sample.used);
  });

  it("carries the enforced ceiling and its basis alongside them", () => {
    seedWithDormantRows();
    const sample = buildConcurrencySample();
    expect(sample.limit).toBe(STATIC_LIMIT);
    expect(sample.basis).toBe(STATIC_BASIS);
  });
});

describe("THE HEADLINE IS NOT COMPUTED HERE", () => {
  it("sends exactly the contract's six keys and nothing that claims to be the peak", () => {
    seedWatchdog([verdict({ agent_id: "b1" })]);
    const sample = buildConcurrencySample();

    // The whole key set, sorted — an EXACT match, so an added field is a failure rather than a
    // silent widening of a frozen wire shape.
    expect(Object.keys(sample).sort()).toEqual(
      ["agentIds", "agentRss", "basis", "limit", "live", "used"].sort(),
    );
    // `processes` is Rust's, computed as the intersection of `agentIds` with its live PTY sessions:
    // the frontend owns "which rows are agents", Rust owns "which of those are really running".
    // A frontend-computed process count is the number that would be wrong in the permissive
    // direction, and it is the one the founder means to quote publicly.
    expect(sample).not.toHaveProperty("processes");
    expect(sample).not.toHaveProperty("peak");
    expect(Object.keys(sample)).not.toContain("total_ram_bytes");
    // Rust reads the clock and the machine itself, so a wrong client cannot forge a peak's time or
    // inflate the RAM it is compared against.
    expect(Object.keys(sample).some((k) => /at_ms|at_iso|timestamp/i.test(k))).toBe(false);
  });
});

describe("PER-AGENT TREE RSS PASSES THROUGH UNTOUCHED", () => {
  // `sparkle-mjmuj` — an agent is a process TREE (mean ~1.95 processes, peak 5). A "520 MB per
  // agent" claim was made twice from PER-PROCESS data and was wrong both times. This suite is the
  // guard against that reshaping re-entering here: the only acceptable source is a watchdog verdict,
  // whose `rss_bytes` is already the whole descendant tree.
  const TREE_A = 1_207_959_552; // ~1.125 GiB across 2 processes
  const TREE_B = 2_684_354_560; // ~2.5 GiB across 3 processes
  const TREE_C = 402_653_184; //  ~384 MiB, a single-process agent

  beforeEach(() => {
    seedWatchdog([
      verdict({ agent_id: "b1", rss_bytes: TREE_A, proc_count: 2 }),
      verdict({ agent_id: "w1", rss_bytes: TREE_B, proc_count: 3 }),
      verdict({ agent_id: "b2", rss_bytes: TREE_C, proc_count: 1 }),
    ]);
  });

  it("returns each agent's TREE total unchanged, with its proc count", () => {
    expect(currentAgentRss()).toEqual([
      { agentId: "b1", rssBytes: TREE_A, procCount: 2 },
      { agentId: "w1", rssBytes: TREE_B, procCount: 3 },
      { agentId: "b2", rssBytes: TREE_C, procCount: 1 },
    ]);
  });

  it("the mean proc count implied by the payload is ~2, NOT 1 — the per-process tell", () => {
    const { agentRss } = buildConcurrencySample();

    // One entry per AGENT, not one per process. A per-process reshaping would produce 6 entries
    // (2 + 3 + 1) instead of 3, each carrying a fraction of its tree.
    expect(agentRss).toHaveLength(3);

    const procs = agentRss.reduce((n, a) => n + a.procCount, 0);
    const meanProcsPerAgent = procs / agentRss.length;
    // 6 processes across 3 agents. `proc_count` is recorded alongside every RSS figure exactly so
    // this ratio is checkable: **a mean near 1.0 means the data is per-process and the number is
    // wrong.** This assertion fails the moment anyone flattens the list.
    expect(meanProcsPerAgent).toBe(2);
    expect(meanProcsPerAgent).toBeGreaterThan(1.5);

    // And no aggregation happened on the way through: the sum is the sum of the trees, not of pids.
    expect(agentRss.reduce((n, a) => n + a.rssBytes, 0)).toBe(TREE_A + TREE_B + TREE_C);
    // Nothing was averaged or divided — the largest tree is still exactly the largest tree.
    expect(Math.max(...agentRss.map((a) => a.rssBytes))).toBe(TREE_B);
  });

  it("does not filter the report down to rows it recognises as agents", () => {
    // `b2` is in the watchdog report but is NOT one of the seeded project rows. It still goes
    // through: the report is Rust's own attribution of pids to agents, and second-guessing it here
    // would silently drop observations from the distribution the whole record exists to build.
    expect(currentAgentRss().map((a) => a.agentId)).toContain("b2");
  });
});

describe("NO WATCHDOG REPORT ⇒ EMPTY ARRAY", () => {
  it("sends `[]`, not zeros and not an omitted key", () => {
    useAgentWatchdogStore.setState({ report: null });

    expect(currentAgentRss()).toEqual([]);

    const sample = buildConcurrencySample();
    // The key is PRESENT and empty. Rust reads an empty array as "no basis" and leaves the whole
    // memory block byte-for-byte unchanged; fabricating a zero-RSS observation per agent would fold
    // a p50 of 0 into a PERMANENT record, and nothing in the contract ever lowers one back.
    expect(sample).toHaveProperty("agentRss");
    expect(sample.agentRss).toEqual([]);
    expect(sample.agentRss).toHaveLength(0);
    // An unmeasured machine is not an empty one — the same rule `memoryAdmission` states for a null
    // reading. The COUNTS still go, so the peak half of the record is unaffected by this.
    expect(sample.agentIds.length).toBeGreaterThan(0);
  });
});

describe("A FAILING BACKEND IS SILENT", () => {
  it("resolves without throwing when the command does not exist", async () => {
    invoke.mockRejectedValue(new Error("Command record_agent_concurrency not found"));
    // The EXPECTED case on any build predating the command: it rejects every 5s tick, and the poll
    // is not awaited, so a throw would surface as an unhandled rejection forever.
    await expect(recordPeakConcurrency()).resolves.toBeUndefined();
    expect(currentPeakRecord()).toBeNull();
  });

  it("leaves the previously cached record INTACT rather than clearing it to null", async () => {
    invoke.mockResolvedValue(FIXTURE);
    await recordPeakConcurrency();
    expect(currentPeakRecord()?.peak.processes).toBe(41);

    invoke.mockRejectedValue(new Error("transient IPC hiccup"));
    await expect(recordPeakConcurrency()).resolves.toBeUndefined();

    // Clearing here would make `peakSummary()` report `observed: false` — turning one dropped tick
    // into the claim that no peak has ever been recorded, about days of history that are still on
    // disk. A record we could not refresh is still the last one we actually read.
    expect(currentPeakRecord()?.peak.processes).toBe(41);
    expect(peakSummary().observed).toBe(true);
  });

  it("refuses to cache a payload that is not shaped like a record", async () => {
    invoke.mockResolvedValue({ nonsense: true });
    await recordPeakConcurrency();
    expect(currentPeakRecord()).toBeNull();
    expect(peakSummary().observed).toBe(false);
  });

  it("sends the sample under the `sample` key the command expects", async () => {
    invoke.mockResolvedValue(FIXTURE);
    await recordPeakConcurrency();
    expect(invoke).toHaveBeenCalledWith("record_agent_concurrency", {
      sample: buildConcurrencySample(),
    });
  });

  it("refreshPeakRecord reads without merging, and is silent on rejection", async () => {
    invoke.mockResolvedValue(FIXTURE);
    await refreshPeakRecord();
    expect(invoke).toHaveBeenCalledWith("agent_concurrency_peak");
    expect(currentPeakRecord()?.samples).toBe(12345);

    invoke.mockRejectedValue(new Error("nope"));
    await expect(refreshPeakRecord()).resolves.toBeUndefined();
    expect(currentPeakRecord()?.samples).toBe(12345);
  });
});

describe("`currentPeakRecord()` STARTS NULL, and `observed` is what a reader must branch on", () => {
  it("null before anything has been read — which is not the same as a peak of zero", () => {
    expect(currentPeakRecord()).toBeNull();

    const s = peakSummary();
    expect(s.observed).toBe(false);
    expect(s.peakProcesses).toBe(0);
    // "" rather than an epoch or a fabricated now: a peak without a time cannot be corroborated,
    // and a plausible-looking timestamp on a peak that never happened is worse than none.
    expect(s.peakAtIso).toBe("");
    expect(s.peakTotalRamBytes).toBe(0);
    expect(s.hourlySpanHours).toBe(0);
    // The LIVE reading is still real — it is measured here and now, not read off the record.
    expect(s.used).toBe(2);
    expect(s.live).toBe(2);
    expect(s.limit).toBe(STATIC_LIMIT);
    expect(s.basis).toBe(STATIC_BASIS);
  });

  it("reports observed:false for samples === 0 even when a record has been read", async () => {
    // An empty-but-valid record: the file exists, nothing has ever been merged into it. This is the
    // case the contract calls out in the imperative — say "no peak recorded", never "the peak is 0".
    invoke.mockResolvedValue({ ...FIXTURE, samples: 0 } satisfies PeakRecord);
    await recordPeakConcurrency();

    expect(currentPeakRecord()).not.toBeNull();
    const s = peakSummary();
    expect(s.observed).toBe(false);
    // And it does NOT leak the record's peak row through the false flag — a reader that ignored the
    // flag would otherwise quote 41 from a record that has merged nothing.
    expect(s.peakProcesses).toBe(0);
    expect(s.peakAtIso).toBe("");
  });

  it("reports agentRssObserved:false for memory.observed === false", async () => {
    invoke.mockResolvedValue({
      ...FIXTURE,
      memory: { ...FIXTURE.memory, observed: false },
    } satisfies PeakRecord);
    await recordPeakConcurrency();

    const s = peakSummary();
    // The peak half is still observed — the two flags are independent, which is why there are two.
    expect(s.observed).toBe(true);
    expect(s.agentRssObserved).toBe(false);
    expect(s.agentRssP50Bytes).toBe(0);
    expect(s.agentRssP90Bytes).toBe(0);
    // 0, not 1.95 — and a reader seeing 0 with the flag false knows nothing was measured, rather
    // than concluding from a near-1.0 mean that per-process data got in.
    expect(s.meanProcsPerAgent).toBe(0);
  });

  it("both flags true once the real record is cached — pinned to the canonical fixture's bytes", async () => {
    invoke.mockResolvedValue(FIXTURE);
    await recordPeakConcurrency();

    const s = peakSummary();
    expect(s.observed).toBe(true);
    expect(s.agentRssObserved).toBe(true);
    // EXACT values from scripts/tests/fixtures/peak-concurrency.json — the same bytes the Rust and
    // shell suites parse. Pinning them here is what makes a serde-shape change fail on BOTH sides
    // instead of leaving one half green against a wire nobody produces.
    expect(s.peakProcesses).toBe(41);
    expect(s.peakAtIso).toBe("2026-08-22T18:40:00Z");
    expect(s.peakTotalRamBytes).toBe(137_438_953_472);
    expect(s.hourlySpanHours).toBe(2);
    expect(s.agentRssP50Bytes).toBe(1_308_622_848);
    expect(s.agentRssP90Bytes).toBe(1_845_493_760);
    // 1950 milli → 1.95 processes per agent. THE tell: near 1.0 would mean per-process data.
    expect(s.meanProcsPerAgent).toBe(1.95);
    expect(s.meanProcsPerAgent).toBeGreaterThan(1.5);

    // The fixture's own peak row and the LIVE reading are different instants and must not be
    // conflated: the record peaked at 39 live / 47 used, this machine is showing 2 / 2 right now.
    expect(s.live).toBe(2);
    expect(s.used).toBe(2);
    expect(FIXTURE.peak.live).toBe(39);
    expect(FIXTURE.peak.used).toBe(47);
  });

  it("publishes a flat block — no nested record, so get_state does not meaningfully grow", async () => {
    invoke.mockResolvedValue(FIXTURE);
    await recordPeakConcurrency();
    const s = peakSummary() as unknown as Record<string, unknown>;
    // `get_state` is documented as expensive and is permanently resident in every caller's context.
    // The 129-bucket histogram and the 720-entry hourly series must never reach it.
    for (const v of Object.values(s)) {
      expect(["number", "string", "boolean"]).toContain(typeof v);
    }
    expect(s).not.toHaveProperty("hist");
    expect(s).not.toHaveProperty("hourly");
    expect(Object.keys(s).sort()).toEqual(
      [
        "agentRssObserved",
        "agentRssP50Bytes",
        "agentRssP90Bytes",
        "basis",
        "hourlySpanHours",
        "limit",
        "live",
        "meanProcsPerAgent",
        "observed",
        "peakAtIso",
        "peakProcesses",
        "peakTotalRamBytes",
        "used",
      ].sort(),
    );
  });
});

// ── ROBOREV FINDINGS (job 67765) ────────────────────────────────────────────────────────────────
describe("a partial payload cannot poison get_state", () => {
  // The guard asserts `value is PeakRecord`, so whatever it admits is dereferenced as total.
  // A short-but-plausible payload used to pass on `samples` + `peak.processes` alone and then throw
  // inside peakSummary() — which runs synchronously in handleGetState, turning the ENTIRE get_state
  // reply into an error, on every scope, for every caller, PERMANENTLY (the cache is never cleared,
  // so only a well-shaped record could displace it). The old suite only tried `{nonsense: true}`,
  // which the guard already rejected, so it could not see this.
  it("refuses a payload missing hourly/memory rather than caching it", async () => {
    resetPeakConcurrency();
    invoke.mockResolvedValueOnce({ samples: 1, peak: { processes: 5 } });
    await recordPeakConcurrency();
    expect(currentPeakRecord()).toBeNull();
  });

  it("peakSummary() stays total after such a payload — it does not throw", async () => {
    resetPeakConcurrency();
    invoke.mockResolvedValueOnce({ samples: 1, peak: { processes: 5 } });
    await recordPeakConcurrency();
    expect(() => peakSummary()).not.toThrow();
    const s = peakSummary();
    expect(s.observed).toBe(false);
    expect(s.peakAtIso).toBe("");
    expect(s.hourlySpanHours).toBe(0);
    expect(typeof s.peakTotalRamBytes).toBe("number");
  });
});

describe("hourlySpanHours is a SPAN, not an entry count", () => {
  // `hourly` is sparse — an entry exists only for hours in which samples were merged. The two
  // definitions agree only when every hour happens to be contiguous, which is exactly what the
  // canonical fixture contains, so a test pinned to it cannot tell them apart. This record has a
  // GAP: two entries, six hours apart.
  const sparse = {
    ...FIXTURE,
    samples: 10,
    hourly: [
      { ...FIXTURE.hourly[0], hour_start_ms: 1787418000000, hour_start_iso: "2026-08-22T17:00:00Z" },
      { ...FIXTURE.hourly[0], hour_start_ms: 1787439600000, hour_start_iso: "2026-08-22T23:00:00Z" },
    ],
  };

  it("reports 7 hours for two entries six hours apart, not 2", async () => {
    resetPeakConcurrency();
    invoke.mockResolvedValueOnce(sparse);
    await recordPeakConcurrency();
    expect(peakSummary().hourlySpanHours).toBe(7);
  });

  it("is 0 for an empty series", async () => {
    resetPeakConcurrency();
    invoke.mockResolvedValueOnce({ ...FIXTURE, samples: 10, hourly: [] });
    await recordPeakConcurrency();
    expect(peakSummary().hourlySpanHours).toBe(0);
  });
});

describe("each watchdog report is folded at most once", () => {
  // Rust adds every entry to a PERMANENT, never-lowered distribution. The poller leaves the
  // PREVIOUS report in the store when an invoke rejects or a reply lands out of order — likeliest
  // when forking `ps` is slow, i.e. under the very memory pressure being measured. Unguarded, one
  // snapshot would be folded 17,280 times a day, biased toward the unluckiest instant.
  it("sends the observations once, then [] until a NEW report arrives", async () => {
    resetPeakConcurrency();
    seedWatchdog([verdict({ agent_id: "a", rss_bytes: 1_000_000_000, proc_count: 2 })]);

    expect(currentAgentRss()).toHaveLength(1);
    invoke.mockResolvedValueOnce(FIXTURE);
    await recordPeakConcurrency();
    expect(invoke.mock.calls[0]?.[1]?.sample.agentRss).toHaveLength(1);

    // Same report still in the store: nothing new was measured, so nothing may be folded again.
    expect(currentAgentRss()).toEqual([]);
    invoke.mockResolvedValueOnce(FIXTURE);
    await recordPeakConcurrency();
    expect(invoke.mock.calls[1]?.[1]?.sample.agentRss).toEqual([]);

    // A genuinely new reading is folded.
    seedWatchdog([verdict({ agent_id: "a", rss_bytes: 1_200_000_000, proc_count: 3 })]);
    expect(currentAgentRss()).toHaveLength(1);
  });

  it("a REJECTED invoke does not consume the reading — it is still eligible next tick", async () => {
    resetPeakConcurrency();
    seedWatchdog([verdict({ agent_id: "a", rss_bytes: 1_000_000_000, proc_count: 2 })]);
    expect(currentAgentRss()).toHaveLength(1);
    invoke.mockRejectedValueOnce(new Error("command not found"));
    await recordPeakConcurrency();
    // The fold never reached Rust, so advancing on SEND would have silently dropped it.
    expect(currentAgentRss()).toHaveLength(1);
  });
});

// ── ROBOREV FINDINGS (job 67780) ────────────────────────────────────────────────────────────────
describe("the fold-once guard survives OVERLAPPING ticks", () => {
  // recordPeakConcurrency is void-ed from a 5s setInterval with no in-flight guard. Every earlier
  // test awaited each call before the next, so two samples were never in flight together and the
  // race was structurally invisible — the tests could not have caught it.
  it("a second tick starting before the first resolves sends NO agentRss", async () => {
    resetPeakConcurrency();
    seedWatchdog([verdict({ agent_id: "a", rss_bytes: 1_000_000_000, proc_count: 2 })]);

    let release: ((v: unknown) => void) | undefined;
    invoke.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    invoke.mockResolvedValueOnce(FIXTURE);

    const first = recordPeakConcurrency();   // in flight, holding seq
    const second = recordPeakConcurrency();  // fires while the first is outstanding
    release?.(FIXTURE);
    await Promise.all([first, second]);

    expect(invoke.mock.calls[0]?.[1]?.sample.agentRss).toHaveLength(1);
    // Without a send-time reservation this re-sent the SAME verdicts and Rust folded one snapshot
    // twice into a permanent, never-lowered distribution.
    expect(invoke.mock.calls[1]?.[1]?.sample.agentRss).toEqual([]);
  });

  it("an out-of-order resolution cannot move the marker BACKWARDS", async () => {
    resetPeakConcurrency();
    // TWO DISTINCT reports in flight at once, with the LATER one resolving FIRST. Awaiting each
    // call in turn (as the first draft of this test did) can never produce that interleaving, so it
    // proved nothing about ordering — the failure this guards is specifically a late resolution
    // committing an OLDER seq last.
    seedWatchdog([verdict({ agent_id: "a", rss_bytes: 1_000_000_000, proc_count: 2 })]);
    let releaseOld: ((v: unknown) => void) | undefined;
    invoke.mockImplementationOnce(() => new Promise((r) => { releaseOld = r; }));
    const older = recordPeakConcurrency();          // holds seq N, unresolved

    seedWatchdog([verdict({ agent_id: "a", rss_bytes: 1_100_000_000, proc_count: 2 })]);
    invoke.mockResolvedValueOnce(FIXTURE);
    await recordPeakConcurrency();                  // seq N+1, resolves FIRST -> commits N+1

    releaseOld?.(FIXTURE);                          // the OLDER fold lands last
    await older;

    // A bare assignment would now have the marker back at N, re-admitting the N+1 report.
    expect(currentAgentRss()).toEqual([]);
  });

  it("a DEFLECTED tick cannot clear the reservation held by a still-in-flight tick", async () => {
    // The three-tick interleaving, which neither the two-tick race test nor the sequential ones can
    // produce. Tick 1 reserves the reading and stays in flight. Tick 2 is DEFLECTED — its
    // currentAgentRss() returns [] because the reading is spoken for — but `pendingWatchdogSeq`
    // still holds tick 1's seq, so a deflected tick that compared against it would match and its
    // `finally` would release a claim it never made. Tick 3 would then re-send the SAME verdicts
    // and Rust would fold one snapshot twice.
    resetPeakConcurrency();
    seedWatchdog([verdict({ agent_id: "a", rss_bytes: 1_000_000_000, proc_count: 2 })]);

    let releaseFirst: ((v: unknown) => void) | undefined;
    invoke.mockImplementationOnce(() => new Promise((r) => { releaseFirst = r; }));
    const first = recordPeakConcurrency();      // reserves, stays in flight

    invoke.mockResolvedValueOnce(FIXTURE);
    await recordPeakConcurrency();              // DEFLECTED, resolves first, must clear NOTHING

    // Tick 3, while tick 1 is STILL in flight: the reading must remain spoken for.
    expect(currentAgentRss()).toEqual([]);

    releaseFirst?.(FIXTURE);
    await first;
    // And once it lands it is committed, not merely released.
    expect(currentAgentRss()).toEqual([]);
  });

  it("a rejected invoke RELEASES the reservation rather than pinning the reading out", async () => {
    resetPeakConcurrency();
    seedWatchdog([verdict({ agent_id: "a", rss_bytes: 1_000_000_000, proc_count: 2 })]);
    invoke.mockRejectedValueOnce(new Error("command not found"));
    await recordPeakConcurrency();
    // Still eligible: the fold never reached Rust, so it must not be marked consumed OR left
    // reserved forever.
    expect(currentAgentRss()).toHaveLength(1);
  });
});

describe("hourlySpanHours never publishes NaN", () => {
  // isRecord checks Array.isArray(hourly) and nothing about the ELEMENTS, so a renamed or
  // partially-serialized entry used to reach the arithmetic and yield NaN — which serializes to
  // null over JSON, in the one temporal figure the concierge quotes beside the peak.
  it("an hourly entry missing hour_start_ms yields 0, not NaN", async () => {
    resetPeakConcurrency();
    invoke.mockResolvedValueOnce({
      ...FIXTURE,
      samples: 10,
      hourly: [{ hourStartMs: 1787418000000 }, { hourStartMs: 1787421600000 }],
    });
    await recordPeakConcurrency();
    const span = peakSummary().hourlySpanHours;
    expect(Number.isNaN(span)).toBe(false);
    expect(span).toBe(0);
  });

  it("a non-object hourly entry also yields 0", async () => {
    resetPeakConcurrency();
    invoke.mockResolvedValueOnce({ ...FIXTURE, samples: 10, hourly: [1787418000000, "x"] });
    await recordPeakConcurrency();
    expect(peakSummary().hourlySpanHours).toBe(0);
  });
});

