// Pure reconciliation between the sidebar work-mode chevron and the agent the main pane shows.
//
// The pane renders the SELECTED agent in a terminal, while the chevron is independent `workMode`
// state. Left unsynced they drift: a programmatic cross-mode select (Ask-Sparkle from a build
// terminal, a notification/history jump, or a restored selection on boot) leaves the chevron
// pointing at the Plan board while a build agent's terminal is showing. This helper computes the
// `workMode` that MATCHES the current selection so a single effect can keep them in agreement.

// THE MODE UNION LIVES HERE, and `stores/uiStore` re-exports it. Two independent declarations is
// what this file used to be half of — different callers imported different ones, so widening the
// union in one place left the other narrow and the mismatch surfaced as a type error in whichever
// file happened to bridge them. This one is the source because it has NO imports of its own, so
// nothing can turn a value import of it into a cycle.
//
// THE LIST IS THE VALUE, and the type is derived from it. A bare union type cannot be iterated at
// runtime, so every place that has to VALIDATE a mode string — the concierge's `set_work_mode` is
// the one that exists today — ends up re-listing the members by hand, and the re-listing is what
// goes stale: that guard refused `"preview"` with the message `the chevrons are "plan" and "build"`
// for one commit after the union already had three members, i.e. it told the user a real mode did
// not exist. Deriving both from one array means a fourth mode cannot be accepted by the type and
// rejected by the guard.
export const WORK_MODES = ["plan", "build", "preview"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

/** Is this arbitrary string one of the modes? A TYPE PREDICATE, not a bare boolean, so a caller
 *  that validates an outside string (the concierge's `set_work_mode` takes one) gets the narrowing
 *  for free and has no reason to re-list the members to satisfy the compiler — which is how the
 *  stale enumeration got written the first time. */
export function isWorkMode(value: string): value is WorkMode {
  return (WORK_MODES as readonly string[]).includes(value);
}

/**
 * The work mode that should be active given what the pane is showing, or `null` when no change is
 * warranted. Rules, in order:
 *  - A special view (Sparkle / the Plan board) owns the pane → leave the mode alone (`null`).
 *  - ANY OVERLAY MODE (Plan, Preview) is a surface with no agent of its own → never auto-changed
 *    here (`null`). See the note below: this guard is `mode !== "build"`, not `mode === "plan"`.
 *  - No selection (empty pane) → keep the user's chosen mode so its empty state shows (`null`).
 *  - Otherwise a real agent is selected and its terminal is showing, so the mode should be Build.
 *    Returns "build" only when the current mode isn't already Build.
 *
 * THE GUARD IS `mode !== "build"` AND THAT IS LOAD-BEARING, not a tidier spelling of the same
 * thing. It was `mode === "plan"`, written when the union had exactly two members — under which it
 * is equivalent, because the only mode reaching the last line was "build" and it answered `null`.
 * Adding "preview" broke that equivalence and made the difference severe: `mode === "preview"` with
 * an agent selected falls through to the final line and returns `"build"`, so AgentSidebar's effect
 * kicks the column straight back out of Preview the instant any row is selected — i.e. always,
 * since selecting a row is how you get there. The old comment at AgentSidebar's call site predicted
 * exactly this ("if that helper ever grows a third mode").
 *
 * THE LAST LINE STILL RETURNS A MODE, and that is deliberate rather than vestigial (roborev 60625).
 * It was briefly a bare `return null`, which made the guard PROVABLY DEAD — every path answered
 * null, so reverting the guard to `mode === "plan"` changed nothing and the tests that claim to pin
 * it stayed green. A guard whose documented mutation cannot red anything is not a guard. With the
 * final line live, the guard is the only thing deciding the "preview" cases, which is what both
 * `workMode.test.ts` and `AgentSidebar.previewMode.test.tsx` assert.
 *
 * Enumerating the overlay modes here instead would reintroduce the same trap for the fourth mode.
 * Ask the property — "is the pane showing an agent's terminal?" — which is what "build" means.
 */
export function reconcileWorkMode(
  hasSelection: boolean,
  mode: WorkMode,
  hasSpecial: boolean,
): WorkMode | null {
  if (hasSpecial || mode !== "build") return null;
  if (!hasSelection) return null;
  // Reached only in Build with a selection, so this answers `null` today — but it is the branch
  // that would fire if the guard above stopped excluding a non-Build mode, which is exactly the
  // regression the guard exists to prevent. Keeping it live is what makes that regression
  // observable; see the note above.
  return mode === "build" ? null : "build";
}
