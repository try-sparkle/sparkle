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
/** MUST match `knightwatch.rs`'s `#[tauri::command]`. */
export const KNIGHTWATCH_PROBE_GATE_COMMAND = "knightwatch_probe_gate";

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

/**
 * Read one PR's knightwatch probes.
 *
 * NEVER throws, and a failure is `probes: undefined` — UNKNOWN, the state `knightwatch.rs` and
 * `mergeGuard/types.ts` both insist on keeping distinct from an empty answer. The decision core
 * holds `probe-read-unknown` on it. Collapsing it to "no probes" would turn every unreadable read
 * into a confident "this PR needs nothing", which is the bug the three-state discipline exists to
 * close — and it is the reading a rate-limited or unauthenticated `gh` produces most easily.
 */
export async function readProbeGate(root: string, number: number): Promise<BabysitProbeGate> {
  try {
    const gate = await invoke<BabysitProbeGate>(KNIGHTWATCH_PROBE_GATE_COMMAND, { root, number });
    // A reply we cannot recognise is UNKNOWN too. `invoke` hands back `unknown` that TypeScript is
    // happy to have asserted into a typed object, and the one thing a cast cannot do is notice that
    // the two sides have drifted (the argument `conflictFlags.parseConflictFlags` makes at length).
    if (!gate || typeof gate !== "object" || typeof gate.applicable !== "boolean") {
      return { applicable: true, probes: undefined, error: "unrecognised probe-gate reply", overridden: false };
    }
    return gate;
  } catch (e) {
    return { applicable: true, probes: undefined, error: String(e), overridden: false };
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
}
const prClocks = new Map<string, PrClocks>();

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
): Promise<BabysitSweepOutcome> {
  const out: BabysitSweepOutcome = { dispatched: [], holds: {}, unidentified: 0 };
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

  const leases = await readLeases();

  for (const pr of prs) {
    const repo = repoSlugFromPrUrl(pr.url);
    if (!repo) {
      out.unidentified += 1;
      continue;
    }
    const gate = await readProbeGate(project.rootPath, pr.number);
    const snapshot: BabysitPrSnapshot = {
      repo,
      number: pr.number,
      state: "open",
      mergeStateStatus: pr.mergeStateStatus,
      checks: checkRollupOf(pr),
      gate,
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
      // REMEMBER WHAT WE SAW EVEN WHEN HOLDING — that is the entire two-observation rule. A hold of
      // `single-observation` that did not record this sighting could never become a dispatch, and
      // the sweep would report "waiting for a second look" forever.
      lastObservation.set(k, { evidenceIds: babysitEvidenceIds(babysitEvidenceFor(snapshot)) });
      continue;
    }

    lastObservation.set(k, { evidenceIds: babysitEvidenceIds(decision.evidence) });
    const agentId = await dispatchOne(project, repo, pr.number, now);
    if (agentId) {
      recentDispatchAt = [...recentDispatchAt.filter((t) => now - t < BABYSIT_RATE_WINDOW_MS), now];
      // Stamped only on a dispatch that actually produced a driver. A lost acquire or a refused
      // spawn created nothing, so recording that a driver existed would charge the PR a cooldown
      // for an event that never happened — and since the exit clock is the sole per-PR limiter,
      // `sawLive` is the field that guard now protects. Hoisting it out of `if (agentId)` is what
      // the two refusal tests fail on.
      clocks.sawLive = true;
      out.dispatched.push({ repo, pr: pr.number, agentId });
    } else {
      hold("lease-lost-or-spawn-refused");
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
): Promise<string | null> {
  const holder = `babysit-dispatch:${repo}#${pr}:${now}`;
  let acquired = false;
  try {
    const res = await invoke<{ acquired?: boolean }>(BABYSIT_LEASE_ACQUIRE_COMMAND, {
      repo,
      pr,
      agentId: holder,
    });
    acquired = res?.acquired === true;
  } catch (e) {
    log.warn("babysit", "lease acquire failed; not dispatching", { repo, pr, error: String(e) });
    return null;
  }
  if (!acquired) return null;

  const agentId = spawnBuildAgentInProject(project, {
    prompt: babysitPrompt(pr),
    name: `Babysit #${pr}`,
    // THE WHOLE REASON `background` EXISTS. This fires on a timer; landing the human in an agent
    // they never asked for, several times an hour, is worse than not watching the PR at all.
    background: true,
  });

  if (!agentId) {
    // The spawn refused — at capacity, torn out, or the project is not on screen. Give the lease
    // back, or this PR is silent until the lease goes stale.
    try {
      await invoke(BABYSIT_LEASE_RELEASE_COMMAND, { repo, pr, agentId: holder });
    } catch (e) {
      log.warn("babysit", "lease release after a refused spawn failed", { repo, pr, error: String(e) });
    }
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
    try {
      await sweepAllProjects(resolved);
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
  };
}

/** The seams the tick supplies in production and a test replaces. Same shape as
 *  `sweepGoalContinuations`'/`startPusherRunner`'s `ownsProject` injection. */
export interface BabysitSweepDeps {
  ownsProject: (projectId: string) => boolean;
  projects: () => readonly Project[];
}

const PRODUCTION_DEPS: BabysitSweepDeps = {
  ownsProject: ownsProjectInThisWindow,
  projects: () => useProjectStore.getState().projects,
};

export async function sweepAllProjects(
  resolved: BabysitDispatchConfig,
  deps: BabysitSweepDeps = PRODUCTION_DEPS,
): Promise<void> {
  const now = Date.now();
  for (const project of deps.projects()) {
    // SINGLE-OWNER ELECTION, the same one every sibling per-project sweep uses
    // (`sweepGoalContinuations`, `startPusherRunner`). `startPusher` mounts in EVERY window, and
    // without this each window sweeps every project: `recentDispatchAt` is module-level state in a
    // per-webview module instance, so the ceiling documented as FLEET-WIDE would silently become
    // 4 per open window — on a budget whose whole point is that "a dispatch costs a full Claude
    // session on the founder's own quota" — and every window would independently spend one `gh`
    // subprocess per open PR per 180 s on the same repos. The lease still stops two DRIVERS on one
    // PR; it does not bound spend, so this is the thing that does.
    if (!deps.ownsProject(project.id)) continue;
    try {
      const outcome = await babysitSweepProject(project, now, resolved);
      if (outcome.dispatched.length > 0 || Object.keys(outcome.holds).length > 0) {
        log.debug("babysit", "sweep", {
          project: project.id,
          dispatched: outcome.dispatched.length,
          holds: outcome.holds,
          unidentified: outcome.unidentified,
        });
      }
    } catch (e) {
      // One project's failure must never starve the projects after it.
      log.warn("babysit", "sweep failed for a project", { project: project.id, error: String(e) });
    }
  }
}


/** Test seam: forget every remembered observation and dispatch. */
export function _resetBabysitDispatcherForTests(): void {
  sweepStartedAt = null;
  lastObservation.clear();
  prClocks.clear();
  recentDispatchAt = [];
  if (timer !== null) clearInterval(timer);
  timer = null;
}
