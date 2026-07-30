// The EVENTS domain — how the concierge finds out what changed without asking about everything.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS, AND WHAT IT HONESTLY IS NOT
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// The PRD calls this "event subscription + wake": a PUSH channel, so the concierge learns about
// status changes, approvals and exits instead of polling for them. The transport cannot push, and
// this module does not pretend it can. The full argument is in stores/conciergeEventLog's header;
// the short version is three facts, any one of which is sufficient on its own:
//
//   1. `apps/mcp-control/src/bridgeClient.ts` opens a fresh Unix socket per call and reads exactly
//      one response line. There is no persistent connection for the app to write onto.
//   2. MCP over stdio here is request/response; the server has no way to wake a caller.
//   3. The caller does not outlive the turn. The concierge brain is one `claude -p` process PER
//      TURN — a notification pushed at 12:03 arrives at a process that exited at 12:01.
//
// So "wake" degrades to what a request/response transport can actually deliver: a DURABLE LOG WITH
// A CURSOR. The app records events as they happen; a turn drains everything since its cursor. That
// is genuinely more than the app had — section D shipped POLLING for approvals, and a poll of
// "what's pending now" structurally cannot report an approval that was requested AND answered
// between two turns. `read_events` can. Whoever wires a persistent transport later should push from
// `recordConciergeEvent`; nothing in this file would have to change.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// TWO PROPERTIES THE OPS EXIST TO GUARANTEE
//
//   • NOTHING DOUBLE-DELIVERED. Events carry a monotonic, never-reused `seq`. A subscription
//     remembers the last one it was shown and only ever moves forward, so draining twice in a row
//     returns the events once and then nothing.
//   • NOTHING SILENTLY DROPPED. The buffer is bounded (it must be — this app runs for days), so
//     events CAN be lost. What must never happen is losing them quietly: because seq numbers are
//     dense, every drain carries `evictedBeforeCursor` — EXACT for an unfiltered read, and an UPPER
//     BOUND for a kind-filtered one, since the evicted events took their kinds with them. Zero is
//     the direction that carries the guarantee: it means the account below is whole. A short list
//     that looks complete is the failure mode this field exists to prevent.
//
// AND THE THIRD, WHICH IS THE SAME PROPERTY ACROSS A RELOAD. The log is module state, so an app
// reload starts a fresh one with `seq` back at 1 — and the recovery path above is exactly a caller
// re-presenting a cursor or an id it remembered from before. Every run therefore names itself
// (`epoch`, returned on every subscribe and drain, and prefixed onto every subscription id), and a
// cursor or id from another run is REFUSED with `log-restarted` rather than answered with an empty
// zero-loss drain that reads as "nothing happened". See `readEvents` for the three guards.
//
// EVERY OP DEFAULTS TO `allow`. Three of the four are pure reads. `subscribe`/`unsubscribe` write
// nothing but a cursor in this process's memory — they are classified `routine` rather than
// `read-only` because they DO mutate module state and calling them read-only would be false, but
// `routine` derives to `allow` too (see policy.ts's DEFAULT_DECISION_BY_RISK), so learning what
// changed never needs the human's permission. Asking a human to approve "may I find out what
// happened" would be the surest way to get the concierge switched off.
import {
  CONCIERGE_EVENT_KINDS,
  CONCIERGE_EVENT_WIRING,
  DEFAULT_DRAIN_LIMIT,
  MAX_RETAINED_EVENTS,
  MAX_SUBSCRIPTIONS,
  closeSubscription,
  drainEvents,
  eventLogEpoch,
  latestEventSeq,
  listSubscriptions,
  openSubscription,
  pendingForSubscription,
  findSubscription,
  readSubscription,
  retainedEventCount,
  subscriptionIdOrigin,
  type ConciergeEvent,
  type ConciergeEventKind,
} from "../../stores/conciergeEventLog";
// The approvals ledger, imported for ONE call. See `settleTimeBasedEvents`.
import { sweepConciergeApprovals } from "../../stores/conciergeApprovals";

// ---------------------------------------------------------------------------------------------
// The operation surface
// ---------------------------------------------------------------------------------------------

export const EVENTS_OPS = [
  "subscribe",
  "read_events",
  "unsubscribe",
  "list_subscriptions",
] as const;

export type EventsOp = (typeof EVENTS_OPS)[number];

/** Two classes, both of which derive to `allow`. See the header for why `subscribe` is not
 *  described as read-only despite changing nothing a human can observe. */
export type EventsRisk = "read-only" | "routine";

export const EVENTS_RISK: Record<EventsOp, EventsRisk> = {
  subscribe: "routine",
  read_events: "read-only",
  unsubscribe: "routine",
  list_subscriptions: "read-only",
};

// ---------------------------------------------------------------------------------------------
// Results — the board/approvals convention
// ---------------------------------------------------------------------------------------------

export interface EventsOk<T> {
  ok: true;
  op: EventsOp;
  risk: EventsRisk;
  data: T;
}

export interface EventsRefusal {
  ok: false;
  op: EventsOp;
  risk: EventsRisk;
  reason: string;
  message: string;
}

export type EventsResult<T> = EventsOk<T> | EventsRefusal;

function ok<T>(op: EventsOp, data: T): EventsOk<T> {
  return { ok: true, op, risk: EVENTS_RISK[op], data };
}

function refuse(op: EventsOp, reason: string, message: string): EventsRefusal {
  return { ok: false, op, risk: EVENTS_RISK[op], reason, message };
}

/** "That subscription is not here", from the ONE place that sentence is written.
 *
 *  `read_events` reaches this from two sites — the pre-drain existence probe, and the nullable return
 *  of `readSubscription` behind it — and the two are supposed to be the same fact. Written out twice
 *  they were free to drift, and a caller reading a slightly different sentence for the same condition
 *  has to work out whether it IS the same condition. The remedy matters as much as the diagnosis: it
 *  names the stateless read, which is the one recovery that works when the id is gone. */
function noSuchSubscription(id: string): EventsRefusal {
  return refuse(
    "read_events",
    "unknown-subscription",
    `I have no subscription “${id}” — it may have been evicted (only ${MAX_SUBSCRIPTIONS} are ` +
      `kept) or closed. Subscribe again, or read with \`since\` and a cursor you already have.`,
  );
}

// ---------------------------------------------------------------------------------------------
// Kind validation
// ---------------------------------------------------------------------------------------------

function isEventKind(v: string): v is ConciergeEventKind {
  return (CONCIERGE_EVENT_KINDS as readonly string[]).includes(v);
}

type NarrowedKinds =
  | { ok: true; kinds: readonly ConciergeEventKind[] }
  | { ok: false; unknown: readonly string[] };

/**
 * Narrow a caller's kind list, REFUSING anything unrecognised rather than dropping it.
 *
 * Dropping is the tempting shortcut and it is the dangerous one: a caller that asks for
 * `["aproval_resolved"]` and is quietly given "no filter" (or "an empty filter") gets a stream that
 * looks plausible and answers a different question. A typo must be a refusal that names the typo.
 *
 * An EMPTY/absent list means "every kind", which is a real request and not the same as a typo.
 */
function narrowKinds(raw: readonly string[] | undefined): NarrowedKinds {
  if (!raw || raw.length === 0) return { ok: true, kinds: [] };
  const unknown = raw.filter((k) => !isEventKind(k));
  if (unknown.length) return { ok: false, unknown };
  return { ok: true, kinds: raw.filter(isEventKind) };
}

function unknownKindMessage(op: EventsOp, unknown: readonly string[]): EventsRefusal {
  return refuse(
    op,
    "unknown-event-kind",
    `I don't record ${unknown.map((k) => `“${k}”`).join(", ")}. The kinds are: ` +
      `${CONCIERGE_EVENT_KINDS.join(", ")}.`,
  );
}

// ---------------------------------------------------------------------------------------------
// The restart refusal
// ---------------------------------------------------------------------------------------------

/**
 * "That cursor / that subscription belongs to a log that no longer exists."
 *
 * ITS OWN REASON, distinct from `unknown-subscription`, because the remedy differs and so does what
 * the caller should believe. An unknown subscription may simply have been evicted while the app kept
 * running and its history is still in the ring; a restart means the whole log is gone and nothing
 * from before it is recoverable at any cursor. A caller told the first when the second is true
 * subscribes again and reasonably assumes it has lost nothing.
 *
 * The remedy it names is a STATELESS read from zero, and that remedy is VALID UNDER THE CONDITION
 * THAT TRIGGERED THE REFUSAL — which is the whole test a remedy string has to pass. `since: 0` is
 * exempt from the epoch guard precisely so that following this sentence literally, stale epoch still
 * attached, works on the first try instead of returning this same refusal (roborev 55441). It also
 * advances no cursor and cannot consume anyone else's subscription.
 */
function logRestarted(op: EventsOp, what: string, held: string): EventsRefusal {
  return refuse(
    op,
    "log-restarted",
    // DROP THE ID, not just the epoch (roborev 55500). This remedy used to say "read with `since: 0`
    // — accepted whether or not you keep the old `epoch` on it", which is true and insufficient: the
    // caller reaching this refusal via a stale SUBSCRIPTION ID would keep that id, send
    // `{ subscriptionId: "<old>-sub-1", since: 0 }`, and hit the identical refusal with no hint that
    // the id was the thing to let go of. That is the non-converging remedy loop 55441 fixed for
    // `epoch`, one parameter over. A remedy has to be safe — and reachable — from the state the
    // refusal leaves the caller in.
    `${what} The app reloaded since then, so the event log started over — this run is “${eventLogEpoch()}” ` +
      `and holds ${held}. Nothing recorded before the reload is recoverable at any cursor. Read with a ` +
      `bare \`since: 0\` — DROP the \`subscriptionId\` as well as the old \`epoch\`, since a stale id is ` +
      `refused on its own — and \`subscribe\` again if you want a cursor that remembers itself.`,
  );
}

// ---------------------------------------------------------------------------------------------
// Settling what the CLOCK changed, before answering
// ---------------------------------------------------------------------------------------------

/**
 * BRING THE LOG UP TO NOW BEFORE READING IT.
 *
 * Every source that feeds this log is event-driven — a status transition, a human's click — with one
 * exception: an approval question that ends because its TTL ran out. Nothing happens at that moment.
 * There is no timer, no poller, and `pendingApprovals` is a pure render-phase read that deliberately
 * writes nothing back, so in the exact case the expiry announcement exists for (the concierge asks,
 * nobody clicks, no further approval traffic) the ledger is never swept and the event is never
 * recorded at all. The reader waits forever, exactly as before (roborev 55441).
 *
 * Draining is the moment that matters, so draining is where the clock is settled. Called before the
 * cursor is computed on every read path, which is what makes the promise the tool description hands
 * the model — "by the time read_events answers, every question that has died is in the log" — a fact
 * rather than a hope. Cheap: a scan of at most 50 ledger entries.
 *
 * A tool call is not a render, so the store write is safe here.
 */
function settleTimeBasedEvents(now: number): void {
  sweepConciergeApprovals(now);
}

function heldNow(): string {
  const retained = retainedEventCount();
  const latest = latestEventSeq();
  return retained === 0
    ? "no events yet"
    : `${retained} event${retained === 1 ? "" : "s"} up to seq ${latest}`;
}

// ---------------------------------------------------------------------------------------------
// The views
// ---------------------------------------------------------------------------------------------

/**
 * What a subscriber is told at the moment it subscribes.
 *
 * `unwiredKinds` is the field that keeps this surface honest. Two of the kinds the PRD names have
 * no source in this build (`pr_checks_concluded`, `build_failed` — see CONCIERGE_EVENT_WIRING), and
 * a subscription to them would simply stay empty forever. Silence is indistinguishable from "it
 * hasn't happened yet", so a model would keep draining and keep concluding, wrongly, that PR checks
 * never conclude. Saying it up front costs one field.
 */
export interface SubscriptionView {
  subscriptionId: string;
  /** Which RUN of the log this belongs to. Hold it beside the cursor: pass it back as `epoch` and a
   *  read against a restarted log is refused (`log-restarted`) instead of answered with an empty,
   *  zero-loss drain that reads as "nothing happened". */
  epoch: string;
  /** The kinds asked for; empty means every kind. */
  kinds: readonly ConciergeEventKind[];
  /** Where this subscription starts. It is `now`, not zero: subscribing declares interest in what
   *  happens NEXT. Read statelessly with `since: 0` to sweep up the retained backlog instead. */
  cursor: number;
  /** Of the kinds subscribed to, the ones nothing in this build emits. Usually empty. */
  unwiredKinds: readonly ConciergeEventKind[];
  /** How many events are held right now, and the ceiling they are held under — so a caller can
   *  reason about how far behind it may fall before losing anything. */
  retained: number;
  ceiling: number;
}

/** One drain, as the concierge sees it. */
export interface EventDrainView {
  events: readonly ConciergeEvent[];
  /** Which RUN of the log produced this. Carry it with the cursor; see {@link SubscriptionView}. */
  epoch: string;
  /** Pass back as `since` for a stateless read; carried automatically by a subscription. */
  cursor: number;
  /** The highest seq this run has recorded. A remembered cursor ABOVE it is impossible within a run,
   *  which is the tell for a restart even from a caller that kept no epoch. */
  latestSeq: number;
  /** How many events OF ANY KIND were evicted before this reader reached them — exact for an
   *  unfiltered read, an UPPER BOUND for a kind-filtered one (see `conciergeEventLog`). Non-zero
   *  means something fell off the end before your cursor, POSSIBLY NONE OF IT YOURS; it is not a
   *  count of what you personally missed. Zero means the account below is the whole story. */
  evictedBeforeCursor: number;
  /** True when `limit` cut the drain short — call again.
   *
   *  HOW depends on the mode, and conflating them is now a refusal rather than a wrong answer
   *  (roborev 55460): re-read a SUBSCRIPTION with the same `subscriptionId`, optionally a new `limit`
   *  (it resumes from its own cursor — passing `since` alongside is `since-with-subscription`), and a
   *  STATELESS read with the returned `cursor` as `since`.
   *
   *  "AND NOTHING ELSE" IS WHAT THIS USED TO SAY, AND IT WAS FALSE (roborev 55500). `limit` is legal
   *  beside a `subscriptionId` and is how a bounded continuation stays bounded — the truncated-drain
   *  test passes exactly that pair. Sitting one clause before the two genuine prohibitions, it read
   *  as a third one, which would have pushed a model draining a large backlog in chunks to drop
   *  `limit` and take the whole remainder into a context window that is its scarcest resource. */
  hasMore: boolean;
  retained: number;
  ceiling: number;
}

/** One live subscription, for the op that lets a fresh turn find its own cursor again. */
export interface SubscriptionSummary {
  subscriptionId: string;
  kinds: readonly ConciergeEventKind[];
  cursor: number;
  /** How many events it would be shown right now — so a turn can skip the drain when it is zero. */
  pending: number;
  createdAt: number;
}

function unwiredAmong(kinds: readonly ConciergeEventKind[]): readonly ConciergeEventKind[] {
  const scope = kinds.length ? kinds : CONCIERGE_EVENT_KINDS;
  return scope.filter((k) => CONCIERGE_EVENT_WIRING[k] === "named");
}

// ---------------------------------------------------------------------------------------------
// The ops
// ---------------------------------------------------------------------------------------------

/**
 * Declare interest in a set of event kinds, and get back a cursor that remembers itself.
 *
 * The subscription starts at NOW. That is the whole difference between this and a stateless read:
 * `subscribe` says "tell me what happens from here", while `read_events({ since: 0 })` says "tell
 * me everything you still hold". Handing back the retained backlog on subscribe would conflate the
 * two and dump history into a turn that asked for none.
 *
 * The ledger is capped ({@link MAX_SUBSCRIPTIONS}) and evicts the OLDEST, so a model that loops on
 * this op loses its stale cursors rather than the app losing its memory.
 */
export function subscribe(
  kinds: readonly string[] | undefined,
  now: number = Date.now(),
): EventsResult<SubscriptionView> {
  const narrowed = narrowKinds(kinds);
  if (!narrowed.ok) return unknownKindMessage("subscribe", narrowed.unknown);
  // SETTLE AFTER THE CURSOR IS TAKEN — WORTH DOING, AND NARROWER THAN IT LOOKS (roborev 55459,
  // scoped by 55526 and 55545). Read this together with the two paired tests in events.test.ts,
  // "cannot report a question that died before it existed" and "hands the lapse to a subscription
  // opened AFTER the question died"; neither states the contract alone.
  //
  // WHAT THIS ORDERING BUYS: when `subscribe` is the FIRST caller to sweep the ledger, the lapse it
  // materialises lands above the new cursor and the first drain hands it over. Settling first swallowed
  // it — the cursor is `latestEventSeq()` at the moment the subscription opens, so a lapse recorded
  // one line earlier is at or below it forever.
  //
  // WHAT IT DOES NOT BUY, and an earlier version of this comment claimed it did: it does not rescue
  // the `list_subscriptions` → nothing → `subscribe` recovery path. There are FIVE sweep sites —
  // `subscribe`, `listEventSubscriptions`, `readEvents`, `requestApproval`, and a human's click — and
  // `listEventSubscriptions` sweeps unconditionally (it must, or `pending` would not count the
  // lapse). Once any of them has materialised the lapse, a subscription opened afterwards starts
  // above it BY DESIGN, because a subscription starts at NOW. That is the module's contract, not a
  // hole in it, and the thing that answers about the past is the stateless `since: 0` read.
  //
  // Delivering a resolution for a request this subscription never saw is the lesser evil where it
  // does happen: the event is stamped `at: expiresAt`, so it reads as "this died 40 minutes ago"
  // rather than claiming to be news, and it is what the stateless path already does.
  const sub = openSubscription(narrowed.kinds, now);
  settleTimeBasedEvents(now);
  return ok("subscribe", {
    subscriptionId: sub.id,
    epoch: eventLogEpoch(),
    kinds: sub.kinds,
    cursor: sub.cursor,
    unwiredKinds: unwiredAmong(sub.kinds),
    retained: retainedEventCount(),
    ceiling: MAX_RETAINED_EVENTS,
  });
}

/**
 * Drain events. TWO MODES, and the second exists because the caller does not survive its own turn.
 *
 *   • WITH a `subscriptionId` — the stateful read. The cursor advances, so the same event is never
 *     handed over twice. This is the mode to use across a conversation.
 *   • WITHOUT one — the stateless read, from `since` (default 0: everything still retained). This
 *     is the recovery path. The concierge brain is a fresh `claude -p` process each turn, so a
 *     subscription id it minted last turn may simply not be in its context any more; a stateless
 *     drain from a remembered cursor gets the same answer without one. `list_subscriptions` is the
 *     other half of that recovery.
 *
 * An unknown `subscriptionId` is REFUSED, not answered with an empty list. "That subscription is
 * gone (it may have been evicted — the ledger holds 16)" and "nothing has happened" are different
 * facts, and a model handed the second when the first is true concludes the app is quiet while it
 * is in fact deaf.
 *
 * THE TWO MODES DO NOT MIX, and each way of mixing them has its own refusal — because accepting one
 * of these arguments and discarding it answers a different question than the caller asked:
 *
 *   • `since` with a `subscriptionId` → `since-with-subscription`. The subscription resumes from
 *     ITS cursor, not the caller's, so honouring neither is safe: draining from the subscription's
 *     cursor and advancing it would strand everything in between.
 *   • `kinds` with a `subscriptionId` → `kinds-with-subscription`. The subscription's own kinds
 *     govern; a second filter would advance the cursor past events never handed over. An EMPTY
 *     `kinds` is not a filter and is allowed.
 *
 * Both are checked AFTER the subscription is known to exist, so a dead id reports what is actually
 * wrong with it rather than a rule about an argument combination — `log-restarted` when it came from
 * another run of the log (the common case, and the more useful sentence), `unknown-subscription`
 * otherwise. The full precedence is spelled out at the top of the `subscriptionId` branch below.
 *
 * AND A CURSOR OR ID FROM A PREVIOUS RUN IS REFUSED TOO (`log-restarted`), for the same reason one
 * step further out. The recovery path above is precisely a caller re-presenting something it
 * remembered, and an app reload resets `seq` to 1 and the subscription numbering with it. Three
 * guards, cheapest first:
 *
 *   • `epoch` mismatches the run that is answering, AND the call claims continuity (a
 *     `subscriptionId`, or a non-zero `since`) → the caller is holding a cursor from a log that no
 *     longer exists. This is the only one that catches a REMEMBERED-LOW cursor (`since: 5` against a
 *     fresh log already at 30, which would otherwise hand back this run's events 6..30 as if they
 *     continued the last run's). `since: 0` is exempt — see {@link logRestarted}.
 *   • `subscriptionId` was minted under another epoch (or by a build with no epoch at all) → it must
 *     not resolve against whatever this run's `sub-1` happens to be, which is the failure that
 *     silently advanced an unrelated subscription's cursor (roborev 55405).
 *   • `since` above this run's `latestSeq` → impossible within a run, since every cursor this module
 *     hands out is a seq it has already issued. The backstop for a caller that kept no epoch.
 */
export function readEvents(
  options: {
    subscriptionId?: string;
    since?: number;
    /** The run the cursor/id came from, as handed back on the drain or subscribe that produced it.
     *  Optional — omitting it only forfeits the first guard above, never fabricates data. */
    epoch?: string;
    kinds?: readonly string[];
    limit?: number;
  } = {},
  now: number = Date.now(),
): EventsResult<EventDrainView> {
  const narrowed = narrowKinds(options.kinds);
  if (!narrowed.ok) return unknownKindMessage("read_events", narrowed.unknown);

  // Bring the log up to NOW before any of the below reads it — including the refusals, whose
  // "here is what this run holds" sentence would otherwise be one sweep out of date.
  settleTimeBasedEvents(now);

  // A READ FROM ZERO IS ALWAYS ACCEPTED, epoch or not, and that exemption is what stops the remedy
  // below from being a loop. `since: 0` asks for "everything you still hold" — it makes no claim of
  // continuity with a previous run, cannot be misread as one, and advances no cursor, so there is
  // nothing here for the epoch guard to protect. Without the exemption, a caller that did what the
  // MCP description tells it to (carry the epoch beside `since`) would send `{since: 0, epoch:
  // <stale>}`, get this refusal, follow its "read with since: 0" remedy verbatim, and get the exact
  // same refusal again with no hint that the epoch was the thing to drop (roborev 55441).
  const claimsContinuity = options.subscriptionId !== undefined || (options.since ?? 0) > 0;
  if (claimsContinuity && options.epoch !== undefined && options.epoch !== eventLogEpoch()) {
    return logRestarted(
      "read_events",
      `That cursor is from log run “${options.epoch}”.`,
      heldNow(),
    );
  }

  const frame = {
    epoch: eventLogEpoch(),
    latestSeq: latestEventSeq(),
    retained: retainedEventCount(),
    ceiling: MAX_RETAINED_EVENTS,
  };

  if (options.subscriptionId !== undefined) {
    // ORDER IS THE SUBSTANCE HERE, most specific diagnosis first (roborev 55460 + 55405).
    // `log-restarted` before `unknown-subscription` because an id minted under another epoch IS
    // absent from this run's ledger — reporting it as merely "unknown" would be true and useless,
    // when the caller needs to know the log restarted under it. Then existence, because both
    // argument rules below are about a subscription the caller HAS: checking them first masked
    // `unknown-subscription` for the exact scenario the `since` refusal was written for — a fresh
    // turn recovering `{ subscriptionId, cursor }` from last turn's context, whose subscription has
    // since been evicted — and handed it a remedy ("read the subscription as it is") for a
    // subscription that is not there.
    if (subscriptionIdOrigin(options.subscriptionId) === "other-run") {
      return logRestarted(
        "read_events",
        `Subscription “${options.subscriptionId}” was opened by an earlier run of the log.`,
        heldNow(),
      );
    }
    // `findSubscription`, NOT `readSubscription` — the latter ADVANCES the cursor, so using it as a
    // probe would consume the very events the caller is about to be refused.
    if (!findSubscription(options.subscriptionId)) return noSuchSubscription(options.subscriptionId);
    // `since` IS THE SAME BUG AS `kinds` (roborev 55444). Accepting an argument and discarding it
    // answers a different question than the caller asked, and `since` was being accepted and
    // discarded on this exact branch. It is MORE likely to be sent than `kinds`, not less:
    // `list_subscriptions` hands back each subscription's `cursor` and the description calls that
    // how you recover one, so `read_events({ subscriptionId, since: 40 })` is a natural thing to
    // write. It would have drained from the subscription's CURRENT cursor and then advanced it,
    // making everything in between unrecoverable through that subscription and reporting it as
    // "nothing happened since 40".
    if (options.since !== undefined) {
      return refuse(
        "read_events",
        "since-with-subscription",
        // THE STATELESS FORM LEADS, and that ordering is the point (roborev 55460). "Read the
        // subscription as it is" is NOT safe under the condition that triggers this: a caller with
        // `since: 40` against a subscription whose cursor is 120 would get 121→head, advance the
        // cursor, and still be missing 41–120 — the same silent wrong answer one turn later. A
        // remedy has to be safe under the circumstances that produced the refusal.
        `A subscription carries its own cursor, so \`since\` cannot be applied on top of ` +
          `\`subscriptionId\`. To read from YOUR cursor, drop the \`subscriptionId\` and use the ` +
          `stateless form (\`since\` on its own, optionally with \`kinds\`) — a subscription resumes ` +
          `from ITS cursor, not from yours, so reading it bare would skip everything in between.`,
      );
    }
    // REFUSED, not ignored. The subscription's own kinds govern — applying a second filter would
    // skip events the subscription's cursor then moved past, losing them for good. But ACCEPTING
    // the argument and discarding it is the other half of that same bug: a caller that asked for
    // `["approval_resolved"]` against a subscription on `["agent_status"]` gets status rows, has
    // its cursor advanced past everything, and concludes no approval happened. That is the exact
    // "answers a different question" failure `unknown-subscription` is refused for, so it gets the
    // same treatment rather than a silent one (roborev 55410).
    // NON-EMPTY, not merely present (roborev 55426). `narrowKinds` documents an EMPTY list as
    // meaning "every kind, which is a real request and not the same as a typo", and `drainEvents`
    // treats it as no filter at all — so `kinds: []` cannot cause the answers-a-different-question
    // failure this refusal exists to prevent, and refusing it fails a legal read with a message
    // that does not describe what the caller did. A model filling an optional array field with `[]`
    // is a common shape, and `readEventsArgs` accepts it.
    if (narrowed.kinds.length > 0) {
      return refuse(
        "read_events",
        "kinds-with-subscription",
        `A subscription already carries its own kinds, so \`kinds\` cannot be applied on top of ` +
          `\`subscriptionId\` — filtering here would advance the cursor past events you never saw. ` +
          `Read the subscription as it is, or use the stateless form (\`since\` + \`kinds\`), or ` +
          `subscribe again with the kinds you want.`,
      );
    }
    const drained = readSubscription(options.subscriptionId, options.limit);
    // UNREACHABLE as the code stands: `findSubscription` above proved this id resolves, and nothing
    // between the two touches the ledger. Kept because `readSubscription` is typed nullable, and if
    // it ever does fire the honest answer is still that the id is gone — same sentence, one source.
    if (!drained) return noSuchSubscription(options.subscriptionId);
    return ok("read_events", { ...drained, ...frame });
  }

  const since = options.since ?? 0;
  if (since > latestEventSeq()) {
    return logRestarted(
      "read_events",
      `Cursor ${since} is ahead of everything this log has ever recorded, so it cannot have come from it.`,
      heldNow(),
    );
  }

  const drain = drainEvents({ since, kinds: narrowed.kinds, limit: options.limit });
  return ok("read_events", { ...drain, ...frame });
}

/**
 * Close a subscription.
 *
 * An id that is not here is a refusal rather than a cheerful success, for the same reason
 * `read_events` refuses one: "I closed it" and "it was already gone" are different, and a caller
 * told the first when the second is true believes it has tidied up something that expired
 * underneath it. An id from a previous run gets the restart refusal instead — there is nothing here
 * to close, and saying "already closed or evicted" would misdescribe why.
 */
export function unsubscribe(subscriptionId: string): EventsResult<{ subscriptionId: string }> {
  if (subscriptionIdOrigin(subscriptionId) === "other-run") {
    return logRestarted(
      "unsubscribe",
      `Subscription “${subscriptionId}” was opened by an earlier run of the log, so it is already gone.`,
      heldNow(),
    );
  }
  if (!closeSubscription(subscriptionId)) {
    return refuse(
      "unsubscribe",
      "unknown-subscription",
      `There is no subscription “${subscriptionId}” to close — it may already have been closed or ` +
        `evicted.`,
    );
  }
  return ok("unsubscribe", { subscriptionId });
}

/**
 * Every live subscription, with how much each has waiting.
 *
 * THE RECOVERY OP. A turn that does not remember the id it minted last turn can find it here rather
 * than opening a second subscription and re-reading everything the first already consumed. `pending`
 * lets it skip the drain entirely when there is nothing to drain — one cheap call instead of one
 * cheap call plus a wasted one.
 */
export function listEventSubscriptions(now: number = Date.now()): EventsResult<{
  subscriptions: readonly SubscriptionSummary[];
  /** The run these ids belong to. An id you remember that does not start with this is from before a
   *  reload and will be refused rather than resolved against one of the ids below. */
  epoch: string;
  latestSeq: number;
  retained: number;
  ceiling: number;
  defaultLimit: number;
}> {
  // `pending` is what a turn uses to decide whether draining is worth a call, so a question that
  // died of old age has to be counted here too — otherwise this op reports `pending: 0`, the turn
  // skips the drain, and the lapse goes unread for exactly as long as the app stays quiet.
  settleTimeBasedEvents(now);
  return ok("list_subscriptions", {
    epoch: eventLogEpoch(),
    subscriptions: listSubscriptions().map((s) => ({
      subscriptionId: s.id,
      kinds: s.kinds,
      cursor: s.cursor,
      pending: pendingForSubscription(s),
      createdAt: s.createdAt,
    })),
    latestSeq: latestEventSeq(),
    retained: retainedEventCount(),
    ceiling: MAX_RETAINED_EVENTS,
    defaultLimit: DEFAULT_DRAIN_LIMIT,
  });
}
