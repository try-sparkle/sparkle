// THE EVENT LOG the concierge reads instead of re-asking the app what changed.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THIS IS A LOG WITH A CURSOR, NOT A PUSH CHANNEL — AND THAT IS A TRANSPORT FACT, NOT A CHOICE.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// The PRD asks for a push channel so the concierge "learns about" changes without polling. The
// transport cannot do it, and pretending otherwise would be the expensive kind of lie. Concretely:
//
//   • apps/mcp-control/src/bridgeClient.ts opens a FRESH Unix-socket connection per call, writes one
//     request line, reads one response line, and destroys the socket. The Rust bridge's serve_conn
//     writes exactly one response per request. There is no long-lived socket for the app to write an
//     unsolicited frame onto.
//   • MCP itself is request/response over stdio here; the server has no channel to wake a caller.
//   • And the caller does not persist anyway. The concierge brain is one `claude -p` process PER
//     TURN. There is no process sitting between turns for a push to arrive at — a notification
//     delivered at 12:03 would land on a process that exited at 12:01.
//
// So "wake" degrades, honestly, to a DURABLE LOG THE CONCIERGE CAN DRAIN WITH A CURSOR. The app
// records what happened as it happens; a turn drains everything since its last cursor and learns
// about changes it never observed — including ones that occurred while no concierge process
// existed at all. That is the real half of the feature, and it is strictly more than the app had:
// section D shipped POLLING for approvals (ask the ledger what is pending NOW), which cannot tell
// you that an approval was requested AND resolved between two turns. This can.
//
// If a persistent transport ever lands (a duplex socket the app can write to, or a resident
// concierge process), this module is the right thing to push FROM — `recordConciergeEvent` is the
// single choke point and would gain a listener list. Nothing above it would change.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// FOUR PROPERTIES, in the order they matter:
//
// 1. THE CURSOR IS MONOTONIC AND NEVER REUSED — WITHIN A RUN, WHICH IS WHY THE RUN IS NAMED. `seq`
//    starts at 1 and only ever increases, for the life of the app run. It is what makes "nothing
//    double-delivered" mean something: a read returns events with `seq > cursor` and moves the
//    cursor past them, so the same event cannot come back.
//
//    But this is plain module state, so an app reload starts a FRESH log with `seq` back at 1 — and
//    the concierge brain, being one process per turn, is exactly the kind of caller that carries a
//    cursor across that boundary. A remembered `since: 400` read against a restarted log would come
//    back `events: []`, `evictedBeforeCursor: 0` — "nothing happened", which is the precise lie this
//    module exists to prevent. A stale `sub-1` was worse: it resolved SUCCESSFULLY against a brand
//    new, unrelated subscription and advanced someone else's cursor.
//
//    So every run mints an EPOCH ({@link eventLogEpoch}) and stamps it on everything it hands out:
//    it is returned on every drain and subscribe, and it prefixes every subscription id
//    (`k3f9a1-sub-1`). A cursor or an id minted under a different epoch is REFUSED with its own
//    reason (`log-restarted`) rather than answered, because "the log you were reading no longer
//    exists" and "nothing has happened" are different facts and only one of them is true.


//
// 2. NOTHING IS SILENTLY DROPPED. The buffer is bounded (property 3), so events CAN be lost — the
//    point is that a reader is TOLD. Because seq numbers are dense and never reused, a reader whose
//    cursor is older than the oldest retained event is handed a count of what fell off before it
//    got there (`evictedBeforeCursor`). "I missed 12 status changes" is actionable; a short list
//    that looks complete is not.
//
//    That count is EXACT for an unfiltered reader and an UPPER BOUND for a kind-filtered one, which
//    is why the field is named for evictions rather than for the reader's own loss. Evicted events
//    are gone, kinds included, so a per-kind figure would need a permanent record of everything ever
//    dropped. The guarantee that matters survives either way: ZERO still means "this is the whole
//    story", and that is the direction a reader acts on (roborev 55410).
//
// 3. BOUNDED BY CONSTRUCTION. A ring of {@link MAX_RETAINED_EVENTS}, evicting oldest-first. This app
//    runs for days and a flapping agent can emit hundreds of transitions an hour; an unbounded array
//    is a memory leak with a countdown on it. The subscription ledger is capped too
//    ({@link MAX_SUBSCRIPTIONS}) — a model that loops on `subscribe` must not be able to grow it
//    without limit either.
//
// 4. NO USER DATA. Same rule as engine/statusTransitionLog, and for the same reason: these records
//    are handed to a model and may be quoted back. Events carry ids, statuses, triggers and
//    conclusions — never terminal content, never prompt text, never argument values.
//
// STORE-FREE AND DOM-FREE. Plain module state, no zustand: the writers are a logging module and a
// store, both of which are imported from hot paths, and nothing renders this. Consumers are the
// events tool domain (services/conciergeTools/events.ts) and tests.

/**
 * The kinds the PRD names. ALL SEVEN ARE LISTED; not all seven are WIRED — see
 * {@link CONCIERGE_EVENT_WIRING}, which is the honest account of which sources exist today.
 * Listing an unwired kind is deliberate: it is the vocabulary a reader subscribes to, and a kind
 * that silently did not exist would read to a model as "this never happens".
 */
export const CONCIERGE_EVENT_KINDS = [
  "agent_status",
  "agent_spawned",
  "agent_exited",
  "approval_requested",
  "approval_resolved",
  "research_completed",
  "pr_checks_concluded",
  "build_failed",
  "screen_unrecognized",
] as const;

export type ConciergeEventKind = (typeof CONCIERGE_EVENT_KINDS)[number];

/**
 * WHETHER A KIND HAS A SOURCE IN THIS BUILD — stated in the code, not just in a doc.
 *
 * `wired` means something in this app calls `recordConciergeEvent` for it today. `named` means the
 * PRD asks for it, the vocabulary carries it, and NOTHING emits it yet. The distinction is exported
 * so the tool surface can tell a subscriber the truth up front ("you subscribed to build_failed;
 * nothing emits it in this build") instead of leaving it to infer capability from silence, which is
 * indistinguishable from "it hasn't happened".
 */
export const CONCIERGE_EVENT_WIRING: Record<ConciergeEventKind, "wired" | "named"> = {
  // engine/statusTransitionLog.ts — the single choke point every StatusEngine transition funnels
  // through. Its own doc comment states that a path added later cannot escape it, which is exactly
  // the property that makes it a trustworthy event source.
  agent_status: "wired",
  agent_spawned: "wired",
  agent_exited: "wired",
  // stores/conciergeApprovals.ts — minted on a genuinely NEW request, and on every way the question
  // ends: the human's yes, their no, and the TTL lapsing it unanswered (`outcome: "expired"`).
  approval_requested: "wired",
  approval_resolved: "wired",
  // services/research/drain.ts — the turn-start drain observes the research task list and records
  // one event per task the FIRST time it is seen in a terminal state. It is the emitter because it
  // is the one thing that reads the whole list on a schedule tied to turns; the sidebar row renders
  // the same list but is a view, and a view that emitted would emit again on every re-render.
  //
  // IT IS A SECOND ACCOUNT, NOT THE ONLY ONE — and it used to be the only one. `isUnread` is
  // `done`-only, so a `failed` or `cancelled` task reached no prompt at all; that is what this
  // existed for. It is no longer true: those tasks now get their own preamble section
  // (`research/drain.buildResearchFailurePreamble`), because THIS log does not survive an app
  // reload — it is plain module state, per the header — so it could never have been the durable
  // channel a failure needs.
  //
  // Still recorded, and `done` with it, so the stream is a complete account of how each task ended,
  // replayable from a cursor, where the preamble is a one-shot claimed on delivery and then gone.
  research_completed: "wired",
  // NAMED, NOT WIRED. `pr_checks_status` (services/conciergeTools/workflow.ts) is an ON-DEMAND read
  // the concierge performs itself; there is no background poller watching PR checks, so there is no
  // moment at which the app learns a conclusion the concierge did not already ask for. Emitting from
  // that read would be circular — an "event" reporting the answer to the question just asked.
  pr_checks_concluded: "named",
  // NAMED, NOT WIRED. There is no build-failure signal in the desktop app to attach to: a failing
  // build surfaces as an agent's status going `errored`, which is already carried by `agent_status`.
  // A separate kind that nothing distinguishes would be a second, worse spelling of that.
  build_failed: "named",
  // engine/screenReadability, via the concierge feed's per-tick readability check. Edge-triggered
  // per agent (see `noteScreenReadability`) — a permanently unreadable pane must not mint an event
  // on every tick, which would evict everything else from the ring.
  screen_unrecognized: "wired",
};

/** Every kind something actually emits today. */
export const WIRED_EVENT_KINDS: readonly ConciergeEventKind[] = CONCIERGE_EVENT_KINDS.filter(
  (k) => CONCIERGE_EVENT_WIRING[k] === "wired",
);

// ---------------------------------------------------------------------------------------------
// The event shapes
// ---------------------------------------------------------------------------------------------

/** An agent moved between statuses. `from`/`to`/`trigger` are the state machine's own vocabulary
 *  (see engine/statusTransitionLog) — verdicts, never the screen text behind them. */
export interface AgentStatusEvent {
  kind: "agent_status";
  agentId: string;
  from: string;
  to: string;
  trigger: string;
}

/** A status engine was constructed for this agent — i.e. its terminal session started. */
export interface AgentSpawnedEvent {
  kind: "agent_spawned";
  agentId: string;
  status: string;
}

/** The agent's PTY exited. `status` is what it settled on (`done` / `errored`). */
export interface AgentExitedEvent {
  kind: "agent_exited";
  agentId: string;
  status: string;
}

/** A NEW approval question reached the human's column. Not emitted for the idempotent re-ask of a
 *  question already on screen — see stores/conciergeApprovals. */
export interface ApprovalRequestedEvent {
  kind: "approval_requested";
  approvalId: string;
  domain: string;
  op: string;
}

/**
 * THE QUESTION IS OVER. This is the one that section D's polling could miss entirely: an approval
 * requested and resolved between two turns leaves `pendingApprovals` looking exactly as it did.
 *
 * `outcome` carries THREE endings, not two, and the third is the one a reader must not have to infer
 * from silence. `expired` means nobody answered inside {@link
 * import("./conciergeApprovals").APPROVAL_REQUEST_TTL_MS} and the ledger lapsed the question. A
 * subscriber that drained `approval_requested` and is waiting for the matching resolution otherwise
 * waits forever on a card that is already dead — the stream reads as still-open while the app has
 * moved on (roborev 55405).
 *
 * It is carried on THIS kind rather than a separate `approval_expired` deliberately: a reader
 * subscribed to the request/resolve pair would not be subscribed to a kind that did not exist when
 * it subscribed, so a new kind would reproduce exactly the silence it was meant to remove.
 */
export interface ApprovalResolvedEvent {
  kind: "approval_resolved";
  approvalId: string;
  domain: string;
  op: string;
  outcome: "approved" | "denied" | "expired";
}

/**
 * A RESEARCH TASK REACHED A TERMINAL STATE — `done`, `failed` or `cancelled` (bead `sparkle-s7rfc`).
 *
 * `status` rather than a boolean, and all three terminal states rather than just failure, because
 * `services/research/types` made them three deliberately: "the shell came back non-zero", "the human
 * killed it" and "it ran out of wall clock" are different facts to a concierge deciding whether to
 * re-ask, and a reader that had to infer cancellation from silence would re-dispatch work the
 * founder just stopped.
 *
 * NO QUESTION TEXT AND NO FINDINGS — property 4. The findings travel in the turn-start prompt
 * preamble (`services/research/drain`), which is the surface meant to carry them; this stream is
 * ids, statuses and outcomes, like every other kind here.
 */
export interface ResearchCompletedEvent {
  kind: "research_completed";
  taskId: string;
  /** The project the task was asked about; `null` when the dispatch resolved none — a real state,
   *  see `ResearchTask.projectId`. */
  projectId: string | null;
  /** One of the terminal `ResearchStatus` values. Typed as a string here so this store keeps no
   *  import edge into the research contract — the emitter is what holds both. */
  status: string;
}

/** NAMED, NOT WIRED — see {@link CONCIERGE_EVENT_WIRING}. The shape is declared so a future source
 *  has one to fill rather than inventing a second one. */
export interface PrChecksConcludedEvent {
  kind: "pr_checks_concluded";
  projectId: string;
  number: number;
  conclusion: string;
}

/** NAMED, NOT WIRED — see {@link CONCIERGE_EVENT_WIRING}. */
export interface BuildFailedEvent {
  kind: "build_failed";
  agentId: string | null;
  /** A short, already-sanitised reason. NEVER raw output. */
  detail: string;
}

/**
 * THE DETECTOR FAILED TO RECOGNISE A LIVE AGENT'S SCREEN — the regression alarm for lexical rot.
 *
 * ══ WHY THIS KIND EXISTS ════════════════════════════════════════════════════════════════════════
 * `engine/claudeCodeScreen` recognises Claude Code by markers that Claude Code can change without
 * telling anyone. When they rot, EVERY consequence is fail-CLOSED: the write guard refuses, the
 * picker cannot be read, and the row still shows "Needs you" over a pane with nothing in it. It
 * rotted exactly that way at 2.1.237 — three of five permission modes went unrecognised — and
 * nothing anywhere said so. It surfaced only because the founder lost a night to it.
 *
 * So the failure has to ANNOUNCE ITSELF. This is that announcement.
 *
 * ══ NO SCREEN TEXT — PROPERTY 4 IS NOT WAIVED FOR DIAGNOSTICS ═══════════════════════════════════
 * The obvious payload is the unrecognised screen, and it is exactly what this log forbids: these
 * records are handed to a model and may be quoted back, and a terminal screen is user data. What
 * travels instead is the DETECTOR'S OWN VERDICT — how many independent marker families the screen
 * scored, and whether it had a composer box. That is not a lesser substitute; it IS the diagnosis.
 * The 2.1.237 rot reads as `families: 1, composerBox: true` — "this is a live Claude Code TUI whose
 * chrome we no longer recognise" — which names the family to re-capture. Confirming it is then a
 * `capturedScreens.fixture.ts` capture, which is where screen text is allowed to live.
 */
export interface ScreenUnrecognizedEvent {
  kind: "screen_unrecognized";
  agentId: string;
  /** How many independent marker families the screen scored (`claudeCodeMarkerFamilies`). */
  families: number;
  /** Whether the live-TUI composer box was present. `true` with a low family count is the signature
   *  of lexical rot specifically, as opposed to a genuine `vim`/`less`, which scores neither. */
  composerBox: boolean;
}

/** The payload union, discriminated on `kind`. */
export type ConciergeEventPayload =
  | AgentStatusEvent
  | AgentSpawnedEvent
  | AgentExitedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ResearchCompletedEvent
  | PrChecksConcludedEvent
  | BuildFailedEvent
  | ScreenUnrecognizedEvent;

/** One recorded event: the payload plus the envelope that makes it drainable. */
export type ConciergeEvent = ConciergeEventPayload & {
  /** Monotonic, dense, never reused. THE cursor. */
  seq: number;
  /** Wall-clock, for the concierge to say "eleven minutes ago". Not used for ordering — `seq` is. */
  at: number;
};

// ---------------------------------------------------------------------------------------------
// The ring
// ---------------------------------------------------------------------------------------------

/**
 * How many events are retained.
 *
 * 500 is chosen against the loudest real source: a flapping agent produces status transitions in
 * the tens per minute, and the concierge is expected to drain within a turn or two. 500 covers a
 * long, noisy gap while costing a few tens of KB. It is a CEILING that is reported to readers
 * (`ceiling` on every read), not a secret — a reader that keeps seeing `evictedBeforeCursor > 0`
 * knows to drain more often rather than guessing why its history has holes.
 */
export const MAX_RETAINED_EVENTS = 500;

/** How many live subscriptions may exist. See property 3 — the ledger is bounded for the same
 *  reason the ring is. Oldest is evicted, because the newest cursor is the one being used. */
export const MAX_SUBSCRIPTIONS = 16;

// ---------------------------------------------------------------------------------------------
// The epoch — the name of THIS run of the log
// ---------------------------------------------------------------------------------------------

/**
 * How many epochs this process has minted. Mixed into the token purely so two epochs minted in the
 * SAME MILLISECOND cannot collide — which is not a hypothetical: the test reset mints one per case.
 * It contributes nothing across processes (it restarts at 0 with the module), which is what the
 * clock and the random component are for.
 */
let epochsMinted = 0;

/**
 * A short token naming this run. Short because it prefixes every subscription id and a model has to
 * quote those back; unique enough because the only thing it must distinguish is "the log I was
 * reading" from "the log I am reading now" — three base-36 digits of clock and two of randomness
 * make two consecutive runs colliding a ~1-in-46,000 event even if they start in the same
 * millisecond, and the counter makes it impossible within one process.
 *
 * NOT a secret and NOT a security boundary, exactly like the subscription ids it stamps: knowing an
 * epoch grants nothing. It is a mismatch detector.
 */
function mintEpoch(): string {
  epochsMinted += 1;
  const clock = (Date.now() % 46_656).toString(36).padStart(3, "0");
  const noise = Math.floor(Math.random() * 1_296)
    .toString(36)
    .padStart(2, "0");
  return `${clock}${noise}${epochsMinted.toString(36)}`;
}

let epoch = mintEpoch();

/** The token naming this run of the log. Returned on every drain and subscribe so a caller can hold
 *  it alongside a cursor and be told, rather than guess, when the log underneath it restarted. */
export function eventLogEpoch(): string {
  return epoch;
}

/** Where a subscription id came from. `not-an-id` is a string that was never a subscription id at
 *  all (a hallucinated one, say); `other-run` is one that WAS, minted by a log this process is not
 *  running any more — including the un-prefixed `sub-N` shape a build before the epoch handed out. */
export type SubscriptionIdOrigin = "current" | "other-run" | "not-an-id";

const SUBSCRIPTION_ID = /^(?:([0-9a-z]+)-)?sub-([0-9]+)$/;

export function subscriptionIdOrigin(id: string): SubscriptionIdOrigin {
  const match = SUBSCRIPTION_ID.exec(id.trim());
  if (!match) return "not-an-id";
  return match[1] === epoch ? "current" : "other-run";
}

/** Oldest first. Length never exceeds {@link MAX_RETAINED_EVENTS}. */
let ring: ConciergeEvent[] = [];

/** The seq the NEXT event will take. Starts at 1, so `cursor: 0` legitimately means "I have seen
 *  nothing" and can never collide with a real event's seq. */
let nextSeq = 1;

/** The highest seq recorded so far — `nextSeq - 1`. Exported as a function so a subscription can
 *  start at "now" without reaching into the ring. */
export function latestEventSeq(): number {
  return nextSeq - 1;
}

/** How many events are retained right now. */
export function retainedEventCount(): number {
  return ring.length;
}

/** The oldest seq still retained, or `latestEventSeq()` when the ring is empty (nothing is missing
 *  from an empty log — there is simply nothing in it). */
export function oldestRetainedSeq(): number {
  return ring[0]?.seq ?? nextSeq;
}

/**
 * Record one event. THE choke point — every kind, every source, one function.
 *
 * Returns the stored event (with its envelope) so a caller can assert on the seq it was given.
 * Best-effort by construction: it cannot throw on any input it accepts, because its callers are a
 * logging module invoked from a state machine's constructor and a store mutator. An event log that
 * can take down the state machine it observes is worse than no event log.
 */
export function recordConciergeEvent(payload: ConciergeEventPayload, at: number = Date.now()): ConciergeEvent {
  const event = { ...payload, seq: nextSeq, at } as ConciergeEvent;
  nextSeq += 1;
  ring.push(event);
  // Evict oldest-first. A `while` rather than an `if` so a lowered ceiling (or a future batch write)
  // still converges instead of leaving the ring permanently one over.
  while (ring.length > MAX_RETAINED_EVENTS) ring.shift();
  return event;
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

export interface EventDrain {
  /** The matching events, oldest first. */
  events: readonly ConciergeEvent[];
  /** Where to resume. Pass this back as `since` (or let the subscription carry it). */
  cursor: number;
  /**
   * How many events OF ANY KIND were evicted from the ring before this reader could see them.
   *
   * Exact for an unfiltered read, because seq numbers are dense. For a KIND-FILTERED read it is an
   * UPPER BOUND, and that is deliberate: the evicted events are gone, so their kinds are gone with
   * them, and an exact per-kind figure would mean retaining a per-kind record of everything ever
   * dropped — unbounded bookkeeping to refine a number whose only job is "you have a hole".
   *
   * The name says `evicted` rather than `dropped` for that reason (roborev 55410): a subscription
   * on `approval_resolved` sitting behind a flapping agent must not read a count of evicted
   * `agent_status` rows as "I lost 7 approvals". Non-zero means "something fell off the end before
   * you got here, possibly none of it yours"; zero — the normal case — still means "this is the
   * whole story", which is the direction that carries the guarantee.
   */
  evictedBeforeCursor: number;
  /** True when `limit` cut the drain short. The cursor stops at the last delivered event, so the
   *  next read continues rather than skipping. */
  hasMore: boolean;
}

/** Default page size for one drain. Small enough not to flood a turn's context, large enough that a
 *  quiet gap is a single call. */
export const DEFAULT_DRAIN_LIMIT = 100;

/**
 * Drain events after `since`, optionally narrowed to `kinds`.
 *
 * THE CURSOR ADVANCES PAST EVENTS THAT DID NOT MATCH, and that is deliberate. A reader subscribed
 * only to `approval_resolved` should not re-scan four hundred status transitions on every call, and
 * it cannot miss anything by skipping them — it asked not to be told. The cursor therefore lands on
 * the log HEAD when the drain completed, and on the last DELIVERED event when `limit` cut it short.
 *
 * Pure: it reads and computes, and writes nothing back. Subscription bookkeeping is the caller's
 * (see {@link readSubscription}), so a stateless read cannot disturb a stateful one.
 */
export function drainEvents(options: {
  since: number;
  kinds?: readonly ConciergeEventKind[];
  limit?: number;
}): EventDrain {
  const since = Number.isFinite(options.since) ? Math.max(0, Math.floor(options.since)) : 0;
  const limit = Math.max(1, Math.min(MAX_RETAINED_EVENTS, Math.floor(options.limit ?? DEFAULT_DRAIN_LIMIT)));
  const kinds = options.kinds && options.kinds.length ? new Set(options.kinds) : null;

  // Everything the reader has not seen that is still retained.
  const unseen = ring.filter((e) => e.seq > since);
  // What it fell behind by: the gap between where it was and the oldest thing still held. Computed
  // from the RETAINED floor rather than from a counter, so it stays exact across any eviction order.
  const evictedBeforeCursor = ring.length ? Math.max(0, oldestRetainedSeq() - since - 1) : 0;

  const matching = kinds ? unseen.filter((e) => kinds.has(e.kind)) : unseen;
  const events = matching.slice(0, limit);
  const hasMore = matching.length > events.length;

  // Truncated → stop exactly where delivery stopped. Complete → skip past the non-matching tail too.
  const cursor = hasMore
    ? (events[events.length - 1]?.seq ?? since)
    : Math.max(since, latestEventSeq());

  return { events, cursor, evictedBeforeCursor, hasMore };
}

// ---------------------------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------------------------

export interface ConciergeEventSubscription {
  id: string;
  kinds: readonly ConciergeEventKind[];
  /** The seq of the last event this subscription has been shown. */
  cursor: number;
  createdAt: number;
}

const subscriptions = new Map<string, ConciergeEventSubscription>();

/** Ids are sequential and human-readable (`k3f9a1-sub-1`) rather than random. Nothing here is a
 *  security boundary — a subscription grants no authority, it only remembers a cursor — and a model
 *  that has to quote the id back gets it right more often when it is short. The epoch prefix is what
 *  keeps a stale id from a previous run from resolving against an unrelated new subscription that
 *  happens to have landed on the same number; see property 1. */
let nextSubscriptionId = 1;

/**
 * Open a subscription STARTING AT NOW.
 *
 * From-now rather than from-the-beginning: subscribing is a declaration of interest in what happens
 * NEXT, and handing back the whole retained ring on `subscribe` would make the first drain a dump of
 * history the caller did not ask for. A caller that genuinely wants the backlog reads statelessly
 * with `since: 0`, which is a different, explicit request.
 */
export function openSubscription(
  kinds: readonly ConciergeEventKind[],
  at: number = Date.now(),
): ConciergeEventSubscription {
  const sub: ConciergeEventSubscription = {
    id: `${epoch}-sub-${nextSubscriptionId}`,
    kinds: [...kinds],
    cursor: latestEventSeq(),
    createdAt: at,
  };
  nextSubscriptionId += 1;
  subscriptions.set(sub.id, sub);
  // Bounded like the ring. Insertion order is creation order, so the first key is the oldest.
  while (subscriptions.size > MAX_SUBSCRIPTIONS) {
    const oldest = subscriptions.keys().next();
    if (oldest.done) break;
    subscriptions.delete(oldest.value);
  }
  return { ...sub };
}

export function findSubscription(id: string): ConciergeEventSubscription | undefined {
  const found = subscriptions.get(id);
  return found ? { ...found } : undefined;
}

/** Every live subscription, oldest first. Copies, so a caller cannot move a cursor by assignment. */
export function listSubscriptions(): readonly ConciergeEventSubscription[] {
  return [...subscriptions.values()].map((s) => ({ ...s }));
}

/** Drop one. `false` for an id that is not (or is no longer) here — which a caller must report as
 *  its own outcome, since "already gone" and "removed it" are different facts. */
export function closeSubscription(id: string): boolean {
  return subscriptions.delete(id);
}

/**
 * Drain through a subscription AND ADVANCE ITS CURSOR — the stateful read.
 *
 * The advance is the whole point and is what makes double-delivery impossible: two identical calls
 * with no intervening event return the same events exactly once, and then nothing. Returns null for
 * an unknown id so the caller can say "that subscription is gone" rather than "no events", which a
 * model would read as "nothing happened".
 */
export function readSubscription(id: string, limit?: number): EventDrain | null {
  const sub = subscriptions.get(id);
  if (!sub) return null;
  const drain = drainEvents({ since: sub.cursor, kinds: sub.kinds, limit });
  sub.cursor = drain.cursor;
  return drain;
}

/** How many events a subscription would be shown right now, without showing them. Lets
 *  `list_subscriptions` say "3 waiting" so a turn knows whether draining is worth a call. */
export function pendingForSubscription(sub: ConciergeEventSubscription): number {
  const kinds = sub.kinds.length ? new Set(sub.kinds) : null;
  return ring.filter((e) => e.seq > sub.cursor && (!kinds || kinds.has(e.kind))).length;
}

/**
 * Test-only: empty the ring, the ledger and both counters, so cases cannot see each other's events.
 * Named with the leading underscore this codebase uses for the same purpose elsewhere.
 *
 * MINTS A FRESH EPOCH, because this IS a restart — it resets exactly the state a module re-init
 * resets. That is not incidental: it is what lets a test hold an id or a cursor from "before the
 * reload" and assert the refusal, which is the only way to cover property 1 without reloading a
 * module.
 */
export function _resetConciergeEventLogForTests(): void {
  clearConciergeEventLog();
}

/**
 * Drop the log — the IDENTITY reset, and the production caller the reset above never had.
 *
 * This log is the third per-human concierge store, and it was missed when the other two were wired
 * to sign-out (roborev 55593). It holds `approval_requested` / `approval_resolved` rows carrying
 * `domain`, `op` and `outcome`, which together are an index of what the previous human was asked and
 * whether they said yes — plus `agent_spawned` / `agent_exited` / `agent_status` history, up to
 * {@link MAX_RETAINED_EVENTS} for the process lifetime. And it already has the reader that makes
 * residue reachable rather than merely present: the concierge drains it over `sparkle_events`, so a
 * `since: 0` read after the next sign-in would return the previous human's approval history.
 *
 * THE FRESH EPOCH IS PART OF THE RESET, not bookkeeping. Without it, a cursor or subscription id the
 * previous session handed out would silently re-base against the new empty log — `since: 5` against a
 * log restarted at 1 reads as continuous — which is the failure `log-restarted` exists to refuse.
 * Minting here means those ids are rejected with that reason instead.
 *
 * Identical body to the test reset because it IS the same operation: a restart. The two names exist
 * so a reader of `resetConciergeIdentityState` is not left wondering why production calls something
 * labelled test-only.
 */
export function clearConciergeEventLog(): void {
  ring = [];
  nextSeq = 1;
  subscriptions.clear();
  nextSubscriptionId = 1;
  epoch = mintEpoch();
}
