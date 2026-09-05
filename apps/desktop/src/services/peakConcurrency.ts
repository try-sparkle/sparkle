// The frontend half of the PERSISTENT concurrency + per-agent-memory record.
//
// `docs/peak-concurrency.md` is the frozen contract for the on-disk file and for BOTH wire
// directions; this module is only the sampler that feeds it and the cached read the concierge
// quotes. Two things it records, and the second is the more valuable half:
//
//   1. How many agents ran at once — a persistent peak, so a public claim has evidence behind it.
//      Before this, NOTHING in the app wrote a peak down; a peak that resets on relaunch is what
//      left us with no history at all.
//   2. What one agent actually costs in RAM — a persistent distribution of per-agent TREE RSS, so
//      the ceiling that number feeds can be re-grounded in a measurement instead of an assumption
//      (`config.rs` currently divides by half an assumed V8 heap ceiling; the measured term loses).
//
// WHY EVERY PAYLOAD FIELD IS BUILT IN A NAMED FUNCTION HERE, and not inline in the App.tsx tick:
// `agentCapacity.pollMemoryAdmission`'s docstring records the precedent. **Which count gets sent is
// a correctness decision, and inline in `App.tsx` it was not unit-testable** — it shipped wrong once
// (`used` where Rust needed `live`) and nothing could have caught it, because the only assertion
// available was that some number was forwarded. This module exists so every one of those decisions
// is a function a test can drive directly.
//
// ── THE TRAP: per-process RSS is NOT per-agent RSS ───────────────────────────────────────────────
//
// An agent is a process TREE — measured mean ~1.95 processes, peak 5 under subagent fan-out. A
// "520 MB per agent" claim was made twice from per-process data and was wrong both times; bead
// `sparkle-mjmuj` is the standing refutation and says in its own title not to re-derive it.
//
// `currentAgentRss()` below is the ONE place that trap can re-enter. The only acceptable source is
// `memwatch::agent_footprints` — already exposed as `agent_memory_watchdog`, already polled on this
// same 5s tick — which walks each root's descendant tree and attributes each pid to at most one
// agent. `scripts/agent-mem.sh` is NOT an acceptable source: its own header says it reports the
// coalition and matches on process basename, which is exactly the per-process view that produced
// the two wrong answers. So: never sum, average, divide or reshape a verdict's `rss_bytes` here.
// Each agent's tree total goes through untouched and Rust aggregates. `procCount` rides along on
// every observation precisely so a reader can tell: **a mean near 1.0 processes/agent means the
// data is per-process and the number is wrong.**
import { invoke } from "@tauri-apps/api/core";
import { useProjectStore } from "../stores/projectStore";
import { useAgentWatchdogStore } from "../stores/agentWatchdogStore";
import { localAgentCapacity } from "./agentCapacity";

// ── THE WIRE, both directions ────────────────────────────────────────────────────────────────────
//
// EVERY FIELD IS REQUIRED — no `field?: T`, in either direction. A Rust `Option` crosses the wire as
// `null`, NEVER as an absent key, so `field?: T` (which means `T | undefined`) describes a shape the
// wire cannot produce; an all-or-nothing parser then discards the whole payload and the feature is
// inert forever with nothing logged (`sparkle-16y6h` — two halves built in parallel against a frozen
// field list, both suites green, the shipped feature never once ran). The contract guarantees Rust
// emits every key with a TOTAL value for exactly this reason: unknowns are in-band (`basis` is `""`,
// counts are `0`, `hourly` is `[]`).
//
// INPUT is camelCase (serde `rename_all = "camelCase"` on the command argument); OUTPUT is
// snake_case, matching `memoryAdmission.MemorySample`, which reads Rust's default serde casing.

/** One agent's whole DESCENDANT PROCESS TREE, straight from a `WatchdogVerdict`. Not one pid. */
export interface AgentRssIn {
  agentId: string;
  /** The tree total. Passed through untouched — see the trap note in this file's header. */
  rssBytes: number;
  /** How many processes that total covers. ~1.95 typical; near 1.0 means the data is per-process. */
  procCount: number;
}

/** The `record_agent_concurrency` argument. Exactly six keys — see `buildConcurrencySample`. */
export interface ConcurrencySampleIn {
  /** Local build/worker ROW ids. Rust intersects these with live PTY sessions to get the headline. */
  agentIds: string[];
  /** `localAgentCapacity().live` — window-local mounted panes. Stored, never the headline. */
  live: number;
  /** `localAgentCapacity().used` — every local build/worker row. Stored, never the headline. */
  used: number;
  limit: number;
  /** `""` when unknown; never omitted. */
  basis: string;
  /** Per-AGENT tree RSS. EMPTY means "no basis" and must leave the whole memory block unchanged. */
  agentRss: AgentRssIn[];
}

/** The moment of the peak. Replaced as ONE row, so these can never describe different instants. */
export interface PeakRow {
  /** THE NUMBER: live agent PTY processes, app-wide, counted in Rust. `headline` names this field. */
  processes: number;
  live: number;
  used: number;
  limit: number;
  basis: string;
  total_ram_bytes: number;
  at_ms: number;
  at_iso: string;
}

/** The all-time per-AGENT tree-RSS distribution. Read the trap note above before quoting any of it. */
export interface PeakMemory {
  /** False ⇒ never sampled, and every number below is then 0 — NOT "agents cost nothing". */
  observed: boolean;
  /** One per agent per sample — NOT a count of agents. */
  agent_observations: number;
  agents_seen_max: number;
  /** Derived from `hist`, so its resolution is ±32 MiB. Never quote it more precisely. */
  p50_bytes: number;
  p90_bytes: number;
  /** EXACT, not bucketed — a bucketed max would understate the worst case, which is the whole point. */
  max_bytes: number;
  min_bytes: number;
  proc_count_total: number;
  proc_count_max: number;
  /** 1950 = 1.950 processes/agent. NEAR 1000 ⇒ THE DATA IS PER-PROCESS. */
  mean_proc_count_milli: number;
  hist_bucket_bytes: number;
  /** 129 counts; index 128 is the overflow bucket for everything >= 8 GiB. */
  hist: number[];
  first_at_ms: number;
  first_at_iso: string;
  last_at_ms: number;
  last_at_iso: string;
}

/** One hour of the rolling series. MEAN and MAX for memory — never percentiles; see the contract. */
export interface PeakHour {
  hour_start_ms: number;
  hour_start_iso: string;
  processes: number;
  live: number;
  used: number;
  limit: number;
  total_ram_bytes: number;
  agent_observations: number;
  /** ÷ `agent_observations` is the hourly MEAN. Say "mean", not "p50" — they differ a lot here. */
  rss_sum_bytes: number;
  rss_max_bytes: number;
  proc_count_total: number;
}

/** The whole on-disk record, as `agent_concurrency_peak` / `record_agent_concurrency` return it. */
export interface PeakRecord {
  version: number;
  /** Which field IS the claim — recorded rather than assumed, so nobody re-derives the wrong one. */
  headline: string;
  peak: PeakRow;
  memory: PeakMemory;
  /** Oldest first, at most 720 entries (~30 days). `[]` when nothing has been recorded. */
  hourly: PeakHour[];
  /** `peak.processes === 0` with `samples === 0` means NOTHING HAS BEEN OBSERVED YET. */
  samples: number;
  updated_at_ms: number;
  updated_at_iso: string;
}

/**
 * The ids of every LOCAL build/worker ROW, across every project.
 *
 * The SAME population `localAgentCapacity()` counts as `used` — cloud agents excluded (they run in a
 * server sandbox and consume none of this machine's RAM), and every kind that is not `build` or
 * `worker` excluded (a shell is not a model process). This list is "rows that COULD be an agent
 * process"; Rust intersects it with `PtyManager::session_pids()` to get the headline, because Rust
 * cannot tell a build agent from a shell — a session id is just an agent id. Frontend owns "which
 * rows are agents", Rust owns "which of those are really running". Neither half can report a peak
 * on its own, which is the point.
 */
export function localAgentProcessIds(): string[] {
  const { projects } = useProjectStore.getState();
  const ids: string[] = [];
  for (const p of projects) {
    for (const a of p.agents) {
      if (a.runtime === "cloud" || (a.kind !== "build" && a.kind !== "worker")) continue;
      ids.push(a.id);
    }
  }
  return ids;
}

/**
 * Per-agent tree RSS, from the CACHED watchdog report `refreshAgentWatchdog()` already fetched on
 * this same tick. `[]` when no report is cached — which the contract requires Rust read as "no
 * basis", leaving the whole memory block byte-for-byte unchanged.
 *
 * THIS IS THE ONE PLACE THE PER-PROCESS TRAP CAN RE-ENTER (`sparkle-mjmuj`). `rss_bytes` on a
 * verdict is a whole DESCENDANT PROCESS TREE, already attributed by `memwatch::agent_footprints`.
 * Nothing here sums, averages, divides or reshapes it: each agent's tree total is passed through
 * untouched with its `proc_count`, and Rust aggregates. Reshaping this into a per-process list is
 * exactly how a "520 MB per agent" claim got made twice and was wrong both times.
 *
 * It round-trips through the frontend rather than being re-derived inside `record_agent_concurrency`
 * for one reason: `agent_footprints` needs a full uncached `ps -axo`, and running that a SECOND time
 * every 5 seconds — on a machine with hundreds of processes, which is exactly the condition the
 * watchdog exists to detect — is the cost `agent_memory_watchdog`'s own doc comment warns about. The
 * numbers originate in Rust either way. The consequence, stated rather than hidden: this report is
 * up to one tick (5s) stale relative to the counts in the same payload. Immaterial to a distribution
 * accumulated over days, and it is why the memory half carries its own first/last timestamps.
 */
export function currentAgentRss(): AgentRssIn[] {
  const { report, seq } = useAgentWatchdogStore.getState();
  if (!report || !Array.isArray(report.verdicts)) return [];
  // EACH REPORT IS FOLDED AT MOST ONCE. Rust adds every entry to a PERMANENT, never-lowered
  // distribution, so re-sending an unchanged report does not merely waste work — it silently biases
  // a measurement nothing can afterwards undo, and this record exists precisely to re-ground an
  // assumed divisor in a real one.
  //
  // The poller leaves the PREVIOUS report in the store whenever an invoke rejects or a reply lands
  // out of order (services/agentMemoryWatchdog), and that is likeliest exactly when forking `ps` is
  // slow — i.e. under the memory pressure being measured. Unguarded, a watchdog that starts failing
  // would fold one snapshot 17,280 times a day, weighted toward the unluckiest instant.
  //
  // Returning `[]` is the contracted "no basis" path: Rust leaves the memory block byte-for-byte
  // unchanged. An unmeasured tick is not an empty machine.
  if (seq === lastFoldedWatchdogSeq || seq === inFlightWatchdogSeq) return [];
  pendingWatchdogSeq = seq;
  return report.verdicts.map((v) => ({
    agentId: v.agent_id,
    rssBytes: v.rss_bytes,
    procCount: v.proc_count,
  }));
}

/**
 * The whole `record_agent_concurrency` argument — the six keys of the contract's Input block, and
 * nothing else. It deliberately carries NO field claiming to be the peak or the process count:
 * `processes` is Rust's to compute, from the intersection of `agentIds` with its live PTY sessions.
 *
 * ONE `localAgentCapacity()` call, destructured. Calling it twice in one expression is a bug this
 * codebase has already fixed once — two readings milliseconds apart can disagree, and `live`/`used`/
 * `limit`/`basis` describe a single instant or they describe nothing.
 */
export function buildConcurrencySample(): ConcurrencySampleIn {
  const { live, used, limit, basis } = localAgentCapacity();
  return {
    agentIds: localAgentProcessIds(),
    live,
    used,
    limit,
    basis,
    agentRss: currentAgentRss(),
  };
}

/**
 * The cached record. `null` means WE HAVE NOT READ ONE — never "the peak is zero".
 *
 * Cached rather than awaited because `handleGetState` in services/controlListener is SYNCHRONOUS,
 * and the concierge's read of this goes through it. Same poll-and-cache shape as
 * `memoryAdmission.currentMemoryAdmissionReading`, and for the same reason.
 */
let cached: PeakRecord | null = null;

/**
 * The watchdog `seq` most recently folded into the record, and the one a sample in flight WOULD
 * fold. They are separate because a fold only counts once Rust has accepted it: if the invoke
 * rejects, the observations never reached the distribution and the same report must still be
 * eligible next tick. Advancing on send instead would DROP a reading on every transient IPC error.
 */
let lastFoldedWatchdogSeq = 0;
let pendingWatchdogSeq = 0;
/**
 * The seq of a fold that has been SENT but not yet accepted. Reserved at send time, because
 * `recordPeakConcurrency` is `void`-ed from a 5s interval with NO in-flight guard: tick 2 fires
 * while tick 1 is still awaiting Rust, `lastFoldedWatchdogSeq` is still behind, and the SAME
 * verdicts go out twice — one snapshot folded twice into a permanent, never-lowered distribution.
 * The trigger is a slow round trip under memory pressure, which is the exact regime the fold-once
 * guard exists for, so checking only the committed marker fails precisely when it matters.
 *
 * `0` means nothing is outstanding. Cleared rather than committed on rejection, so a failed invoke
 * leaves the reading eligible next tick instead of silently dropping it.
 */
let inFlightWatchdogSeq = 0;

/** Test seam — drop the cache, so one test's record can't leak into the next. */
export function resetPeakConcurrency(): void {
  cached = null;
  lastFoldedWatchdogSeq = 0;
  pendingWatchdogSeq = 0;
  inFlightWatchdogSeq = 0;
}

function isRecord(value: unknown): value is PeakRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<PeakRecord>;
  // EVERY field `peakSummary()` dereferences must be checked here, not just the two it branches on.
  //
  // This guard asserts `value is PeakRecord`, so whatever it admits is treated downstream as
  // total. A short-but-plausible payload — a backend at a different contract version, a v2 that
  // renames `hourly`, a partially-serialized record — used to pass on `samples` + `peak.processes`
  // alone and then throw `Cannot read properties of undefined` inside `peakSummary()`. That runs
  // synchronously inside `handleGetState`, so the throw turns the ENTIRE `get_state` reply into an
  // error, on every scope, for every caller, PERMANENTLY: the cache is deliberately never cleared,
  // so only a well-shaped record can ever displace the poisoned one.
  //
  // That is the all-or-nothing partial-parse failure (`sparkle-16y6h`) this module's header cites,
  // relocated one level up — the guard meant to prevent it was validating 2 of 8 top-level keys.
  if (typeof r.samples !== "number") return false;
  if (!Array.isArray(r.hourly)) return false;
  const peak = r.peak;
  if (!peak || typeof peak !== "object") return false;
  if (typeof peak.processes !== "number") return false;
  if (typeof peak.at_iso !== "string") return false;
  if (typeof peak.total_ram_bytes !== "number") return false;
  const memory = r.memory;
  if (!memory || typeof memory !== "object") return false;
  if (typeof memory.observed !== "boolean") return false;
  if (typeof memory.p50_bytes !== "number") return false;
  if (typeof memory.p90_bytes !== "number") return false;
  if (typeof memory.mean_proc_count_milli !== "number") return false;
  return true;
}

/**
 * ONE sample: build the payload, merge it in Rust, cache what comes back.
 *
 * Fire-and-forget from the App.tsx tick — NEVER throws and never rejects. A REJECTED invoke is the
 * EXPECTED case, not an error path: the command does not exist on any build predating it, so an
 * older backend rejects with "command not found" on every tick, and the poll is not awaited, so a
 * throw would surface as an unhandled rejection every few seconds forever. Exactly how
 * `refreshAgentWatchdog` and `refreshMemoryAdmission` already behave.
 *
 * A failure does NOT clear the cache. A record we could not refresh is still the last thing we
 * actually read, and dropping it to `null` would make `peakSummary()` report `observed: false` —
 * i.e. turn one transient IPC hiccup into "no peak has ever been recorded", which is a false claim
 * about days of history.
 *
 * THIS IS THE ONLY THING IN THE APP THAT EVER WRITES A PEAK OR A MEMORY OBSERVATION DOWN.
 */
export async function recordPeakConcurrency(): Promise<void> {
  try {
    const sample = buildConcurrencySample();
    // ONLY the tick that actually carries observations owns a reservation.
    //
    // A DEFLECTED tick (one whose `currentAgentRss()` returned `[]` because the reading was already
    // spoken for) must touch nothing: `pendingWatchdogSeq` still holds the OTHER tick's seq, so a
    // deflected tick that compared against it would match, and its `finally` would clear a
    // reservation it never made — releasing the still-in-flight tick's claim and re-opening exactly
    // the double-fold window this guard exists to close.
    const reserved = sample.agentRss.length > 0;
    const foldingSeq = reserved ? pendingWatchdogSeq : 0;
    // RESERVE before awaiting, so an overlapping tick sees this reading as already spoken for.
    if (reserved) inFlightWatchdogSeq = foldingSeq;
    try {
      const record = await invoke<PeakRecord>("record_agent_concurrency", { sample });
      // Only now is the fold real. `Math.max` because two invokes can resolve OUT OF ORDER, and a
      // bare assignment would move the marker BACKWARDS and re-admit a report already folded.
      if (reserved) {
        lastFoldedWatchdogSeq = Math.max(lastFoldedWatchdogSeq, foldingSeq);
      }
      if (isRecord(record)) cached = record;
    } finally {
      // Release ONLY our own reservation — `reserved` gates this, so a deflected tick can never
      // clear another tick's claim. Committed above on success, released on failure so the reading
      // stays eligible; never left stale, which would pin a report out of the fold forever.
      if (reserved && inFlightWatchdogSeq === foldingSeq) inFlightWatchdogSeq = 0;
    }
  } catch {
    // See above: an older backend rejects every tick, and the cache must survive it.
  }
}

/**
 * Read the record without merging a sample — for a caller that wants the peak and has nothing to
 * contribute. Same never-throws, never-clears rules as `recordPeakConcurrency`.
 */
export async function refreshPeakRecord(): Promise<void> {
  try {
    const record = await invoke<PeakRecord>("agent_concurrency_peak");
    if (isRecord(record)) cached = record;
  } catch {
    /* older backend, or a teardown race — keep whatever we last read */
  }
}

/**
 * The cached record, SYNCHRONOUSLY. `null` means "we have not read one", never "the peak is zero".
 * Callers that need to say something to a human should use `peakSummary()`, whose `observed` flag
 * makes that distinction unmissable.
 */
export function currentPeakRecord(): PeakRecord | null {
  return cached;
}

/** The flat block `get_state` publishes. Small on purpose — `get_state` is documented as expensive
 *  and is permanently resident in every caller's context, so this must not meaningfully grow. */
export interface PeakSummary {
  /** THE HEADLINE. `0` with `observed: false` means NOT OBSERVED YET, not "zero agents ran". */
  peakProcesses: number;
  /** `""` when never observed. A peak without a time cannot be corroborated. */
  peakAtIso: string;
  peakTotalRamBytes: number;
  /** False ⇒ say "no peak recorded". NEVER "the peak is 0". */
  observed: boolean;
  /** How many hours the rolling series SPANS (inclusive), NOT how many entries it holds — the
   *  series is sparse, so those differ whenever the machine went idle for an hour. */
  hourlySpanHours: number;
  /** The reading RIGHT NOW, not at the peak. */
  live: number;
  used: number;
  limit: number;
  basis: string;
  /** Per-AGENT tree RSS (±32 MiB — it is a bucket midpoint). Not per-process. */
  agentRssP50Bytes: number;
  agentRssP90Bytes: number;
  /** False ⇒ every RSS number above is 0 because nothing was ever measured. */
  agentRssObserved: boolean;
  /** ~1.95. NEAR 1.0 ⇒ per-process data got in; say so rather than quoting the RSS figures. */
  meanProcsPerAgent: number;
}

/**
 * What `get_state` carries, so the concierge can quote the peak without shelling out to
 * `scripts/peak-concurrency.sh`.
 *
 * The two `observed` flags are the whole point of this shape. `samples === 0` and
 * `memory.observed === false` both produce a block of zeros, and a reader with no flag to check
 * cannot tell that from a machine that genuinely peaked at zero agents — which never happens. The
 * contract states the rule in the imperative: say "no peak recorded", never "the peak is 0".
 */
/**
 * How many hours the rolling series SPANS, inclusive of both endpoint hours — 0 when empty.
 *
 * Split out and named so the difference from `hourly.length` is stated once, where it is computed.
 * The two agree only when every hour in the window happens to be contiguous, which is exactly the
 * case a fixture is most likely to contain and therefore the case a test is least likely to
 * distinguish.
 */
function hourlySpanHours(record: PeakRecord | null): number {
  const hours = record?.hourly;
  if (!hours || hours.length === 0) return 0;
  // Indexed reads are `| undefined` under noUncheckedIndexedAccess, and this runs inside the
  // synchronous get_state path where a throw poisons the whole reply — so treat a hole as no span
  // rather than asserting it away.
  const first = hours[0];
  const last = hours[hours.length - 1];
  // Validate the FIELD, not just the element. `isRecord` checks `Array.isArray(hourly)` and stops
  // there, so a renamed or partially-serialized entry (`{hourStartMs: …}`, a number, a string)
  // passes, is cached permanently, and yields NaN here — which serializes to `null` over JSON and
  // becomes the one temporal figure the concierge quotes beside the peak. Same class as the guard
  // this replaced; it had simply moved one level deeper.
  // ONE load-bearing check, deliberately not belt-and-braces: a redundant `Number.isFinite` on the
  // result would mask this one, so neither could be shown to matter and a mutation of either stays
  // green. JSON cannot carry Infinity, so a non-number endpoint is the only way NaN arises here.
  if (typeof first?.hour_start_ms !== "number" || typeof last?.hour_start_ms !== "number") return 0;
  return Math.floor((last.hour_start_ms - first.hour_start_ms) / 3_600_000) + 1;
}

export function peakSummary(): PeakSummary {
  const { live, used, limit, basis } = localAgentCapacity();
  const record = cached;
  const observed = !!record && record.samples > 0;
  const memory = record?.memory;
  const memObserved = !!memory && memory.observed;
  return {
    peakProcesses: observed ? record.peak.processes : 0,
    peakAtIso: observed ? record.peak.at_iso : "",
    peakTotalRamBytes: observed ? record.peak.total_ram_bytes : 0,
    observed,
    // A SPAN, from the endpoints — not `hourly.length`, which is an entry COUNT.
    //
    // `hourly` is a rolling series with an entry only for hours in which samples were merged, so
    // it is sparse: a machine used two hours a day for a fortnight has 28 entries across a 14-day
    // window. This is the one temporal figure the concierge quotes beside the peak, and the count
    // understates the real observation window by an order of magnitude on any realistic usage.
    hourlySpanHours: hourlySpanHours(record),
    live,
    used,
    limit,
    basis,
    agentRssP50Bytes: memObserved ? memory.p50_bytes : 0,
    agentRssP90Bytes: memObserved ? memory.p90_bytes : 0,
    agentRssObserved: memObserved,
    // Stored as thousandths in the record so the wire carries an integer; published as the ratio a
    // reader actually compares against 1.0.
    meanProcsPerAgent: memObserved ? memory.mean_proc_count_milli / 1000 : 0,
  };
}
