// A MOUNTED SEND MADE WHILE A PICKER IS LIVE IS DELIVERED, NOT BOUNCED AND NOT HELD
// (beads sparkle-9gsjqm, sparkle-93wnu3).
//
// THE FOUNDER'S RECURRING P0: text he types into a mounted build-agent pane does not reach that
// agent. `neverPickerAnswer` is true for every mounted composer send, so a message typed while a
// picker happened to be on screen took `addressed-at-picker` and came straight back. An earlier fix
// made those arms HOLD instead, which only moved the loss later — the hold's release condition is a
// predicate that can be permanently wrong about the screen, and the message was dropped at
// MAX_AGE_MS. Asked directly (2026-08-20), the founder chose "Never hold — just send it".
//
// WHAT THESE ROWS ASSERT IS THE SIDE EFFECT — that `submitPrompt` was called with his exact text,
// never merely that some friendly status came back. The refusing rows pin that NOTHING reached the
// PTY by either primitive, so a guard that let everything through cannot pass this file.
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
import { dispatchConciergeAnswer } from "./conciergeDispatch";
import { conciergeToolAuthority } from "./dispatchAuthority";

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

function expectNothingWritten(): void {
  expect(submitPrompt).not.toHaveBeenCalled();
  expect(writePtyChainedStrict).not.toHaveBeenCalled();
}

/** The founder's mounted composer send, field for field as ConciergeHost builds it: a `mount`
 *  authority, `mountedSend` on (`mentionAim?.via === "mount"`), `neverPickerAnswer` on
 *  (`!!mentionAim && addressable`), and a genuine user prompt. */
const MOUNTED = {
  authority: { kind: "mount", agentId: AGENT } as const,
  userPrompt: true,
  neverPickerAnswer: true,
  mountedSend: true,
};

/** The concierge's own tool layer, through the one gate that can mint the arm. */
const TOOL_CALL = conciergeToolAuthority("call-1", { tier: "allow" })!;

beforeEach(() => {
  vi.mocked(getAgentViewport).mockReturnValue(null);
  vi.mocked(detectTerminalPrompts).mockReturnValue([]);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("a mounted send at a live picker", () => {
  it("is delivered rather than refused or queued", async () => {
    atALivePicker();
    const r = await dispatchConciergeAnswer(AGENT, TYPED, MOUNTED);
    expect(r.ok).toBe(true);
    expect(r.path).toBe("free-text");
    expect(submitPrompt).toHaveBeenCalledWith(AGENT, TYPED, expect.anything());
  });

  // DELIVERED AS A MESSAGE, NEVER COLLAPSED INTO A KEYSTROKE — the standing rule for an addressed
  // send (roborev 54569/55400), and a mounted send is an addressed send. Pressing a button the
  // human never read is the least recoverable thing this path can do. `writePtyChainedStrict` is
  // the keystroke primitive; `submitPrompt` is the prompt one. This row uses a word that WOULD have
  // matched an option, and a terse one that WOULD have been pressed, so a version that answered the
  // menu on his behalf goes red here.
  it("is delivered as a prompt, not as a picker keystroke, even when it matches an option", async () => {
    atALivePicker();
    // A whole-phrase yes: matches `YES_WORDS` and is terse, so it is exactly what the picker path
    // would have collapsed to `y\r`.
    await dispatchConciergeAnswer(AGENT, "yes", MOUNTED);
    // A bare ordinal: `matchAnswerToOption` resolves it by 1-based ON-SCREEN POSITION, which is the
    // most dangerous collapse of the three (it presses a row of a menu the founder may not have
    // been reading).
    await dispatchConciergeAnswer(AGENT, "1", MOUNTED);
    expect(submitPrompt).toHaveBeenCalledWith(AGENT, "yes", expect.anything());
    expect(submitPrompt).toHaveBeenCalledWith(AGENT, "1", expect.anything());
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });

  // ── AND IT IS THE BLOCK THAT IS SKIPPED, NOT ONE ARM OF IT ─────────────────────────────────
  // The exemption is on the block, so the other two refusals inside it (`ambiguous-picker`, twice)
  // are unreachable for a mounted send as well. These rows drive text that WOULD have taken each of
  // them and pin that it is delivered instead — a rule implemented at only some arms is how this
  // defect happened in the first place.
  it("delivers a non-matching answer instead of reporting it ambiguous", async () => {
    atALivePicker();
    const r = await dispatchConciergeAnswer(AGENT, "neither of those, actually", MOUNTED);
    expect(r.path).toBe("free-text");
    expect(submitPrompt).toHaveBeenCalledWith(AGENT, "neither of those, actually", expect.anything());
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });

  it("delivers a matching-but-not-terse user prompt instead of reporting it ambiguous", async () => {
    atALivePicker(PUNCTUATED_OPTIONS);
    // MATCHES option 1 exactly (the label, verbatim) and is still not terse — see
    // PUNCTUATED_OPTIONS for why that combination exists and why nothing else reaches this arm.
    const r = await dispatchConciergeAnswer(AGENT, "Keep going?", MOUNTED);
    expect(r.path).toBe("free-text");
    expect(submitPrompt).toHaveBeenCalledWith(AGENT, "Keep going?", expect.anything());
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });
});

// ══ AND THE GUARD IS NOT WEAKENED FOR ANYONE ELSE ═══════════════════════════════════════════════
// The exemption is for ONE caller — the founder, mounted and watching the pane he typed into. A
// MODEL guessing at a screen it cannot see, or an auto-resume firing every 15s, cannot take a bad
// write back, so they keep the refusal verbatim. These rows fail the moment someone "simplifies"
// `mountedHumanSend` into an unconditional exemption.
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
  });
});
