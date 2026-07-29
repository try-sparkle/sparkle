// Pure view-model helper for the "Improve Sparkle" sidebar row. Kept dependency-free (no React, no
// theme/runtime imports) so the consent wording is unit-tested in isolation.
//
// `sparkleBarState` USED TO LIVE HERE and is gone with the row's progress bar (see the note where
// SparkleRowProgress was, in AgentSidebar.tsx). It is the last thing this module owned that was a
// PARALLEL status derivation — it mapped an AgentTabStatus to its own three-state machine, beside
// the effectiveStatus → rollupDot → band pipeline every other row goes through. The row now takes
// that pipeline directly, and nothing status-shaped should come back into this file.
import type { SparkleImprovementConsent } from "../stores/settingsStore";

/** The consent mode beside the row's title, in product wording.
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
