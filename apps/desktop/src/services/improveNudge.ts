// improveNudge — the founder's "watcher and pusher, pushing you whenever it doesn't see you doing
// anything", scoped to the ONE agent it is about: the Improve Sparkle agent (`__sparkle_self__`).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
// The founder's directive: "You should basically never be idle. You should always be working on
// something to improve Sparkle." Layer 1 (the persona's NEVER-IDLE contract in sparkleAgent.ts) tells
// the agent that, and defines the INTAKE→PULL loop it runs. This is the enforcement half: when the
// agent falls idle without having advanced anything, something has to notice and nudge it back to
// work — otherwise the contract is only as good as the model's memory across a turn boundary.
//
// ── A DELIBERATELY THIN, SCOPED EXTENSION OF THE PUSHER, NOT A NEW WATCHER ────────────────────────
// This does not run its own timer, own its own roster, or invent a second delivery path. It is a
// step the PUSHER's existing sweep invokes once per tick (see pusherRunner.sweepPushers /
// pusherMount.buildPusherDeps), reusing: the Pusher's 60s cadence, its per-project ownership election
// (`ownsProjectInThisWindow`), and its verified inbox send (`sendVerified`). All this file adds is a
// PURE decision (`decideImproveNudge`) plus a thin, fully-injected orchestrator (`sweepImproveNudge`)
// so the side effect — the nudge actually being sent — is assertable in a unit test.
//
// The Pusher's ordinary per-partner challenge path is UNTOUCHED: this only ever targets the Improve
// Sparkle agent, so no ordinary build agent's nudge behaviour changes. (It also does not collide with
// `goalContinuationRunner`, which resumes goal-carrying agents by iterating `projectStore` agents —
// and the Improve Sparkle agent is deliberately never in any project's `agents` array, so that runner
// never touches it. There is only one resumer for this agent, and it is this one.)
//
// ── IDLE IS "DID NOT ADVANCE A CONCRETE ITEM", NOT "HAS NO CHILDREN" ──────────────────────────────
// This is the correction that makes the loop valuable rather than counter-productive. The Improve
// Sparkle agent DELEGATES through backgrounded Task subagents and then WATCHES them — so a naive
// "does it have live children / background tasks" signal reads BUSY at exactly the moments it is
// idle-watching with nothing actually progressing. A nudge gated on "no in-flight children" would
// therefore never fire when it most should.
//
// So idleness is judged by a CONCRETE-ADVANCE FINGERPRINT the wiring supplies: when it MOVES the
// agent advanced (its own turn re-opened to commit / edit / file work), and when it is flat across
// the whole idle interval it did not — an agent that only spawned-and-is-watching produces no
// movement and is nudge-eligible even though child processes exist. The wiring keys the fingerprint
// off signals ATTRIBUTABLE to this agent, never a project-wide quantity that would churn from other
// agents and re-stamp the clock forever (roborev 66016) — see `pusherMount.improveAdvanceFingerprint`.
//
// ── SHIPS INERT (AGENTS.md "A hook that WRITES ships inert") ──────────────────────────────────────
// A nudge is a WRITE — it auto-resumes the agent's next turn. So the decision requires `armed`, and
// the wiring defaults it OFF: the feature is dormant until a human explicitly arms it (the in-app
// analogue of `scripts/arm-hook.sh`). `armed === false` is the FIRST thing the decision checks, so an
// unarmed build can compute every other signal and still never send.
//
// ── THE FAILURE DIRECTION IS "MISS A NUDGE", NEVER "NUDGE A BUSY AGENT" ───────────────────────────
// Every absent or ambiguous signal resolves toward "do not nudge": an unread pane status (undefined)
// is NOT idle; an UNREADABLE fingerprint (null — no reading in this window) counts as "advanced", so
// a broken read can never manufacture an idle verdict; a not-yet-baselined clock also counts as
// "advanced" (grace). The cost of a missed nudge is one more 60s tick of idleness; the cost of a
// wrong nudge is spending the agent's attention on a turn it did not need.

import type { AgentTabStatus } from "../types";
import { log } from "../logger";

/**
 * The nudge text delivered into the Improve Sparkle agent's inbox. Carries NO digits, so it can never
 * trip the Pusher's citation gate even if it were ever routed through the challenge path (it is not —
 * `sweepImproveNudge` sends directly). It restates the persona's INTAKE→PULL loop in one line so a
 * fresh turn cannot miss it: scan surfaces nobody reads and file beads, THEN work the highest-value
 * ready bead.
 */
export const NEVER_IDLE_NUDGE_TEXT =
  "You are idle and did not advance a concrete item this interval. Run one INTAKE→PULL cycle now, " +
  "do not end the turn idle. INTAKE: scan a surface nobody reads (autoscaler logs, roborev's " +
  "undrained reviews, GCP quota headroom, PRs whose checks never concluded, unread findings on " +
  "merged PRs) and FILE a bead for anything you find — a clean scan is itself a real result. PULL: " +
  "work the highest-value ready item — open P1/blocking pipeline-health beads first, then `bd " +
  "ready`, then the agent-feedback inbox. Advance one concrete item: commit, merge, file or comment " +
  "a bead, or make a real edit.";

/**
 * The ESCALATED nudge, sent once the agent has been nudged repeatedly WITHOUT advancing a concrete
 * item (see `NEVER_IDLE_ESCALATE_AFTER`). The soft nudge above is a reminder; this is the response to
 * an agent that keeps ANSWERING the nudge — with a status line, a plan, or a question back to the
 * founder — instead of shipping. That is the exact failure a prompt cannot fix, so this text does not
 * merely repeat the ask: it names the streak, DECLARES those non-artifact replies unacceptable, and
 * demands a concrete artifact THIS turn. The counter it keys off (`advanceFingerprint`) measures what
 * the agent DID, so rewording a deferral cannot satisfy it — only a real artifact resets the streak.
 */
export const NEVER_IDLE_ESCALATED_NUDGE_TEXT =
  "You have now been asked to work MULTIPLE times without producing a single concrete artifact. A " +
  "status line, a plan, a list of options, or a question back to the founder is NOT an acceptable " +
  "response — prioritizing and executing is your job, and deferring that choice is the failure being " +
  "corrected. Do ONE thing this turn that leaves an artifact: a commit, a pushed PR, a filed or " +
  "closed bead, or a real file edit. Pick the single highest-value ready item YOURSELF (open " +
  "P1/blocking pipeline-health beads first, then `bd ready`, then the agent-feedback inbox) and act " +
  "on it — do not ask which one. Reply `blocked-*` ONLY if a genuine consent, cost, or " +
  "product-direction decision that is truly the founder's is pending; 'which of these should I fix " +
  "first' is never such a decision.";

/**
 * How many nudges an agent may absorb WITHOUT a concrete advance before the escalated text replaces
 * the soft one. Two: the first nudge is a reminder and the second gives a resumed turn one more
 * chance to produce an artifact; a THIRD nudge in the same flat-signal streak means the agent is
 * answering the nudge instead of working, which is what escalation exists to break.
 */
export const NEVER_IDLE_ESCALATE_AFTER = 2;

/** The nudge text for a given streak of prior nudges-without-advance. Soft below the threshold, the
 *  escalated demand at or above it. Exported so the sweep and its test name the SAME selector. */
export function neverIdleNudgeText(priorNudgesWithoutAdvance: number): string {
  return priorNudgesWithoutAdvance >= NEVER_IDLE_ESCALATE_AFTER
    ? NEVER_IDLE_ESCALATED_NUDGE_TEXT
    : NEVER_IDLE_NUDGE_TEXT;
}

/**
 * How long after a delivered nudge before another may be sent to the same agent.
 *
 * Ten minutes, chosen against the Pusher's 60s tick: without a floor the sweep would re-nudge every
 * tick for as long as the agent stayed idle-with-backlog, which is a storm, not a nudge. Ten minutes
 * gives a resumed turn room to actually pick up work and change the signal before the watcher speaks
 * again — and it only starts counting from a CONFIRMED delivery (see `sweepImproveNudge`), so a nudge
 * that never landed is retried on the next tick rather than suppressed for ten minutes.
 */
export const NEVER_IDLE_CADENCE_MS = 10 * 60 * 1000;

/**
 * How long the agent may go without a concrete advance before it counts as idle. Ten minutes — long
 * enough that a normal working turn (reading, thinking, running a subagent that then produces a
 * commit) never trips it, short enough that a genuinely idle-watching agent is caught within one
 * cadence of the Pusher's tick.
 */
export const ADVANCE_IDLE_MS = 10 * 60 * 1000;

/**
 * The statuses that mean "turn done, at rest" for the Improve Sparkle agent. Mirrors the resting set
 * `goalContinuationRunner.RESTING` uses, and deliberately EXCLUDES `waiting`/`approval` (a question
 * or approval is on screen — nudging would type over it) and `blocked`/`lapsed` (a stall the goal
 * runner and the ordinary Pusher already own). `undefined` — no reading in this window — is not
 * resting either, which is the fail-closed direction. NOTE this is the agent's OWN pane status: an
 * idle-watching agent whose backgrounded children are live still reads `idle` here (its own turn
 * closed), which is the exact case the concrete-advance signal, not this gate, is there to judge.
 */
const RESTING: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>(["idle", "unmerged"]);

/** Everything the decision reads. Pure inputs so the whole rule tests as arithmetic. */
export interface ImproveNudgeInput {
  /** Ships-inert gate. `false` (the default until a human arms it) always refuses — checked FIRST. */
  armed: boolean;
  /** Does THIS window own the sparkle-self project? Only the owner nudges, so two windows cannot
   *  double-send — the same single-owner election the Pusher and goal runner use. */
  ownsProject: boolean;
  /** Improvement consent is "never" (chat-only). A chat-only session is barred from mining backlog,
   *  so it must not be nudged to. Reading consent, never changing it. */
  consentIsNever: boolean;
  /** The agent's live pane status, or `undefined` when this window has no reading. */
  paneStatus: AgentTabStatus | undefined;
  /**
   * Did the agent ADVANCE A CONCRETE ITEM within the idle interval? This REPLACES an "in-flight
   * children" check, on purpose: the Improve Sparkle agent backgrounds subagents, so children-exist
   * reads busy while it is only watching. `true` suppresses the nudge (it is really working, or we
   * could not tell); `false` means it has been idle-watching or resting with no output for the whole
   * interval, which is exactly what to nudge.
   */
  advancedRecently: boolean;
  /** How many open, unblocked improvement beads are ready (the board's `backlog` column). */
  readyBacklogCount: number;
  /** How many open P1 pipeline-health beads exist — the highest-value ready work, counted separately
   *  so a blocked-but-open P1 still satisfies "there is work" even if the backlog column is empty. */
  p1PipelineHealthCount: number;
  /** When the last nudge was delivered, or `null` if never. */
  lastNudgedAt: number | null;
  now: number;
  cadenceMs: number;
}

export type ImproveNudgeDecision =
  | { nudge: true }
  | { nudge: false; reason: ImproveNudgeRefusal };

export type ImproveNudgeRefusal =
  | "not-armed"
  | "not-owner"
  | "consent-never"
  | "not-idle"
  | "advanced-recently"
  | "no-ready-backlog"
  | "rate-limited";

/**
 * Should the watcher nudge the Improve Sparkle agent right now?
 *
 * PURE. Refuses toward silence at every step, and each refusal names a distinct reason so a log or a
 * test can tell "nothing to do" from "already working" from "not armed". The guardrails, in order:
 *
 *   1. `not-armed`         — ships inert; nothing is sent until a human arms the feature.
 *   2. `not-owner`         — another window owns sparkle-self; it will decide.
 *   3. `consent-never`     — chat-only mode may not be told to mine backlog.
 *   4. `not-idle`          — the agent's own pane is not at rest (working / waiting / approval / unknown).
 *   5. `advanced-recently` — it advanced a concrete item within the interval (or we could not tell); it IS working.
 *   6. `no-ready-backlog`  — nothing is ready, so resting is CORRECT; it may rest (guardrail a).
 *   7. `rate-limited`      — a nudge was delivered within `cadenceMs`; give the turn room to act.
 */
export function decideImproveNudge(input: ImproveNudgeInput): ImproveNudgeDecision {
  if (!input.armed) return { nudge: false, reason: "not-armed" };
  if (!input.ownsProject) return { nudge: false, reason: "not-owner" };
  if (input.consentIsNever) return { nudge: false, reason: "consent-never" };
  if (input.paneStatus === undefined || !RESTING.has(input.paneStatus)) {
    return { nudge: false, reason: "not-idle" };
  }
  if (input.advancedRecently) return { nudge: false, reason: "advanced-recently" };
  if (input.readyBacklogCount <= 0 && input.p1PipelineHealthCount <= 0) {
    return { nudge: false, reason: "no-ready-backlog" };
  }
  if (input.lastNudgedAt !== null && input.now - input.lastNudgedAt < input.cadenceMs) {
    return { nudge: false, reason: "rate-limited" };
  }
  return { nudge: true };
}

/** What the sweep gathers from the live app. Every field is a getter so the orchestrator stays pure
 *  of store/registry reads and the whole thing tests with plain spies. */
export interface ImproveNudgeDeps {
  now(): number;
  /** Is the feature armed? Defaults false in the wiring — see the header. */
  armed(): boolean;
  /** Does this window own the sparkle-self project? */
  ownsProject(): boolean;
  /** Is improvement consent "never"? */
  consentIsNever(): boolean;
  /** The improve agent's live pane status, or undefined for "no reading in this window". */
  paneStatus(): AgentTabStatus | undefined;
  /**
   * A summary of the improve agent's own CONCRETE-ADVANCE signal this instant, or `null` when nothing
   * could be read. When this string CHANGES between sweeps the agent advanced; when it is flat across
   * the whole idle interval it did not. `null` (unreadable) never counts as idle. See
   * `pusherMount.improveAdvanceFingerprint` for what feeds it, and `sweepImproveNudge` for the clock.
   */
  advanceFingerprint(): string | null;
  /** The ready-work counts, read from the beads board. */
  readyBacklog(): { ready: number; p1PipelineHealth: number };
  /** Deliver the nudge to the improve agent's inbox; returns whether delivery was CONFIRMED. */
  send(text: string): Promise<boolean>;
}

export interface ImproveNudgeOutcome {
  sent: boolean;
  /** `"nudged"` on a confirmed delivery, `"transport-failed"` on a decided-but-undelivered send,
   *  `"errored"` when a dep threw, or the decision's refusal reason. */
  detail: ImproveNudgeRefusal | "nudged" | "transport-failed" | "errored";
}

// ── Module state, window-local and NOT persisted, like the Pusher's and goal runner's own. ────────
let lastNudgedAt: number | null = null;
/** The last concrete-output fingerprint we saw, and WHEN it last moved. A fresh window has observed
 *  no advance, so the first non-null fingerprint stamps `lastAdvanceAt` as a BASELINE (grace), not as
 *  an advance — an agent gets one full idle interval before it can be judged stale, exactly like the
 *  goal runner's idle clock. */
let lastFingerprint: string | null = null;
let lastAdvanceAt: number | null = null;
/** How many nudges have been DELIVERED in the current flat-signal streak — i.e. since the agent last
 *  advanced a concrete item. Reset to 0 the instant `advancedRecently` is true (any real advance ends
 *  the streak) and incremented on each confirmed delivery. Feeds `neverIdleNudgeText` so the message
 *  escalates when the agent keeps answering the nudge without shipping. Window-local, not persisted. */
let consecutiveIdleNudges = 0;

/** Test/introspection seam: the current flat-signal nudge streak. */
export function improveConsecutiveIdleNudges(): number {
  return consecutiveIdleNudges;
}

/** Test seam: forget every clock so one suite cannot leak into the next. */
export function _resetImproveNudgeForTests(): void {
  lastNudgedAt = null;
  consecutiveIdleNudges = 0;
  lastFingerprint = null;
  lastAdvanceAt = null;
}

/** Test/introspection seam: when did the last nudge land? */
export function improveLastNudgedAt(): number | null {
  return lastNudgedAt;
}

/**
 * Fold one sweep's fingerprint into the advance clock and answer "did it advance within the interval".
 *
 * `null` — UNREADABLE — RESTARTS the clock and returns `true`: a read we could not take is not
 * evidence of idleness, and — the subtle half (roborev 66023/66024) — the blind stretch must not be
 * COUNTED as idle time either. Leaving the clock alone would let a long null run (e.g. the improve
 * pane closed for an hour, which DELETES its `status` entry) be followed by one identical readable
 * sample and fire a nudge immediately, on evidence that covers none of that hour. Restarting the
 * clock on every null means a nudge can only ever fire after a FRESH full interval of readable, flat
 * signal. The first readable fingerprint after that is a BASELINE (grace); a change re-stamps.
 */
function advancedWithin(fingerprint: string | null, now: number, idleMs: number): boolean {
  if (fingerprint === null) {
    lastFingerprint = null;
    lastAdvanceAt = now;
    return true;
  }
  if (lastFingerprint === null || fingerprint !== lastFingerprint) {
    lastFingerprint = fingerprint;
    lastAdvanceAt = now;
  }
  // `lastAdvanceAt` is non-null here (just stamped, or stamped on an earlier sweep).
  return lastAdvanceAt === null || now - lastAdvanceAt < idleMs;
}

/**
 * One pass of the never-idle watcher. Advances the concrete-advance clock, decides, and — only on a
 * `nudge` verdict — sends. NEVER THROWS and NEVER REJECTS: a failure here (a dep read, the awaited
 * send) must not take the Pusher's sweep down, so the whole body is wrapped and a throw becomes an
 * `errored` outcome. The caller also guards, but the contract lives with the function that promises it.
 *
 * THE RATE-LIMIT CLOCK ADVANCES ONLY ON A CONFIRMED DELIVERY. A send the transport could not confirm
 * leaves `lastNudgedAt` untouched, so the next tick retries rather than suppressing for ten minutes —
 * the same "spend the budget against a confirmed delivery" discipline the Pusher uses. Overlapping
 * sweeps cannot double-nudge because the Pusher serialises its ticks and awaits this hook within one.
 */
export async function sweepImproveNudge(deps: ImproveNudgeDeps): Promise<ImproveNudgeOutcome> {
  try {
    const now = deps.now();
    // The advance clock is folded EVERY sweep, before the decision and regardless of every other
    // gate, so a window that is not the owner (or is disarmed) still tracks advance and does not
    // manufacture a false "idle for ages" the moment it becomes eligible.
    const advancedRecently = advancedWithin(deps.advanceFingerprint(), now, ADVANCE_IDLE_MS);
    // A real advance ENDS the streak: the agent worked, so the next nudge (if any) starts soft again.
    // Done every sweep, before the decision, so an advance resets escalation even on a tick that then
    // refuses to nudge for some other reason.
    if (advancedRecently) consecutiveIdleNudges = 0;
    const backlog = deps.readyBacklog();
    const decision = decideImproveNudge({
      armed: deps.armed(),
      ownsProject: deps.ownsProject(),
      consentIsNever: deps.consentIsNever(),
      paneStatus: deps.paneStatus(),
      advancedRecently,
      readyBacklogCount: backlog.ready,
      p1PipelineHealthCount: backlog.p1PipelineHealth,
      lastNudgedAt,
      now,
      cadenceMs: NEVER_IDLE_CADENCE_MS,
    });

    if (!decision.nudge) return { sent: false, detail: decision.reason };

    // NO re-entrancy guard of its own: the Pusher already serialises its ticks with a `sweeping`
    // flag and AWAITS this hook inside that guarded tick, so a second sweep cannot start while this
    // send is in flight. A private `sending` flag here would be redundant with that and, worse, would
    // stay latched forever if a send never settled — permanently, silently disabling the watcher
    // (roborev 66023). The one serializer is the Pusher's.
    // ESCALATE by the streak so far: `consecutiveIdleNudges` counts prior deliveries WITHOUT an
    // advance, so the text hardens the more the agent answers the nudge instead of shipping. Keyed on
    // the advance fingerprint (what the agent DID), so a reworded deferral cannot dodge it.
    const delivered = await deps.send(neverIdleNudgeText(consecutiveIdleNudges));
    if (delivered) {
      lastNudgedAt = now;
      consecutiveIdleNudges += 1;
    }
    return { sent: delivered, detail: delivered ? "nudged" : "transport-failed" };
  } catch (e) {
    log.warn("pusher", "never-idle nudge sweep threw", { error: String(e) });
    return { sent: false, detail: "errored" };
  }
}
