// A MOUNTED SEND MADE WHILE A PICKER IS LIVE IS HELD, NOT BOUNCED (bead sparkle-9gsjqm).
//
// THE FOUNDER'S RECURRING P0: text he types into a mounted build-agent pane does not reach that
// agent. `ConciergeHost` declares a mounted send HOLDABLE and deliberately falls through to
// `dispatchConciergeAnswer` rather than refusing it, promising in a comment that "the actual hold
// happens a few lines down… via `holdForScreenClear`". Three of the dispatcher's refusal arms kept
// that promise; the three inside the PICKER block did not — they returned their refusal with no
// hold attempt at all. `neverPickerAnswer` is true for every mounted composer send, so a message
// typed while a picker happened to be on screen took `addressed-at-picker` and came straight back.
//
// WHAT THESE ROWS ASSERT IS THE SIDE EFFECT. `path: "queued"` on its own would be satisfied by a
// version that accepted the words and dropped them — the same bug in a friendlier status code — so
// the load-bearing row drives the real flush and pins that `submitPrompt` was called with the
// founder's text. The refusing rows pin that NOTHING reached the PTY by either primitive.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuggestionButton } from "./suggestions/types";

vi.mock("../pty", () => {
  class PtyGoneError extends Error {}
  return {
    writePtyChainedStrict: vi.fn(async () => {}),
    submitPrompt: vi.fn(async () => {}),
    PtyGoneError,
  };
});
vi.mock("./terminalScrollback", () => ({ getAgentScrollback: vi.fn(() => "SCREEN") }));
vi.mock("./suggestions/heuristics", () => ({
  detectTerminalPrompts: vi.fn((): SuggestionButton[] => []),
}));
vi.mock("./terminalViewport", () => ({ getAgentViewport: vi.fn(() => null) }));

import { submitPrompt, writePtyChainedStrict } from "../pty";
import { detectTerminalPrompts } from "./suggestions/heuristics";
import { getAgentViewport } from "./terminalViewport";
import { dispatchConciergeAnswer, flushScreenHeldSends } from "./conciergeDispatch";
import { conciergeToolAuthority } from "./dispatchAuthority";
import { resetScreenHeldSends } from "./screenHoldQueue";

const AGENT = "agent-1";
const TYPED = "when you're done, rebase onto main and push";

/** The exact option shape the founder's screens produce: `detectClaudeCodePicker` renders every
 *  option as `${n} · ${label}`, and the values are ordinals rather than the y/n pair — so the
 *  dispatcher's `viewportOffersYesNo` waiver stays off and the ordinary scrollback parse stands. */
const OPTIONS = [
  { label: "1 · Yes", value: "1\n" },
  { label: "2 · No", value: "2\n" },
] as unknown as SuggestionButton[];

/**
 * A menu whose labels END IN PUNCTUATION, which is the only shape that reaches the THIRD picker
 * arm at all. `isTerseAnswer` strips a trailing `?`/`.`/`!` before comparing against the labels
 * while `matchAnswerToOption` does not, so a user echoing such a label verbatim MATCHES an option
 * and is nevertheless not terse — the one combination that lands on `userPrompt && !isTerseAnswer`.
 * With any ordinary label the matcher's three arms are a strict subset of terseness and that branch
 * cannot be reached, so a row using one would leave the third call site untestable (and did: the
 * first cut of this file was FLAGged by `mutation-check --line` for exactly that).
 */
const PUNCTUATED_OPTIONS = [
  { label: "Keep going?", value: "1\n" },
  { label: "Stop and ask me?", value: "2\n" },
] as unknown as SuggestionButton[];

/** A live permission dialog on the NORMAL buffer, so neither screen guard above the picker block is
 *  what decides these rows — the picker block itself is. (Same fixture shape the alt-screen suite
 *  uses for its "still answers a live picker" row, for the same reason.) */
function atALivePicker(options: SuggestionButton[] = OPTIONS): void {
  vi.mocked(getAgentViewport).mockReturnValue({
    text: "Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel · Tab to amend",
    alternateBuffer: false,
  });
  vi.mocked(detectTerminalPrompts).mockReturnValue(options);
}

/** The picker is gone; an ordinary shell prompt is all that is left. */
function pickerCleared(): void {
  vi.mocked(getAgentViewport).mockReturnValue({ text: "$ ", alternateBuffer: false });
  vi.mocked(detectTerminalPrompts).mockReturnValue([]);
}

function expectNothingWritten(): void {
  expect(submitPrompt).not.toHaveBeenCalled();
  expect(writePtyChainedStrict).not.toHaveBeenCalled();
}

/** The founder's mounted composer send, field for field as ConciergeHost builds it: a `mount`
 *  authority, `holdForScreenClear` on (`mentionAim?.via === "mount"`), `neverPickerAnswer` on
 *  (`!!mentionAim && addressable`), and a genuine user prompt. */
const MOUNTED = {
  authority: { kind: "mount", agentId: AGENT } as const,
  userPrompt: true,
  neverPickerAnswer: true,
  holdForScreenClear: true,
};

/** The concierge's own tool layer, through the one gate that can mint the arm. */
const TOOL_CALL = conciergeToolAuthority("call-1", { tier: "allow" })!;

beforeEach(() => {
  vi.mocked(getAgentViewport).mockReturnValue(null);
  vi.mocked(detectTerminalPrompts).mockReturnValue([]);
  resetScreenHeldSends();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("a mounted send at a live picker", () => {
  it("is queued rather than refused, and writes nothing yet", async () => {
    atALivePicker();
    const r = await dispatchConciergeAnswer(AGENT, TYPED, MOUNTED);
    expect(r.ok).toBe(true);
    expect(r.path).toBe("queued");
    expect(r.heldReason).toBe("screen");
    expectNothingWritten();
  });

  // THE ROW THAT MATTERS. Queueing with nothing to drain it reproduces the founder's bug exactly —
  // his words accepted and never delivered — so this drives the real flush (what
  // hooks/useScreenHoldDrain calls once its poll sees the screen clear) and asserts the write.
  it("reaches the agent once the picker clears and the queue is flushed", async () => {
    atALivePicker();
    const held = await dispatchConciergeAnswer(AGENT, TYPED, MOUNTED);
    expect(held.path).toBe("queued");
    expectNothingWritten();

    pickerCleared();
    const [flushed] = await flushScreenHeldSends(AGENT);
    expect(flushed?.ok).toBe(true);
    expect(flushed?.path).toBe("free-text");
    expect(submitPrompt).toHaveBeenCalledWith(AGENT, TYPED, expect.anything());
  });

  // THE HELD MESSAGE IS DELIVERED AS A MESSAGE, NEVER COLLAPSED INTO A KEYSTROKE. Holding at a
  // picker would be worse than the refusal it replaces if the flush pressed a button with it: the
  // founder's rule is that his text is delivered to THAT agent, not that it answers a question he
  // never read. `writePtyChainedStrict` is the keystroke primitive; `submitPrompt` is the prompt one.
  it("is delivered as a prompt, not as a picker keystroke", async () => {
    atALivePicker();
    await dispatchConciergeAnswer(AGENT, "yes", MOUNTED);
    pickerCleared();
    await flushScreenHeldSends(AGENT);
    expect(submitPrompt).toHaveBeenCalledWith(AGENT, "yes", expect.anything());
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });

  // ── THE OTHER TWO PICKER ARMS TAKE THE SAME ROUTE ──────────────────────────────────────────
  // `addressed-at-picker` above is the arm the founder's own send hits. These two are the arms a
  // hold-permitted caller reaches when it has NOT declared the text a non-answer: the rule is
  // per-arm, and a per-arm rule that only three of six arms implement is how this defect happened
  // in the first place. Each row also keeps its own `holdForScreenClear` call site honest under
  // mutation — one shared row would go green with the other two sites still returning a refusal.
  it("holds a non-matching answer instead of reporting it ambiguous", async () => {
    atALivePicker();
    const r = await dispatchConciergeAnswer(AGENT, "neither of those, actually", {
      ...MOUNTED,
      neverPickerAnswer: false,
    });
    expect(r.path).toBe("queued");
    expectNothingWritten();

    pickerCleared();
    await flushScreenHeldSends(AGENT);
    expect(submitPrompt).toHaveBeenCalledWith(AGENT, "neither of those, actually", expect.anything());
  });

  it("holds a matching-but-not-terse user prompt instead of reporting it ambiguous", async () => {
    atALivePicker(PUNCTUATED_OPTIONS);
    // MATCHES option 1 exactly (the label, verbatim) and is still not terse — see
    // PUNCTUATED_OPTIONS for why that combination exists and why nothing else reaches this arm.
    const r = await dispatchConciergeAnswer(AGENT, "Keep going?", {
      ...MOUNTED,
      neverPickerAnswer: false,
    });
    expect(r.path).toBe("queued");
    expectNothingWritten();

    pickerCleared();
    await flushScreenHeldSends(AGENT);
    expect(submitPrompt).toHaveBeenCalledWith(AGENT, "Keep going?", expect.anything());
  });
});

// ══ AND THE GUARD IS NOT WEAKENED FOR ANYONE ELSE ═══════════════════════════════════════════════
// The hold exists for ONE caller — the founder, mounted and watching the pane he typed into. A
// MODEL guessing at a screen it cannot see, or an auto-resume firing every 15s, cannot take a bad
// write back, so they keep the refusal verbatim. These rows fail the moment someone "simplifies"
// the three new call sites into an unconditional hold.
describe("a machine caller at the same picker is still refused", () => {
  it("refuses the concierge's own send_to_agent_terminal", async () => {
    atALivePicker();
    // Minted through the real gate, never hand-built: `policy` is a stamp only that module can
    // mint, so a literal would fail `isDispatchAuthority` and this row would be measuring
    // `unauthorized` — a refusal that says nothing about the picker arms under test.
    const r = await dispatchConciergeAnswer(AGENT, TYPED, {
      authority: TOOL_CALL,
      userPrompt: true,
      neverPickerAnswer: true,
    });
    expect(r.ok).toBe(false);
    expect(r.path).toBe("addressed-at-picker");
    expectNothingWritten();
    // And nothing was smuggled into the queue to be delivered by a later poll tick, which is the
    // way a "refusal" could still turn into the write this row exists to prevent.
    pickerCleared();
    expect(await flushScreenHeldSends(AGENT)).toEqual([]);
    expectNothingWritten();
  });

  it("refuses the goal auto-resume", async () => {
    atALivePicker();
    const r = await dispatchConciergeAnswer(AGENT, "continue", {
      authority: { kind: "goal-continue", agentId: AGENT },
      neverPickerAnswer: true,
    });
    expect(r.ok).toBe(false);
    expect(r.path).toBe("addressed-at-picker");
    expectNothingWritten();
    pickerCleared();
    expect(await flushScreenHeldSends(AGENT)).toEqual([]);
    expectNothingWritten();
  });

  // The same two callers on the OTHER two arms — a machine send that does not declare itself a
  // non-answer must still be told the answer was ambiguous rather than quietly queued.
  it("refuses a non-matching machine answer as ambiguous rather than holding it", async () => {
    atALivePicker();
    const r = await dispatchConciergeAnswer(AGENT, "neither of those, actually", {
      authority: { kind: "goal-continue", agentId: AGENT },
      userPrompt: true,
    });
    expect(r.ok).toBe(false);
    expect(r.path).toBe("ambiguous-picker");
    expectNothingWritten();
    pickerCleared();
    expect(await flushScreenHeldSends(AGENT)).toEqual([]);
  });

  it("refuses a non-terse machine answer as ambiguous rather than holding it", async () => {
    atALivePicker(PUNCTUATED_OPTIONS);
    const r = await dispatchConciergeAnswer(AGENT, "Keep going?", {
      authority: { kind: "goal-continue", agentId: AGENT },
      userPrompt: true,
    });
    expect(r.ok).toBe(false);
    expect(r.path).toBe("ambiguous-picker");
    expectNothingWritten();
    pickerCleared();
    expect(await flushScreenHeldSends(AGENT)).toEqual([]);
  });
});
