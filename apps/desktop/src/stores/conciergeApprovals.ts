// THE HUMAN HALF of the per-tool autonomy policy — the pending-approval ledger that makes
// `ask` mean something.
//
// services/conciergeTools/policy.ts can already say `ask`, and services/dispatchAuthority already
// refuses to mint an authority for an ask-tier call unless `approvedByUser === true`. Nothing could
// ever produce that `true`, so every tool the human set to "Ask first" was permanently DEAD and the
// refusal promised a prompt that did not exist. This module is the missing prompt's memory.
//
// ---------------------------------------------------------------------------------------------
// WHY THIS IS A LEDGER AND NOT A PROMISE — the shape is forced by how the concierge runs.
//
// The concierge brain is a headless `claude -p` child, ONE PROCESS PER TURN. It does not sit around
// waiting on a deferred; the turn ends when the process exits. A tool call that blocked on a human
// would therefore hold the whole turn — and the bridge's round trip (src-tauri/src/bridge.rs
// ROUNDTRIP_TIMEOUT, 600s) — hostage on a human who may be asleep.
//
// So dispatch NEVER awaits. An ask-tier call is refused IMMEDIATELY with an honest sentence ("I've
// asked — approve it and tell me to go ahead"), and the human's answer is recorded HERE so the
// NEXT turn's retry can spend it. That is the whole reason this file exists: the answer has to
// outlive the process that asked the question.
//
// ---------------------------------------------------------------------------------------------
// THE ONE HARD PART: an approval must survive a retry WITHOUT becoming a standing grant.
//
// `toolCallId` is minted fresh per call by the MCP server (`randomUUID()` in
// apps/mcp-control/src/tools.ts — never supplied by the model), which is exactly what makes it
// trustworthy and exactly what makes it useless as the retry's key: the retry is a different call
// with a different id. Keying the grant on the id alone would mean no approval is ever spendable.
// Keying it on the OP alone would mean "approve this discard" silently became "may always discard".
//
// Neither, therefore. A grant is claimed by (id) OR by IDENTITY — the domain, the op, AND the exact
// arguments the human was shown, canonicalised. So the retry can spend it only by asking for the
// very thing that was approved: `discard_agent(agentId: X)` cannot redeem an approval given for
// `discard_agent(agentId: Y)`. And it is spendable EXACTLY ONCE (`spent`), inside a bounded window
// ({@link APPROVAL_GRANT_TTL_MS}), after which it is gone. Approving something twice takes being
// asked twice.
//
// Matching on model-supplied argument text is safe here because it is a MATCH REQUIREMENT, never a
// trust decision: the args narrow what a grant can be spent on, they never widen it.
//
// ---------------------------------------------------------------------------------------------
// WHAT IS AND IS NOT A HUMAN GESTURE.
//
// {@link approveApproval} is called from ONE place: the button in the concierge column. Nothing in
// the tool path may call it. In particular the domains' own `confirm: true` flags and
// `DISCARD_CONFIRM_TOKEN` are NOT approval — they arrive inside the MODEL's tool arguments, so
// honouring them would let the model approve itself. That confused deputy is precisely what
// services/dispatchAuthority exists to prevent (note it deliberately has no `router` arm), and this
// module does not reopen it.
//
// FAIL CLOSED, everywhere. A blank id, an unknown id, an expired entry, a denied entry, an entry
// already spent, or a fingerprint that does not match all yield `false` from {@link claimApproval}.
// There is no path through this file that returns `true` without a human having pressed a button.
import { create } from "zustand";

import type { ConciergeRiskClass } from "../services/conciergeTools/policy";
// TYPE ONLY — the derivation lives beside the registry that produces the arguments it reads, so
// there is one definition of what a subject is rather than a copy on each side of the seam.
import type { ApprovalSubject } from "../services/conciergeTools/approvalSubject";
// The concierge's drainable event log. Imported for ONE purpose: to announce that a question
// reached the human and that they answered it. Nothing is read back from it, and nothing in this
// file's behaviour depends on it — see `emitApprovalEvent`.
import {
  recordConciergeEvent,
  type ApprovalRequestedEvent,
  type ApprovalResolvedEvent,
} from "./conciergeEventLog";

/** The only two payloads this module ever emits. */
type ApprovalEventPayload = ApprovalRequestedEvent | ApprovalResolvedEvent;

// ---------------------------------------------------------------------------------------------
// Windows and bounds
// ---------------------------------------------------------------------------------------------

/** How long an UNANSWERED prompt sits in the column before it lapses. Long enough to step away
 *  from the desk and come back, short enough that yesterday's question can't be answered today. */
export const APPROVAL_REQUEST_TTL_MS = 10 * 60_000;

/**
 * How long a human's YES stays spendable, measured from the moment they pressed the button.
 *
 * A separate (and shorter) window from the request TTL on purpose. The grant's job is to bridge one
 * gap — the human approves, says "go ahead", and the next `claude -p` turn retries — which takes
 * seconds. Anything longer is a standing permission wearing a timer, and standing permission is
 * what the Settings override is for.
 */
export const APPROVAL_GRANT_TTL_MS = 5 * 60_000;

/** Hard cap on retained entries. Resolved ones are evicted first; a pending one is only dropped
 *  when the ledger is entirely pending, which takes a runaway caller rather than ordinary use. */
export const MAX_RETAINED_APPROVALS = 50;

/** Longest argument value rendered in the prompt. A model can put a whole file in a `text`
 *  argument; the card has to stay a card. */
export const ARG_VALUE_MAX_CHARS = 220;

/** Argument names whose VALUE is never shown. Nothing in the concierge tool surface takes a
 *  credential today — this is here so that adding one is not also a leak into the UI. */
const SECRETISH_KEY = /(token|secret|password|passphrase|credential|api[-_]?key|\bkey\b)/i;

// ---------------------------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------------------------

/** Where an entry has got to. `pending` is the only state the column renders. */
export type ApprovalOutcome = "pending" | "approved" | "denied" | "expired";

/** Re-exported so a card or its container has ONE import for everything on a ledger entry, rather
 *  than reaching into the tool registry for a type it only ever reads off an approval. */
export type { ApprovalSubject };

/** One `name: value` line of the "here is what I would run" block. */
export interface ApprovalArgLine {
  key: string;
  /** Already truncated and redacted — safe to render verbatim. */
  value: string;
}

/** Everything the prompt needs to state plainly what is about to happen. Assembled by the policy
 *  binding from `policy.ts`'s own tables; no prose is invented here or in the card. */
export interface ConciergeApprovalRequest {
  /** The MCP-minted `toolCallId` (or, for the legacy sparkle-control ops, the Rust-minted `reqId`).
   *  NEVER a model-supplied string — see the header. */
  id: string;
  /** `lifecycle` | `terminal` | `workflow` | `workspace` | `app`. */
  domain: string;
  op: string;
  /** The catalog's one-line description of the tool (policy.ts `ConciergeToolEntry.summary`). */
  summary: string;
  /** Null only for a tool the policy layer does not classify — which resolves to `deny` and so
   *  never reaches here in practice. */
  riskClass: ConciergeRiskClass | null;
  /** The risk map's own note (policy.ts `CONCIERGE_RISK_NOTE`). */
  riskNote: string;
  /** Display-safe argument lines. Build with {@link describeApprovalArgs}. */
  args: readonly ApprovalArgLine[];
  /**
   * The model's RAW arguments, retained verbatim — never rendered.
   *
   * Held so that approving can REPLAY the exact call the human was shown, rather than authorising a
   * re-issue the model has to compose from memory. That distinction is the whole bug this field
   * exists to close: `args` above is display-safe (truncated at {@link ARG_VALUE_MAX_CHARS},
   * secret-ish values masked), so it is lossy by design and cannot be executed. Without a verbatim
   * copy, the only way to spend an approval was for the model to retype every argument
   * byte-identically on a later turn so {@link approvalFingerprint} matched — which is fine for
   * `{projectId: "p1"}` and effectively impossible for a multi-paragraph `text:` brief. Those calls
   * could be approved but never actually run.
   *
   * NOT a widening of authority: this is the same value the fingerprint was computed from, so a
   * replay can only ever be the call the human read and agreed to.
   */
  rawArgs: unknown;
  /**
   * Did this call carry the FOUNDER'S OWN WORDS — judged when the approval was RAISED, which is the
   * only moment anyone can still tell (bead `sparkle-p9s5q`, roborev 64197).
   *
   * WHY IT HAS TO BE CAPTURED HERE. Approving RUNS the call from a click handler, arbitrarily long
   * after the requesting turn ended — and `services/relayDerivation`'s question is asked against the
   * turn's own text, which by then has been dropped. So the resumed call cannot re-derive this; it
   * can only carry what the first call worked out.
   *
   * It matters because the receipt line now states AUTHORSHIP. Without this field an approved,
   * genuine relay of his words settles with the flag absent and renders "Concierge wrote to @X" —
   * an affirmative claim that the concierge composed something it merely forwarded, on the path MOST
   * terminal sends take (`send_to_agent_terminal` is `disruptive`, so its default decision is `ask`).
   * The old wording was neutral, so this is not a withheld claim but a wrong one.
   *
   * Absent means "no relay claim", matching every other fail-closed reader of this verdict.
   */
  relayedFounderWords?: true;
  /**
   * WHAT this call would act on — the fact the card used to be missing (bead `sparkle-jjm27e`).
   *
   * The founder's complaint was that a card reading `workflow.merge_pr` / `projectId ed5d0ece-…` /
   * `prNumber 2165` states the tool's internal name and a raw uuid, neither of which he can act on,
   * while omitting the one thing he needs: WHICH BUILD AGENT the work belongs to, clickable. This
   * field is the durable half of that answer — a REFERENCE to the subject, resolved to a live pill
   * by the container at render time (components/Concierge/ConciergeApprovals).
   *
   * STAMPED AT RAISE, for the same reason as {@link relayedFounderWords} above: approving runs the
   * call from a click handler arbitrarily long after the requesting turn ended. Deriving it there
   * would mean re-reading {@link rawArgs} — untyped model JSON — inside the view, which is exactly
   * the raw-args coupling this change removes.
   *
   * DERIVED FROM UNTRUSTED ARGUMENTS. On the registry path the dispatch has validated them first,
   * but `resolveAskTier`'s other caller (`controlOpPolicy`, behind `appOpPolicy`/`chiefOpPolicy`)
   * has no schema at all — see {@link ApprovalSubject}'s module for why its guards are load-bearing
   * rather than redundant.
   *
   * ABSENT means the op names neither an agent nor a pull request, which is ordinary — the card
   * falls back to the catalog summary it already renders. It does NOT mean "no owner": an
   * unresolvable OWNER is rendered as "owner unresolved" beside a subject that is present.
   */
  subject?: ApprovalSubject;
  /** `concierge.tools.<op>` — named in the card so "stop asking me" is one click from discoverable. */
  configPath: string;
  /** Canonical identity of this exact call. Build with {@link approvalFingerprint}. */
  fingerprint: string;
  /**
   * True when an identical call ALREADY RAN moments ago off a human's approval.
   *
   * The card says so. This is what makes a deliberate repeat possible without making an accidental
   * one easy: the human is told the thing already happened and decides, rather than the clock
   * deciding for them (roborev 54729, finding 1 — an earlier version refused these outright while
   * telling the human to "ask again if you did mean to do it twice", which produced the same
   * fingerprint and the same refusal, so the remedy it named did not exist).
   */
  ranRecently?: boolean;
}

export interface ConciergeApproval extends ConciergeApprovalRequest {
  requestedAt: number;
  /** When this entry stops counting — the request window while pending, the grant window once
   *  approved. */
  expiresAt: number;
  outcome: ApprovalOutcome;
  /** When the human answered. Null while pending. */
  resolvedAt: number | null;
  /** True once a dispatch has SPENT this approval. Single-use, permanently. */
  spent: boolean;
}

interface ConciergeApprovalsState {
  /** Insertion order, oldest first. An array rather than a map because every operation here is a
   *  scan over at most {@link MAX_RETAINED_APPROVALS} entries and the order is load-bearing (the
   *  column renders oldest-first, and a fingerprint claim spends the oldest match). */
  entries: readonly ConciergeApproval[];
  replace: (entries: readonly ConciergeApproval[]) => void;
}

export const useConciergeApprovals = create<ConciergeApprovalsState>((set) => ({
  entries: [],
  replace: (entries) => set({ entries }),
}));

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

/** Canonical JSON: object keys sorted at every depth, so two structurally identical argument
 *  objects fingerprint identically however the model happened to order them. */
function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
}

/**
 * The identity of one call: what it is and what it would do it to.
 *
 * `undefined` args normalise to `{}` — the same normalisation `parseArgs` in
 * services/conciergeTools/registry.ts applies — so an arg-less op called twice fingerprints the
 * same both times, while `quit_app({confirm:true})` stays distinct from `quit_app({})`.
 */
export function approvalFingerprint(domain: string, op: string, args: unknown): string {
  return `${domain}.${op}#${canonical(args === undefined ? {} : args)}`;
}

// ---------------------------------------------------------------------------------------------
// Display-safe arguments
// ---------------------------------------------------------------------------------------------

function truncate(s: string): string {
  return s.length <= ARG_VALUE_MAX_CHARS ? s : `${s.slice(0, ARG_VALUE_MAX_CHARS - 1)}…`;
}

function renderValue(v: unknown): string {
  if (v === undefined) return "(not set)";
  if (v === null) return "null";
  if (typeof v === "string") return truncate(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return truncate(JSON.stringify(v) ?? String(v));
  } catch {
    // A cyclic or otherwise unserialisable value. Say so rather than throwing into the dispatch
    // path — this runs while a tool call is being refused, and a throw here would turn a refusal
    // into an internal-error.
    return "(unreadable)";
  }
}

/**
 * Turn a model-supplied `args` blob into lines fit to show a human.
 *
 * TOTAL over every input, because `args` is untyped JSON a model wrote: a string, an array, `null`
 * and a cyclic object all produce lines rather than an exception.
 */
export function describeApprovalArgs(args: unknown): readonly ApprovalArgLine[] {
  if (args === undefined || args === null) return [];
  if (typeof args !== "object") return [{ key: "arguments", value: renderValue(args) }];
  if (Array.isArray(args)) return [{ key: "arguments", value: renderValue(args) }];
  return Object.entries(args as Record<string, unknown>).map(([key, value]) => ({
    key,
    value: SECRETISH_KEY.test(key) ? "••••••" : renderValue(value),
  }));
}

// ---------------------------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------------------------

function isLive(e: ConciergeApproval, now: number): boolean {
  return e.expiresAt > now;
}

/**
 * Lapse anything whose window has closed, then evict down to the retention cap. PURE — it computes
 * the next ledger and reports which QUESTIONS died in the process; announcing them is
 * {@link sweepAndAnnounce}'s job, so this stays callable from anywhere.
 *
 * `lapsed` is every way a question ENDS WITHOUT AN ANSWER, and it is deliberately narrower than "the
 * entry changed":
 *
 *   • `pending → expired` (the TTL) — a resolution nobody ever announced. A reader that drained
 *     `approval_requested` is waiting on the matching `approval_resolved` and would otherwise wait
 *     forever on a card that is already dead.
 *   • A PENDING entry evicted by the retention cap. Only reachable when the ledger is entirely
 *     pending — a runaway caller rather than ordinary use — but the reader sees the same silence,
 *     so it gets the same announcement. It is reported as `expired` because that is what it means
 *     to the reader: the question is over and nobody answered it.
 *
 * NOT included: an APPROVED entry lapsing. Its `approval_resolved` was already emitted when the
 * human pressed the button, and what expired is the GRANT, not the question. Announcing that as a
 * second resolution would say the question expired, which is false.
 */
function sweep(
  entries: readonly ConciergeApproval[],
  now: number,
): { entries: readonly ConciergeApproval[]; lapsed: readonly ConciergeApproval[] } {
  const lapsed: ConciergeApproval[] = [];
  const aged = entries.map((e) => {
    if ((e.outcome !== "pending" && e.outcome !== "approved") || isLive(e, now) || e.spent) return e;
    const expired = { ...e, outcome: "expired" as const };
    if (e.outcome === "pending") lapsed.push(expired);
    return expired;
  });
  if (aged.length <= MAX_RETAINED_APPROVALS) return { entries: aged, lapsed };
  // Evict the oldest RESOLVED entries first: a pending one is on the human's screen, and dropping
  // it would silently remove a question they can still see.
  const overflow = aged.length - MAX_RETAINED_APPROVALS;
  const dropped = new Set<ConciergeApproval>();
  for (const e of aged) {
    if (dropped.size >= overflow) break;
    if (e.outcome !== "pending") dropped.add(e);
  }
  const kept = aged.filter((e) => !dropped.has(e));
  if (kept.length <= MAX_RETAINED_APPROVALS) return { entries: kept, lapsed };
  // Still over: there were not enough resolved entries to evict, so the oldest PENDING ones go. They
  // leave the human's screen without an answer, which is exactly the silence above — announce them.
  const survivors = kept.slice(kept.length - MAX_RETAINED_APPROVALS);
  for (const e of kept.slice(0, kept.length - MAX_RETAINED_APPROVALS)) {
    if (e.outcome === "pending") lapsed.push({ ...e, outcome: "expired" });
  }
  return { entries: survivors, lapsed };
}

/**
 * Sweep, and ANNOUNCE every question that died of old age.
 *
 * A silent expiry is the same "silence is indistinguishable from not-yet" failure the event log
 * exists to eliminate, applied to the one kind pair the log is centred on: a subscriber that drained
 * `approval_requested` for a call and never receives the matching `approval_resolved` reads the
 * stream as still-open while the card is gone from the human's screen (roborev 55405).
 *
 * The announcement runs BEFORE the caller commits the swept ledger, which is not observable: the
 * event log neither reads this store nor is read by it, and nothing else runs in between. Emitting
 * here rather than at each of the four call sites is what makes it impossible for a new sweep site
 * to reintroduce the silence.
 */
function sweepAndAnnounce(
  entries: readonly ConciergeApproval[],
  now: number,
): readonly ConciergeApproval[] {
  const swept = sweep(entries, now);
  for (const e of swept.lapsed) {
    // Stamped at the moment the question actually died, not at the moment the sweep noticed. The
    // log orders by `seq`, never by `at` (see conciergeEventLog property 1), so an out-of-order
    // timestamp costs nothing and "it lapsed 40 minutes ago" is the true sentence.
    emitApprovalEvent(
      { kind: "approval_resolved", approvalId: e.id, domain: e.domain, op: e.op, outcome: "expired" },
      Math.min(e.expiresAt, now),
    );
  }
  return swept.entries;
}

/**
 * SWEEP THE LEDGER FROM OUTSIDE — the non-render trigger the announcement needs to be worth anything.
 *
 * Everything else that sweeps is a WRITE: a new ask-tier call arrives, or a human presses a button.
 * In the scenario the expiry announcement exists for — the concierge asks, nobody clicks, and no
 * further approval traffic happens — none of those ever run, so the card would leave the human's
 * screen at `expiresAt` and the event would never be emitted at all. The reader would still wait
 * forever, and would now be doing it while being TOLD that a missing resolution means the question
 * is open (roborev 55441).
 *
 * The events domain calls this before it drains, which makes the guarantee true where it is
 * claimed: by the time a reader is answered, every question that has died is already in the log.
 * Nothing renders off this, so writing here is safe — unlike {@link pendingApprovals}, which is
 * computed during render and must stay a pure read.
 */
export function sweepConciergeApprovals(now: number = Date.now()): void {
  commit(sweepAndAnnounce(useConciergeApprovals.getState().entries, now));
}

function commit(next: readonly ConciergeApproval[]): void {
  useConciergeApprovals.getState().replace(next);
}

function blank(id: unknown): boolean {
  return typeof id !== "string" || id.trim() === "";
}

/**
 * Record that a specific tool call is waiting on the human, and return the entry the column will
 * render. Returns `null` for an unusable id — an approval with nothing to attribute it to is not
 * an approval, the same rule `conciergeToolAuthority` applies to a blank `toolCallId`.
 *
 * IDEMPOTENT per id: asking again about an id already in the ledger returns the existing entry
 * untouched. It must never reset a `denied` entry back to `pending`, or a model that simply
 * retried would erase the human's "no" and get a fresh prompt for it.
 *
 * IDEMPOTENT PER LIVE QUESTION TOO, and that one is a safety property rather than a nicety. Ids are
 * minted per call, so a model refused once and retried before anyone clicks would otherwise put a
 * SECOND card for the identical call on screen — and since `claimApproval` authorises each entry
 * independently by id, approving both would run the op twice. Two clicks, two sends, one intention
 * (roborev 54729, finding 2). One live question per identity: the same call asked again while it is
 * still unanswered returns the card already waiting.
 */
export function requestApproval(
  request: ConciergeApprovalRequest,
  now: number = Date.now(),
): ConciergeApproval | null {
  if (blank(request.id)) return null;
  const id = request.id.trim();
  const swept = sweepAndAnnounce(useConciergeApprovals.getState().entries, now);
  const existing = swept.find((e) => e.id === id);
  if (existing) {
    commit(swept);
    return existing;
  }
  // Same call, already on screen and still unanswered → that card IS this question.
  const onScreen = swept.find(
    (e) => e.fingerprint === request.fingerprint && e.outcome === "pending" && isLive(e, now),
  );
  if (onScreen) {
    commit(swept);
    return onScreen;
  }
  const entry: ConciergeApproval = {
    ...request,
    id,
    requestedAt: now,
    expiresAt: now + APPROVAL_REQUEST_TTL_MS,
    outcome: "pending",
    resolvedAt: null,
    spent: false,
  };
  // Sweep AFTER appending, so the retention cap is applied to the list that actually gets stored —
  // sweeping first would let the ledger sit one entry over the cap indefinitely.
  commit(sweepAndAnnounce([...swept, entry], now));
  // AFTER the commit, and ONLY on this arm — the two idempotent returns above are the same question
  // already on screen, and an event for those would wake the concierge twice for one thing the human
  // sees once. This arm is the only one that puts a NEW card in front of them.
  emitApprovalEvent({ kind: "approval_requested", approvalId: entry.id, domain: entry.domain, op: entry.op }, now);
  return entry;
}

/** Record one approval event, best-effort. The ledger's correctness may never depend on the event
 *  log being reachable, so a throw here is swallowed: this is an observer, not a participant. */
function emitApprovalEvent(payload: ApprovalEventPayload, now: number): void {
  try {
    recordConciergeEvent(payload, now);
  } catch {
    // Deliberately silent — see above.
  }
}

/**
 * THE HUMAN GESTURE. Called from the approve button in the concierge column and NOWHERE else.
 *
 * Only a live `pending` entry can be approved; an expired, denied, or already-answered one returns
 * `false` and is left as it is. On success the deadline is REPLACED with a fresh grant window
 * measured from this moment — the request window is about how long a question may sit unanswered,
 * which has nothing to do with how long the answer stays good.
 */
export function approveApproval(id: string, now: number = Date.now()): boolean {
  return resolve(id, "approved", now);
}

/** The other human gesture. A denied entry is terminal: it can never be approved, and a retry of
 *  the same call fingerprints onto nothing. */
export function denyApproval(id: string, now: number = Date.now()): boolean {
  return resolve(id, "denied", now);
}

function resolve(id: string, outcome: "approved" | "denied", now: number): boolean {
  if (blank(id)) return false;
  const swept = sweepAndAnnounce(useConciergeApprovals.getState().entries, now);
  const target = swept.find((e) => e.id === id.trim());
  if (!target || target.outcome !== "pending") {
    commit(swept);
    return false;
  }
  commit(
    swept.map((e) =>
      e === target
        ? {
            ...e,
            outcome,
            resolvedAt: now,
            expiresAt: outcome === "approved" ? now + APPROVAL_GRANT_TTL_MS : now,
          }
        : e,
    ),
  );
  // THE EVENT THAT POLLING CANNOT PRODUCE. `pendingApprovals` — the read the approvals domain
  // offers — shows what is waiting NOW, so a question asked and answered between two concierge
  // turns leaves it looking exactly as it did before. This is the record of the answer itself.
  // Emitted only on the arm that actually changed the entry: the early return above (no such id,
  // or already answered) changed nothing and must announce nothing.
  emitApprovalEvent(
    { kind: "approval_resolved", approvalId: target.id, domain: target.domain, op: target.op, outcome },
    now,
  );
  return true;
}

/**
 * Spend an approval for this call, if a human gave one. Returns `true` at most ONCE per approval.
 *
 * Two ways to match, and the second is the one that makes a retry possible at all:
 *
 *  1. BY ID. The same `toolCallId` coming back around — the entry must be `approved`, live, and
 *     unspent. If an entry for this id exists in ANY other state (pending, denied, expired, spent)
 *     the answer is `false` and we stop there: an explicit "no" for this exact call must not be
 *     routed around by the identity path below.
 *  2. BY IDENTITY. No entry for this id, so this is a fresh call from a later turn. The oldest
 *     approved-live-unspent entry with the SAME fingerprint is spent. Same domain, same op, same
 *     arguments — the human approved this exact thing, just under a previous id.
 *
 * Everything else is `false`. There is no third way.
 */
export function claimApproval(
  id: string,
  fingerprint: string,
  now: number = Date.now(),
): boolean {
  const swept = sweepAndAnnounce(useConciergeApprovals.getState().entries, now);
  const spendable = (e: ConciergeApproval) =>
    e.outcome === "approved" && !e.spent && isLive(e, now);

  let target: ConciergeApproval | undefined;
  const byId = blank(id) ? undefined : swept.find((e) => e.id === id.trim());
  if (byId) {
    // A known id answers for itself, whatever the answer was.
    if (!spendable(byId)) {
      commit(swept);
      return false;
    }
    target = byId;
  } else {
    target = swept.find((e) => spendable(e) && e.fingerprint === fingerprint);
  }

  if (!target) {
    commit(swept);
    return false;
  }
  commit(swept.map((e) => (e === target ? { ...e, spent: true } : e)));
  return true;
}

/**
 * Was this exact call ALREADY RUN, moments ago, off a human's approval?
 *
 * Guards the duplicate-run path that opened when approving started dispatching immediately
 * (services/conciergeApprovalResume). The model is not told that the click ran anything — its turn
 * ended with a refusal — so a human who does the thing the refusal asked for and says "go ahead"
 * makes it call again. That call mints a fresh `toolCallId`, finds the grant `spent`, and would
 * raise a SECOND identical card; approving that would type the same brief into an agent twice, spawn
 * two agents, push a branch again. Non-idempotent ops make that a real side effect, not a nuisance.
 *
 * "Moments ago" is the grant window ({@link APPROVAL_GRANT_TTL_MS}) — a spent entry keeps its
 * `approved` outcome and its deadline (the sweep only lapses UNSPENT entries), so staying live is
 * exactly the right test. Past that window a repeat is treated as a fresh intention and asked about
 * again, which is what makes this a de-duplicator rather than a lockout: a human who genuinely wants
 * the same thing twice waits, or says so and gets asked again.
 */
export function recentlyRan(
  fingerprint: string,
  now: number = Date.now(),
): ConciergeApproval | undefined {
  return useConciergeApprovals
    .getState()
    .entries.find(
      (e) => e.fingerprint === fingerprint && e.outcome === "approved" && e.spent && isLive(e, now),
    );
}

/**
 * Every question still on the human's screen, oldest first.
 *
 * A PURE READ — it lapses stale entries in what it returns but writes nothing back. The card list
 * is computed during render, and a store write in the render phase is how you get an infinite
 * re-render loop. The ledger is swept for real on every request/resolve/claim, which is often
 * enough; a prompt whose window closes while nobody touches the tool surface simply stops being
 * returned here, which is the only behaviour the human can observe anyway.
 */
export function pendingApprovals(
  entries: readonly ConciergeApproval[] = useConciergeApprovals.getState().entries,
  now: number = Date.now(),
): readonly ConciergeApproval[] {
  return entries.filter((e) => e.outcome === "pending" && isLive(e, now) && !e.spent);
}

/** Read one entry without changing anything — for tests and for asserting a state transition. */
export function findApproval(id: string): ConciergeApproval | undefined {
  return useConciergeApprovals.getState().entries.find((e) => e.id === id);
}

/** Drop the whole ledger. Tests, and the identity reset. */
export function clearConciergeApprovals(): void {
  commit([]);
}
