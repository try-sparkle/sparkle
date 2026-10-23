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

/** The full-width rule Claude Code draws above and below its composer, at the 120-column grid the
 *  other reconstructions here use. */
const RULE_120 = "─".repeat(120);

/**
 * AN IDLE AGENT WHOSE ONLY FOOTER IS THE AGENTS INDICATOR — bead sparkle-eou3y0.8.
 *
 * RECONSTRUCTED, NOT CAPTURED, from the bead's description of four affected panes (an Improve
 * Sparkle pane, a crypto-basis pane, a Daily Spend Report pane and a babysit pane): an idle prompt
 * whose transcript reads normally and whose footer row is ONLY the agents indicator — no permission
 * mode bar, no `? for shortcuts`. The reply's own `⏺` header has scrolled above the viewport, which
 * is the ordinary state of a finished agent that wrote more than a screenful.
 *
 * On that screen the composer box was the ONLY recognised family, `isClaudeCodeScreen` answered
 * false, and `send_to_agent_terminal` refused `alternate-screen` — so the concierge could not
 * message most idle agents. The two footer variants named in the bead are the two exports below.
 */
const idleWithFooter = (footer: string): string =>
  [
    "  - Merged PR #3088 into main and confirmed it by ancestry.",
    "  - Closed the review findings with stated reasons.",
    "",
    "  Nothing else is pending on my side.",
    "",
    "✻ Cogitated for 3m 12s",
    "",
    "",
    "",
    RULE_120,
    "❯ ",
    RULE_120,
    footer,
  ].join("\n");

export const IDLE_AGENTS_MANAGE_FOOTER_SCREEN = idleWithFooter("  ← agents · ↓ to manage");
export const IDLE_AGENTS_FEEDBACK_DRAFT_FOOTER_SCREEN = idleWithFooter("  ← agents · 1 feedback draft");

/**
 * THE FEEDBACK-DRAFT CARD — bead sparkle-eou3y0.5.
 *
 * RECONSTRUCTED, NOT CAPTURED. An agent answering a status-check nudge calls SendFeedback, and
 * Claude Code leaves a "Bug report drafted" card on screen offering `1 review / 2 send / 0 dismiss`.
 * The footer is spelled here as a key-hint bar (`N to verb · …`), because that is the only spelling
 * consistent with what the bead observed: `read_picker_options` answered
 * `blind: "footer-without-options"`, which requires the shared picker footer matcher to have
 * matched, and that matcher accepts only `<key> to <verb>` segments. The recogniser does not depend
 * on that spelling — `feedbackDraftCard.ts` also takes `1 review / 2 send / 0 dismiss` — so a
 * capture that disagrees narrows nothing.
 */
export const FEEDBACK_DRAFT_CARD_SCREEN = [
  "⏺ Not blocked — the goal is met and PR #3065 is on main. I've drafted feedback about the",
  "  repeated status checks.",
  "",
  "  Bug report drafted: Status-check nudges keep firing after goal is met",
  "  1 to review · 2 to send · 0 to dismiss",
  "",
  RULE_120,
  "❯ ",
  RULE_120,
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← agents · 1 feedback draft",
].join("\n");

/** The same card in the slash-separated spelling the bead quoted, with no `to`. */
export const FEEDBACK_DRAFT_CARD_SLASH_SCREEN = FEEDBACK_DRAFT_CARD_SCREEN.replace(
  "  1 to review · 2 to send · 0 to dismiss",
  "  1 review / 2 send / 0 dismiss",
);

/**
 * THE IMPOSTOR — the SAME card text quoted in agent output with more output beneath it. A card that
 * real output has scrolled past is not live, so nothing may be offered for it: a stale "2 send"
 * pressed on a guess would publish a bug report nobody asked to send.
 */
export const FEEDBACK_DRAFT_CARD_QUOTED_SCREEN = [
  "⏺ Here is what the card looked like:",
  "  Bug report drafted: Status-check nudges keep firing after goal is met",
  "  1 to review · 2 to send · 0 to dismiss",
  "",
  "⏺ Next I re-ran the suite:",
  "  bash scripts/tests/run.sh nudge",
  "  SELECTED SHELL TESTS PASSED (3 of 57 — full suite NOT run)",
  "  The nudge suite is green on this branch.",
  "  Moving on to the Rust side now.",
  "  cargo test --lib nudge_gate",
  "  test result: ok. 41 passed",
  "",
  RULE_120,
  "❯ ",
  RULE_120,
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
].join("\n");
