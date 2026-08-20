// THE ROUTER: an `@agent` in a bead comment becomes a doorbell in that agent's inbox.
//
// WHY THIS EXISTS (live incident, 2026-08-20). A bead comment is the sanctioned cross-agent channel —
// one shared store, founder-visible, outliving any session — but posting one WAKES NOBODY. During a
// CI P0 the improvement agent posted a stand-down comment on another agent's bead; that agent never
// saw it and kept working a superseded plan until the FOUNDER hand-relayed it. Removing the human as
// the wire is the entire point of this file.
//
// ── FOUR PROPERTIES, each a correctness claim rather than a nicety ───────────────────────────────
//
// 1. THE BEAD IS THE MESSAGE; THE INBOX IS ONLY A DOORBELL. We queue a content-free notice pointing
//    at the bead, never the comment body (`mentionMessages.buildDoorbell`). The agent reads what is
//    CURRENTLY on the bead, so it can never act on a private copy that has since been superseded.
//    Nothing is typed into a terminal: chat text never reaches an agent's stdin.
//
// 2. QUEUED IS NOT DELIVERED IS NOT READ, AND WE NEVER COLLAPSE THEM. On 2026-08-14 a send returned
//    `{ok:true, messageId}` for four messages the agent never saw, and the queue then reported them
//    ACKNOWLEDGED — a different `claude` in the same worktree had drained and acked them. So an
//    `ok` from the enqueue is proof of PERSISTENCE and nothing else. This router keeps a ledger of
//    what it queued and re-reads the queue's own verdict; a doorbell still `pending` past
//    `UNDELIVERED_DEADLINE_MS` is reported UNDELIVERED on the bead (property 4), never assumed sent.
//
// 3. A MENTION THAT REACHES NOBODY IS VISIBLE TO WHOEVER WROTE IT. An unknown handle and an ambiguous
//    one are both reported back as a comment on the same bead. A silent no-op here would reproduce
//    the very failure this feature exists to remove, one layer down.
//
// 4. A MENTION STORM MUST NOT BECOME A WAKE STORM. At most one doorbell per (comment, agent) — the
//    ledger is the dedupe, keyed on bd's own stable comment id — at most one refusal comment per
//    source comment however many handles it names, at most one UNDELIVERED report per doorbell, and
//    a hard per-tick ceiling.
//
// ── WHY NEW COMMENTS ARE FOUND BY COUNT, NOT BY READING ──────────────────────────────────────────
// The beads store is one embedded Dolt DB shared by every worktree, single-writer, and a cold
// `bd list --all --json` has been measured at 44.8s under fleet load. Reading every bead's comments
// on a beat would be a lock convoy. So the trigger is `commentCount`, which already rides the bulk
// list the board polls anyway — zero added bd calls — and only a bead whose count actually ROSE costs
// a per-bead read.
//
// A bead is SEEDED on first sight (baseline recorded, nothing routed). That is what makes losing this
// state harmless: after a restart the worst case is that we re-seed and route nothing, never that we
// re-doorbell the whole backlog at a fleet that has already read it.

import type { MentionCandidate, MentionResolution } from "../agentMentionResolve";
import { resolveAgentMention } from "../agentMentionResolve";
import { parseMentionTokens } from "./parseMentionTokens";
import {
  buildDoorbell,
  buildUndeliveredComment,
  buildUnresolvedComment,
  isRouterAuthored,
  type UnresolvedHandle,
} from "./mentionMessages";

/** How long a queued doorbell may sit `pending` before we say so on the bead. Matches the existing
 *  mention channel's ACK deadline (`mention.rs::DEFAULT_ACK_DEADLINE_MS`) rather than inventing a
 *  second number for the same idea. */
export const UNDELIVERED_DEADLINE_MS = 3 * 60 * 1000;

/**
 * The inbox's own record TTL (`inbox.rs::MAX_AGE_MS`). Past this the queue omits a message ENTIRELY
 * — "pending, delivered and acknowledged alike" — so `inbox_peek` stops listing it and our reader
 * sees `missing`.
 */
export const QUEUE_RECORD_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * A ledger entry is dropped once it is this old, and it MUST be shorter than the queue's own TTL.
 *
 * IT USED TO BE LONGER (13h vs 12h) AND THAT ONE-HOUR OVERLAP WAS A FALSE-REPORT MACHINE. Once
 * `missing` became reportable, every successfully delivered and acknowledged doorbell re-read as
 * `missing` the moment the queue aged its record out — while our entry, at 12h, was still under the
 * 13h cut. Nothing had ever been wrong with it, so `reportedUndelivered` was unlatched and the
 * deadline long past: the router would post "UNDELIVERED after 720m … it will NOT arrive" onto the
 * bead, for a mention the agent had read twelve hours earlier, into a shared, founder-visible,
 * non-revertible store — for EVERY mention the feature successfully handled. Retiring first means
 * queue expiry can never present as `missing`.
 */
export const LEDGER_MAX_AGE_MS = QUEUE_RECORD_TTL_MS - 60 * 60 * 1000;

/** Hard ceiling on doorbells queued in one tick (property 4). A comment naming the whole fleet, or a
 *  batch of beads all commented at once, must not turn into an unbounded fan-out. */
export const MAX_DOORBELLS_PER_TICK = 20;

/** How many deadlines an entry waits out while the thread state reads as DEFAULTED before we give
 *  up and say so. A defaulted read is indistinguishable from a failed one (see the sweep), and
 *  `write_state` is non-atomic, so a transient truncated read must never be terminal. */
const DEFAULTED_STATE_GRACE_FACTOR = 4;

/** Hard ceiling on per-bead comment reads in one tick. Each read is a `bd` process against a
 *  single-writer store; the remainder keeps its raised count and is read on the next tick. */
export const MAX_BEAD_READS_PER_TICK = 8;

/** Bound on the processed-comment set so it cannot grow without limit across a long session. */
const MAX_PROCESSED = 2000;

/** One bead, as the bulk list reports it. */
export interface BeadCommentCount {
  id: string;
  commentCount: number;
}

/** One comment, as `beads_detail` reports it. */
export interface RouterComment {
  id: string;
  author: string | null;
  text: string;
}

/** What `mention.rs::mention_send` reported. Mirrors the fields of its `MentionOutcome` we act on. */
export interface MentionChannelOutcome {
  /** The channel round this send occupies. Matching it against `MentionThreadStatus.awaitingAckRound`
   *  is what makes a verdict apply to the RIGHT entry — see the sweep. */
  round: number;
  doorbelled: boolean;
  /** `@improve` only: a scoped responder was launched (vs. one already in flight). */
  spawned: boolean;
  /** `@sparkle` only: the concierge wake event was emitted. */
  wakeSparkle: boolean;
  /** The exchange hit the channel's anti-loop round cap: NOTHING was posted, doorbelled, or woken. */
  capped: boolean;
  messageId: string | null;
}

/** `mention.rs::mention_status`, whose verdict comes from the BEAD's ack comment, not the inbox. */
export interface MentionThreadStatus {
  /** The thread's CURRENT round — the latest send. This, not `awaitingAckRound`, is what identifies
   *  the entry a verdict describes: `status_of` zeroes `awaitingAckRound` the moment an ACK lands
   *  (`awaiting_ack_round: if acked { 0 } else { awaiting }`), and no real entry has round 0, so
   *  matching on it meant an ACKed mention could NEVER resolve — and was then falsely reported
   *  undelivered as soon as any later mention advanced the round. */
  round: number;
  awaitingAckRound: number;
  acked: boolean;
  overdue: boolean;
}

/** What the inbox says happened to a message we queued. `missing` = no longer in the queue view
 *  (expired or compacted), which is NOT the same as delivered and is never reported as such. */
export type DoorbellState = "pending" | "delivered" | "acknowledged" | "missing";

/** One doorbell we queued, awaiting a verdict. */
export interface LedgerEntry {
  messageId: string;
  commentId: string;
  beadId: string;
  agentId: string;
  agentName: string;
  queuedAt: number;
  /** When the thread state FIRST read as defaulted for this entry. The retry grace is measured from
   *  here, never from `queuedAt`: measuring from queue time establishes only "this entry is old",
   *  so an entry already past the grace got ZERO retry and its very first transient defaulted read
   *  was terminal. */
  firstDefaultedAt?: number;
  /** Latched once the UNDELIVERED comment has been posted, so it is posted exactly once. */
  reportedUndelivered?: boolean;
  /** True when this doorbell went through `mention.rs` (a reserved handle). Its delivery verdict
   *  then comes from the BEAD's ack comment via `readMentionStatus`, never from the inbox — see
   *  `RouterDeps.sendViaMentionChannel` for why that distinction is load-bearing. */
  viaMentionChannel?: boolean;
  /** The mention-channel round this entry occupies, for exact verdict matching. */
  round?: number;
  /** Latched the first time the queue reported a terminal SUCCESS for this doorbell.
   *
   *  Independent of the TTL ordering above, and deliberately belt-and-braces: an entry that has
   *  ONCE been seen delivered or acknowledged must never be reported undelivered later, whatever a
   *  subsequent read says. "Never accounted for" and "aged out after success" both surface as
   *  `missing`, and only this flag can tell them apart. */
  resolved?: boolean;
}

/** Everything the router remembers between ticks. Safe to lose — see the seeding note above. */
export interface RouterState {
  /** beadId → the `comment_count` we have already accounted for, from the BULK LIST. This is the
   *  rise detector and nothing else. Absent = never seen = seed it. */
  baselines: Record<string, number>;
  /** beadId → how many comments the DETAIL READ actually returned last time. This is the slice
   *  offset, and it must NOT be the same number as `baselines`.
   *
   *  THE TWO COUNTS ARE FROM DIFFERENT SOURCES AND ARE DOCUMENTED NOT TO AGREE. `beads_cmd.rs`'s
   *  comment parser is deliberately TOLERANT — a bd build that drops the `comments` key, or one
   *  comment missing its `text`, "degrades to fewer comments rather than failing the whole detail
   *  read". So `comments.length` can be permanently below `comment_count`. Using the list count as
   *  an array index then leaves the offset forever past the end: `slice(offset)` returns `[]` for
   *  every future comment while the baseline keeps advancing — silent, permanent non-delivery on
   *  that bead, which is the exact failure class this file exists to remove, and it never
   *  self-corrects. */
  accounted?: Record<string, number>;
  /** Stable bd comment ids already routed, newest last. Bounded by `MAX_PROCESSED`. */
  processed: string[];
  /** Doorbells queued and not yet resolved to a terminal verdict. */
  ledger: LedgerEntry[];
}

export function emptyRouterState(): RouterState {
  return { baselines: {}, accounted: {}, processed: [], ledger: [] };
}

/** The seams. Every one of these is injected so the whole deliver→report flow is testable with no
 *  `bd`, no Tauri, and no clock. */
export interface RouterDeps {
  /** Agents that can be addressed right now: `{ id, name }`, name already resolved through the
   *  shared display-name rule by the caller. */
  listCandidates: () => readonly MentionCandidate[];
  /** One bead's comments, oldest-first. */
  fetchComments: (beadId: string) => Promise<readonly RouterComment[]>;
  /** Queue the doorbell. MUST be an enqueue that proves persistence (it reads the record back
   *  through the reader's own parser) and MUST reject rather than returning an id it cannot stand
   *  behind. Returns the message id. */
  enqueueDoorbell: (agentId: string, text: string, from: string) => Promise<string>;
  /** Post a comment back onto a bead. */
  postComment: (beadId: string, text: string) => Promise<void>;
  /** The queue's own verdict for messages we queued for one agent. */
  readDoorbellStates: (agentId: string) => Promise<ReadonlyMap<string, DoorbellState>>;
  /**
   * Send through the EXISTING @mention channel (`mention.rs`) instead of a bare inbox enqueue.
   *
   * WHY THIS EXISTS AND WHY IT IS NOT A SECOND MECHANISM. A doorbell without a wake is only as
   * timely as the target's own cadence: a build agent mid-turn meets it at its next `Stop`, but the
   * two APP-GLOBAL targets have no session at all between passes, so a bare enqueue could sit for
   * over an hour. `mention.rs` already implements the missing half — `@improve` SPAWNS a scoped
   * responder, `@sparkle` emits the event the frontend turns into an immediate concierge turn — and
   * its module header describes this exact design ("BEADS IS THE MESSAGE; THE INBOX IS ONLY A
   * DOORBELL", "SYMMETRIC WAKE", "DELIVERY IS NOT ACK"). It had zero callers anywhere; this is the
   * first. One transport, more than one caller, rather than a parallel channel that drifts.
   *
   * IT ALSO FIXES THE ACK. Its ACK is a BEAD COMMENT the recipient writes, not the inbox ack file —
   * which is what makes it survive the 2026-08-14 trap: two `claude` processes in one worktree meant
   * a BYSTANDER drained and acked four messages, and `inbox_status` reported them `acknowledged` for
   * messages the real agent never saw. An inbox ack is satisfiable by any process sharing the
   * worktree; a bead comment attributed to the agent is not.
   *
   * Returns what the channel did, so `capped` can be reported rather than silently swallowed.
   */
  sendViaMentionChannel?: (
    /** The RESOLVED AGENT ID, never the token the author typed — the adapter maps it to the
     *  canonical wire handle. Both are `string`, so nothing typechecks as wrong if they are
     *  swapped; that mistake made every reserved mention inert while both suites stayed green. */
    agentId: string,
    beadId: string,
    from: string,
  ) => Promise<MentionChannelOutcome>;
  /** Read the channel's own delivery verdict for a thread — sourced from the BEAD's ack comment. */
  readMentionStatus?: (beadId: string) => Promise<MentionThreadStatus>;
  /** Resolve a RESERVED handle, case-insensitively. Consulted BEFORE the roster: these addresses are
   *  the app's own, and a roster row that happens to share a name must not be able to shadow one —
   *  `resolveAgentMention` answers `ambiguous` on any name collision, which would make the reserved
   *  handle unaddressable exactly when a similarly-named agent is running. Optional; omitted in
   *  tests that only care about roster resolution. */
  resolveSpecialHandle?: (token: string) => MentionCandidate | null;
  /** Extra spellings the PARSER should recognise (the reserved handles), so a multi-word one is
   *  captured whole. Resolution still goes through `resolveSpecialHandle`. */
  specialHandleNames?: readonly string[];
  now: () => number;
  /** Non-fatal diagnostics. A failure to route ONE mention must never stop the tick. */
  onError?: (where: string, err: unknown) => void;
}

/** What one tick did — returned so tests can assert the SIDE EFFECTS rather than internal state. */
export interface TickReport {
  /** Beads seeded on this tick (baseline recorded, nothing routed). */
  seeded: string[];
  /** Beads whose comments were read because their count rose. */
  read: string[];
  /** Doorbells successfully queued, in order. */
  doorbelled: Array<{ agentId: string; beadId: string; commentId: string; messageId: string }>;
  /** Handles that reached nobody, reported back onto their bead. */
  unresolved: Array<{ beadId: string; commentId: string } & UnresolvedHandle>;
  /** Doorbells reported UNDELIVERED on this tick. */
  undelivered: Array<{ agentId: string; beadId: string; messageId: string }>;
  /** COMMENTS deferred by the per-tick ceiling — not tokens dropped, because none are. A comment
   *  that hits the budget (before its first token or part-way through) is un-processed, its bead's
   *  baseline is left unadvanced, and the whole comment is retried next tick. The `(comment, agent)`
   *  ledger makes that retry idempotent for tokens already doorbelled. */
  deferred: number;
}

function emptyReport(): TickReport {
  return { seeded: [], read: [], doorbelled: [], unresolved: [], undelivered: [], deferred: 0 };
}

/**
 * Which beads gained a comment since we last looked — and which are merely being seen for the first
 * time. Pure, so the "a brand-new bead never wakes anyone" rule is directly testable.
 *
 * A count that FELL (a comment was deleted) re-baselines silently: there is no new comment to route,
 * and leaving the old high-water mark would suppress the next real one.
 */
export function selectBeadsToRead(
  state: RouterState,
  beads: readonly BeadCommentCount[],
): { toRead: string[]; seeded: string[]; baselines: Record<string, number> } {
  const baselines = { ...state.baselines };
  const toRead: string[] = [];
  const seeded: string[] = [];
  for (const bead of beads) {
    const prev = baselines[bead.id];
    if (prev === undefined) {
      baselines[bead.id] = bead.commentCount;
      seeded.push(bead.id);
      continue;
    }
    if (bead.commentCount > prev) toRead.push(bead.id);
    else if (bead.commentCount < prev) baselines[bead.id] = bead.commentCount;
  }
  return { toRead, seeded, baselines };
}

/** Does this comment's author look like the agent we are about to wake? Best-effort and deliberately
 *  conservative: bd's author field is a free-text actor string, not an agent id, so we only suppress
 *  on an exact match against the id or the display name. Waking an agent about its own comment is
 *  noise, never harm, so a miss here is cheap and a false positive would be a dropped message. */
function isSelfMention(author: string | null, candidate: MentionCandidate): boolean {
  if (author === null) return false;
  const a = author.trim();
  return a === candidate.id || a === candidate.name;
}

/** Route the mentions in ONE comment. Extracted so the per-comment rules — self-mention, dedupe,
 *  one refusal comment however many bad handles — are testable without a whole tick around them. */
async function routeOneComment(
  beadId: string,
  comment: RouterComment,
  candidates: readonly MentionCandidate[],
  state: RouterState,
  deps: RouterDeps,
  report: TickReport,
  budget: { left: number },
): Promise<{ exhausted: boolean }> {
  const tokens = parseMentionTokens(comment.text, [
    ...candidates.map((c) => c.name),
    ...(deps.specialHandleNames ?? []),
  ]);
  if (tokens.length === 0) return { exhausted: false };

  const from = comment.author?.trim() || "someone";
  const unresolved: UnresolvedHandle[] = [];
  /** Doorbells this comment actually queued — the ONLY input to the report's heading. */
  let delivered = 0;

  for (const { token } of tokens) {
    // RESERVED HANDLES FIRST — see `RouterDeps.resolveSpecialHandle`. Resolving these in the same
    // pass as the roster lets any identically-named agent shadow the app's own address.
    const reserved = deps.resolveSpecialHandle?.(token) ?? null;
    const verdict: MentionResolution = reserved
      ? { kind: "ok", id: reserved.id, name: reserved.name }
      : resolveAgentMention(candidates, token);

    // SHADOWING MUST BE VISIBLE, not silent. Reserved-first plus case folding means a live agent
    // whose display name matches a reserved handle becomes unaddressable BY NAME — and where the
    // old behaviour at least produced an `ambiguous` refusal naming both ids, precedence alone
    // would send the doorbell to the reserved target with nothing said. That is a real doorbell
    // delivered to someone nobody addressed, which the parser's own header calls the worst outcome
    // it guards against. So the delivery still happens (precedence is correct — the way OUT must
    // not be shadowable) and a note is appended telling the author to use the agent's id.
    // NOTE: the shadow note is recorded only AFTER the doorbell is confirmed queued (below).
    // Recording it here, before the enqueue, meant a refused inbox produced BOTH a `shadowed` line
    // saying the notice "went there" and an `enqueue-failed` line saying it could not be queued —
    // a self-contradicting report about a delivery that never happened.
    const shadow = reserved
      ? candidates.find((c) => c.name.trim().toLowerCase() === token.trim().toLowerCase())
      : undefined;

    if (verdict.kind === "ambiguous") {
      unresolved.push({ token, reason: "ambiguous", ids: verdict.ids });
      continue;
    }
    if (verdict.kind === "unknown") {
      unresolved.push({ token, reason: "unknown" });
      continue;
    }

    // ONE DOORBELL PER (COMMENT, AGENT) — property 4. Keyed on bd's stable comment id, so a comment
    // naming the same agent twice, or a bead re-read after a transient failure, cannot double-wake.
    const already = state.ledger.some(
      (e) => e.commentId === comment.id && e.agentId === verdict.id,
    );
    if (already) {
      // ALREADY DOORBELLED ON AN EARLIER PASS — and both of this function's signals describe the
      // WHOLE COMMENT, not this pass, so they must account for it here.
      //
      // A comment deferred by the per-tick budget is re-routed in full next tick, and that RETRY is
      // the only pass that ever posts (the exhausted pass returns before the report is built). If
      // this skip ran ahead of the two lines below, the retry would count zero deliveries and head
      // the report "reached nobody" for a comment that had already woken agents, and the shadow
      // note — which the header calls a correctness property — would never be written at all.
      delivered += 1;
      if (shadow) unresolved.push({ token, reason: "shadowed", resolvedId: shadow.id });
      continue;
    }
    if (isSelfMention(comment.author, { id: verdict.id, name: verdict.name })) continue;

    if (budget.left <= 0) {
      // MID-COMMENT EXHAUSTION DEFERS THE WHOLE COMMENT — it must not drop the remaining tokens.
      //
      // This is the LIKELY shape, not a corner case: the per-tick budget is shared across up to
      // MAX_BEAD_READS_PER_TICK beads, so it landing exactly on a comment boundary is the unlikely
      // outcome. Dropping here would lose those mentions permanently and silently, with nothing
      // posted onto the bead — the failure this module exists to remove, reintroduced by its own
      // rate limit. The caller un-processes the comment and leaves the bead's baseline unadvanced;
      // the (comment, agent) ledger check above makes the retry idempotent for tokens already sent.
      report.deferred += 1;
      return { exhausted: true };
    }

    try {
      // A RESERVED HANDLE GOES THROUGH THE MENTION CHANNEL, which doorbells AND wakes. A bare
      // enqueue would leave these two — which have no live session between passes — waiting on
      // their own cadence, which is the "doorbell without a wake" this router otherwise is.
      let messageId: string;
      let viaMentionChannel = false;
      let channelRound: number | undefined;
      if (reserved && deps.sendViaMentionChannel) {
        const sent = await deps.sendViaMentionChannel(verdict.id, beadId, from);
        if (sent.capped) {
          // The channel's anti-loop cap fired: nothing was posted, doorbelled or woken. Say so —
          // a silently halted exchange is indistinguishable from a delivered one.
          unresolved.push({ token, reason: "capped", resolvedId: verdict.id });
          continue;
        }
        if (!sent.doorbelled) {
          unresolved.push({ token, reason: "enqueue-failed", resolvedId: verdict.id });
          continue;
        }
        messageId = sent.messageId ?? "";
        viaMentionChannel = true;
        channelRound = sent.round;
      } else {
        messageId = await deps.enqueueDoorbell(verdict.id, buildDoorbell(from, beadId), from);
      }
      budget.left -= 1;
      state.ledger.push({
        messageId,
        commentId: comment.id,
        beadId,
        agentId: verdict.id,
        agentName: verdict.name,
        queuedAt: deps.now(),
        viaMentionChannel,
        round: channelRound,
      });
      report.doorbelled.push({
        agentId: verdict.id,
        beadId,
        commentId: comment.id,
        messageId,
      });
      delivered += 1;
      // The doorbell is queued, so the shadowing note is now a true statement about a real delivery.
      if (shadow) unresolved.push({ token, reason: "shadowed", resolvedId: shadow.id });
    } catch (err) {
      // The enqueue refused — a full inbox, an unwritable queue. That is a FAILURE to deliver, so it
      // must not be recorded as a doorbell. It is reported with its OWN reason rather than as an
      // unresolvable handle: the agent resolved fine, so telling the writer the handle "matches no
      // agent" and to re-comment with an id is false twice over, and the remedy it offers hits the
      // identical refusal. A remedy is an instruction someone will follow.
      deps.onError?.(`enqueue ${verdict.id}`, err);
      unresolved.push({ token, reason: "enqueue-failed", resolvedId: verdict.id });
    }
  }

  // ONE refusal comment for the whole source comment, never one per handle.
  const text = buildUnresolvedComment(beadId, unresolved, delivered);
  // (Unreachable on the exhausted path: that returns above, so the retry cannot double-post this.)
  if (text !== null) {
    try {
      await deps.postComment(beadId, text);
      for (const u of unresolved) {
        report.unresolved.push({ beadId, commentId: comment.id, ...u });
      }
    } catch (err) {
      deps.onError?.(`postComment ${beadId}`, err);
    }
  }
  return { exhausted: false };
}

/** Re-read the queue's verdict for every outstanding doorbell and say so on the bead when one has
 *  sat `pending` past the deadline. Property 2 — this is the half that makes silence visible. */
async function sweepLedger(
  state: RouterState,
  deps: RouterDeps,
  report: TickReport,
): Promise<void> {
  const now = deps.now();
  const byAgent = new Map<string, LedgerEntry[]>();
  for (const e of state.ledger.filter((x) => !x.viaMentionChannel)) {
    const list = byAgent.get(e.agentId);
    if (list) list.push(e);
    else byAgent.set(e.agentId, [e]);
  }

  // MENTION-CHANNEL ENTRIES ARE JUDGED BY THE BEAD, NOT THE INBOX. Their proof of reading is an ACK
  // COMMENT the recipient wrote on the thread, which a bystander process sharing the worktree cannot
  // produce — unlike an inbox ack, which is exactly what the wrong `claude` forged on 2026-08-14.
  //
  // ONE VERDICT PER BEAD, APPLIED ONLY TO THE ENTRY IT DESCRIBES. `mention_status` is per-thread and
  // ROUND-SCOPED: it reports the latest awaited round and nothing else. A bead can easily hold
  // several outstanding entries (`@improve @sparkle` in one comment is two sends, two rounds), and
  // reading that single verdict for all of them fails in both directions — a later round's ACK would
  // silently resolve an earlier entry nobody acknowledged, which is the fail-open this module
  // forbids, and one overdue thread would post a separate UNDELIVERED comment per entry into a
  // shared, founder-visible store. Grouping also collapses N `bd` reads per tick into one, on the
  // single-writer store this module is designed around.
  const channelByBead = new Map<string, LedgerEntry[]>();
  for (const e of state.ledger) {
    if (!e.viaMentionChannel || e.resolved || e.reportedUndelivered) continue;
    const list = channelByBead.get(e.beadId);
    if (list) list.push(e);
    else channelByBead.set(e.beadId, [e]);
  }

  for (const [beadId, entries] of channelByBead) {
    if (!deps.readMentionStatus) continue;
    let st: MentionThreadStatus;
    try {
      st = await deps.readMentionStatus(beadId);
    } catch (err) {
      // Fail CLOSED: an unreadable thread never resolves to acked.
      deps.onError?.(`readMentionStatus ${beadId}`, err);
      continue;
    }

    for (const entry of entries) {
      // MATCH ON THE THREAD'S CURRENT ROUND, not on `awaitingAckRound`. Rust zeroes the latter the
      // moment an ACK lands, and no real entry has round 0 — so matching on it made the resolve
      // path unreachable in production.
      //
      // A verdict only speaks for the entry whose round it IS. Three things fall outside that, and
      // all three must be judged the same way rather than trusted or silenced:
      //   - the thread has moved past this entry's round (a later mention on the same bead);
      //   - this entry predates the `round` field (persisted by an earlier build);
      //   - the thread state is DEFAULTED — `read_state` is `unwrap_or_default()`, so a missing or
      //     unparseable state file yields `{round: 0, acked: false, overdue: false}`. The ledger
      //     lives in localStorage and the thread state on disk under app data, two stores with
      //     independent lifetimes, so divergence is ordinary rather than exotic.
      // Matching a round-less entry against ANY state would let some other round's ACK resolve it —
      // the fail-open this module forbids — and matching none of them left it re-reading the thread
      // every tick, forever, in silence. It is UNKNOWN, and reported as unknown.
      const stateIsDefaulted = st.round === 0;
      const isLatest =
        !stateIsDefaulted && entry.round !== undefined && entry.round === st.round;

      if (isLatest && st.acked) {
        entry.resolved = true;
        continue;
      }

      // NOTHING IS REPORTED BEFORE ITS OWN DEADLINE. Two reserved handles in ONE comment are two
      // sends in the SAME tick, so the first is superseded the instant the second lands — reporting
      // on supersession alone posted a false notice at age ~0ms, for a recipient that had not had a
      // moment to answer.
      // ONE DEADLINE FOR EVERY TARGET, and that is now correct rather than a simplification. It
      // used to be per-target because the reserved handles had no live session between passes, so
      // anything shorter than an hour cried wolf on them. Routing them through `mention.rs` removed
      // that premise — a responder is SPAWNED for @improve and a concierge turn scheduled for
      // @sparkle — so a reply really is due in minutes, and this matches the channel's own
      // `DEFAULT_ACK_DEADLINE_MS`. A per-target seam that nothing supplies would be dead code
      // pretending to be a capability.
      const deadline = UNDELIVERED_DEADLINE_MS;
      if (now - entry.queuedAt < deadline) continue;

      const dueNow = isLatest && st.overdue;
      if (!isLatest || stateIsDefaulted) {
        // A DEFAULTED STATE IS A FAILED READ, AND IS RETRIED — not reported terminally.
        //
        // `{round: 0}` carries strictly no more information than a `readMentionStatus` throw: it is
        // literally what `read_state` returns when the file cannot be read, since `read_to_string`
        // is `.ok()`-swallowed. Treating a throw as retry-next-tick while treating this as terminal
        // was contradictory — and the window is real rather than theoretical, because `write_state`
        // is a NON-ATOMIC `fs::write`, so any `mention_status` read racing a `mention_send` on the
        // same bead sees a truncated file. One such read would have posted a permanent UNCONFIRMED
        // notice for every outstanding entry on a perfectly healthy thread, and latched them out of
        // the sweep so the ACK that did arrive could never resolve them.
        //
        // A state that is STILL unreadable long past the deadline is a different fact, and that one
        // is reported — silence there is the hole this branch exists to close.
        if (stateIsDefaulted) {
          // Start the clock at the FIRST defaulted read, so the grace measures "still unreadable"
          // rather than "this entry is old". The reachable case: a mention queued, the app quit a
          // minute later, reopened half an hour on — the entry is already well past any
          // queue-time grace, so its first status read after relaunch, racing a concurrent
          // `mention_send` and seeing the truncated file the non-atomic `write_state` leaves,
          // would have been terminal on the spot. That latches a healthy, still-awaiting thread
          // out of the sweep: the ACK arriving seconds later could never resolve it.
          entry.firstDefaultedAt ??= now;
          if (now - entry.firstDefaultedAt < deadline * DEFAULTED_STATE_GRACE_FACTOR) continue;
        } else {
          // A readable state clears the memo, so an isolated blip never accumulates toward it.
          entry.firstDefaultedAt = undefined;
        }
        try {
          await deps.postComment(
            beadId,
            buildUndeliveredComment(
              entry.agentName,
              beadId,
              // Name the cause honestly: supersession is only ESTABLISHED when a readable state
              // shows a later round. A lost state proves nothing about a later exchange.
              // THREE CAUSES, THREE SENTENCES — a two-way split put the "state unreadable" claim on
              // the round-less population, where the state read fine and typically shows a later
              // round. Right about delivery, wrong about why, one branch over.
              stateIsDefaulted
                ? "unjudgeable"
                : entry.round !== undefined && st.round > entry.round
                  ? "superseded"
                  : "unmatched",
              now - entry.queuedAt,
            ),
          );
          entry.reportedUndelivered = true;
          report.undelivered.push({
            agentId: entry.agentId,
            beadId,
            messageId: entry.messageId,
          });
        } catch (err) {
          deps.onError?.(`postComment unconfirmed ${beadId}`, err);
        }
        continue;
      }
      if (!dueNow) continue;

      try {
        await deps.postComment(
          beadId,
          buildUndeliveredComment(entry.agentName, beadId, "unacked", now - entry.queuedAt),
        );
        entry.reportedUndelivered = true;
        report.undelivered.push({
          agentId: entry.agentId,
          beadId,
          messageId: entry.messageId,
        });
      } catch (err) {
        deps.onError?.(`postComment unacked ${beadId}`, err);
      }
    }
  }

  for (const [agentId, entries] of byAgent) {
    let states: ReadonlyMap<string, DoorbellState>;
    try {
      states = await deps.readDoorbellStates(agentId);
    } catch (err) {
      // Could not read the verdict. Fail CLOSED: leave the entries alone so they are re-checked next
      // tick. Never resolve an unreadable queue to "delivered" — that is the 2026-08-14 shape.
      deps.onError?.(`readDoorbellStates ${agentId}`, err);
      continue;
    }
    for (const entry of entries) {
      const st = states.get(entry.messageId) ?? "missing";
      // `delivered` and `acknowledged` are the only terminal SUCCESSES. `missing` is the queue
      // saying it has no record of this notice at all — expired, compacted, or the agent's queue
      // torn down — and skipping it here was a fail-OPEN in the exact direction property 2 claims
      // to be closed: the sender would believe a mention landed that the queue itself cannot
      // account for. The "unreadable queue" test did not cover it, because that path THROWS while
      // this one returns a perfectly valid map that simply lacks the id.
      if (st === "delivered" || st === "acknowledged") {
        // Terminal success — remember it, so a later `missing` (the queue aging the record out)
        // cannot be mistaken for "never arrived".
        entry.resolved = true;
        continue;
      }
      if (entry.resolved) continue;
      if (st !== "pending" && st !== "missing") continue;
      // AGE SILENCES ONLY THE AMBIGUOUS VERDICT, and only `missing` is ambiguous. Past the queue's
      // own TTL its record is gone, so "never handed over" and "expired after a delivery no tick
      // happened to observe" look identical — that is the whole reason this window exists. A
      // `pending` verdict is NOT ambiguous at any age: `entries_of` filters expired records out, so
      // the queue still listing it is an affirmative statement that the agent never got it.
      // Skipping on age BEFORE reading the verdict silenced that too, and since the entry is
      // retired immediately after, no later tick could report it either — turning the one guarantee
      // this feature exists to provide into silence, in exactly the app-away gap it is meant for.
      if (st === "missing" && now - entry.queuedAt >= LEDGER_MAX_AGE_MS) continue;
      if (entry.reportedUndelivered) continue;
      if (now - entry.queuedAt < UNDELIVERED_DEADLINE_MS) continue;
      try {
        await deps.postComment(
          entry.beadId,
          buildUndeliveredComment(entry.agentName, entry.beadId, st, now - entry.queuedAt),
        );
        entry.reportedUndelivered = true;
        report.undelivered.push({
          agentId: entry.agentId,
          beadId: entry.beadId,
          messageId: entry.messageId,
        });
      } catch (err) {
        deps.onError?.(`postComment undelivered ${entry.beadId}`, err);
      }
    }
  }

  // Retire entries that have reached a terminal verdict or aged out of the queue entirely.
  state.ledger = state.ledger.filter((e) => now - e.queuedAt < LEDGER_MAX_AGE_MS);
}

/**
 * One tick. Returns the NEXT state and a report of what it actually did.
 *
 * Never throws: a failure against one bead or one agent is recorded through `onError` and the rest of
 * the tick continues. A watcher that died on a single unreadable bead would be a channel that stops
 * working silently, which is the class of bug this whole file is about.
 */
export async function runMentionTick(
  prev: RouterState,
  beads: readonly BeadCommentCount[],
  deps: RouterDeps,
): Promise<{ state: RouterState; report: TickReport }> {
  const report = emptyReport();
  const { toRead, seeded, baselines } = selectBeadsToRead(prev, beads);
  report.seeded = seeded;

  const state: RouterState = {
    baselines,
    accounted: { ...(prev.accounted ?? {}) },
    processed: [...prev.processed],
    ledger: [...prev.ledger],
  };

  const candidates = deps.listCandidates();
  const processed = new Set(state.processed);
  const budget = { left: MAX_DOORBELLS_PER_TICK };

  for (const beadId of toRead.slice(0, MAX_BEAD_READS_PER_TICK)) {
    let comments: readonly RouterComment[];
    try {
      comments = await deps.fetchComments(beadId);
    } catch (err) {
      // Leave the baseline BELOW the observed count so this bead is retried next tick rather than
      // being silently skipped forever.
      deps.onError?.(`fetchComments ${beadId}`, err);
      continue;
    }
    report.read.push(beadId);

    // ROUTE ONLY THE TAIL — everything at or after the count we had already accounted for.
    //
    // THE BUG THIS EXISTS TO PREVENT, which the seeding rule alone does NOT: seeding records a
    // COUNT, not WHICH comments were there. So "seeded ⇒ nothing routed" held for the seed tick and
    // was falsified one comment later — the first count rise re-read the bead's ENTIRE history and
    // routed every comment of it that was not in `processed`. On a first launch (or after any
    // localStorage loss, which is documented as safe) one new comment on a long-lived bead became a
    // doorbell for every historic @mention on it, plus a NOT DELIVERED comment for every historic
    // unresolvable one — unbounded writes to a shared, single-writer, non-revertible store.
    //
    // Slicing by the baseline also removes `processed`'s FIFO cap from the correctness path: an
    // evicted id below the baseline is now unreachable rather than re-routable.
    // The offset comes from what was actually READ last time. Falling back to the list count keeps
    // state persisted before this field existed working: it is the best estimate available, and it
    // is what the previous build used for every bead.
    const previouslyAccounted = prev.accounted?.[beadId] ?? prev.baselines[beadId] ?? 0;
    const fresh = comments.slice(previouslyAccounted);

    // The skipped prefix is still recorded as seen, so a later baseline reset cannot resurrect it.
    for (const old of comments.slice(0, previouslyAccounted)) {
      if (old.id.length > 0 && !processed.has(old.id)) {
        processed.add(old.id);
        state.processed.push(old.id);
      }
    }

    let deferred = false;
    for (const comment of fresh) {
      if (comment.id.length === 0) continue; // no stable key ⇒ cannot dedupe ⇒ must not route
      if (processed.has(comment.id)) continue;
      if (isRouterAuthored(comment.text)) {
        // Our own comment. Mark it processed so it is never re-examined, and never scan it — this is
        // the guard that stops a refusal from provoking another refusal, forever.
        processed.add(comment.id);
        state.processed.push(comment.id);
        continue;
      }
      // THE PER-TICK CEILING DEFERS; IT MUST NOT DROP. Marking the comment processed BEFORE routing
      // it — and advancing the baseline past it below — is how a suppressed doorbell became a
      // mention that reached nobody, silently, with nothing posted back onto the bead. So a comment
      // that cannot be fully routed within this tick's budget is left unprocessed, the baseline is
      // left unadvanced, and the whole bead is retried next tick.
      if (budget.left <= 0) {
        report.deferred += 1;
        deferred = true;
        break;
      }
      processed.add(comment.id);
      state.processed.push(comment.id);
      const outcome = await routeOneComment(
        beadId,
        comment,
        candidates,
        state,
        deps,
        report,
        budget,
      );
      if (outcome.exhausted) {
        // Un-process it so the retry re-reads this comment in full, and stop the bead here.
        processed.delete(comment.id);
        state.processed = state.processed.filter((id) => id !== comment.id);
        deferred = true;
        break;
      }
    }

    // Only now advance the baseline: a bead whose read failed, or whose tail was cut short by the
    // budget, keeps its old one and is retried.
    if (deferred) continue;
    const observed = beads.find((b) => b.id === beadId)?.commentCount;
    if (observed !== undefined) state.baselines[beadId] = observed;
    // Recorded from the READ, never from the list count — see `RouterState.accounted`.
    (state.accounted ??= {})[beadId] = comments.length;
  }

  await sweepLedger(state, deps, report);

  if (state.processed.length > MAX_PROCESSED) {
    state.processed = state.processed.slice(-MAX_PROCESSED);
  }
  return { state, report };
}
