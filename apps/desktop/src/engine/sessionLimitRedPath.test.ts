import { describe, expect, it } from "vitest";
import { AGENT_STATUS } from "@sparkle/ui";
import { classifyApiFailure, classifyFromScrollback } from "./apiRecovery";
import { classifyPassFailure, passFailureStatus } from "./passFailureStatus";

// ══ THE ACCEPTANCE TEST FOR THE FOUNDER'S STATED GOAL ═══════════════════════════════════════════
//
// He screenshotted the Improve Sparkle agent sitting on a session limit with a GRAY dot and said it
// should have been RED. This file pins that end to end, in HIS terms — the colour a human would see
// — rather than in the terms of any one classifier.
//
// WHY IT LIVES HERE AND NOT INSIDE EITHER CLASSIFIER'S SUITE. The bug was never in one of them: it
// was in the SEAM. `apiRecovery` guards the pane-open path (a terminal line); `passFailureStatus`
// guards the pane-closed one (a structured failure message from the headless pass). Each suite can
// be entirely green while the row still paints gray, because each proves only its own half — which
// is exactly what happened: `quotaBlockIn` alone reaches NONE of the strings below, and a suite
// written against the pretty scrollback wording passes against a completely broken implementation.
//
// So this asserts the OUTCOME across both halves, and it is deliberately written against the exact
// wordings that were observed in the wild rather than the ones that read nicely.
describe("a session or quota limit paints the Improve Sparkle dot RED", () => {
  const RED = AGENT_STATUS.blocked.color;

  // ── The pane-open path: a terminal line reaches StatusEngine via quotaBlockIn ────────────────
  it.each([
    // A SUB-AGENT's wall, quoted onto the parent's screen behind the Task tool's failure prefix.
    'Agent "Fix auto-switch on expired account" failed: Claude Code process exited due to an API error: You’ve hit your session limit · resets 9:30am',
    // The same wall arriving as a tool RESULT row, so it wears ⎿ and not ⏺.
    "  ⎿  You’ve hit your session limit · resets 9:30am",
    // The AUTO-CONTINUE wording, which nothing in the app knew until 2026-08-22.
    "Usage limit reached · continuing automatically at 9:30am",
  ])("pane-open: %# classifies terminal, so the row goes red", (line) => {
    expect(classifyApiFailure(line)).toBe("terminal");
  });

  // ⚠️ THE ASSISTANT MARKER GOES THROUGH THE SCROLLBACK ENTRY POINT, NOT `classifyApiFailure`, and
  // the difference is worth stating because it is genuinely asymmetric: `⎿` is peeled INSIDE
  // `classifyApiFailure` (it is peeled for the account-limit test only, so a ⎿-marked API error
  // still cannot win a backwards scan), whereas `⏺` is stripped by the CALLERS —
  // `streamFailure.stripMarkers` in `quotaBlocksIn`'s frame loop and in `classifyFromScrollback`.
  // Calling the inner function with a `⏺` still attached therefore answers null, which says nothing
  // about production. This case drives the real path a screen line takes.
  it("pane-open: the plain ⏺-marked banner still classifies terminal through the real entry point", () => {
    expect(classifyFromScrollback("⏺ You’ve hit your session limit · resets 9:30am")).toBe("terminal");
  });

  // ── The pane-closed path: the headless pass never produces a PTY ─────────────────────────────
  // `sparkle_improve.rs::failure_message` hands TS claude's STRUCTURED detail instead, and the
  // crate's own `failure_message_surfaces_claude_detail_when_stderr_empty` pins the recurring
  // exit-1-with-empty-stderr message as literally "Claude usage limit reached".
  it.each([
    "Claude usage limit reached",
    "Claude AI usage limit reached|1787412000",
    "Claude usage limit reached. Your limit resets at 5:00pm.",
    "Claude usage limit reached - resuming at 5pm",
    "Claude usage limit reached — will reset at 3pm (America/Bogota)",
    "You've hit your weekly limit · resets 4pm",
  ])("pane-closed: %# resolves to the RED tier", (message) => {
    const status = passFailureStatus(classifyPassFailure(message, 0));
    expect(AGENT_STATUS[status].color).toBe(RED);
  });

  it("an expired credential is RED too — no retry ever clears one", () => {
    const status = passFailureStatus(
      classifyPassFailure("Failed to authenticate: OAuth session expired and could not be refreshed", 0),
    );
    expect(AGENT_STATUS[status].color).toBe(RED);
  });

  // ── AND THE OTHER HALF OF THE FOUNDER'S RULE ─────────────────────────────────────────────────
  // Red only keeps its meaning while things that need nothing from him are NOT red. His words:
  // "why are they red when they don't require my assistance?"
  it.each(["read ECONNRESET", "stalled mid-stream", "claude exited without a successful result (exit code 1)"])(
    "an auto-retried failure (%s) stays AMBER, never red",
    (message) => {
      const status = passFailureStatus(classifyPassFailure(message, 0));
      expect(AGENT_STATUS[status].color).toBe(AGENT_STATUS.lapsed.color);
      expect(AGENT_STATUS[status].color).not.toBe(RED);
    },
  );

  // A short-window 429 is the case that most tempts a false red: it mentions a limit and it clears
  // itself within a minute.
  it("a short-window rate limit is not a wall", () => {
    const status = passFailureStatus(classifyPassFailure('API Error: 429 {"type":"rate_limit_error"}', 0));
    expect(AGENT_STATUS[status].color).not.toBe(RED);
  });
});
