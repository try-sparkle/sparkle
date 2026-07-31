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
import { decideContinuation, progressMark } from "../engine/goalContinuation";
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
import { livenessOf } from "./agentLiveness";
import { notifyAttention } from "./attention";
import { agentCanAcceptInput, dispatchConciergeAnswer } from "./conciergeDispatch";
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

/** Test seam: forget the idle clock and any in-flight sends. */
export function _resetGoalContinuationRunnerForTests(): void {
  idleClock = new Map();
  inFlight.clear();
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

  const outcomes: SweepOutcome[] = [];
  const pending: Promise<void>[] = [];

  for (const project of projects) {
    if (!owns(project.id)) continue;
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

      const decision = decideContinuation({
        goal: agent.goal,
        status: composite.get(agent.id) ?? "stopped",
        now,
        idleSince: idleClock.get(agent.id),
        hasTurnEndAuthority: hasTurnEndAuthority(agent.id),
        canAcceptInput: agentCanAcceptInput(agent.id),
        processAlive: processAliveFor(agent.id, raw, openIds),
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
    outcome.sent = result.ok;
    if (result.ok) {
      useProjectStore.getState().noteAgentGoalContinue(projectId, agent.id, mark);
      log.info("goals", "auto-continued a stalled agent", { agentId: agent.id, path: result.path });
    } else {
      log.warn("goals", "auto-continue did not reach the terminal", {
        agentId: agent.id,
        path: result.path,
      });
    }
  } catch (e) {
    outcome.detail = "threw";
    outcome.sent = false;
    log.warn("goals", "auto-continue threw", { agentId: agent.id, error: String(e) });
  } finally {
    // RE-ARM ON BOTH PATHS. On success this is the one-send-per-turn rule. On FAILURE it is a
    // backoff: a refused or dead-PTY send that left the clock alone would be retried on every
    // 15s sweep forever. A failure costs one settle window and no retry from the budget.
    markContinued(agent.id, now);
  }
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
