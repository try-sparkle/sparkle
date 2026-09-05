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

/**
 * One reading, WITH the resident count it was computed from.
 *
 * `inUse` is the whole reason this is a struct rather than a bare admission (bead `sparkle-ftapmp`).
 * Rust's `sampled_admission` returns `in_use + available/per_agent`, so every ceiling on the payload
 * is denominated in RESIDENT agents and is only meaningful RELATIVE to the `in_use` that produced
 * it. A consumer that wants the HEADROOM — how many more the reading grants — has to subtract that
 * exact number, and `AGENTS.md` records what happens when it subtracts a count of its own instead:
 * `orchestrationListener.globalUsedSlots` counts workers only, `localAgentCapacity` counts rows, and
 * mixing either of those with a residents-denominated ceiling is how a ceiling came to be compared
 * against a strictly larger population. `load_headroom` was put ON THE WIRE for that reason; there is
 * no `memory_headroom` field, so the honest substitute is to remember what we SENT rather than to
 * guess what Rust used. It is the same request, so the two cannot disagree.
 */
export interface MemoryAdmissionReading {
  admission: ConcurrencyAdmission;
  /** The RESIDENT count sent as `in_use` for THIS reading — `agentCapacity`'s `live` at poll time. */
  inUse: number;
  /** Identifies THIS reading, so a consumer can tell a new one from a re-read of the same one. The
   *  applied request sequence; see {@link countWhenReadingArrived}, which is the only thing that
   *  needs it. */
  seq: number;
}

interface CachedAdmission extends MemoryAdmissionReading {
  /** When it was taken, on `clock`'s scale. */
  at: number;
}

/**
 * A CALLER'S OWN COUNT, FROZEN AT THE READING IT BELONGS TO (roborev 81142, High).
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ─────────────────────────────────────────────────────────────
 * The first cut of the denomination fix displaced the ceiling by the caller's count taken AT GATE
 * TIME: `count >= max(1, min(staticCap, count + h))`, where `h = ceiling - inUse`. The count appears
 * on BOTH sides and cancels, so that reduces to `h <= 0 || count >= staticCap` — the memory ceiling
 * stops constraining anything at all while there is any headroom left.
 *
 * Two consequences, both found by review on the committed fixtures. A reading saying "room for
 * exactly ONE more" admitted spawn after spawn up to the static ceiling, because each admission
 * raised the count and the ceiling in lockstep — the jetsam path the sampler exists to close. And
 * `globalUsedSlots()`'s in-flight reservations, which exist so a burst of concurrent spawn requests
 * cannot all pass before any of them land, were neutralised for the same reason: they raised both
 * sides equally.
 *
 * ── WHY AN ANCHOR RATHER THAN A BIGGER PAYLOAD ──────────────────────────────────────────────────
 * The headroom is a per-SAMPLE allowance ("this many more fit, as of this measurement"), so the
 * count it is added to has to be the one that was true AT THAT MEASUREMENT — otherwise it is spent
 * again on every call. `pollMemoryAdmission` could record the ROW count for free, but the second
 * gate counts WORKERS and this module cannot reach that number without importing the orchestration
 * listener. So each caller anchors its own count, keyed by a name of its own, the first time it sees
 * a reading it has not seen before.
 *
 * ── IT IS LAZY, AND LAZINESS CUTS BOTH WAYS (roborev 81146, High) ───────────────────────────────
 * The anchor is taken at the first GATE CALL after a reading lands, not at the instant it landed.
 * An anchor taken too HIGH is harmless — it merely admits a little more for one poll. An anchor
 * taken too LOW is the original bug back on a shorter clock, and it is reachable on an ordinary
 * launch: `localAgentRowIds().used` reads `useProjectStore` with no visited filter, so it is 0 until
 * the project list hydrates from Rust, while `pollMemoryAdmission()` fires on mount and sends
 * `live = 0`. Any render in that gap anchors `rows = 0`, and `limit` becomes the bare headroom —
 * 18 on the branch's own measured fixture — so 60 rows arriving a moment later read as AT CAPACITY,
 * with a memory basis, for up to a poll interval (or the whole 15s TTL if the next invokes reject,
 * since a rejection does not change `seq`). That is precisely the "60 rows against a residents
 * ceiling" refusal this bead was filed to kill.
 *
 * SO THE ANCHOR IS HELD ONLY WHILE IT STILL DESCRIBES A FLEET ITS OWN CEILING COULD CONTAIN. Once
 * `current` has passed `anchor + headroom`, the anchor is demonstrably about a different fleet and
 * is retaken. The two failure directions come apart cleanly under that rule:
 *
 *   • THE CANCELLATION (81142) is a count growing INTO the ceiling — `current <= anchor + headroom`
 *     throughout — so the anchor holds and the gate refuses at the boundary, which is the whole
 *     point of freezing it.
 *   • THE STALE ANCHOR (81146) is a count already PAST that ceiling, which cannot have grown there
 *     through this gate. Retaking admits, and admitting is the right direction to fail: a false
 *     refusal is the defect this bead exists to kill, while the over-admission costs one poll.
 *
 * And note what a headroom of ZERO does: the retaken ceiling is `current`, so `current >= current`
 * still refuses. A genuinely full machine cannot be talked into admitting by a fleet that grew
 * underneath it.
 *
 * @param key      names the population — "rows", "workers". Two callers must not share one.
 * @param seq      `MemoryAdmissionReading.seq`. A change re-anchors.
 * @param current  the caller's count right now.
 * @param headroom the allowance the CALLER'S OWN BRANCH ENFORCES on top of the anchor, so "has the
 *                 fleet already passed the ceiling this anchor implies?" is asked about the ceiling
 *                 that is actually being applied. The NARROWEST of that branch's anchor-relative
 *                 terms, never the widest: asked with the widest, the anchor is held long past the
 *                 point the gate has started refusing, and the retake is inert exactly where the
 *                 terms differ most (roborev 81181, High — on a load reading `load_headroom` is 0
 *                 or 1 while `memory_admitted` is the whole static cap). A term that is not
 *                 anchor-relative constrains nothing the anchor can move and must be left out of
 *                 that `min`. Pass 0 and the anchor is retaken on any growth at all, which is the
 *                 live count and the cancellation.
 */
const anchors = new Map<string, { seq: number; count: number }>();
export function countWhenReadingArrived(
  key: string,
  seq: number,
  current: number,
  headroom: number,
): number {
  const a = anchors.get(key);
  const room = Math.max(0, Math.floor(headroom));
  if (a && a.seq === seq && current <= a.count + room) return a.count;
  anchors.set(key, { seq, count: current });
  return current;
}

let cached: CachedAdmission | null = null;

/**
 * Bumped whenever the RESIDENCY VERDICT this cache expresses changes — see `residencyVerdictOf`.
 *
 * A React surface cannot subscribe to a module-level cache, and one now needs to: the pane-mount
 * gate (`hooks/usePaneResidencyAdmission`) decides whether a dormant row's pane may become resident,
 * and that decision moves when the machine's memory reading moves. Same shape as
 * `services/sessionProjects` and `services/resurrectionAdmission` — private state, a version
 * counter, a listener set, consumed through `useSyncExternalStore`.
 *
 * IT BUMPS ON THE VERDICT, NOT ON EVERY POLL, and that is deliberate. `App.tsx` refreshes every 5s,
 * and `Workspace` — whose own perf note calls its memo the top render driver in the app — would then
 * re-render every 5 seconds forever on a machine where nothing about memory had changed. The
 * verdict is a three-field digest, so an ordinary poll on a steady machine notifies nobody.
 *
 * WHAT IT DELIBERATELY DOES NOT OBSERVE IS THE TTL. Expiry is a function of the clock, not of an
 * event, so nothing can bump a counter at the moment a reading goes stale. That is safe here
 * because expiry moves the gate in the PERMISSIVE direction — a stale reading is "no basis to
 * narrow", which admits — so the worst case is a pane held back a few seconds longer than it had to
 * be, cleared by the next poll (or by the failure clear below, within `FAILURES_BEFORE_CLEAR`
 * polls). A counter that bumped on expiry would have to be a timer, which is a second clock to keep
 * in step with the first.
 */
let version = 0;
const listeners = new Set<() => void>();

/** The part of a reading the residency gate actually reads. Two readings with the same digest
 *  cannot produce different mount decisions, so there is nothing to notify about. */
function residencyVerdictOf(c: CachedAdmission | null): string {
  if (!c) return "none";
  return `${c.admission.sampled}|${c.admission.memory_admitted ?? ""}|${c.admission.static_max}|${c.inUse}`;
}

/** Publish a real change. A listener's failure must never break the caller, nor starve the
 *  listeners after it — same rule as every other notifier in this app. */
function notifyIfVerdictMoved(before: string): void {
  if (residencyVerdictOf(cached) === before) return;
  version += 1;
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      // Swallowed by design; see above.
    }
  }
}

/** A monotonically increasing token that changes whenever the residency verdict moves. */
export function memoryAdmissionVersion(): number {
  return version;
}

/**
 * TRANSLATE A RESIDENTS-DENOMINATED CEILING INTO THE CALLER'S OWN POPULATION (bead
 * `sparkle-ftapmp`).
 *
 * **`count` MUST be {@link countWhenReadingArrived}'s answer, never the live count at gate time.**
 * Passing the live count puts it on both sides of the caller's `count >= ceiling` comparison, where
 * it cancels and the ceiling stops constraining anything — see that function's header (roborev
 * 81142, High).
 *
 * Every ceiling on this payload — `effective`, `memory_admitted` — is `in_use + available/per_agent`,
 * so it counts RESIDENT agents. No gate in this app counts residents: `agentCapacity` counts local
 * build/worker ROWS, `orchestrationListener.globalGateBinds` counts WORKER rows. Comparing either
 * against the raw ceiling is a one-way ratchet, because retiring a resident agent lowers the count
 * AND the ceiling together, so the gap never closes. Measured 2026-09-04: 60 rows against a ceiling
 * of 39, two refusals 90s apart with a retire between them, gap fixed at 21.
 *
 * What IS population-independent is the HEADROOM — `ceiling - inUse`, "this many more agents fit",
 * a pure quantity. So the translation is to displace the caller's own count by it.
 *
 * IT LIVES HERE, IN ONE PLACE, BECAUSE TWO GATES NEED IT AND THEY HAVE DRIFTED BEFORE (roborev
 * 81139, High: the first cut of this fix landed in `agentCapacity` and left `globalGateBinds` — the
 * gate that actually admits worker spawns — still comparing raw, so the founder-visible reading
 * admitted while the gate refused). This module is where the denomination is defined, and both
 * gates already import from it.
 *
 * THE HEADROOM IS SIGNED ON PURPOSE. A ceiling BELOW the resident count is a real over-commit —
 * `by_level` collapses `admitted` to `in_use` under critical pressure — and clamping it at zero
 * would forgive that, turning "you are already past what memory holds" into "no opinion". Callers
 * apply their own `Math.max(1, Math.min(staticCap, …))`, which is what keeps the two standing
 * invariants: never below 1, and NEVER ABOVE the static ceiling.
 *
 * @param ceilingResidents the payload's ceiling, in residents.
 * @param count            the caller's own population count AS IT STOOD AT THE READING — see above.
 * @param inUse            the resident count THAT reading was measured from — `MemoryAdmissionReading.inUse`,
 *                         never a count of the caller's own. Subtracting a different population is
 *                         the mistake this function exists to make impossible.
 */
export function ceilingInPopulationOf(
  ceilingResidents: number,
  count: number,
  inUse: number,
): number {
  return count + (Math.floor(ceilingResidents) - inUse);
}

/** Subscribe to residency-verdict changes. Returns an unsubscribe fn. */
export function onMemoryAdmissionChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

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
  const before = residencyVerdictOf(cached);
  cached = null;
  notifyIfVerdictMoved(before);
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
  // Module state outlives a component tree, so one test's anchor would otherwise decide the next
  // test's verdict — and an anchor keyed on a seq that has just been invalidated is a stale one.
  anchors.clear();
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
    const before = residencyVerdictOf(cached);
    // `inUse` is stored VERBATIM as it was sent, not re-read from `agentCapacity`: by the time this
    // reply lands the fleet may have moved, and the ceiling on this payload was computed from the
    // number that went out with the request. See `MemoryAdmissionReading`.
    cached = { admission, inUse, seq, at: clock() };
    notifyIfVerdictMoved(before);
  } catch {
    // Same staleness rule for a rejection: a late failure must not evict a newer good reading.
    if (seq <= lastApplied) return;
    lastApplied = seq;
    noteFailure();
  }
}

function noteFailure(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures < FAILURES_BEFORE_CLEAR) return;
  const before = residencyVerdictOf(cached);
  cached = null;
  notifyIfVerdictMoved(before);
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
/**
 * The cached reading TOGETHER with the resident count it was computed from — the form a consumer
 * needs to recover HEADROOM rather than a bare ceiling. Null covers three cases that differ in
 * origin and are identical in consequence: nothing was ever sampled, the last sample failed, the
 * last sample expired. All three mean "behave exactly as you did before"; none means "zero
 * available".
 *
 * THE ONLY ACCESSOR. A bare `currentMemoryAdmission()` returning just the admission used to sit
 * beside this one and was DELETED once every production caller moved here (bead `sparkle-ftapmp`):
 * it handed out a ceiling with no way to say what population it was measured from, which is the
 * whole defect this module now exists to prevent. Read this whenever you are about to do arithmetic
 * on `memory_admitted` or `effective`. Those numbers count RESIDENT agents; `inUse` is the only thing
 * that says where the count they were measured from stood, and without it the ceiling is a bare
 * number that gets spent against whatever population the caller happens to hold. That is bead
 * `sparkle-ftapmp`: 60 rows compared against a ceiling of 39 residents, where retiring an agent
 * lowered both sides and the gap never closed.
 */
export function currentMemoryAdmissionReading(): MemoryAdmissionReading | null {
  if (!cached) return null;
  // `>=` not `>`, and an absolute value: a clock that jumped BACKWARD (a manual time change, an
  // NTP correction) would otherwise make an ancient reading look fresh forever.
  if (Math.abs(clock() - cached.at) >= MEMORY_ADMISSION_TTL_MS) return null;
  return { admission: cached.admission, inUse: cached.inUse, seq: cached.seq };
}
