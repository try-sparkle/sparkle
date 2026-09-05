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

/**
 * THE WEDGED FRAME — a live Claude Code session whose grid was painted for a geometry the pane no
 * longer has, so the composer box is gone and the app reports a full-screen app where a human sees
 * an idle prompt. This is the screen behind bead sparkle-4utugq, where, at one instant, on one
 * agent:
 *
 *   send_to_agent_terminal -> refused `alternate-screen` ("a pager or an editor holds the screen")
 *   read_agent_terminal    -> ok, freshness `live`: a completed turn and an idle `❯` prompt
 *
 * RECONSTRUCTED, NOT CAPTURED — but derived from a real byte log rather than assembled by hand,
 * which is why it belongs here and not in `capturedScreens.fixture.ts`. Claude Code **2.1.261** was
 * driven in a pty at 120x40 by that file's own recipe, taken to a completed turn, and its byte log
 * replayed through `@xterm/headless`. Replayed into a grid of the SAME size the child drew for, the
 * result is an ordinary idle prompt and `isClaudeCodeScreen` answers TRUE. Replayed into a grid of
 * a DIFFERENT size — which is what a pane whose PTY winsize has drifted from its emulator is — the
 * absolutely-positioned trailing chrome lands on top of the composer's closing rule, both rules are
 * lost, and the same predicate answers FALSE. The rows below are that second render, verbatim.
 *
 * ── WHY THE PREDICATE IS RIGHT TO REFUSE THIS AND THE APP IS STILL WRONG ──────────────────────
 * There is no composer box on this screen. `isClaudeCodeScreen` is a POSITIVE-evidence detector and
 * it is answering honestly about the bytes it was given. What is broken is upstream: the bytes are
 * a frame that was never validly rendered. So the fix is not to widen the predicate — typing into a
 * real pager is the harm it prevents — it is to make the child REPAINT and ask the same predicate
 * again. See `conciergeTools/terminal.repairAndRetryAlternateScreen`.
 *
 * Two things on this screen are ordinary 2.1.261 chrome and must not be "corrected" away, because
 * they are what the incident report singled out as suspicious:
 *   • `← for agents` is the agents indicator Claude Code draws at the end of its status bar.
 *   • the trailing row is a MERGE of the composer prompt and status-bar fragments, not a prompt.
 *     The U+00A0 after the caret is the non-breaking space Claude Code pads the prompt with,
 *     and it is escaped in the row below rather than written literally so it cannot be mistaken
 *     for an ordinary space.
 */
export const WEDGED_FRAME_SCREEN = [
  "",
  " ▐▛███▛█   Claude Code v2.1.261",
  "▝▜██████▀  Opus 5 (1M context) · Claude Max",
  "  ▝▝ ▝▝    ~/Projects/sparkle",
  "",
  "",
  "❯ Reply with exactly: hello. Nothing else.                                                                              ",
  "",
  "⏺ hello",
  "",
  "✻ Sautéed for 27s · done 10:27 PM",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "❯\u00a0                                                ← for agents                   "
].join("\n");
