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
// ══ THE ORCHESTRATOR SESSION IS SEQUENTIAL; THE FAN-OUT IS NOT ═════════════════════════════════
// The RUNNING turn drains ONE AT A TIME through {@link turnFinished}. That is not laziness about
// parallelism — it is forced by the backend: every turn resumes the SAME Claude Code session
// (`resume_session_id`), so two turns run concurrently against one session would interleave writes to
// one transcript. So the orchestrator's own session stays serial, and `turnFinished` is what advances
// it when the running turn settles.
//
// ══ …BUT A WAITING PROMPT NO LONGER HAS TO WAIT FOR THAT — DISPATCH-AND-CONTINUE ═══════════════
// The defect the founder measured: because `turnFinished` was the ONLY thing that advanced the queue,
// 24–36 prompts stacked behind one serial session, each answered one-at-a-time. `conciergeAutoDispatch`
// already hands a waiting prompt's heavy lifting to a SEPARATE research child (its own session, so no
// transcript interleaving), but that child dequeued NOTHING — the prompt kept waiting, so the depth
// never dropped and the concierge still ground through the backlog serially.
//
// {@link dequeueDispatched} closes that: when a waiting prompt is handed to a worker, it LEAVES the
// queue immediately (the advance happens on DISPATCH, not on the worker's completion), so the depth
// drops now and the concierge reads the next prompt at once. The worker answers in parallel and its
// answer posts back asynchronously through the research drain / proactive push. The founder's shape,
// exactly: "it shouldn't wait while it's fanning research out." The parallelism lives entirely in the
// workers — the orchestrator session (the running turn) stays serial-but-fast.
//
// So the promise here is not "fast" — it is "NOTHING IS LOST". A queued question is answered late
// rather than destroyed, and the per-message status says which one is being worked on.

/** One message waiting for its turn. Text and bubble id only — see the header on why no snapshot. */
// The bounds — how many messages one turn may absorb, and how many characters they may put
// on a run — live with the judge that applies them, so there is exactly one definition of each.
import { MAX_ABSORBED_RUN, MAX_RUN_CHARS } from "./conciergeRelatedness";

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
  /**
   * When this prompt was HANDED TO A WORKER (moved to `delegated`), in epoch ms — set only on a
   * delegated entry, by {@link dequeueDispatched}. It is DISTINCT from `enqueuedAt`: a prompt waits up
   * to a minute before the ramp hands it off, so the redelivery grace window ({@link redeliverReadyIds})
   * must be measured from the hand-off, not from the send, or a just-delegated prompt would look
   * instantly overdue and be redelivered before its worker's task ever appears in the store.
   */
  delegatedAt?: number;
}

/**
 * The queue's whole state.
 *
 * `running` is the bubble whose turn is actually in flight, or null when nothing is. It is stored
 * rather than derived because "a turn is running" and "the queue is non-empty" are different facts
 * that a reducer must not conflate: the queue is empty for the entire life of an ordinary single
 * send, and that send is still running.
 *
 * `delegated` is the DISPATCH-AND-CONTINUE half (see the header): prompts whose heavy lifting was
 * handed to a research worker. They are NO LONGER blocking the concierge's serial session — that is
 * the whole point — but they are STILL OWED. A delegated prompt is not lost and is not answered yet;
 * it is being worked in parallel, and {@link redeliverDelegated} moves it back into `waiting` the
 * moment its worker reaches a terminal state, so the concierge always delivers an answer (with the
 * pre-warmed findings riding that turn). Keeping it in the state — rather than deleting it on
 * dispatch — is what preserves the "NOTHING IS LOST" promise AND keeps the `queue-unfanned` detector
 * honest: an owed prompt still counts, it is merely being served by a worker instead of by the queue.
 */
/**
 * The messages being answered by the turn currently in flight, oldest first.
 *
 * ══ WHY A RUN, AND WHY A NON-EMPTY TUPLE ══════════════════════════════════════════════════════
 * One turn used to mean one message. It no longer does: the founder *"often will send a message
 * right after the one that I just sent that has more context"*, and answering the first alone is
 * what makes the answer worse. A turn now answers the whole ABSORBED RUN — see
 * `engine/conciergeRelatedness` for the related/different judgement and this module's
 * {@link turnFinished} / {@link mergeIntoRunning} for the two ways a run grows.
 *
 * The tuple type is load-bearing, not decoration. The obvious model — leaving `running` a bare
 * `QueuedTurn` and adding a second `absorbed: QueuedTurn[]` beside it — compiles everywhere it is
 * already read, which is exactly the problem: `statusOf`, `queueDepthOf`, the `redeliverDelegated`
 * presence set and `conciergeMessageStatuses` would all keep building and all be silently WRONG
 * about messages 2..N. Wrapping the run in a type whose field nobody reads yet turns each of those
 * into a compile error at the one moment someone can still fix it. `[QueuedTurn, ...QueuedTurn[]]`
 * additionally makes "a running turn with no message" unrepresentable, so `running !== null` keeps
 * meaning what every existing caller already assumes it means — where a bare array would have made
 * `[] !== null` silently true.
 */
export interface RunningRun {
  readonly entries: readonly [QueuedTurn, ...QueuedTurn[]];
}

/** One entry as a single-message run — the ordinary send, which is still by far the common case. */
export function runOf(entry: QueuedTurn): RunningRun {
  return { entries: [entry] };
}

/** Every message a run answers, oldest first. `[]` when nothing is running. */
export function runEntries(run: RunningRun | null): readonly QueuedTurn[] {
  return run ? run.entries : [];
}

/** Just the texts, for the relatedness judge and the prompt. */
export function runTexts(run: RunningRun | null): string[] {
  return runEntries(run).map((q) => q.text);
}

/** Total characters a run would put in the prompt — the bound {@link mergeIntoRunning} honours. */
function runChars(entries: readonly QueuedTurn[]): number {
  return entries.reduce((n, q) => n + q.text.length, 0);
}

export interface TurnQueueState {
  running: RunningRun | null;
  waiting: QueuedTurn[];
  /** Prompts handed to a research worker — owed, being worked in parallel, not yet answered. */
  delegated: QueuedTurn[];
}

export const EMPTY_TURN_QUEUE: TurnQueueState = { running: null, waiting: [], delegated: [] };

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

/** Is anything in flight, waiting, or still owed to a worker? Nothing is outstanding when all three empty. */
export function isIdle(s: TurnQueueState): boolean {
  return s.running === null && s.waiting.length === 0 && s.delegated.length === 0;
}

/**
 * The outcome of a send: what the host should do, and the state it leaves behind.
 *
 * `dispatch` is the RUN to START NOW, or null when the send was queued. Returning it rather than
 * a boolean means the host cannot dispatch the wrong messages — there is exactly one thing to hand
 * to `startConciergeTurn`, and it comes from the reducer that decided it. It is a run rather than an
 * entry for the reason {@link RunningRun} gives: a turn answers everything absorbed into it, and a
 * host holding only the head would silently drop the rest from the prompt.
 *
 * `superseded` is the run whose in-flight turn must be KILLED before `dispatch` starts — set only by
 * {@link mergeIntoRunning}. Null on every other path, including every ordinary send.
 */
export interface SendOutcome {
  next: TurnQueueState;
  dispatch: RunningRun | null;
  /** The run whose turn this send replaces, when merging; null otherwise. See {@link mergeIntoRunning}. */
  superseded?: RunningRun | null;
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
    // `...s` preserves any `delegated` prompts owed while the concierge was idle (all its waiters were
    // handed to workers, then the running turn finished). The new send takes the slot; nothing owed
    // is dropped.
    const run = runOf(entry);
    return { next: { ...s, running: run, waiting: [] }, dispatch: run, dropped: null };
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
export function turnFinished(s: TurnQueueState, isRelated: RelatednessFn = alwaysDifferent): SendOutcome {
  const [head, ...rest] = s.waiting;
  // `...s` carries `delegated` across both branches — a running turn finishing must not discard the
  // prompts still owed to workers (they were dropped silently before `delegated` existed).
  if (!head) return { next: { ...s, running: null, waiting: [] }, dispatch: null, dropped: null };

  // ══ ABSORB THE RELATED RUN, RATHER THAN PROMOTING ONE MESSAGE ═══════════════════════════════
  // The founder's instruction, verbatim: *"you basically keep reading the following messages until
  // you get to one that you determine is substantially different. And then and only then you
  // respond."* This is the half that costs NOTHING — every candidate is already queued, so there is
  // no waiting and no added latency; we are only choosing how many of them one prompt answers.
  //
  // The default is `alwaysDifferent`, so a caller that passes no judge gets exactly today's
  // one-at-a-time behaviour. That keeps this reducer's existing callers and tests honest instead of
  // silently changing what they assert.
  const { absorbed, remaining } = walkRelated(head, rest, isRelated);
  const run: RunningRun = { entries: [head, ...absorbed] };
  return { next: { ...s, running: run, waiting: remaining }, dispatch: run, dropped: null };
}

/**
 * Does `next` belong with the run so far? `run` is oldest-first and never empty; `gapMs` is the
 * elapsed time between the last absorbed message and this candidate.
 *
 * Injected rather than imported so this module stays pure and free of the heuristic's own
 * dependencies — the same split `enqueuedAt` already keeps (the reducer reads no clock; the caller
 * stamps). `engine/conciergeRelatedness.isRelated` is the production implementation.
 */
export type RelatednessFn = (run: readonly string[], next: string, gapMs: number) => boolean;

/** The default judge: absorb nothing, i.e. exactly the behaviour before runs existed. */
const alwaysDifferent: RelatednessFn = () => false;

/**
 * Walk forward from `head`, absorbing while the judge says related and the bounds allow.
 *
 * ══ TERMINATION IS THE BOUNDS' JOB, NOT THE JUDGE'S ════════════════════════════════════════════
 * A judge that answers "related" to everything — including the fail-safe one, which answers
 * "related" whenever it cannot decide — must still leave this loop. So the walk stops on the FIRST
 * of: a different verdict, {@link MAX_ABSORBED_RUN} messages, or {@link MAX_RUN_CHARS} characters.
 * Nothing here depends on the judge behaving, which is what makes the termination test meaningful.
 *
 * ══ AND A REFUSED CANDIDATE IS NOT DISCARDED ═══════════════════════════════════════════════════
 * Everything the walk declines stays in `remaining`, in order, and heads the next turn. This module's
 * promise is "NOTHING IS LOST" (see the header); absorbing fewer messages must never mean answering
 * fewer of them.
 */
function walkRelated(
  head: QueuedTurn,
  rest: readonly QueuedTurn[],
  isRelated: RelatednessFn,
): { absorbed: QueuedTurn[]; remaining: QueuedTurn[] } {
  const absorbed: QueuedTurn[] = [];
  let i = 0;
  for (; i < rest.length; i++) {
    const candidate = rest[i];
    if (candidate === undefined) break;
    const entries: [QueuedTurn, ...QueuedTurn[]] = [head, ...absorbed];
    if (entries.length >= MAX_ABSORBED_RUN) break;
    if (runChars(entries) + candidate.text.length > MAX_RUN_CHARS) break;
    // The gap the judge weighs is between the LAST absorbed message and this one, not from the head:
    // a run built over several minutes is still one thought if each step followed closely on the last.
    const prev = entries[entries.length - 1] ?? head;
    if (!relatedOrAbsorb(isRelated, entries, candidate, candidate.enqueuedAt - prev.enqueuedAt)) break;
    absorbed.push(candidate);
  }
  return { absorbed, remaining: rest.slice(i) };
}

/**
 * Ask the judge, and ABSORB if asking it fails.
 *
 * ══ THE FAILURE MODE MUST NOT BE THE DEFECT ════════════════════════════════════════════════════
 * The founder's complaint IS splitting — his follow-up answered separately from the message it
 * completes. So a judge that throws must not produce the very behaviour the feature exists to
 * remove. Answering two messages together when they were unrelated costs a slightly broader reply;
 * answering them apart when they were one thought is the bug. The asymmetry is why the default here
 * is `true` and not `false`.
 *
 * This is belt to `engine/conciergeRelatedness.isRelated`'s braces — that function is itself
 * fail-safe. The guard is repeated at this layer because the judge is INJECTED: a caller may pass
 * its own, and the walk's safety must not depend on someone else's implementation being careful.
 */
function relatedOrAbsorb(
  isRelated: RelatednessFn,
  entries: readonly QueuedTurn[],
  candidate: QueuedTurn,
  gapMs: number,
): boolean {
  try {
    return isRelated(entries.map((q) => q.text), candidate.text, gapMs);
  } catch {
    return true;
  }
}

/**
 * A related send arrived while a turn was in flight AND that turn has not said a word yet — so fold
 * it into the run and start over.
 *
 * ══ WHY SUPERSEDING IS SAFE HERE, WHEN THIS MODULE EXISTS TO STOP SUPERSEDING ══════════════════
 * The header records the defect that created this queue: on 2026-07-29, 149 of 378 turns were KILLED
 * mid-flight by the user's own next send, destroying answers already being written. Nothing about
 * that is undone here, because the caller gates this on `conciergeSawAnswerText()` being FALSE. A
 * turn that has produced no answer text has nothing to destroy — the work it would lose is a prompt
 * we are about to re-send with strictly more context. The 2026-07-29 kills were the opposite case:
 * answers mid-sentence, thrown away.
 *
 * ══ WHY NOT WAIT INSTEAD ═══════════════════════════════════════════════════════════════════════
 * The alternative considered was holding every send for a few seconds so a follow-up could land
 * before dispatch. Measured, that costs a settle delay on EVERY message — including the vast
 * majority with no follow-up — and leaves the column blank while it runs, because the typing
 * indicator and liveness clock are raised at dispatch. Superseding pays only in the burst case, and
 * pays with a partial turn rather than with everyone's latency.
 *
 * Returns `dispatch: null` when the merge is refused (bounds exceeded), leaving the state untouched
 * so the caller falls back to {@link enqueue}. Refusing must never lose the send.
 */
export function mergeIntoRunning(s: TurnQueueState, entry: QueuedTurn): SendOutcome {
  const current = s.running;
  if (current === null) return { next: s, dispatch: null, dropped: null, superseded: null };
  const entries = current.entries;
  if (entries.length >= MAX_ABSORBED_RUN) return { next: s, dispatch: null, dropped: null, superseded: null };
  if (runChars(entries) + entry.text.length > MAX_RUN_CHARS) {
    return { next: s, dispatch: null, dropped: null, superseded: null };
  }
  const run: RunningRun = { entries: [...entries, entry] };
  return { next: { ...s, running: run }, dispatch: run, dropped: null, superseded: current };
}

/**
 * Waiting messages were HANDED TO WORKERS — move them from `waiting` to `delegated` so the queue
 * advances on DISPATCH, without dropping the obligation.
 *
 * ══ THE ADVANCE-ON-DISPATCH HALF OF THE FAN-OUT (see the header) ═══════════════════════════════
 * `conciergeAutoDispatch` decides which waiting prompts to hand to research children; this is what
 * makes that hand-off ADVANCE THE QUEUE. Until now a dispatched message kept waiting — the child
 * pre-warmed an answer but dequeued nothing, so the depth never moved and the concierge still ground
 * through the backlog one serial turn at a time.
 *
 * ══ MOVE, NEVER DELETE — WHY `delegated` AND NOT A `waiting.filter` ════════════════════════════
 * A first cut simply removed the handed-off prompts from `waiting`. That drops the depth, but it also
 * DETACHES the prompt from the only path that guarantees an answer: nothing hands it to `turnFinished`,
 * so if its worker fails, is refused after ack, or returns nothing, the prompt is gone with no
 * receipt, no status and no retry — breaking the file's own "NOTHING IS LOST" promise, and blinding
 * the `queue-unfanned` detector that motivated the feature (a deleted prompt reads as an empty queue
 * while the question is still outstanding). So the prompt MOVES to `delegated`: it stops blocking the
 * concierge's serial session, but it is still owed and still counted, and {@link redeliverDelegated}
 * brings it back to `waiting` the instant its worker terminates so the concierge answers it. Serial
 * session unblocked; obligation preserved.
 *
 * ══ WAITING-ONLY SOURCE, AND NEVER `running` ══════════════════════════════════════════════════
 * `conciergeAutoDispatch` only ever chooses from `waiting` (it excludes the running turn — the
 * concierge is already answering that on the resumed session). So this moves only from `waiting`, and
 * `running` still drains through {@link turnFinished}.
 *
 * ══ IDEMPOTENT BY BUBBLE ID ════════════════════════════════════════════════════════════════════
 * The tick is async and the queue moves under it: a concurrent {@link turnFinished} can promote a
 * waiter to `running`, or a prior tick can have handed the same prompt off already. A bubble that is
 * no longer waiting is simply absent from the result — never an error, and never a touch to `running`.
 * When nothing matches, the SAME state object is returned, so the host's publisher effect does not
 * re-render for a no-op.
 */
export function dequeueDispatched(
  s: TurnQueueState,
  bubbleIds: readonly string[],
  now: number,
): TurnQueueState {
  if (bubbleIds.length === 0) return s;
  const move = new Set(bubbleIds);
  const moved = s.waiting.filter((q) => move.has(q.bubbleId));
  if (moved.length === 0) return s; // nothing matched — same identity, no re-publish
  const waiting = s.waiting.filter((q) => !move.has(q.bubbleId));
  // Appended in send order (oldest first); a bubble already delegated is not added twice. STAMPED with
  // the hand-off time so {@link redeliverReadyIds} measures the grace window from here, not from send.
  const already = new Set(s.delegated.map((q) => q.bubbleId));
  const delegated = [
    ...s.delegated,
    ...moved.filter((q) => !already.has(q.bubbleId)).map((q) => ({ ...q, delegatedAt: now })),
  ];
  return { ...s, waiting, delegated };
}

/** The minimal view of a research pass the redelivery decision needs: is a pass for this text LIVE? */
export interface DelegatedPassView {
  /** The question as dispatched — matched to a delegated prompt by exact trimmed text. */
  question: string;
  /** Still queued or running (not terminal). */
  live: boolean;
}

/**
 * How long after a hand-off before a delegated prompt with no live pass is redelivered.
 *
 * A GRACE WINDOW, not a delay: it covers exactly the interval in which our own dispatch is invisible
 * to the research store (the poll is 5s and an unacknowledged dispatch may never appear — see
 * `conciergeAutoDispatch.DISPATCH_SETTLE_MS`, which this mirrors). Without it, a prompt handed off this
 * instant would find "no live pass matches" true, because the store has not listed its worker yet, and
 * be redelivered before the worker ever ran — undoing the hand-off on the very next tick.
 */
export const REDELIVER_GRACE_MS = 60_000;

/**
 * Which delegated prompts are ready to come back to `waiting` — FAIL-SAFE by construction.
 *
 * ══ KEYED ON THE ABSENCE OF A LIVE PASS, NOT ON OBSERVING A TERMINAL ONE ═══════════════════════
 * A first cut redelivered a prompt when it saw a terminal task with matching text. That strands a
 * prompt whose task VANISHES (`useResearchStore.replaceAll` reaps a task that drops out of a full
 * listing) — the terminal state is never observed, so the prompt is never answered and `outstanding`
 * stays > 0 forever, latching `canHoldFor` and the delegation ladder. This inverts it: a prompt
 * returns once, past the grace window, NO LIVE pass matches its text — true for finished, reaped and
 * vanished alike. Absence is the safe signal; a task that simply disappears can no longer strand it.
 *
 * It also fixes the RE-DISPATCH race the terminal-keyed version had: when a prompt is re-dispatched,
 * the store holds both the stale terminal pass AND the fresh live one, so keying on "some terminal"
 * redelivered it while its new worker had barely started. Keying on "no LIVE pass" leaves it delegated
 * while the fresh worker runs, which is correct.
 *
 * ══ NO WALL-CLOCK BACKSTOP — "IT TAKES AS LONG AS IT TAKES" (roborev, review 65704) ════════════
 * An earlier cut also redelivered anything delegated past a 10-minute ceiling, to cover a task stuck
 * `running` forever. That was WRONG: `research.rs` has no time limit (the founder had the old
 * 3/15-minute walls deleted — "remove the time limits completely"), a `queued` task in a saturated
 * pool has not even started, and pulling a still-live prompt back on the clock produces a HOLLOW
 * answer (the concierge answers with no findings, then the worker's findings land orphaned). So a
 * prompt whose worker is genuinely still live stays delegated — owed and VISIBLE (the `delegated`
 * status and the queue-unfanned count both still show it), never silently lost. A task that dies
 * without writing a terminal state is a research-layer bug to fix there, not to paper over with a
 * shorter wall one layer up.
 *
 * THE TWO CORRUPT-CLOCK SHAPES ARE HANDLED DIFFERENTLY, because their recovery is different:
 *   • A NEGATIVE age — a clock step-back on wake, `now` before `delegatedAt` — is TRANSIENT. We
 *     cannot establish the grace elapsed and redelivering would undo a fresh hand-off, so we HOLD;
 *     the prompt comes back the moment the clock passes `delegatedAt + grace` again.
 *   • A NON-FINITE age — a corrupt or absent `delegatedAt` (`NaN`/`Infinity`; note `?? ` rescues an
 *     absent stamp but not a `NaN` one) — NEVER recovers, so holding it would be the permanent strand
 *     the absence-keying above exists to remove. So a non-finite age FAILS SAFE TOWARD ANSWERING:
 *     it redelivers exactly when no live pass matches, the same as an ordinary elapsed one.
 */
export function redeliverReadyIds(
  s: TurnQueueState,
  passes: readonly DelegatedPassView[],
  now: number,
): string[] {
  if (s.delegated.length === 0) return [];
  const liveText = new Set(
    passes.filter((p) => p.live && typeof p.question === "string").map((p) => p.question.trim()),
  );
  const ready: string[] = [];
  for (const q of s.delegated) {
    const age = now - (q.delegatedAt ?? q.enqueuedAt);
    // NEGATIVE (finite) age → transient clock step-back → HOLD (see the header).
    if (age < 0) continue;
    // A non-finite age (corrupt stamp, never recovers) or a finite age past the grace window
    // redelivers — but only when nothing live is coming for it. Absence is the safe signal.
    if ((!Number.isFinite(age) || age >= REDELIVER_GRACE_MS) && !liveText.has(q.text.trim())) {
      ready.push(q.bubbleId);
    }
  }
  return ready;
}

/**
 * A worker reached a TERMINAL state — bring its delegated prompt back to `waiting` so the concierge
 * answers it (with the pre-warmed findings riding that turn).
 *
 * ══ THIS IS THE DELIVERY GUARANTEE ═════════════════════════════════════════════════════════════
 * {@link dequeueDispatched} takes a prompt out of the concierge's way while a worker researches it;
 * this is what puts it back so an answer is actually produced. Called for both outcomes — the worker
 * that finished with findings AND the worker that failed or returned nothing — because "NOTHING IS
 * LOST" means every delegated prompt is eventually answered, not only the ones whose research
 * succeeded. Re-entering `waiting` also re-arms every guard keyed on it: the re-dispatch cap and
 * cooldown, the per-message status, the depth-derived thresholds.
 *
 * Appended NEWEST-BEHIND (to the back of `waiting`) rather than jumped to the front: it has been
 * researched already, so it is cheap for the concierge to answer, but the founder's freshest live
 * questions still lead. Idempotent and order-preserving; same identity when nothing matched.
 */
export function redeliverDelegated(s: TurnQueueState, bubbleIds: readonly string[]): TurnQueueState {
  if (bubbleIds.length === 0) return s;
  const move = new Set(bubbleIds);
  const moved = s.delegated.filter((q) => move.has(q.bubbleId));
  if (moved.length === 0) return s; // nothing matched — same identity, no re-publish
  const delegated = s.delegated.filter((q) => !move.has(q.bubbleId));
  const present = new Set([
    ...runEntries(s.running).map((q) => q.bubbleId),
    ...s.waiting.map((q) => q.bubbleId),
  ]);
  const waiting = [...s.waiting, ...moved.filter((q) => !present.has(q.bubbleId))];
  return { ...s, waiting, delegated };
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
export function statusOf(
  s: TurnQueueState,
  bubbleId: string,
): "working" | "waiting" | "delegated" | null {
  // EVERY message in the run, not just its head. A bubble absorbed into the running turn is being
  // answered right now; reporting it as `waiting` — or, worse, letting it fall through to the
  // positional "3rd in line" line below — would tell the founder his follow-up is still queued while
  // the very turn he is watching is answering it.
  if (s.running?.entries.some((q) => q.bubbleId === bubbleId)) return "working";
  if (s.waiting.some((q) => q.bubbleId === bubbleId)) return "waiting";
  // HANDED TO A WORKER — owed and being researched in parallel, not lost. Rendered distinctly from
  // "waiting" so a founder whose message just left the queue is not shown a blank where a status was.
  return s.delegated.some((q) => q.bubbleId === bubbleId) ? "delegated" : null;
}

/** How many messages are waiting behind the one being worked on. */
export function waitingCount(s: TurnQueueState): number {
  return s.waiting.length;
}

/** How many messages are handed to workers — owed, being researched, not yet answered. */
export function delegatedCount(s: TurnQueueState): number {
  return s.delegated.length;
}

/** Everything still OWED behind the running turn — waiting plus delegated. What the Pusher must see. */
export function outstandingCount(s: TurnQueueState): number {
  return s.waiting.length + s.delegated.length;
}

/** The oldest still-owed send instant across waiting AND delegated, or null when nothing is owed. */
export function oldestOutstandingAt(s: TurnQueueState): number | null {
  let oldest: number | null = null;
  for (const q of s.waiting) if (oldest === null || q.enqueuedAt < oldest) oldest = q.enqueuedAt;
  for (const q of s.delegated) if (oldest === null || q.enqueuedAt < oldest) oldest = q.enqueuedAt;
  return oldest;
}
