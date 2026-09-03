// goalContinuationRunner — the mount that spends real money on `engine/goalContinuation`.
//
// The engine is data-in-data-out: it answers "should this agent be restarted right now?" from a
// bundle of evidence it is handed. This module is the other half — it GATHERS that evidence from
// the live app, acts on the answer (a PTY write, a store update, a notification), and bounds the
// whole thing to one window and one send per turn.
//
// THREE THINGS HERE ARE EASY TO GET WRONG, and each has a rule:
//
//   1. WHICH STATUS. The engine's motivating case is the `unmerged` band, which no engine ever
//      SETS — `unmergedAttention.withUnmergedWork` overlays it onto a resting row. Reading
//      `runtimeStore.status` raw would therefore never see it, and the most common gray row on a
//      real fleet would never be continued. So the sweep composites the same overlay the sidebar
//      does. It deliberately stops there; see `compositeStatuses`.
//
//   2. WHICH LIVENESS. That same overlay covers `done` and `stopped`, so an `unmerged` row cannot
//      witness its own liveness and `decideContinuation` requires `processAlive` for it, failing
//      closed. The evidence is the RAW status underneath the overlay plus whether this window
//      observed it at all — see `processAliveFor`. Never a hardcoded `true`.
//
//   3. ONE SEND PER TURN. The agent does not go `working` the instant we type; the spinner takes a
//      moment to appear, and the sweep runs every 15s against a 45s settle window. Without a guard,
//      the second and third sweeps after a send would each see the SAME still-idle row past the same
//      threshold and type again. So a send RE-ARMS the idle clock (`markContinued`): the turn we
//      just started has to go quiet for another full `IDLE_SETTLE_MS` before it is eligible again.
//      Duplicate sends are the failure mode this whole file is arranged around.
//
// THE EXPECTED FAILURE DIRECTION IS MISSING A STALL, NEVER INTERRUPTING LIVE WORK. Every piece of
// absent evidence here resolves to "don't send".
import {
  type CloudEvidence,
  type ExternalWait,
  burstsOf,
  decideContinuation,
  progressMark,
} from "../engine/goalContinuation";
import {
  REARM_TTL_MS,
  decideExpiry,
  type ExpiryDecision,
  type NoExpiryReason,
} from "../engine/goalExpiry";
import { awaitingCloseEvidenceFor, expiryProofFor } from "./agentGoalReading";
import type { WorkflowState } from "./branchStatus";
import { hasUnmetGoal, type MergeAuthorityEvidence } from "../engine/agentGoal";
// THE MERGE FLOOR, READ FROM THE ONE PLACE THAT OWNS IT. `MERGE_PROTECTED_SLUGS` is compiled into
// the build and pinned against `shared/merge-protected-repos.json` by policy's own test; a second
// copy of the list here is exactly the drift that file's header forbids. `slugForRoot` is the
// synchronous, never-throwing cache the tool policy already resolves the same question through.
import { isPinnedMergeProtectedSlug } from "./conciergeTools/mergeProtected";
import { slugForRoot } from "./conciergeTools/repoSlug";
import { quotaBlockForAgent } from "../engine/engineRegistry";
import { hasTurnEndAuthority } from "../engine/turnEndAuthority";
import { isInMotion } from "../engine/inMotion";
import { hasLiveBackgroundTasksForAgent } from "./backgroundTaskRegistry";
import { withUnmergedWork } from "../engine/unmergedAttention";
import { resolveStage } from "../engine/workflowStage";
import { useProjectStore } from "../stores/projectStore";
import {
  mergeOpenAgentIds,
  readPersistedOpenAgentIds,
  useRuntimeStore,
} from "../stores/runtimeStore";
import type { AgentTab, AgentTabStatus } from "../types";
import { APP_WINDOW_LABEL } from "../windowContext";
import { useAuthStore } from "../stores/authStore";
import { livenessOf } from "./agentLiveness";
import { notifyAttention } from "./attention";
import { cloudApi } from "./cloudAgents/api";
import { cloudSessionStatusOf, refreshCloudSessionStatuses } from "./cloudAgents/sessionStatus";
import {
  agentCanAcceptInput,
  agentCanAcceptPrompt,
  dispatchConciergeAnswer,
} from "./conciergeDispatch";
import type { ConciergeDispatchPath } from "./conciergeDispatch";
import { altScreenRefusalVerdict, type AltScreenRefusalVerdict } from "../engine/screenReadability";
import { getAgentViewport } from "./terminalViewport";
import { getRelaySocket } from "./relayClient";
import { log } from "../logger";
import { findWindowForProject } from "./windowRegistry";
import { routeToOwningWindow } from "./windowOwnership";

/**
 * How often the sweep runs.
 *
 * Chosen against `IDLE_SETTLE_MS` (45s), not in the abstract. The settle window is the thing a
 * sweep has to observe, so the cadence has to divide it several times over: at 15s a row that
 * crosses 45s of continuous rest is acted on within 15s of crossing, i.e. the worst-case detection
 * latency for a stall is a minute — three orders of magnitude better than the 30-to-153-minute
 * stalls this feature was commissioned for, and far below the two-minute floor the PRD counts as a
 * stall at all. Sampling AT or ABOVE 45s would risk stepping over a whole settle window.
 *
 * Faster buys nothing and is not free: a sweep composites a status overlay across every agent in
 * every project. It is all in-memory store reads — no git, no IPC, no LLM — so 15s across a
 * 64-agent fleet is negligible, but at 1s it would be 15× that for no reduction in the number of
 * stalls caught, since nothing can be caught before its settle window elapses.
 */
export const GOAL_SWEEP_INTERVAL_MS = 15_000;

/**
 * The statuses a row must hold to have its idle clock RUNNING.
 *
 * Mirrors `isRestingStatus` in engine/goalContinuation, which is module-private there. A copy is
 * regrettable, and the drift it can cause is bounded in the safe direction on purpose: if this set
 * is ever NARROWER than the engine's, an eligible row simply has no `idleSince` and the engine
 * answers `idle-not-settled` — a MISSED stall. If it is WIDER, the extra rows are gated out by the
 * engine's own `not-idle` arm before anything is sent. Neither drift can produce a send the engine
 * would have refused.
 */
const RESTING: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>(["idle", "unmerged"]);

/**
 * Statuses that mean the PROCESS IS GONE. Everything else this window has actually observed implies
 * a PTY that was recently producing output (see engine/statusEngine: `done`/`errored` are written
 * from the `pty:exit` handler, and `stopped` is the not-running default).
 */
const DEAD: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>(["done", "errored", "stopped"]);

/** agentId → epoch ms the row last BECAME resting. The field `ContinuationInput.idleSince` needs and
 *  that nothing in the app records — see {@link trackIdleSince}. */
export type IdleClock = ReadonlyMap<string, number>;

/**
 * Advance the idle clock by one observation.
 *
 * PURE, and separated out for exactly that reason: this is the only piece of state the runner keeps
 * of its own, so the rule that governs it should be testable as arithmetic rather than by driving a
 * timer. For each agent: resting and already clocked → keep the ORIGINAL stamp (that is what makes
 * it "continuously resting since", not "resting as of the last sweep"); resting and new → stamp
 * `now`; anything else → drop, so leaving the resting band resets the clock and the next rest
 * starts a fresh settle window.
 *
 * Agents absent from `statuses` are dropped too, which is what garbage-collects a closed agent's
 * entry — the map only ever holds ids the caller just observed.
 */
export function trackIdleSince(
  prev: IdleClock,
  statuses: ReadonlyMap<string, AgentTabStatus>,
  now: number,
): Map<string, number> {
  const next = new Map<string, number>();
  for (const [id, status] of statuses) {
    if (!RESTING.has(status)) continue;
    next.set(id, prev.get(id) ?? now);
  }
  return next;
}

/**
 * Is this agent's PROCESS alive, on the evidence this window actually holds?
 *
 * PURE. Two questions in order, and both fail closed:
 *
 *   • Did this window OBSERVE the agent at all? `runtimeStore.status` is window-local and never
 *     persisted, so a missing entry is "no reading", not "calm" — services/agentLiveness exists
 *     because that confusion has been made twice. Anything but `local` is no evidence, so `false`.
 *   • Is the observed RAW status one of the dead ones? Note "raw": the composited status is exactly
 *     what cannot answer this, because the `unmerged` overlay it carries is written over `done` and
 *     `stopped` alike.
 */
export function processAliveFor(
  agentId: string,
  raw: Record<string, AgentTabStatus>,
  openIds: ReadonlySet<string>,
): boolean | undefined {
  // `undefined`, not `false`, when this window never observed the agent — the two refuse the
  // continue identically, but they produce DIFFERENT sentences downstream: `decideContinuation`
  // reports `process-gone` only for an observed death and `liveness-unknown` for absent evidence,
  // and that reason is what the concierge reads out to a human. Saying "its process is gone" about
  // an agent nobody looked at would send them to close a tab whose agent is running (roborev 55298).
  if (livenessOf(agentId, raw, openIds) !== "local") return undefined;
  const status = raw[agentId];
  if (status === undefined) return undefined;
  return !DEAD.has(status);
}

/**
 * Can this agent receive the continuation AT ALL — asked in the form that matches what a
 * continuation actually IS.
 *
 * ══ WHY THIS IS NOT JUST `agentCanAcceptInput` (the bug this closes) ═════════════════════════════
 * A continuation is a plain PROMPT. It goes through `dispatchConciergeAnswer`, which routes a cloud
 * agent to `deliverCloudPrompt` and puts the text on the relay as an `agent_input` frame — a path
 * that has existed and worked for cloud since the compose box learned to address one.
 * `agentCanAcceptInput`, by its own doc, is deliberately THE LOCAL-PTY QUESTION and is false for
 * every cloud agent, because its other callers (`sendControlKey`, dictation, the API-recovery ping)
 * write RAW BYTES to a PTY that a cloud agent does not have. Feeding that answer to the sweep asked
 * "can I write bytes to its PTY" about a send that writes no bytes to any PTY — so the whole
 * goal-continuation feature was dead for cloud: never nudged, and (because the bounds sit after the
 * gates) never escalated either. Silent forever, which is the state that module exists to abolish.
 *
 * ══ WHY IT IS NOT A BLANKET SWAP TO `agentCanAcceptPrompt` EITHER ════════════════════════════════
 * The two predicates agree for every agent that has a roster row and a local runtime, so a blanket
 * swap would look harmless today. It is still wrong to write, for one reason worth more than the
 * diff it saves: `agentCanAcceptInput` is where the local-PTY question LIVES, and its doc promises
 * that callers aiming a PTY write ask it. A sweep that reaches an irreversible local write through
 * the prompt predicate inherits none of that promise, and the next person to narrow the local gate
 * (a dead-PTY check is the obvious candidate, and the obvious place to put it) would tighten it for
 * every caller except this one — silently, with no test able to see it. Asking each runtime its own
 * question keeps the local path bound to the local gate, whatever that gate grows into.
 *
 * Fails closed on an unknown id both ways: both predicates refuse an agent the store never heard of.
 */
export function canAcceptContinuation(agent: Pick<AgentTab, "id" | "runtime">): boolean {
  return agent.runtime === "cloud" ? agentCanAcceptPrompt(agent.id) : agentCanAcceptInput(agent.id);
}

/**
 * Gather what this window knows about a cloud agent's sandbox (engine/goalContinuation's
 * `CloudEvidence`). Cheap and synchronous — three in-memory reads, no IO — because it runs for every
 * cloud agent with a goal on every 15s sweep.
 *
 * The freshness of `sessionStatus` is NOT this function's job: `cloudSessionStatusOf` expires its
 * own readings, and {@link maybeRefreshCloudStatuses} is what keeps a live project's readings inside
 * that window. Both halves are needed — an un-refreshed reading ages into `undefined` and refuses,
 * which is the correct failure, not a working one.
 */
export function cloudEvidenceFor(agentId: string, now: number): CloudEvidence {
  return {
    sessionStatus: cloudSessionStatusOf(agentId, now),
    balanceCents: useAuthStore.getState().me?.balanceCents,
    // The server's RESUME floor — the number that actually governs the decision this evidence feeds.
    // Deliberately NOT `minStartCents`, which is a different and much higher bar the server applies
    // only to spawning: reading it here would abandon paused agents their owner can still afford.
    // Undefined when the server stated none, which falls back to the 1¢ obviously-empty check.
    minContinueCents: useAuthStore.getState().me?.cloudAgentPricing?.minContinueCents,
    // `CloudTransport.write` reads exactly this and silently no-ops when it is null, so a resume sent
    // over a dead relay would be recorded as delivered. Asked here, before the decision, rather than
    // discovered afterwards — the transport has no failure channel to read.
    relayConnected: getRelaySocket() !== null,
  };
}

/**
 * The status map the rest of the app reads, per project, flattened to one map.
 *
 * ONLY `withUnmergedWork` is applied, and the omissions are deliberate rather than an oversight:
 *
 *   • `withDismissedAlerts` de-escalates a DISMISSED red row to idle/stopped. Applying it would
 *     make a row the human deliberately silenced eligible for an auto-continue; not applying it
 *     leaves that row reading `waiting`/`blocked`, which the engine refuses. Omitting is the
 *     conservative direction.
 *   • the worker-attention bubbles invent a red on a PARENT from a CHILD's state. Reading a bubbled
 *     red as the parent's own would be a lie about whose turn ended, and the bubble only ever adds
 *     reds, so omitting it can only make us MORE willing to continue a parent whose own turn is
 *     genuinely over — which is correct.
 *   • `withNewAgentCalm` turns a never-briefed agent's `blocked` into `new`. Neither is resting, so
 *     it changes no decision here.
 */
function compositeStatuses(
  projects: readonly { agents: readonly AgentTab[] }[],
  raw: Record<string, AgentTabStatus>,
  stageOf: (id: string) => ReturnType<typeof resolveStage>,
): Map<string, AgentTabStatus> {
  const out = new Map<string, AgentTabStatus>();
  for (const p of projects) {
    const overlaid = withUnmergedWork(p.agents, raw, stageOf);
    // `?? "stopped"` matches withUnmergedWork's own default for an agent missing from the map (and
    // the sidebar's). An unobserved agent is therefore `stopped` — not resting — so it is gated out
    // here rather than reaching the engine as a bare `undefined`.
    for (const a of p.agents) out.set(a.id, overlaid[a.id] ?? "stopped");
  }
  return out;
}

/** What one agent's turn through the sweep did. Returned for observability and for tests that want
 *  to explain a missing send; the SIDE EFFECTS (the send, the store write, the notification) are
 *  the contract, not this. */
export interface SweepOutcome {
  agentId: string;
  action: "continue" | "escalate" | "none";
  /** The engine's reason for `none`/`escalate`, or the dispatch path for a `continue`. */
  detail: string;
  /** Only meaningful for `continue`: did the text actually reach the terminal? */
  sent?: boolean;
}

export interface SweepOptions {
  /** Injected clock, house style — so the settle-window arithmetic needs no fake timers. */
  now?: number;
  /** Single-owner election. Defaults to {@link ownsProjectInThisWindow}; injected by tests. */
  ownsProject?: (projectId: string) => boolean;
  /**
   * Re-list one SERVER project's cloud sessions so their lifecycle readings stay fresh. Defaults to
   * the real (throttled, never-throwing) refresher; injected by tests so no suite makes a request.
   */
  refreshCloudStatuses?: (cloudProjectId: string, now: number) => unknown;
}

/** The real refresher: `GET /sessions?project_id=` behind {@link CLOUD_SESSION_REFRESH_MS}'s
 *  throttle, recording every lifecycle it gets back. */
function defaultRefreshCloudStatuses(cloudProjectId: string, now: number): Promise<number> {
  return refreshCloudSessionStatuses(cloudProjectId, { api: cloudApi, now });
}

/**
 * Keep one project's cloud lifecycle readings inside their expiry window — the producer half of the
 * `cloud-session-*` gates.
 *
 * FIRE AND FORGET, NEVER AWAITED, and that is deliberate rather than lazy. The sweep already awaits
 * its sends behind a `sweeping` re-entrancy guard, so a listing that hangs (a captive portal, a
 * black-holed connection — `listSessions` carries no deadline of its own) would stall EVERY later
 * sweep, for every agent, local ones included. The cost of not awaiting is that a brand-new reading
 * lands one sweep late; the cost of awaiting is the whole feature stopping on one bad socket. The
 * settle window makes the first cost invisible in practice — nothing is eligible on the sweep that
 * first observes it at rest anyway.
 *
 * SCOPED TO PROJECTS THAT COULD USE IT: a project with no cloud binding, or with no cloud agent
 * chasing a goal, issues no request at all. A local-only user never touches the network from here.
 *
 * "CHASING A GOAL" IS `hasUnmetGoal`, NOT "the field is set" (roborev 58287). `AgentTab.goal` is
 * never cleared when a goal finishes — `goalStateOf` reads `met`/`escalated`/`expired` off a record
 * that stays defined — so a presence check kept polling forever, once a minute per bound project,
 * for readings `decideContinuation` can never act on: it answers `goal-met` / `already-escalated` /
 * `goal-expired` before it ever looks at `input.cloud`. Same predicate the decision uses, so the
 * request and the use of the request cannot drift apart.
 */
function maybeRefreshCloudStatuses(
  project: { cloudProjectId?: string | null; agents: readonly AgentTab[] },
  now: number,
  refresh: (cloudProjectId: string, now: number) => unknown,
): void {
  const cloudProjectId = project.cloudProjectId;
  if (!cloudProjectId) return;
  if (!project.agents.some((a) => a.runtime === "cloud" && hasUnmetGoal(a.goal, now))) return;
  try {
    // The refresher swallows its own IO failures; this catch is for a bad injection or a synchronous
    // throw. A failed refresh must never take the sweep down — the readings simply age out.
    void Promise.resolve(refresh(cloudProjectId, now)).catch((e: unknown) => {
      log.debug("goals", "cloud session-status refresh failed", { error: String(e) });
    });
  } catch (e) {
    log.debug("goals", "cloud session-status refresh threw", { error: String(e) });
  }
}

// ── Module state ────────────────────────────────────────────────────────────────────────────────
// Two maps, both window-local and both deliberately NOT persisted. A restart resets the idle clock,
// which means an agent that was already stalled when the app came up waits one more settle window
// before it is continued. That is the right default: a freshly-booted window has observed nothing,
// and "it looked idle for the two seconds I have been running" is not evidence of a stall.

let idleClock: Map<string, number> = new Map();
/** Agents with a send in flight RIGHT NOW. The intra-sweep half of the one-send-per-turn rule: the
 *  idle-clock re-arm below only lands after the await, so without this a second sweep starting
 *  while a slow PTY write is still pending would decide to send again off the pre-send clock. */
const inFlight = new Set<string>();
/** agentId → how many auto-continues IN A ROW never reached the terminal for the SAME REASON, and
 *  what that reason was. See {@link MAX_UNDELIVERED_CONTINUES}. Cleared by a delivery and by an
 *  escalation.
 *
 *  ── THE REASON IS PART OF THE STREAK, NOT A LABEL ON IT (bead sparkle-phb1h (d)) ───────────────
 *  It used to be a label: the count advanced on ANY refusal and only the last path was remembered,
 *  so three refusals with three different causes reached the bound and escalated with the reason of
 *  whichever one happened to be third. That is not the fact the bound is meant to certify — its own
 *  doc says "only a condition that holds across three consecutive settle windows escalates" — and it
 *  meant a structural refusal that will never change (a dead PTY) shared its three strikes with a
 *  transient one (a PTY still coming up). The count now RESETS when the reason changes, so each
 *  reason gets its own budget and the escalation names a condition that actually held three times.
 *
 *  The key stays the agent id so the roster prune below still reaches every entry. */
const undelivered = new Map<string, { count: number; reason: string }>();
/** agentId → epoch ms until which this sweep must not type anything into it. See
 *  {@link suppressContinuation}. */
const suppressedUntil = new Map<string, number>();

/** Test seam: forget the idle clock, any in-flight sends, the undelivered streaks, and any
 *  suppressions. */
/** Agents whose expiry refusal has already been logged, so a 15-second sweep does not shout.
 *
 *  ONCE PER AGENT PER REASON, not once per sweep: a given refusal is a steady state — an unreadable
 *  PR probe stays unreadable — so a line per pass would be ~5,700 a day per stuck agent and would
 *  bury the one that matters. But NOT once per agent either: see `noteExpiryRefusal` for why the
 *  narrower key silently hid every reason after the first.
 *
 *  ⚠️ BOUNDED BY THE LIVE ROSTER × REASONS **BECAUSE IT IS GARBAGE-COLLECTED**, not by assertion —
 *  an earlier version of this comment claimed the bound while nothing pruned it, so the real bound
 *  was every agent id seen since app start. It is swept beside `undelivered` on every pass;
 *  `_resetGoalContinuationRunnerForTests` is a TEST seam and was never the production answer. */
const loggedExpiryRefusal = new Set<string>();

/** ONCE PER AGENT PER REASON, for the `none` arms that carry a REMEDY (roborev 78977).
 *
 *  `goal-misspecified` is a function of the goal text and the repo's merge protection, evaluated
 *  ahead of every status gate, and NOTHING CLEARS IT — the goal stands until a human rewrites it. So
 *  an ungated log re-emits an identical line every sweep (15s), ~5.7k lines/day/agent, which is
 *  precisely the wall of repeated noise `isStuckRefusal` above exists to prevent: it trains the
 *  reader to skip the band, and the band is the surface this remedy was routed to in the first
 *  place. Same key shape and same prune site as `loggedExpiryRefusal`; see that Set's note for why
 *  the key carries the REASON and not the agent id alone. */
const loggedRemedy = new Set<string>();

/** A short, colon-free identity for a goal's text — see `remedyKey`'s note for why the key needs
 *  one and why it must not contain a colon. Not a hash for security, only for distinguishing one
 *  goal from the next on the same agent. */
function goalFingerprint(text: string | undefined): string {
  let h = 5381;
  for (let i = 0; i < (text?.length ?? 0); i++) h = ((h << 5) + h + (text as string).charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/**
 * Is this refusal worth telling anyone about?
 *
 * Only the ones that describe a STUCK agent. `not-expired` is every healthy goal on every sweep, and
 * `cloud-runtime` / `no-worktree` are permanent facts about what an agent IS rather than states it
 * can leave — surfacing those would be a wall of noise that trains the reader to skip the band
 * entirely, which is how the signal that matters gets lost.
 */
function isStuckRefusal(reason: NoExpiryReason): boolean {
  return reason !== "not-expired" && reason !== "cloud-runtime" && reason !== "no-worktree";
}

/** Log an expiry refusal that would otherwise be invisible — once per agent; see the Set above. */
function noteExpiryRefusal(agent: AgentTab, reason: NoExpiryReason, now: number): void {
  // ⚠️ KEYED ON AGENT **AND REASON**, not on the agent alone. Keyed on the id, only the FIRST reason
  // an agent ever refused with is ever logged — and the first one is systematically the least
  // informative: `expiryProofFor` answers `undefined` whenever `branchStatus` is absent, which is
  // exactly the state a freshly-launched window is in (it boots clean by design). So an expired goal
  // swept before the branch probe lands logs `evidence-unreadable`, latches the id, and the true
  // steady-state reason that arrives seconds later — `landed-but-dirty`, `worktree-parked`,
  // `pr-state-unknown` — is suppressed for the life of the process. That is the opposite of the
  // point. The comment above is also corrected: `evidence-unreadable` is the ONE refusal here that
  // is reliably TRANSIENT, so it must not be able to shadow the ones that are not.
  const key = `${agent.id}:${reason}`;
  if (loggedExpiryRefusal.has(key)) return;
  loggedExpiryRefusal.add(key);
  log.warn("goals", "expiry could not decide", {
    agentId: agent.id,
    reason,
    goalAgeMs: agent.goal === undefined ? undefined : now - agent.goal.setAt,
    ttlRearms: agent.goal?.ttlRearms ?? 0,
  });
}

export function _resetGoalContinuationRunnerForTests(): void {
  idleClock = new Map();
  loggedExpiryRefusal.clear();
  loggedRemedy.clear();
  inFlight.clear();
  undelivered.clear();
  suppressedUntil.clear();
  externalWaitSeen.clear();
  inMotionSeen.clear();
  toolActivity.clear();
}

/**
 * agentId → the last windowed tool count we saw, and how many times it has been seen to GO UP.
 *
 * ⚠️ THE RAW COUNT IS NOT A PROGRESS SIGNAL, AND USING IT AS ONE WAS A DEFECT (roborev 65440,
 * Medium). `HookFacts.toolsRecent` is a count over a SLIDING 15-minute window, so it moves for two
 * reasons and only one of them is work:
 *
 *   • it goes UP when the agent runs tools — real evidence;
 *   • it goes DOWN, all by itself, as old events age out of the window.
 *
 * Fed straight into `progressMark`, the second one reads exactly like the first: an agent that
 * genuinely stopped decays 41 → 30 → … → 0 over a quarter of an hour, and EVERY decrement moves the
 * mark, resets the consecutive streak, and pushes the escalation further away. The same is true of a
 * failed digest poll, which republishes `{}` and drops the reading to null.
 *
 * So the count is folded into a MONOTONE counter instead: `bursts` advances only when the reading is
 * strictly greater than the previous one. Decay leaves it flat, a poll gap leaves it flat, and only
 * new tool activity moves it — which is the property the mark's string comparison needs and the raw
 * sample cannot provide. This is `engine/movementRetraction.noteMovement`'s high-water-mark trick
 * applied to the other consumer of the same stream, and for the same underlying reason (that
 * module's header note 3).
 *
 * WHAT THIS DELIBERATELY DOES NOT FIX, stated because the review raised it and the answer is a
 * judgement rather than an oversight: tools the agent runs INSIDE the resumed turn still count, so
 * an agent that answers every resume with a couple of `Read`s keeps its streak alive and is only
 * caught by {@link MAX_CONTINUES_TOTAL}. That is weaker than the 3-strike bound but it is NOT the
 * `turnsRecent` failure the doc rejects: a turn counter moves on every attempt with certainty,
 * including for an agent that answers with pure prose and stops — which is precisely the observed
 * pathology (`continuePrompt`'s note: "three identical banners, three status reports, no progress").
 * Prose runs no tools, so the streak bound is still reachable for the case it was written for. The
 * residual costs a LATER page; reading decay as progress cost false ones, and this is the founder's
 * stated ordering.
 */
const toolActivity = new Map<string, { lastSeen: number; bursts: number }>();

/**
 * agentId → the external gate this window is currently watching, and WHEN it first saw that exact
 * gate. See `engine/goalContinuation.ExternalWait.since` for what the age buys.
 *
 * A FIRST-SEEN LEDGER, NOT A DURATION, and the distinction is what makes it honest across a
 * restart: nothing here is persisted, so a window that has just booted reports `since: null` — "I
 * cannot say how long" — rather than "the gate appeared just now", which would silently restart the
 * grace on every relaunch and could park an agent forever in a crash loop.
 *
 * KEYED ON THE GATE'S IDENTITY, so a DIFFERENT PR restarts the clock. Without the signature an
 * agent that landed #10 and opened #11 would inherit #10's age and could be escalated for a gate
 * that is minutes old. `undefined` clears the entry: a gate that goes away has no age to keep.
 *
 * WRITTEN ONLY BY THE SWEEP (see the fold at its call site) and garbage-collected beside its
 * siblings, for the reason spelled out there: an id reused by a new agent must not inherit an age.
 */
const externalWaitSeen = new Map<string, { signature: string; since: number }>();

/** agentId → epoch ms this window first saw the agent CONTINUOUSLY in motion (a running child).
 *  Mirrors {@link externalWaitSeen}: the sweep folds it via {@link noteInMotion}, and the shared
 *  {@link continuationEvidenceFor} reads it, so the decision and the `resumeReading` prediction take
 *  the same age and cannot drift. Presence is recomputed LIVE in the builder; this holds only the age. */
const inMotionSeen = new Map<string, number>();

/**
 * Fold the first-seen-in-motion ledger for one agent. `inMotionNow` is the sweep's live reading; a
 * `false` CLEARS the entry, so a child that settles and a later one that starts are two separate
 * motions with two separate ages rather than one that looks stuck. Called once per agent per sweep,
 * BEFORE {@link continuationEvidenceFor} reads it — the same fold-then-read order as the burst ledger.
 */
export function noteInMotion(agentId: string, inMotionNow: boolean, now: number): void {
  if (!inMotionNow) {
    inMotionSeen.delete(agentId);
    return;
  }
  if (!inMotionSeen.has(agentId)) inMotionSeen.set(agentId, now);
}

/**
 * The motion gate for one agent — LIVE presence plus its ledger age — or `undefined` when no child is
 * running. Mirrors {@link externalWaitOf}: presence is recomputed every call from already-polled
 * window state (worker statuses + the background-task footer count), so the predictor never lags on
 * whether a child exists; only the AGE comes from the ledger the sweep folds. `since: null` when the
 * ledger has not been folded for this agent yet — the UNTIMED case the pure gate refuses to park on.
 */
function inMotionOf(agent: AgentTab): { since: number | null } | undefined {
  const siblings =
    useProjectStore.getState().projects.find((p) => p.agents.some((a) => a.id === agent.id))?.agents ?? [agent];
  const running =
    isInMotion(agent.id, siblings, useRuntimeStore.getState().status) ||
    hasLiveBackgroundTasksForAgent(agent.id);
  if (!running) return undefined;
  return { since: inMotionSeen.get(agent.id) ?? null };
}

/**
 * Fold ONE tick's windowed tool count into {@link toolActivity} and return the burst counter.
 *
 * ⚠️ THIS ADVANCES STATE, so it must be called exactly ONCE per agent per sweep, and never from a
 * read-only surface — see {@link continuationEvidenceFor}, which only reads. A second caller folding
 * the same tick would double-count nothing (the counter moves on a strict increase, and the second
 * fold sees an unchanged `lastSeen`), but it WOULD move `lastSeen` forward for a reader that has no
 * business advancing anyone's clock.
 *
 * `null` — no digest for this agent — is SILENCE, not a reading: the counter is returned unchanged
 * and `lastSeen` is left alone, so a poll gap cannot manufacture movement when the digest returns.
 */
export function noteToolActivity(
  agentId: string,
  toolsRecent: number | null,
  /**
   * The burst count this agent's PERSISTED mark already carries — see {@link burstsOf}.
   *
   * ⚠️ WITHOUT IT, EVERY APP RESTART HANDS EVERY AGENT ONE FREE "PROGRESSED" (roborev 65483). This
   * ledger is module-local webview state; the mark it feeds is persisted on the goal
   * (`projectStore`, beside `continues`). After a reload the ledger is empty, so a cold baseline of
   * 0 is compared against a stored mark reading `…␀4␀…` — the two differ, `decideContinuation` calls
   * that progress, and `noteAgentGoalContinue` rewrites `continues` to 1. A wedged agent on a
   * machine that restarts more often than it accumulates three settled strikes could then never
   * reach the 3-strike escalation at all. Seeding from the stored value closes it, and closes the
   * same gap between two WINDOWS: a satellite window's sweep and the main window's prediction both
   * start from the one number that is actually shared.
   */
  seedBursts: number | null = null,
): number {
  const prev = toolActivity.get(agentId);
  if (toolsRecent === null) return prev?.bursts ?? seedBursts ?? 0;
  if (prev === undefined) {
    // FIRST SIGHTING IS A BASELINE, NOT A BURST. Counting it would make every agent's first sweep
    // after a window start read as progress — including the ones that have been idle for hours.
    // The LEVEL starts here; the COUNT resumes from whatever the persisted mark already claimed.
    const bursts = seedBursts ?? 0;
    toolActivity.set(agentId, { lastSeen: toolsRecent, bursts });
    return bursts;
  }
  const bursts = toolsRecent > prev.lastSeen ? prev.bursts + 1 : prev.bursts;
  toolActivity.set(agentId, { lastSeen: toolsRecent, bursts });
  return bursts;
}

/** What {@link continuationEvidenceFor} hands to `decideContinuation` — the two fields BOTH callers
 *  must agree on. */
export interface ContinuationEvidence {
  mark: string;
  externalWait: ExternalWait | undefined;
  /** A running child gate, or undefined — see engine/goalContinuation ContinuationInput.inMotion.
   *  Built here so the sweep and `resumeReading` apply the identical park; presence live, age from
   *  the ledger the sweep folds. */
  inMotion: { since: number | null } | undefined;
  /**
   * Whether this agent's repo is one Sparkle may merge in — see `agentGoal.MergeAuthorityEvidence`.
   *
   * ⚠️ BUILT HERE RATHER THAN AT THE SWEEP'S CALL SITE, and that is the whole reason this field is on
   * the shared builder. `controlListener.resumeReading` PREDICTS what the sweep will decide and
   * spreads this object wholesale; wiring the gate into the sweep alone would make the prediction
   * answer `willResume: true` for an agent the sweep declines as `goal-misspecified` — the exact
   * drift roborev 65440 (High) recorded for the mark and the external gate. One builder, one answer.
   */
  mergeAuthority: MergeAuthorityEvidence | undefined;
}

/**
 * The progress mark and the external gate for one agent — THE ONE PLACE either is built.
 *
 * ⚠️ `decideContinuation` HAS TWO PRODUCTION CALLERS AND THEY MUST NOT DRIFT (roborev 65440, High).
 * The sweep decides; `controlListener.resumeReading` PREDICTS what the sweep will decide, and that
 * prediction is its entire value — its own docstring says so ("A second answer would drift from the
 * one that actually decides"). When the artifact signals were added to the sweep only, the two marks
 * stopped matching for any agent with evidence: the sweep would record
 * `0␀␀␀2␀3␀open#2117` while the prediction recomputed `0␀␀␀␀␀`, so `live.mark !== mark` read as
 * PROGRESS, the streak arm could never fire in the prediction, and `set_agent_escalation` answered
 * `willResume: true` for an agent the very next sweep would escalate — the empty success that
 * function exists to prevent. The gate drifted the other way: a gated agent the sweep will CONTINUE
 * was reported `willResume: false, blockedBy: "would-re-escalate"`.
 *
 * READ-ONLY. It never advances {@link toolActivity} — the sweep folds the tick itself, once, before
 * calling this. A prediction between sweeps therefore reads the evidence as of the last sweep, which
 * is exactly what "what will the next sweep do" means.
 *
 * Every input is already-polled window-local state: no git call, no network. See the note at the
 * sweep's call site for why that is a requirement rather than an optimisation.
 */
export function continuationEvidenceFor(agent: AgentTab): ContinuationEvidence {
  const rt = useRuntimeStore.getState();
  const ws = rt.workflowState?.[agent.id];
  return {
    mark: progressMark({
      promptHistoryLength: agent.promptHistory.length,
      activity: agent.activity,
      aiTitle: agent.aiTitle,
      // The MONOTONE counter, never the raw window sample — see `toolActivity`. Falls back to the
      // count the agent's own PERSISTED mark carries, so a window whose ledger is cold (a fresh
      // launch, or a prediction taken before this window has ever swept the agent) reproduces the
      // recorded token instead of manufacturing a difference from its own ignorance.
      toolBursts: toolActivity.get(agent.id)?.bursts ?? burstsOf(agent.goal?.mark),
      commitsAhead: rt.branchStatus?.[agent.id]?.ahead ?? null,
      prMark: prMarkOf(ws),
    }),
    externalWait: externalWaitOf(ws, agent.id),
    inMotion: inMotionOf(agent),
    mergeAuthority: mergeAuthorityFor(agent.id),
  };
}

/**
 * Is the repo this agent works in one Sparkle is FORBIDDEN to merge in?
 *
 * ⚠️ EVERY UNCERTAINTY RESOLVES TO `undefined`, WHICH MEANS "LEAVE THE GOAL ORDINARY" — the opposite
 * of this file's usual fail-closed direction, and chosen for the reason
 * `agentGoal.MergeAuthorityEvidence` sets out: the gate this feeds STOPS the ladder, so a false
 * positive silences a real stall while a false negative costs only the status quo.
 *
 * `slugForRoot` is a CACHE and its `null` is genuinely ambiguous — "we have not resolved this root
 * yet" and "this root has no GitHub slug we recognise" are the same value at that seam (see its own
 * header). Both are "could not tell" here, and both are `undefined`. That ambiguity is safe in this
 * direction and would not be in the other, which is why the positive arm requires a RESOLVED slug.
 *
 * READ-ONLY AND SYNCHRONOUS, like everything else this builder touches: no git call, no network, no
 * prime. The cache is filled at hydrate by the tool-policy binding; a cold one costs a sweep in
 * which the goal is treated as ordinary, which is what it is treated as today.
 */
function mergeAuthorityFor(agentId: string): MergeAuthorityEvidence | undefined {
  let root: string | null = null;
  try {
    for (const project of useProjectStore.getState().projects) {
      if (project.agents.some((a) => a.id === agentId)) {
        root = project.rootPath ?? null;
        break;
      }
    }
  } catch {
    // An unreadable project store is "we don't know which repo" — ordinary, never unsatisfiable.
    return undefined;
  }
  if (root === null) return undefined;
  const slug = slugForRoot(root);
  if (slug === null) return undefined;
  return { mergeProtectedRepo: isPinnedMergeProtectedSlug(slug), repo: slug };
}

/**
 * Hold off auto-continuing one agent until `untilMs`.
 *
 * ── THE COLLISION THIS EXISTS TO STOP ─────────────────────────────────────────────────────────
 * The instant the resurrector admits a dead agent, its pane mounts and then SITS IDLE while
 * `claude --resume` boots — a worktree prep, a transcript scan, an account pick and the model
 * re-reading its whole context. At `IDLE_SETTLE_MS` (45s) this sweep sees a goal-carrying agent that
 * has been continuously at rest and does exactly what it is built to do: types a continue into it.
 *
 * That is wrong twice over, and the second one is the expensive one. It spends one of the agent's 20
 * continues on a turn it never needed — but worse, if that agent is a cohort's CANARY it pollutes
 * the survival evidence the whole cohort is waiting on. `advanceProbation` judges `hasTurnAuthority`
 * and `didWork` at the deadline; a continue typed in at t+45s manufactures both, so a canary that
 * booted into a still-closed door would report a clean probation and release 48 agents behind it.
 *
 * REUSES THE `inFlight` SKIP rather than adding a gate of its own — the sweep already has exactly
 * one place where an agent is passed over without spending anything from any budget, and this is the
 * same shape: no send, no retry recorded, no idle-clock re-arm, so the agent is continued normally
 * the moment the suppression lapses.
 *
 * Idempotent and monotonic: a second call may only ever push the deadline LATER. A respawn that
 * happens mid-probation must not be able to shorten a hold that is already running.
 */
export function suppressContinuation(agentId: string, untilMs: number): void {
  const existing = suppressedUntil.get(agentId);
  if (existing !== undefined && existing >= untilMs) return;
  suppressedUntil.set(agentId, untilMs);
}

/** Is this agent currently held off? Exported so a test can assert the rule directly rather than
 *  only through the absence of a send. */
export function continuationSuppressedUntil(agentId: string): number | undefined {
  return suppressedUntil.get(agentId);
}

/**
 * How many consecutive auto-continues may fail to REACH the terminal before we stop retrying and
 * tell the human.
 *
 * This is a different bound from `MAX_CONTINUES_WITHOUT_PROGRESS`, and conflating them is the bug it
 * was added for. That one asks "we restarted the agent and it still isn't moving" — it counts
 * DELIVERED sends, and `continueAgent` deliberately records a retry only after a delivery it watched
 * succeed, so an undelivered send costs nothing from that budget. Correct, and by itself
 * open-ended: a send that is refused for a STRUCTURAL reason is refused identically on every sweep,
 * so the pair "try, get refused, re-arm the settle window" repeats for as long as the condition
 * holds. Observed in the field as an agent whose pane sat in a full-screen app: the auto-resume was
 * refused at the dispatch chokepoint every ~45s for over five hours, ~400 times, and the only trace
 * was a WARN line. The agent never moved, the goal was never met, and nobody was told.
 *
 * Three is the same shape as the progress bound for the same reason — enough to ride out a
 * transient (a pane mid-remount, a PTY that came up a beat late) without turning a permanent
 * condition into an unbounded loop. At one send per settle window that is ~2¼ minutes of silence
 * before the human hears about it.
 */
export const MAX_UNDELIVERED_CONTINUES = 3;

/**
 * Why an auto-continue did not reach the terminal: a dispatch path, or `"threw"` for the one
 * outcome the dispatcher cannot report because it never returned.
 *
 * TYPED AGAINST THE CLOSED UNION rather than `string`. `ConciergeDispatchPath` is exhaustive by
 * design, and taking a bare `string` here quietly opted this ladder out of that guarantee: a path
 * renamed or removed on the dispatch side would still typecheck here and silently fall through to
 * the default arm, which is the one that cannot name a remedy. It also meant nothing checked that
 * every arm below corresponds to a path that actually exists — the reason `agent-failed` could sit
 * under the wrong remedy without a compiler complaint.
 */
type UndeliveredPath = ConciergeDispatchPath | "threw";

/**
 * The agent branch's pull request as ONE opaque token for {@link progressMark}, or `null` when this
 * window has no reading.
 *
 * `state#number` rather than either alone: the state moving (`open` → `merged`) and the number
 * appearing (no PR → `open#2117`) are both the agent having done something, and joining them means
 * one field in the mark covers both without the engine learning GitHub's vocabulary.
 *
 * A `prState` of `null` yields `null`, deliberately, and it is NOT the same as "no PR". Rust sends
 * `null` both for "probed, found nothing" and for a poll that never probed (`probePrState` is
 * gated), so the two are indistinguishable here — the ambiguity `WorkflowState.hasRemote`
 * documents for its own `false`. `progressMark` renders `null` as an empty token, which is right:
 * we are saying we do not know, not that there is no PR.
 *
 * Exported as a test seam, like {@link undeliveredStreakFor} below: it is the one place the
 * store's PR reading is turned into evidence, and the ambiguity note above is a rule no assertion
 * on the sweep's output could pin.
 */
export function prMarkOf(ws: WorkflowState | undefined): string | null {
  if (ws === undefined || ws.prState === null) return null;
  return `${ws.prState}#${ws.prNumber ?? ""}`;
}

/**
 * Is this agent's work parked behind an external gate — see `engine/goalContinuation.ExternalWait`.
 *
 * ONLY `prState === "open"` QUALIFIES, and only the positive reading is used. `merged`/`closed` mean
 * the gate has already answered, so there is nothing to wait for and an idle agent there really may
 * be stuck. `null` is the ambiguous reading above and must not be turned into a negative finding
 * either way: it simply produces no gate, which escalates exactly as before.
 *
 * Exported as a test seam for the same reason as {@link prMarkOf}.
 */
export function externalWaitOf(ws: WorkflowState | undefined, agentId: string): ExternalWait | undefined {
  const gate = externalGateOf(ws);
  if (gate === undefined) return undefined;
  const seen = externalWaitSeen.get(agentId);
  // THE SIGNATURE MUST MATCH, not merely exist. A stale entry for a PREVIOUS gate would hand this
  // one somebody else's age — see the ledger's note — and the fold below only rewrites the entry on
  // a sweep, so a prediction taken between sweeps can legitimately see a gate the ledger has not
  // caught up with. Unmatched reads as `null`: "I cannot say", which keeps today's behaviour.
  const since = seen !== undefined && seen.signature === signatureOf(gate) ? seen.since : null;
  return { ...gate, since };
}

/** The gate's IDENTITY, with no age attached — the half `noteExternalWait` and `externalWaitOf`
 *  must agree on. One reader, one writer, one derivation. */
function externalGateOf(ws: WorkflowState | undefined): Omit<ExternalWait, "since"> | undefined {
  if (ws?.prState !== "open") return undefined;
  return { kind: "open-pr", prNumber: ws.prNumber };
}

function signatureOf(gate: Omit<ExternalWait, "since">): string {
  return `${gate.kind}#${gate.prNumber ?? ""}`;
}

/**
 * FOLD the external-gate ledger for one agent — the ONLY writer, called once per agent per sweep.
 *
 * Same shape and the same reason as {@link noteToolActivity} directly above: the sweep advances the
 * ledger, and `continuationEvidenceFor` — which `controlListener.resumeReading` also calls to
 * PREDICT what the sweep will decide — only ever reads it. A prediction that folded would age a
 * gate on a schedule nothing else shares, and the two answers would drift.
 *
 * Idempotent for an unchanged gate: re-stamping `since` on every sweep is precisely the bug that
 * would make the grace unreachable, because the age would reset to zero fifteen seconds at a time.
 */
export function noteExternalWait(
  agentId: string,
  ws: WorkflowState | undefined,
  now: number,
): void {
  const gate = externalGateOf(ws);
  if (gate === undefined) {
    externalWaitSeen.delete(agentId);
    return;
  }
  const signature = signatureOf(gate);
  if (externalWaitSeen.get(agentId)?.signature === signature) return;
  externalWaitSeen.set(agentId, { signature, since: now });
}

/** Test/introspection seam: when did this window first see the gate it is currently watching? */
export function externalWaitSinceFor(agentId: string): number | undefined {
  return externalWaitSeen.get(agentId)?.since;
}

/** Test/introspection seam: how many auto-continues in a row have failed to reach `agentId`? */
export function undeliveredStreakFor(agentId: string): number {
  return undelivered.get(agentId)?.count ?? 0;
}

/** The streak key: the dispatch path, plus the screen verdict when there is one. Two refusals with
 *  the same path but different screens are different conditions and get different budgets. */
function refusalReasonKey(path: UndeliveredPath, screenVerdict?: AltScreenRefusalVerdict): string {
  return screenVerdict === undefined ? path : `${path}/${screenVerdict}`;
}

/** Quote up to the first few menu labels for the alternate-screen "a dialog is waiting" copy, so the
 *  human is told WHICH question is on the screen rather than being sent to hunt for it. Empty in →
 *  empty string out, so the caller can concatenate unconditionally. */
function namedMenuOptions(labels: string[]): string {
  const shown = labels
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 4);
  if (shown.length === 0) return "";
  const quoted = shown.map((l) => `"${l}"`).join(", ");
  const more = labels.length > shown.length ? ", …" : "";
  return ` — the options are ${quoted}${more}`;
}

/**
 * WHY THERE IS NO SHARED BLOCKED-PROMPT SENTENCE HERE ANY MORE.
 *
 * There was one, read by two arms of {@link undeliverableReason}, and it was removed deliberately —
 * twice over, for two independent reasons that point the same way:
 *
 *  1. THE COPY WAS WRONG WHEN BORROWED. The label-less form is a CLAIM (a password / a host-key /
 *     a yes-no), true only on the path that positively identified a prompt by KIND. Reached from
 *     `alternate-screen`, where all that was observed is a dialog frame, it told the human a
 *     credential prompt was waiting on a screen where none was seen — and each false claim spends
 *     one of the finite `MAX_CONCIERGE_REARMS`. (roborev 75882, High.)
 *
 *  2. THE COPY BECAME UNAUDITABLE. `scripts/screen-refusal-copy-drift.sh` grades these arms by
 *     reading the ARM's own lines: RULE A forbids an `alternate-screen` sentence from claiming a
 *     'permission dialog', RULE B requires the `blocked-prompt` arm to name one. With the
 *     sentences behind a helper both arms read as empty, so BOTH rules passed vacuously on the one
 *     file whose routing change (bead sparkle-d6a5r) they exist to police.
 *
 * De-duplicating founder-facing copy is normally right — AGENTS.md § User-facing copy is code. It
 * is wrong HERE because the two arms are not saying the same thing: they describe screens observed
 * by different probes, and the guard's whole job is to check that they keep describing them
 * differently. Each arm spells its own sentences, at the arm.
 */

/**
 * What to tell the human when auto-continue could not DELIVER, keyed on the dispatch path.
 *
 * Every arm names the obstacle and the remedy, because the generic escalation copy is actively
 * misleading here: "Something is blocking it that restarting cannot fix" sends someone hunting for a
 * mystery blocker inside the agent's work, when the truth is that the message never arrived and the
 * fix is a few seconds of pane-wrangling. A wrong diagnosis costs more than no diagnosis.
 *
 * The default arm is deliberately vague rather than guessing: it still says the one fact that
 * matters — nothing was delivered — and names the path so a log or a bug report can identify it.
 */
function undeliverableReason(
  goalText: string,
  path: UndeliveredPath,
  isCloud: boolean,
  /** For the SCREEN paths (`alternate-screen`, `blocked-prompt`): the live menu labels the
   *  dispatcher's screen probe found, or `undefined` when it found none (`blind:'no-menu'`, and a
   *  credential field, which never carries labels by construction). Undefined for every other path.
   *  See {@link ConciergeDispatchResult.liveMenuLabels} and beads sparkle-j2gase, sparkle-d6a5r. */
  liveMenuLabels?: string[],
  /** For `alternate-screen` only: what {@link altScreenRefusalVerdict} made of the screen the
   *  refusal was taken against. Undefined on every other path, and on a call that never asked. */
  screenVerdict?: AltScreenRefusalVerdict,
): string {
  // THE SCREEN ARMS ARE RUNTIME-AWARE TOO, not just the closing sentence. Both of these fire for a
  // cloud agent — the guards that produce them run BEFORE the cloud branch and read the RELAYED
  // viewport — so keying only the closing on the runtime produced a message that contradicted
  // itself in adjacent sentences: "its TERMINAL is waiting at a prompt … Nothing reached the
  // SANDBOX." Same defect as the closing, one clause earlier (roborev 58551).
  const screen = isCloud ? "its sandbox screen" : "its terminal";
  const pane = isCloud ? "its pane" : "the pane";
  const why =
    path === "alternate-screen"
      ? // ── NAME THE EVIDENCE, NOT A GUESS DRESSED AS ONE (bead sparkle-saoe3) ────────────────
        // This used to read "is sitting in a full-screen app (vim/less/htop)". That sentence
        // asserts as fact something this path does not know and, in the field, is essentially
        // never true: the refusal fires on `alternateBuffer && !isClaudeCodeScreen`, and CLAUDE
        // CODE ITSELF holds the alternate buffer — its permission dialog replaces the composer box
        // `isClaudeCodeScreen` requires, so an ordinary approval prompt takes this exact path.
        //
        // The cost was measured on one afternoon's escalations: five agents frozen with this
        // reason, every one of them a normal Claude Code pane stopped at `Do you want to proceed?`,
        // not one in an editor or a pager. The remedy compounded it — "quit that app in the pane"
        // is an instruction a human CANNOT follow when there is no app to quit, so the escalation
        // named an obstacle that did not exist and withheld the one that did. AGENTS.md's rule for
        // remedy strings applies exactly here: a refusal's suggested action is an instruction the
        // user will follow, and it needs the same scrutiny as the code path it replaces.
        //
        // ── AND IT BRANCHES ON THE MENU PROBE, because one string for two states cost the human a
        // trip (bead sparkle-j2gase). BOTH states reach this same `alternate-screen` path, but the
        // dispatcher already KNOWS which one it is: the SAME `liveOptionsFor` read that made the
        // refusal decision is carried on `liveMenuLabels`. A live menu (a Claude Code permission
        // dialog, reached by a free-text send) has options — there IS a question, name it and say
        // "answer it". No menu (`blind:'no-menu'` — a pager or editor holds the buffer) has none —
        // "answer what is on screen" is a dead instruction there, so say the true remedy: quitting it
        // is safe and will not lose the turn. Measured: four agents in one morning, every one a
        // no-menu pager, all told to go find a dialog that was not there.
        //
        // ── AND THE NO-MENU BRANCH IS GONE ENTIRELY (bead sparkle-phb1h) ─────────────────────
        // It used to say "a pager or editor is holding the screen". That is the SAME class of
        // unwarranted claim the comment above corrected once already, one branch further down:
        // the refusal fires on `!isClaudeCodeScreen`, and a Claude Code screen that has merely
        // lost its composer box fails that predicate. Measured three times on 2026-08-20 — every
        // one an ordinary Claude Code pane answering `present=false, blind='no-menu'` live, one of
        // them seconds after MERGING ITS PR. Two of the three were latched, and un-latching spends
        // one of the finite `MAX_CONCIERGE_REARMS`.
        //
        // So the ladder no longer escalates that state at all — see `noteUndelivered`, which fails
        // OPEN on every `alternate-screen` verdict but `claude-dialog`, on the founder's own
        // instruction. This arm is what a `claude-dialog` verdict says, and it says it in the
        // BLOCKED-PROMPT words: that copy already tells the human to answer the prompt in the pane,
        // which is the true remedy for the one alternate-screen shape that still reaches a human.
        // The second branch is defensive — reachable only if a future caller escalates a verdict
        // this one does not — and it claims nothing it cannot see.
        //
        // ── THIS ARM OWNS ITS WORDS, AND MUST NOT BORROW THE OTHER PATH'S ───────────────────
        // It used to call the shared `blockedPromptSentence`. That sharing was the roborev 75882
        // defect — the label-less form leaked a credential claim onto a screen where none was
        // observed — and patching it with a discriminator left a worse problem behind: with the
        // copy living in a helper, `screen-refusal-copy-drift.sh` reads BOTH arms as empty, so
        // RULE A (no `alternate-screen` sentence may claim a permission dialog) and RULE B
        // (the `blocked-prompt` arm must name one) both went VACUOUS on this file. A guard that
        // cannot see the copy it grades is worse than no guard, because it reports ok.
        //
        // So each arm spells its own sentences, and the two say DIFFERENT things because the two
        // paths observed different things:
        //   • WITH a menu — options were actually read off the viewport, so name them and ask for
        //     an answer. It is a "dialog", NOT a "permission dialog": that phrase belongs to
        //     `blocked-prompt`, whose classifier identified the prompt by KIND. All that was seen
        //     here is a dialog frame (bead sparkle-d6a5r, and RULE A of the drift guard).
        //   • WITHOUT one — say only that a dialog is there whose options could not be read.
        screenVerdict === "claude-dialog" || (liveMenuLabels && liveMenuLabels.length > 0)
          ? liveMenuLabels && liveMenuLabels.length > 0
            ? `${screen} has a dialog waiting for your answer${namedMenuOptions(liveMenuLabels)}. It is a decision the auto-resume cannot make for you — open ${pane} and choose what is on screen, and the auto-resume will take over again`
            : `${screen} has a dialog on it whose options the auto-resume could not read — open ${pane} and answer what is on screen, and the auto-resume will take over again`
          : `${screen} is showing something the auto-resume could not recognise, and it found no menu on it — so nothing is known to be waiting on an answer. Open ${pane} to see what it is showing`
      : path === "blocked-prompt"
        ? // ── A PERMISSION DIALOG ARRIVES HERE NOW (bead sparkle-d6a5r) ─────────────────────────
          // It used to take `alternate-screen` and be described as an editor or a pager, which the
          // arm above already had to correct once. `conciergeDispatch` classifies it as what it is,
          // which routes it to THIS sentence — so this list has to lead with it rather than
          // enumerating only the credential shapes, or the escalation names every cause but the one
          // the human is actually looking at.
          //
          // ── AND IT BRANCHES ON THE MENU PROBE, FOR THE REASON THE ARM ABOVE DOES ──────────────
          // Reclassifying the dialog fixed the diagnosis and broke the SPECIFICS: the arm above
          // names the actual question and its options, and this one enumerated four candidate
          // causes — a permission dialog, a password, a host-key confirmation, a yes/no — exactly
          // one of which is true, for the screen that is now the most common one to reach a
          // refusal. The dispatcher already knows which: `liveMenuLabels` carries the VIEWPORT menu
          // its own `screenBlocksWrite` interlock read. So say what is being asked when there is a
          // menu, and keep the honest enumeration for when there is not.
          //
          // ⚠️ THE NO-MENU BRANCH MUST NOT INHERIT THE PAGER REMEDY. "Quitting it is safe" belongs
          // to the arm above and is TRUE only there; a no-menu `blocked-prompt` is a credential
          // field or a confirmation, where quitting loses the turn and answering is the point.
          // Neither branch may suggest restarting the agent: this bead exists because
          // `restart_agent` — which destroys in-flight context to deliver one message — was left as
          // the only route to the pane.
          //
          // ── SPELLED OUT HERE, NOT BEHIND A HELPER ────────────────────────────────────────────
          // `screen-refusal-copy-drift.sh` RULE B greps THIS ARM for the words 'permission dialog'.
          // While these two sentences lived in a shared function the grep found nothing and the
          // rule passed vacuously — on the one file whose routing change (sparkle-d6a5r) the rule
          // was written to police. Copy that a guard grades belongs where the guard reads it.
          liveMenuLabels && liveMenuLabels.length > 0
            ? `${screen} has a permission dialog waiting for your answer${namedMenuOptions(liveMenuLabels)}. It is a decision the auto-resume cannot make for you — open ${pane} and choose what is on screen, and the auto-resume will take over again`
            : `${screen} is waiting at a prompt that must not receive free text — a password, a host-key confirmation, or a yes/no. Answer that prompt in ${pane}`
        : path === "pty-gone"
          ? "its process is gone. Restart the agent to pick the goal back up"
          : // SPLIT FROM `pty-gone`, because the remedies differ and this one already has an
            // established answer elsewhere in the app. `agent-failed` means the agent never
            // STARTED, and ConciergeHost's refusal copy for it says "open its pane and hit Retry
            // (or finish installing Claude Code)". Grouping it under "its process is gone. Restart
            // the agent" sent the user to restart something that had not run yet — a wrong
            // diagnosis, which this function's own header says costs more than no diagnosis.
            path === "agent-failed"
            ? "it never started. Open its pane and hit Retry (or finish installing Claude Code), and the auto-resume will take over again"
            : path === "cloud-offline"
              ? "it runs in the cloud and the relay is not connected. Reconnect, and the auto-resume will take over again"
              : // THE CLOUD TWIN of `alternate-screen`/`blocked-prompt`, and it only became
                // reachable when cloud agents were enabled for this sweep. `deliverCloudPrompt`
                // refuses with `cloud-agent` when the detector finds live options in the relayed
                // scrollback: the agent is asking something only a human can answer, and the
                // concierge cannot see that screen well enough to answer it. Its remedy is already
                // established everywhere else in the app — answer it in its own pane — so the
                // default arm's "the send kept coming back" plus a closing sentence about a
                // terminal the agent does not have was the wrong-diagnosis shape this function's
                // header exists to prevent.
                path === "cloud-agent"
                ? "it runs in the cloud and has a question on its own screen that only a human can answer. Open its pane and answer it there, and the auto-resume will take over again"
                : // HELD, NOT DELIVERED. `queued` reports that the PTY was still coming up and the
                // message is sitting in the hold queue — which is why the runner counts it as
                // undelivered rather than crediting it (see the dispatch site). Reaching the bound
                // on it means the pane never finished starting across the whole streak.
                path === "queued"
                ? "its terminal never finished starting, so the message was only ever held rather than typed. Open its pane to see what it is waiting on"
                : `the send kept coming back "${path}"`;
  // THE CLOSING SENTENCE IS NOT THE SAME ON EVERY PATH, and `queued` is the exception.
  //
  // Every other arm here describes a send that was REFUSED — nothing was written and nothing is
  // pending, so "nothing was typed" is simply true and stays true. A `queued` send is different:
  // it is HELD in `pendingSends` with a 2-minute TTL and flushed for real if the pane reports
  // ready. The bound trips after three sends one settle window apart — roughly 92 seconds — so at
  // the moment the human is notified, all three holds are still live and WILL be typed if the PTY
  // comes up in the next half-minute or so.
  //
  // Claiming "nothing was typed, so the agent has not seen any of it" would therefore be a
  // statement that can become false minutes after it is read, on the one surface a stuck user
  // trusts. AGENTS.md § User-facing copy is code: a change to WHEN something happens has to update
  // every place that described the old timing, and demoting `queued` to undelivered changed
  // exactly that. So this arm says what is actually guaranteed — nothing has been typed YET — and
  // names the condition under which that changes.
  //
  // AND IT IS KEYED ON THE RUNTIME, NOT ON THE PATH. Keying it on the path name looked equivalent
  // and is not: the cloud-named paths are NOT the only ones a cloud agent produces. The screen
  // guards run BEFORE the cloud branch in `dispatchConciergeAnswer` and both read the RELAYED
  // viewport, so a cloud agent stopped at a password prompt refuses with `blocked-prompt`, and the
  // runner's own catch arm produces `threw`. Either would have been told "nothing was typed into
  // the terminal" about an agent that has no terminal — the exact wording this arm exists to
  // remove, leaking through a proxy (roborev 58544).
  const closing = isCloud
    ? `Nothing reached the sandbox, so the agent has not seen any of it.`
    : path === "queued"
      ? `Nothing has been typed into the terminal yet. If its pane finishes starting within the ` +
        `next couple of minutes the held message may still go through, so check the pane before ` +
        `assuming the agent has seen nothing.`
      : `Nothing was typed into the terminal, so the agent has not seen any of it.`;
  return (
    `Auto-resume could not reach this agent ${MAX_UNDELIVERED_CONTINUES} times in a row: ${why}. ` +
    `The goal is still unmet: "${goalText}". ${closing}`
  );
}

/** Test/introspection seam: when did this window first see `agentId` come to rest? */
export function idleSinceFor(agentId: string): number | undefined {
  return idleClock.get(agentId);
}

/**
 * Re-arm one agent's idle clock, so the turn we just started has to settle again before it can be
 * continued a second time. Observable through {@link idleSinceFor}, which is what lets a test assert
 * the rule directly instead of only through the absence of a second send.
 */
function markContinued(agentId: string, now: number): void {
  idleClock.set(agentId, now);
}

/** This window's Tauri label, or the single-window default when there is no Tauri (tests, the
 *  browser preview). Never throws — an unanswerable question must not take the sweep down.
 *  Exported so `pusherMount` resolves THIS window's Improve Sparkle id the same way the ownership
 *  election does, rather than guessing an arbitrary roster match. */
export function currentWindowLabel(): string {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return APP_WINDOW_LABEL;
  try {
    // Lazy require-shaped access so the module graph doesn't pull Tauri into a non-Tauri context.
    const w = window as unknown as {
      __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } };
    };
    return w.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? APP_WINDOW_LABEL;
  } catch {
    return APP_WINDOW_LABEL;
  }
}

/**
 * Should THIS window auto-continue agents in `projectId`?
 *
 * The app's existing single-owner election (services/windowOwnership), not a new one: the registry
 * maps label → displayed project, at most one label answers true for a project, and main adopts
 * anything unowned. A torn-off satellite (services/satelliteWindows) owns the project it displays
 * and main clears its own row for it, so the two windows cannot both decide to restart the same
 * agent.
 *
 * The window-local evidence would MOSTLY cover this on its own — `turnEndAuthority` only holds
 * records for agents whose pane this window drives — but "mostly" is not a guarantee to rest a
 * duplicate irreversible PTY write on, and the PTY host is app-global: `pty_write` from any webview
 * reaches any agent.
 */
export function ownsProjectInThisWindow(projectId: string): boolean {
  const label = currentWindowLabel();
  return routeToOwningWindow(projectId, {
    myLabel: label,
    isMain: label === APP_WINDOW_LABEL,
    findWindowForProject: (pid) => findWindowForProject(pid),
  });
}

/**
 * One pass over every agent that HAS a goal.
 *
 * Exported (not just driven by the interval) so a caller can force a pass, and so the tests drive
 * the real thing rather than a re-implementation. Never throws: a failure on one agent must not
 * stop the sweep reaching the others.
 */
export async function sweepGoalContinuations(opts: SweepOptions = {}): Promise<SweepOutcome[]> {
  const now = opts.now ?? Date.now();
  const owns = opts.ownsProject ?? ownsProjectInThisWindow;
  const refreshCloud = opts.refreshCloudStatuses ?? defaultRefreshCloudStatuses;

  const rt = useRuntimeStore.getState();
  const raw = rt.status;
  // Built EXACTLY as conciergeTools/terminal and get_state build it — the in-memory set goes stale
  // between open()/close(), so the persisted one is re-read every time.
  const openIds = new Set(mergeOpenAgentIds(rt.openAgentIds ?? [], readPersistedOpenAgentIds()));
  const stageOf = (id: string) => resolveStage(rt.branchStatus[id], rt.workflowStage[id]);

  const projects = useProjectStore.getState().projects;
  const composite = compositeStatuses(projects, raw, stageOf);

  // Advance the clock over EVERY agent, including ones in projects this window doesn't own and ones
  // with no goal. The clock answers "how long has this been resting", which is a property of the
  // row and not of our interest in it — clocking only the eligible subset would restart the timer
  // the moment a goal is set on an already-idle agent, and delay its rescue by a settle window.
  idleClock = trackIdleSince(idleClock, composite, now);
  // Same garbage collection `trackIdleSince` does by rebuilding: an agent that has been closed can
  // never deliver, so leaving its streak behind would both leak and, if the id were ever reused,
  // start the next agent partway to an escalation.
  for (const id of undelivered.keys()) if (!composite.has(id)) undelivered.delete(id);
  // …and the refusal log's keys, for the SAME two reasons. Left ungathered this grows with every
  // agent id ever seen since app start (not with the live roster), and — the part that matters more
  // than the leak — a row torn down and recreated under the same id would be permanently silent for
  // any reason it had already emitted, which is the exact suppression the key widening exists to
  // remove. The key is `<agentId>:<reason>`, and a reason never contains a colon, so the id is
  // everything before the LAST one.
  for (const key of loggedExpiryRefusal) {
    if (!composite.has(key.slice(0, key.lastIndexOf(":")))) loggedExpiryRefusal.delete(key);
  }
  // …and the remedy ledger. Same PURPOSE as the prune above — without it the bound is every agent
  // id seen since app start, and a row recreated under the same id is permanently silent for a
  // remedy it already emitted — but NOT the same key arithmetic, and that difference bit.
  //
  // This key has THREE segments (`<agentId>:<reason>:<goalFingerprint>`), so `lastIndexOf(":")`
  // yields `<agentId>:<reason>`, which is never in `composite`. Every entry was therefore pruned on
  // every sweep and the line re-logged each tick — the exact flood the ledger exists to prevent,
  // reintroduced by the fix for roborev 79562 and caught by its own two-sweep test. An agent id is
  // a UUID and contains no colon, so the id is everything before the FIRST one.
  for (const key of loggedRemedy) {
    if (!composite.has(key.slice(0, key.indexOf(":")))) loggedRemedy.delete(key);
  }
  // …and the tool-burst ledger, where the SAME argument bites HARDER than for either sibling
  // (roborev 65483). What it holds is a LEVEL, not a counter: a row torn down and recreated under
  // the same id would inherit its predecessor's `lastSeen` — say 41 — so the new agent's own
  // genuine tool activity (5, 9, 14 …) never exceeds it, `bursts` stays flat, the mark never moves,
  // and three sweeps later a WORKING agent is escalated with "no sign of progress". That is
  // verbatim the false page this whole feature exists to end, reintroduced by a stale map entry.
  for (const id of toolActivity.keys()) if (!composite.has(id)) toolActivity.delete(id);
  // …and the external-gate ledger, where the stale-entry failure is the one that matters MOST: an
  // inherited `since` is an inherited AGE, so a brand-new agent could be handed to a human for a
  // gate that had been open for minutes — or, if the grace had not yet elapsed, be parked on
  // somebody else's evidence.
  for (const id of externalWaitSeen.keys()) if (!composite.has(id)) externalWaitSeen.delete(id);
  for (const id of inMotionSeen.keys()) if (!composite.has(id)) inMotionSeen.delete(id);

  const outcomes: SweepOutcome[] = [];
  const pending: Promise<void>[] = [];

  for (const project of projects) {
    if (!owns(project.id)) continue;
    // Only for projects this window OWNS: the ownership election is what stops two windows both
    // acting on one agent, and it should stop them both polling for it too.
    maybeRefreshCloudStatuses(project, now, refreshCloud);
    for (const agent of project.agents) {
      if (agent.goal === undefined) continue;
      if (inFlight.has(agent.id)) {
        outcomes.push({ agentId: agent.id, action: "none", detail: "send-in-flight" });
        continue;
      }
      // The same skip, for an agent the resurrector has just respawned — see suppressContinuation.
      // Named distinctly so a human reading a sweep's outcomes can tell "a write is in progress"
      // from "this one is on probation", but it takes the identical no-cost path: nothing sent,
      // nothing recorded, the idle clock left alone.
      const heldUntil = suppressedUntil.get(agent.id);
      if (heldUntil !== undefined) {
        if (now < heldUntil) {
          outcomes.push({ agentId: agent.id, action: "none", detail: "respawn-probation" });
          continue;
        }
        // Lapsed. Dropped on READ rather than on a timer: a `setTimeout` here would be a second
        // clock to keep in step with the injected `now` every other decision in this sweep uses,
        // and it would fire against a window that may be gone. An agent closed before its hold
        // lapses leaves one stale entry, bounded by the number of agents this window resurrected —
        // the same bound `sessionProjects`' visited set carries, and for the same reason.
        suppressedUntil.delete(agent.id);
      }

      // The mark is computed ONCE, here, and the same value is both decided on and recorded. Two
      // reads would let the store move in between and record a mark that was never compared
      // against — silently resetting the consecutive-retry streak the escalation bound reads.
      // ── THE ARTIFACT HALF OF THE MARK, AND THE GATE ──────────────────────────────────────────
      // FOLD FIRST, THEN READ. `noteToolActivity` is the only writer of the burst ledger and this
      // is its only call site: the sweep advances the counter once per agent per tick, and
      // `continuationEvidenceFor` — which `controlListener.resumeReading` also calls — only reads.
      // See the ledger's own note for why the RAW windowed count could not be used directly.
      noteToolActivity(
        agent.id,
        rt.agentMovement?.[agent.id]?.toolsRecent ?? null,
        burstsOf(agent.goal?.mark),
      );
      // …and the SAME fold-then-read for the external gate, whose age decides whether a quiet agent
      // is parked behind CI or has to be handed to a human. Without this line the ledger is never
      // written, every gate reports `since: null`, and the whole park is dead code that still
      // typechecks — the shape `ContinuationInput.quotaBlock` warns about two dozen lines below.
      noteExternalWait(agent.id, rt.workflowState?.[agent.id], now);
      // …and the SAME fold-then-read for the running-child gate, whose age decides whether a
      // delegating agent is parked or handed to a human once the child looks stuck. Presence is
      // recomputed in `inMotionOf`; this only stamps the first-seen age.
      noteInMotion(
        agent.id,
        isInMotion(agent.id, project.agents, raw) || hasLiveBackgroundTasksForAgent(agent.id),
        now,
      );
      // ONE builder, shared with the prediction surface, so the two cannot drift. Computed ONCE
      // here and passed below rather than re-derived: two reads of the same store can disagree,
      // and the mark that is DECIDED on must be the mark that is RECORDED.
      const { mark, externalWait, inMotion, mergeAuthority } = continuationEvidenceFor(agent);

      // STATED, not inferred — see ContinuationInput.runtime. `AgentTab.runtime` is the store's own
      // record of where the agent runs, and the same field `getTransport` selects a transport by.
      const runtime = agent.runtime === "cloud" ? "cloud" : "local";

      // ══ THE EXPIRY ARM ══════════════════════════════════════════════════════════════════════
      // Expiry used to be a dead letter: `decideContinuation` answered `goal-expired` and NOTHING in
      // the app ever wrote to an expired goal again, so an agent whose clock lapsed — most cheaply
      // during a spend outage, where the quota gate correctly refuses to spend retries while the TTL
      // keeps running — was never resumed by anything, ever.
      //
      // PLACED HERE, and both bounds matter. AFTER the `inFlight` and `suppressedUntil` skips above,
      // because those mean "do not touch this agent at all" and a latch write is touching it. BEFORE
      // `decideContinuation`, because a re-arm changes the answer that call would give — the goal
      // goes back to `unmet` and the ordinary continue path picks it up on the NEXT sweep.
      //
      // IT NEVER SENDS. That is the whole reason the resume is left to the next pass: a bespoke send
      // here would be a second sender, costing nothing from `totalContinues` and bypassing the
      // in-flight guard, the undelivered ceiling and the idle-settle window this file is arranged
      // around. One sender, one budget.
      const expiry = decideExpiry({
        goal: agent.goal,
        now,
        runtime: agent.runtime === "cloud" ? "cloud" : "local",
        hasWorktree: typeof agent.worktreePath === "string" && agent.worktreePath !== "",
        proof: expiryProofFor(agent.id),
      });
      if (expiry.action !== "none") {
        // `now` travels with the decision: the instant that JUDGED the goal expired is the instant
        // the latch is stamped with, so the two clocks cannot drift apart. See the store actions.
        applyExpiry(project.id, agent, expiry, now);
        outcomes.push({ agentId: agent.id, action: "none", detail: `expiry:${expiry.action}` });
        continue;
      }
      // ── THE REFUSAL IS RECORDED, NOT DROPPED ────────────────────────────────────────────────────
      // `decideExpiry` names every refusal precisely so a human can be told WHICH reading was
      // missing — and until now that name was computed and thrown away: `applyExpiry` is skipped for
      // `none`, the sweep falls through, and the outcome said only `goal-expired`. So the module's
      // most careful distinctions ("we could not read its git state" vs "we never asked about its
      // PR") reached nobody, and the silent gap at `sparkle-nmqcb` was uncountable — you could not
      // even ask how many agents were in it, which is the evidence its fix needs.
      if (isStuckRefusal(expiry.reason)) {
        outcomes.push({
          agentId: agent.id,
          action: "none",
          detail: `expiry:none:${expiry.reason}`,
        });
        noteExpiryRefusal(agent, expiry.reason, now);
      }

      const awaitingClose = awaitingCloseEvidenceFor(agent.id, agent.goal);
      const decision = decideContinuation({
        goal: agent.goal,
        status: composite.get(agent.id) ?? "stopped",
        now,
        idleSince: idleClock.get(agent.id),
        // BOTH OF THESE ARE HONEST FOR CLOUD, and neither needed a special case — which is worth
        // saying, because a "cloud has no PTY, so stub these true" reading of the same fields is the
        // way this goes wrong. `Terminal.tsx` drives a cloud pane through the SAME StatusEngine over
        // the SAME transport seam, so the spinner latch that grants turn-end authority is fed by
        // relayed `agent_output` frames, and `cloud_exit` reaches `StatusEngine.exit` exactly as a
        // local `pty:exit` does — which is what makes `processAliveFor` report a terminated sandbox
        // as `process-gone` rather than guessing. A cloud agent this window is NOT streaming has
        // neither witness and is refused, which is correct: the sweep never resumes an agent it
        // cannot observe, whichever runtime it is.
        hasTurnEndAuthority: hasTurnEndAuthority(agent.id),
        canAcceptInput: canAcceptContinuation(agent),
        processAlive: processAliveFor(agent.id, raw, openIds),
        runtime,
        // The extra evidence a sandbox needs and a local PTY does not. Gathered ONLY for cloud, so a
        // local sweep reads no auth store and no relay socket.
        cloud: runtime === "cloud" ? cloudEvidenceFor(agent.id, now) : undefined,
        mark,
        // WHAT THE WORK IS PARKED BEHIND, so the streak bound does not diagnose a CI queue as a
        // stuck agent. See engine/goalContinuation.ExternalWait — absent means no gate was found,
        // which escalates exactly as before, so a window that has not polled this agent keeps
        // today's behaviour rather than silently going quiet.
        ...(externalWait === undefined ? {} : { externalWait }),
        // A CHILD STILL RUNNING under an agent whose own turn closed — see engine/goalContinuation
        // ContinuationInput.inMotion. From the SAME shared builder `resumeReading` uses, so the
        // prediction cannot drift from the decision (roborev 65440's rule, applied to this gate).
        ...(inMotion === undefined ? {} : { inMotion }),
        // The wall the agent itself reported. Without this line the whole backoff is dead code: the
        // gate lives in the pure decision, and the pure decision only knows what this sweep hands it.
        quotaBlock: quotaBlockForAgent(agent.id, now),
        // WHETHER THE WORK ALREADY SHIPPED FOR THIS GOAL — and, exactly as with the wall above, the
        // `goal-awaiting-close` gate is dead code without this line. This is the sweep that kept
        // resuming a finished agent: the measured row (`d5d7056e`, PR #2188) held merged work and a
        // `{kind:"human"}` check it could not close itself, so every pass here spent a continue on
        // an agent with nothing left to do until the streak bound escalated it to the founder.
        ...(awaitingClose === undefined ? {} : { awaitingClose }),
        // WHETHER THE GOAL ASKS FOR A MERGE THIS AGENT MAY NEVER PERFORM. Without this line the
        // `goal-misspecified` gate is dead code that still typechecks — the same shape
        // `ContinuationInput.quotaBlock` warns about. This is the sweep that burned fourteen
        // auto-continues on "Land PR #91 on main" in a merge-protected repo (bead sparkle-hrzitj).
        ...(mergeAuthority === undefined ? {} : { mergeAuthority }),
      });

      if (decision.action === "none") {
        // THE REMEDY TRAVELS WITH THE REASON. A mis-specified goal makes the row go quiet, and a
        // bare reason token would reproduce the silence the classification exists to end — the human
        // has to be told the goal needs rewriting and why. Every other `none` arm carries no remedy
        // and is unchanged.
        const detail =
          decision.remedy === undefined
            ? decision.reason
            : `${decision.reason}: ${decision.remedy}`;
        // AND LOG IT, because the returned array has no production reader: the tick calls
        // `await sweepGoalContinuations();` and discards it (roborev 78716). A remedy that exists
        // only in a value nobody consumes is dead outside the tests that hand-build it. Logged only
        // when there IS a remedy, so the ordinary `none` arms — which fire on every idle sweep for
        // every resting agent — do not turn this into a per-tick log flood.
        if (decision.remedy !== undefined) {
          // KEYED ON THE GOAL, NOT JUST THE REASON (roborev 79562). `decision.reason` is the
          // constant token `goal-misspecified` for this entire class, so keying on it alone made
          // every LATER mis-specified goal on the same agent permanently silent — and the expected
          // follow-up to this very line is a human doing what it says, REWRITE THE GOAL. If the
          // second draft still names a merge in a protected repo ("get PR #91 merged", the likeliest
          // rewrite) the gate fires again, no continue is spent, nothing pages, and the log is
          // suppressed: the row just goes quiet, which is the silence this was built to end.
          //
          // The fingerprint is hex and contains no colon, so the prune's `lastIndexOf(":")` still
          // resolves the agent id. Keying on the raw remedy would break that — it contains `: "`.
          const remedyKey = `${agent.id}:${decision.reason}:${goalFingerprint(agent.goal?.text)}`;
          if (!loggedRemedy.has(remedyKey)) {
            loggedRemedy.add(remedyKey);
            log.info("goals", "goal is mis-specified", {
              agentId: agent.id,
              reason: decision.reason,
              remedy: decision.remedy,
            });
          }
        }
        outcomes.push({ agentId: agent.id, action: "none", detail });
        continue;
      }

      if (decision.action === "escalate") {
        escalateToHuman(project.id, agent, decision.reason, "escalate", now);
        outcomes.push({ agentId: agent.id, action: "escalate", detail: decision.reason });
        continue;
      }

      const outcome: SweepOutcome = {
        agentId: agent.id,
        action: "continue",
        detail: "pending",
        sent: false,
      };
      outcomes.push(outcome);
      inFlight.add(agent.id);
      pending.push(
        continueAgent(project.id, agent, decision.prompt, mark, now, outcome).finally(() => {
          inFlight.delete(agent.id);
        }),
      );
    }
  }

  await Promise.all(pending);
  return outcomes;
}

/**
 * Type the continue prompt into the agent's terminal, then record it.
 *
 * ORDER IS LOAD-BEARING: the retry is recorded only AFTER a delivery we watched succeed. Recording
 * first would spend a retry (and, three times over, escalate to a human) on sends that never
 * reached a terminal — the escalation would then tell the human "restarting cannot fix this" about
 * an agent nobody ever restarted.
 *
 * `userPrompt: false`, and this is not a detail. A user prompt is metered against the trial, written
 * into `promptHistory` and fed to auto-naming — and `promptHistory.length` is one third of the
 * progress mark. A machine send that grew it would make the mark move on EVERY auto-continue,
 * `decideContinuation` would read that as progress, the consecutive-retry streak would reset
 * forever, and `MAX_CONTINUES_WITHOUT_PROGRESS` could never fire. The bound that stops us restarting
 * an agent that cannot make progress would be vacuous — with only the per-goal ceiling left.
 */
async function continueAgent(
  projectId: string,
  agent: AgentTab,
  prompt: string,
  mark: string,
  now: number,
  outcome: SweepOutcome,
): Promise<void> {
  try {
    const result = await dispatchConciergeAnswer(agent.id, prompt, {
      authority: { kind: "goal-continue", agentId: agent.id },
      userPrompt: false,
    });
    outcome.detail = result.path;
    // `ok` IS NOT DELIVERY, and `queued` is the one path where they diverge. A dispatch to a pane
    // whose PTY has not come up yet returns `ok: true, path: "queued"`: the message is HELD in the
    // pending-sends queue, not typed. Crediting that as a delivery cleared the undelivered streak
    // and recorded a goal-continue against a message the agent had not seen — so if the queue
    // later expired or was abandoned, the streak reset on every sweep, the bound could never trip,
    // and this feature's whole purpose (stop retrying an unreachable agent, and TELL someone)
    // silently did not apply to the case where a pane never finishes starting.
    //
    // Counted as undelivered instead. That is the safe direction: if the hold does flush and the
    // next sweep delivers for real, the streak clears then — a slight over-count costs one settle
    // window, while the under-count cost an unbounded loop nobody was told about. Fixed HERE rather
    // than by refusing to queue `goal-continue` in the dispatcher: this is a reading of a result
    // the dispatcher already reports correctly, so it needs no new refusal path threaded through a
    // closed union and every switch over it, and no behaviour change for the other callers that
    // legitimately want the hold.
    const delivered = result.ok && result.path !== "queued";
    outcome.sent = delivered;
    if (delivered) {
      undelivered.delete(agent.id);
      useProjectStore.getState().noteAgentGoalContinue(projectId, agent.id, mark);
      log.info("goals", "auto-continued a stalled agent", { agentId: agent.id, path: result.path });
    } else {
      // `liveMenuLabels` is set on the two SCREEN refusals — `alternate-screen` and
      // `blocked-prompt` — and only when the refusing arm's own screen read found a live menu.
      // Undefined everywhere else, which is exactly what `undeliverableReason` wants for every
      // other arm. (It was `alternate-screen`-only until the permission dialog was reclassified
      // onto `blocked-prompt`; bead sparkle-d6a5r.)
      // ── CLASSIFY THE SCREEN BEFORE DECIDING WHAT TO SAY ABOUT IT (bead sparkle-phb1h) ────────
      // Only for `alternate-screen`: that is the one path whose refusal used to be reported as a
      // claim about a full-screen app, and the only one this verdict changes. Read from the same
      // `TerminalViewport` registry every write guard reads, so the ladder cannot answer from
      // different evidence than the refusal it is describing (see `engine/screenReadability`).
      const screenVerdict =
        result.path === "alternate-screen"
          ? altScreenRefusalVerdict(getAgentViewport(agent.id), result.liveMenuLabels)
          : undefined;
      noteUndelivered(projectId, agent, result.path, now, result.liveMenuLabels, screenVerdict);
    }
  } catch (e) {
    outcome.detail = "threw";
    outcome.sent = false;
    log.warn("goals", "auto-continue threw", { agentId: agent.id, error: String(e) });
    noteUndelivered(projectId, agent, "threw", now);
  } finally {
    // RE-ARM ON BOTH PATHS. On success this is the one-send-per-turn rule. On FAILURE it is a
    // backoff: a refused or dead-PTY send that left the clock alone would be retried on every
    // 15s sweep forever. A failure costs one settle window and no retry from the budget.
    markContinued(agent.id, now);
  }
}

/**
 * Record one auto-continue that never reached the terminal, and escalate once the streak hits
 * {@link MAX_UNDELIVERED_CONTINUES}.
 *
 * A STREAK, not a total: the counter is cleared by any delivery, so a pane that is briefly
 * unreachable and then reachable again never accumulates toward the bound. Only a condition that
 * holds across three consecutive settle windows escalates.
 *
 * The escalation reuses {@link escalateToHuman}, which latches the goal — so `decideContinuation`
 * answers `already-escalated` on the next sweep and this function is never reached again for that
 * goal. Clearing the entry here is therefore belt-and-braces rather than the thing that stops the
 * retrying; it matters if a human un-escalates the goal, which should start the count over rather
 * than re-escalate on the first refusal.
 */
function noteUndelivered(
  projectId: string,
  agent: AgentTab,
  path: UndeliveredPath,
  now: number,
  /** For the SCREEN paths (`alternate-screen`, `blocked-prompt`): the live menu labels the
   *  dispatcher found this sweep, or undefined for the `blind:'no-menu'` case (and every non-screen
   *  path). Passed straight to {@link undeliverableReason} so the escalation names the right remedy
   *  — see beads sparkle-j2gase and sparkle-d6a5r. It is the CURRENT sweep's verdict that escalates,
   *  so this needs no persisting in the streak map: the sweep that trips the bound carries its own
   *  menu state. */
  liveMenuLabels?: string[],
  /** For `alternate-screen`: what {@link altScreenRefusalVerdict} made of the screen. This decides
   *  BOTH whether a human is told and what they are told — see the fail-open block below. */
  screenVerdict?: AltScreenRefusalVerdict,
): void {
  const reason = refusalReasonKey(path, screenVerdict);
  const prior = undelivered.get(agent.id);
  // A DIFFERENT REASON STARTS A NEW STREAK — see the map's own note. Three refusals with three
  // different causes are not a condition that held three times.
  const count = prior !== undefined && prior.reason === reason ? prior.count + 1 : 1;
  undelivered.set(agent.id, { count, reason });
  log.warn("goals", "auto-continue did not reach the terminal", {
    agentId: agent.id,
    path,
    ...(screenVerdict !== undefined ? { screenVerdict } : {}),
    consecutive: count,
  });
  // ══ FAIL OPEN ON A SCREEN THE DETECTOR CANNOT RECOGNISE — bead sparkle-phb1h ═══════════════════
  // The founder's own remedy, and the newest word on that bead: *"when it cannot recognise the
  // screen, do not escalate; report 'unreadable' and let the nudge ladder continue."* It supersedes
  // the bead body, which would have kept the escalation for the zero-evidence case.
  //
  // WHY IT IS SAFE TO GO NO FURTHER HERE, and not a hidden actionable row: a screen the app cannot
  // read is ALREADY a red row reading "Can't read screen" (`engine/screenReadability`), and that row
  // already pages the founder. This ladder escalating on top of it added no information and spent a
  // finite budget — un-latching costs one of `MAX_CONCIERGE_REARMS`, which refills only when a human
  // types. Measured three times: an ordinary Claude Code pane, no dialog on it, latched anyway; one
  // of the three seconds after it MERGED ITS PR, another left with its last re-arm gone.
  //
  // The streak is still counted and still logged, so the condition is visible to anyone reading the
  // log — what is withheld is only the claim that a human is needed.
  if (path === "alternate-screen" && screenVerdict !== "claude-dialog") return;
  if (count < MAX_UNDELIVERED_CONTINUES) return;
  undelivered.delete(agent.id);
  escalateToHuman(
    projectId,
    agent,
    undeliverableReason(
      agent.goal?.text ?? "",
      path,
      agent.runtime === "cloud",
      liveMenuLabels,
      screenVerdict,
    ),
    "escalate",
    now,
  );
}

/**
 * Auto-continue has given up — latch it on the goal AND make sure a human hears about it.
 *
 * Both halves are required and they are different jobs. `escalateAgentGoal` is what stops the
 * retrying (`goalStateOf` → `escalated`, which `decideContinuation` refuses) and what makes
 * `engine/agentStall` report the row as stalled-because-auto-continue-gave-up. But a latched field
 * nobody is looking at is the silent-forever state this feature exists to abolish, so the
 * escalation also fires the app's ordinary "this agent needs you" banner — the same
 * `notify_attention` path a waiting agent uses, which routes a click back to the agent.
 *
 * FIRES ONCE by construction rather than by a flag here: `escalateGoal` is latched, so the next
 * sweep reads `already-escalated` and never reaches this function again.
 *
 * ⚠️ BOTH `via` AND `now` ARE REQUIRED, and neither was at first — `via` defaulted to "escalate" and
 * `now` to `Date.now()`. The second default was the interesting mistake: it was introduced by a
 * commit whose whole point was deleting the same default one frame DOWN, in the store actions, and
 * whose comment claimed "required is the whole guarantee". It was not. The abandon path — the one
 * call site that actually reads `now` — still compiled without an instant, so a future
 * `escalateToHuman(projectId, agent, reason, "abandon")` would stamp `abandonedAt` from the wall
 * clock while the sweep judged at an injected one: exactly the split clock the change existed to
 * make unrepresentable, moved up a stack frame rather than removed. A default that serves the
 * callers which never read the value, while disarming the one that does, is worse than no parameter.
 *
 * And the escalate branch USED to discard `now` entirely — `escalateAgentGoal` took no instant and
 * stamped `Date.now()` — so the required parameter here was dead on the more common of the two
 * paths while two comments claimed the seam was closed. It is threaded all the way to the
 * transition now.
 *
 * `via` SELECTS THE LATCH, NOT A SECOND PATH. An abandoned goal is an escalation — `abandonGoal`
 * writes THROUGH `escalateGoal` — so both variants inherit the retry suppression, the once-only
 * property above, and the amber floor. What `"abandon"` adds is `abandonedAt`, the annotation
 * `engine/agentStall` keys the red `abandoned-goal` cause on. It is a parameter rather than its own
 * function so there stays exactly ONE `notifyAttention` call site for a goal giving out; the first
 * version of the expiry arm called `escalateToHuman` directly and therefore never wrote
 * `abandonedAt` at all, leaving `abandonAgentGoal` with zero callers and the red cause unreachable.
 */
function escalateToHuman(
  projectId: string,
  agent: AgentTab,
  reason: string,
  via: "escalate" | "abandon",
  now: number,
): void {
  const store = useProjectStore.getState();
  if (via === "abandon") store.abandonAgentGoal(projectId, agent.id, reason, now);
  else store.escalateAgentGoal(projectId, agent.id, reason, now);
  notifyAttention({
    projectId,
    agentId: agent.id,
    title: `${agent.name} needs you`,
    body: reason,
  });
  log.warn(
    "goals",
    via === "abandon" ? "goal abandoned — escalated to the human" : "auto-continue escalated to the human",
    { agentId: agent.id, reason },
  );
}

// ── The mount ───────────────────────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

/**
 * Start the sweep. Returns a teardown. Idempotent: a second call replaces the first interval rather
 * than running two.
 *
 * Mounted once, app-level, from App.tsx — the same shape as `useLimitSync` and `startStaleBuildWatch`
 * and for the same reason: a goal belongs to an AGENT, and one sweep serves the whole fleet, so a
 * per-pane timer would multiply the work to reach an identical conclusion (and, unlike the limit
 * poll, would multiply the SENDS).
 */
export function startGoalContinuationRunner(
  intervalMs: number = GOAL_SWEEP_INTERVAL_MS,
): () => void {
  stopGoalContinuationRunner();
  const tick = async () => {
    // A sweep awaits its sends, so a slow PTY write can outlast the interval. Overlapping ticks
    // would each read the pre-send idle clock.
    if (sweeping) return;
    sweeping = true;
    try {
      await sweepGoalContinuations();
    } catch (e) {
      log.warn("goals", "goal sweep failed", { error: String(e) });
    } finally {
      sweeping = false;
    }
  };
  // NO immediate tick. The first pass would run against an empty idle clock, so nothing could be
  // eligible anyway — but more importantly the clock is what makes "continuously resting" mean
  // anything, and a window that has been up for zero seconds has observed no continuity at all.
  timer = setInterval(() => void tick(), intervalMs);
  return stopGoalContinuationRunner;
}

/** Stop the sweep (idempotent). Leaves the idle clock alone — a remount should not hand every
 *  resting agent a fresh settle window it has already served. */
export function stopGoalContinuationRunner(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

/** Test/introspection helper: is the sweep armed? */
export function isGoalContinuationRunnerRunning(): boolean {
  return timer !== null;
}

/**
 * Write ONE expiry outcome to the store.
 *
 * The rules live in `engine/goalExpiry.decideExpiry` and are not re-checked here — a second copy of
 * a gate is how the two copies come to disagree in exactly the case that closes an unfinished agent
 * or reddens a finished one.
 *
 * ONLY `abandon` NOTIFIES. A re-arm is Sparkle quietly doing its job and must not page anyone; a
 * discharge is good news about work that already landed. Abandonment routes through the SAME
 * `escalateToHuman` path an ordinary escalation uses — `abandonGoal` writes through `escalateGoal`,
 * so the row inherits the `already-escalated` circuit breaker and the once-only notification latch
 * rather than getting a parallel set of its own.
 *
 * ⚠️ IT MUST PASS `"abandon"`, and the plain call was a real defect rather than a nicety: without it
 * the escalation is written by `escalateAgentGoal`, `abandonedAt` is never set, and the red
 * `abandoned-goal` cause (`engine/agentStall`, which keys on exactly that field) can never fire — so
 * the loudest outcome this module can reach rendered identically to an ordinary give-up.
 */
function applyExpiry(
  projectId: string,
  agent: AgentTab,
  decision: ExpiryDecision,
  now: number,
): void {
  const store = useProjectStore.getState();
  switch (decision.action) {
    case "rearm":
      store.rearmAgentGoal(projectId, agent.id, REARM_TTL_MS, now);
      return;
    case "discharge":
      store.dischargeAgentGoal(projectId, agent.id, decision.sha, decision.baseSha, now);
      return;
    case "abandon":
      escalateToHuman(projectId, agent, decision.evidence, "abandon", now);
      return;

    case "none":
      return;
  }
}
