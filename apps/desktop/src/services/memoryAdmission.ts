// The machine's LIVE memory reading, cached so a synchronous gate can consult it.
//
// The concurrency ceiling every spawn path enforces (services/agentCapacity → `enforcedWorkerCap`)
// is a PREDICTION: config.rs reads installed RAM and core count ONCE at startup, divides, memoizes.
// It is a good answer to "what could this machine carry, in principle" and no answer at all to
// "what can it carry right now" — it reacts to nothing. Not to Chrome holding 12 GiB, not to one
// agent running away, not to the compressor thrashing. A machine that is already swapping will
// happily admit another agent and report "at capacity" only once the static count is reached.
//
// This module is the consumption side of the Rust `memory_admission` command, which samples the
// machine (vm_stat / sysctl, behind its own 1s TTL) and returns a ceiling narrowed by what it
// found. Two properties matter to every reader here:
//
//  1. SAMPLING MAY ONLY REFUSE, NEVER RAISE. The Rust side guarantees `effective <= static_max`
//     and `effective >= 1`; agentCapacity re-imposes the min anyway rather than trusting it, so a
//     backend bug or a tampered payload cannot lift the ceiling the static analysis set.
//  2. A NULL CACHE MEANS "NO BASIS TO NARROW" — never "zero available". Absent, failed and stale
//     readings all collapse to null, and every one of them must leave the gate behaving exactly as
//     it did before this module existed. Failing the other way would make an unrelated backend
//     error look like a machine-wide memory emergency and refuse every spawn.
import { invoke } from "@tauri-apps/api/core";
import type { ConcurrencyBound } from "./config";

/** One sample of the machine's memory, as `memory_admission` serializes it (serde snake_case). */
export interface MemorySample {
  total_bytes: number;
  available_bytes: number;
  compressed_bytes: number;
  swap_used_bytes: number;
  /** The OS's own verdict, not our arithmetic: "normal" | "warn" | "critical". */
  level: "normal" | "warn" | "critical";
}

/** The admission decision: the static ceiling, the sampled one, and which of them binds. */
export interface ConcurrencyAdmission {
  /** What to ENFORCE — `min(static, sampled)`. Never greater than `static_max`, never below 1. */
  effective: number;
  /** The static/predicted ceiling, unchanged. Carried so a refusal can contrast the two. */
  static_max: number;
  /** Why the STATIC number is what it is ("cpu" | "ram" | "pinned" | …). */
  static_bound: ConcurrencyBound;
  /** Which dimension binds `effective`. "available" | "pressure" when memory is the constraint. */
  bound: ConcurrencyBound;
  /** One human sentence, composed in Rust next to the number it explains so the two can't drift. */
  basis: string;
  /** How many MORE agents the run queue will admit on top of the `in_use` that was sent — 0 when it
   *  is not narrowing, 0 at its hard stop, and a small trickle in between. Read it to tell a
   *  THROTTLE from a STOP; do not try to recover it by subtracting a count of your own, because
   *  every count on this side is a different population than the `in_use` it was built on, and
   *  mixing those is what made a rate's ceiling equal the number it is compared against (bead
   *  `sparkle-e57k99.1`).
   *
   *  OPTIONAL, DEFAULTING TO 0, for a payload that predates the field: 0 reads as the hard stop,
   *  which refuses. A missing field must never admit more than was measured. */
  load_headroom?: number;
  /** What MEMORY alone would admit, before the run queue had any say — equal to `static_max` when
   *  memory did not narrow.
   *
   *  READ IT IN EVERY BRANCH THAT DOES NOT ALREADY USE `effective`. `bound` is NOT a partition:
   *  `bound === "load"` does not imply memory declined to narrow, so a load-attributed reading can
   *  carry a real RAM-derived ceiling. `effective` is the min of the two and cannot be decomposed,
   *  so a gate that branches on the bound and computes its own ceiling has dropped the memory one —
   *  which is the jetsam path the memory sampler exists to close.
   *
   *  OPTIONAL, DEFAULTING TO `static_max` (never to 0, which would refuse everything on a payload
   *  that predates the field). */
  memory_admitted?: number;
  /** The sentence that goes with `memory_admitted`. Quote it instead of `basis` whenever the memory
   *  term is what actually bound — on the load path `bound` stays `"load"` even then, because the
   *  two ceilings are denominated differently by the time they get here. Optional; absent falls back
   *  to `basis`, which is what the payload said before this field existed. */
  memory_basis?: string;
  /** False when nothing could be measured. A `false` here must narrow NOTHING — see the note on
   *  the null cache above; an unmeasured machine is not a squeezed one. */
  sampled: boolean;
  sample: MemorySample | null;
}

/**
 * How long a reading may keep narrowing the ceiling before it stops counting.
 *
 * A sample is a fact about a MOMENT, and the moment passes: the whole point of reading live memory
 * is that it moves. Whatever was resident when we sampled — a build, a video export, an agent
 * finishing a big diff — is routinely gone seconds later, and a reading taken during that spike
 * must not hold the ceiling down after the machine recovers. Without an expiry, one unlucky sample
 * plus a backend that stops answering would pin the app at a refusing ceiling for the rest of the
 * session, with no way for the user to tell why "at capacity" never cleared.
 *
 * 15s is chosen against the poll interval that feeds it (App.tsx, 5s): three polls fit inside the
 * window, so a single slow or dropped sample never drops the narrowing and starts admitting spawns
 * onto a machine that is still squeezed — but a backend that has genuinely stopped answering
 * releases the ceiling within about the time it takes a human to notice and retry. Shorter and the
 * narrowing flickers on normal poll jitter; much longer and a stale spike outlives its cause.
 */
export const MEMORY_ADMISSION_TTL_MS = 15_000;

/**
 * How often App.tsx re-samples. Lives HERE, next to the TTL, because the two are a pair and the
 * reasoning above is only valid while `TTL >= 3 × POLL` — split them across files and a later tweak
 * to one silently invalidates the other. See the App.tsx call site for the cost side of the choice.
 */
export const MEMORY_ADMISSION_POLL_MS = 5_000;

interface CachedAdmission {
  admission: ConcurrencyAdmission;
  /** When it was taken, on `clock`'s scale. */
  at: number;
}

let cached: CachedAdmission | null = null;

/**
 * Monotonic request counter, so a SLOW reply cannot overwrite a NEWER one (roborev 55383).
 *
 * Tauri runs the sync command off the main thread and the Rust sampler forks `sysctl`/`vm_stat` —
 * process spawn is slowest precisely when memory is tight, i.e. exactly when this matters. Without
 * sequencing: tick A stalls at t=0; tick B returns a `critical` narrowing reading at t=5s and caches
 * it; A resolves at t=6s with its older non-narrowing reading and overwrites B, holding the ceiling
 * un-narrowed for another full TTL. A late REJECTION could wipe a newer good reading the same way.
 *
 * This is only the ISSUE counter. What the guard actually compares against is `lastApplied` below —
 * comparing against this one starves the cache entirely under sustained latency.
 */
let latestRequest = 0;

/**
 * The highest sequence number whose reply has been APPLIED. The guard compares against this, not
 * against `latestRequest` (roborev 55425).
 *
 * Comparing against the last ISSUED request means a reply is accepted only if no newer tick fired
 * while it was in flight — and `App.tsx` ticks unconditionally every 5s. So if command latency is
 * sustainedly above the poll interval, EVERY reply is superseded before it lands and nothing is ever
 * cached: seq 1 resolves at t=6s but seq 2 was issued at t=5s → dropped; seq 2 resolves at t=11s but
 * seq 3 went out at t=10s → dropped; forever. The TTL then expires the last good reading and the
 * ceiling silently reverts to the static prediction.
 *
 * That failure mode is the worst possible one for this feature: the sampler forks `sysctl`/`vm_stat`,
 * which is slowest exactly when memory is tight, so the gate would disable itself precisely in the
 * condition it exists for. A high-water mark of what has been applied keeps genuinely out-of-order
 * (older) replies discarded while letting a slow-but-consistent backend keep the cache fresh.
 */
let lastApplied = 0;

/**
 * Consecutive failures. The cache is NOT dropped on the first one (roborev 55383).
 *
 * The TTL already expresses "a reading we can no longer refresh must stop narrowing", and it does so
 * on a timescale chosen to survive exactly this. Clearing on the first error contradicted that: it
 * made a single IPC hiccup drop the ceiling straight back to the static value, so the
 * `TTL >= 3 × POLL` invariant protected only the SLOW case and not the DROPPED case its own comment
 * named. Concretely — machine at pressure, ceiling narrowed to 3, one tick errors → the static 12 is
 * admitted onto a swapping machine until the next successful poll.
 *
 * Letting the TTL do the expiring costs nothing in the case that motivated the clear: an older
 * backend that rejects forever still releases the ceiling within the TTL, because no successful
 * sample ever refreshes `at`. So this counter exists only for observability and for the
 * belt-and-braces clear below.
 */
let consecutiveFailures = 0;

/**
 * Clear after this many consecutive failures, as a backstop to the TTL rather than a replacement for
 * it. With a 5s poll and a 15s TTL the TTL virtually always wins the race; this only matters if the
 * poll interval is ever shortened well below the TTL, in which case a persistently failing backend
 * should still stop narrowing on its own.
 */
const FAILURES_BEFORE_CLEAR = 4;

/**
 * The clock, injectable so the staleness rule is testable.
 *
 * Deliberately NOT a bare `Date.now()` at the call sites: the only interesting behaviors here are
 * about the passage of time (a reading narrows, then 20s later it must not), and a test cannot
 * exercise that against the wall clock without either sleeping or faking timers globally. Tests
 * set this and restore it; production never touches it.
 */
let clock: () => number = () => Date.now();

/** Test seam — override the clock. Pass nothing to restore the real one. */
export function setMemoryAdmissionClock(fn?: () => number): void {
  clock = fn ?? (() => Date.now());
}

/** Test seam — drop the cache, so one test's reading can't leak into the next. */
export function resetMemoryAdmission(): void {
  cached = null;
  // INVALIDATE in-flight requests rather than un-guarding them (roborev 55450).
  //
  // Zeroing both counters inverted this seam's whole purpose. An in-flight pre-reset reply carrying,
  // say, `seq = 5` would evaluate `5 <= 0` as FALSE, apply its reading into the freshly cleared cache,
  // and set `lastApplied = 5` — swallowing every subsequent reply until the new counter passed 5. The
  // old `seq !== latestRequest` guard dropped it. Test-seam only, so no production impact, but this is
  // exactly what `beforeEach`/`afterEach` rely on to stop one test's reading leaking into the next —
  // and the starvation test deliberately leaves invoke promises unresolved, which is that shape.
  //
  // Leaving both AT `latestRequest` means every outstanding `seq` is `<= lastApplied` and is dropped,
  // while the next request (`++latestRequest`) is greater and applies normally.
  lastApplied = latestRequest;
  consecutiveFailures = 0;
}

/**
 * Sample the machine and cache the result. Fire-and-forget from a poll; never throws.
 *
 * **`inUse` must be the count of RESIDENT agents — `agentCapacity`'s `live`, NOT its `used`**
 * (roborev 55383). Rust's `sampled_admission` computes `in_use + available/per_agent` on the premise
 * that the agents already running are already subtracted from `available_bytes`, so their share has
 * to be added back. Rows in project tabs the user has never opened have no PTY and hold no memory, so
 * adding their share back inflates the ceiling by `(used - live) × per_agent` — and inflates it in the
 * PERMISSIVE direction, which made the `available` bound stop narrowing almost entirely rather than
 * merely being a bit off.
 *
 * A REJECTED invoke is the EXPECTED case, not an error path: the command does not exist on any
 * build predating it, so every older backend rejects with "command not found" on every tick. It must
 * never reject into the caller — the poll is not awaited, so a rejection would surface as an
 * unhandled promise rejection every few seconds forever. It also does NOT clear the cache; the TTL
 * owns expiry (see `consecutiveFailures`).
 */
export async function refreshMemoryAdmission(inUse: number): Promise<void> {
  const seq = ++latestRequest;
  try {
    // `inUse` camelCase → `in_use` on the Rust side; Tauri v2 converts args by default, which is
    // the same convention every other invoke in this app uses (see config.ts's `projectRoot`).
    const admission = await invoke<ConcurrencyAdmission>("memory_admission", { inUse });
    // A newer reply has already been APPLIED: this one is stale by construction and must not
    // overwrite it, however good the reading looks. `resetMemoryAdmission()` also raises `lastApplied`
    // to `latestRequest`, so a reply that was in flight across a reset lands here and is dropped.
    if (seq <= lastApplied) return;
    lastApplied = seq;
    // A payload that isn't shaped like an admission is worth no more than no payload. Guarding the
    // one field the gate arithmetic depends on keeps a garbage `effective` from reaching a
    // `Math.min` that would silently turn NaN into a refusal of everything. Counted as a failure —
    // it is a backend that answered wrongly, which is not better than one that didn't answer.
    if (!admission || typeof admission.effective !== "number" || !Number.isFinite(admission.effective)) {
      noteFailure();
      return;
    }
    consecutiveFailures = 0;
    // Stamped at RESOLVE, not at request. Sequencing above is what prevents an out-of-order reply
    // from winning, so the stamp no longer has to compensate for that — and resolve time is the
    // better estimate of when the reading was valid, because Rust samples inside the call (behind its
    // own 1s TTL) rather than when we asked. Request-time stamping also compounded the starvation
    // above: a reply whose latency approached the 15s TTL would be cached already expired.
    cached = { admission, at: clock() };
  } catch {
    // Same staleness rule for a rejection: a late failure must not evict a newer good reading.
    if (seq <= lastApplied) return;
    lastApplied = seq;
    noteFailure();
  }
}

function noteFailure(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= FAILURES_BEFORE_CLEAR) cached = null;
}

/**
 * The cached reading, synchronously — or null when there is no basis to narrow.
 *
 * Synchronous on purpose: `localAgentCapacity()` is called from render paths and from both spawn
 * gates, and making it async would mean making every one of those async. That is why this is a
 * poll-and-cache rather than an await at the gate.
 *
 * Null covers three cases that are different in origin and identical in consequence — nothing was
 * ever sampled, the last sample failed, the last sample expired. All three mean "behave exactly as
 * you did before". None of them mean "zero available".
 */
export function currentMemoryAdmission(): ConcurrencyAdmission | null {
  if (!cached) return null;
  // `>=` not `>`, and an absolute value: a clock that jumped BACKWARD (a manual time change, an
  // NTP correction) would otherwise make an ancient reading look fresh forever.
  if (Math.abs(clock() - cached.at) >= MEMORY_ADMISSION_TTL_MS) return null;
  return cached.admission;
}
