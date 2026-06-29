import { describe, it, expect } from "vitest";
import { isCopySelectionKey, type CopyKeyEvent } from "./copySelectionKey";

const ev = (over: Partial<CopyKeyEvent>): CopyKeyEvent => ({
  type: "keydown",
  key: "c",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  repeat: false,
  ...over,
});

describe("isCopySelectionKey", () => {
  it("matches ⌘C keydown", () => {
    expect(isCopySelectionKey(ev({}))).toBe(true);
    expect(isCopySelectionKey(ev({ key: "C" }))).toBe(true); // case-insensitive (with shift)
  });

  it("ignores the keyup half of the chord so it doesn't re-copy", () => {
    expect(isCopySelectionKey(ev({ type: "keyup" }))).toBe(false);
  });

  it("ignores OS key-repeat keydowns while ⌘C is held", () => {
    expect(isCopySelectionKey(ev({ repeat: true }))).toBe(false);
  });

  it("does NOT match Ctrl+C — that must stay a SIGINT to the PTY", () => {
    expect(isCopySelectionKey(ev({ metaKey: false, ctrlKey: true }))).toBe(false);
    // Even ⌘+Ctrl+C is excluded so we never swallow a control combo.
    expect(isCopySelectionKey(ev({ ctrlKey: true }))).toBe(false);
  });

  it("does not match other keys or Alt combos", () => {
    expect(isCopySelectionKey(ev({ key: "v" }))).toBe(false);
    expect(isCopySelectionKey(ev({ altKey: true }))).toBe(false);
    expect(isCopySelectionKey(ev({ metaKey: false }))).toBe(false);
  });
});
