// WHAT the call would act on — the one fact the approval card was missing.
//
// The founder's complaint, verbatim: a card reading `workflow.merge_pr` / `projectId ed5d0ece-…` /
// `prNumber 2165` tells him nothing he can act on. He does not need the tool's internal name or a
// raw uuid; he needs to know WHICH BUILD AGENT the work belongs to, and to be able to click it.
//
// This module answers the first half — it turns a validated argument blob into a REFERENCE to the
// thing being acted on. Resolving that reference to a live, clickable agent is deliberately NOT
// done here: it needs the roster (and, for a pull request, an async `pr_owner` lookup), and this
// module is pure so the derivation can be unit-tested without a store or an IPC stub. The container
// (components/Concierge/ConciergeApprovals) does the resolving.
//
// ══ WHY IT IS STAMPED AT RAISE TIME ═════════════════════════════════════════════════════════════
// The subject is computed when the approval is RAISED and stored on the ledger entry, beside
// `relayedFounderWords` and for a related reason: the card's click handler runs arbitrarily long
// after the requesting turn ended. Deriving it later would mean re-reading `rawArgs` — untyped
// model JSON — in the view layer, which is exactly the raw-args coupling this change exists to
// remove. Stamping it once means the view consumes a typed reference and never sees the blob.
//
// ══ THE INPUT IS UNTRUSTED, AND THE GUARDS BELOW ARE NOT REDUNDANT ══════════════════════════════
// An earlier version of this comment said the arguments have ALREADY passed their zod schema.
// That is true only of the REGISTRY path: `dispatchConciergeTool` validates before it consults the
// policy (bead `sparkle-jjm27e`). `resolveAskTier` has a SECOND live caller — `controlOpPolicy`,
// reached from `appOpPolicy` and `chiefOpPolicy` — which passes `ctx?.args` straight through with
// no schema anywhere on that path. So every card raised for an `app` or `chief` control op derives
// its subject from raw model JSON.
//
// Hence: `Number.isInteger`, `> 0`, non-empty strings and the total/never-throws contract below are
// load-bearing, not belt-and-braces mirroring of schemas that already ran. Do not delete them as
// redundant — on the control-op path they are the only thing between the model's blob and the card.
//
// ══ WHY IT KEYS ON ARGUMENT SHAPE, NOT ON A PER-OP TABLE ════════════════════════════════════════
// There are seventeen tool domains and the op list grows. A hand-written "this op's subject is
// spelled X" table is a second list to forget to update, and it would go stale silently — the card
// would quietly stop naming an agent for a newly added op, which reads as "this tool has no owner"
// rather than as a missing case. Shape is stable instead: `agentId` means an agent everywhere it
// appears, and `number` is used by exactly the four workflow PR ops (`pr_owner`, `pr_checks_status`,
// `pr_roborev_status`, `merge_pr`) and nowhere else in the registry. An op that names neither yields
// `undefined`, and the card falls back to the catalog summary it already renders — a graceful
// degradation rather than a wrong answer.
//
// ══ NEVER A GUESS ═══════════════════════════════════════════════════════════════════════════════
// Every branch here either recognises a shape exactly or returns `undefined`. That mirrors the Rust
// `pr_owner`, which answers `agentId: null` WITH a reason rather than inferring an owner. The card
// renders an unresolved subject as "owner unresolved" and stays approvable — the founder's ruling:
// a metadata gap must not block a merge he actually wants, and it must not be hidden either.

/** The thing an approval would act on. A REFERENCE, not a resolved agent — see the header. */
export type ApprovalSubject =
  | { kind: "agent"; agentId: string }
  | { kind: "pr"; projectId: string; number: number };

function record(args: unknown): Record<string, unknown> | null {
  // `typeof null === "object"`, and an array's entries are not named arguments. Both are shapes a
  // model can actually send, so both are rejected rather than indexed into.
  if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
  return args as Record<string, unknown>;
}

/**
 * The subject of one call, or `undefined` when the arguments name none.
 *
 * TOTAL over every input, because `args` originates as untyped model JSON: a string, an array,
 * `null` and a missing value all yield `undefined` rather than an exception. This runs on the
 * dispatch path while a tool call is being refused, and a throw here would turn a refusal into an
 * internal-error.
 *
 * `domain` and `op` are accepted but deliberately unused for the match — see the header on why the
 * shape decides. They are in the signature because callers have them and because a future op whose
 * arguments genuinely collide would need them to disambiguate; taking them now means that fix does
 * not change every call site.
 */
export function approvalSubject(
  _domain: string,
  _op: string,
  args: unknown,
): ApprovalSubject | undefined {
  const a = record(args);
  if (!a) return undefined;

  // AGENT FIRST, and the order is load-bearing. An agent is the thing the call ACTS ON; a PR number
  // is a lookup key for the same question. A call carrying both would otherwise be labelled with
  // the PR's owner rather than with the agent it actually touches.
  if (typeof a.agentId === "string" && a.agentId !== "") {
    return { kind: "agent", agentId: a.agentId };
  }

  // BOTH HALVES REQUIRED. `fetchPrOwner(root, projectId, number)` cannot resolve a bare number, and
  // inventing a project would point the pill at an agent in the wrong repository. The numeric guard
  // matches the registry's own `z.number().int().positive()` so a subject can never describe a call
  // the schema would have refused.
  if (
    typeof a.projectId === "string" &&
    a.projectId !== "" &&
    typeof a.number === "number" &&
    Number.isInteger(a.number) &&
    a.number > 0
  ) {
    return { kind: "pr", projectId: a.projectId, number: a.number };
  }

  return undefined;
}
