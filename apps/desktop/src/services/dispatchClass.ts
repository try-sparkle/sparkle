// How long does the user get to cancel THIS message before it goes? — the dispatch tier classifier.
//
// See docs/superpowers/specs/2026-07-27-concierge-control-design.md §3 A3: a routine send arms a 3s
// countdown, a destructive one 5s. This module answers only "which tier", and it answers it off the
// EXISTING auto-approve taxonomy.
//
// ONE TAXONOMY — a locked decision (design §1, decision 3), not a preference. The obvious
// alternative is a bespoke list of dangerous verbs here ("delete", "force push", "rm -rf"). That
// list would immediately be the app's SECOND opinion about how dangerous an action is:
// services/suggestions/approvalCategories + services/autoApprovePreset already encode one, and it
// already drives the auto-approve settings the user sets by hand. Two lists drift, and the day they
// disagree the user sees the settings say one thing and the countdown do another. So:
//
//   • the CLASS of an action comes from approvalClassifier.classifyCategory — the same function that
//     categorises a live permission prompt;
//   • which classes are DESTRUCTIVE is DERIVED from the conservative auto-approve preset rather than
//     written down again (see DESTRUCTIVE_CATEGORIES) — so the two can't be edited apart.
import {
  APPROVAL_CATEGORIES,
  type ApprovalCategory,
} from "./suggestions/approvalCategories";
import { NON_BASH_CATEGORIES } from "./autoApprovePreset";
import { classifyCategory } from "./suggestions/approvalClassifier";

/** The two countdown tiers. */
export type DispatchClass = "routine" | "destructive";

/** A routine send: long enough to catch a misroute, short enough not to feel like a dialog. */
export const ROUTINE_DELAY_MS = 3000;
/** A destructive send gets the longer look, per the design's tier table. */
export const DESTRUCTIVE_DELAY_MS = 5000;

/**
 * The categories that count as destructive — DERIVED, deliberately, rather than listed.
 *
 * `NON_BASH_CATEGORIES` is what the most conservative auto-approve preset ("everything except
 * commands") is willing to fire on the user's behalf; the complement is exactly what that preset
 * withholds because it can't be taken back. Reusing that boundary is what makes "destructive" mean
 * the same thing here as it does in the Auto-approve pane. Adding a category to the taxonomy
 * automatically lands it on the right side of this line, with no edit here at all.
 */
export const DESTRUCTIVE_CATEGORIES: readonly ApprovalCategory[] = APPROVAL_CATEGORIES.filter(
  (c) => !NON_BASH_CATEGORIES.includes(c),
);

/** Is a category in the destructive tier? */
export function isDestructiveCategory(c: ApprovalCategory): boolean {
  return DESTRUCTIVE_CATEGORIES.includes(c);
}

/**
 * Which tier does this outgoing message belong to?
 *
 * PURE and total — an unrecognized message is `routine`, never a refusal. Getting the tier wrong
 * costs 2 seconds of countdown; there is no path here that can drop a send.
 */
export function classifyDispatch(text: string): DispatchClass {
  return isDestructiveCategory(classifyCategory(text)) ? "destructive" : "routine";
}

/** How long the user gets to cancel a send of this class. */
export function dispatchDelayMs(cls: DispatchClass): number {
  switch (cls) {
    case "destructive":
      return DESTRUCTIVE_DELAY_MS;
    case "routine":
      return ROUTINE_DELAY_MS;
    default: {
      const unhandled: never = cls;
      void unhandled;
      return ROUTINE_DELAY_MS;
    }
  }
}
