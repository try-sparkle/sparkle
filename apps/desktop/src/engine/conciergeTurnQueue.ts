// SEND AGAIN WITHOUT DESTROYING THE ANSWER YOU ARE WAITING FOR — the turn queue's policy half.
//
// ══ THE DEFECT THIS EXISTS FOR ═════════════════════════════════════════════════════════════════
// The founder: *"I basically like to have as much visibility as possible… I usually send multiple
// messages to the Concierge."* And, asking directly how many he could send: *"tell me how many
// messages I could fire off before it gets confused."*
//
// The answer today is ONE, and it is not confusion — it is a kill:
//
//   • `concierge.rs` installs at most one turn in its slot, and a newer turn REPLACES the older
//     one, calling `kill_turn_group` on the child it evicts. That takes out `claude` and every
//     process it spawned.
//   • `buildSnapshot` puts only the newest message in the prompt, so nothing carries the displaced
//     question forward.
//   • A killed turn never emits `concierge:done`, and that event is the ONLY place a session id is
//     captured — so the displaced turn's work is not merely interrupted, it leaves no trace to
//     resume from.
//
// Measured, in this app's own logs (see services/conciergeLiveness's header): on 2026-07-29, **149
// of 378 turns** were killed mid-flight by the user's own next send. Roughly two in five questions
// destroyed the answer to the one before it. The founder had been rate-limiting himself against a
// real defect, and was right to.
//
// ══ WHAT THIS MODULE DECIDES, AND WHAT IT DELIBERATELY DOES NOT ════════════════════════════════
// It decides ONE thing: when a send arrives, does it start now or wait? That is a pure function of
// (is a turn in flight?) and (what is already waiting?), so it is a pure reducer with no timers, no
// promises and no store — the same posture as engine/conciergeLiveness beside it. The host owns
// dispatch; this owns policy.
//
// It does NOT decide the ORDER a turn's reply is rendered in, does not touch the session id, and
// does not know what a snapshot is. A queued entry carries the message text and its bubble id and
// nothing else, because everything else about a turn is built at DISPATCH time from live state —
// building a snapshot at enqueue time would freeze a fleet picture that is minutes stale by the
// time the turn actually runs, which is exactly the kind of quietly-wrong context this app has been
// removing everywhere else.
//
// ══ SEQUENTIAL, AND WHY THAT IS NOT A COMPROMISE ═══════════════════════════════════════════════
// Queued turns drain ONE AT A TIME. That is not laziness about parallelism — it is forced by the
// backend: every turn resumes the SAME Claude Code session (`resume_session_id`), so two turns run
// concurrently against one session would interleave writes to one transcript. Sequential drain is
// the only safe shape until the fan-out lands (the founder's "Concierge Agents" row, which answers
// several questions at once by dispatching to SEPARATE agents rather than by racing one session).
//
// So the promise here is not "fast" — it is "NOTHING IS LOST". A queued question is answered late
// rather than destroyed, and the per-message status says which one is being worked on.

/** One message waiting for its turn. Text and bubble id only — see the header on why no snapshot. */
export interface QueuedTurn {
  /** The `you` bubble this message was rendered as, so its status and reply can be attached back. */
  bubbleId: string;
  /** Exactly what the user typed. The prompt is built from this at dispatch, never at enqueue. */
  text: string;
  /**
   * When the user sent it, in epoch ms.
   *
   * STAMPED BY THE CALLER, not by `enqueue` — this module is pure and reads no clock (see the
   * header), the same split `conciergeDelegation` and `nudge_ladder.rs` keep.
   *
   * REQUIRED, NOT OPTIONAL, and the whole reason this field exists is a bug caused by the opposite
   * choice. The Pusher's `queue-unfanned` condition refuses to fire without an age
   * (`pusherFleet.queueUnfanned`: "we cannot establish the age" is not "it is old"), so a producer
   * that silently omits the timestamp does not degrade the report — it DELETES it, permanently and
   * with nothing logged. Required makes forgetting a compile error instead.
   */
  enqueuedAt: number;
}

/**
 * The queue's whole state.
 *
 * `running` is the bubble whose turn is actually in flight, or null when nothing is. It is stored
 * rather than derived because "a turn is running" and "the queue is non-empty" are different facts
 * that a reducer must not conflate: the queue is empty for the entire life of an ordinary single
 * send, and that send is still running.
 */
export interface TurnQueueState {
  running: QueuedTurn | null;
  waiting: QueuedTurn[];
}

export const EMPTY_TURN_QUEUE: TurnQueueState = { running: null, waiting: [] };

/**
 * How many messages may wait behind the running turn.
 *
 * ══ WHY A CAP AT ALL, WHEN THE POINT IS "SEND AS MANY AS YOU LIKE" ═════════════════════════════
 * The founder's ask is explicitly large — *"maybe 20 messages that it's working on responding to at
 * once"* — so this is set well above that, at a number he is unlikely to reach by hand in one
 * sitting. It exists for the case he cannot see: a stuck turn. If the running turn never settles,
 * every later send queues behind it forever, and an unbounded queue turns "the concierge is slow"
 * into an ever-growing list of questions that will never be reached, all of them rendering a status
 * that says they are waiting.
 *
 * At the cap the OLDEST WAITER IS DROPPED, not the newest ({@link enqueue}). Refusing the newest
 * would throw away the thing the user just typed — the one message they are still looking at — to
 * preserve one they sent long enough ago to have moved on from.
 */
export const MAX_QUEUED_TURNS = 50;

/** Is anything in flight or waiting? */
export function isIdle(s: TurnQueueState): boolean {
  return s.running === null && s.waiting.length === 0;
}

/**
 * The outcome of a send: what the host should do, and the state it leaves behind.
 *
 * `dispatch` is the entry to START NOW, or null when the send was queued. Returning it rather than
 * a boolean means the host cannot dispatch the wrong entry — there is exactly one thing to hand to
 * `startConciergeTurn`, and it comes from the reducer that decided it.
 */
export interface SendOutcome {
  next: TurnQueueState;
  dispatch: QueuedTurn | null;
  /** The waiter dropped to stay under {@link MAX_QUEUED_TURNS}, so the host can say so. */
  dropped: QueuedTurn | null;
}

/**
 * A user send arrived.
 *
 * THE WHOLE BEHAVIOUR CHANGE IS HERE: with nothing running, the send dispatches immediately and the
 * queue stays empty — an ordinary single send behaves exactly as it always has. With a turn already
 * running, the send WAITS instead of superseding, which is what stops message N+1 killing the work
 * on message N.
 */
export function enqueue(s: TurnQueueState, entry: QueuedTurn): SendOutcome {
  if (s.running === null) {
    return { next: { running: entry, waiting: [] }, dispatch: entry, dropped: null };
  }
  const waiting = [...s.waiting, entry];
  // Drop from the FRONT — see MAX_QUEUED_TURNS on why the oldest goes rather than the newest.
  const dropped = waiting.length > MAX_QUEUED_TURNS ? waiting.shift()! : null;
  return { next: { ...s, waiting }, dispatch: null, dropped };
}

/**
 * The running turn ended — settled, failed, or cancelled; this reducer does not care which.
 *
 * IT DOES NOT CARE ON PURPOSE. A failed turn must drain the queue exactly like a successful one:
 * the alternative is that one quota rejection strands every question behind it, which is precisely
 * the 2026-07-29 shape (a burst of failures, each followed by a re-send) turned into a permanent
 * stall. Whether the user is TOLD about the failure is the host's business and is unchanged.
 */
export function turnFinished(s: TurnQueueState): SendOutcome {
  const [next, ...rest] = s.waiting;
  if (!next) return { next: { running: null, waiting: [] }, dispatch: null, dropped: null };
  return { next: { running: next, waiting: rest }, dispatch: next, dropped: null };
}

/**
 * The user abandoned everything (a reset / sign-out / "start over").
 *
 * Separate from {@link turnFinished} because it must NOT dispatch: draining into a fresh turn after
 * the conversation was discarded would resurrect a question the user just threw away.
 */
export function clearQueue(): TurnQueueState {
  return EMPTY_TURN_QUEUE;
}

/**
 * Where a given bubble stands, for the per-message status line.
 *
 * `"working"` is the one being answered, `"waiting"` is queued behind it, and null means this queue
 * knows nothing about it — which is the honest answer for every message in a long thread and must
 * render as nothing at all. See services/conciergeMessageStatuses: a status is a report of
 * something OBSERVED, never a claim about a message the app is not tracking.
 */
export function statusOf(s: TurnQueueState, bubbleId: string): "working" | "waiting" | null {
  if (s.running?.bubbleId === bubbleId) return "working";
  return s.waiting.some((q) => q.bubbleId === bubbleId) ? "waiting" : null;
}

/** How many messages are waiting behind the one being worked on. */
export function waitingCount(s: TurnQueueState): number {
  return s.waiting.length;
}
