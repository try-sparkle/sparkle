// R5 — "Stop re-reporting unchanged state — say it once, then go quiet."
//
// `warn`, never autofix: the compliant reply is SHORTER, and deciding which sentences to drop is
// the judgment the rule is really about. Deleting the overlapping run mechanically would produce a
// reply with a hole in it.
//
// ══ WHAT "RE-REPORTING" IS, MECHANICALLY ════════════════════════════════════════════════════════
// The decidable core of the rule is verbatim repetition of the PREVIOUS reply. A model re-reporting
// unchanged state does not paraphrase it — the state did not change, so the sentence describing it
// comes out the same, modulo re-wrapping. So: the longest contiguous run this reply shares with the
// previous one, after whitespace collapsing, against a character threshold.
//
// The engine is `overlap.ts`, shared with `relay-paste`. Same measure, different corpus — see that
// module's header for why it is shared and why it is not the quadratic DP.
//
// ══ THE THRESHOLD IS THE WHOLE CHECK ════════════════════════════════════════════════════════════
// 200 characters is roughly two sentences. Below that, overlap is ordinary English: a reply that
// opens "Done." twice, a bulleted list with the same bullet prefixes, a repeated agent name, a
// shared closing line. Firing on those would flag every well-formed reply in the thread, which is
// why the threshold is data (`[concierge.checks.restated-state].threshold`) and not a constant
// someone has to rebuild to move.
//
// `prevReply === null` is a NO-OP, not a pass with zero overlap: the first reply of a thread has
// nothing to repeat, and a check that "passed" would misreport that as a fact it verified.

import type { Check, LintContext, Severity, Violation } from "../types";
import { longestOverlap } from "../overlap";

/** The check id. Must equal the `[concierge.checks.<id>]` table key in `config.toml`. */
export const RESTATED_STATE_CHECK_ID = "restated-state";

/** Characters of contiguous verbatim overlap with the previous reply before it counts. */
export const DEFAULT_RESTATED_STATE_THRESHOLD = 200;

export const restatedStateCheck: Check = {
  id: RESTATED_STATE_CHECK_ID,
  run(text: string, ctx: LintContext): { text: string; violations: Violation[] } {
    const prev = ctx.prevReply;
    if (typeof prev !== "string" || prev.length === 0) return { text, violations: [] };

    const policy = ctx.policy?.checks?.[RESTATED_STATE_CHECK_ID];
    const severity: Severity = policy?.severity ?? "warn";
    const threshold =
      typeof policy?.threshold === "number" && policy.threshold > 0
        ? policy.threshold
        : DEFAULT_RESTATED_STATE_THRESHOLD;

    const { length } = longestOverlap(text, [prev]);
    if (length < threshold) return { text, violations: [] };

    return {
      text,
      violations: [
        {
          check: RESTATED_STATE_CHECK_ID,
          severity,
          action: "warned",
          span: length,
          // Metadata only — the count, never the run itself (plan §7).
          detail: `repeats ${length} characters verbatim from the previous reply (threshold ${threshold})`,
        },
      ],
    };
  },
};
