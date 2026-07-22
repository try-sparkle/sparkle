// Pure reconciliation between the sidebar work-mode chevron and the agent the main pane shows.
//
// The pane renders the SELECTED agent in a terminal, while the chevron is independent `workMode`
// state. Left unsynced they drift: a programmatic cross-mode select (Ask-Sparkle from a build
// terminal, a notification/history jump, or a restored selection on boot) leaves the chevron
// pointing at the Plan board while a build agent's terminal is showing. This helper computes the
// `workMode` that MATCHES the current selection so a single effect can keep them in agreement.

export type WorkMode = "plan" | "build";

/**
 * The work mode that should be active given what the pane is showing, or `null` when no change is
 * warranted. Rules, in order:
 *  - A special view (Sparkle / the Plan board) owns the pane → leave the mode alone (`null`).
 *  - Plan mode is a board overlay with no agent → never auto-changed here (`null`).
 *  - No selection (empty pane) → keep the user's chosen mode so its empty state shows (`null`).
 *  - Otherwise a real agent is selected and its terminal is showing, so the mode should be Build.
 *    Returns "build" only when the current mode isn't already Build.
 */
export function reconcileWorkMode(
  hasSelection: boolean,
  mode: WorkMode,
  hasSpecial: boolean,
): WorkMode | null {
  if (hasSpecial || mode === "plan") return null;
  if (!hasSelection) return null;
  return mode === "build" ? null : "build";
}
