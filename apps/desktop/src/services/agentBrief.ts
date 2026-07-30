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
  /** No launch and no failure within the caller's patience. NOT the same as failure: the brief may
   *  still go out. Reported as unconfirmed so nobody upgrades a silence into a success. */
  | { state: "unconfirmed" };

interface Held {
  text: string;
  /** Set once a launch actually CARRIED this brief, so a later relaunch does not re-submit it. Note
   *  this is NOT "an outcome was reported": a `launch-failed` answers the waiters but leaves the
   *  brief deliverable, because the pane's Retry is expected to carry it (see `noteBriefFailed`). */
  launched: boolean;
  waiters: Array<(o: BriefDeliveryOutcome) => void>;
}

const held = new Map<string, Held>();

/** Hold `text` as `agentId`'s opening brief, to be emitted as claude's positional prompt by the
 *  pane's next FRESH launch. Replaces any brief not yet delivered (a re-spawn supersedes it). */
export function attachBrief(agentId: string, text: string): void {
  held.set(agentId, { text, launched: false, waiters: [] });
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
  return h && !h.launched ? h.text : undefined;
}

/** Is a brief still waiting to go out for this agent? (For UI copy and tests.) */
export function hasUndeliveredBrief(agentId: string): boolean {
  const h = held.get(agentId);
  return !!h && !h.launched;
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
  if (!h || h.launched) return undefined;
  log.debug("agent-brief", "brief delivered as launch argv", { agentId });
  h.launched = true;
  // Consumed: a real launch carried it, so no relaunch may submit it a second time.
  settle(agentId, { state: "submitted" }, true);
  // Handed back so the caller can record the prompt side-effects for it (pinned header, prompt
  // history, auto-naming). Those normally ride `submitPrompt`, which an argv-delivered brief never
  // touches.
  return h.text;
}

/**
 * The pane will never launch this brief: its spawn errored, or there is no claude to run. Reported
 * rather than dropped — a brief that was promised and then silently vanished is exactly the failure
 * this module exists to end (and it is the same reason `abandonPendingSends` exists).
 */
export function noteBriefFailed(agentId: string, reason: string): void {
  const h = held.get(agentId);
  if (!h || h.launched) return;
  log.warn("agent-brief", "brief was never launched", { agentId, reason });
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
 * `bridge.request("concierge_tool", …)` bounds the round trip at `DEFAULT_TIMEOUT_MS = 30_000`
 * (apps/mcp-control/src/bridgeClient.ts) and passes no override. This was 45s, which outlived that
 * transport: any briefed spawn slower than 30s killed the socket first, so the caller got a thrown
 * `bridge request timeout` for a spawn that HAD created the agent and consumed a capacity slot — and
 * the natural response to a timeout is a retry, which duplicates the agent. The honest
 * `unconfirmed` / `launch-failed` payloads this whole change exists to deliver could never reach an
 * MCP caller at all. Before the wait was introduced the op answered in milliseconds, so the 30s
 * bound was never in play.
 *
 * So this is deliberately well under it, leaving room for the rest of the round trip.
 * `agentBrief.bridgeBound.test.ts` reads the bridge's constant and fails if the two ever cross.
 *
 * Waiting for `ptyReady` (which is `pty_spawn` returning, not a booted TUI) does not need tens of
 * seconds — worktree prep, the Claude check and the bridge start are what it actually covers.
 */
export const BRIEF_DELIVERY_TIMEOUT_MS = 20_000;

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
      resolve({ state: "unconfirmed" });
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
