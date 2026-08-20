// A build agent's OPENING BRIEF — held from spawn until the launch that carries it, and reported
// back once that launch has actually happened.
//
// ══ WHY THIS EXISTS: THE BRIEF THAT NEVER SUBMITTED ═══════════════════════════════════════════
//
// The brief used to ride `services/pendingSends`: queued at spawn, then written into the agent's PTY
// by `flushPendingSends` the moment the pane reported ready — one bracketed paste, then a carriage
// return 60ms later (`pty.ts` submitPrompt). The text always arrived. The SUBMIT never did. The
// human hit it on five of five concierge spawns in one evening; two agents sat idle 20+ minutes, and
// one woke with no objective at all, ran eight forensic checks, and correctly reported it had no
// goal. Meanwhile `spawn_build_agent` replied `briefed: true`, so nothing downstream knew.
//
// It was NOT bracketed paste eating the newline. `submitPrompt` already sends the `\r` as its own
// write, outside the ESC[200~ … ESC[201~ block. It was READINESS. `Terminal.tsx` fires `onReady` the
// instant `pty_spawn` resolves, and `pty_spawn` returns right after `spawn_command` — i.e. "the child
// process was forked", NOT "claude's TUI has attached its stdin handler". Claude Code needs seconds
// to boot (this repo's SessionStart hooks run `bd prime` and several check scripts first), so the
// paste and the CR landed in the tty buffer before anything was reading it in raw mode.
//
// Measured against a real `claude` in a real pty, verdict decided by whether the agent actually
// carried out a file-writing instruction (no output parsing, so no false positives):
//
//   | delivery                                             | submitted? |
//   |------------------------------------------------------|-----------|
//   | paste + CR at +0.11s  (what the app did)              | NO        |
//   | paste + CR at +0.11s, ICRNL cleared on the pty        | NO        |
//   | paste + CR at +9.8s   (after output idled 2.5s)       | NO        |
//   | paste + CR at +35s    (TUI fully up)                  | YES       |
//   | prompt in claude's ARGV at launch                     | YES       |
//   | `claude --print` (harness control)                    | YES       |
//
// Two things fall out of that table, and both shape this module:
//
//   1. "Output went quiet" is NOT a readiness signal — the +9.8s arm had been idle 2.5s and still
//      lost the submit. Any timer-or-idle heuristic is guessing, and a fixed sleep long enough to be
//      safe on a loaded machine is pure waste on an idle one.
//   2. The positional prompt CANNOT lose the submit, because claude submits it itself at startup
//      (`claudeSpawn.buildClaudeExec`: "The positional prompt auto-submits on launch"). It is
//      already how WORKER agents get their mission, which is why workers never had this bug.
//
// So the brief is delivered as ARGV, and the race is deleted rather than timed. This module holds
// the text between "the agent row was created" and "the pane assembled its launch", and records the
// one observation that makes `briefed` truthful: the launch carrying that argv actually ran.
//
// Deliberately module-level and NOT persisted, matching `pendingSends`: this is a hand-off across a
// mount, not a durable outbox. A relaunch of an agent whose brief never went out still finds it here
// (the brief is only released once delivery is settled), and an app restart legitimately starts empty.

import { log } from "../logger";

/** How a brief's delivery ended. */
export type BriefDeliveryOutcome =
  /** claude was exec'd with the brief in its argv, so claude itself submits it at startup. This is
   *  the only value that may be reported as `briefed: true`. */
  | { state: "submitted" }
  /** The pane gave up before any launch happened (spawn error, or no claude on PATH). The agent ROW
   *  SURVIVES and the brief is STILL ATTACHED, so the pane's "Start again" re-emits it. */
  | { state: "launch-failed"; reason: string }
  /**
   * The agent was closed or discarded before its brief went out. Distinct from `launch-failed`, and
   * deliberately NOT folded into it: the two leave the world in opposite states, and the caller's
   * user-facing copy is different in every clause.
   *
   * Both once returned `launch-failed`, which made a close-during-wait answer with the retry copy —
   * "its brief is still attached, so Start again will send it" — naming a control on a row that had
   * just been deleted, about a brief that had just been dropped. That is precisely the remedy-copy
   * trap the rest of this module exists to close, so the state is split rather than the copy patched.
   */
  | { state: "agent-closed"; reason: string }
  /**
   * The caller's patience ran out while a launch WAS ALREADY CARRYING this brief in its argv —
   * `briefForLaunch` had handed the text to a pane's spawn, but that spawn had not yet reported
   * `ptyReady`. Distinct from `unconfirmed`, and the distinction is the whole point.
   *
   * This is not a silence. The brief is committed to a specific launch's command line, and only two
   * futures remain: the exec returns (`submitted`) or the pane gives up (`launch-failed`, reported
   * promptly and loudly by `noteBriefFailed`). Neither of them is "the agent sits there briefless",
   * which is the state `unconfirmed` cannot rule out and this one can.
   *
   * WHY IT EXISTS AT ALL — a bound cannot be made big enough to delete the tail. Measured over 108
   * spawns in one day, the time from the pane starting its launch to `pty_spawn` returning had a p50
   * of 7.5s, a p90 of 24.5s and a max of 39.8s; it tracks worktree-prep cost, so a busy machine or a
   * large repo moves the whole distribution right. Any fixed patience is therefore a race, and the
   * honest fix is to say WHICH race you lost rather than picking a bigger number and calling it
   * certainty.
   *
   * The remedy that fits it is WAIT, not re-send. That matters concretely: three consecutive
   * concierge spawns reported the old bare `unconfirmed`, whose copy said "check that it picked up
   * the task", and the recovery was a hand re-send of the brief — into agents that had already
   * received it as argv, i.e. a duplicate brief. One of those re-sends was refused outright by the
   * full-screen-app write guard.
   */
  | { state: "launching" }
  /** No launch has read this brief AND nothing failed within the caller's patience — nothing has
   *  taken delivery of it at all. The genuinely unknown case (no pane mounted, most likely), and the
   *  only one that leaves "briefless agent" on the table. Never upgraded into a success. */
  | { state: "unconfirmed" };

/**
 * What the ATTACHING caller already did to the store for this brief, so the delivery path does not
 * do it a second time.
 *
 * ══ WHY THIS EXISTS: ONE MISSION, TWO WRITERS ═════════════════════════════════════════════════
 *
 * `AgentPane` runs `recordPromptSideEffects` after an argv brief launches, because a brief that
 * bypasses `submitPrompt` would otherwise leave the pinned header, prompt history and auto-naming
 * blind to it. That is exactly right for `buildAgentSpawn`, which attaches and writes NOTHING else.
 *
 * It is wrong for `sendToBuild.seedDraft`, which `appendPrompt`s the seed itself (that write is what
 * puts the mission in the pinned header on the RESUME branch, where no argv launch ever happens).
 * Once `seedDraft` also started attaching, the fresh branch got BOTH writes: two identical
 * `promptHistory` rows for one mission — only one carrying a terminal marker, so the other's "jump
 * to this prompt" is dead — a double-counted naming ladder, a free-trial prompt debited for every
 * board Start, and a generated epic brief taught to the ghost-text corpus that documents it must
 * hold only what a person actually TYPED.
 *
 * So the brief carries what was already recorded, and the delivery path completes only what is
 * still owed.
 */
export interface BriefRecord {
  /** The `promptHistory` id `appendPrompt` returned, so delivery can mark the terminal against the
   *  EXISTING entry instead of appending a duplicate to mark. */
  promptId?: string;
  /**
   * Did a PERSON compose this text? Carried rather than defaulted because the delivery path cannot
   * see the authority the handoff was made under, and the flag governs
   * `projectStore.releaseGoalDebt`.
   *
   * `AgentPane` used to default it to `true` and said why: the brief fires on an agent whose PTY has
   * only just come up, so there is no goal and no debt for either answer to release. That reasoning
   * ended with an explicit warning — "it stops being true the moment spawn seeds an agent that
   * INHERITS a goal or a debt — a reused id, a restored session. If that ever lands, thread the real
   * `isHumanAuthored(authority)` down from the spawn caller rather than reading this comment as a
   * licence." `seedDraft` attaching briefs landed exactly that: `epicSweepRunner` and
   * `conciergeTools/plans` pass `humanAuthored: false` precisely so a machine handoff onto a REUSED
   * orchestrator cannot un-latch an escalation nothing spent, and a reused row whose session is gone
   * spawns FRESH — so the argv path ran on an agent that did carry `goalDebt`/`escalatedAt`. This is
   * the threading that comment asked for.
   */
  humanAuthored: boolean;
}

interface Held {
  text: string;
  /** See {@link BriefRecord}. Absent when the attaching caller wrote nothing to the store. */
  recorded?: BriefRecord;
  /**
   * A launch has READ this brief into its argv (`briefForLaunch` returned the text) but has not yet
   * reported an outcome. The difference between "we are waiting on a launch we can name" and "we are
   * waiting on nothing" — see the `launching` outcome for why that distinction is load-bearing.
   *
   * Cleared by `noteBriefFailed`, because that launch is over: the brief is retained for the pane's
   * Retry, and until that Retry reads it again there is once more no launch carrying it. Leaving it
   * set would report `launching` for a pane that had already given up.
   */
  inFlight: boolean;
  waiters: Array<(o: BriefDeliveryOutcome) => void>;
}

const held = new Map<string, Held>();

/** Hold `text` as `agentId`'s opening brief, to be emitted as claude's positional prompt by the
 *  pane's next FRESH launch. Replaces any brief not yet delivered (a re-spawn supersedes it).
 *
 *  Pass `recorded` when you have ALREADY written this prompt to the store — see {@link BriefRecord}
 *  for the duplicate-record and goal-debt bugs that omitting it produced. */
export function attachBrief(agentId: string, text: string, recorded?: BriefRecord): void {
  held.set(agentId, { text, recorded, inFlight: false, waiters: [] });
}

/**
 * What the attaching caller already recorded for this agent's held brief, or undefined when nothing
 * is held or nothing was recorded.
 *
 * READ IT BEFORE `noteBriefLaunched`, which consumes the entry. Kept as a separate accessor rather
 * than folded into that function's return so the many existing callers and tests asserting
 * `noteBriefLaunched(...) === text` keep working unchanged.
 */
export function briefRecord(agentId: string): BriefRecord | undefined {
  return held.get(agentId)?.recorded;
}

/**
 * The brief to emit as claude's positional prompt for this launch, or undefined when there is none.
 *
 * Returns undefined when `resume` is true, for the same reason `buildClaudeExec` drops the
 * positional prompt on resume: the resumed conversation already contains the mission, and
 * re-emitting it would re-run the whole brief on every reopen. NON-destructive — the brief stays
 * held until delivery is settled, so a launch that errors before exec can be retried with it.
 */
export function briefForLaunch(agentId: string, resume: boolean): string | undefined {
  if (resume) return undefined;
  const h = held.get(agentId);
  if (!h) return undefined;
  // THE MOMENT THE BRIEF STOPS BEING A SILENCE. Returning the text here IS the commitment: the caller
  // puts it in the launch's argv, so from now on a wait that runs out of patience can say `launching`
  // (a named launch is carrying it) instead of `unconfirmed` (nothing has taken it). Marked here
  // rather than at `setSpawn` because this is the only read — and a superseded run does not falsify
  // it: the brief is retained until delivery settles, so the pane's next attempt reads it again and a
  // launch really is still in progress. Only `noteBriefFailed` — a pane that gave up — clears it.
  h.inFlight = true;
  return h.text;
}

/** Is a brief still waiting to go out for this agent? (For UI copy and tests.) */
export function hasUndeliveredBrief(agentId: string): boolean {
  return held.has(agentId);
}

/**
 * Answer this agent's waiters, and decide whether the brief itself is CONSUMED.
 *
 * `drop` is the subtle half (roborev finding on the first cut of this file). Deleting the entry on
 * every outcome looked tidy and broke Retry: a `launch-failed` destroyed the text, so the pane's
 * Retry called `briefForLaunch`, got undefined, and launched claude with NO positional prompt — an
 * agent silently up with no objective. Worse, `briefFailure` told the human to restart, which is
 * exactly the action that produced the briefless agent (the remedy-copy trap AGENTS.md names).
 *
 * So: a real launch consumes the brief; a FAILED launch keeps it deliverable for the next attempt;
 * and only the agent going away (`clearBrief`) discards it.
 */
function settle(agentId: string, outcome: BriefDeliveryOutcome, drop: boolean): void {
  const h = held.get(agentId);
  if (!h) return;
  if (drop) held.delete(agentId);
  const waiters = h.waiters.splice(0);
  for (const w of waiters) {
    try {
      w(outcome);
    } catch (e) {
      // A waiter's failure must never break the outcome for the others.
      log.warn("agent-brief", "brief delivery waiter threw", e);
    }
  }
}

/**
 * THE OBSERVATION. Called by the pane once the PTY for a launch carrying this brief in its argv has
 * actually been spawned — i.e. claude was exec'd with the prompt, and submits it itself.
 *
 * This is the moment that makes `briefed: true` mean SUBMITTED rather than "we wrote some bytes at
 * it". It is deliberately NOT "we assembled a command" (which proves nothing ran) and deliberately
 * NOT "the composer looks empty" (which the app cannot read out of a TUI's framebuffer without
 * guessing). It is "the process that owns the submit was started, with the submit in its arguments".
 *
 * No-op when nothing is held for `agentId` — the ordinary case for an unbriefed agent and for every
 * relaunch after the first.
 */
export function noteBriefLaunched(agentId: string): string | undefined {
  const h = held.get(agentId);
  if (!h) return undefined;
  log.debug("agent-brief", "brief delivered as launch argv", { agentId });
  // Consumed: a real launch carried it, so no relaunch may submit it a second time.
  settle(agentId, { state: "submitted" }, true);
  // Handed back so the caller can record the prompt side-effects for it (pinned header, prompt
  // history, auto-naming). Those normally ride `submitPrompt`, which an argv-delivered brief never
  // touches.
  return h.text;
}

/**
 * The launch that had read this brief is OVER without having reached the PTY — the pane unmounted
 * (tab closed, project switched, run superseded) between `briefForLaunch` and `pty_spawn`.
 *
 * WITHOUT THIS, `inFlight` HAD NO WAY BACK DOWN except `noteBriefFailed`, which the pane calls only
 * for `phase === "error" | "no-claude"`. Every other abandonment left the flag stuck true, so a wait
 * that timed out afterwards answered `launching` — "give it a moment rather than re-sending" — about
 * a launch that was not happening. That is the very wrong-remedy shape this module exists to close,
 * relocated into the flag added to close it: before `inFlight` existed the same path reported
 * `unconfirmed` and correctly said to go check. The window is the 7–40s a real launch takes, so it
 * is not a corner.
 *
 * DELIBERATELY NOT A SETTLE. No outcome is reported and no waiter is answered: nothing has failed —
 * the brief is still held and still deliverable, and a caller mid-wait should keep waiting in case
 * the pane remounts. This only retracts the "a launch is carrying it" claim, so a LATER timeout tells
 * the truth. No-op once the brief has actually launched.
 */
export function noteBriefLaunchAbandoned(agentId: string): void {
  const h = held.get(agentId);
  if (!h || !h.inFlight) return;
  log.debug("agent-brief", "launch abandoned before the brief reached the pty", { agentId });
  h.inFlight = false;
}

/**
 * The pane will never launch this brief: its spawn errored, or there is no claude to run. Reported
 * rather than dropped — a brief that was promised and then silently vanished is exactly the failure
 * this module exists to end (and it is the same reason `abandonPendingSends` exists).
 */
export function noteBriefFailed(agentId: string, reason: string): void {
  const h = held.get(agentId);
  if (!h) return;
  log.warn("agent-brief", "brief was never launched", { agentId, reason });
  // That launch is OVER, so nothing is carrying the brief any more. Cleared before the settle so a
  // wait that times out after this reports `unconfirmed` (nothing has taken delivery) rather than
  // `launching` (a live launch has it in its argv) — the latter would tell the human to sit and wait
  // for a pane that has already given up, which is the remedy-copy trap this module exists to close.
  h.inFlight = false;
  // RETAINED, not dropped: the pane offers Retry, and a Retry must carry the brief. Dropping it here
  // is what made a restart produce a silently briefless agent while the failure copy recommended
  // restarting. Only `clearBrief` (the agent is gone) discards an unlaunched brief.
  settle(agentId, { state: "launch-failed", reason }, false);
}

/**
 * Default patience for {@link awaitBriefDelivery}. A BOUND on how long we will wait before saying
 * "unconfirmed" — NOT a delay used to make delivery work. Delivery resolves on the launch event;
 * this only decides when silence stops being worth waiting on.
 *
 * ══ IT MUST STAY UNDER THE MCP BRIDGE'S OWN TIMEOUT ═══════════════════════════════════════════
 *
 * `spawn_build_agent` is reachable from the sparkle-control MCP server, whose
 * `bridge.request("concierge_tool", …)` bounds the round trip. This was once 45s against that
 * transport's 30s DEFAULT, which inverted the whole point of the change: any briefed spawn slower
 * than 30s killed the socket first, so the caller got a thrown `bridge request timeout` for a spawn
 * that HAD created the agent and consumed a capacity slot — and the natural response to a timeout is
 * a retry, which duplicates the agent. The honest `unconfirmed` / `launch-failed` payloads this whole
 * change exists to deliver could never reach an MCP caller at all. Before the wait was introduced the
 * op answered in milliseconds, so the 30s bound was never in play.
 *
 * The answer to that was to cut this to 20s — and THAT number was measured against nothing. It sits
 * under the real launch latency, so it manufactured false alarms out of ordinary slow spawns (see
 * below). The transport bound is a knob, not a law of nature: `conciergeToolCall` now passes an
 * explicit `CONCIERGE_TOOL_TIMEOUT_MS`, so the ceiling is raised for the one op that needs it instead
 * of the wait being squeezed under a default meant for cheap synchronous reads.
 * `agentBrief.bridgeBound.test.ts` reads the bridge call's ACTUAL bound and fails if the two cross.
 *
 * ══ WHY 45s, AND WHERE THE NUMBER COMES FROM ══════════════════════════════════════════════════
 *
 * Waiting for `ptyReady` (which is `pty_spawn` returning, not a booted TUI) covers worktree prep, the
 * Claude check and the bridge start — and on a machine running a fleet those are not fast. Measured
 * over 108 spawns in one day: p50 7.5s, p75 14.8s, p90 24.5s, p95 26.3s, max 39.8s. **13.9% exceeded
 * the old 20s bound.** That is not a corner case; it is one spawn in seven raising a false alarm
 * about a brief that had been delivered, on an agent that was working.
 *
 * It is what happened on three consecutive concierge spawns: 18.5s, 18.7s and 39.8s from the pane
 * starting its launch to `pty_spawn` — and the wait starts BEFORE that, at the spawn call, so even
 * the sub-20s pair ran out of patience. All three agents launched, took the brief from their argv and
 * worked normally. Because the reply said the brief could not be confirmed, it was re-sent by hand:
 * a duplicate brief into an already-briefed agent, one of which the full-screen write guard refused.
 *
 * 45s clears the observed maximum (39.8s) — and it is a CEILING, not just a floor. It cannot simply
 * be raised to buy more comfort: the concierge's liveness clock treats a tool call as silence, so the
 * worst-case quiet is the TRANSPORT bound plus the MCP return plus the model's first delta, against a
 * 60s sticky-RED latch. Widening the wait widens the transport above it and eats that margin, which
 * is how a fix for a false alarm becomes a different false alarm one layer up. The three constants
 * are solved together in `agentBrief.bridgeBound.test.ts`; the real release valve is to stop counting
 * tool-wait as silence at all (bead `sparkle-t85dj`).
 *
 * It is NOT a claim that no spawn can be slower — the distribution moves with machine load and repo
 * size (tkmx-client's median was 17.7s against sparkle-desktop's 7.6s on the same day). The tail is
 * handled by being HONEST about it (`launching`), not by pretending a bigger number is certainty.
 */
export const BRIEF_DELIVERY_TIMEOUT_MS = 45_000;

/**
 * Resolve when this agent's brief is either launched or known to have failed — WITHOUT polling and
 * without a fixed sleep. Resolves immediately when nothing is held (nothing to wait for: treated as
 * already submitted, since the only way a brief leaves this module is by being delivered or failed).
 *
 * `timeoutMs` is a give-up bound, and its outcome is "unconfirmed", never "submitted": a caller that
 * timed out learned nothing about the brief and must not claim it landed.
 */
export function awaitBriefDelivery(
  agentId: string,
  opts: {
    timeoutMs?: number;
    /** Injectable for tests, so the bound needs no real clock. */
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (h: unknown) => void;
  } = {},
): Promise<BriefDeliveryOutcome> {
  const h = held.get(agentId);
  if (!h) return Promise.resolve({ state: "submitted" });
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  return new Promise<BriefDeliveryOutcome>((resolve) => {
    let done = false;
    const waiter = (o: BriefDeliveryOutcome) => {
      if (done) return;
      done = true;
      clearTimer(timer);
      resolve(o);
    };
    const timer = setTimer(() => {
      if (done) return;
      done = true;
      // Drop OUR waiter but keep the brief: giving up on the answer is not the same as the brief
      // being undeliverable, and a launch that arrives late must still carry it. Removing the
      // closure is what stops a timed-out wait from pinning it for the life of the process.
      const h2 = held.get(agentId);
      if (h2) h2.waiters = h2.waiters.filter((w) => w !== waiter);
      // WHICH silence was it? A launch already carrying the brief in its argv is not the same fact as
      // nothing having taken it, and reporting both as `unconfirmed` is what sent a human to re-send
      // a brief that had already gone (see the `launching` outcome). Read from the CURRENT entry, not
      // the one captured at call time: `inFlight` is set by a `briefForLaunch` that may well have run
      // during this very wait, which is the ordinary case for a slow spawn.
      const state = h2?.inFlight ? ("launching" as const) : ("unconfirmed" as const);
      // Never silent, whichever it was: the timeout is the one outcome nobody observes from the UI.
      log.warn("agent-brief", "brief delivery not confirmed within the wait", {
        agentId,
        state,
        waitedMs: opts.timeoutMs ?? BRIEF_DELIVERY_TIMEOUT_MS,
      });
      resolve({ state });
    }, opts.timeoutMs ?? BRIEF_DELIVERY_TIMEOUT_MS);
    h.waiters.push(waiter);
  });
}

/**
 * The agent is GONE (closed or discarded) — discard its brief and answer any waiter.
 *
 * This is the only path that throws away a brief which was never launched, and it must be called or
 * two things go wrong: the concierge's `awaitBriefDelivery` sits out the full bound and reports
 * `unconfirmed` instead of the truthful "agent closed", and the entry outlives the agent so
 * `hasUndeliveredBrief` keeps answering true for a dead id.
 *
 * Called from the paths that destroy agent rows: `removeAgent` (close / discard / worker cascade),
 * `removeProject` (which deletes its agents with it), and `withoutRemovedAgents` (the cross-window
 * tombstone merge, which drops rows an OTHER window closed).
 *
 * THIS LIST HAS BEEN WRONG TWICE, in the same way both times. It first claimed `removeAgent` was
 * "the one choke point"; `removeProject` was missed. It then said "TWO, not one"; the tombstone
 * merge was missed (roborev 55865, 55876). A count in prose is not an invariant — nothing enforces
 * it, and it reads exactly like something that does. So do NOT trust this sentence as coverage: the
 * thing that actually protects the reply is `spawn_build_agent` OBSERVING whether the row still
 * exists at reply time rather than inferring it from the delivery outcome. Missing a call here now
 * costs a stale held entry, not a lie to the user.
 */
export function clearBrief(agentId: string, reason = "agent closed"): void {
  // `agent-closed`, NOT `launch-failed`: the row is gone and the brief is discarded, so the retry
  // remedy that fits a failed launch would be nonsense here (see BriefDeliveryOutcome).
  if (held.has(agentId)) settle(agentId, { state: "agent-closed", reason }, true);
}

/** Test seam: forget every held brief. */
export function resetAgentBriefs(): void {
  for (const id of [...held.keys()]) held.delete(id);
}

/** Test seam: how many waiter closures are currently pinned to this agent's held brief.
 *
 *  Exists so the timeout path's waiter cleanup is ASSERTABLE. Without it that cleanup is invisible:
 *  a retained waiter is still invoked by a later `settle`, sees its `done` flag and returns
 *  silently, so nothing observable changes — and a test "covering" it passes with the cleanup
 *  deleted. That is exactly the vacuous test this repo's guidance is about, and this file shipped
 *  one (roborev 55850). */
export function __heldWaiterCount(agentId: string): number {
  return held.get(agentId)?.waiters.length ?? 0;
}
