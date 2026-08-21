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
// ══ AND WHY IT WAS REWRITTEN — THE LATCH (bead `sparkle-zx9knz`) ═══════════════════════════════
// The first version dispatched each message AT MOST ONCE, EVER, and it held that memory as a plain
// `Set<string>` living inside the host's `[]`-dep effect. Both halves of that were wrong, and
// together they are why the founder watched sixteen messages queue behind a badge reading `+2`:
//
//   • A DISPATCHED MESSAGE KEEPS WAITING. Research dequeues nothing — only `turnFinished` advances
//     the turn queue — so a message that has had its one pass is still in `waiting` forever after.
//     Once every waiter had been dispatched once, this decider returned `all-dispatched` and never
//     fired again. Those passes ran 30s–14min, finished, and left the live count (`liveTasks` is
//     queued+running only), so the badge decayed toward zero while the queue stayed sixteen deep.
//   • THE SET DID NOT SURVIVE A REMOUNT, which is the opposite failure in the same mechanism: a
//     host remount re-armed the latch and re-dispatched the whole queue.
//
// The replacement is not a better ledger — it is NO ledger. What has already been sent is DERIVED
// from the research store by matching a task's `question` to the waiting message's trimmed text
// (`dispatchResearchTask` trims, and the runner stores that verbatim, so the match is exact). That
// is durable across a remount by construction, and it is the only source that can also say whether
// the earlier pass has FINISHED — the fact the latch had no way to represent. See
// {@link dispatchStateFor}.
//
// ══ PURE ON PURPOSE ════════════════════════════════════════════════════════════════════════════
// No Tauri, no store, no clock — the same split `conciergeDelegation` keeps, and `nudge_ladder.rs`
// before it. The caller owns the dispatch and the notice; this file only decides. That is what lets
// the rule be asserted directly instead of through a rendered component. `dispatchStateFor` keeps
// that posture too: it takes {@link ResearchPassRecord}, a four-field structural reduction of
// `ResearchTask`, rather than importing the store's type — so the decider still knows nothing about
// where a task comes from.
import { MAX_CONCURRENT_RESEARCH, QUEUE_UNFANNED_MIN_AGE_MS } from "@sparkle/core";

import { endsMidClause } from "../voice/confidence";

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

/**
 * How long a dispatch WE just made counts as live before the store has confirmed it.
 *
 * ══ A GRACE WINDOW, NOT A LATCH — AND THAT DIFFERENCE IS THE WHOLE BEAD ════════════════════════
 * The `Set<string>` this replaces was permanent: once a bubble id went in, nothing ever took it out,
 * so a message was un-dispatchable for the rest of the mount however long ago its pass had finished.
 * This EXPIRES. It covers exactly the window in which our own dispatch is invisible — we fired, and
 * the store has not listed it yet (`RESEARCH_POLL_INTERVAL_MS` is 5s against a 15s tick, so one or
 * two ticks) — and then it stops holding anything back.
 *
 * SIXTY SECONDS RATHER THAN THE POLL INTERVAL, because the poll is not the only way a dispatch goes
 * unseen. `dispatchResearchTask` bounds its round trip (`DISPATCH_ACK_MS`) and can return
 * `not-acknowledged` WITH NO TASK ID AT ALL — and its header is explicit that such a dispatch has
 * very probably STARTED, so retrying it buys a second metered child for one question. There is no
 * id to match on and possibly no store record ever, so the only thing standing between that case and
 * a re-dispatch is this window plus {@link AUTO_REDISPATCH_COOLDOWN_MS} behind it.
 *
 * WHAT HAPPENS AT EXPIRY IS DELIBERATE AND IS NOT "FORGET IT": an expired stamp with still nothing
 * in the store is counted as a pass that FINISHED at the moment the window closed
 * ({@link dispatchStateFor}). So an unacknowledged dispatch does not become re-dispatchable the
 * instant we stop believing in it — it enters the cooldown like any other completed pass, and it
 * spends one of the {@link MAX_DISPATCH_PASSES_PER_MESSAGE}. Fail-closed on the money-spending side.
 */
export const DISPATCH_SETTLE_MS = 60_000;

/**
 * How many research passes ONE waiting message may ever have.
 *
 * ══ WITHOUT THIS, DE-LATCHING IS A MONEY LOOP ══════════════════════════════════════════════════
 * The latch being removed was wrong, but it was not arbitrary: it was the only thing standing
 * between this mechanism and unbounded spend. Consider a message whose research pass fails
 * instantly — a bad project root, a logged-out CLI, a child that dies on spawn. It goes terminal in
 * under a second, so "no live pass" is true again immediately, and a re-dispatch rule with only a
 * liveness test would fire again on the very next tick, and the next, for as long as the message
 * sits in the queue. That is four metered children a minute, forever, for one question — strictly
 * worse than the latch it replaced.
 *
 * THREE is the cap because the failure this feature exists for is a message with NOBODY coming for
 * it; a third independent pass that also came back with nothing is evidence about the question, not
 * about the queue. The cooldown paces the retries; this bounds them.
 */
export const MAX_DISPATCH_PASSES_PER_MESSAGE = 3;

/**
 * How long after a pass FINISHES before the same message may be dispatched again.
 *
 * THE SAME CONSTANT AS THE WAIT FLOOR, IMPORTED RATHER THAN INVENTED, for the reason
 * {@link AUTO_DISPATCH_MIN_WAIT_MS}'s own docstring gives: one constant, one meaning. The two ask
 * the same question at different moments — *has this message been unattended long enough to be
 * worth a metered child?* — and answering it with two numbers is how a mechanism comes to dispatch
 * on a threshold it does not report.
 */
export const AUTO_REDISPATCH_COOLDOWN_MS = AUTO_DISPATCH_MIN_WAIT_MS;

/**
 * The most dispatches one tick may make.
 *
 * ══ THE RAMP'S STEP SIZE — WHY FOUR AND NOT SIXTEEN ════════════════════════════════════════════
 * The old rule was one dispatch per tick, and it took ~4 minutes to put sixteen agents on sixteen
 * waiting messages — by which time the founder has given up on the queue this exists to serve.
 * Sixteen at once would be instant and is the wrong answer for the reason the one-per-tick rule was
 * written: a burst decided from ONE reading spends the whole pool on a count that may already be
 * stale. Four is the step that keeps the control loop intact while reaching the pool in ~60s: 0
 * live / 16 waiting covers in four ticks, and a wrong or stale count costs at most four metered
 * children rather than sixteen. See {@link decideAutoDispatch} for the full arithmetic.
 */
export const AUTO_DISPATCH_MAX_PER_TICK = 4;

/** What has already been sent for one waiting message, as the caller observes it. */
export interface BubbleDispatchState {
  /** How many research passes this message has had. 0 for a message never dispatched. */
  passes: number;
  /** Is any of its passes still LIVE (queued or running, or too fresh for the store to have seen)? */
  livePass: boolean;
  /** Epoch ms the most recent pass reached a terminal state; null when none has, or none is known. */
  lastFinishedAt: number | null;
}

/**
 * One research pass, reduced to what the dispatch decision needs.
 *
 * A STRUCTURAL TYPE, not `ResearchTask`. This module holds no store and no Tauri (see the header),
 * and taking the store's own type here would import that dependency through the back door. The
 * caller maps — `live: isLivePhase(t.status)`, `finishedAt: t.finishedAt` — which is three fields of
 * translation in exchange for a decider that can be tested with object literals.
 */
export interface ResearchPassRecord {
  /** The question as dispatched — matched to a waiting message by exact trimmed text. */
  question: string;
  /** Still queued or running. */
  live: boolean;
  /** Epoch ms it reached a terminal state; null while live. */
  finishedAt: number | null;
}

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
   * founder is looking at cannot tell different stories. It is also the ramp's own measurement:
   * a task is live from the instant it is `queued`, so each dispatch raises this immediately and the
   * next tick measures against a queue one step closer to covered.
   *
   * COUNTING ONLY `running` WOULD BREAK THE RULE BELOW, and not merely make it noisier. The pool's
   * cap (`packages/core/researchPool.ts`, mirrored from `research.rs`) bounds how many children can
   * hold a permit at once; everything past it waits in the runner's waiting room, still dispatched
   * and still owed. A count that ignored the waiting room would report those as absent and keep
   * dispatching against a queue it had already covered.
   */
  liveResearch: number;
  /**
   * Prompts already handed to a worker and still owed — `TurnQueueState.delegated.length`.
   *
   * ══ WHY THE `served` TEST CANNOT USE `waiting.length` ANY MORE (roborev 65829) ═══════════════
   * Before dispatch-and-continue, a dispatched prompt STAYED in `waiting`, so `liveResearch` and
   * `waiting.length` counted the same population and comparing them was apples to apples. Now the
   * hand-off MOVES the prompt to `delegated` while its worker keeps inflating `liveResearch`, so
   * the comparison is systematically skewed toward "covered".
   *
   * Worked example, with the shipped constants: 5 prompts stack behind the running turn. Tick 1
   * dispatches 4 (`AUTO_DISPATCH_MAX_PER_TICK`), which move to `delegated` → `waiting` is 1 and
   * `liveResearch` is 4. Tick 2 evaluates `4 >= 1` and answers `served` — declaring the 5th prompt
   * covered by four workers researching four OTHER questions. It is never fanned out and is
   * answered serially, silently, at the tail of every backlog: the exact defect this feature
   * exists to remove.
   *
   * `buildConciergeQueue` and `queueCondition` were both already changed to count `waiting +
   * delegated` "precisely so dispatch-and-continue does not blind the detector it feeds". This is
   * the same correction for the decider, which makes the same comparison against the same two
   * numbers and was missed.
   *
   * OPTIONAL, defaulting to 0, so a caller that has not been updated behaves exactly as before
   * rather than failing to compile into a wrong answer.
   */
  delegated?: number;
  /**
   * Has the research store been read at least once?
   *
   * `false` means WE DID NOT LOOK, and it must not be read as "no agents are running" — that is the
   * fail-OPEN answer at the door of a mechanism that SPENDS MONEY when it fires. An unhydrated
   * store would report zero live agents and license dispatching the whole queue.
   */
  researchHydrated: boolean;
  /**
   * What each waiting message has already had spent on it — see {@link dispatchStateFor}.
   *
   * A BUBBLE ABSENT FROM THE MAP HAS NEVER BEEN DISPATCHED. That is the map's whole contract, and
   * it is why an empty map is a legal observation rather than a suspicious one: the first tick of a
   * fresh queue has nothing in it.
   *
   * WHY A MAP AND NOT THE `Set` IT REPLACES. A set can only answer *has this been sent*, and the
   * answer the ramp needs is *is anything still coming for this* — a question a set cannot even
   * express. See the header on the latch (bead `sparkle-zx9knz`).
   */
  dispatched: ReadonlyMap<string, BubbleDispatchState>;
  /**
   * Are ALL of this machine's Claude accounts OAuth-expired (`credentialHealth.isCredentialExpired`)?
   *
   * WHEN TRUE, NOTHING DISPATCHES — see {@link decideAutoDispatch}. A research pass is a metered
   * `claude` child, and every one of them dies on the same dead auth the concierge's own turns die on,
   * so dispatching against it spends money to produce nothing while the founder is being told, once,
   * to sign in again (bead sparkle-s8xi35). It is a whole-pool fact, not a per-waiter one, so it gates
   * the whole decision rather than feeding {@link excludeReason}. Self-heals: the credential-health
   * state returns to healthy the moment a `/login` gives the machine a usable account, and the next
   * tick dispatches normally.
   */
  credentialExpired: boolean;
  now: number;
}

/** Why nothing was dispatched. Named rather than boolean, so the log says which rule held. */
export type AutoDispatchSkip =
  /**
   * Every Claude account is OAuth-expired, so a research child would only die on the same dead auth.
   * Checked FIRST — it is a fact about the whole credential pool, not about any waiter — so it wins
   * over every other reason including {@link AutoDispatchObservation.credentialExpired}'s siblings.
   */
  | "credential-expired"
  /** Nothing is waiting. The overwhelmingly common case, and the whole life of a single send. */
  | "queue-empty"
  /** An agent for every waiting message. The queue is being served — see {@link decideAutoDispatch}. */
  | "served"
  /** We have not read the research store, so we cannot know whether anything is running. */
  | "not-looked"
  /**
   * Every waiter currently has a LIVE pass — something is already coming for each of them.
   *
   * NARROWED FROM ITS ORIGINAL MEANING (bead `sparkle-zx9knz`). It used to mean "every waiter has
   * been dispatched for at some point in the life of this mount", which is a permanent condition
   * and was the defect: it was the reason the mechanism went quiet with sixteen messages in line.
   * It now describes a state that ENDS on its own as those passes finish.
   */
  | "all-dispatched"
  /** Candidates exist, but their most recent pass finished too recently. See {@link AUTO_REDISPATCH_COOLDOWN_MS}. */
  | "cooling"
  /** Candidates have used every pass they get. See {@link MAX_DISPATCH_PASSES_PER_MESSAGE}. */
  | "spent"
  /** The pool is already full of live tasks — dispatching now would only fill the waiting room. */
  | "at-cap"
  /** The oldest re-dispatchable waiter has not waited long enough yet. */
  | "too-young"
  /** It is too short to be a question worth researching. See {@link MIN_DISPATCHABLE_CHARS}. */
  | "too-short"
  /** It reads as CUT OFF mid-clause, so there is no whole question in it. See {@link endsMidClause}. */
  | "fragment";

export type AutoDispatchDecision =
  | {
      action: "dispatch";
      /** Every message to dispatch this tick, oldest first. Never empty. */
      entries: readonly QueuedTurn[];
      queued: number;
      live: number;
      /** The OLDEST chosen entry's wait, for the log line. */
      waitedMs: number;
    }
  | { action: "none"; reason: AutoDispatchSkip };

/**
 * What has already been spent on each waiting message, DERIVED FROM THE RESEARCH STORE.
 *
 * ══ WHY DERIVED AND NOT REMEMBERED ═════════════════════════════════════════════════════════════
 * The obvious implementation is a ledger: keep the task id a dispatch returned, look it up later.
 * It is worse than this in three ways, and the first one is the bead.
 *
 *   • A LEDGER DIES WITH THE MOUNT. The `Set` this replaces lived inside a `[]`-dep effect, so a
 *     host remount re-armed the latch and re-dispatched the entire queue — the opposite failure
 *     from the one it was written to prevent, in the same three lines.
 *   • A LEDGER CANNOT SEE A DISPATCH IT DID NOT MAKE. The concierge dispatches research itself
 *     (`conciergeTools/registry`'s `dispatch` route), and that pass covers the waiting question
 *     just as well as ours does. Matching on the QUESTION counts it; matching on our own returned
 *     ids cannot, so the app would buy a second child for a question already being researched.
 *   • A LEDGER HAS NO ID FOR THE CASE THAT MATTERS MOST. An unacknowledged dispatch returns no task
 *     id at all, which is precisely the case where a retry is forbidden — see
 *     {@link DISPATCH_SETTLE_MS}.
 *
 * ══ THE MATCH IS EXACT TEXT, AND THAT IS SOUND RATHER THAN LUCKY ═══════════════════════════════
 * `dispatchResearchTask` does `const question = input.question.trim()` and the runner stores that
 * string verbatim (`ResearchTask.question` is documented "the question as dispatched. Verbatim").
 * So a pass we made for a waiting message has a `question` equal to that message's trimmed text —
 * not similar to it, equal. No fuzzy matching, no substring, nothing that could quietly widen.
 *
 * TWO WAITERS WITH IDENTICAL TEXT (the founder sent the same question twice) both match the same
 * passes and therefore both count them. That over-counts, and it over-counts in the direction that
 * DECLINES to spend money: the second copy is held back by a pass dispatched for the first. Given
 * the two are literally the same question, one pass answering both is the right outcome anyway.
 *
 * @param waiting      the messages still in line, oldest first
 * @param passes       every research task this window knows about, reduced to {@link ResearchPassRecord}
 * @param pendingSince bubbleId -> when WE fired, for dispatches the store may not have seen yet
 * @param now          epoch ms
 */
export function dispatchStateFor(
  waiting: readonly QueuedTurn[],
  passes: readonly ResearchPassRecord[],
  pendingSince: ReadonlyMap<string, number>,
  now: number,
): Map<string, BubbleDispatchState> {
  // Grouped once rather than scanned per waiter: the store holds every task this install has ever
  // run (172 of them on the founder's machine at the time of the bead) and `waiting` can be 16 deep.
  const byQuestion = new Map<string, ResearchPassRecord[]>();
  for (const p of passes) {
    // A PASS WITH NO READABLE QUESTION IS SKIPPED, not crashed on. The store is a mirror of JSON on
    // disk (`research/<id>.json`), so a truncated or hand-edited file can produce a record missing
    // the one field this match is built on — and `tsc` cannot see that, because the store's own
    // `byId` is populated from a Tauri response. There is no fail-CLOSED option here: a pass whose
    // question is unreadable cannot be attributed to any waiter by any rule, so counting it would
    // mean guessing which message it covers. Skipping is the only honest answer, and it is bounded
    // by the cooldown and the pass cap behind it.
    if (typeof p.question !== "string") continue;
    const key = p.question.trim();
    const bucket = byQuestion.get(key);
    if (bucket === undefined) byQuestion.set(key, [p]);
    else bucket.push(p);
  }

  const out = new Map<string, BubbleDispatchState>();
  for (const entry of waiting) {
    const matched = byQuestion.get(entry.text.trim()) ?? [];
    const liveInStore = matched.some((p) => p.live);

    const stamp = pendingSince.get(entry.bubbleId);
    const stamped = stamp !== undefined && Number.isFinite(stamp);
    // NON-FINITE `now` FAILS CLOSED TOO: `NaN - x < window` is false, so a corrupt clock cannot make
    // a fresh stamp look expired and license an immediate re-dispatch. It reports the stamp as
    // expired-and-unseen instead, which enters the cooldown.
    const pendingFresh = stamped && now - (stamp as number) < DISPATCH_SETTLE_MS;
    // WE FIRED, THE WINDOW CLOSED, AND THE STORE NEVER SHOWED IT. Counted as a pass that finished
    // when the window closed rather than discarded — see {@link DISPATCH_SETTLE_MS} for why an
    // unacknowledged dispatch must not become instantly re-dispatchable.
    const unseenExpired = stamped && !pendingFresh && matched.length === 0;

    let count = matched.length;
    // Only when the store shows nothing live for this text: if it does, that live task IS the
    // dispatch this stamp refers to, and counting both would double-count one pass.
    if (pendingFresh && !liveInStore) count += 1;
    // AND THE EXPIRED-UNSEEN CASE COUNTS TOO. Dropping it here would be the whole guard collapsing:
    // with no pass recorded the bubble is absent from the map, absent means never dispatched, and an
    // unacknowledged dispatch — the one `dispatchResearchTask` forbids retrying — would be re-sent
    // on the very next tick with neither the cooldown nor the pass cap ever binding.
    if (unseenExpired) count += 1;

    let lastFinishedAt: number | null = null;
    for (const p of matched) {
      if (p.live || p.finishedAt === null || !Number.isFinite(p.finishedAt)) continue;
      if (lastFinishedAt === null || p.finishedAt > lastFinishedAt) lastFinishedAt = p.finishedAt;
    }
    if (unseenExpired) {
      const closedAt = (stamp as number) + DISPATCH_SETTLE_MS;
      if (lastFinishedAt === null || closedAt > lastFinishedAt) lastFinishedAt = closedAt;
    }

    if (count === 0) continue; // never dispatched — absent from the map, by contract
    out.set(entry.bubbleId, { passes: count, livePass: liveInStore || pendingFresh, lastFinishedAt });
  }
  return out;
}

/** Why THIS waiter was not chosen, or `null` when it was eligible. Ordered by the precedence below. */
function excludeReason(
  entry: QueuedTurn,
  state: BubbleDispatchState | undefined,
  now: number,
): AutoDispatchSkip | null {
  if (state !== undefined) {
    // SOMETHING IS ALREADY COMING FOR IT. Checked first because it is the only exclusion that is
    // about the queue being served rather than about a rule declining to serve it.
    if (state.livePass) return "all-dispatched";
    if (state.passes >= MAX_DISPATCH_PASSES_PER_MESSAGE) return "spent";
    if (state.passes > 0) {
      const since = state.lastFinishedAt;
      // FAIL CLOSED ON A NON-FINITE STAMP, and note the shape: `now - NaN >= cooldown` is FALSE, so
      // the naive comparison already declines — but only by accident of the operator's direction.
      // Stated explicitly so an inversion of this test (`< cooldown` returning early) cannot quietly
      // turn "we cannot establish when it finished" into "it finished long ago", which is the
      // fail-open direction on a mechanism that spends money. Same trap the age check documents.
      if (since === null || !Number.isFinite(since)) return "cooling";
      if (!(now - since >= AUTO_REDISPATCH_COOLDOWN_MS)) return "cooling";
    }
  }

  const waitedMs = now - entry.enqueuedAt;
  if (!Number.isFinite(waitedMs) || waitedMs < AUTO_DISPATCH_MIN_WAIT_MS) {
    // NON-FINITE FAILS CLOSED, and it is reported as "too young" rather than dispatched. A missing
    // or corrupt stamp makes the age unknowable, and "we cannot establish the age" is not "it is
    // old" — the same reading `queueUnfanned` gives an absent `oldestAt`.
    return "too-young";
  }

  if (entry.text.trim().length < MIN_DISPATCHABLE_CHARS) return "too-short";
  // ── A FRAGMENT IS NOT A QUESTION (bead `sparkle-r3wl6f`) ─────────────────────────────────────
  // Distinct from `too-short` above and NOT a refinement of it: length is the wrong axis entirely.
  // `we can see that there is` is 24 characters, clears that floor exactly, and is not a question
  // by any reading. What disqualifies it is its TAIL.
  //
  // WHAT THIS COST, measured on one evening: the founder's dictation was being truncated (the other
  // half of that bead), and SEVEN research agents were dispatched on the resulting fragments. All
  // seven came back with the same finding — "your message got cut off, there is nothing here to
  // research" — each having first read NOTES.md, the stash list and the bead backlog hunting for an
  // antecedent that only ever existed in the conversation. Seven metered children, seven `+1`s on
  // the row misrepresenting the concierge as delegating, and no answer produced by any of them.
  //
  // THIS IS WORTH KEEPING EVEN IF THE TRUNCATION NEVER RECURS, which is why it is a separate fix
  // rather than a belt on the first one. It is defensive against ANY future source of a cut-off
  // message — a relay drop, a paste that lost its tail, a hand-typed thought abandoned halfway —
  // and it costs one string comparison against a message already in hand.
  //
  // The message still REACHES the concierge; only the research child is refused. A fragment the
  // founder wants answered is answered by the concierge asking him to finish it, which is a turn he
  // was going to spend anyway — not by a subprocess searching the repo for words he never said.
  if (endsMidClause(entry.text)) return "fragment";
  return null;
}

/**
 * Should the app dispatch research right now, and for which messages?
 *
 * ── THE RULE, WHICH IS THE FOUNDER'S AND NOT AN APPROXIMATION OF IT ────────────────────────────
 * *"let's not make it if live research is zero. Let's just make it if live research is lower than
 * the queue depth."* So the test is `liveResearch < waiting.length`, not `liveResearch === 0`. The
 * difference is the whole complaint: one agent running against six waiting messages is not a queue
 * being served — five of those messages still have nobody coming for them, and a zero-test calls
 * that healthy and stays quiet.
 *
 * ── A BATCH PER TICK, AND WHY THAT DOES NOT ABANDON THE CONTROL LOOP ───────────────────────────
 * THIS PARAGRAPH REPLACES ONE THAT SAID "ONE PER CALL, DELIBERATELY" (bead `sparkle-zx9knz`), so it
 * owes an account of why that rule was written and what of it survives. It was written to keep the
 * MEASUREMENT INSIDE THE LOOP: a queue of six must not become six dispatches decided from a single
 * reading, because each dispatch raises `liveResearch` (a task is live from the instant it is
 * `queued`), so a burst spends children against a count that its own earlier members have already
 * invalidated. That reasoning is correct and is kept in full. What was wrong was the step size, not
 * the shape — at one per 15s tick, sixteen waiting messages take four minutes to cover, and the
 * founder has long since stopped waiting.
 *
 * So the batch is still DERIVED FROM THE READING THIS TICK JUST TOOK, and bounded three ways:
 *
 *     deficit  = waiting.length - liveResearch                    // > 0; the `served` check guarantees it
 *     headroom = max(0, MAX_CONCURRENT_RESEARCH - liveResearch)   // never create children the pool can only park
 *     budget   = min(deficit, headroom, AUTO_DISPATCH_MAX_PER_TICK)
 *
 * `deficit` is the messages with nobody coming for them — dispatching past it would spend a child on
 * a question already covered. `headroom` is the pool's own shape, imported from
 * `packages/core/researchPool.ts` (which is drift-tested against the `research.rs` that declares
 * it): past the cap a dispatch does not fail, it queues in the runner's waiting room, so exceeding
 * headroom buys children that cannot run and inflates the very badge the founder reads.
 * {@link AUTO_DISPATCH_MAX_PER_TICK} is the step that keeps the loop honest.
 *
 * The result: 0 live against 16 waiting reaches 16 in FOUR ticks (~60s) rather than ~4 minutes, and
 * a stale or wrong count costs at most four metered children instead of sixteen. Every tick
 * re-measures; nothing is decided from a reading older than this one.
 *
 * ── AND WHY A MESSAGE MAY BE DISPATCHED MORE THAN ONCE, BUT NOT MANY TIMES ─────────────────────
 * A message whose pass has FINISHED while it is still in the queue has, once again, nobody coming
 * for it — that is exactly the condition this whole mechanism fires on, and the original latch
 * declared it permanently ineligible. It is eligible again, subject to three guards that all have
 * to hold: no live pass, {@link MAX_DISPATCH_PASSES_PER_MESSAGE} not reached, and
 * {@link AUTO_REDISPATCH_COOLDOWN_MS} elapsed since the last one finished. Removing the latch
 * without those is a money loop; see each constant for the case it closes.
 *
 * ── WHAT HAPPENS IF THE MESSAGE WAS NOT A QUESTION ─────────────────────────────────────────────
 * Stated because it is the obvious objection and the answer is not "it cannot happen". A waiting
 * message may be an instruction — "merge that PR" — and this will dispatch a research pass for it.
 * A research pass is READ-ONLY (`research.rs` runs an investigation, not a build agent), so the
 * worst case is a wasted slot and a finding the concierge ignores. It is NEVER a wrong write, which
 * is the property that makes acting-without-asking acceptable here at all. If that ever stops being
 * true — if research gains write powers — this rule must be revisited in the same change.
 *
 * AND THE INSTRUCTION IS STILL CARRIED OUT. Under dispatch-and-continue the dispatched prompt is
 * MOVED to `delegated` (`conciergeTurnQueue.dequeueDispatched`), not deleted, and `redeliverDelegated`
 * returns it to `waiting` when its worker terminates — so the concierge still receives the instruction
 * and acts on it, with the read-only findings as context. Advancing the queue defers the instruction
 * behind fresher input; it never drops it.
 */
export function decideAutoDispatch(obs: AutoDispatchObservation): AutoDispatchDecision {
  // BEFORE ANYTHING ELSE, EVEN THE EMPTY-QUEUE CHECK. When every account is OAuth-expired a research
  // pass is a metered `claude` child that dies on the same dead auth every concierge turn dies on, so
  // there is nothing worth spending on until a human signs in again (bead sparkle-s8xi35). This is a
  // whole-pool fact — it does not depend on what is waiting — so it short-circuits the whole decision
  // rather than being one more per-waiter exclusion. It clears itself when the credential recovers.
  if (obs.credentialExpired) return { action: "none", reason: "credential-expired" };
  if (obs.waiting.length === 0) return { action: "none", reason: "queue-empty" };
  // BEFORE THE COUNT, never after. An unhydrated store reports zero live agents, which reads as the
  // most acute possible version of the very condition being detected — and this mechanism spends
  // money when it fires, so it fails closed.
  if (!obs.researchHydrated) return { action: "none", reason: "not-looked" };
  // OUTSTANDING, not waiting — see `AutoDispatchObservation.delegated`. `liveResearch` counts the
  // workers on delegated prompts too, so comparing it against `waiting` alone declares the tail of a
  // backlog served by children working on other questions.
  const outstanding = obs.waiting.length + (obs.delegated ?? 0);
  if (obs.liveResearch >= outstanding) return { action: "none", reason: "served" };

  // BEFORE THE PER-WAITER LOOP. A full pool is a fact about the runner, not about any one message,
  // so reporting it as (say) "cooling" would name a rule that had nothing to do with the refusal.
  const headroom = Math.max(0, MAX_CONCURRENT_RESEARCH - obs.liveResearch);
  if (headroom === 0) return { action: "none", reason: "at-cap" };

  // OLDEST FIRST — `waiting` is in send order, so the earliest eligible entry has been waiting
  // longest. It is also the one the founder is most likely to have given up on, which is the reason
  // to serve it first rather than the freshest.
  const eligible: QueuedTurn[] = [];
  let oldestExcluded: AutoDispatchSkip | null = null;
  for (const entry of obs.waiting) {
    const reason = excludeReason(entry, obs.dispatched.get(entry.bubbleId), obs.now);
    if (reason === null) eligible.push(entry);
    // THE OLDEST EXCLUDED WAITER'S REASON, not the last one seen. `waiting` is oldest-first, so the
    // first exclusion recorded is the one holding back the message that has waited longest — the
    // rule the founder is actually being held by. Reporting the last would make the log a function
    // of iteration order and would name whichever rule the NEWEST message happened to trip.
    else if (oldestExcluded === null) oldestExcluded = reason;
  }

  if (eligible.length === 0) {
    // `oldestExcluded` cannot be null here: the queue is non-empty and every entry was either
    // eligible or excluded with a reason. `all-dispatched` is the fallback rather than a throw
    // because a decider that crashes is worse than one that stays quiet for a tick.
    return { action: "none", reason: oldestExcluded ?? "all-dispatched" };
  }

  // Also measured against OUTSTANDING, for the same reason: a deficit computed from `waiting` alone
  // shrinks by one for every prompt the previous tick delegated, so the batch starves as it drains.
  // `entries` is still selected from `obs.waiting` only — a delegated prompt already has a worker.
  const deficit = outstanding - obs.liveResearch;
  const budget = Math.min(deficit, headroom, AUTO_DISPATCH_MAX_PER_TICK);
  const entries = eligible.slice(0, budget);

  return {
    action: "dispatch",
    entries,
    // The OLDEST chosen entry — `entries` is in send order, so index 0 is the longest wait.
    waitedMs: obs.now - entries[0]!.enqueuedAt,
    queued: obs.waiting.length,
    live: obs.liveResearch,
  };
}

/**
 * What the concierge is told, at its next turn boundary, about dispatches the app made for it.
 *
 * ── WHY IT IS TOLD AT ALL ──────────────────────────────────────────────────────────────────────
 * Not politeness — it is what stops duplicated work. The concierge will reach these messages
 * eventually and start reading files to answer them; if it does not know a research pass is already
 * running on exactly those questions, the app has bought metered children and changed nothing. The
 * message therefore leads with the ACTION taken and names each question, so the model can match
 * them against the queue it can see.
 *
 * ── AND WHY IT READS AS A REPORT, NOT A REPRIMAND ──────────────────────────────────────────────
 * The delegation ladder already scolds; a second scolding channel is noise, and this one fires on
 * queue state rather than on anything the concierge did wrong — a queue can outrun a concierge that
 * is behaving perfectly. The one instruction it carries is the one that prevents the duplicate.
 *
 * ── ONE NOTICE PER TICK, COVERING THE WHOLE BATCH ──────────────────────────────────────────────
 * It takes the LIST rather than one entry (bead `sparkle-zx9knz`). Four notices for one tick's four
 * dispatches would be four preamble insertions saying nearly the same thing, and the concierge
 * reads the preamble as narrative — a repeated near-identical paragraph is how a model comes to
 * treat the whole channel as boilerplate.
 */
export function autoDispatchNotice(
  entries: readonly QueuedTurn[],
  queued: number,
  live: number,
): string {
  const msgs = queued === 1 ? "message" : "messages";
  const wasWere = queued === 1 ? "was" : "were";
  const agents = live === 1 ? "agent" : "agents";
  const n = entries.length;
  // TRUNCATED AND WHITESPACE-FLATTENED, as before: the notice is preamble the concierge reads, and a
  // pasted stack trace or a thousand-word message would crowd out everything after it.
  const heads = entries
    .map((e) => `"${e.text.trim().replace(/\s+/g, " ").slice(0, 120)}"`)
    .join(", ");
  return (
    `[sparkle-auto-dispatch] ${queued} ${msgs} ${wasWere} waiting behind your turn with only ${live} ` +
    `concierge ${agents} working, so Sparkle handed ${n === 1 ? "the oldest one" : "the oldest ones"} ` +
    `to ${n === 1 ? "a research agent" : `${n} research agents`} so ${n === 1 ? "it does" : "they do"} ` +
    `not block you: ${heads}. ${n === 1 ? "It left" : "They left"} your queue and ` +
    `${n === 1 ? "will come" : "will each come"} back for you to answer once ` +
    `${n === 1 ? "its worker" : "each worker"} finishes, with whatever it found. ` +
    `Do NOT start reading files to answer ${n === 1 ? "that question" : "those questions"} now — ` +
    `${n === 1 ? "it is" : "they are"} already being researched. Reach for sparkle_research yourself ` +
    `on the next one and this will not need to happen.`
  );
}
