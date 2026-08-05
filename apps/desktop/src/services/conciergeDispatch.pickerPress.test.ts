// ANSWERING A PERMISSION PICKER THAT IS ON THE ALTERNATE SCREEN (bead sparkle-jk8zt).
//
// ══ THE BUG ═════════════════════════════════════════════════════════════════════════════════════
// The concierge could not answer ANY approval prompt. Four agents in one day, four for four, every
// `select_picker_option` refused with `alternate-screen` — while `read_picker_options` SUCCEEDED on
// the same agent in the same instant, returning clean numbered options and a stable fingerprint.
//
// The write path was the wrong one. `isClaudeCodeScreen` REQUIRES its composer-box family, and
// Claude Code's permission dialog REPLACES the composer box — so on an approval prompt exactly one
// marker family survives and the predicate returns false, i.e. "treat this as a full-screen app".
// That made the Claude Code carve-out structurally incapable of firing during a picker, which is
// precisely when answering one is the point. `claudeCodeScreen.test.ts` pins that reading and it is
// still correct FOR FREE TEXT; what was missing was an exception for the one write that carries its
// own proof.
//
// ══ WHY THESE TESTS USE THE REAL DETECTOR ═══════════════════════════════════════════════════════
// The sibling `conciergeDispatch.altScreen.test.ts` mocks `suggestions/heuristics` down to
// `detectTerminalPrompts`. That is right for a file about refusals, and WRONG here: the whole claim
// under test is that the dispatcher independently re-derives a fingerprint from the live screen, and
// a mocked detector would let a broken derivation pass. So heuristics is NOT mocked, the screen is
// the captured 2.1.220 approval dialog, and the fingerprint is produced by the same function the
// tool layer calls. Only the PTY and the two screen readers are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pty", () => {
  class PtyGoneError extends Error {}
  return {
    writePtyChainedStrict: vi.fn(async () => {}),
    submitPrompt: vi.fn(async () => {}),
    PtyGoneError,
  };
});
vi.mock("./terminalScrollback", () => ({ getAgentScrollback: vi.fn(() => "") }));
vi.mock("./terminalViewport", () => ({ getAgentViewport: vi.fn(() => null) }));

import { submitPrompt, writePtyChainedStrict } from "../pty";
import { getAgentScrollback } from "./terminalScrollback";
import { getAgentViewport } from "./terminalViewport";
import { dispatchConciergeAnswer, liveOptionsFor } from "./conciergeDispatch";
import { pickerFingerprint } from "./pickerFingerprint";
import { APPROVAL_2_1_220 } from "../engine/capturedScreens.fixture";
import { isClaudeCodeScreen } from "../engine/claudeCodeScreen";

const AGENT = "agent-1";
const OPTS = { authority: { kind: "mention", agentId: AGENT } as const, userPrompt: false };

/** The real captured Claude Code permission dialog, on the alternate buffer — the exact state in
 *  which all four refusals happened. */
function onApprovalPromptInAltScreen(): void {
  vi.mocked(getAgentScrollback).mockReturnValue(APPROVAL_2_1_220);
  vi.mocked(getAgentViewport).mockReturnValue({
    text: APPROVAL_2_1_220,
    alternateBuffer: true,
  });
}

function expectNothingWritten(): void {
  expect(submitPrompt).not.toHaveBeenCalled();
  expect(writePtyChainedStrict).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.mocked(getAgentViewport).mockReturnValue(null);
  vi.mocked(getAgentScrollback).mockReturnValue("");
});
afterEach(() => {
  vi.clearAllMocks();
});

// ══ THE PRECONDITIONS THAT MAKE THE REST OF THIS FILE MEAN ANYTHING ═════════════════════════════
// If either of these drifts, the tests below would still pass while testing nothing of interest —
// a picker press on a screen that was never alt-screen, or one the old code would have allowed. So
// the trap is pinned explicitly rather than assumed.
describe("the trap: an approval dialog is on the alternate screen AND is not recognised", () => {
  it("does not read as Claude Code, which is why the write path refused it", () => {
    expect(isClaudeCodeScreen(APPROVAL_2_1_220)).toBe(false);
  });

  it("nonetheless offers real, readable options — the contradiction that started this", () => {
    onApprovalPromptInAltScreen();
    const options = liveOptionsFor(AGENT);
    expect(options.length).toBeGreaterThan(0);
    // A non-empty fingerprint is what `read_picker_options` hands the caller, and it succeeding here
    // is the READ half of the contradiction: same agent, same instant, the read works.
    expect(pickerFingerprint(AGENT, options)).not.toBe("");
  });
});

describe("a fingerprinted picker press is answered, not refused", () => {
  it("presses the option and writes to the PTY", async () => {
    onApprovalPromptInAltScreen();
    const options = liveOptionsFor(AGENT);
    const fingerprint = pickerFingerprint(AGENT, options);

    const r = await dispatchConciergeAnswer(AGENT, options[0]!.value, {
      ...OPTS,
      pickerPress: { fingerprint },
    });

    expect(r.path).not.toBe("alternate-screen");
    expect(r.ok).toBe(true);
    // THE SIDE EFFECT, not the verdict: a "success" that wrote nothing would be the same outage.
    const wrote =
      vi.mocked(submitPrompt).mock.calls.length +
      vi.mocked(writePtyChainedStrict).mock.calls.length;
    expect(wrote).toBeGreaterThan(0);
  });

  it("refuses a press whose fingerprint does not match the live screen", async () => {
    onApprovalPromptInAltScreen();

    const r = await dispatchConciergeAnswer(AGENT, "1\r", {
      ...OPTS,
      pickerPress: { fingerprint: "not-the-menu-on-screen" },
    });

    expect(r.ok).toBe(false);
    expect(r.path).toBe("alternate-screen");
    expectNothingWritten();
  });

  it("refuses an empty fingerprint rather than treating it as a match", async () => {
    onApprovalPromptInAltScreen();

    const r = await dispatchConciergeAnswer(AGENT, "1\r", {
      ...OPTS,
      pickerPress: { fingerprint: "" },
    });

    expect(r.ok).toBe(false);
    expect(r.path).toBe("alternate-screen");
    expectNothingWritten();
  });
});

// ══ THE HALF THAT MUST NOT MOVE ═════════════════════════════════════════════════════════════════
// The guard exists because typed text in a real pager RUNS AS COMMANDS, and this tool writes into
// live PTYs. The exception above is scoped to a fingerprinted option press; prose gets nothing.
describe("free text is still refused in the same state", () => {
  it("refuses free text on the very screen a picker press is allowed through", async () => {
    onApprovalPromptInAltScreen();

    const r = await dispatchConciergeAnswer(AGENT, "rebase onto main please", OPTS);

    expect(r.ok).toBe(false);
    expect(r.path).toBe("alternate-screen");
    expectNothingWritten();
  });

  it("refuses free text in a real pager, where no menu exists to fingerprint", async () => {
    vi.mocked(getAgentScrollback).mockReturnValue("~\n~\n~");
    vi.mocked(getAgentViewport).mockReturnValue({ text: "~\n~\n~", alternateBuffer: true });

    const r = await dispatchConciergeAnswer(AGENT, "rebase onto main please", OPTS);

    expect(r.ok).toBe(false);
    expect(r.path).toBe("alternate-screen");
    expectNothingWritten();
  });

  // THE FORGERY CASE. `vim` has no menu, so `liveOptionsFor` returns nothing and there is no
  // fingerprint to match — a caller that invents one gets refused anyway. This is what makes the
  // exemption evidence-based rather than a flag a caller can simply assert.
  it("refuses a claimed picker press when there is no picker on screen", async () => {
    vi.mocked(getAgentScrollback).mockReturnValue("~\n~\n~");
    vi.mocked(getAgentViewport).mockReturnValue({ text: "~\n~\n~", alternateBuffer: true });

    const r = await dispatchConciergeAnswer(AGENT, "1\r", {
      ...OPTS,
      pickerPress: { fingerprint: "fabricated" },
    });

    expect(r.ok).toBe(false);
    expect(r.path).toBe("alternate-screen");
    expectNothingWritten();
  });
});
