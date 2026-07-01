// Pure reconciliation between the sidebar work-mode chevron and the agent the main pane shows.
//
// The pane renders the SELECTED agent by its `kind` (think → ThinkPanel, everything else →
// terminal), while the chevron is independent `workMode` state. Left unsynced they drift: switching
// the chevron doesn't move selection (pane keeps showing the old agent), and a programmatic
// cross-kind select (Ask-Sparkle from a build terminal, a notification/history jump, or a restored
// selection on boot) leaves the chevron pointing at the wrong section. This helper computes the
// `workMode` that MATCHES the current selection so a single effect can keep them in agreement.

import type { AgentKind } from "../types";

export type WorkMode = "think" | "plan" | "build";

/** The work mode whose sidebar surfaces an agent of this kind: Think for think agents, Build for
 *  everything else (build / worker / shell). Used when we need to REVEAL a specific agent (e.g. a
 *  cross-window "needs attention" jump) — switching to this mode un-hides an agent the current mode
 *  filter was dropping. Gate-aware: a `think` agent maps to Build when the AI/brainstorm feature is
 *  OFF (there's no Think chevron then), so we never ask for a mode that can't be shown — and so a
 *  reveal can't fight `reconcileWorkMode` (which also refuses gated-off Think). This is the single
 *  kind→mode mapping `reconcileWorkMode` uses too, so the two can't drift. */
export function revealModeForKind(kind: AgentKind, aiBrainstorm: boolean): WorkMode {
  return kind === "think" && aiBrainstorm ? "think" : "build";
}

/**
 * The work mode that should be active given what the pane is showing, or `null` when no change is
 * warranted. Rules, in order:
 *  - A special view (Sparkle / the Plan board) owns the pane → leave the mode alone (`null`).
 *  - Plan mode is a board overlay with no agent → never auto-changed here (`null`).
 *  - Think is AI-gated: if we're sitting on Think with the feature off, fall back to Build (this
 *    subsumes the old standalone brainstorm-gate effect).
 *  - No selection (empty pane) → keep the user's chosen mode so its empty state shows (`null`).
 *  - Otherwise the mode should match the selected agent's kind: `think` → "think", anything else
 *    (build / worker / shell) → "build". Returns the desired mode only when it differs from the
 *    current one, and never selects gated-off Think.
 */
export function reconcileWorkMode(
  selectedKind: AgentKind | undefined,
  mode: WorkMode,
  hasSpecial: boolean,
  aiBrainstorm: boolean,
): WorkMode | null {
  if (hasSpecial || mode === "plan") return null;
  // Never strand the user on the Think chevron when the feature is gated off.
  if (mode === "think" && !aiBrainstorm) return "build";
  if (!selectedKind) return null;
  // revealModeForKind maps a gated-off think agent to Build, so `desired` is never a hidden mode:
  // a selected think agent while gated stays under the Build chevron (its pane still shows by kind)
  // rather than force-enabling a gated feature — an accepted, obscure drift.
  const desired = revealModeForKind(selectedKind, aiBrainstorm);
  return desired === mode ? null : desired;
}
