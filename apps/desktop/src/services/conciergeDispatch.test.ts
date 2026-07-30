import { afterEach, describe, expect, it, vi } from "vitest";
import type { SuggestionButton } from "./suggestions/types";

// Mock the PTY layer (the write primitives) and the scrollback/detector so we test dispatch ROUTING,
// not the heuristic parser (which has its own tests). PtyGoneError is defined here so the source's
// `instanceof PtyGoneError` check (it imports from "../pty") matches what the tests throw.
vi.mock("../pty", () => {
  class PtyGoneError extends Error {}
  return { writePtyChainedStrict: vi.fn(async () => {}), submitPrompt: vi.fn(async () => {}), PtyGoneError };
});
vi.mock("./terminalScrollback", () => ({ getAgentScrollback: vi.fn(() => "SCREEN") }));
vi.mock("./suggestions/heuristics", () => ({ detectTerminalPrompts: vi.fn(() => [] as SuggestionButton[]) }));

import { PtyGoneError, submitPrompt, writePtyChainedStrict } from "../pty";
import { getAgentScrollback } from "./terminalScrollback";
import { detectTerminalPrompts } from "./suggestions/heuristics";
import { dispatchConciergeAnswer, matchAnswerToOption } from "./conciergeDispatch";

/** Any valid authority. These suites predate the dispatch authority gate and exercise DELIVERY,
 *  not authorization — the gate itself is covered by dispatchAuthority.test.ts and
 *  conciergeDispatch.gate.test.ts. `authority` is required and non-defaulted (see
 *  services/dispatchAuthority), so every call has to name one. */
const TEST_AUTHORITY = { kind: "suggestion", agentId: "a1" } as const;

const btn = (id: string, label: string, value: string): SuggestionButton => ({
  id,
  label,
  value,
  kind: "terminal",
  source: "heuristic",
});
const YN = [btn("1", "Yes", "y\n"), btn("2", "No", "n\n")];
const MENU = [btn("1", "1", "1\n"), btn("2", "2", "2\n"), btn("3", "3", "3\n")];

afterEach(() => {
  vi.clearAllMocks();
  (detectTerminalPrompts as unknown as ReturnType<typeof vi.fn>).mockReturnValue([]);
});

describe("matchAnswerToOption (pure)", () => {
  it("returns null for no options or empty text", () => {
    expect(matchAnswerToOption("yes", [])).toBeNull();
    expect(matchAnswerToOption("   ", YN)).toBeNull();
  });
  it("maps a bare number to that option", () => {
    expect(matchAnswerToOption("2", MENU)).toBe(MENU[1]);
    expect(matchAnswerToOption("2.", MENU)).toBe(MENU[1]);
  });
  it("maps yes/approve family to the affirmative option", () => {
    for (const w of ["yes", "y", "approve", "ok", "do it", "confirm"]) {
      expect(matchAnswerToOption(w, YN)).toBe(YN[0]);
    }
  });
  it("maps no/deny family to the negative option", () => {
    for (const w of ["no", "n", "deny", "reject", "cancel"]) {
      expect(matchAnswerToOption(w, YN)).toBe(YN[1]);
    }
  });
  it("matches an exact label case-insensitively", () => {
    expect(matchAnswerToOption("no", YN)).toBe(YN[1]);
  });
  it("returns null when nothing corresponds", () => {
    expect(matchAnswerToOption("banana", YN)).toBeNull();
    expect(matchAnswerToOption("9", MENU)).toBeNull();
  });
  it("falls back to on-screen POSITION for a bare number on a worded picker", () => {
    // "1"/"2" aren't the Yes/No labels, but map to the 1-based position.
    expect(matchAnswerToOption("1", YN)).toBe(YN[0]);
    expect(matchAnswerToOption("2", YN)).toBe(YN[1]);
    expect(matchAnswerToOption("3", YN)).toBeNull(); // out of range → refused
  });
  it("a 'yes'-family answer does NOT select a non-affirmative option that merely starts with Y", () => {
    const opts = [btn("1", "Y - use YAML", "1\n"), btn("2", "Other", "2\n")];
    expect(matchAnswerToOption("yes", opts)).toBeNull();
  });
});

describe("dispatchConciergeAnswer", () => {
  const setPrompt = (opts: SuggestionButton[]) =>
    (detectTerminalPrompts as unknown as ReturnType<typeof vi.fn>).mockReturnValue(opts);

  it("sends the matched option keystroke (CR-framed) when a picker is live", async () => {
    setPrompt(YN);
    const r = await dispatchConciergeAnswer("agent-1", "approve", { authority: TEST_AUTHORITY });
    expect(r).toMatchObject({ ok: true, path: "picker-option", agentId: "agent-1", matchedLabel: "Yes" });
    // frameSubmit normalizes "y\n" → exactly one trailing CR.
    expect(writePtyChainedStrict).toHaveBeenCalledWith("agent-1", "y\r");
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("re-reads the CURRENT scrollback before deciding", async () => {
    setPrompt(YN);
    await dispatchConciergeAnswer("agent-1", "no", { authority: TEST_AUTHORITY });
    expect(getAgentScrollback).toHaveBeenCalledWith("agent-1");
    expect(writePtyChainedStrict).toHaveBeenCalledWith("agent-1", "n\r");
  });

  it("refuses (no keystroke) when a picker is live but the answer maps to no option", async () => {
    setPrompt(YN);
    const r = await dispatchConciergeAnswer("agent-1", "maybe later", { authority: TEST_AUTHORITY });
    expect(r).toMatchObject({ ok: false, path: "ambiguous-picker", options: YN });
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  // ══ THE GATE THE HOST CANNOT ENFORCE (roborev 54569) ═════════════════════════════════════════
  // ConciergeHost suppresses its `answersLivePicker` check for a message the user ADDRESSED to an
  // agent by name. That check is only a MIRROR of the block below — it decides nothing — so the
  // dispatcher went on matching the text and pressing the button. A host-level test cannot see it,
  // because it mocks this function; the assertion has to be made here, against the real matcher and
  // the real write primitive.
  describe("neverPickerAnswer — an addressed message is never a keystroke", () => {
    it("does NOT press a matching option, and writes no keystroke at all", async () => {
      setPrompt(YN);
      const r = await dispatchConciergeAnswer("agent-1", "yes", {
        authority: TEST_AUTHORITY,
        userPrompt: true,
        neverPickerAnswer: true,
      });
      // Its OWN path, never a second use of ambiguous-picker: that path's copy claims the answer
      // mapped to nothing and tells the user to answer with just the option, both of which are
      // false here — which sent them round a loop with no stated exit (roborev 54665).
      expect(r).toMatchObject({ ok: false, path: "addressed-at-picker", options: YN });
      expect(writePtyChainedStrict).not.toHaveBeenCalled();
      expect(submitPrompt).not.toHaveBeenCalled();
    });

    // THE FLAG IS A PRECONDITION, NOT A TIE-BREAK (roborev 55309). It used to be read AFTER the
    // matcher, so a declared non-answer that failed to match fell into `ambiguous-picker` — whose
    // copy tells the user to "answer with just the option". The realistic text that lands here is a
    // concierge send carrying a staged file: `attachedPayload` prefixes the quoted temp path, every
    // arm of the matcher is anchored, so it never matches. Telling someone who attached a
    // screenshot to answer with just the option describes neither what they did nor what is in
    // their way. Reading the declaration first gives them the line that is actually true.
    it("refuses a declared non-answer that does NOT match, with its own path", async () => {
      setPrompt(YN);
      const r = await dispatchConciergeAnswer("agent-1", "'/tmp/shot.png' yes", {
        authority: TEST_AUTHORITY,
        userPrompt: true,
        neverPickerAnswer: true,
      });
      expect(r).toMatchObject({ ok: false, path: "addressed-at-picker", options: YN });
      expect(writePtyChainedStrict).not.toHaveBeenCalled();
      expect(submitPrompt).not.toHaveBeenCalled();
    });

    // …and the same non-matching text WITHOUT the declaration still reads as ambiguous, so the row
    // above is pinning the ordering rather than a change to the matcher.
    it("…while the same text without the flag is still ambiguous-picker", async () => {
      setPrompt(YN);
      const r = await dispatchConciergeAnswer("agent-1", "'/tmp/shot.png' yes", {
        authority: TEST_AUTHORITY,
        userPrompt: true,
      });
      expect(r).toMatchObject({ ok: false, path: "ambiguous-picker", options: YN });
    });

    // The exact text that used to get through: terse, matching, and user-authored.
    it("blocks a bare number that would have selected a menu row", async () => {
      setPrompt(MENU);
      const r = await dispatchConciergeAnswer("agent-1", "2", {
        authority: TEST_AUTHORITY,
        userPrompt: true,
        neverPickerAnswer: true,
      });
      expect(r.ok).toBe(false);
      expect(writePtyChainedStrict).not.toHaveBeenCalledWith("agent-1", "2\r");
    });

    // Same call WITHOUT the flag still presses it — so the row above is pinning the flag, not some
    // unrelated change to the matcher.
    // THE OTHER HALF — this is what makes the flag a BRANCH and not a constant, so hard-coding the
    // refusal above fails here. No separate `neverPickerAnswer: false` row is needed beside it:
    // conciergeDispatch reads the flag by TRUTHINESS, so an explicit `false` and an omitted flag are
    // the same input, and a row passing `false` would only restate this one with weaker assertions.
    // One was added and removed for exactly that reason (roborev 55462).
    it("…while the same send without the flag still takes the keystroke path", async () => {
      setPrompt(YN);
      const r = await dispatchConciergeAnswer("agent-1", "yes", {
        authority: TEST_AUTHORITY,
        userPrompt: true,
      });
      expect(r).toMatchObject({ ok: true, path: "picker-option" });
      expect(writePtyChainedStrict).toHaveBeenCalledWith("agent-1", "y\r");
    });

    // With NO picker on screen the flag is inert — an addressed message is an ordinary free-text
    // send, which is the overwhelmingly common case.
    it("does not disturb a send when no picker is up", async () => {
      setPrompt([]);
      const r = await dispatchConciergeAnswer("agent-1", "ship the DMG", {
        authority: TEST_AUTHORITY,
        userPrompt: true,
        neverPickerAnswer: true,
      });
      expect(r).toMatchObject({ ok: true, path: "free-text" });
      expect(submitPrompt).toHaveBeenCalledWith("agent-1", "ship the DMG");
    });
  });

  it("sends free text via submitPrompt when no prompt is on screen", async () => {
    setPrompt([]);
    const r = await dispatchConciergeAnswer("agent-1", "add a test for the webhook", { authority: TEST_AUTHORITY });
    expect(r).toMatchObject({ ok: true, path: "free-text", sent: "add a test for the webhook" });
    expect(submitPrompt).toHaveBeenCalledWith("agent-1", "add a test for the webhook");
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });

  it("reports pty-gone (not a silent success) when the free-text PTY is dead", async () => {
    setPrompt([]);
    (submitPrompt as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new PtyGoneError("dead"));
    const r = await dispatchConciergeAnswer("agent-1", "hello", { authority: TEST_AUTHORITY });
    expect(r).toMatchObject({ ok: false, path: "pty-gone" });
  });

  it("reports pty-gone when the picker write hits a dead PTY", async () => {
    setPrompt(YN);
    (writePtyChainedStrict as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new PtyGoneError("dead"));
    const r = await dispatchConciergeAnswer("agent-1", "yes", { authority: TEST_AUTHORITY });
    expect(r).toMatchObject({ ok: false, path: "pty-gone" });
  });

  it("refuses a blank/whitespace answer without writing anything", async () => {
    setPrompt([]);
    for (const blank of ["", "   ", "\n"]) {
      const r = await dispatchConciergeAnswer("agent-1", blank, { authority: TEST_AUTHORITY });
      expect(r).toMatchObject({ ok: false, path: "empty" });
    }
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });

  it("treats a null scrollback as no live prompt (free-text path)", async () => {
    (getAgentScrollback as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    setPrompt([]); // detector on "" → no options
    const r = await dispatchConciergeAnswer("agent-1", "hi there", { authority: TEST_AUTHORITY });
    expect(detectTerminalPrompts).toHaveBeenCalledWith("");
    expect(r).toMatchObject({ ok: true, path: "free-text" });
  });
});
