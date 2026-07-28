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
  /** `concierge.tools.<op>` — named in the card so "stop asking me" is one click from discoverable. */
  configPath: string;
  /** Canonical identity of this exact call. Build with {@link approvalFingerprint}. */
  fingerprint: string;
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

/** Lapse anything whose window has closed, then evict down to the retention cap. Pure. */
function sweep(entries: readonly ConciergeApproval[], now: number): readonly ConciergeApproval[] {
  const aged = entries.map((e) =>
    (e.outcome === "pending" || e.outcome === "approved") && !isLive(e, now) && !e.spent
      ? { ...e, outcome: "expired" as const }
      : e,
  );
  if (aged.length <= MAX_RETAINED_APPROVALS) return aged;
  // Evict the oldest RESOLVED entries first: a pending one is on the human's screen, and dropping
  // it would silently remove a question they can still see.
  const overflow = aged.length - MAX_RETAINED_APPROVALS;
  const dropped = new Set<ConciergeApproval>();
  for (const e of aged) {
    if (dropped.size >= overflow) break;
    if (e.outcome !== "pending") dropped.add(e);
  }
  const kept = aged.filter((e) => !dropped.has(e));
  return kept.length <= MAX_RETAINED_APPROVALS
    ? kept
    : kept.slice(kept.length - MAX_RETAINED_APPROVALS);
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
 */
export function requestApproval(
  request: ConciergeApprovalRequest,
  now: number = Date.now(),
): ConciergeApproval | null {
  if (blank(request.id)) return null;
  const id = request.id.trim();
  const swept = sweep(useConciergeApprovals.getState().entries, now);
  const existing = swept.find((e) => e.id === id);
  if (existing) {
    commit(swept);
    return existing;
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
  commit(sweep([...swept, entry], now));
  return entry;
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
  const swept = sweep(useConciergeApprovals.getState().entries, now);
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
  const swept = sweep(useConciergeApprovals.getState().entries, now);
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
