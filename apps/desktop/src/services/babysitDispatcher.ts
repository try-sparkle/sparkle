// STARTING `/babysit-pr` BY ITSELF — the sweep that closes bead `sparkle-4cd0x`.
//
// ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────────────────────────
// `.claude/skills/babysit-pr/SKILL.md` is a 930-line skill that answers review probes, drives
// re-review, and self-terminates on merge, close, or convergence. After its FIRST invocation it is
// genuinely self-driving: each pass arms a `Monitor` that wakes it on the next change or after
// ~28 minutes. **Nothing ever performs that first invocation.** It is a slash command a human types,
// once, per PR, if they remember.
//
// Measured: PR #1176 merged carrying an unanswered `[blocking]` knightwatch probe, and five more
// (#1239, #1238, #1236, #1234, #1233) then piled up blocked and were noticed only when the founder
// tried to merge them by hand. Over the last 40 merged PRs the skill was invoked on roughly one.
//
// ── DETECTION IS MECHANICAL; DISPATCH IS NOT ────────────────────────────────────────────────────
// The founder's instruction, and the reason this is a plain timer rather than a step in the hourly
// LLM pass: "an hour is far too long for a PR to sit with a blocking probe. The babysit pass itself
// needs a model; the decision to start one does not."
//
// So everything here is arithmetic and I/O. There is no model call on any path. The judgement lives
// in `@sparkle/core`'s `decideBabysitDispatch`, which is pure — no clock, no network, no store — and
// this module is the part that gathers its inputs and carries out its verdict. That split is what
// makes the rules testable as arithmetic instead of as a mock of the whole app.
//
// It runs on `OPEN_PR_POLL_MS` (180 s), the cadence `openPrs` already uses and the one the design
// report landed on: `PR_REPROBE_TTL` (90 s) is the aggressive end and anything faster spends GitHub
// rate limit for no signal.
//
// ── ONE DRIVER PER PR, AND THE ORDER THAT GUARANTEES IT ─────────────────────────────────────────
// The skill's own Step 1 forbids two drivers: "two drivers collide with the never-reply-twice
// guardrail. One babysit driver per PR, decided up front." Two dispatches are not a watcher started
// twice — they are two overlapping passes replying to the same comments, and the damage is published
// to a human's pull request before anyone can see it.
//
// A read of the lease standing cannot provide that on its own: two ticks could both read `free`. So
// the standing is only an INPUT to the decision, and the actual exclusion is the ACQUIRE, which is a
// compare-and-set in Rust (`babysit_lease.rs`, process mutex + `flock` + atomic rename). The order
// below is therefore load-bearing and must not be rearranged:
//
//   1. read standing  → 2. decide → 3. ACQUIRE (atomic; may lose) → 4. spawn only if acquired
//
// Acquire BEFORE spawn, never after: spawning first and then losing the race leaves an orphan agent
// already writing to a human's PR, which is the exact outcome the lease exists to prevent. And if
// the spawn then fails, the lease is RELEASED rather than left standing — otherwise one failed spawn
// silences that PR until the lease goes stale.
//
// ── WHY THE HOLD REASONS ARE LOGGED EVEN THOUGH THEY ARE THE COMMON CASE ────────────────────────
// Almost every PR on almost every sweep answers `no-evidence`, which is the healthy answer. They are
// still counted and logged in aggregate, because the failure this system is most likely to have is
// silence: `shouldRunImprovementPass` once answered `false` for hours and the honest answer to "what
// has it been doing?" was "nothing, and there is no way to find out why" (design report, risk 5).
import { invoke } from "@tauri-apps/api/core";
import {
  babysitEvidenceFor,
  babysitEvidenceIds,
  decideBabysitDispatch,
  resolveBabysitConfig,
  type BabysitCheckRollup,
  type BabysitDispatchConfig,
  type BabysitLeaseStanding,
  type BabysitObservation,
  type BabysitPrSnapshot,
  type BabysitProbeGate,
  BABYSIT_RATE_WINDOW_MS,
} from "@sparkle/core";
import { fetchOpenPrs, OPEN_PR_POLL_MS, type PrRow } from "./openPrs";
import { getConfig } from "./config";
// ONE adapter for `knightwatch_probe_gate`, owned by `probeGate.ts` — see `readProbeGate` there.
import { readProbeGate } from "./probeGate";
import { spawnBuildAgentInProject } from "./buildAgentSpawn";
import { localAgentCapacity } from "./agentCapacity";
import { useProjectStore } from "../stores/projectStore";
import { ownsProjectInThisWindow } from "./goalContinuationRunner";
import { log } from "../logger";
import type { Project } from "../types";

/** MUST match the Rust command names in `babysit_lease.rs`. */
export const BABYSIT_LEASE_LIST_COMMAND = "babysit_leases";
export const BABYSIT_LEASE_ACQUIRE_COMMAND = "babysit_lease_acquire";
export const BABYSIT_LEASE_RELEASE_COMMAND = "babysit_lease_release";

/** MUST match `REASON_HELD_LIVE` in `babysit_lease.rs` — the ONE refusal that is not a bug. */
export const BABYSIT_LEASE_REASON_HELD_LIVE = "held-live";

/**
 * THE CEILING `babysit_lease.rs::is_agent_id` ENFORCES. An id one byte over is rejected, and the
 * rejection is indistinguishable from "another driver holds it" to a caller reading `acquired`.
 */
export const BABYSIT_HOLDER_ID_MAX_LEN = 128;

/**
 * THE HOLDER ID THE ACQUIRE IS TAKEN UNDER — and the ONE place its alphabet is decided.
 *
 * `babysit_lease.rs::is_agent_id` accepts `[A-Za-z0-9_-]{1,128}` and nothing else, because the same
 * shape is what `worktree::validate_id` requires before an id is joined onto a path. The previous
 * mint here was `babysit-dispatch:${repo}#${pr}:${now}` — whose `:`, `/` and `#` that validator
 * rejects — so EVERY acquire in the history of this module bailed before it touched the store and
 * `dispatchOne` returned null silently. Zero drivers were ever dispatched (sparkle-2hsrlz).
 *
 * The repo half is folded to the accepted alphabet AND truncated, because GitHub's maximum slug
 * (39-char owner + 100-char name) overruns 128 bytes on its own — a second, independent way to mint
 * an id the store will not take. `pr` and `now` are kept whole and at the END: they are what make
 * the id unique per attempt, and truncating those instead would let two sweeps collide.
 *
 * `apps/desktop/shared/babysit-holder-id.fixture.json` pins the output of this function, and the
 * Rust suite feeds those same strings to the real validator — so the two halves fail TOGETHER.
 */
export function mintDispatchHolderId(repo: string, pr: number, nowMs: number): string {
  const prefix = "babysit-dispatch_";
  const suffix = `_${pr}_${nowMs}`;
  const budget = BABYSIT_HOLDER_ID_MAX_LEN - prefix.length - suffix.length;
  const slug = repo.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, Math.max(0, budget));
  return `${prefix}${slug}${suffix}`;
}

/** How often the sweep runs. See the header for why this is the PR-poll cadence and not faster. */
export const BABYSIT_SWEEP_MS = OPEN_PR_POLL_MS;

/**
 * `owner/name` out of a PR's html url, lowercased — the identity half of the lease key.
 *
 * Parsed from the url the PR listing already returns rather than shelling out for
 * `nameWithOwner`: one fewer round trip per sweep, and it cannot disagree with the PR it came from.
 * `undefined` when the url is not the shape we expect, which is a REFUSAL to guess — a wrong repo
 * slug would key the lease against a PR in a different repository, and the babysit skill's own
 * Step 1 makes the same point about its bare-number argument.
 */
export function repoSlugFromPrUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url);
  if (!m) return undefined;
  return `${m[1]}/${m[2]}`.toLowerCase();
}

/**
 * `PrRow.checks` → the decision core's rollup vocabulary.
 *
 * The only difference is the name of the empty case: `openPrs` says `"none"`, the core says
 * `"absent"`. Mapped explicitly rather than cast, so a new value on either side is a type error
 * here instead of an `undefined` that the core would read as "not looked".
 */
export function checkRollupOf(pr: PrRow): BabysitCheckRollup {
  switch (pr.checks) {
    case "passing":
      return "passing";
    case "failing":
      return "failing";
    case "pending":
      return "pending";
    case "none":
      return "absent";
  }
}


/** One lease as `babysit_leases` reports it, narrowed to what this module reads. */
interface LeaseView {
  lease?: { repo?: string; pr?: number };
  standing?: string;
}

/**
 * The lease standing for one PR — `free` when nothing holds it, `unknown` when we could not look.
 *
 * FAIL CLOSED. An unreadable lease store must never read as `free`: the harm is two drivers
 * double-posting on a human's PR, so "I could not tell whether a driver exists" is not "no driver
 * exists". The decision core holds `lease-unknown` on it and nothing is dispatched.
 */
export function standingFor(
  rows: readonly LeaseView[] | undefined,
  repo: string,
  pr: number,
): BabysitLeaseStanding {
  if (rows === undefined) return "unknown";
  const row = rows.find((r) => r.lease?.repo === repo && r.lease?.pr === pr);
  if (!row) return "free";
  switch (row.standing) {
    case "live":
      return "held-live";
    case "dead-epoch":
    case "dead-stale":
      return "held-dead";
    default:
      // A standing this build does not recognise is not a licence to dispatch.
      return "unknown";
  }
}

async function readLeases(): Promise<readonly LeaseView[] | undefined> {
  try {
    const rows = await invoke<LeaseView[]>(BABYSIT_LEASE_LIST_COMMAND);
    return Array.isArray(rows) ? rows : undefined;
  } catch {
    return undefined;
  }
}

/** What the sweep remembers between ticks. Module-level, not persisted: a fresh launch starting with
 *  no prior observation simply means every condition needs one more sweep before it can fire, which
 *  is the conservative direction. */
const lastObservation = new Map<string, BabysitObservation>();
/** Epoch ms of every dispatch this session, ANY PR — the input to the hourly ceiling. */
let recentDispatchAt: number[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
/**
 * When the in-flight sweep started, or `null` when none is running.
 *
 * A TIMESTAMP RATHER THAN A BOOLEAN, deliberately (roborev 58515). A boolean is cleared only by the
 * `finally` on the sweep's own promise, so one `invoke` that never SETTLES — not rejects, settles —
 * wedges it at `true` for the life of the webview and permanently disables dispatch, with a
 * `log.debug` per tick as the only evidence. That is not hypothetical here: a sync
 * `#[tauri::command]` blocking on a held mutex never resolves its promise, and one sweep awaits
 * `fetchOpenPrs`, `readLeases`, a `readProbeGate` per PR, and two lease commands per dispatch. The
 * pre-guard code degraded LOUDLY under a hang (piling ticks); a bare boolean degrades into
 * indistinguishable-from-disabled silence, which is strictly worse for the one failure this module
 * is most likely to have.
 */
let sweepStartedAt: number | null = null;

/**
 * How long an in-flight sweep may run before the next tick treats it as ABANDONED and starts a
 * fresh one. A bounded multiple of the period rather than a new tunable: a healthy sweep is bounded
 * by its own `gh` timeouts, so anything past several periods is a wedge, not slowness.
 */
export const BABYSIT_SWEEP_ABANDON_MS = 4 * BABYSIT_SWEEP_MS;

/**
 * Bumped every time a sweep starts. A sweep that has been ABANDONED must not keep writing.
 *
 * The deadline above starts a replacement, but starting one does not stop the old one: it is still
 * parked on an `await` inside `babysitSweepProject`, and when its `invoke` finally settles it
 * resumes the loop holding a `now` captured at least `BABYSIT_SWEEP_ABANDON_MS` ago. Every write it
 * then makes is stale, and one of them is actively harmful: `observeLease` would stamp
 * `lastDriverExitAt` with that ancient timestamp — on the field this module calls THE SOLE PER-PR
 * LIMITER — so a cooldown that should still be owed reads as long expired and the PR becomes
 * re-dispatchable a full cooldown early. `recentDispatchAt`'s rebuild filters on the same stale
 * `now`, and `lastObservation` loses the newer sweep's sighting.
 *
 * The boolean guard this replaced made that impossible by never letting a second sweep start. The
 * deadline is worth having anyway — a permanently wedged sweep must not disable dispatch forever —
 * but it has to come WITH a fence, or it trades a visible stall for silent corruption.
 */
let sweepGeneration = 0;

/**
 * THE PER-PR CLOCKS. Without these the `cooling-down` hold is UNREACHABLE.
 *
 * `BabysitFleetState`'s clock fields are OPTIONAL, so omitting them is not a type error — it
 * silently deletes both `cooldownMs` (30 min) and `recoveryCooldownMs` (5 min) and nothing goes red.
 * (This sweep now omits `lastDispatchAt` DELIBERATELY and feeds only `lastDriverExitAt`; see the
 * note on the interface below for why the dispatch clock could never bind here. The warning is
 * about dropping the clock that IS fed.) The two failures that buys are the exact ones those
 * constants exist to stop: a
 * driver that finishes one pass and releases its lease is re-dispatched on the NEXT 180 s sweep for
 * as long as any evidence persists (a `checks-failing` PR survives the pass that pushed the fix),
 * and after an app restart every lease reads `held-dead` — which deliberately falls through
 * `driver-alive` — so such a PR re-dispatches in a loop. One sick PR then spends the whole
 * fleet-wide hourly ceiling in about twelve minutes.
 *
 * ── WHAT THIS MAP DOES *NOT* COVER, STATED PLAINLY ──────────────────────────────────────────────
 * It is a plain module-level `Map` with no persistence, so a restart EMPTIES it. On the first round
 * after a restart, every PR with a dead lease and persisting evidence still dispatches with **no
 * per-PR limiter** — and `recentDispatchAt` is wiped by the same restart, so the fleet-wide hourly
 * ceiling resets too and three restarts in a day permit three full budgets. What these clocks
 * actually bound is the SECOND and later attempts, i.e. the crash loop. That is a real fix, but it
 * is a different claim from "the restart case is handled", and it must not be read as the latter.
 *
 * NOTE THE ASYMMETRY WITH `lastObservation` ABOVE, because the same justification does not carry
 * over: losing an observation is CONSERVATIVE (every condition needs one more sweep before it can
 * fire), while losing a clock is PERMISSIVE (a cooldown that should be owed is not). Persisting
 * these beside the durable lease is what would genuinely close the restart case.
 */
interface PrClocks {
  // NO `lastDispatchAt` HERE, DELIBERATELY (roborev 58509). One was wired and was DEAD as a limiter:
  // `decideBabysitDispatch` short-circuits on `held-live`/`unknown` BEFORE the cooldown check, so
  // that check only ever runs with the lease reading `free` or `held-dead` — and the first sweep to
  // reach it is by construction the first to see the exit edge, because `sawLive` is stamped at the
  // dispatch. `latest()` takes the MAX of the two clocks, so the exit stamp (always the later one)
  // permanently shadowed the dispatch stamp. It could never bind, and no test at this level could
  // observe it. Deleted rather than kept as a backstop nothing covers: THE EXIT CLOCK IS THE SOLE
  // PER-PR LIMITER IN THIS SWEEP. The core still exposes `lastDispatchAt` for other callers.
  /** When a driver for this PR was last OBSERVED to have gone. Stamped once per exit — see below. */
  lastDriverExitAt?: number;
  /** Whether the previous sweep saw a LIVE lease. The edge out of this is what an exit IS. */
  sawLive?: boolean;
  /**
   * How many sweeps IN A ROW have decided to dispatch this PR and then failed to produce a driver.
   *
   * A `lease-lost-or-spawn-refused` hold is filed in the same `holds` map as every ordinary
   * DECISION, which is what makes a permanent one invisible: one refusal is routine (a lost acquire
   * race is exactly what the compare-and-set is for), and a thousand of them look identical to it in
   * the rollup. Measured on the founder's own machine — one PR held at that reason on EVERY sweep
   * for over two days, ~58 consecutive identical INFO lines at the 180 s cadence, dispatching
   * nothing and escalating nothing. The streak is the only thing that separates the two cases, and
   * nothing was counting it.
   *
   * Reset on a dispatch that produced a driver, and on any sweep that decided NOT to dispatch — the
   * count is `consecutive refusals`, so anything that is not a refusal breaks the run. Resetting on
   * a plain hold is the conservative direction (it can only produce FEWER warnings) and it is what
   * keeps a handful of unrelated lost races spread over a week from ever adding up to an alarm.
   */
  refusalStreak?: number;
}

/**
 * Consecutive refused dispatches before a PR is called WEDGED.
 *
 * At the 180 s sweep cadence this is ~15 minutes of the dispatcher deciding, over and over, that a
 * PR needs a driver and then not getting one. Below it, a refusal is ordinary contention and must
 * stay quiet; the whole point of the streak is that the two are indistinguishable per-sweep.
 */
export const BABYSIT_REFUSAL_STREAK_WEDGED = 5;

/**
 * Once wedged, re-warn only every this-many further refusals (~1 hour at the 180 s cadence).
 *
 * A warn on EVERY sweep would reproduce the failure this fixes with a louder level: the header on
 * the rollup below records a sweep that emitted 143 identical warns a day and went undiagnosed for
 * a full day precisely because a line that repeats forever reads as background noise.
 */
export const BABYSIT_REFUSAL_STREAK_REWARN = 20;
const prClocks = new Map<string, PrClocks>();

/**
 * The last probe-gate reading per PR, with the `updatedAt` it was read at.
 *
 * WHY: the sweep costs one `knightwatch_probe_gate` per open PR per tick, and each is a `gh`
 * subprocess under a 45 s read timeout. At ten open PRs on a 180 s cadence that is ~200 calls an
 * hour against a 5000/hour budget, spent almost entirely re-reading PRs that did not change.
 *
 * GitHub bumps `updatedAt` on any comment, review, push or label, so an unchanged value means the
 * previous reading is still current for every event that CREATES probe evidence.
 *
 * ONE KNOWN HOLE, and it is narrow (knightwatch #1317 probe 4). `answered` is derived from reply
 * BODIES — `knightwatch.rs` computes it as `repliers.iter().any(|c| cites_probe(&c.body, index))` —
 * and editing an existing comment in place bumps that COMMENT's `updatedAt`, never the parent PR's.
 * So a probe answered by EDITING an old reply, rather than posting a new one, changes the gate's
 * answer while this key holds still, and the PR keeps reading from the cached gate until any other
 * event bumps the stamp. The normal answer path posts a NEW comment, which does bump it; the cache
 * is also process-local, so an app restart clears it. Accepted deliberately: the alternative is
 * re-reading every PR every tick, which is the cost this map exists to avoid.
 *
 * THE CACHE IS ONLY EVER A SHORTCUT PAST A READ, NEVER A SOURCE OF A DIFFERENT ANSWER. It is used
 * only when the stored `updatedAt` is non-empty and equal to the current one; an absent or empty
 * value on either side always re-reads. That matters because "absent" is what a `gh` that stopped
 * returning the field produces, and two absents comparing equal would silence that PR forever.
 */
const lastGate = new Map<string, { updatedAt: string; gate: BabysitProbeGate }>();

function clocksFor(k: string): PrClocks {
  let c = prClocks.get(k);
  if (!c) {
    c = {};
    prClocks.set(k, c);
  }
  return c;
}

/**
 * Stamp `lastDriverExitAt` on the EDGE out of `held-live`, never on the level.
 *
 * The caller contract on that field is explicit that it is "stamped ONCE and never re-stamped",
 * because a timestamp refreshed on every sweep that still sees a finished driver pins the PR at
 * `cooling-down` forever — the "silently stops being watched" outcome, arriving through the back
 * door. An edge cannot do that: it fires on the one sweep where a lease we last saw live is no
 * longer live, and cannot fire again until a new dispatch makes it live again.
 *
 * `unknown` is NOT an exit. We could not look, and the decision holds `lease-unknown` anyway;
 * treating an unreadable store as "the driver went" would manufacture a cooldown out of ignorance.
 */
function observeLease(k: string, standing: BabysitLeaseStanding, now: number): void {
  const c = clocksFor(k);
  if (standing === "held-live") {
    c.sawLive = true;
    return;
  }
  if (standing === "unknown") return;
  if (c.sawLive) {
    c.sawLive = false;
    c.lastDriverExitAt = now;
  }
}

function key(repo: string, pr: number): string {
  return `${repo}#${pr}`;
}

/** The prompt that starts the skill. `/babysit-pr <n>` reaches claude as its positional argv, which
 *  claude submits itself at startup — verified against the real interactive CLI, see
 *  `PRD/sparkle/babysit-pr-auto-dispatch.md`. It does NOT depend on the submit key, which is broken
 *  fleet-wide (`sparkle-bhhu1`). */
export function babysitPrompt(pr: number): string {
  return `/babysit-pr ${pr}`;
}

export interface BabysitSweepOutcome {
  dispatched: Array<{ repo: string; pr: number; agentId: string }>;
  /** Every hold, counted by reason — see the header on why silence is the failure mode to avoid. */
  holds: Record<string, number>;
  /** PRs whose repo slug could not be parsed, so they were never judged at all. */
  unidentified: number;
  /**
   * PRs whose evaluation THREW and were therefore skipped.
   *
   * Distinct from `unidentified` (a PR we declined to judge because we could not name its repo)
   * and from a `hold` (a PR we judged and decided against): this one is a PR we FAILED to judge,
   * and it is the only outcome here that indicates a bug rather than a decision.
   */
  failed: number;
  /**
   * PRs this sweep decided to dispatch, could not, and has now failed to dispatch for at least
   * {@link BABYSIT_REFUSAL_STREAK_WEDGED} sweeps in a row.
   *
   * Counted rather than only logged, for the same reason `failed` is: these PRs are already inside
   * `holds`, indistinguishable from a PR the dispatcher deliberately left alone. A wedged PR is not
   * a decision — the dispatcher WANTED a driver and the fleet would not give it one — so it needs a
   * field of its own in the summary a human reads.
   */
  wedged: number;
  /** True when this sweep was superseded mid-flight and stopped early rather than writing stale
   *  state. Surfaced so an abandoned sweep is visible rather than looking like a quiet one. */
  abandoned?: boolean;
}

/**
 * This project's `[review]` policy, as the two fields the core's `never-reviewed` evidence reads.
 *
 * ONE READ PER SWEEP, not per PR: the answer is a property of the repo, and re-invoking the config
 * command for every PR in a 14-PR fleet would be 14 round-trips for one unchanging value.
 *
 * FAILS CLOSED. An unreadable config yields `{}`, which the core reads as NOT ARMED and turns into
 * no evidence at all — the module's standing rule that an unknown never manufactures evidence,
 * honoured here at the boundary rather than in the decision. Getting this backwards would dispatch a
 * driver at every PR in the fleet on the strength of a config read that failed.
 */
async function readReviewPolicy(
  projectRoot: string,
): Promise<{ requireReview?: boolean; prReviewer?: string }> {
  try {
    const eff = await getConfig(projectRoot);
    const review = eff.config.review;
    if (!review) return {};
    return { requireReview: review.require_review === true, prReviewer: review.pr_reviewer };
  } catch {
    return {};
  }
}

/**
 * ONE sweep over one project's open PRs.
 *
 * `now` is passed in rather than read, so the whole thing is drivable from a test without faking a
 * clock — the same rule `decideBabysitDispatch` follows.
 */
export async function babysitSweepProject(
  project: Project,
  now: number,
  config: BabysitDispatchConfig,
  /** False once this sweep has been superseded — see {@link sweepGeneration}. Defaults to "always
   *  current" so a direct caller (every test) is unaffected. */
  isCurrent: () => boolean = () => true,
  /**
   * WHEN A DISPATCH ACTUALLY HAPPENED, for the hourly budget only (roborev, PR #1266 probe 1).
   *
   * `now` is captured once at the top of the sweep, which is correct for every DECISION here — they
   * must all judge the same instant. It is wrong for the budget: a sweep that wedged for 12+ minutes
   * and then dispatched would file the entry under its ANCIENT start time, and the core reads that
   * as the dispatch epoch — so it ages out of the one-hour window early and permits an extra Claude
   * session in the hour. The append is the one write whose timestamp must be the real one.
   *
   * Defaults to the sweep's own `now`, so every direct caller (and every test that fixes the clock)
   * behaves exactly as before.
   */
  dispatchClock: () => number = () => now,
): Promise<BabysitSweepOutcome> {
  const out: BabysitSweepOutcome = { dispatched: [], holds: {}, unidentified: 0, failed: 0, wedged: 0 };
  const hold = (reason: string): void => {
    out.holds[reason] = (out.holds[reason] ?? 0) + 1;
  };

  const prs = await fetchOpenPrs(project.rootPath, project.id);
  // `null` is "we could not look" and is NOT an empty list. Nothing to do either way, but the two
  // must not be conflated in what we report.
  if (prs === null) {
    hold("pr-state-unknown");
    return out;
  }
  if (prs.length === 0) return out;

  // After the early returns: a project with nothing open needs no policy read at all.
  const reviewPolicy = await readReviewPolicy(project.rootPath);

  const leases = await readLeases();

  for (const pr of prs) {
    // THE FENCE. Checked before every PR's writes rather than once at the top, because the awaits
    // that make a sweep abandonable are INSIDE this loop (one probe-gate read per PR). An abandoned
    // sweep stops here and writes nothing further; what it already wrote before the deadline was
    // written while it was still current.
    if (!isCurrent()) {
      out.abandoned = true;
      return out;
    }
    // ONE BAD PR MUST NOT STARVE THE REST OF ITS PROJECT.
    //
    // Everything below judges a SINGLE PR, and every throw it can produce is about that PR alone —
    // an unreadable probe-gate reply, a shape the wire contract did not anticipate, a slug that
    // parses but resolves to nothing. Without this the throw escapes the loop and is caught only by
    // `sweepAllProjects`, which is PER PROJECT: the first bad PR aborts every PR after it in the
    // same project, on every tick, for as long as the condition holds. That is not hypothetical —
    // it is how one malformed reply kept nine open PRs unjudged for hours while the sweep reported
    // nothing but a single warn line.
    //
    // The fences above stay OUTSIDE: an abandoned sweep `return`s, and a return is not a throw, so
    // it still unwinds the whole function rather than being mistaken for one PR failing.
    try {
      const repo = repoSlugFromPrUrl(pr.url);
      if (!repo) {
        out.unidentified += 1;
        continue;
      }
      // SKIP THE READ WHEN THE PR HAS NOT CHANGED — see `lastGate`.
      //
      // ONE GUARD, NOT TWO. An empty stamp is excluded on the WRITE side below, so nothing with an
      // empty `updatedAt` is ever in the map and re-checking it here could not change an outcome. A
      // second `stamp !== ""` on this line reads like defence in depth but is unreachable, and an
      // unreachable condition is one no test can pin — which is exactly how the rest of this module
      // accumulated guards that looked wired and were not.
      const k0 = key(repo, pr.number);
      const cached = lastGate.get(k0);
      const stamp = pr.updatedAt ?? "";
      let gate: BabysitProbeGate;
      if (cached && cached.updatedAt === stamp) {
        gate = cached.gate;
      } else {
        gate = await readProbeGate(project.rootPath, pr.number);
        // Only an AUTHORITATIVE reading is worth caching. Caching an UNKNOWN would pin the PR at
        // `probe-read-unknown` for as long as nobody touched it, turning one failed `gh` call into a
        // PR that is never looked at again — the opposite of what this sweep exists to do.
        if (stamp !== "" && gate.probes !== undefined) lastGate.set(k0, { updatedAt: stamp, gate });
      }
      // FENCE AGAIN, AFTER THE AWAIT — this is the check that actually matters (roborev 58533). The
      // sweep that gets abandoned is the one parked INSIDE this loop, on the probe-gate read under a
      // 45 s `gh` timeout. It passed the check at the top of the iteration and, without this, walks
      // straight into `observeLease` below holding a `now` and a `leases` snapshot from before the
      // deadline — stamping `lastDriverExitAt` with an ancient timestamp and clearing the replacement
      // sweep's `sawLive`. A fence checked only before the await covers PRs 2..N of an abandoned
      // sweep and misses the single PR it was written for.
      if (!isCurrent()) {
        out.abandoned = true;
        return out;
      }
      const snapshot: BabysitPrSnapshot = {
        repo,
        number: pr.number,
        state: "open",
        mergeStateStatus: pr.mergeStateStatus,
        checks: checkRollupOf(pr),
        // `|| undefined` IS THE UNKNOWN MAPPING, not a tidy-up. The Rust decoder fills `headRefOid`
        // with `str_field`, which yields an EMPTY STRING when the field is absent — and an empty head
        // passed through as-is would satisfy the core's `headSha !== undefined` guard and then fail
        // every prefix test, manufacturing `commits-pushed-since-last-review` for a PR whose head we
        // could not read. That is precisely the "an unknown never becomes evidence" rule the core
        // states, defeated at the boundary rather than in the decision.
        headSha: pr.headRefOid || undefined,
        gate,
        // THE REPO'S REVIEW POLICY, which is what makes `never-reviewed` reachable at all. Both
        // fields are carried through unresolved: the core owns the precedence between them (the
        // `none` hatch above the key), so pre-ANDing them here would move the one part that is easy
        // to get wrong out of the module that tests it.
        requireReview: reviewPolicy.requireReview,
        prReviewer: reviewPolicy.prReviewer,
      };
      const k = key(repo, pr.number);
      const lease = standingFor(leases, repo, pr.number);
      // Before the decision, so a driver that exited during THIS interval is already cooling down by
      // the time the cooldown is evaluated rather than one sweep later.
      observeLease(k, lease, now);
      const clocks = clocksFor(k);
      // One reading, used twice — two calls could disagree and produce a negative slot count.
      const capacity = localAgentCapacity();
      const decision = decideBabysitDispatch({
        now,
        config,
        pr: snapshot,
        lease,
        prior: lastObservation.get(k),
        fleet: {
          recentDispatchAt,
          freeAgentSlots: Math.max(0, capacity.limit - capacity.used),
          lastDriverExitAt: clocks.lastDriverExitAt,
        },
      });

      if (!decision.dispatch) {
        hold(decision.hold);
        // A sweep that declined to dispatch is not a refusal, so it BREAKS the run — see the field's
        // own note for why the count is consecutive rather than cumulative.
        clocks.refusalStreak = 0;
        // REMEMBER WHAT WE SAW EVEN WHEN HOLDING — that is the entire two-observation rule. A hold of
        // `single-observation` that did not record this sighting could never become a dispatch, and
        // the sweep would report "waiting for a second look" forever.
        lastObservation.set(k, { evidenceIds: babysitEvidenceIds(babysitEvidenceFor(snapshot)) });
        continue;
      }

      lastObservation.set(k, { evidenceIds: babysitEvidenceIds(decision.evidence) });
      const agentId = await dispatchOne(project, repo, pr.number, now, isCurrent);
      // NO FENCE HERE, DELIBERATELY (roborev 58537). There WAS one, and it was strictly permissive in
      // the two directions this module says matter most, because neither write below is a stale-clock
      // hazard — they record FACTS about a driver that demonstrably exists:
      //
      //   * `recentDispatchAt` is the hourly budget, and a real driver costs a full Claude session on
      //     the founder's own quota. Writing it with a stale `now` would only age the entry out early;
      //     SKIPPING it never charges the driver at all, so the hour permits N+1. Strictly worse.
      //   * `clocks.sawLive` records that a driver was just spawned. Without it, if that driver's lease
      //     goes free before any sweep observes it `held-live`, `observeLease` never takes the exit
      //     edge, `lastDriverExitAt` — THE SOLE PER-PR LIMITER — is never stamped, and the PR is
      //     re-dispatchable with NO cooldown at all. The fence reintroduced exactly the crash loop
      //     `BABYSIT_RECOVERY_COOLDOWN_MS` exists to slow.
      //
      // The fence that matters is the one after `readProbeGate` above, which guards `observeLease` —
      // the write that stamps a TIMESTAMP and can therefore be poisoned by a stale clock.
      if (agentId) {
        const dispatchedAt = dispatchClock();
        recentDispatchAt = [
          ...recentDispatchAt.filter((t) => dispatchedAt - t < BABYSIT_RATE_WINDOW_MS),
          dispatchedAt,
        ];
        // Stamped only on a dispatch that actually produced a driver. A lost acquire or a refused
        // spawn created nothing, so recording that a driver existed would charge the PR a cooldown
        // for an event that never happened — and since the exit clock is the sole per-PR limiter,
        // `sawLive` is the field that guard now protects. Hoisting it out of `if (agentId)` is what
        // the two refusal tests fail on.
        // NO `clocks.refusalStreak = 0` HERE, DELIBERATELY. One was written and DELETED because it
        // could not fail: after a dispatch, the very next sweep for this PR necessarily HOLDS —
        // `driver-alive` while the lease is live, `cooling-down` once the exit edge stamps — and
        // the reset on that branch has already zeroed the streak before any later refusal can add
        // to it. Removing this line left every assertion green, which is the file's own test for
        // dead state (see the `lastDispatchAt` note above). The reset a dispatch needs is real; it
        // just arrives one sweep later, through the hold, and that path IS covered.
        clocks.sawLive = true;
        out.dispatched.push({ repo, pr: pr.number, agentId });
      } else {
        hold("lease-lost-or-spawn-refused");
        // THE STREAK, NOT THE REFUSAL, IS THE SIGNAL. One refusal is what the compare-and-set is
        // for; a run of them means this PR is never going to get a driver until someone looks.
        const streak = (clocks.refusalStreak ?? 0) + 1;
        clocks.refusalStreak = streak;
        if (streak >= BABYSIT_REFUSAL_STREAK_WEDGED) {
          out.wedged += 1;
          if (
            streak === BABYSIT_REFUSAL_STREAK_WEDGED ||
            (streak - BABYSIT_REFUSAL_STREAK_WEDGED) % BABYSIT_REFUSAL_STREAK_REWARN === 0
          ) {
            log.warn("babysit", "a PR keeps being chosen for a driver and keeps not getting one", {
              repo,
              pr: pr.number,
              consecutiveRefusals: streak,
            });
          }
        }
      }
    } catch (e) {
      // Counted, not just logged. `failed` is the only outcome in a sweep that means a BUG rather
      // than a decision, so it has to be visible in the summary a human reads — a warn line alone
      // is what let this run unnoticed at 143 occurrences a day.
      out.failed += 1;
      log.warn("babysit", "skipped a PR whose evaluation threw", {
        project: project.id,
        pr: pr.number,
        error: String(e),
      });
      continue;
    }
  }
  return out;
}

/**
 * ACQUIRE, THEN SPAWN, AND RELEASE IF THE SPAWN DID NOT HAPPEN.
 *
 * The acquire is the real exclusion (see the header). It is taken under a synthesized holder id
 * because the agent does not exist yet and MUST NOT: creating the agent first and then losing the
 * race would leave an orphan already replying on a human's PR.
 */
async function dispatchOne(
  project: Project,
  repo: string,
  pr: number,
  now: number,
  isCurrent: () => boolean = () => true,
): Promise<string | null> {
  const holder = mintDispatchHolderId(repo, pr, now);
  let acquired = false;
  // `reason` and `detail` are Rust `Option`s, so they cross the wire as `null` — NEVER as an absent
  // key. Typing them `?: string` alone would describe a shape the wire cannot produce.
  let refusal: { reason?: string | null; detail?: string | null } = {};
  try {
    const res = await invoke<{ acquired?: boolean; reason?: string | null; detail?: string | null }>(
      BABYSIT_LEASE_ACQUIRE_COMMAND,
      { repo, pr, agentId: holder },
    );
    acquired = res?.acquired === true;
    refusal = { reason: res?.reason ?? null, detail: res?.detail ?? null };
  } catch (e) {
    log.warn("babysit", "lease acquire failed; not dispatching", { repo, pr, error: String(e) });
    return null;
  }
  if (!acquired) {
    // SAY WHY. A refusal for `held-live` is the ordinary one-driver-per-PR outcome and is debug.
    // Any OTHER reason means this caller handed the lease store arguments it rejected — a bug here,
    // not a decision — and a bare `return null` is what hid exactly that for the whole history of
    // this module: 49,381 sweeps, `dispatched_total=0` in every one, and not a single log line
    // anywhere that named the cause (sparkle-2hsrlz).
    if (refusal.reason === BABYSIT_LEASE_REASON_HELD_LIVE) {
      log.debug("babysit", "not dispatching: another driver already holds the lease", {
        repo,
        pr,
        detail: refusal.detail ?? null,
      });
    } else {
      log.warn("babysit", "lease acquire REFUSED for a non-held reason; not dispatching", {
        repo,
        pr,
        holder,
        reason: refusal.reason ?? "unreported",
        detail: refusal.detail ?? null,
      });
    }
    return null;
  }

  /** Give the holder back. Every exit after the acquire that did NOT leave a driver running must
   *  call this, or the PR is silent until the lease goes stale 90 minutes later. */
  const releaseHolder = async (why: string): Promise<void> => {
    try {
      await invoke(BABYSIT_LEASE_RELEASE_COMMAND, { repo, pr, agentId: holder });
    } catch (e) {
      log.warn("babysit", `lease release after ${why} failed`, { repo, pr, error: String(e) });
    }
  };

  // CHECK AFTER THE ACQUIRE, BEFORE THE SPAWN (knightwatch #1298 probe 1).
  //
  // The acquire is an await, so `stop()` can land during it. Until here the sweep held nothing a
  // caller can see: the lease is ours but NO AGENT EXISTS, so standing down costs only a release —
  // no driver is leaked, nothing goes uncharged, no cooldown is left unarmed. That makes this the
  // last cancellable instant, and the previous version's claim that everything from `dispatchOne`
  // onward was uncancellable was wider than it needed to be.
  //
  // Past `spawnBuildAgentInProject` it really is uncancellable: the agent exists and is about to
  // start replying on a human's PR, and the writes after it record facts about it.
  if (!isCurrent()) {
    await releaseHolder("a cancelled dispatch");
    log.debug("babysit", "dispatch cancelled after acquire: the sweep was superseded", { repo, pr });
    return null;
  }

  let agentId: string | null;
  try {
    agentId = spawnBuildAgentInProject(project, {
      prompt: babysitPrompt(pr),
      name: `Babysit #${pr}`,
      // THE WHOLE REASON `background` EXISTS. This fires on a timer; landing the human in an agent
      // they never asked for, several times an hour, is worse than not watching the PR at all.
      background: true,
    });
  } catch (e) {
    // A THROWN spawn is a REFUSED spawn as far as the lease is concerned — no driver exists either
    // way. Only the falsy return released, so a throw left the holder standing for the full 90-minute
    // stale threshold, and the sweep's per-PR isolation now swallows the throw and moves on, making
    // that leak silent and repeatable. Release, then rethrow so the PR is still counted `failed`.
    await releaseHolder("a spawn that threw");
    throw e;
  }

  if (!agentId) {
    // The spawn refused — at capacity, torn out, the project is not on screen, or a step after the
    // row was added threw and it was torn back down. All of them mean no agent exists, which is the
    // only fact the release depends on.
    await releaseHolder("a refused spawn");
    return null;
  }
  log.info("babysit", "dispatched a driver", { repo, pr, agentId });
  return agentId;
}

/** Start the sweep. Returns a stop function; safe to call twice (the second is a no-op). */
export function startBabysitDispatcher(config?: Partial<BabysitDispatchConfig>): () => void {
  const resolved = resolveBabysitConfig(config);
  const tick = async (): Promise<void> => {
    if (!resolved.enabled) return;
    // ONE SWEEP AT A TIME (roborev 58487). `setInterval` fires every 180 s whether or not the last
    // tick finished, and a tick is strictly serial: one PR list, one lease read, then ONE
    // `knightwatch_probe_gate` PER PR — each a `gh` subprocess under a 45 s read timeout. Four slow
    // PRs already exceed the interval, and this feature is being built for a repo with ~20 open.
    // Without this, ticks pile up unboundedly: N concurrent sweeps each spawning a subprocess per
    // PR, and both mutating `lastObservation` for the same keys, so a slow sweep's write can
    // overwrite a newer one's and reset the two-observation gate that gates every dispatch.
    const startedAt = Date.now();
    if (sweepStartedAt !== null) {
      const age = startedAt - sweepStartedAt;
      if (age < BABYSIT_SWEEP_ABANDON_MS) {
        log.debug("babysit", "sweep skipped: the previous one is still running", { ageMs: age });
        return;
      }
      // Past the deadline the previous sweep is treated as wedged and a fresh one starts. WARN, not
      // debug: "the dispatcher has been silent" must be findable in the log, because it is
      // indistinguishable from "nothing needed dispatching" from the outside.
      log.warn("babysit", "abandoning a wedged sweep and starting a fresh one", { ageMs: age });
    }
    sweepStartedAt = startedAt;
    const myGeneration = ++sweepGeneration;
    try {
      await sweepAllProjects(resolved, PRODUCTION_DEPS, () => myGeneration === sweepGeneration);
    } finally {
      // Only the sweep that still owns the slot clears it — an abandoned sweep that settles late
      // must not clear the flag out from under the one that replaced it.
      if (sweepStartedAt === startedAt) sweepStartedAt = null;
    }
  };
  if (timer !== null) return () => {};
  void tick();
  timer = setInterval(() => void tick(), BABYSIT_SWEEP_MS);
  return () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    // CANCEL THE SWEEP ALREADY RUNNING, not just the future ticks (knightwatch #1291 probe 1).
    //
    // Clearing the interval alone leaves an in-flight sweep parked on an await — a probe-gate read,
    // or a lease acquisition — and when it resumes it walks on to dispatch. So `[babysit].enabled =
    // false` would stop the NEXT sweep while the current one still spawned a driver, which is the
    // user's off switch visibly not taking effect on the one dispatch they were trying to prevent.
    //
    // Bumping the generation makes that sweep's `isCurrent()` false, so it fences out at its next
    // check. One window stays uncancellable by design: a sweep already inside `dispatchOne` has
    // acquired the lease and may have created the agent, and the writes after it record facts about
    // a driver that exists (see the note there) — abandoning those would leak an uncharged,
    // un-cooled-down driver, which is worse than one extra dispatch.
    sweepGeneration += 1;
  };
}

/** The seams the tick supplies in production and a test replaces. Same shape as
 *  `sweepGoalContinuations`'/`startPusherRunner`'s `ownsProject` injection. */
export interface BabysitSweepDeps {
  ownsProject: (projectId: string) => boolean;
  projects: () => readonly Project[];
  /**
   * The REAL clock, for the hourly-budget append only — see `babysitSweepProject`'s `dispatchClock`.
   *
   * It lives on the injectable deps rather than being written inline at the call site so the
   * production wiring is REACHABLE FROM A TEST. It was inline, and that made the whole fix unpinned:
   * `dispatchClock` defaults to the sweep's `now`, so deleting the argument silently restored the
   * bug (budget entries filed under a wedged sweep's ancient start time) with every test green,
   * because each one injected its own clock directly into `babysitSweepProject`.
   */
  dispatchClock: () => number;
  /** The instant every DECISION in one sweep judges against. Injectable for the same reason as
   *  `dispatchClock`: with only one of the two controllable, a test cannot tell the two apart, and
   *  the wiring that keeps them distinct stays unpinned. */
  sweepClock: () => number;
}

const PRODUCTION_DEPS: BabysitSweepDeps = {
  dispatchClock: () => Date.now(),
  sweepClock: () => Date.now(),
  ownsProject: ownsProjectInThisWindow,
  projects: () => useProjectStore.getState().projects,
};

export async function sweepAllProjects(
  resolved: BabysitDispatchConfig,
  deps: BabysitSweepDeps = PRODUCTION_DEPS,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const now = deps.sweepClock();
  for (const project of deps.projects()) {
    // SINGLE-OWNER ELECTION, the same one every sibling per-project sweep uses
    // (`sweepGoalContinuations`, `startPusherRunner`). `startPusher` mounts in EVERY window, and
    // without this each window sweeps every project: `recentDispatchAt` is module-level state in a
    // per-webview module instance, so the ceiling documented as FLEET-WIDE would silently become
    // 4 per open window — on a budget whose whole point is that "a dispatch costs a full Claude
    // session on the founder's own quota" — and every window would independently spend one `gh`
    // subprocess per open PR per 180 s on the same repos.
    //
    // WHAT IT DOES NOT DO, stated because the previous wording claimed otherwise: it does not make
    // the hourly ceiling app-wide. `recentDispatchAt` is per-webview module state and this election
    // only makes each window's PROJECT SET disjoint, so two windows owning different projects are
    // still `BABYSIT_DISPATCHES_PER_HOUR` EACH. The lease stops two drivers on one PR; nothing here
    // bounds total spend across windows, and a durable counter is what would.
    if (!deps.ownsProject(project.id)) continue;
    try {
      if (!isCurrent()) return;
      const outcome = await babysitSweepProject(project, now, resolved, isCurrent, deps.dispatchClock);
      // TWO PROMOTIONS, ONE CAUSE, AND BOTH BELONG HERE. `logger.ts` forwards `debug` only when
      // `import.meta.env.DEV`, so anything logged at debug is discarded by the shipped build —
      // which is how a sweep that threw on every PR, dispatched nothing and emitted 143 identical
      // warns a day went undiagnosed for a full day. Two branches found that independently:
      //
      //   * a sweep that ONLY failed matched no predicate at all, so it said nothing whatsoever;
      //     `failed` therefore has to enter the condition, not just the payload.
      //   * even when a sweep did report, the rollup naming WHICH hold fired sat at debug, so the
      //     one record of the decision existed only in a devtools console nobody had open.
      //
      // So: report on failure OR activity, `warn` when something failed, `info` otherwise. `info`
      // rather than `debug` because a quiet sweep should still say so — the failure this system is
      // most likely to have is silence. Cost is one small JSON line per owned project per 180 s
      // sweep, and only when there is something to say.
      //
      // A THIRD PROMOTION, SAME CAUSE (see `BabysitSweepOutcome.wedged`). A PR whose dispatch is
      // refused every single sweep files an ordinary hold, so this line stayed at `info` and read
      // exactly like a quiet sweep that had decided to leave things alone — for over two days, at
      // three-minute intervals, on the founder's own machine. `wedged` is the same shape as
      // `failed`: not a decision, so it enters the LEVEL and not just the payload.
      const failures = outcome.failed > 0;
      const wedged = outcome.wedged > 0;
      if (failures || outcome.dispatched.length > 0 || Object.keys(outcome.holds).length > 0) {
        const summary = {
          project: project.id,
          dispatched: outcome.dispatched.length,
          holds: outcome.holds,
          unidentified: outcome.unidentified,
          failed: outcome.failed,
          wedged: outcome.wedged,
        };
        if (failures) log.warn("babysit", "sweep skipped PRs that threw", summary);
        else if (wedged) log.warn("babysit", "sweep could not dispatch a PR it keeps choosing", summary);
        else log.info("babysit", "sweep", summary);
      }
    } catch (e) {
      // One project's failure must never starve the projects after it.
      log.warn("babysit", "sweep failed for a project", { project: project.id, error: String(e) });
    }
  }
}


/** Test seam: forget every remembered observation and dispatch. */
export function _resetBabysitDispatcherForTests(): void {
  lastGate.clear();
  sweepStartedAt = null;
  sweepGeneration = 0;
  lastObservation.clear();
  prClocks.clear();
  recentDispatchAt = [];
  if (timer !== null) clearInterval(timer);
  timer = null;
}
