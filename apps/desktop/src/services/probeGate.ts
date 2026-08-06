// Reading knightwatch probes FOR THE OPEN-PR PANEL — the row's status, not the merge's gate.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
// `knightwatch_probe_gate` has been a `#[tauri::command]` since the merge gate landed, and its own
// doc comment advertises it as "the hook for the TypeScript side: call it to surface open probes in
// the UI". Nothing in the UI ever called it. So the panel had no probe data at row-render time, and
// `prMergeReadiness` — which decides every row's dot, word and Merge button — judged a PR without
// it: a probe-blocked PR with clean CI rendered GREEN with a live one-click Merge, and the app
// learned otherwise only by ATTEMPTING the merge and catching Rust's refusal. That is the founder's
// 2026-08-05 report ("things look like they're ready to be merged to main").
//
// ── THE COST THIS MODULE EXISTS TO MANAGE ──────────────────────────────────────────────────────
// One call = one `gh api repos/{o}/{r}/issues/<n>/comments --paginate` SUBPROCESS, under a 45 s read
// timeout, and there is NO CACHE ANYWHERE IN RUST — `knightwatch.rs` holds no Mutex/OnceLock, so
// every invoke is a fresh paginated GitHub read. The panel routinely shows 27 PRs across 6 projects.
// Naively badging every row would be 27 subprocesses on every open and every 180 s poll, which is
// why this module is a cache and a bounded fan-out rather than a bare `invoke`.
//
// ── THE RULE IT MUST NOT BREAK ─────────────────────────────────────────────────────────────────
// UNKNOWN IS NOT CLEAN. `probes` nullish means the read failed — `gh` absent, unauthed, offline,
// timed out, or the comment page saturated at exactly 100, which `knightwatch.rs` also reports as
// unknown because a truncated window is not an empty one. Every path here carries that through as
// `unansweredBlocking: null`, and `prMergeReadiness` lets a null fall straight through rather than
// reddening the row. Collapsing it to 0 would claim a PR is probe-clean on the strength of a read
// that failed; collapsing it to "blocked" would let one slow `gh` disable every Merge in the app.

import { invoke } from "@tauri-apps/api/core";
import type { BabysitProbe, BabysitProbeGate } from "@sparkle/core";
import type { PrProbeState, PrRow } from "./openPrs";

/** MUST match `knightwatch.rs`'s `#[tauri::command]`. The ONE constant; the babysit sweep imports
 *  it from here rather than declaring its own. */
export const KNIGHTWATCH_PROBE_GATE_COMMAND = "knightwatch_probe_gate";

/**
 * How many reads may be in flight at once.
 *
 * Each is a `gh` subprocess doing a paginated GitHub read, so this is a rate limiter on both the
 * local process table and the GitHub API. Four is deliberately modest: the panel's rows render
 * immediately from the PR list and refine as reads land, so throughput here costs nobody a blank
 * screen — whereas 27 concurrent `gh` processes on a machine already running dozens of agents is a
 * real cost, and secondary-rate-limit territory besides.
 */
export const PROBE_READ_CONCURRENCY = 4;

/** A probe as the panel renders it. Re-exported so a row need not know the type lives in core. */
export type { BabysitProbe as ProbeDetail };

/**
 * One PR's cached reading, remembered against the `updatedAt` it was read at.
 *
 * KEYED BY `updatedAt`, NOT BY HEAD SHA — and the difference is correctness, not tuning. A probe is
 * ANSWERED BY A COMMENT, and a comment never moves `headRefOid`. Keying on the head would therefore
 * pin a "Blocked: 1 probe" row in place after the probe had been answered, until somebody happened
 * to push — which is the precise failure this panel exists to stop, inverted. GitHub bumps
 * `updatedAt` on any comment, review, push or label: exactly the set of events that can change a
 * probe reading.
 *
 * This mirrors `babysitDispatcher`'s `lastGate`, deliberately and to the field name. Both cache the
 * same Rust command against the same staleness question, and the one known hole is shared: a probe
 * answered by EDITING an existing reply bumps that comment's timestamp, never the parent PR's, so
 * that reading stays cached until any other event bumps the stamp. The normal answer path posts a
 * NEW comment, which does bump it; the cache is process-local, so a relaunch clears it; and the
 * panel's Refresh calls {@link refreshProbeGates} outright.
 */
interface CacheEntry {
  updatedAt: string;
  gate: BabysitProbeGate;
}

const cache = new Map<string, CacheEntry>();

/**
 * A MODULE-WIDE bound, not a per-call one.
 *
 * The limiter used to be a local queue inside `fetchProbeGates`, which bounds one call and nothing
 * else — and the panel issues one call PER SCOPE. At the six open projects named in the header that
 * is 6 × 4 = 24 concurrent `gh` subprocesses, essentially the 27 this module exists to prevent. A
 * shared counter is the only version of this limit that means what it says.
 */
let inFlight = 0;
const waiting: (() => void)[] = [];

function acquire(): Promise<void> {
  if (inFlight < PROBE_READ_CONCURRENCY) {
    inFlight += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiting.push(() => {
      inFlight += 1;
      resolve();
    });
  });
}

function release(): void {
  inFlight -= 1;
  waiting.shift()?.();
}

/**
 * Bumped by {@link refreshProbeGates}. An in-flight read carries the generation it STARTED in, and
 * a read from an older generation may neither be joined nor written to the cache.
 *
 * WHY A COUNTER AND NOT JUST `cache.clear()`: Refresh exists for the one hole `updatedAt` keying
 * cannot cover (a probe answered by EDITING an existing reply, which moves the comment's stamp and
 * never the PR's). Reads are bounded at 45 s and the poll runs every 180 s, so pressing Refresh
 * DURING a read is the ordinary case — and without this, the refetch simply joins the running
 * pre-Refresh read and re-caches its answer. Clearing the cache while leaving the in-flight map
 * intact makes Refresh a no-op exactly when it is being used for the only thing it is for.
 */
let generation = 0;

/**
 * Reads currently in flight, keyed exactly as the cache is, and carrying the two facts that decide
 * whether a later caller may JOIN one rather than issue its own.
 *
 * WHY DEDUP AT ALL: reads are bounded at 45 s and the poll runs every 180 s, so a Refresh landing
 * during a poll is ordinary rather than exotic. Without this, that overlap re-issues a subprocess
 * for every PR already being read — the cache cannot help, because nothing has been written yet.
 *
 * WHY THE STAMP IS PART OF THE IDENTITY. A read started at `t1` answers the question "what did this
 * PR look like at `t1`". Joining it from a request at `t2` hands back a PRE-`t2` reading, which
 * `fetchProbeGates` would then write to the cache under `t2` — pinning a reading taken before the
 * comment that bumped the stamp, under the newest stamp, until some other event moves it. That is
 * the precise failure `updatedAt` keying was introduced to eliminate, re-entering by another door,
 * and it pins in both directions: a stale "blocked" on an answered probe, or a stale "clean" on a
 * PR that just gained one.
 */
interface InFlightRead {
  /** The generation the read started in. An older one is unjoinable — Refresh has since happened. */
  gen: number;
  /** The `updatedAt` the read answers for. A different stamp is a different question. */
  stamp: string;
  promise: Promise<BabysitProbeGate>;
}
const inFlightReads = new Map<string, InFlightRead>();

/**
 * One read of one PR, deduped against a read already running FOR THE SAME QUESTION and bounded by
 * the module-wide semaphore. Returns the reading plus the generation it was taken in, so the caller
 * can decline to cache a result that a Refresh has already invalidated.
 *
 * THE `try` IS THE CONTRACT, NOT A BELT, AND IT COVERS THE CALL — not just the settlement. `read` is
 * an injectable seam (the stated convergence with `babysitDispatcher.readProbeGate` is exactly such
 * an injection), its type is satisfied by a PLAIN function, and a plain function that throws
 * synchronously blows up on the call itself. A `.catch` chained to the return value is attached one
 * expression too late to see that: the error escapes, rejects the `Promise.all` below, and
 * `fetchProbeGates` discards the whole accumulated map and abandons every queued PR.
 *
 * A NON-THENABLE RETURN IS A SEPARATE CASE AND THE `try` DOES NOT CATCH IT — that clause used to be
 * in this comment and was simply false. It is handled by validating the resolved value in the body.
 * Both degrade to UNKNOWN, which is the answer the docstring promises and every consumer handles.
 */
function readOnce(
  root: string,
  number: number,
  stamp: string,
  read: (root: string, number: number) => Promise<BabysitProbeGate>,
): Promise<{ gate: BabysitProbeGate; gen: number }> {
  const k = cacheKey(root, number);
  const existing = inFlightReads.get(k);
  if (existing && existing.gen === generation && existing.stamp === stamp) {
    const joined = existing;
    return joined.promise.then((gate) => ({ gate, gen: joined.gen }));
  }
  const gen = generation;
  const promise = (async (): Promise<BabysitProbeGate> => {
    await acquire();
    try {
      const g = await read(root, number);
      // VALIDATE THE RESOLVED VALUE, because `await` does not. The docstring above used to claim
      // the `try` covered a seam that "returns a non-thenable" — it does not: `return await x` on a
      // plain value simply resolves to it, nothing throws, and a seam returning `undefined` (the
      // PLAIN-function case the comment names) then reached `gate.probes` in `fetchProbeGates` and
      // TypeError'd inside the Promise.all — the exact batch-abandoning failure the guard exists to
      // prevent. Same shape check `readPrProbeGate` applies to `invoke`'s reply, for the same
      // reason: a cast cannot notice that two sides have drifted.
      if (!g || typeof g !== "object" || typeof g.applicable !== "boolean") {
        return unknownGate("unrecognised probe-gate reply");
      }
      return g;
    } catch (e) {
      return unknownGate(String(e));
    } finally {
      release();
      // ONLY IF IT IS STILL OURS. A newer read for the same PR (a bumped stamp, or a Refresh) has
      // already replaced this entry, and deleting by key alone would evict the live one and let the
      // next caller issue a third subprocess for a read already running.
      const cur = inFlightReads.get(k);
      if (cur && cur.gen === gen && cur.stamp === stamp) inFlightReads.delete(k);
    }
  })();
  inFlightReads.set(k, { gen, stamp, promise });
  return promise.then((gate) => ({ gate, gen }));
}

// A PRINTABLE separator, and the NUMBER FIRST. The first version of this line carried a literal
// NUL byte, which made git classify the whole module as BINARY: 207 lines landed with no reviewable
// diff, `grep` printed "Binary file … matches" with no line content, and any future merge here would
// have been an all-or-nothing conflict instead of a resolvable hunk. Number-first keeps it
// unambiguous without needing an exotic character — the number is digits, so the first space
// delimits it and no two (root, number) pairs can collide.
const cacheKey = (root: string, number: number): string => `${number} ${root}`;

/**
 * The UNKNOWN reading, in the shape the rest of this module speaks.
 *
 * A named constructor rather than an inline literal at each site, because the field that matters is
 * the one that is easiest to get wrong: `probes` must be nullish, and `applicable` must stay TRUE.
 * An unknown read that reported `applicable: false` would be claiming "this PR has no knightwatch
 * review" on the strength of a read that never happened.
 */
const unknownGate = (error: string): BabysitProbeGate => ({
  applicable: true,
  probes: undefined,
  error,
  overridden: false,
});

/**
 * The gate EXACTLY as it arrives over IPC — which is NOT `BabysitProbeGate`.
 *
 * `ProbeGate` in `knightwatch.rs` derives a plain `serde::Serialize` with NO `skip_serializing_if`
 * anywhere on it, so every `Option::None` is serialised as JSON `null` and arrives as a PRESENT
 * field holding `null` — never as an absent field reading `undefined`. Two fields the core types as
 * optional are therefore mis-declared at this boundary, and each fails its own way if passed on:
 *
 *   * `probes: null` — the core's UNKNOWN test is `probes === undefined`
 *     (`babysitDispatch.ts`, the `probe-read-unknown` hold), and `null` does not satisfy it. So a
 *     failed or saturated read reads as AUTHORITATIVE and the PR reports the healthy-sounding
 *     `no-evidence`, then gets CACHED as one.
 *   * `reviewedHead: null` — the core reads `reviewedHead !== undefined && reviewedHead.length > 0`,
 *     and `null !== undefined` is TRUE, so `.length` THROWS and aborts the whole project's sweep.
 *
 * Declaring the wire shape honestly is what makes the normalisation below type-checked rather than
 * remembered.
 */
type WireProbeGate = Omit<BabysitProbeGate, "probes" | "reviewedHead"> & {
  probes: BabysitProbeGate["probes"] | null;
  reviewedHead?: string | null;
};

/**
 * Read one PR's probes. NEVER throws; a failure is the UNKNOWN reading.
 *
 * THE ONLY ADAPTER FOR `knightwatch_probe_gate`. The panel and the babysit sweep used to each own a
 * near-identical copy plus its own command constant, on the reasoning that the sweep's lifecycle
 * should not couple to the panel's render — but an adapter is not a lifecycle, and two of them for
 * one Rust response is two places for the wire contract to drift. `babysitDispatcher` imports this.
 *
 * IT IS THE null→undefined BOUNDARY. See {@link WireProbeGate}: serde puts `null` where the core's
 * contract says `undefined`, and `unansweredBlockingProbes` here tests `== null`, which is satisfied
 * by either — so normalising once, at the boundary, is safe for both callers and required by one.
 */
export async function readProbeGate(root: string, number: number): Promise<BabysitProbeGate> {
  try {
    const gate = await invoke<WireProbeGate>(KNIGHTWATCH_PROBE_GATE_COMMAND, { root, number });
    // A reply we cannot RECOGNISE is unknown too. `invoke` returns `unknown`, and a cast is happy to
    // assert any shape onto it — the one thing a cast cannot do is notice the two sides have
    // drifted. Check the discriminating field rather than trusting the annotation.
    if (!gate || typeof gate !== "object" || typeof gate.applicable !== "boolean") {
      return unknownGate("unrecognised probe-gate reply");
    }
    // NORMALISE ON SHAPE, NOT ON NULLISHNESS — the class, not the one value.
    //
    // CARRIED FROM `main` WHEN THIS ADAPTER MOVED HERE. The merge that brought the two copies
    // together kept this file's side and deleted the dispatcher's — and `main` had meanwhile
    // improved the dispatcher's normalisation, so resolving in our favour wholesale would have
    // silently dropped it. That is exactly the conflict git resolves happily and nobody notices.
    //
    // `?? undefined` (which this was) maps BOTH `null` and a missing field to `undefined`, so it
    // defeats the one non-conforming value serde is known to send TODAY and nothing else: `invoke`
    // returns `unknown` and the `WireProbeGate` cast is unchecked, so any OTHER shape — a `probes`
    // that became `{ items: [...] }` in a Rust refactor, a renamed serde field, a frontend newer
    // than its backend — sails past `??` and is then read as AUTHORITATIVE by every consumer. Same
    // argument the `applicable` check above makes, applied to the two fields whose values are
    // subsequently ITERATED and INDEXED rather than merely compared.
    //
    // A value that is not the declared shape is UNKNOWN, the fail-closed direction here.
    // `Array.isArray`/`typeof` still map `null` and an absent field to `undefined`, so the
    // `skip_serializing_if` case the previous `??` was written for keeps working unchanged.
    return {
      ...gate,
      probes: Array.isArray(gate.probes) ? gate.probes : undefined,
      reviewedHead: typeof gate.reviewedHead === "string" ? gate.reviewedHead : undefined,
    };
  } catch (e) {
    return unknownGate(String(e));
  }
}

/**
 * The unanswered `[blocking]` probes in a reading, or `null` when the read did not answer.
 *
 * `null` vs `[]` is the whole point — see the module header. Callers that want a count take
 * `?.length ?? null`, which preserves the distinction; `?.length ?? 0` destroys it.
 */
export function unansweredBlockingProbes(gate: BabysitProbeGate | undefined): BabysitProbe[] | null {
  // `== null` catches BOTH null and undefined, which is required: this crosses an IPC boundary and
  // serde serialises `Option::None` as literal `null`, so an `=== undefined` guard misses every
  // real unknown the producer sends.
  if (!gate || gate.probes == null) return null;
  return gate.probes.filter((p) => p.severity === "blocking" && !p.answered);
}

/**
 * Project a reading down to the three facts `prMergeReadiness` judges.
 *
 * An OVERRIDDEN gate reports its real probe count with `overridden: true` rather than zero, so the
 * row can say "3 probes, waived" if it ever wants to. The readiness rule is what decides that an
 * override clears the block — this function only reports.
 */
export function probeStateOf(gate: BabysitProbeGate | undefined): PrProbeState | undefined {
  if (!gate) return undefined;
  const unanswered = unansweredBlockingProbes(gate);
  return {
    unansweredBlocking: unanswered === null ? null : unanswered.length,
    overridden: gate.overridden === true,
    applicable: gate.applicable === true,
  };
}

/**
 * Drop every cached reading — what the panel's Refresh calls.
 *
 * NOT the primary way an answered probe clears: replying bumps the PR's `updatedAt`, so the next
 * poll re-reads on its own. This is the belt-and-braces path, and it is what covers the known hole
 * the cache inherits from the babysit sweep — a probe answered by EDITING an existing reply bumps
 * only that comment's stamp, never the parent PR's, so that one reading would otherwise sit until
 * some other event moved the stamp.
 *
 * Clears every root because the panel's Refresh is FLEET-WIDE: `refetch` walks every open scope, so
 * a per-root eviction would have no caller to distinguish.
 */
export function refreshProbeGates(): void {
  cache.clear();
  // AND INVALIDATE WHAT IS IN FLIGHT. Clearing only the cache leaves the refetch free to JOIN a
  // read that started before the press and re-cache its pre-Refresh answer — a Refresh that does
  // nothing, in precisely the overlap window it is most likely to be pressed in. See `generation`.
  generation += 1;
}

/** One PR to evict, named the way the cache keys it. */
export interface ProbeGateTarget {
  root: string;
  number: number;
}

/**
 * Drop the cached readings for exactly these PRs. What the panel calls on OPEN.
 *
 * THE CALLER SUPPLIES THE VERDICT; THIS FUNCTION DOES NOT RE-DERIVE ONE. Two earlier versions did:
 * first "has unanswered blocking probes", then the same thing plus `overridden`. Both were a probe
 * rule rather than the RANKING, and the drift is structural, not accidental — the cache holds only
 * `(root, number) -> gate`, so nothing here can see the facts that outrank probes. A PR that is
 * conflicting, or that this viewer cannot merge, reports that word and has its drawer suppressed,
 * yet was still evicted and re-read on every single open. For `merge-rights` that is as permanent
 * as an override: rights are not answered away by replying to a probe, so it was a `gh` subprocess
 * per open forever for a reading no value of which can change the row.
 *
 * The panel computes the targets from `prMergeReadiness(row).blocker === "probes"` over rows it
 * already holds, so the eviction, the header count and the drawer are three views of ONE call.
 *
 * Does NOT bump the generation: this is a routine re-ask, not the user rejecting an answer, so a
 * read already in flight for the same question is still worth joining.
 */
export function evictProbeGates(targets: Iterable<ProbeGateTarget>): void {
  for (const t of targets) cache.delete(cacheKey(t.root, t.number));
}

/**
 * Test seam. Not exported from an index; production never calls it.
 *
 * RESETS EVERY PIECE OF MODULE STATE, not just the cache — the semaphore counter, its wait queue and
 * the in-flight map included. A test that leaves a read pending would otherwise consume a slot
 * permanently, and four of those deadlock every later test on `acquire()` with no assertion failure
 * to point at the cause; a leaked in-flight entry would hand one test's promise to the next, since
 * the fixtures here reuse the same `(root, number)`.
 */
export function __resetProbeGateCacheForTests(): void {
  cache.clear();
  inFlightReads.clear();
  waiting.length = 0;
  inFlight = 0;
  generation += 1;
}

/**
 * Whether a cached entry still describes `pr`.
 *
 * AN ABSENT OR EMPTY `updatedAt` NEVER COUNTS AS UNCHANGED, on either side. "Absent" is what a `gh`
 * that stopped returning the field produces, and two absents comparing equal would silence that PR
 * forever. Re-reading costs a subprocess; a wrong "no probes" costs a bad merge.
 */
function stillFresh(entry: CacheEntry | undefined, pr: Pick<PrRow, "updatedAt">): boolean {
  if (!entry) return false;
  // NO SEPARATE EMPTINESS BRANCH, and that is a deliberate correction rather than an omission.
  // An earlier version had one, and a test that claimed to cover it — but the write guard below
  // never caches a stamp-less row, so `entry.updatedAt` is always non-empty, and a plain `===`
  // against an absent or empty incoming stamp is already false. The branch could not change an
  // outcome, and neither could any test of it: removing it left the suite green, which is exactly
  // the vacuous shape AGENTS.md is written against. `!!pr.updatedAt` stays because it makes this
  // function correct on its own terms rather than by depending on a guard forty lines away.
  return !!pr.updatedAt && entry.updatedAt === pr.updatedAt;
}

/** What `fetchProbeGates` hands back: PR number → reading, for the PRs it could read. */
export type ProbeGatesByNumber = Map<number, BabysitProbeGate>;

/**
 * Read probes for a batch of PRs, cached by `updatedAt` and bounded to
 * {@link PROBE_READ_CONCURRENCY} in flight MODULE-WIDE (not per call).
 *
 * NEVER REJECTS. A PR whose read fails is present in the result with its UNKNOWN reading, because a
 * caller that has to distinguish "absent because unread" from "read and unknown" would otherwise
 * have to infer it from a missing key — and an inference is exactly what the three-state discipline
 * exists to remove.
 */
export async function fetchProbeGates(
  root: string,
  prs: readonly Pick<PrRow, "number" | "updatedAt">[],
  read: (root: string, number: number) => Promise<BabysitProbeGate> = readProbeGate,
): Promise<ProbeGatesByNumber> {
  const out: ProbeGatesByNumber = new Map();
  const queue: Pick<PrRow, "number" | "updatedAt">[] = [];

  for (const pr of prs) {
    const entry = cache.get(cacheKey(root, pr.number));
    if (stillFresh(entry, pr)) out.set(pr.number, entry!.gate);
    else queue.push(pr);
  }

  // Every queued PR is requested at once; `readOnce` is what holds them to PROBE_READ_CONCURRENCY
  // across the whole module, so the fan-out here does not need its own pool.
  await Promise.all(
    queue.map(async (pr) => {
      const { gate, gen } = await readOnce(root, pr.number, pr.updatedAt ?? "", read);
      out.set(pr.number, gate);
      // ONLY CACHE AN ANSWER, and only against a stamp we can compare later. Caching an unknown
      // would pin a transient `gh` failure — a flaked network, a momentary rate limit — to the PR
      // until something bumped its `updatedAt`, turning a one-poll blip into a lasting "we don't
      // know". Same rule the babysit sweep applies to the same command.
      //
      // AND ONLY IF NO REFRESH LANDED WHILE WE WERE READING. `gen` is the generation the read
      // STARTED in; a Refresh during those seconds means the user asked for a reading newer than
      // this one, and writing it would answer their press with the very answer they rejected.
      // The row still SHOWS this gate — it is the best we have — it just does not become the
      // cached truth for the next 180 s.
      if (gate.probes != null && pr.updatedAt && gen === generation) {
        cache.set(cacheKey(root, pr.number), { updatedAt: pr.updatedAt, gate });
      }
    }),
  );
  return out;
}
