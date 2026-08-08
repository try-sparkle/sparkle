import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../clipboard", () => ({ copyToClipboard: vi.fn(async () => true) }));

import { copyToClipboard } from "../clipboard";
import {
  DICTATION_CLIPBOARD_CAP,
  appendDictatedForClipboard,
  capDictationBuffer,
  mirrorDictatedSegment,
  noteDictatedSegment,
  peekDictationClipboardBuffer,
  resetDictationClipboard,
} from "./dictationClipboard";

// NOTE the plain arrow body. `beforeEach(() => resetDictationClipboard())` would be fine, but the
// mock-returning shorthand is not: a hook's RETURN VALUE is treated as a teardown and vitest CALLS
// it after every test, which produces red rows with no AssertionError and no stack.
beforeEach(() => {
  resetDictationClipboard();
  vi.mocked(copyToClipboard).mockClear();
});

describe("the unit is the running text, not the last utterance", () => {
  it("accumulates every segment since the last reset", () => {
    // THE FOUNDER'S DECISION, and the load-bearing assertion of this file. Per-utterance would make
    // the third expectation "and file the bug" — the fragment — which is the answer he rejected
    // precisely because a message that came out in pieces is when you reach for the clipboard.
    expect(noteDictatedSegment("let's ship the toggle")).toBe("let's ship the toggle");
    expect(noteDictatedSegment("default off")).toBe("let's ship the toggle default off");
    expect(noteDictatedSegment("and file the bug")).toBe(
      "let's ship the toggle default off and file the bug",
    );
  });

  it("clears on reset, so the next stretch of talking starts clean", () => {
    noteDictatedSegment("first message");
    resetDictationClipboard();
    // NOT "first message second message" — this is the boundary that keeps the buffer bounded and
    // stops a Speak session gluing every message to the one before it.
    expect(noteDictatedSegment("second message")).toBe("second message");
  });

  it("returns null for a segment that adds nothing, rather than rewriting the clipboard", () => {
    noteDictatedSegment("hello");
    // A pointless clipboard write is not free: it stomps whatever the user copied a moment ago with
    // a value that did not even change.
    expect(noteDictatedSegment("   ")).toBeNull();
    expect(peekDictationClipboardBuffer()).toBe("hello");
  });
});

describe("the spacing rule", () => {
  it("matches ComposeBox.appendDictated's shape", () => {
    expect(appendDictatedForClipboard("", "a")).toBe("a");
    expect(appendDictatedForClipboard("a", "b")).toBe("a b");
    // Already spaced → do not double it.
    expect(appendDictatedForClipboard("a ", "b")).toBe("a b");
    // Segments arrive with recogniser whitespace; it must not survive into the join.
    expect(appendDictatedForClipboard("a", "  b  ")).toBe("a b");
    expect(appendDictatedForClipboard("a", "   ")).toBe("a");
  });
});

describe("the cap keeps the NEWEST text", () => {
  it("trims from the front", () => {
    const over = "x".repeat(DICTATION_CLIPBOARD_CAP) + "END";
    const { text, truncated } = capDictationBuffer(over);
    expect(truncated).toBe(true);
    expect(text).toHaveLength(DICTATION_CLIPBOARD_CAP);
    // Dropping the START of a message is the exact silent loss this whole feature exists to
    // prevent, so the assertion is on the tail surviving — not merely on the length.
    expect(text.endsWith("END")).toBe(true);
  });

  it("leaves anything under the cap untouched", () => {
    expect(capDictationBuffer("short")).toEqual({ text: "short", truncated: false });
  });
});

describe("the setting gates it", () => {
  it("writes nothing when the setting is off — the default", async () => {
    expect(await mirrorDictatedSegment("something private", false)).toBe(false);
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("does not advance the buffer while off", async () => {
    await mirrorDictatedSegment("said while the toggle was off", false);
    await mirrorDictatedSegment("said after switching it on", true);
    // Switching the feature ON must not retroactively put words on a system-wide surface that the
    // user never agreed to publish.
    expect(copyToClipboard).toHaveBeenCalledWith("said after switching it on");
  });

  it("writes the running text when on", async () => {
    expect(await mirrorDictatedSegment("one", true)).toBe(true);
    await mirrorDictatedSegment("two", true);
    expect(copyToClipboard).toHaveBeenLastCalledWith("one two");
  });
});
