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
  decideContinuation,
  progressMark,
} from "../engine/goalContinuation";
import { hasUnmetGoal } from "../engine/agentGoal";
import { quotaBlockForAgent } from "../engine/engineRegistry";
import { hasTurnEndAuthority } from "../engine/turnEndAuthority";
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
/** agentId → how many auto-continues IN A ROW never reached the terminal, and the path the last one
 *  refused on. See {@link MAX_UNDELIVERED_CONTINUES}. Cleared by a delivery and by an escalation. */
const undelivered = new Map<string, { count: number; path: string }>();

/** Test seam: forget the idle clock, any in-flight sends, and the undelivered streaks. */
export function _resetGoalContinuationRunnerForTests(): void {
  idleClock = new Map();
  inFlight.clear();
  undelivered.clear();
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

/** Test/introspection seam: how many auto-continues in a row have failed to reach `agentId`? */
export function undeliveredStreakFor(agentId: string): number {
  return undelivered.get(agentId)?.count ?? 0;
}

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
function undeliverableReason(goalText: string, path: UndeliveredPath, isCloud: boolean): string {
  // THE SCREEN ARMS ARE RUNTIME-AWARE TOO, not just the closing sentence. Both of these fire for a
  // cloud agent — the guards that produce them run BEFORE the cloud branch and read the RELAYED
  // viewport — so keying only the closing on the runtime produced a message that contradicted
  // itself in adjacent sentences: "its TERMINAL is waiting at a prompt … Nothing reached the
  // SANDBOX." Same defect as the closing, one clause earlier (roborev 58551).
  const screen = isCloud ? "its sandbox screen" : "its terminal";
  const pane = isCloud ? "its pane" : "the pane";
  const why =
    path === "alternate-screen"
      ? `${screen} is sitting in a full-screen app (vim/less/htop), which would read the message as commands. Quit that app in ${pane} and the auto-resume will take over again`
      : path === "blocked-prompt"
        ? `${screen} is waiting at a prompt that must not receive free text — a password, a host-key confirmation, a yes/no. Answer that prompt in ${pane}`
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
 *  browser preview). Never throws — an unanswerable question must not take the sweep down. */
function currentWindowLabel(): string {
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

      // The mark is computed ONCE, here, and the same value is both decided on and recorded. Two
      // reads would let the store move in between and record a mark that was never compared
      // against — silently resetting the consecutive-retry streak the escalation bound reads.
      const mark = progressMark({
        promptHistoryLength: agent.promptHistory.length,
        activity: agent.activity,
        aiTitle: agent.aiTitle,
      });

      // STATED, not inferred — see ContinuationInput.runtime. `AgentTab.runtime` is the store's own
      // record of where the agent runs, and the same field `getTransport` selects a transport by.
      const runtime = agent.runtime === "cloud" ? "cloud" : "local";

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
        // The wall the agent itself reported. Without this line the whole backoff is dead code: the
        // gate lives in the pure decision, and the pure decision only knows what this sweep hands it.
        quotaBlock: quotaBlockForAgent(agent.id, now),
      });

      if (decision.action === "none") {
        outcomes.push({ agentId: agent.id, action: "none", detail: decision.reason });
        continue;
      }

      if (decision.action === "escalate") {
        escalateToHuman(project.id, agent, decision.reason);
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
      noteUndelivered(projectId, agent, result.path);
    }
  } catch (e) {
    outcome.detail = "threw";
    outcome.sent = false;
    log.warn("goals", "auto-continue threw", { agentId: agent.id, error: String(e) });
    noteUndelivered(projectId, agent, "threw");
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
function noteUndelivered(projectId: string, agent: AgentTab, path: UndeliveredPath): void {
  const count = (undelivered.get(agent.id)?.count ?? 0) + 1;
  undelivered.set(agent.id, { count, path });
  log.warn("goals", "auto-continue did not reach the terminal", {
    agentId: agent.id,
    path,
    consecutive: count,
  });
  if (count < MAX_UNDELIVERED_CONTINUES) return;
  undelivered.delete(agent.id);
  escalateToHuman(
    projectId,
    agent,
    undeliverableReason(agent.goal?.text ?? "", path, agent.runtime === "cloud"),
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
 */
function escalateToHuman(projectId: string, agent: AgentTab, reason: string): void {
  useProjectStore.getState().escalateAgentGoal(projectId, agent.id, reason);
  notifyAttention({
    projectId,
    agentId: agent.id,
    title: `${agent.name} needs you`,
    body: reason,
  });
  log.warn("goals", "auto-continue escalated to the human", { agentId: agent.id, reason });
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
