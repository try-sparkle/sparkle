import { afterEach, describe, expect, it, vi } from "vitest";
import type { SuggestionButton } from "./suggestions/types";

// Mock the PTY layer (the write primitives) and the scrollback/detector so we test dispatch ROUTING,
// not the heuristic parser (which has its own tests). PtyGoneError is defined here so the source's
// `instanceof PtyGoneError` check (it imports from "../pty") matches what the tests throw.
vi.mock("../pty", () => {
  class PtyGoneError extends Error {}
  return { writePty: vi.fn(async () => {}), submitPrompt: vi.fn(async () => {}), PtyGoneError };
});
vi.mock("./terminalScrollback", () => ({ getAgentScrollback: vi.fn(() => "SCREEN") }));
vi.mock("./suggestions/heuristics", () => ({ detectTerminalPrompts: vi.fn(() => [] as SuggestionButton[]) }));

import { PtyGoneError, submitPrompt, writePty } from "../pty";
import { getAgentScrollback } from "./terminalScrollback";
import { detectTerminalPrompts } from "./suggestions/heuristics";
import { dispatchConciergeAnswer, matchAnswerToOption } from "./conciergeDispatch";

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
    const r = await dispatchConciergeAnswer("agent-1", "approve");
    expect(r).toMatchObject({ ok: true, path: "picker-option", agentId: "agent-1", matchedLabel: "Yes" });
    // frameSubmit normalizes "y\n" → exactly one trailing CR.
    expect(writePty).toHaveBeenCalledWith("agent-1", "y\r");
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("re-reads the CURRENT scrollback before deciding", async () => {
    setPrompt(YN);
    await dispatchConciergeAnswer("agent-1", "no");
    expect(getAgentScrollback).toHaveBeenCalledWith("agent-1");
    expect(writePty).toHaveBeenCalledWith("agent-1", "n\r");
  });

  it("refuses (no keystroke) when a picker is live but the answer maps to no option", async () => {
    setPrompt(YN);
    const r = await dispatchConciergeAnswer("agent-1", "maybe later");
    expect(r).toMatchObject({ ok: false, path: "ambiguous-picker", options: YN });
    expect(writePty).not.toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  it("sends free text via submitPrompt when no prompt is on screen", async () => {
    setPrompt([]);
    const r = await dispatchConciergeAnswer("agent-1", "add a test for the webhook");
    expect(r).toMatchObject({ ok: true, path: "free-text", sent: "add a test for the webhook" });
    expect(submitPrompt).toHaveBeenCalledWith("agent-1", "add a test for the webhook");
    expect(writePty).not.toHaveBeenCalled();
  });

  it("reports pty-gone (not a silent success) when the free-text PTY is dead", async () => {
    setPrompt([]);
    (submitPrompt as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new PtyGoneError("dead"));
    const r = await dispatchConciergeAnswer("agent-1", "hello");
    expect(r).toMatchObject({ ok: false, path: "pty-gone" });
  });

  it("reports pty-gone when the picker write hits a dead PTY", async () => {
    setPrompt(YN);
    (writePty as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new PtyGoneError("dead"));
    const r = await dispatchConciergeAnswer("agent-1", "yes");
    expect(r).toMatchObject({ ok: false, path: "pty-gone" });
  });

  it("refuses a blank/whitespace answer without writing anything", async () => {
    setPrompt([]);
    for (const blank of ["", "   ", "\n"]) {
      const r = await dispatchConciergeAnswer("agent-1", blank);
      expect(r).toMatchObject({ ok: false, path: "empty" });
    }
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(writePty).not.toHaveBeenCalled();
  });

  it("treats a null scrollback as no live prompt (free-text path)", async () => {
    (getAgentScrollback as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    setPrompt([]); // detector on "" → no options
    const r = await dispatchConciergeAnswer("agent-1", "hi there");
    expect(detectTerminalPrompts).toHaveBeenCalledWith("");
    expect(r).toMatchObject({ ok: true, path: "free-text" });
  });
});
