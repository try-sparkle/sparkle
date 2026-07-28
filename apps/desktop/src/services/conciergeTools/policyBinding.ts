/**
 * Binds the per-tool autonomy POLICY (`policy.ts`) to the tool DISPATCH seam (`registry.ts`), and
 * closes the loop through the human with the pending-approval ledger
 * (`stores/conciergeApprovals.ts`).
 *
 * The two policy layers were built in parallel against a deliberately narrow contract, and they do
 * not speak the same shape: `evaluateToolPolicy(toolName, ctx)` answers with a rich
 * `ToolPolicyEvaluation` (for the settings pane and for explaining a decision to the human), while
 * the registry wants a terse `ToolPolicyQuery -> ToolPolicyDecision`. This file is that translation
 * plus the approval round-trip, so the policy layer stays pure and store-free and the registry stays
 * free of both config and UI concerns.
 *
 * HOW `ask` RESOLVES NOW
 * ----------------------
 * `conciergeToolAuthority` grants authority for `ask` only when `approvedByUser === true`. Until the
 * ledger existed nothing could ever produce that `true`, so every tool the human set to "Ask first"
 * was DEAD — ship_agent, discard_agent, merge_pr, quit_app, set_config and the rest — while the
 * refusal promised a prompt that did not exist. The only escape was setting `allow`, i.e. trading
 * "ask each time" for "never ask": the opposite of what the human chose.
 *
 * An `ask` verdict now does two things, in this order:
 *
 *   1. TRY TO SPEND an approval a human already gave for this exact call
 *      (`claimApproval`). Single-use, time-boxed, and matched by tool-call id OR by the call's
 *      identity — the domain, the op, and the exact arguments the human was shown. It returns
 *      `true` only where somebody pressed a button; every ambiguous path is `false`.
 *   2. Otherwise RAISE THE QUESTION (`requestApproval`) so the concierge column can show it, and
 *      report `approvedByUser: false` — which is the truthful outcome: the human asked to be
 *      consulted and has not answered yet.
 *
 * WHY THE CALL IS REFUSED RATHER THAN HELD. The concierge brain is a headless `claude -p` child,
 * ONE PROCESS PER TURN, and a tool call that blocked on a human would hold that turn — and the
 * bridge's 600s round trip — hostage on somebody who may be asleep. So dispatch never awaits: the
 * call is refused immediately with an honest sentence, and the human's answer is recorded in the
 * ledger for the NEXT turn's retry to spend. See the ledger's header for why a retry can spend it
 * at all when the MCP server mints a fresh `toolCallId` per call.
 *
 * WHAT IS NOT AN APPROVAL. Only the button in the column calls `approveApproval`. The domains' own
 * `confirm: true` flags and `DISCARD_CONFIRM_TOKEN` arrive inside the MODEL's tool arguments, so
 * treating them as consent would let the model approve itself — the confused deputy
 * `services/dispatchAuthority` exists to prevent. Nothing here reads them.
 */

import {
  approvalFingerprint,
  claimApproval,
  describeApprovalArgs,
  requestApproval,
} from "../../stores/conciergeApprovals";
import { useSettingsStore } from "../../stores/settingsStore";
import { aiFeatureNow } from "../aiGate";
import type { ToolPolicyDecision } from "../dispatchAuthority";
import {
  CONCIERGE_RISK_NOTE,
  CONCIERGE_TOOL_CATALOG,
  conciergeToolConfigPath,
  evaluateToolPolicy,
  NO_TOOL_POLICY_OVERRIDES,
  type ConciergeToolEntry,
  type ToolPolicyEvaluation,
  type ToolPolicyOverrides,
} from "./policy";
import type { ConciergeToolPolicy, ToolPolicyQuery } from "./registry";

/** Read the human's `[concierge.tools]` rules off the live settings store, WITH whether we have
 *  actually read their config yet.
 *
 *  Defensive by design: this runs on every tool call, and a store that is not yet hydrated (or a
 *  test that never mounted one) must not throw into the dispatch path.
 *
 *  The `hydrated` half matters (roborev 54247, finding 3). An earlier version of this comment said
 *  degrading here "cannot silently widen authority" because no derived default is ever `allow` for
 *  a risky tool. That was true only against the DEFAULTS, and the defaults are not the authority
 *  that matters — the human's own rules are. `conciergeToolPolicy` is config-mirrored and NOT
 *  persisted, so it is an empty map on every boot until `hydrateFromConfig` runs; during that
 *  window a tool the human explicitly set to `deny` looks exactly like one they never touched, and
 *  every read-only/routine tool would resolve to `allow` over the top of their rule. */
export function readToolPolicyOverrides(): {
  overrides: ToolPolicyOverrides;
  hydrated: boolean;
} {
  try {
    const s = useSettingsStore.getState();
    return {
      overrides: s.conciergeToolPolicy ?? NO_TOOL_POLICY_OVERRIDES,
      hydrated: s.conciergeToolPolicyHydrated === true,
    };
  } catch {
    return { overrides: NO_TOOL_POLICY_OVERRIDES, hydrated: false };
  }
}

/** Are AI enhancements live for the concierge (bead sparkle-4562)?
 *
 *  `aiFeatureNow("concierge")` is the settings flag AND a served credit balance, so this is false
 *  for a human who turned the feature off, for one who has run out of credits, AND — with no extra
 *  code path — for a build compiled from the open-source repo, which has no Sparkle backend and so
 *  never has a signed-in `me`. One rule covers all three.
 *
 *  Fails CLOSED on a throw: an unreadable store means we cannot show the gate is open, and the
 *  concierge acting on that assumption is the expensive direction to be wrong in. */
export function conciergeAiEnabled(): boolean {
  try {
    return aiFeatureNow("concierge");
  } catch {
    return false;
  }
}

/** The catalog by name, so the prompt can quote the tool's OWN one-liner rather than a second
 *  description written here that would drift from it. */
const CATALOG_BY_NAME: ReadonlyMap<string, ConciergeToolEntry> = new Map(
  CONCIERGE_TOOL_CATALOG.map((t) => [t.name as string, t]),
);

/** Map a policy evaluation onto the registry's decision union. PURE — it invents no approval and
 *  touches no store, so `toDispatchDecision("ask", …)` is unapproved by construction. The approval
 *  lookup lives in {@link resolveAskTier}, where the call's identity is available. Exported for
 *  tests so the mapping can be asserted without a store. */
export function toDispatchDecision(
  decision: "allow" | "ask" | "deny",
  reason: string,
): ToolPolicyDecision {
  if (decision === "allow") return { tier: "allow" };
  if (decision === "deny") return { tier: "deny", reason };
  return { tier: "ask", approvedByUser: false };
}

/** One ask-tier call, as much of it as this layer can see. */
interface AskContext {
  /** The MCP-minted `toolCallId`, or the Rust-minted `reqId` for a legacy control op. Never a
   *  model-supplied string. A blank one can spend nothing and raise nothing — fail closed. */
  id: string;
  domain: string;
  op: string;
  /** The model's raw arguments. Used ONLY to compute the call's identity and to render the prompt;
   *  nothing here reads a `confirm` flag out of them. */
  args: unknown;
  evaluation: ToolPolicyEvaluation;
}

/**
 * Spend a human approval for this call if there is one, otherwise put the question on their screen.
 *
 * The ONLY producer of `approvedByUser: true` in this codebase, and it produces it only from
 * `claimApproval`, which in turn only ever says yes to an entry a human resolved with the approve
 * button. Everything else — unknown id, expired window, already spent, denied, still pending —
 * comes back false.
 */
function resolveAskTier(c: AskContext): ToolPolicyDecision {
  const fingerprint = approvalFingerprint(c.domain, c.op, c.args);
  // The approval is BOUND to this call's id, so `conciergeToolAuthority` refuses if it is ever
  // presented for a different call. Belt and braces with the ledger's own single-use claim: the
  // ledger stops it being spent twice, this stops it being spent on something else.
  if (claimApproval(c.id, fingerprint)) {
    return { tier: "ask", approvedByUser: true, approvedForToolCallId: c.id };
  }

  const entry = CATALOG_BY_NAME.get(c.op);
  const riskClass = c.evaluation.riskClass;
  requestApproval({
    id: c.id,
    domain: c.domain,
    op: c.op,
    // Both strings come from `policy.ts`'s own tables. Nothing new is written here: a second
    // description of the same tool is the one that goes stale.
    summary: entry?.summary ?? c.evaluation.reason,
    riskClass,
    riskNote: riskClass ? CONCIERGE_RISK_NOTE[riskClass] : "",
    args: describeApprovalArgs(c.args),
    configPath: entry?.configPath ?? conciergeToolConfigPath(c.op),
    fingerprint,
  });
  return { tier: "ask", approvedByUser: false };
}

/**
 * The bound policy handed to `dispatchConciergeTool`.
 *
 * NOTE the op-name mapping: the registry asks about `{ domain, op }` while the policy table is
 * keyed by the BARE op name (the four domains' op unions are disjoint by construction, which is
 * what lets `ConciergeToolName` be their plain union). So the query's `op` is the policy's tool
 * name directly. A name the policy layer does not recognise resolves to `deny` — fail-closed —
 * rather than falling through to allow.
 */
/**
 * Evaluate one op, reporting separately whether the verdict is being HELD because we have not read
 * the human's rules yet (roborev 54247, finding 3).
 *
 * Before the first hydrate we cannot tell "no rule" from "a rule we haven't loaded", so an `allow`
 * is not a decision we are entitled to make — EXCEPT for `read-only` tools, which observe and change
 * nothing. Holding those too would leave the concierge unable to so much as look at the roster
 * during startup, which is a real cost for no safety gain.
 *
 * A hold is NOT an `ask`: it must not put a question on the human's screen. "We haven't finished
 * reading your config" is a transient condition to retry, not something for a person to adjudicate,
 * and raising a prompt for it would train them to click through prompts.
 */
function evaluateWithHydrationHold(op: string): {
  evaluation: ToolPolicyEvaluation;
  held: boolean;
} {
  const { overrides, hydrated } = readToolPolicyOverrides();
  const evaluation = evaluateToolPolicy(op, { overrides, aiEnabled: conciergeAiEnabled() });
  const held =
    !hydrated && evaluation.decision === "allow" && evaluation.riskClass !== "read-only";
  return { evaluation, held };
}

/** The refusal for a held verdict. A `deny` carrying its own reason, so the caller's deny branch
 *  renders this sentence rather than "you turned this off in Settings", which would be false. */
const HYDRATION_HOLD: ToolPolicyDecision = {
  tier: "deny",
  reason:
    "Sparkle hasn't finished loading your concierge tool settings, so I'm not assuming this one is allowed. Try again in a moment.",
};

export const configuredToolPolicy: ConciergeToolPolicy = (q: ToolPolicyQuery) => {
  const { evaluation, held } = evaluateWithHydrationHold(q.op);
  if (held) return HYDRATION_HOLD;
  if (evaluation.decision !== "ask") {
    return toDispatchDecision(evaluation.decision, evaluation.reason);
  }
  return resolveAskTier({
    id: q.toolCallId,
    domain: q.domain,
    op: q.op,
    args: q.args,
    evaluation,
  });
};

/**
 * The same decision, for the ORIGINAL `sparkle-control` ops (the policy layer's `app` domain).
 *
 * Separate from {@link configuredToolPolicy} because those ops are NOT registry dispatches: they
 * have their own handlers in `controlListener`, and the registry's `ToolPolicyQuery` describes a
 * `{ domain, op }` pair the registry can route — which these are not. Sharing the type would mean
 * widening the registry's domain union to admit a domain it cannot dispatch, i.e. making a
 * meaningless state representable purely to reuse a signature.
 *
 * `ctx` carries what the approval round-trip needs, and it is OPTIONAL for one reason only: a caller
 * that cannot supply a trustworthy request id must not be able to raise (or spend) an approval. With
 * no id the ask tier stays unapproved forever, which is the fail-closed answer — see
 * controlListener, which passes the Rust-minted `reqId` precisely so `set_config` is reachable.
 *
 * Same fail-closed guarantee: an unrecognised op name resolves to `deny`.
 */
export function appOpPolicy(
  op: string,
  ctx?: { requestId?: string; args?: unknown },
): ToolPolicyDecision {
  const { evaluation, held } = evaluateWithHydrationHold(op);
  if (held) return HYDRATION_HOLD;
  if (evaluation.decision !== "ask") {
    return toDispatchDecision(evaluation.decision, evaluation.reason);
  }
  return resolveAskTier({
    id: ctx?.requestId ?? "",
    domain: "app",
    op,
    args: ctx?.args,
    evaluation,
  });
}
