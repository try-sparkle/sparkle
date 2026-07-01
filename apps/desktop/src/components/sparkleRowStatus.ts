// Pure view-model helpers for the "Improve Sparkle" sidebar row. Kept dependency-free (no React,
// no theme/runtime imports) so the consent-pill wording and the progress-bar state machine are
// unit-tested in isolation. The row component maps these to concrete colors/markup.
import type { AgentTabStatus } from "../types";
import type { SparkleImprovementConsent } from "../stores/settingsStore";

/** The little status pill on the row: the user's consent mode, in product wording.
 *  always → "Always" (autonomous), case_by_case → "Manual" (approve each PR), never → "Off". */
export function consentPillLabel(mode: SparkleImprovementConsent): string {
  switch (mode) {
    case "always":
      return "Always";
    case "never":
      return "Off";
    case "case_by_case":
    default:
      return "Manual";
  }
}

/**
 * Progress-bar state for the row, derived from the agent's live status + consent mode:
 *   - "off"      → consent is Never; the agent doesn't run → flat dimmed rail.
 *   - "building" → agent is actively working → the sparkle.ai cyan→blue gradient sweeps (the same
 *                  "building" treatment the orchestrator/worker WorkflowLine rows use).
 *   - "idle"     → not running / finished a cycle / needs you → faint gray rail.
 * The bar shows PROGRESS only (like every other row's WorkflowLine); red/green/gray status —
 * including "needs you" (waiting/approval/errored) — is carried by the row's StatusDot, NOT the
 * bar. This special agent issues PRs and (for most users) never merges to main itself, so the bar
 * intentionally has no "shipped/on-main ✓" terminal — a finished cycle just returns to the rail.
 */
export type SparkleBarState = "off" | "idle" | "building";

export function sparkleBarState(status: AgentTabStatus, mode: SparkleImprovementConsent): SparkleBarState {
  if (mode === "never") return "off";
  if (status === "working") return "building";
  return "idle";
}
