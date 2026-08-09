// Screens that encode a REPORTED INCIDENT, shared by the suites that assert different guarantees
// about the same screen.
//
// ── WHY THIS IS NOT `capturedScreens.fixture.ts` (roborev 61864) ──────────────────────────────
// That file opens with a provenance promise — every fixture in it is a verbatim, unedited slice of
// a real PTY/xterm capture, re-capturable with the recipe in its header. The screens here are
// RECONSTRUCTIONS: assembled from a founder screenshot or a bug report, true to the incident but
// not to any single capture. Putting one under that promise is the hazard `claudeCodeScreen.test.ts`
// already names — someone following "re-capture when Claude Code's TUI moves" would either
// "correct" the screen against a real capture, destroying the incident it encodes, or trust a
// hand-assembled screen as evidence of what the TUI actually draws.
//
// So: captures there, reconstructions here, and each file's header says which it is.
//
// These still belong in ONE module rather than copied per suite. A literal copy in a second suite
// lets both stay green while drifting apart, which is the re-derivation-disagrees-with-the-source
// class the picker parser's own comments exist to prevent.

/**
 * APPROVE WITH NOTHING TO APPROVE — a permission dialog whose option block has scrolled off the
 * viewport, leaving only its footer. The row reads `status: "approval"` while
 * `read_picker_options` answers `present: false, options: []`.
 *
 * RECONSTRUCTED, NOT CAPTURED. The last content line is the founder's screenshot verbatim — the
 * Recap agent's terminal ended at "Called sparkle-control 2 times" with nothing beneath it — and
 * the lines above it are assembled to reproduce that shape. Do not "re-capture" it.
 *
 * Two suites assert different things about this one screen, which is why it is shared:
 *   • `engine/approvalDeadEnd.test.ts` — the row stays RED with nothing pressable, and
 *     `classifyApproval` bails before the approvals policy is ever read.
 *   • `services/conciergeTools/terminal.test.ts` — `read_picker_options` reports it as
 *     `blind: "footer-without-options"`, so the taxonomy cannot drift from the incident it names.
 */
export const FOOTER_ONLY_SCREEN = [
  "⏺ Not blocked — research is done, I have a definitive root cause.",
  "",
  "  Called sparkle-control 2 times",
  " Esc to cancel · Tab to amend · ctrl+e to explain",
].join("\n");
