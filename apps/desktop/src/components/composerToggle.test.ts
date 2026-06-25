import { describe, it, expect } from "vitest";
import { isComposerToggleKey, type ToggleKeyEvent } from "./composerToggle";

const key = (over: Partial<ToggleKeyEvent>): ToggleKeyEvent => ({
  type: "keydown",
  key: "j",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  ...over,
});

describe("isComposerToggleKey", () => {
  it("matches Cmd+J on keydown (either case)", () => {
    expect(isComposerToggleKey(key({ key: "j" }))).toBe(true);
    expect(isComposerToggleKey(key({ key: "J" }))).toBe(true);
  });

  it("ignores J without the Cmd modifier", () => {
    expect(isComposerToggleKey(key({ key: "j", metaKey: false }))).toBe(false);
  });

  it("ignores other keys held with Cmd", () => {
    expect(isComposerToggleKey(key({ key: "k" }))).toBe(false);
  });

  it("ignores Cmd+J combined with Ctrl/Alt (reserve those for the app)", () => {
    expect(isComposerToggleKey(key({ ctrlKey: true }))).toBe(false);
    expect(isComposerToggleKey(key({ altKey: true }))).toBe(false);
  });

  it("only fires on keydown", () => {
    expect(isComposerToggleKey(key({ type: "keyup" }))).toBe(false);
  });
});
