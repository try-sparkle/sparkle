// COLOUR AND AUTHORIZATION ARE NOT THE SAME QUESTION — the pair that pins it (bead sparkle-gihgml).
//
// ══ WHAT WENT WRONG, AND WHY ONE TEST CANNOT GUARD IT ══════════════════════════════════════════
// `backgroundTaskRowCount` is read by two callers whose false-positive costs are orders of magnitude
// apart: the ROW COLOUR path (`liveBackgroundSubagentCount` → `backgroundTaskFooter`), where a wrong
// answer paints a dot, and the AUTHORIZATION path (`hasBackgroundTaskList` → `isClaudeCodeScreen` →
// `terminalWriteRefusal`), where a wrong answer types a line into `less` AND PRESSES ENTER. The
// walk was widened for the first — a real narrow pane with subagents running was taking its row gray
// — and, because both callers shared one threshold, the widening silently reached the second.
//
// A single test asserting the gate still refuses would be AMBIGUOUS: it also passes if the leniency
// were deleted outright, which would put the gray-row bug back. So these two assertions are a PAIR
// over ONE snapshot. Together they say the split is real and both halves survive; either alone
// says nothing about the other.
import { describe, it, expect } from "vitest";

import {
  chromeBarTailBelow,
  isClaudeCodeScreen,
  liveBackgroundSubagentCount,
} from "./claudeCodeScreen";
import { nothingUnrecognizedBelowFooter } from "./screenClassifier";
import { parseDelegatedWorkCount } from "./backgroundTaskFooter";
import { screenReadability } from "./screenReadability";
import { terminalWriteRefusal } from "../voice/dictationTerminalRoute";

// A live subagent roster on a NARROW pane. The tail is Claude's own `▶▶ bypass permissions on
// (shift+tab to cycle) · PR #730 · esc to interrupt` bar, wrapped by Ink across six rows exactly as
// `capturedScreens.fixture.ts` records it — the shape that only the LOOSE, rejoined-tail test
// recognises. There is no composer box (the roster replaced it) and no live dialog, so family F is
// the only thing that can carry this screen.
const WRAPPED_BAR_ROSTER = [
  "⏺ sparkle/agent-narrow",
  "  ◯ general-purpose  Draining roborev findings  3m 04s",
  "▶▶ bypass",
  "permissions on",
  "(shift+tab to",
  "cycle) · PR",
  "#730 · esc to",
  "interrupt",
].join("\n");

const ROSTER_ROW = 1;

describe("the family-F threshold is SPLIT by caller, and both halves are load-bearing", () => {
  it("PRECONDITION: this tail is exactly the widening — loose accepts it, the strict walk does not", () => {
    // Without this the pair below could be passing for some unrelated reason. It pins that the two
    // walks genuinely disagree about THIS screen, which is what makes it the case at issue.
    const lines = WRAPPED_BAR_ROSTER.split("\n");
    expect(chromeBarTailBelow(lines, ROSTER_ROW)).toBe(true);
    expect(nothingUnrecognizedBelowFooter(lines, ROSTER_ROW)).toBe(false);
  });

  // ── HALF ONE: THE AUTHORIZATION CALLER STILL REFUSES ─────────────────────────────────────────
  // Driven through the REAL production entry point, not through the predicate: `terminalWriteRefusal`
  // is what `dictationTerminalRoute`, the concierge composer and the `@Name` mention path all call,
  // and `alternate-screen` is the refusal that keeps the keys out of the pane.
  it("the KEYSTROKE gate still refuses this screen — the case the widening let through", () => {
    expect(terminalWriteRefusal({ text: WRAPPED_BAR_ROSTER, alternateBuffer: true })).toBe(
      "alternate-screen",
    );
  });

  // ── HALF TWO: THE DISPLAY CALLER STILL READS IT LENIENTLY ────────────────────────────────────
  // The paired assertion. `parseDelegatedWorkCount` is what the row's colour is derived from, and a
  // `null` here fires `forgetBackgroundTasks` and takes the row GRAY while three subagents run —
  // bead sparkle-262p7's bug. If this goes red the "fix" was to delete the leniency, not to split it.
  it("the ROW COLOUR caller still sees the live roster on the same screen", () => {
    expect(liveBackgroundSubagentCount(WRAPPED_BAR_ROSTER)).toBe(1);
    expect(parseDelegatedWorkCount(WRAPPED_BAR_ROSTER)).toBe(1);
  });

  // ── AND THE SPLIT IS IN THE SIGNATURE, WITH THE SAFE VALUE AS THE DEFAULT ────────────────────
  // The recommendation the bead makes is only kept if a caller that names NOTHING gets the strict
  // reading. Asserting both branches of the parameter on one snapshot is what proves the parameter
  // is load-bearing rather than decoration — a mutation that ignores it reds one of these two.
  it("`isClaudeCodeScreen` defaults to the AUTHORIZING reading, and says so in its signature", () => {
    expect(isClaudeCodeScreen(WRAPPED_BAR_ROSTER)).toBe(false);
    expect(isClaudeCodeScreen(WRAPPED_BAR_ROSTER, "authorize-keystrokes")).toBe(false);
    expect(isClaudeCodeScreen(WRAPPED_BAR_ROSTER, "colour-only")).toBe(true);
  });

  // ── THE ROW LABEL DELIBERATELY TAKES THE AUTHORIZING READING TOO ─────────────────────────────
  // `screenReadability` is a DISPLAY caller that must not diverge from the send path: a row saying
  // "Needs you" on a screen `terminalWriteRefusal` is refusing is the founder's original bug. It is
  // the one display caller that opts INTO strictness, and this pins that choice rather than leaving
  // it to be re-derived from an absent argument.
  it("the ROW LABEL agrees with the gate, not with the colour path", () => {
    expect(screenReadability({ text: WRAPPED_BAR_ROSTER, alternateBuffer: true })).toEqual({
      kind: "blind",
      reason: "unrecognized-fullscreen",
    });
  });
});
