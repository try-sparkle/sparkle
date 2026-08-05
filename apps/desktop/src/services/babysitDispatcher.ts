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
  /** True when this sweep was superseded mid-flight and stopped early rather than writing stale
   *  state. Surfaced so an abandoned sweep is visible rather than looking like a quiet one. */
  abandoned?: boolean;
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
    // THE FENCE. Checked before every PR's writes rather than once at the top, because the awaits
    // that make a sweep abandonable are INSIDE this loop (one probe-gate read per PR). An abandoned
    // sweep stops here and writes nothing further; what it already wrote before the deadline was
    // written while it was still current.
    if (!isCurrent()) {
      out.abandoned = true;
      return out;
    }
    const repo = repoSlugFromPrUrl(pr.url);
    if (!repo) {
      out.unidentified += 1;
      continue;
    }
    const gate = await readProbeGate(project.rootPath, pr.number);
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
  isCurrent: () => boolean = () => true,
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
    try {
      await invoke(BABYSIT_LEASE_RELEASE_COMMAND, { repo, pr, agentId: holder });
    } catch (e) {
      log.warn("babysit", "lease release after a cancelled dispatch failed", {
        repo,
        pr,
        error: String(e),
      });
    }
    log.debug("babysit", "dispatch cancelled after acquire: the sweep was superseded", { repo, pr });
    return null;
  }

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
  sweepGeneration = 0;
  lastObservation.clear();
  prClocks.clear();
  recentDispatchAt = [];
  if (timer !== null) clearInterval(timer);
  timer = null;
}
