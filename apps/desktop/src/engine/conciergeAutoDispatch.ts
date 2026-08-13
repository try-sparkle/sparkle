// conciergeAutoDispatch — the APP dispatches the research agent, because the concierge forgets to.
//
// ══ WHY THIS EXISTS WHEN A NUDGE ALREADY DOES ══════════════════════════════════════════════════
// `engine/conciergeDelegation` is the watcher and it works: it counts serial investigative calls on
// the live tool stream and asks the concierge to delegate. It has not changed the behaviour, and the
// reason is structural rather than a tuning problem — THERE IS NO CHANNEL THAT INTERRUPTS A TURN IN
// FLIGHT. `concierge.rs` refuses a proactive turn while the slot is occupied (`PROACTIVE_DECLINED_ERR`),
// so the nudge lands at the NEXT turn boundary: after the grind it was watching, about work that is
// already done, to a model that has moved on.
//
// The record on asking is now four rounds deep, and every one of them was a different way of asking:
//
//   1. 2026-07-29 — `concierge-guidelines.md` told it to fan out. Nothing changed.
//   2. 2026-08-11 — the same instruction added AGAIN. Nothing changed. (It also named `Task`/`Agent`,
//      a tool `CONCIERGE_ALLOWED_TOOLS` does not grant, so it could not have been followed.)
//   3. 2026-08-13 — `CONCIERGE_PERSONA` gained "DELEGATE THE DIGGING", naming a tool it does have.
//   4. …and the delegation ladder, which nudges at 6 serial calls, or 2 with messages queued.
//
// The founder, watching his messages sit six deep with the row still reading `+0`, asked for the app
// to stop asking: *"the objective is for the concierge to not be processing my results serially
// where they stack up but to parallelize them by dispatching them out to concierge agents to
// research to get answers to, so the concierge can be focused on answering me quickly. It keeps
// forgetting that it can do this."*
//
// So this module does not ask. When the queue outruns the agents working it, the app dispatches the
// waiting question itself and TELLS the concierge it did. Forgetting is no longer available.
//
// ══ PURE ON PURPOSE ════════════════════════════════════════════════════════════════════════════
// No Tauri, no store, no clock — the same split `conciergeDelegation` keeps, and `nudge_ladder.rs`
// before it. The caller owns the dispatch and the notice; this file only decides. That is what lets
// the rule be asserted directly instead of through a rendered component.
import { QUEUE_UNFANNED_MIN_AGE_MS } from "@sparkle/core";

import type { QueuedTurn } from "./conciergeTurnQueue";

/**
 * How long the oldest waiting message must have been waiting.
 *
 * ── THE SAME CONSTANT THE PUSHER USES, IMPORTED RATHER THAN RESTATED ───────────────────────────
 * `queue-unfanned` reports this situation and this module ACTS on it, so a second number here would
 * let the app dispatch something it does not report, or report something it declined to act on —
 * two channels describing the same queue in different words, which is the specific confusion the
 * founder has now raised twice. One constant, one meaning.
 *
 * The value is his: *"I don't want it to be a three-minute wait. Let's make it more than a
 * one-minute wait."* A floor at all is what keeps the ordinary case quiet — a message that arrives
 * while the previous turn is finishing is not a stalled queue, and dispatching a research pass for
 * it would spend a metered child on a question about to be answered anyway.
 */
export const AUTO_DISPATCH_MIN_WAIT_MS = QUEUE_UNFANNED_MIN_AGE_MS;

/**
 * How often the mount re-measures.
 *
 * NOT THE TRIGGER — {@link AUTO_DISPATCH_MIN_WAIT_MS} is, and it is four times this. Ticking at a
 * quarter of the floor means an eligible message is dispatched within ~15s of becoming eligible
 * rather than up to a minute late, which matters because the whole feature is about the founder not
 * waiting. A tick is a ref read plus a store read — no IPC, no subprocess — so it is nothing like
 * the per-agent cost that forced `fleetWatch`'s poll from ten seconds up to thirty.
 */
export const AUTO_DISPATCH_TICK_MS = 15_000;

/**
 * Below this many characters, a waiting message is not dispatched.
 *
 * ── WHAT THIS IS ACTUALLY GUARDING, AND WHAT IT IS NOT ─────────────────────────────────────────
 * NOT an attempt to tell questions from instructions. That classification is unreliable and the
 * cost of getting it wrong is low in one direction only — see the header on `decideAutoDispatch`
 * for why a mis-dispatched instruction is a wasted read-only pass and never a wrong write.
 *
 * What it IS guarding is the case where a research pass cannot possibly help: a bare
 * acknowledgement. "yes", "go ahead", "do it", "ship it" carry no question at all, so dispatching
 * them produces a research child with nothing to find out — a guaranteed-useless metered call, and
 * a `+1` on the row that would misrepresent the concierge as delegating. 24 characters clears every
 * one of those while leaving a genuine short question ("why is the DMG build red?") dispatchable.
 */
export const MIN_DISPATCHABLE_CHARS = 24;

/** What the caller knows about the queue and the agents working it, at one instant. */
export interface AutoDispatchObservation {
  /**
   * The messages WAITING behind the running turn, oldest first — `TurnQueueState.waiting` verbatim.
   *
   * The running turn is deliberately absent: the concierge is working on it, and dispatching a
   * research pass for the question it is already answering is duplicated work by construction.
   */
  waiting: readonly QueuedTurn[];
  /**
   * Live concierge agents — `liveTasks(...).length`, queued PLUS running.
   *
   * THE SAME SELECTOR THE SIDEBAR'S `+[n]` READS, so the number this decides on and the number the
   * founder is looking at cannot tell different stories. Counting only RUNNING children would also
   * make the rule below unsatisfiable: `MAX_CONCURRENT_RESEARCH` is 2, so a queue of six could
   * never be "covered" and the app would dispatch forever.
   */
  liveResearch: number;
  /**
   * Has the research store been read at least once?
   *
   * `false` means WE DID NOT LOOK, and it must not be read as "no agents are running" — that is the
   * fail-OPEN answer at the door of a mechanism that SPENDS MONEY when it fires. An unhydrated
   * store would report zero live agents and license dispatching the whole queue.
   */
  researchHydrated: boolean;
  /**
   * Bubble ids this mechanism has already dispatched for.
   *
   * WHY THE CALLER HOLDS THIS RATHER THAN THE DECIDER DERIVING IT. A dispatched message KEEPS
   * WAITING — dispatching research does not dequeue anything, the concierge still owes an answer —
   * so it is present in `waiting` on the next tick and on every tick after that. Without a memory
   * of what has been sent, a 15-second tick would dispatch the same question four times a minute.
   */
  dispatched: ReadonlySet<string>;
  now: number;
}

/** Why nothing was dispatched. Named rather than boolean, so the log says which rule held. */
export type AutoDispatchSkip =
  /** Nothing is waiting. The overwhelmingly common case, and the whole life of a single send. */
  | "queue-empty"
  /** An agent for every waiting message. The queue is being served — see {@link decideAutoDispatch}. */
  | "served"
  /** We have not read the research store, so we cannot know whether anything is running. */
  | "not-looked"
  /** Everything currently waiting has already been dispatched for. */
  | "all-dispatched"
  /** The oldest un-dispatched waiter has not waited long enough yet. */
  | "too-young"
  /** It is too short to be a question worth researching. See {@link MIN_DISPATCHABLE_CHARS}. */
  | "too-short";

export type AutoDispatchDecision =
  | { action: "dispatch"; entry: QueuedTurn; waitedMs: number; queued: number; live: number }
  | { action: "none"; reason: AutoDispatchSkip };

/**
 * Should the app dispatch a research agent right now, and for which message?
 *
 * ── THE RULE, WHICH IS THE FOUNDER'S AND NOT AN APPROXIMATION OF IT ────────────────────────────
 * *"let's not make it if live research is zero. Let's just make it if live research is lower than
 * the queue depth."* So the test is `liveResearch < waiting.length`, not `liveResearch === 0`. The
 * difference is the whole complaint: one agent running against six waiting messages is not a queue
 * being served — five of those messages still have nobody coming for them, and a zero-test calls
 * that healthy and stays quiet.
 *
 * ── ONE PER CALL, DELIBERATELY ─────────────────────────────────────────────────────────────────
 * A queue of six does not become six dispatches in one tick. Each dispatch raises `liveResearch` by
 * one (a task is live from the instant it is `queued`), so the next tick re-reads a queue that is
 * one closer to covered and stops on its own when it gets there. That is a control loop with the
 * measurement inside it rather than a burst decided from one reading, and it means a stale or
 * wrong count costs one metered child rather than six.
 *
 * ── WHAT HAPPENS IF THE MESSAGE WAS NOT A QUESTION ─────────────────────────────────────────────
 * Stated because it is the obvious objection and the answer is not "it cannot happen". A waiting
 * message may be an instruction — "merge that PR" — and this will dispatch a research pass for it.
 * A research pass is READ-ONLY (`research.rs` runs an investigation, not a build agent), so the
 * worst case is a wasted slot and a finding the concierge ignores. It is NEVER a wrong write, which
 * is the property that makes acting-without-asking acceptable here at all. If that ever stops being
 * true — if research gains write powers — this rule must be revisited in the same change.
 */
export function decideAutoDispatch(obs: AutoDispatchObservation): AutoDispatchDecision {
  if (obs.waiting.length === 0) return { action: "none", reason: "queue-empty" };
  // BEFORE THE COUNT, never after. An unhydrated store reports zero live agents, which reads as the
  // most acute possible version of the very condition being detected — and this mechanism spends
  // money when it fires, so it fails closed.
  if (!obs.researchHydrated) return { action: "none", reason: "not-looked" };
  if (obs.liveResearch >= obs.waiting.length) return { action: "none", reason: "served" };

  // OLDEST FIRST — `waiting` is in send order, so the first un-dispatched entry is the one that has
  // been waiting longest. It is also the one the founder is most likely to have given up on, which
  // is the reason to serve it first rather than the freshest.
  const next = obs.waiting.find((e) => !obs.dispatched.has(e.bubbleId));
  if (next === undefined) return { action: "none", reason: "all-dispatched" };

  const waitedMs = obs.now - next.enqueuedAt;
  if (!Number.isFinite(waitedMs) || waitedMs < AUTO_DISPATCH_MIN_WAIT_MS) {
    // NON-FINITE FAILS CLOSED, and it is reported as "too young" rather than dispatched. A missing
    // or corrupt stamp makes the age unknowable, and "we cannot establish the age" is not "it is
    // old" — the same reading `queueUnfanned` gives an absent `oldestAt`.
    return { action: "none", reason: "too-young" };
  }

  if (next.text.trim().length < MIN_DISPATCHABLE_CHARS) {
    return { action: "none", reason: "too-short" };
  }

  return {
    action: "dispatch",
    entry: next,
    waitedMs,
    queued: obs.waiting.length,
    live: obs.liveResearch,
  };
}

/**
 * What the concierge is told, at its next turn boundary, about a dispatch the app made for it.
 *
 * ── WHY IT IS TOLD AT ALL ──────────────────────────────────────────────────────────────────────
 * Not politeness — it is what stops duplicated work. The concierge will reach this message
 * eventually and start reading files to answer it; if it does not know a research pass is already
 * running on exactly that question, the app has bought a metered child and changed nothing. The
 * message therefore leads with the ACTION taken and names the question, so the model can match it
 * against the queue it can see.
 *
 * ── AND WHY IT READS AS A REPORT, NOT A REPRIMAND ──────────────────────────────────────────────
 * The delegation ladder already scolds; a second scolding channel is noise, and this one fires on
 * queue state rather than on anything the concierge did wrong — a queue can outrun a concierge that
 * is behaving perfectly. The one instruction it carries is the one that prevents the duplicate.
 */
export function autoDispatchNotice(entry: QueuedTurn, queued: number, live: number): string {
  const plural = queued === 1 ? "message" : "messages";
  const head = entry.text.trim().replace(/\s+/g, " ").slice(0, 120);
  return (
    `[sparkle-auto-dispatch] ${queued} ${plural} were waiting behind your turn with only ${live} ` +
    `concierge agent${live === 1 ? "" : "s"} working, so Sparkle dispatched a research agent for ` +
    `the oldest one itself: "${head}". Its findings will reach you at the start of a later turn. ` +
    `Do NOT start reading files to answer that question — it is already being researched. Reach ` +
    `for sparkle_research yourself on the next one and this will not need to happen.`
  );
}
