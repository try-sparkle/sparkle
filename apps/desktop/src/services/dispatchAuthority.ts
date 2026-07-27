// WHY is this text allowed to reach a build agent's terminal? — the dispatch authority gate.
//
// See docs/superpowers/specs/2026-07-27-concierge-control-design.md §3 A1. The bug this exists to
// kill: user text typed at the concierge was sometimes SILENTLY forwarded to a build agent. That was
// not a stray code path — services/conciergeRouter decided the destination on its own and
// ConciergeHost dispatched on the strength of that decision alone. The structural fix is not to
// remove the router (it stays, with all of its tests); it is to make an un-declared dispatch
// UNREPRESENTABLE: every call that puts concierge-originated user text into a PTY has to name the
// user gesture that authorized it.
//
// So this module is a TYPE first and a runtime check second. The type is what stops the next call
// site: `dispatchConciergeAnswer` takes a required, non-defaulted `authority`, so a new caller can
// no more forget it than it can forget the text. The runtime validator is the belt for the paths
// TypeScript can't see (a JS consumer, a hand-built object off the wire, a future store round trip)
// — it refuses rather than guesses, exactly as the rest of the dispatch layer does.
//
// SCOPE, stated so nobody over-gates (design §3 A1 "Scope boundary"). This governs
// concierge-originated USER TEXT only. The other PTY writers in this app are either the user typing
// directly into a terminal or machine protocol, and gating them would break auto-approve and the
// phone relay: services/agentTransport (raw xterm keystrokes), services/suggestions/approvalsRuntime
// (auto-approve / auto-resume), services/relayClient (phone), components/selectionActions,
// services/agentModel (`/model`), services/requery. None of them import this module, and none
// should.

/**
 * The user gesture that authorizes one dispatch into a build agent's terminal.
 *
 * Each arm carries the id of the THING the user acted on, not merely a label, so an audit line can
 * point at the specific intent/receipt/proposal rather than saying "a countdown, somewhere".
 */
export type DispatchAuthority =
  /** The user typed `@name` in the compose box. Reserved — the typeahead lands on a later branch. */
  | { kind: "mention"; agentId: string }
  /** The user approved a block of text the concierge PROPOSED. Reserved — the propose/approve flow
   *  lands on a later branch. Defined now so the gate's shape is settled before it grows callers. */
  | { kind: "approval"; proposalId: string }
  /** An armed send countdown elapsed without the user cancelling (services/dispatchIntent). */
  | { kind: "countdown"; intentId: string }
  /** The user tapped the redirect on a routing receipt (components/Concierge/RoutingReceipt). */
  | { kind: "redirect"; receiptId: string }
  /** The user clicked Approve on a nudge card. */
  | { kind: "nudge-approve"; agentId: string }
  /** The user clicked a recommended-action pill (components/composer/SuggestionRow). */
  | { kind: "suggestion"; agentId: string };

export type DispatchAuthorityKind = DispatchAuthority["kind"];

/** Which field carries each kind's id. A `Record` over the union KEY, so adding an arm to
 *  `DispatchAuthority` without teaching this map about it is a compile error — the validator below
 *  can therefore never silently pass a kind it doesn't understand. */
const AUTHORITY_REF_FIELD: Record<DispatchAuthorityKind, string> = {
  mention: "agentId",
  approval: "proposalId",
  countdown: "intentId",
  redirect: "receiptId",
  "nudge-approve": "agentId",
  suggestion: "agentId",
};

/** Every authority kind, derived from the field map so the two can never disagree. */
export const DISPATCH_AUTHORITY_KINDS = Object.keys(
  AUTHORITY_REF_FIELD,
) as readonly DispatchAuthorityKind[];

/**
 * The id the authority points at (the intent, the receipt, the proposal, the agent).
 *
 * An exhaustive `switch` with a `never` guard, mirroring `refusalCopy`/`refusedPath` in
 * ConciergeHost: a new arm added to `DispatchAuthority` is a TYPE ERROR here rather than a silent
 * fall-through, which is the whole point of making the union the gate.
 */
export function authorityRef(a: DispatchAuthority): string {
  switch (a.kind) {
    case "mention":
      return a.agentId;
    case "approval":
      return a.proposalId;
    case "countdown":
      return a.intentId;
    case "redirect":
      return a.receiptId;
    case "nudge-approve":
      return a.agentId;
    case "suggestion":
      return a.agentId;
    default: {
      const unhandled: never = a;
      void unhandled;
      return "";
    }
  }
}

/**
 * The one place an authority becomes words: what the USER did that permits this write.
 *
 * Not user-facing copy — it goes in the log line next to a dispatch, so a forwarding complaint can
 * be answered with the gesture that caused it instead of a guess. Exhaustive, same reasoning as
 * `authorityRef`.
 */
export function describeAuthority(a: DispatchAuthority): string {
  switch (a.kind) {
    case "mention":
      return "the user @mentioned this agent";
    case "approval":
      return "the user approved a proposed message";
    case "countdown":
      return "a send countdown elapsed without being cancelled";
    case "redirect":
      return "the user tapped redirect on a routing receipt";
    case "nudge-approve":
      return "the user clicked Approve on a nudge card";
    case "suggestion":
      return "the user clicked a recommended action";
    default: {
      const unhandled: never = a;
      void unhandled;
      return "unknown authority";
    }
  }
}

/**
 * Is this a real, fully-formed authority?
 *
 * FAILS CLOSED, like every other gate in the dispatch layer: an unknown kind, a missing id, or a
 * blank one is NOT an authority, and the dispatcher refuses rather than delivering. TypeScript
 * already stops a call site that forgets the field; this catches the shapes the compiler never sees.
 */
export function isDispatchAuthority(v: unknown): v is DispatchAuthority {
  if (typeof v !== "object" || v === null) return false;
  const kind = (v as { kind?: unknown }).kind;
  if (typeof kind !== "string") return false;
  const field = AUTHORITY_REF_FIELD[kind as DispatchAuthorityKind];
  if (field === undefined) return false;
  const ref = (v as Record<string, unknown>)[field];
  return typeof ref === "string" && ref.trim() !== "";
}
