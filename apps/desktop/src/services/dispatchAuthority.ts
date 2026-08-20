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

declare const TOOL_POLICY_STAMP: unique symbol;

/**
 * The `policy` of a concierge-tool authority — a BRANDED `"allow" | "approved"`.
 *
 * The brand is the difference between a convention and a boundary. Without it the arm is a plain
 * structural type, so `{ kind: "concierge-tool", toolCallId: "x", policy: "allow" }` typechecks
 * anywhere, passes the runtime validator, and delivers — meaning the tool surface can authorize
 * itself without a policy decision ever being consulted, which is the one thing this arm exists to
 * prevent.
 *
 * NOT EXPORTED, and that is the load-bearing part rather than an oversight. An exported brand is a
 * one-assertion forge: `policy: "allow" as ToolPolicyStamp` needs no `as unknown` laundering and
 * would reduce the guarantee straight back to a convention. Unexported, a call site cannot even NAME
 * the type, so `conciergeToolAuthority` really is the only way to obtain one. (Nothing outside needs
 * it — the arm is reachable as `ConciergeToolAuthority`, and no declaration emit is configured.)
 *
 * WHAT IT DOES NOT STOP, stated so the next reader doesn't over-trust it: a call site holding a
 * legitimately minted authority can still spread it (`{...minted, toolCallId: "other"}`) and re-aim
 * it at a different call. The brand stops FABRICATION from nothing, not derivation from a real one.
 * Closing that would need a nominal runtime token, which buys little while `conciergeToolAuthority`
 * has exactly one consumer — but it is the assumption to revisit if the arm grows call sites.
 *
 * The runtime shape is unchanged — it is still the string `"allow"` or `"approved"` on the wire, so
 * `isDispatchAuthority`, logging and any store round trip are unaffected. The brand deliberately
 * does NOT survive to runtime: a JS caller or an object rebuilt off the wire never went through tsc,
 * which is exactly why the tool layer re-checks at runtime rather than trusting the type.
 */
type ToolPolicyStamp = ("allow" | "approved") & { readonly [TOOL_POLICY_STAMP]: true };

/** Mint a stamp. Module-private on purpose — this cast is the whole boundary, so it lives in one
 *  place, next to the factory that is allowed to perform it. */
const stamp = (policy: "allow" | "approved"): ToolPolicyStamp => policy as ToolPolicyStamp;

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
  /**
   * The concierge is MOUNTED to this agent and the user pressed Send — the cable itself is the
   * authorization, so the send goes immediately with no countdown in between.
   *
   * ITS OWN ARM RATHER THAN A BORROWED `countdown`, for the reason `goal-continue` gives below: this
   * union's whole job is that the audit line names the REAL cause. A mounted send claiming
   * `{kind:"countdown"}` would answer "why did it type that?" with "a send countdown elapsed without
   * being cancelled" — naming a countdown that never ran and a cancel window the user never had.
   * The write is real and a human authorized it; the union should say how.
   *
   * WHY IT IS A LEGITIMATE GESTURE, where a router verdict is not. Patching the cable is an
   * explicit, standing, visible act: the column has swapped to that agent's conversation and the
   * compose box is keyed to that agent's draft. The user is not being guessed at — they are typing
   * into a terminal they opened. That is the same class of thing as `mention` (they named the
   * agent), which is why both skip the classify; this one skips the ARMING too, because unlike an
   * address there is nothing being relayed on their behalf for them to veto.
   */
  | { kind: "mount"; agentId: string }
  /** The user tapped the redirect on a routing receipt (components/Concierge/RoutingReceipt). */
  | { kind: "redirect"; receiptId: string }
  /** The user clicked Approve on a nudge card. */
  | { kind: "nudge-approve"; agentId: string }
  /** The user clicked a recommended-action pill (components/composer/SuggestionRow). */
  | { kind: "suggestion"; agentId: string }
  /**
   * The concierge's own TOOL layer wrote to an agent (services/conciergeTools/terminal).
   *
   * Read the `policy` field as the reason, not as a label. An AI tool call is NOT a user gesture —
   * it is the same class of thing as the router's verdict, and the union has no `router` arm for
   * exactly that reason. So this arm does not say "the concierge wanted to"; it names the POLICY
   * DECISION that made the write legal, and only two decisions ever do:
   *   • `"allow"`    — the tool sits in the allow tier, a standing decision the user configured.
   *   • `"approved"` — the tool is ask-tier and a human answered the prompt with yes.
   * There is deliberately no arm for a policy that is unresolved (`ask`, still pending) or denied:
   * those are not representable, so a dispatch cannot be built from one even by mistake. Build this
   * through {@link conciergeToolAuthority} rather than by hand — it is the only path that turns a
   * decision into an authority, and it returns `null` for every decision that isn't one of the two.
   * Nor is "rather than by hand" advisory: `policy` is a {@link ToolPolicyStamp}, which nothing
   * outside this module can mint, so a hand-written literal does not compile.
   */
  | { kind: "concierge-tool"; toolCallId: string; policy: ToolPolicyStamp }
  /**
   * The GOAL auto-continue runner restarted a turn that ended with the goal unmet
   * (services/goalContinuationRunner, deciding through engine/goalContinuation).
   *
   * Its OWN arm rather than a borrowed one, and the borrowing it replaces is the reason. The runner
   * could mint a `concierge-tool` authority — `conciergeToolAuthority(id, {tier:"allow"})` needs
   * nothing the runner doesn't have — and every gate below would pass. But the audit line is the
   * whole point of this union: a "why did it type that?" complaint about an auto-continue would then
   * be answered "a concierge tool call ran under an allow-tier policy", naming a tool call that never
   * happened and a policy nobody configured. The write is real and it is machine-authored; the union
   * says so plainly instead.
   *
   * Carries the agent id, which is the only thing there is to attribute it to — there is no gesture
   * and no tool call. What makes it legal is not recorded here but in the DECISION: `decideContinuation`
   * refuses unless the goal is live and unmet, the row has been continuously resting past
   * `IDLE_SETTLE_MS`, some source actually witnessed the turn ending, the process is alive, and the
   * retry bounds are unspent. This arm is the receipt for that decision, not a second copy of it.
   */
  | { kind: "goal-continue"; agentId: string }
  /**
   * The EPIC SWEEP restarted a stalled epic's orchestrator and handed the epic back
   * (services/epicSweepRunner, deciding through engine/epicContinuation).
   *
   * Its OWN arm, for the reason `goal-continue` gives directly above and `mount` gives above that:
   * this union exists so the audit line names the REAL cause. The sweep could mint a
   * `goal-continue` — it has an agent id and nothing else is checked — and every gate would pass.
   * But a "why did it type that?" complaint would then be answered "goal auto-continue resumed a
   * turn that ended with the goal unmet", naming a goal that may not exist and a turn that never
   * ended. The write is real and machine-authored, and it happened because an EPIC went stale; the
   * union should say that.
   *
   * Carries the epic id as well as the agent id, because unlike every other arm the target is not
   * the whole story: the sweep reuses one orchestrator per epic, so the agent id alone does not say
   * which epic's stall spent the restart. `authorityRef` still returns the agent id — the thing
   * written to — and the epic rides along for the log line.
   *
   * What makes it legal is not recorded here but in the DECISION: `decideEpicSweep` refuses unless
   * the epic was promoted to Build, its plan was written, no child has moved for `EPIC_STALL_MS`,
   * the stall is inside the `EPIC_MAX_STALL_AGE_MS` reach, and the one-shot `sweep-restarted`
   * budget is unspent. This arm is the receipt for that decision, not a second copy of it.
   */
  | { kind: "epic-restart"; agentId: string; epicId: string };

export type DispatchAuthorityKind = DispatchAuthority["kind"];

/**
 * Did a HUMAN author the text of this dispatch — as opposed to merely making it legal?
 *
 * A DIFFERENT QUESTION FROM AUTHORITY, and conflating the two cost a real guarantee (roborev 55588).
 * Every arm of this union authorizes a write; only some of them mean a person composed the words.
 * `projectStore.releaseGoalDebt` clears an agent's retry budget AND un-latches an escalation on the
 * reasoning that "a human changed the picture", so it must key on THIS and not on the dispatch's
 * `userPrompt` flag: `send_to_agent_terminal` passes `userPrompt: true` for prose the concierge LLM
 * composed, so a machine nudge was clearing the very latch whose purpose is to hand the agent to a
 * human — and `send_to_agent_terminal` is `disruptive`, so under a policy that allows disruptive
 * writes that happened unattended, refilling MAX_CONTINUES_TOTAL indefinitely.
 *
 * The union's own docstrings already draw this line — the tool arm says outright "An AI tool call is
 * NOT a user gesture … it is the same class of thing as the router's verdict" — so this only makes a
 * stated distinction executable.
 *
 * A RECORD, NOT A SWITCH, and not an `Array`/`Set` of the human kinds either: a `Record` over
 * `DispatchAuthorityKind` is exhaustive, so ADDING an arm to the union fails to compile here until
 * someone decides which side of this line it sits on. That default-by-omission is exactly what went
 * wrong once already, and the safe answer for a new arm is rarely obvious enough to guess.
 */
const HUMAN_AUTHORED: Record<DispatchAuthorityKind, boolean> = {
  // A person typed, clicked, or let their own armed send run. The words are theirs.
  mention: true,
  approval: true, // the user approved THIS text before it went
  countdown: true,
  mount: true, // they typed it into a terminal they had patched a cable into
  redirect: true,
  "nudge-approve": true,
  suggestion: true,
  // MACHINE-AUTHORED. The policy that made the write legal may well have come from a human, but the
  // prose did not, and it is the prose that constitutes "the human changed the picture".
  "concierge-tool": false,
  "goal-continue": false,
  // MACHINE-AUTHORED, and here that is load-bearing rather than merely accurate. The epic sweep
  // REUSES the orchestrator already bound to the epic, and a human-authored send on that reuse path
  // runs `releaseGoalDebt` — un-latching an escalation nothing spent and zeroing `totalContinues`.
  // `services/sendToBuild` already passes `humanAuthored: false` for exactly this reason on the
  // draft it appends; the delivered instruction has to agree, or the two halves of one handoff
  // would disagree about who wrote it.
  "epic-restart": false,
};

export function isHumanAuthored(a: DispatchAuthority): boolean {
  return HUMAN_AUTHORED[a.kind];
}

/** The tool arm on its own. The concierge tool layer takes THIS, not the whole union: every other
 *  arm is a user gesture that a tool call has no business claiming, and most are constructible from
 *  an agent id the tool call already carries. See services/conciergeTools/terminal `sendToAgentTerminal`. */
export type ConciergeToolAuthority = Extract<DispatchAuthority, { kind: "concierge-tool" }>;

/** Which field carries each kind's id. A `Record` over the union KEY, so adding an arm to
 *  `DispatchAuthority` without teaching this map about it is a compile error — the validator below
 *  can therefore never silently pass a kind it doesn't understand. */
const AUTHORITY_REF_FIELD: Readonly<Record<DispatchAuthorityKind, string>> = Object.freeze({
  mention: "agentId",
  approval: "proposalId",
  countdown: "intentId",
  mount: "agentId",
  redirect: "receiptId",
  "nudge-approve": "agentId",
  suggestion: "agentId",
  "concierge-tool": "toolCallId",
  "goal-continue": "agentId",
  "epic-restart": "agentId",
});

/**
 * Per-kind checks the generic id check below can't express.
 *
 * `concierge-tool` is the only arm whose legality rests on more than "an id is present" TODAY: its
 * `policy` records WHICH decision permitted the write, and a shape that arrives with a missing,
 * pending (`"ask"`) or denied policy is not an authority at all.
 *
 * TOTAL over the union key, exactly like `AUTHORITY_REF_FIELD`, and for the same reason — the six
 * `() => true` entries are the point, not noise. A `Partial` map defaults a new arm to "nothing to
 * prove", so the next arm whose legality rests on more than an id (this one is the proof such arms
 * exist) would pass the validator unvalidated with nothing to warn whoever added it. Total means
 * adding an arm is a compile error until someone states what it has to prove, even if the answer is
 * "nothing".
 *
 * MODULE-PRIVATE and frozen. This table is the only thing standing between `{policy:"ask"}` and a
 * PTY write, on a seam with no second line behind it, so exporting the value — even just for a test
 * — would let any module in the bundle do `AUTHORITY_EXTRA_CHECK["concierge-tool"] = () => true` and
 * permanently disable the policy check. Totality needs no export to be tested: a missing entry now
 * makes `isDispatchAuthority` REFUSE that kind (see the `typeof extra === "function"` guard), so the
 * suite's "accepts every well-formed sample" walk over `DISPATCH_AUTHORITY_KINDS` fails the moment
 * an arm loses its entry. The compile-time `Record` is the primary guarantee either way.
 */
const AUTHORITY_EXTRA_CHECK: Readonly<
  Record<DispatchAuthorityKind, (v: Record<string, unknown>) => boolean>
> = Object.freeze({
  // Nothing beyond the id: the gesture IS the authorization, and the id says which one.
  mention: () => true,
  approval: () => true,
  countdown: () => true,
  // Nothing beyond the agent id. What makes a mounted send legal is that the cable IS patched, and
  // that is checked at the call site against the live wiring (ConciergeHost `mountRouted`) before
  // this authority is built — re-stating a slice of it here would be a second copy that can
  // disagree with the first, exactly as `goal-continue` explains below.
  mount: () => true,
  redirect: () => true,
  "nudge-approve": () => true,
  suggestion: () => true,
  "concierge-tool": (v) => v.policy === "allow" || v.policy === "approved",
  // Nothing beyond the agent id. The legality of an auto-continue is decided by
  // `engine/goalContinuation.decideContinuation` BEFORE this authority is built, and re-stating a
  // slice of that decision here would be a second copy of it that can disagree with the first.
  "goal-continue": () => true,
  // The agent id is checked generically above; the EPIC id is this arm's own requirement. It is not
  // decoration — it is the only thing that says which epic's one-shot restart budget was spent, so
  // an authority carrying a blank one cannot produce the audit line the arm exists for. Refuse it
  // here rather than logging "restarted agent X for epic ''".
  "epic-restart": (v) => typeof v.epicId === "string" && v.epicId.trim() !== "",
});

/**
 * A tool-policy decision, as the concierge's policy layer produces it.
 *
 * Three tiers, and only two of them can ever authorize a write — which is the entire reason this
 * type exists separately from the authority union. `deny` carries its reason for the refusal copy.
 *
 * The `ask` tier splits in two, and that split is load-bearing. An approval is not a boolean flag
 * floating free of what it approved: `approvedByUser: true` must name the CALL the human answered
 * for. A bare boolean can be transplanted — `conciergeToolAuthority(callB, approvalForCallA)` would
 * mint a perfectly valid authority for a call nobody approved, and no layer below could detect it,
 * which re-opens the attribution hole the whole arm exists to close. A loosely-keyed approval map or
 * a re-render reusing the last decision object is all it takes. So the approving arm carries
 * `approvedForToolCallId` and the factory refuses a mismatch; the un-approved arm needs nothing,
 * because "we showed a prompt" attributes to nothing at all.
 */
export type ToolPolicyDecision =
  | { tier: "allow" }
  | { tier: "ask"; approvedByUser: false }
  | { tier: "ask"; approvedByUser: true; approvedForToolCallId: string }
  | { tier: "deny"; reason?: string };

/**
 * Turn a tool-policy decision into a dispatch authority, or `null` when the decision doesn't
 * authorize anything.
 *
 * THE NARROW GATE for the whole concierge tool surface. A caller cannot reach a PTY write without
 * coming through here — the arm's `policy` is a {@link ToolPolicyStamp} only this function can mint
 * — and here refuses four ways:
 *
 *   • a denied tool;
 *   • an ask-tier tool nobody has approved yet ("the user was asked" is not "the user said yes", so
 *     a prompt still on screen, or one the user dismissed, produces no authority and no send);
 *   • a call with no tool-call id to attribute the write to; and
 *   • an approval that was given for a DIFFERENT call — see `ToolPolicyDecision`.
 */
export function conciergeToolAuthority(
  toolCallId: string,
  decision: ToolPolicyDecision,
): ConciergeToolAuthority | null {
  // No id, no attribution — and an unattributable write is exactly what the union exists to stop.
  const id = typeof toolCallId === "string" ? toolCallId.trim() : "";
  if (id === "") return null;
  if (decision.tier === "allow") {
    return { kind: "concierge-tool", toolCallId: id, policy: stamp("allow") };
  }
  if (decision.tier === "ask" && decision.approvedByUser === true) {
    // The binding is re-read defensively (`typeof`) rather than trusted: the type says `string`, but
    // a JS caller or a decision rebuilt off a store round trip never met the compiler. Both sides are
    // trimmed before comparing, for the same reason the stored id is trimmed — a padded id must not
    // read as a different call in either direction. Missing, blank or mismatched all fail CLOSED.
    const approvedFor =
      typeof decision.approvedForToolCallId === "string"
        ? decision.approvedForToolCallId.trim()
        : "";
    if (approvedFor === "" || approvedFor !== id) return null;
    return { kind: "concierge-tool", toolCallId: id, policy: stamp("approved") };
  }
  return null;
}

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
    case "mount":
      return a.agentId;
    case "redirect":
      return a.receiptId;
    case "nudge-approve":
      return a.agentId;
    case "suggestion":
      return a.agentId;
    case "concierge-tool":
      return a.toolCallId;
    case "goal-continue":
      return a.agentId;
    case "epic-restart":
      // The AGENT, not the epic: this is "the id the authority points at", and what is written to
      // is the orchestrator's terminal. The epic is the reason, and it is in `describeAuthority`.
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
    case "mount":
      return "the user sent this straight to the agent the concierge is mounted to";
    case "redirect":
      return "the user tapped redirect on a routing receipt";
    case "nudge-approve":
      return "the user clicked Approve on a nudge card";
    case "suggestion":
      return "the user clicked a recommended action";
    case "concierge-tool":
      // Two different facts, and a forwarding complaint needs to know WHICH: a standing allow-tier
      // policy the user configured once, or a human answering this specific prompt with yes.
      return a.policy === "approved"
        ? "the user approved this concierge tool call"
        : "a concierge tool call ran under an allow-tier policy";
    case "goal-continue":
      return "goal auto-continue resumed a turn that ended with the goal unmet";
    case "epic-restart":
      // Names the epic, because "the epic sweep restarted something" is not an answer to a
      // forwarding complaint — WHICH stalled epic bought this write is the whole fact.
      return `the epic sweep restarted stalled epic ${a.epicId}`;
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
  // OWN properties only. The kind is a lookup key into two plain object literals, so a `kind` of
  // "constructor" or "toString" resolves to an inherited Object.prototype member and reads as a
  // DECLARED kind. Nothing useful comes back from it today, but "safe because the next line happens
  // to fail" is not a gate — an undeclared kind is refused here, explicitly.
  if (!Object.prototype.hasOwnProperty.call(AUTHORITY_REF_FIELD, kind)) return false;
  const field = AUTHORITY_REF_FIELD[kind as DispatchAuthorityKind];
  const ref = (v as Record<string, unknown>)[field];
  if (typeof ref !== "string" || ref.trim() === "") return false;
  // Whatever else this kind has to prove. Six arms prove nothing beyond their id; `concierge-tool`'s
  // policy must name a decision that actually authorizes a write, so `{policy:"ask"}`,
  // `{policy:"deny"}` and a missing policy all fail here rather than riding in on a good toolCallId.
  // The map is TOTAL, so a missing entry means the union grew behind this function's back — refuse.
  const extra = AUTHORITY_EXTRA_CHECK[kind as DispatchAuthorityKind];
  return typeof extra === "function" && extra(v as Record<string, unknown>);
}
