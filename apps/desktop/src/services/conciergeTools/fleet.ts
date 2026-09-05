/**
 * The concierge's fleet-awareness surface: the Level 0–2 escalation ladder.
 *
 * WHAT THIS REPLACES. Until now the concierge learned an agent's state from surface signals — is a
 * spinner visible, is the screen calm — routed through `runtimeStore`, which is window-local,
 * in-memory, and populated only while a pane is mounted. Consequences: a closed pane reads
 * `unknown`, and because `isRedStatus(undefined)` is `false`, an unwatched agent is indistinguishable
 * from a healthy one. That blindness cost 23.6 aggregate agent-hours across 37 stalls in one day.
 *
 * THE RULE THIS SURFACE ENFORCES. Anything knowable from an ARTIFACT is read from the artifact.
 * An agent's turn is spent only when the concierge has something that agent NEEDS. Concretely,
 * agent responses are NEVER used as a liveness mechanism: a message costs the agent a full turn and
 * can end the turn it was in the middle of, so pinging 40 agents every ten minutes is ~240 turns an
 * hour purely to learn who is alive. `fleet_digest` answers the same question without spending an
 * agent TURN — which is the sense in which it is "free", and the only one. It still costs real disk
 * and git work (~0.27s per agent, measured), so it is polled every thirty seconds rather than run
 * in a loop, and unchanged agents are served from a memo without spawning git.
 *
 * THE TIERING IS THE INCENTIVE DESIGN. `inbox_send` is `routine` (auto-allowed) while
 * `send_to_agent_terminal` is `disruptive` (asks). That asymmetry is deliberate and is the whole
 * mechanism by which Level 3 becomes rare: the non-interrupting channel is frictionless and the
 * interrupting one is not, so the cheap correct choice is also the easy one.
 */
import { invoke } from "@tauri-apps/api/core";

import type {
  FleetAgentFacts,
  FleetDigest,
  FleetVerdict,
} from "../../engine/fleetVerdict";
import { verdictsFor } from "../../engine/fleetVerdict";
import { openAgentIdSet } from "../knownAgents";
import { useSettingsStore } from "../../stores/settingsStore";
import { observedDrainerFor, type QueueDrainer } from "../fleetWatch";
import { SPARKLE_AGENT_ID } from "../sparkleAgent";

/** The concierge's reserved caller id. Mirrors `CONCIERGE_CALLER_AGENT_ID` in `../controlListener`,
 *  kept LOCAL here to avoid a controlListener → conciergeTools/registry → fleet import cycle (fleet
 *  is a leaf of that chain). The two literals must stay in step; `fleet.test.ts` pins that
 *  behaviorally — it passes the REAL `CONCIERGE_CALLER_AGENT_ID` to `inboxSend` and asserts it is
 *  addressable, so a drift here would refuse the concierge and red the test. */
const CONCIERGE_INBOX_ID = "sparkle:concierge";

/** The ids `inboxSend`/`inboxBroadcast` will actually DELIVER to — the deliver-or-fail directory
 *  (bead sparkle-179b2s), the same address book `get_state({ scope: "fleet" })` publishes.
 *
 *  THE HOLE THIS CLOSES. `inbox.rs::enqueue` accepts any well-formed id and checks no registry, so a
 *  send to a typo'd, closed, or otherwise undrained id writes a message into a file nothing reads and
 *  hands back an id that looks exactly like a delivery — the `ok:true` silent lie this whole change
 *  exists to kill. Resolving the recipient here, BEFORE the Rust hop, is what makes an undeliverable
 *  send a loud refusal instead.
 *
 *  MEMBERSHIP: every live agent (open in any window — the same `openAgentIdSet` liveness the roster
 *  uses) plus the two app-global special ids. The canonical Improve Sparkle id is always included —
 *  the hourly HEADLESS pass drains it (`sparkle_improve.rs::build_improve_exec` exports
 *  `SPARKLE_INBOX_AGENT`) — so a message lands even with no pane open; a per-window Sparkle id rides
 *  in via `openAgentIdSet` only while its pane is live. */
function inboxAddressableIds(): Set<string> {
  const ids = openAgentIdSet();
  ids.add(CONCIERGE_INBOX_ID);
  ids.add(SPARKLE_AGENT_ID);
  return ids;
}

/** The refusal returned for a recipient nothing drains — named so the caller can report WHICH id it
 *  failed to reach, never a flat "send failed". */
function undeliverableRecipient(op: FleetOp, agentId: string): FleetRefusal {
  return refuse(
    op,
    "undeliverable-recipient",
    `"${agentId}" is not an addressable recipient: no live agent has that id, and it is neither the ` +
      `concierge nor Improve Sparkle. Nothing drains that inbox, so a queued message would never be ` +
      `read — refusing rather than returning an id for a message no one will see. Resolve the ` +
      `recipient against get_state({ scope: "fleet" }) or the project roster first.`,
  );
}

// ---------------------------------------------------------------------------------------------
// Ops and risk
// ---------------------------------------------------------------------------------------------

export const FLEET_OPS = [
  "fleet_digest",
  "read_agent_stream",
  "read_agent_transcript",
  "inbox_send",
  "inbox_broadcast",
  "inbox_status",
] as const;

export type FleetOp = (typeof FLEET_OPS)[number];

export type FleetRisk = "read-only" | "routine" | "disruptive" | "irreversible";

/**
 * EXHAUSTIVE by construction — a `Record<FleetOp, …>`, so an op added without a classification
 * fails `tsc` rather than defaulting to something permissive.
 *
 * The three reads are `read-only`: each one opens files the app already owns and writes nothing.
 *
 * `inbox_status` IS THE FOURTH, AND ITS TIER IS A GUARANTEE RATHER THAN A COST ESTIMATE. It is the op
 * every send receipt tells the caller to use to check whether a message landed, so it is polled — by
 * `fleetWatch` on a ~10s beat, and by a concierge double-checking its own send. If it ever claimed,
 * merely LOOKING would become a delivery path and would consume messages no agent saw, which is the
 * bug it exists to expose. Keep it `read-only`, and keep it reading through `inbox_peek`.
 *
 * The two sends are `routine`, NOT `disruptive`, and the distinction is the point of Level 2. A
 * queued message does not touch the agent's PTY, cannot interrupt a turn in progress, and is not
 * seen until the agent reaches a boundary it was going to reach anyway. The cost of a wrong one is
 * that an agent reads a sentence it did not need — recoverable, and far below the cost of a wrong
 * `send_to_agent_terminal`, which can discard work mid-turn. Classifying it `disruptive` would make
 * the concierge ask before every queued note, and an assistant that must ask to leave a message
 * will reach for the terminal instead — which is exactly backwards.
 */
export const FLEET_RISK: Record<FleetOp, FleetRisk> = {
  fleet_digest: "read-only",
  read_agent_stream: "read-only",
  read_agent_transcript: "read-only",
  inbox_send: "routine",
  inbox_broadcast: "routine",
  inbox_status: "read-only",
};

// ---------------------------------------------------------------------------------------------
// Results — the diff/board/plans convention
// ---------------------------------------------------------------------------------------------

export interface FleetOk<T> {
  ok: true;
  op: FleetOp;
  risk: FleetRisk;
  data: T;
}

export interface FleetRefusal {
  ok: false;
  op: FleetOp;
  risk: FleetRisk;
  reason: string;
  message: string;
}

export type FleetResult<T> = FleetOk<T> | FleetRefusal;

function ok<T>(op: FleetOp, data: T): FleetOk<T> {
  return { ok: true, op, risk: FLEET_RISK[op], data };
}

function refuse(op: FleetOp, reason: string, message: string): FleetRefusal {
  return { ok: false, op, risk: FLEET_RISK[op], reason, message };
}

// ---------------------------------------------------------------------------------------------
// Wire shapes (mirrors of the Rust structs)
// ---------------------------------------------------------------------------------------------

export interface StreamPage {
  lines: string[];
  nextCursor: number;
  remainingBytes: number;
  eof: boolean;
  totalBytes: number;
  /**
   * True when a single record was longer than `maxBytes` and this page therefore contains a FRAGMENT
   * of it rather than a whole line — the one case in which the "a page never splits a record"
   * guarantee cannot be kept. It is not exotic for transcripts: one large tool result exceeds the
   * default page budget, and a caller parsing JSONL would otherwise receive unparseable fragments
   * presented as complete lines, with the multi-byte character straddling the cut replaced by U+FFFD.
   * Re-read with a larger `maxBytes`, or stitch across pages.
   */
  partialLine: boolean;
}

export type InboxSeverity = "fyi" | "act";

/** The raw `inbox_status` row — COUNTS only. Mirrors `inbox::InboxStatus` field for field. */
export interface InboxStatusRow {
  agentId: string;
  pending: number;
  delivered: number;
  acknowledged: number;
  awaitingAck: number;
  pendingIds: string[];
  /**
   * `ts` of the OLDEST still-pending record — the one signal here that retention cannot reset
   * (bead sparkle-6yrvqd). See {@link RecipientQueue.notDraining} for why the counters above cannot
   * answer "is this recipient draining?": `reap_inbox` compacts the record file at 24h, so a
   * healthy agent reads `delivered: 0, acknowledged: 0` a day after its last delivery.
   *
   * `number | null`, NOT `number?`. It is `Option<i64>` in Rust, which serde emits as an explicit
   * `null` rather than omitting the key, and a TS `field?: T` excludes `null` — the exact seam
   * `AGENTS.md` documents, where the parser describes a shape the wire cannot produce. The `?` is
   * here too only so rows hand-built by existing fixtures keep compiling; read it with a finiteness
   * test and treat anything else as "cannot say".
   */
  oldestPendingMs?: number | null;
  /**
   * The ceilings `pending` is judged against — `inbox::FYI_CEILING` and `inbox::MAX_PER_AGENT`.
   *
   * CARRIED FROM RUST RATHER THAN RE-DECLARED HERE. Two literals in two packages are two numbers
   * that look like one and drift silently, which is the reason `peerMessaging.MESSAGE_MAX_CHARS`
   * re-exports rather than restates its cap. The ceilings are Rust's to decide — the reserve split
   * lives in `enqueue` — so the frontend reads them off the row it already fetches.
   *
   * `?:` HERE AND NON-`Option` IN RUST, deliberately, and the asymmetry is the safe direction. The
   * command always sends both (they are plain `u32`s, so nothing crosses as `null` and the
   * `field?: T` / `null` seam `AGENTS.md` documents cannot open). Optional on this side only so the
   * hand-built rows in existing fixtures keep compiling; read them with a `?? null` and report
   * "unknown" rather than inventing a ceiling.
   */
  fyiCeiling?: number;
  actCeiling?: number;
}

/**
 * WHAT A SENDER IS TOLD ABOUT THE RECIPIENT'S QUEUE — the answer to bead `sparkle-x4mnec`'s first
 * acceptance criterion, *"a sender can see the recipient's queue depth BEFORE being refused."*
 *
 * Depth used to exist in exactly one place: the text of a refusal. That is too late by construction
 * — the sender learns the queue was full from the message telling it the send did not happen, and a
 * sender that wanted to slow down, batch, or pick a different channel had nothing to read until it
 * was already refused. So this rides the SUCCESS receipt as well.
 *
 * `headroom` is the actionable half and the two classes differ, which is why both are named:
 *  - `fyiHeadroom` — sends left before the `fyi` ring buffer starts EVICTING the recipient's stalest
 *    `fyi` to admit the next one. Reaching zero is not a refusal (it has not been one since the ring
 *    buffer landed) — it is the point at which sending costs the recipient something it already had.
 *  - `actHeadroom` — sends left before an `act` is REFUSED outright. This one really is a wall.
 */
export interface RecipientQueue {
  /** Messages queued and not yet claimed by any delivery path. */
  pending: number;
  fyiCeiling: number;
  actCeiling: number;
  fyiHeadroom: number;
  actHeadroom: number;
  /**
   * THIS RECIPIENT IS NOT DRAINING — its oldest still-queued message has been waiting longer than
   * {@link NOT_DRAINING_AFTER_MS} (bead sparkle-6yrvqd).
   *
   * WHY AN AGE AND NOT THE COUNTERS, which is the whole correctness of this field. The obvious test
   * is `delivered === 0 && acknowledged === 0`, and it is WRONG: `inbox::status_of` computes both
   * counters by iterating the records still present in `<agent>.jsonl`, and `retention::reap_inbox`
   * compacts that file at `2 × MAX_AGE_MS` (24h). A long-lived, perfectly healthy agent that
   * delivered and acked yesterday therefore reads `0` on both today — so a counter-based test
   * accuses a WORKING recipient, with a remedy pointing at a `settings.local.json` that is
   * correctly configured. That is the same "an alarm on every send is an alarm nobody reads"
   * failure this warning exists to prevent, rebuilt one level up. (Caught in review before it
   * shipped; the first draft of this field made exactly that mistake and asserted the opposite in
   * its own doc comment.)
   *
   * The age cannot lie that way. The record it names is BY DEFINITION still in the file, because it
   * is one of the records being counted — retention removing it would remove the `pending` it is
   * derived from too. And it is what the copy actually claims: a drain runs at every turn boundary,
   * so a message pending far longer than any turn has had no boundary to ride.
   */
  notDraining: boolean;
  /** `ts` of the oldest still-queued message, or `null` when nothing is queued or the row is old. */
  oldestPendingMs: number | null;
  /** One sentence a language model can repeat to a human verbatim. */
  note: string;
}

/**
 * How long the oldest queued message must have waited before the receipt says the recipient is not
 * draining.
 *
 * TWO HOURS, chosen to sit above the longest plausible SINGLE TURN and far below the measured
 * failure. A drain rides the `Stop` hook, so the honest question is "has this agent reached a turn
 * boundary since the message arrived" — and turns here genuinely run long (the desktop unit stage
 * alone is ~22 minutes, and an agent can chain several such steps inside one turn). Crying wolf at
 * thirty minutes would fire on ordinary long work and train everyone to ignore the warning, which
 * is precisely how the real outage went unread for eleven and a half hours. The measured incident
 * had messages pending 11.6h, so this is not a close call in the direction that matters.
 */
const NOT_DRAINING_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * Build a {@link RecipientQueue} from a status row, or `null` when the row cannot tell us.
 *
 * `nowMs` DEFAULTS to the real clock rather than being a required parameter, and the default is
 * covered by its own test. A seam every caller supplies is a seam nothing drives: delete the
 * default and the suite stays green while production loses its clock (`AGENTS.md`, the defaulted
 * seam). It is injectable at all because the not-draining verdict is an AGE, and an age judged
 * against an untestable clock cannot be pinned in either direction.
 */
export function recipientQueueFromRow(
  row: InboxStatusRow | undefined | null,
  nowMs: number = Date.now(),
): RecipientQueue | null {
  if (!row) return null;
  const { pending, fyiCeiling, actCeiling } = row;
  // A row that carries no ceilings is a row from an older shape or a hand-built fixture. Reporting a
  // depth with no scale is worse than reporting nothing — 38 reads as fine or as one-from-eviction
  // depending on a number the caller cannot see — so refuse to guess.
  if (
    typeof pending !== "number" ||
    typeof fyiCeiling !== "number" ||
    typeof actCeiling !== "number"
  ) {
    return null;
  }
  const fyiHeadroom = Math.max(0, fyiCeiling - pending);
  const actHeadroom = Math.max(0, actCeiling - pending);
  // HOW LONG HAS THE OLDEST QUEUED MESSAGE WAITED? `Number.isFinite` rather than a truthiness test:
  // the field is `Option<i64>` in Rust and therefore arrives as `null` when nothing is queued, and
  // as `undefined` from a row minted before it existed. Neither is an age, and neither is evidence
  // — so an unreadable value means "cannot say", the same answer this function gives for a missing
  // ceiling, and never "not draining".
  const oldestPendingMs = Number.isFinite(row.oldestPendingMs)
    ? (row.oldestPendingMs as number)
    : null;
  const waitedMs = oldestPendingMs === null ? null : nowMs - oldestPendingMs;
  const notDraining = waitedMs !== null && waitedMs >= NOT_DRAINING_AFTER_MS && pending > 0;
  // THE LEAD CLAUSE, and it goes FIRST on purpose. A reader — human or model — takes the opening of
  // a receipt as its verdict, and the depth-and-headroom sentence below reads as routine bookkeeping
  // no matter what number it carries. The one thing a sender most needs to know is that its message
  // may reach nobody, so that has to displace the bookkeeping rather than trail it.
  const hoursWaited = waitedMs === null ? 0 : Math.floor(waitedMs / (60 * 60 * 1000));
  const notDrainingNote = !notDraining
    ? ""
    : `THIS RECIPIENT IS NOT DRAINING ITS INBOX: its oldest queued message has been waiting ` +
      `${hoursWaited}h and ${pending} are queued. A drain runs at every turn boundary, so a ` +
      "message waiting this long has had none — treat this send as UNLIKELY TO ARRIVE and use " +
      "another channel if it matters. The usual cause is that the recipient's worktree has no " +
      "`Stop` hook registered (bead sparkle-6yrvqd); check its `.claude/settings.local.json` for a " +
      "`sparkle-hook.mjs` entry. ";
  const depthNote =
    fyiHeadroom > 0
      ? `${pending} of this agent's messages are queued and undelivered; ${fyiHeadroom} more ` +
        `\`fyi\` send(s) fit before the oldest one starts being evicted to make room, and ` +
        `${actHeadroom} before an \`act\` is refused outright.`
      : `${pending} of this agent's messages are queued and undelivered, at or over the ` +
        `${fyiCeiling}-message \`fyi\` ceiling: the next \`fyi\` evicts this agent's stalest ` +
        "`fyi` to make room — UNLESS every queued slot holds an `act`, which an `fyi` may never " +
        `evict and which is refused outright. ${actHeadroom} \`act\` send(s) remain before an ` +
        "`act` is refused. Either way it is not reading what it already has — consider whether " +
        "another message helps.";
  return {
    pending,
    fyiCeiling,
    actCeiling,
    fyiHeadroom,
    actHeadroom,
    notDraining,
    oldestPendingMs,
    note: `${notDrainingNote}${depthNote}`,
  };
}

/**
 * How far one queued message has got. Mirrors `inbox::DeliveryState`.
 *
 * `InboxStatusRow` above COUNTS these; this names the stage of a SPECIFIC message, which is what a
 * human needs to check a "I sent it" claim rather than merely learn that two things are queued.
 */
export type DeliveryState = "pending" | "delivered" | "acknowledged";

/** One live message with its text and stage. Mirrors `inbox::InboxEntry`. */
export interface InboxEntry {
  id: string;
  ts: number;
  from: string;
  text: string;
  severity: InboxSeverity;
  state: DeliveryState;
  /** When the agent acknowledged, if it did. `null` in every other state. */
  ackedAt: number | null;
  /** The agent's own note on the ack, when it wrote one. */
  ackNote: string | null;
}

/** One agent's live inbox — every message still in flight. Mirrors `inbox::InboxView`. */
export interface InboxView {
  agentId: string;
  entries: InboxEntry[];
}

/**
 * One agent's row with its LIVE per-message entries attached.
 *
 * `entries` is `InboxEntry[] | null` and the two are NOT interchangeable: `[]` means the inbox was
 * read and nothing is in flight, `null` means the read FAILED and this row cannot answer "did that
 * message land?" at all. Collapsing unknown onto empty is the same lie this whole change removes —
 * it would let a caller read "no entries" as "nothing outstanding" when the truth is "nobody looked".
 * `entriesUnavailable` on the envelope carries the reason whenever any row is `null`.
 */
export interface InboxRowWithEntries extends InboxStatusRow {
  entries: InboxEntry[] | null;
}

/**
 * One recipient's outcome from a broadcast. Mirrors `inbox::BroadcastOutcome`, plus the same honest
 * enqueue vocabulary `inboxSend` returns — `inbox_broadcast` had the identical flaw, N times over.
 */
export interface BroadcastOutcome {
  agentId: string;
  messageId: string | null;
  error: string | null;
}

/** The stage a send has actually reached. There is deliberately no `"delivered"` member here: no
 *  send op can ever observe delivery, so no send op may name it. */
export type EnqueueState = "queued" | "not-queued";

/**
 * WHAT A SEND OP IS ALLOWED TO CLAIM.
 *
 * `inbox_send` writes a line to a queue. It does not hand anything to an agent — some OTHER path
 * (the `Stop` hook, or `fleetWatch`'s idle sweep) claims that line later, and either may lose it to
 * a foreign process draining the same queue. So the receipt must say what actually happened and
 * nothing more, and it must be UNREADABLE as a delivery confirmation by a language model that is
 * about to tell a human "I sent it".
 *
 * `delivered: false` is a LITERAL, not a boolean that might one day be true. Every field here is
 * load-bearing for a different failure of misreading:
 *  - `state: "queued"` — names the stage in words, for a reader that skims rather than parses.
 *  - `delivered: false` — the direct answer to the question the caller is actually about to answer.
 *  - `verifyWith` / `verifyArgs` — the follow-up call, ready to paste. A receipt that says "this is
 *    unconfirmed" without saying how to confirm it just relocates the problem to the caller.
 *  - `drainableBy` / `drainNote` — WHETHER ANYTHING WILL EVER DRAIN THE QUEUE. See below.
 */
export interface EnqueueReceipt {
  messageId: string;
  agentId: string;
  state: "queued";
  delivered: false;
  verifyWith: "fleet.inbox_status";
  verifyArgs: { agentIds: string[]; messageIds: string[] };
  /**
   * WHAT WILL HAND THIS MESSAGE OVER — the half of the honesty the first version was missing
   * (bead sparkle-rk0k8o).
   *
   * `state: "queued"` + `delivered: false` + "go ask `inbox_status`" is a receipt that is accurate
   * and still leaves the caller stuck: it says the message is not delivered YET, and gives no way to
   * learn that in this case it never will be. Measured — the concierge queued messages to idle
   * agents this window held no pane for, they were never handed over, `inbox_status` said `pending`
   * every time it was asked, and the sender lost time before giving up and using terminal sends.
   *
   * This is decided by the SAME predicate `fleetWatch` applies when the sweep tries to deliver
   * ({@link observedDrainerFor}), so the receipt cannot promise a drain the sweep will then refuse.
   * `"nothing-observable"` is the one that changes what a caller should do: escalate to a terminal
   * send, or open the pane, rather than wait.
   */
  drainableBy: ReceiptDrainer;
  /** One sentence a language model can repeat to a human verbatim. Scoped to THIS WINDOW's
   *  observation and never a claim about the agent — {@link DRAIN_NOTES}. */
  drainNote: string;
  /**
   * HOW DEEP THE RECIPIENT'S QUEUE IS, ON THE SUCCESS RECEIPT — see {@link RecipientQueue}.
   *
   * `drainableBy` answers *will anything ever pick this up*; this answers *how much is already in
   * front of it*, and they are different failures. A queue with a live drainer and thirty-nine
   * undrained messages in it is a channel that is technically working and practically useless, and
   * before this the only way to find that out was to keep sending until something was refused.
   *
   * `null` MEANS "COULD NOT READ IT", NEVER "EMPTY". The depth is a second, best-effort call made
   * after the write has already succeeded, and it is deliberately unable to fail the send: a
   * reporting concern must never turn a queued message into a refusal. A caller that reads `null`
   * knows only that it was not told.
   */
  recipientQueue: RecipientQueue | null;
}

/**
 * The drain path for a recipient. The two ids {@link inboxAddressableIds} admits WITHOUT a pane come
 * FIRST, exactly as they do there, because their queue is drained by something other than a PTY;
 * everything else is the observed-liveness question, unchanged.
 *
 * `observedDrainerFor` would answer `nothing-observable` for both — they have no `runtimeStore`
 * status entry in the ordinary case — and that answer is not conservative, it is WRONG, and wrong in
 * the way that does damage. The concierge has no PTY and no `Stop` hook at all: it drains its inbox
 * while assembling its own turn (`services/conciergeInbox`). Improve Sparkle drains through its
 * scheduled headless pass. So this is not an unknowable case where a false alarm merely costs a look
 * — it is a channel KNOWN to work, reported as dead, on every single send, contradicting
 * {@link undeliverableRecipient}'s own text three lines up. Worse, the remedy prose attached to
 * `nothing-observable` tells the caller to open a pane or use a terminal send, and the concierge has
 * neither: an instruction that cannot be followed, inviting a duplicate delivery on a channel that
 * was already working (the `sparkle-8bvh` shape — a remedy is an instruction the reader will act on,
 * so it must be safe under the very conditions that produced it).
 *
 * AND THE SPARKLE ARM IS CONDITIONAL, which is the whole reason this is a function rather than a set
 * (roborev 71174, High). "Improve Sparkle has its own channel" is true only while that channel is
 * SWITCHED ON: `improvementPass.passHoldReason` returns `consent-off` and the hourly headless pass
 * never runs when `sparkleImprovementConsent === "never"`, a persisted user setting. With consent off
 * and no pane open, NOTHING drains that inbox — and an unconditional `own-channel` would tell the
 * caller not to escalate, in exactly the state where escalating is the only thing that works. That is
 * the same defect as the `idle-sweep` promise this arm was written alongside: an affirmative claim
 * made from a predicate that cannot see one of the real drain path's gates. Here the gate IS
 * synchronously readable, so it is read rather than hedged in prose.
 *
 * The concierge has no such switch — it drains while assembling its own turn, unconditionally — so
 * that arm stays flat.
 */
function receiptDrainerFor(agentId: string): ReceiptDrainer {
  if (agentId === CONCIERGE_INBOX_ID) return "own-channel";
  if (agentId === SPARKLE_AGENT_ID && sparkleHeadlessPassEnabled()) return "own-channel";
  return observedDrainerFor(agentId);
}

/** Is Improve Sparkle's headless pass — its ONLY pane-less drain path — switched on? Mirrors
 *  `improvementPass.passHoldReason`'s first arm, which is the gate that actually holds the pass. */
function sparkleHeadlessPassEnabled(): boolean {
  return useSettingsStore.getState().sparkleImprovementConsent !== "never";
}

/**
 * What the receipt may name as the drain path. {@link QueueDrainer} plus the one arm that is NOT a
 * function of an observed status: a recipient whose queue is drained structurally rather than by a
 * pane. That arm is decided here rather than in `fleetWatch` on purpose — `fleetWatch` owns the
 * liveness rule and must not learn which ids are app-owned singletons.
 */
export type ReceiptDrainer = QueueDrainer | "own-channel";

/**
 * The sentence for each {@link ReceiptDrainer}.
 *
 * THE CONSTRAINT ON THE `nothing-observable` ONE, and it is load-bearing. A missing status entry
 * means this window cannot see a pane; it does NOT mean the agent is gone. The agent may be running
 * in another window, or headless. `engine/probeOutcome.ABSENCE_CLAIM_PATTERNS` is this repo's
 * lexicon for exactly that lie, and `fleet.test.ts` asserts `absenceClaimIn(note) === null` for
 * every note here. So: "this window cannot see a live pane" (an observation), never "that agent is
 * not running" (a claim about the world).
 *
 * THE CONSTRAINT ON THE `idle-sweep` ONE IS THE MIRROR, and it is the same defect pointing the other
 * way. A live resting pane is NECESSARY for the sweep to deliver and it is not SUFFICIENT: the
 * status axis is one of five gates in `fleetWatch.decideIdleDelivery`, which also refuses
 * `no-worktree`, `unobserved`, `never-reached-a-boundary`, `mid-turn` and `boundary-not-settled` —
 * two of them BEFORE it ever looks at the status. Those gates read the fleet digest, which this
 * synchronous receipt does not have and will not pay for. So the note says the sweep is the path and
 * that its other gates still apply; promising the hand-over outright would re-create the exact
 * silent loss this field exists to end, with an affirmative claim attached.
 */
export const DRAIN_NOTES: Readonly<Record<ReceiptDrainer, string>> = {
  "turn-boundary":
    "This window sees that agent mid-turn, so its own Stop hook should drain the queue when it " +
    "reaches its next turn boundary.",
  "idle-sweep":
    "This window sees a live resting pane, so the fleet watch's 30s idle sweep is the path — " +
    "subject to its other gates (a present worktree, an observed verdict, a settled boundary), " +
    "which this receipt does not check. Confirm with inbox_status rather than assuming.",
  "nothing-observable":
    "This window cannot see a live pane for that agent, so nothing here will hand the message " +
    "over; it will sit queued. Open the agent's pane, or use a terminal send, if it has to arrive.",
  "own-channel":
    "That recipient drains its own inbox through its own channel rather than through a pane — the " +
    "concierge while assembling its next turn, Improve Sparkle on its scheduled pass, which was " +
    "checked as switched on — so this one needs no open pane and no terminal send.",
};

/** A broadcast's per-recipient receipt: the raw outcome plus the same honest vocabulary. */
export interface BroadcastReceipt extends BroadcastOutcome {
  state: EnqueueState;
  delivered: false;
  verifyWith: "fleet.inbox_status";
}

export interface AgentRef {
  agentId: string;
  projectId: string;
}

/** A digest with the Level 0 verdicts already attached, so the concierge never re-derives them. */
export interface JudgedDigest extends FleetDigest {
  verdicts: FleetVerdict[];
  /** Agents whose verdict says escalate — the shortlist, so the obvious next question is answered. */
  escalate: string[];
}

// ---------------------------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------------------------

/** Turn an unknown thrown value into a refusal message. */
function detail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Accept an `inbox_peek` reply only if it is the shape we can actually answer from, and say so
 * loudly when it is not.
 *
 * THE SEAM RULE THIS ENFORCES (AGENTS.md). `InboxEntry` mirrors a Rust struct whose `ackedAt` and
 * `ackNote` are `Option<T>` — serde emits those keys with a `null` VALUE, never omits them — so a
 * reader that quietly dropped an entry it found surprising would answer "nothing is queued" for a
 * payload that in fact listed the message the caller is asking about. That is the original bug at the
 * verification step: silence read as an all-clear.
 *
 * So this validates the ENVELOPE (an array of `{agentId, entries[]}`) and refuses the whole reply
 * rather than any part of it. A refusal here becomes `entriesUnavailable` — an explicit "nobody could
 * look" — which is the one answer that cannot be mistaken for "nothing is outstanding".
 */
function parsePeek(raw: unknown): InboxView[] {
  const list = Array.isArray(raw) ? raw : null;
  if (list === null) {
    throw new Error(`inbox_peek returned ${typeof raw}, not an array of inbox views`);
  }
  for (const v of list) {
    const view = v as Partial<InboxView> | null;
    if (!view || typeof view.agentId !== "string" || !Array.isArray(view.entries)) {
      throw new Error("inbox_peek returned a view without an agentId and an entries array");
    }
  }
  return list as InboxView[];
}

/**
 * LEVEL 0. One call, every agent, artifacts only.
 *
 * `ctxFor` supplies what the artifacts cannot know — how the fleet is currently RENDERING each
 * agent, and whether it has an unmet goal. Both are owned elsewhere (`engine/buildSections.ts`,
 * `engine/agentGoal.ts`) and are passed in rather than re-derived, so this surface never becomes a
 * second opinion about a question another module already answers.
 */
export async function fleetDigest(
  agents: AgentRef[],
  opts: { baseBranch?: string; windowMs?: number } = {},
  ctxFor: (agentId: string) => { renderedTerminal?: boolean; hasUnmetGoal?: boolean } = () => ({}),
): Promise<FleetResult<JudgedDigest>> {
  if (agents.length === 0) {
    return refuse(
      "fleet_digest",
      "no-agents",
      "Name at least one agent as { agentId, projectId }. Every agent you can see in get_state has both.",
    );
  }
  try {
    const digest = await invoke<FleetDigest>("fleet_digest", {
      agents,
      baseBranch: opts.baseBranch,
      windowMs: opts.windowMs,
    });
    const verdicts = verdictsFor(digest, ctxFor);
    return ok("fleet_digest", {
      ...digest,
      verdicts,
      escalate: verdicts.filter((v) => v.shouldEscalate).map((v) => v.agentId),
    });
  } catch (e) {
    return refuse("fleet_digest", "digest-failed", detail(e));
  }
}

/**
 * LEVEL 1. An agent's COMPLETE hook stream, paged.
 *
 * Contrast `read_agent_terminal`, which caps at 4000 characters, keeps the tail, and says nothing
 * about the front it dropped — in practice losing 6k and then 12k characters mid-investigation,
 * which is exactly the content an agent writes when it has something important to say. Here a
 * truncated read is always accompanied by `nextCursor` and `remainingBytes`.
 */
export async function readAgentStream(
  agentId: string,
  cursor?: number,
  maxBytes?: number,
): Promise<FleetResult<StreamPage>> {
  try {
    return ok(
      "read_agent_stream",
      await invoke<StreamPage>("fleet_read_hook_stream", { agentId, cursor, maxBytes }),
    );
  } catch (e) {
    return refuse("read_agent_stream", "stream-unreadable", detail(e));
  }
}

/**
 * LEVEL 1. A Claude Code session transcript, paged.
 *
 * The path is not guessed: `fleet_digest` carries `hooks.transcriptPath` for every agent, taken
 * from its own `Stop` hook lines. The Rust side confines the read to `~/.claude/projects` because
 * that value originates outside our trust boundary.
 */
export async function readAgentTranscript(
  transcriptPath: string,
  cursor?: number,
  maxBytes?: number,
): Promise<FleetResult<StreamPage>> {
  if (!transcriptPath.trim()) {
    return refuse(
      "read_agent_transcript",
      "no-path",
      "Pass the `transcriptPath` from that agent's fleet_digest entry (hooks.transcriptPath). " +
        "If it is null the agent has not completed a turn yet, so there is no transcript to read.",
    );
  }
  try {
    return ok(
      "read_agent_transcript",
      await invoke<StreamPage>("fleet_read_transcript", { transcriptPath, cursor, maxBytes }),
    );
  } catch (e) {
    return refuse("read_agent_transcript", "transcript-unreadable", detail(e));
  }
}

/**
 * LEVEL 2. ENQUEUE one non-interrupting message. This does NOT deliver it.
 *
 * THE BUG THIS SHAPE EXISTS TO PREVENT (sparkle-ei7keg). This used to answer `{ messageId }` and
 * nothing else. That is an enqueue receipt wearing a delivery receipt's clothes: an id looks like
 * proof, `ok: true` looks like success, and the caller is a language model whose very next act is to
 * tell a human what it did. It told the founder that seven instructions were delivered. A foreign
 * `claude` process sharing the worktree had drained and acked the queue before the real agent ever
 * reached a turn boundary, so five of the seven reached nobody, and the receipt could not have shown
 * that because it did not carry a single field that could ever have been false.
 *
 * The rule, stated by the founder: *a tool must not return success for work that has not happened.
 * If a call only ENQUEUES something, its result must say so in a way the caller cannot mistake for
 * delivery — and there must be a way to later ask "did it actually land?"* Hence [`EnqueueReceipt`],
 * whose `verifyArgs` is that later question, pre-filled.
 *
 * The `ok: true` envelope is still correct and is not the lie: the ENQUEUE really did happen, and
 * `enqueue` reads the record back before returning an id, so a failed queue write is a refusal. What
 * `ok` never meant — and now cannot be read as meaning — is that an agent has seen the text.
 */
export async function inboxSend(
  agentId: string,
  text: string,
  severity: InboxSeverity = "fyi",
): Promise<FleetResult<EnqueueReceipt>> {
  // DELIVER-OR-FAIL (bead sparkle-179b2s). Resolve the recipient against the fleet directory BEFORE
  // the Rust hop: `enqueue` writes into any well-formed id's file whether or not anything drains it,
  // so a typo'd/closed id would otherwise come back `ok:true` with a real messageId for a message no
  // one will ever read. Refuse loudly, naming the id, and enqueue NOTHING.
  if (!inboxAddressableIds().has(agentId)) {
    return undeliverableRecipient("inbox_send", agentId);
  }
  try {
    const messageId = await invoke<string>("inbox_send", { agentId, text, severity });
    // WILL ANYTHING EVER DRAIN THIS? Asked AFTER the write, of the same seam `fleetWatch` reads (plus
    // the pane-less arm above), so the receipt reports what the sweep would decide rather than a
    // second opinion about liveness.
    const drainableBy = receiptDrainerFor(agentId);
    return ok("inbox_send", {
      messageId,
      agentId,
      state: "queued",
      delivered: false,
      verifyWith: "fleet.inbox_status",
      verifyArgs: { agentIds: [agentId], messageIds: [messageId] },
      drainableBy,
      drainNote: DRAIN_NOTES[drainableBy],
      // AND HOW DEEP THE QUEUE IS — read AFTER the write, so the number includes this message and is
      // the depth the NEXT sender would be judged against. Best-effort by construction; see
      // `readRecipientQueue`.
      recipientQueue: await readRecipientQueue(agentId),
    });
  } catch (e) {
    // A REFUSAL CARRIES THE DEPTH TOO. Rust's capacity refusals already name it, but a queue-write
    // failure does not, and a caller that has just been refused is exactly the one that needs to know
    // whether the recipient is at 3 or at 40 before deciding what to do next.
    const queue = await readRecipientQueue(agentId);
    const suffix = queue ? ` ${queue.note}` : "";
    return refuse("inbox_send", "queue-failed", `${detail(e)}${suffix}`);
  }
}

/**
 * Read the recipient's queue depth. Returns `null` — never a fabricated zero — when it cannot.
 *
 * BEST-EFFORT, AND THAT IS THE WHOLE CONTRACT. Every caller invokes this AFTER the decision the send
 * turned on has already been made, so it must not be able to change that decision: it swallows its
 * own failure, exactly as `handleSendPeerMessage` places its display append after the one call that
 * can fail. A depth read that could refuse a message already sitting in the recipient's queue would
 * report a delivery as a failure, which is the inversion this whole area of the code exists to
 * prevent.
 */
export async function readRecipientQueue(agentId: string): Promise<RecipientQueue | null> {
  try {
    const rows = await invoke<InboxStatusRow[]>("inbox_status", { agentIds: [agentId] });
    // `Array.isArray` rather than optional chaining: this reads a wire payload, and a non-array
    // answer must produce "unknown" rather than throwing inside a path that has already succeeded.
    if (!Array.isArray(rows)) return null;
    return recipientQueueFromRow(rows.find((r) => r?.agentId === agentId) ?? rows[0]);
  } catch {
    return null;
  }
}

/**
 * LEVEL 2. Queue the same message for many agents.
 *
 * Partial failure is reported per agent rather than failing the whole call, so one agent with a full
 * inbox cannot silently prevent the other deliveries.
 *
 * A BROADCAST THAT QUEUED NOTHING IS A REFUSAL, NOT AN `ok` WITH A ZERO IN IT (sparkle-bbghz's rule
 * applied one layer up). `enqueue` now reads each message back before returning an id, so the Rust
 * side is honest per agent — but this wrapper flattened N honest failures into `ok: true` with a
 * `failed` count the caller had to notice on its own. The caller is a language model that has just
 * been asked to instruct a fleet, and `ok: true` is exactly the evidence it uses to tell a human it
 * did. That is the same defect as the bug this pair of beads is about, arriving through the batch
 * path: a positive acknowledgement for something that did not happen.
 *
 * PARTIAL SUCCESS STAYS `ok`, deliberately — some agents really were reached, and refusing the whole
 * call would misreport those as failures and invite a re-send that double-queues them. It carries
 * `failedAgents` so the caller can name who was missed without walking `outcomes` itself; the reason
 * text is already per-agent inside `outcomes`.
 */
export async function inboxBroadcast(
  agentIds: string[],
  text: string,
  severity: InboxSeverity = "fyi",
): Promise<
  FleetResult<{
    outcomes: BroadcastReceipt[];
    queued: number;
    failed: number;
    failedAgents: string[];
    queuedIds: string[];
    state: "queued";
    delivered: false;
    verifyWith: "fleet.inbox_status";
    verifyArgs: { agentIds: string[]; messageIds: string[] };
  }>
> {
  if (agentIds.length === 0) {
    return refuse("inbox_broadcast", "no-recipients", "Name at least one agentId to broadcast to.");
  }
  // DELIVER-OR-FAIL, PER RECIPIENT (bead sparkle-179b2s). Partition against the fleet directory BEFORE
  // the Rust hop. This is the single-send hole N times over and the worse half — a caller reads forty
  // ids as proof of a fleet-wide delivery — so an id nothing drains must never reach `enqueue` and
  // must never receive a messageId. It becomes a `not-queued` outcome that names WHY, sitting beside
  // the real ones, so the counts and the `none-queued` refusal below stay honest.
  const addressable = inboxAddressableIds();
  const deliverable = agentIds.filter((id) => addressable.has(id));
  const undeliverableOutcomes: BroadcastReceipt[] = agentIds
    .filter((id) => !addressable.has(id))
    .map((agentId) => ({
      agentId,
      messageId: null,
      error: undeliverableRecipient("inbox_broadcast", agentId).message,
      state: "not-queued",
      delivered: false,
      verifyWith: "fleet.inbox_status",
    }));
  try {
    // Only addressable ids cross the wire; an all-undeliverable broadcast skips Rust entirely.
    const raw = deliverable.length
      ? await invoke<BroadcastOutcome[]>("inbox_broadcast", {
          agentIds: deliverable,
          text,
          severity,
        })
      : [];
    // EVERY RECIPIENT'S ROW CARRIES THE SAME HONEST VOCABULARY `inboxSend` returns. A fan-out is the
    // single-send bug N times over, and it is the WORSE half: a caller that reads one `messageId` as
    // proof of delivery reads forty of them as proof of a fleet-wide delivery.
    const outcomes: BroadcastReceipt[] = [
      ...raw.map(
        (o): BroadcastReceipt => ({
          ...o,
          state: o.messageId !== null ? "queued" : "not-queued",
          delivered: false,
          verifyWith: "fleet.inbox_status",
        }),
      ),
      ...undeliverableOutcomes,
    ];
    const queued = outcomes.filter((o) => o.messageId !== null).length;
    const failedOutcomes = outcomes.filter((o) => o.messageId === null);
    if (queued === 0) {
      return refuse(
        "inbox_broadcast",
        "none-queued",
        `Nothing was queued. ${failedOutcomes.length} of ${outcomes.length} agent(s) rejected the ` +
          `message and none accepted it, so no agent has been told anything:\n` +
          failedOutcomes
            .map((o) => `  ${o.agentId}: ${o.error ?? "no message id returned"}`)
            .join("\n"),
      );
    }
    const queuedIds = outcomes.flatMap((o) => (o.messageId !== null ? [o.messageId] : []));
    return ok("inbox_broadcast", {
      outcomes,
      queued,
      // Counted off `messageId`, not off `error`. They agree today, but a message id is what a caller
      // would USE as proof of a send — so the count of failures must be the count of agents that have
      // no id, never the count that happened to carry an error string.
      failed: failedOutcomes.length,
      failedAgents: failedOutcomes.map((o) => o.agentId),
      // …and the envelope repeats the vocabulary, because `queued: 40` is exactly the field a summary
      // reads as "40 agents were told". It counts QUEUE WRITES. Nobody has been told anything yet.
      queuedIds,
      state: "queued",
      delivered: false,
      verifyWith: "fleet.inbox_status",
      verifyArgs: {
        agentIds: outcomes.filter((o) => o.messageId !== null).map((o) => o.agentId),
        messageIds: queuedIds,
      },
    });
  } catch (e) {
    return refuse("inbox_broadcast", "broadcast-failed", detail(e));
  }
}

/**
 * LEVEL 2. THE ANSWER TO "did message <id> actually land?" — and the op every send receipt points at.
 *
 * `awaitingAck` is DELIVERY CONFIRMATION, never liveness. An agent that has been delivered to but
 * has not acked is an agent not reaching turn boundaries — which `fleet_digest` already showed for
 * free. It is not a reason to message it again.
 *
 * WHY THIS GREW PER-MESSAGE ENTRIES (sparkle-ei7keg). It used to return COUNTS per agent, and counts
 * cannot answer the only question a caller who has just sent something actually has. "3 pending, 1
 * delivered" does not say WHICH, so an agent handed seven instructions of which five vanished reads
 * exactly like one handed seven of which five are merely still queued. `pendingIds` named uuids with
 * no state and no text beside them, which is a list, not an answer.
 *
 * IT READS, IT NEVER CLAIMS — and that is the property, not a detail. `inbox_peek` is Rust-side
 * read-only by construction (`inbox.rs::entries_of`, which opens no file for writing). If this op
 * claimed, then *looking* would BE a delivery path: a UI poll, or a concierge double-checking its own
 * send, would consume messages no agent ever saw — which is this very bug, reintroduced by its own
 * fix. Any future edit that makes this write is a regression of the bead it closes.
 *
 * ONE READER, NOT TWO. The per-message states come from `entries_of` via the existing `inbox_peek`
 * command rather than from a second implementation here. Two readers of the same claim files WILL
 * drift, and a badge and a watchdog telling the founder different stories about one send is the exact
 * class of defect this change is about.
 *
 * `messageIds` NARROWS THE ENTRIES, NOT THE ROWS. Every requested agent still comes back with its
 * counts, so a filtered call cannot silently drop an agent and read as "that agent has nothing".
 * Ids that match no live entry are reported in `notFound` rather than omitted — an id missing from
 * the live queue is worth saying out loud. Read `notFound`'s own doc before relaying it to a human:
 * it means "not in the live queue", NOT "never arrived", because the live view drops acknowledged
 * records at 12h just as it drops pending ones.
 */
export async function inboxStatus(
  agentIds: string[],
  messageIds?: string[],
  /**
   * Read the live per-message entries too. OFF by default because the entries cost a second
   * per-agent read of `messages.jsonl` + `acks.jsonl` + the claims dir, and the hottest caller
   * (`fleetWatch`, ~10s beat) throws them away — see the cost note at the call below. Implied by a
   * non-empty `messageIds`, since a per-message question cannot be answered from counts.
   */
  withEntries = false,
): Promise<
  FleetResult<{
    rows: InboxRowWithEntries[];
    awaitingAck: number;
    /** Echo of the filter, so a caller can see what was actually asked. `null` when unfiltered. */
    queriedIds: string[] | null;
    /**
     * Requested ids that are in NO agent's LIVE inbox. That is a statement about the queue, and
     * deliberately NOT a statement about delivery — saying more here would re-commit this whole
     * change's defect with the sign flipped.
     *
     * WHY IT CANNOT MEAN "NEVER ARRIVED", WHICH IS WHAT IT USED TO SAY. `entries_of`
     * (`inbox.rs`) omits every record past `MAX_AGE_MS` (12h) REGARDLESS OF STATE — pending,
     * delivered and acknowledged alike, by design, because it answers "what is still in flight".
     * So a message the agent genuinely received and ACKED yesterday lands in `notFound` today. The
     * old contract ("either way the message will not be delivered") therefore reported a confirmed
     * delivery as having reached nobody — the exact misreport this op exists to prevent, inverted.
     * A concierge asked at 22:00 with a 09:00 receipt would have told the founder his instruction
     * was never received.
     *
     * So an id in here means one of three things and this op cannot tell them apart: never queued;
     * queued and still undelivered but aged out; or delivered, possibly acked, and aged out. Ask
     * within 12h and the answer is unambiguous; after that, treat it as "no longer in the queue"
     * and nothing more. Making it decidable needs the Rust side to expose acked ids, which live in
     * `acks.jsonl` independently of the entry TTL — filed as a follow-up, not faked here.
     *
     * Empty when unfiltered, and empty (not exhaustive) when `entriesUnavailable` is set.
     */
    notFound: string[];
    /**
     * Why the per-message entries are absent for the WHOLE CALL, or `null` when the peek ran. It
     * distinguishes the two call-level reasons: the read FAILED, or the caller did not ask
     * (`withEntries` off — `fleetWatch`'s poll). Either way the counts are still true and this call
     * cannot answer "did it land?"; saying which is the point, because "nobody looked" must never
     * be readable as "nothing is outstanding".
     *
     * IT IS NOT A BICONDITIONAL WITH `rows[].entries`, and claiming so was wrong. A PARTIAL peek —
     * one that answered for some agents and not others — leaves that agent's `entries` at `null`
     * while this stays `null`, because the call as a whole succeeded. So: this being non-null tells
     * you no row could be read; this being `null` does NOT promise every row has entries. Check the
     * row. (A per-row reason would make the biconditional true and is the better shape; not built.)
     */
    entriesUnavailable: string | null;
  }>
> {
  if (agentIds.length === 0) {
    return refuse("inbox_status", "no-agents", "Name at least one agentId.");
  }
  try {
    const rows = await invoke<InboxStatusRow[]>("inbox_status", { agentIds });

    // THE PEEK IS OPT-IN, AND THAT IS A COST DECISION WITH A MEASURED REASON. `entries_of` re-reads
    // `messages.jsonl` and `acks.jsonl` and stats the claims dir PER AGENT — roughly the same I/O
    // `status_of` just did — so issuing it unconditionally doubles the per-agent inbox read cost of
    // every caller. `fleetWatch` is the caller that matters: it drives this op on a ~10s beat over
    // the idle candidates, plus again on each `claimBlockedOrLost` / `claimRejectionOutcome`
    // re-read, and it discards `entries` entirely (`return r.data.rows`). Its own module header
    // records that loop having been profiled at 30.5% of process CPU, so doubling its disk work for
    // a payload nobody reads is not a rounding error.
    //
    // The second cost is context, not CPU: an UNFILTERED concierge `inbox_status` over N agents
    // serialises every live message BODY (up to 50 pending each, plus everything delivered or acked
    // inside 12h) straight into the model through `fromFleet`, uncapped.
    //
    // So the concierge path asks for entries (registry.ts) and `fleetWatch` does not. Asking for a
    // `messageIds` filter implies wanting entries — you cannot answer "did m2 land?" from counts —
    // so that turns the peek on by itself and no caller has to know to pass both.
    const wantEntries = withEntries || (messageIds !== undefined && messageIds.length > 0);

    // The peek is caught SEPARATELY and never fails the whole call. `fleetWatch` drives this op on a
    // ~10s beat and its idle-delivery path is the app-side fallback that makes the queue safe at all;
    // turning an unreadable peek into a refusal would take that fallback out over the strictly-extra
    // half of the answer. A `null` that says "nobody looked" is honest; losing delivery is not.
    let views: InboxView[] | null = null;
    let entriesUnavailable: string | null = wantEntries
      ? null
      : "entries were not requested by this caller (withEntries off) — the counts are exact, but " +
        "nothing here can answer whether a specific message landed";
    try {
      // NOT PEEKING IS NOT THE SAME AS PEEKING AND FINDING NOTHING. A caller that did not ask keeps
      // `entries: null` — the "nobody looked" value — rather than `[]`, so the distinction this
      // whole change turns on survives the optimisation instead of being quietly collapsed by it.
      views = wantEntries ? parsePeek(await invoke<unknown>("inbox_peek", { agentIds })) : null;
    } catch (e) {
      views = null;
      entriesUnavailable = detail(e);
    }

    const wanted = messageIds && messageIds.length > 0 ? new Set(messageIds) : null;
    const byAgent = new Map(views?.map((v) => [v.agentId, v.entries]) ?? []);
    // NOT `withEntries` — that is the parameter above, and a `const` of the same name in this scope
    // puts it in the temporal dead zone, so every read of the parameter earlier in the block throws
    // a ReferenceError that the enclosing try turns into a blanket `status-failed` refusal.
    const rowsWithEntries: InboxRowWithEntries[] = rows.map((r) => {
      // `null` is UNKNOWN, `[]` is READ-AND-EMPTY. An agent the peek did not answer for keeps `null`
      // rather than borrowing the empty array that would read as "nothing outstanding".
      const live = byAgent.get(r.agentId);
      if (live === undefined) return { ...r, entries: null };
      if (wanted === null) return { ...r, entries: live };
      return { ...r, entries: live.filter((e) => wanted.has(e.id)) };
    });

    const seen = new Set(views?.flatMap((v) => v.entries.map((e) => e.id)) ?? []);
    return ok("inbox_status", {
      rows: rowsWithEntries,
      awaitingAck: rows.filter((r) => r.awaitingAck > 0).length,
      queriedIds: wanted ? [...wanted] : null,
      notFound: wanted && views !== null ? [...wanted].filter((id) => !seen.has(id)) : [],
      entriesUnavailable,
    });
  } catch (e) {
    return refuse("inbox_status", "status-failed", detail(e));
  }
}

export type { FleetAgentFacts, FleetDigest, FleetVerdict };
