// Pure predicate for the proactive first-run readiness gate (ReadinessGate.tsx). Kept free of React
// and Tauri IPC so the "all prereqs present → invisible / missing dep → show the checklist" decision
// is unit-testable in isolation. The gate probes ONCE with checkPrereqs()/checkClaudeSignedIn() and
// feeds the result here; the actual detect-and-install engine (SetupChecklist) is reused unchanged.

import type { PrereqsReport } from "../preflight";

/** All three runtime prerequisites (git, node, claude) are present on the machine. */
export function prereqsAllInstalled(r: PrereqsReport): boolean {
  return r.git.installed && r.node.installed && r.claude.installed;
}

/** The machine is fully ready to run agents: every prerequisite installed AND the user has actually
 *  completed `claude login`. This is the gate's "invisible / instant" condition — when true, the
 *  readiness step surfaces nothing (a healthy or returning user sees no onboarding). When false,
 *  something is missing and the SetupChecklist is shown so the user can resolve it up front rather
 *  than hitting a wall deep in the app after paying and spawning their first agent.
 *
 *  `claudeSignedIn` is only meaningful when claude is installed; callers pass `false` when claude is
 *  absent (nothing to be signed into yet), which this treats as not-ready via the install check. */
export function readinessComplete(r: PrereqsReport, claudeSignedIn: boolean): boolean {
  return prereqsAllInstalled(r) && claudeSignedIn;
}
