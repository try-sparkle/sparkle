// The concierge reply linter — the check that runs OUTSIDE the model.
//
// `<app_data>/concierge-guidelines.md` holds sixteen rules injected into every concierge turn, and
// until this module existed nothing verified a single one of them: the only detector in the system
// was the human noticing. Eleven of the sixteen end in "_(added by Sparkle, 2026-07-29/30)_" — each
// appended because the concierge broke it — so the list is a record of failures, and appending rule
// seventeen is the move that produced rules six through sixteen.
//
// A rule in the prompt competes for the model's attention with the task, degrades under load, and
// degrades worst exactly when it matters most. A regex has no attention budget, does not degrade in
// hour six, and cannot be talked out of a finding. That is the whole argument for this module, and
// it is also its limit: only the MECHANICALLY DECIDABLE rules live here. The dispositional ones
// ("lead with what needs me, tightest-first") stay in prose, because any pattern approximating a
// disposition is trivially satisfiable without holding it — encoding judgment as patterns teaches
// the model to produce the pattern instead of the behavior.
//
// ══ FAIL-OPEN IS THE POINT ══════════════════════════════════════════════════════════════════════
// `lintReply` NEVER THROWS. Every check runs inside its own try/catch; a check that throws is
// logged to the console and contributes nothing. Losing a reply is the one unacceptable failure of
// this design — the linter exists to improve replies, and a linter that can destroy one is worse
// than no linter. This mirrors `services/concierge.ts` exactly ("nothing here throws to callers").
//
// A corollary that is easy to get backwards: a check that throws is treated as CLEAN, not as
// blocking. Failing closed on a crashed check would let one bad regex stall every reply.
//
// ══ THE REGISTRY IS OPEN ════════════════════════════════════════════════════════════════════════
// This module ships the three text-only checks. The roster/pill checks (`bare-agent-name`,
// `bare-pr-number`, `fat-pill-label`, `unresolved-agent-pill`) and the turn-context checks
// (`relay-paste`, `actions-first`, `unreported-refusal`) land through `registerCheck` — see the
// extension point below.

import type { Check, LintContext, LintResult, Violation } from "./types";
import { severityBlocks, severityRuns } from "./types";
import { askWithoutActionCheck } from "./checks/askWithoutAction";
import { hedgeWordsCheck } from "./checks/hedgeWords";
import { nakedFileRefCheck } from "./checks/nakedFileRef";
import { restatedStateCheck } from "./checks/restatedState";
import { unbackedClaimCheck } from "./checks/unbackedClaim";

export type {
  Check,
  CheckPolicy,
  LintContext,
  LintPolicy,
  LintRefusal,
  LintResult,
  LintRosterAgent,
  LintToolCall,
  Severity,
  Violation,
} from "./types";

/**
 * The checks `lintReply` runs, in order.
 *
 * ══ EXTENSION POINT — ADD YOUR CHECK HERE (or via {@link registerCheck}) ════════════════════════
 * Only the three text-only checks are built in. A sibling check appends itself by calling
 * `registerCheck(myCheck)` at module load, or by adding its `Check` to this array directly if it
 * ships in this folder. Two rules for whatever lands next:
 *
 *   1. The `id` MUST equal its `[concierge.checks.<id>]` table key in `config.toml`. `lintReply`
 *      looks the policy up by that id and SKIPS a check with no policy row — a check whose id does
 *      not match its config key silently never runs.
 *   2. `run` must be pure and must not mutate `text` or `ctx`. Order matters only in that a check
 *      that rewrites the text hands the rewritten text to the checks after it.
 */
export const CHECKS: Check[] = [
  // First because it is the only one here that BLOCKS: when a reply both offers to act and hedges,
  // the offer is the finding worth surfacing — the hedge is a symptom of the same passivity.
  askWithoutActionCheck,
  // Second because it is the other half of the same pair: `ask-without-action` catches the reply
  // that took no action and said so, this catches the reply that took no action and said it did.
  unbackedClaimCheck,
  hedgeWordsCheck,
  nakedFileRefCheck,
  restatedStateCheck,
];

/**
 * Add a check to the registry, replacing any check already registered under the same id.
 *
 * Replace-by-id rather than append: registration happens at module load, and a module imported
 * twice (a test importing both the check and the index, say) would otherwise run its check twice
 * and double every violation it finds.
 */
export function registerCheck(check: Check): void {
  const at = CHECKS.findIndex((c) => c.id === check.id);
  if (at >= 0) CHECKS[at] = check;
  else CHECKS.push(check);
}

/**
 * Lint one complete concierge reply.
 *
 * Returns the text to render — rewritten if a check autofixed it, byte-identical otherwise — the
 * violations that fired, and whether any of them blocks.
 *
 * Skips a check when its policy row is MISSING, `enabled: false`, or `severity: "off"`. A missing
 * row means "not configured", and running an unconfigured check would let a newer app quietly turn
 * on a gate the user's config never asked for.
 *
 * Never throws. Ever. See this module's header.
 */
export function lintReply(text: string, ctx: LintContext): LintResult {
  const original = typeof text === "string" ? text : "";
  // The master switch returns the input UNTOUCHED — not "every severity downgraded to warn". A user
  // who switched the linter off must get exactly the reply the model wrote.
  if (!ctx?.policy?.enabled) return { text: original, violations: [], blocked: false };

  let current = original;
  const violations: Violation[] = [];

  for (const check of CHECKS) {
    const policy = ctx.policy.checks?.[check.id];
    // `severityRuns`, not `=== "off"`: the skip decision goes through the exhaustive
    // SEVERITY_EFFECT table so a new tier is a compile error there rather than a silent default here.
    if (!policy || !policy.enabled || !severityRuns(policy.severity)) continue;
    try {
      const result = check.run(current, ctx);
      if (typeof result?.text === "string") current = result.text;
      if (Array.isArray(result?.violations)) violations.push(...result.violations);
    } catch (err) {
      // The reply survives a broken check; the console records which one broke. No violation is
      // recorded, because "the check crashed" is not evidence the reply was bad.
      console.warn(`conciergeLint: check "${check.id}" threw; skipping it`, err);
    }
  }

  return {
    text: current,
    violations,
    // `severityBlocks`, not `=== "block"` — see SEVERITY_EFFECT in types.ts (roborev 55723).
    blocked: violations.some((v) => severityBlocks(v.severity)),
  };
}
