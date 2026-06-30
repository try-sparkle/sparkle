// Whether a (re)started agent slot should shed the PRIOR occupant's identity — its persisted
// auto-name and the sticky workflow progress watermark — on this spawn. The decision is its own
// testable seam because the guard is subtle: it must fire only on a CONFIDENT "no Claude session to
// resume" (a genuine fresh/reused slot), and NEVER when the session probe merely failed.
//
// `resume` comes from `claudeHasSession`. Before this guard existed, a probe failure (IPC blip) just
// fell back to a fresh `claude` launch but left the displayed identity intact. Gating the reset on a
// bare `!resume` would regress that: a blip would wipe a historied agent's name + "shipped ✓"
// (roborev 16238). So we require the probe to have returned a confident answer.
export function shouldResetReusedSlotIdentity(
  resume: boolean,
  sessionDetectionConfident: boolean,
): boolean {
  return !resume && sessionDetectionConfident;
}
