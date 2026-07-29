// @vitest-environment jsdom
//
// `copyToClipboard` had no tests at all, which is how the selection-clobbering below survived: it
// is the shared helper behind EVERY copy in the app (the terminal, the pinned prompt, the trial
// chrome, the concierge's copy button, and copy-on-selection), and its fallback path is the one no
// unit test elsewhere can reach — the suites that mock it never run it, and jsdom has no real
// `execCommand`, so the callers' own tests stub it out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { copyToClipboard } from "./clipboard";

/** Swap `navigator.clipboard` for the duration of a test. */
function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

/** Put a real, non-collapsed selection across a paragraph and hand back the text it covers. */
function selectSomeText(): { text: string; node: Node } {
  const p = document.createElement("p");
  p.textContent = "the words the user dragged across";
  document.body.appendChild(p);
  const range = document.createRange();
  range.selectNodeContents(p);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  return { text: p.textContent, node: p };
}

beforeEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

afterEach(() => {
  vi.restoreAllMocks();
  setClipboard(undefined);
});

describe("the async Clipboard API is preferred", () => {
  it("writes through navigator.clipboard and reports success", async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    expect(await copyToClipboard("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls through to execCommand when the async write throws", async () => {
    setClipboard({
      writeText: vi.fn(async () => {
        throw new Error("denied");
      }),
    });
    const exec = vi.fn(() => true);
    document.execCommand = exec as unknown as typeof document.execCommand;

    expect(await copyToClipboard("hello")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });
});

describe("the execCommand fallback leaves the user's selection where it found it", () => {
  beforeEach(() => {
    // No async API at all — the only way to reach the fallback.
    setClipboard(undefined);
  });

  it("restores the selection the temp textarea stole", async () => {
    // THE BUG THIS PINS. `ta.select()` replaces the document selection and removing the textarea
    // leaves it collapsed, so the fallback used to end with nothing highlighted. Invisible when the
    // caller is a copy BUTTON, but copy-on-selection and the terminal's copy-on-select are gestures
    // whose subject IS the highlight: you drag across an answer, release, and watch the selection
    // vanish at the moment it was copied — which reads as "it didn't take".
    const { text } = selectSomeText();
    document.execCommand = vi.fn(() => true) as unknown as typeof document.execCommand;

    expect(await copyToClipboard(text)).toBe(true);

    const sel = window.getSelection();
    expect(sel?.rangeCount).toBe(1);
    expect(sel?.isCollapsed).toBe(false);
    expect(sel?.toString()).toBe(text);
  });

  it("hands focus back to whatever had it", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    document.execCommand = vi.fn(() => true) as unknown as typeof document.execCommand;

    await copyToClipboard("hello");
    expect(document.activeElement).toBe(input);
  });

  it("removes the temp textarea whether or not the copy worked", async () => {
    document.execCommand = vi.fn(() => false) as unknown as typeof document.execCommand;
    expect(await copyToClipboard("hello")).toBe(false);
    expect(document.querySelectorAll("textarea").length).toBe(0);
  });

  it("reports failure rather than throwing when nothing works — and still cleans up", async () => {
    // A THROW, not a false return, and the distinction is the whole point of the `finally`.
    // `execCommand` raises a SecurityError in a hardened webview and a TypeError where it has been
    // removed — the same class of environment whose missing `navigator.clipboard` sent us to this
    // path in the first place. With the cleanup on the happy path only, that throw left the hidden
    // textarea in the DOM holding the copied text and holding FOCUS, so the user's next keystrokes
    // went into an invisible offscreen box, with the selection stranded on it — and one leaked per
    // attempt. Strictly worse than the missing restore this path was written to fix.
    // Focus FIRST, then select: focusing an input moves the document selection into it, so doing
    // it the other way round would wipe the selection before `copyToClipboard` ever saw it — and
    // the test would then be asserting against a state the helper never had.
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const { text } = selectSomeText();
    document.execCommand = vi.fn(() => {
      throw new Error("no clipboard here");
    }) as unknown as typeof document.execCommand;

    expect(await copyToClipboard(text)).toBe(false);

    expect(document.querySelectorAll("textarea").length).toBe(0);
    expect(document.activeElement).toBe(input);
    const sel = window.getSelection();
    expect(sel?.isCollapsed).toBe(false);
    expect(sel?.toString()).toBe(text);
  });
});
