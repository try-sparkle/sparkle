import { describe, it, expect } from "vitest";
import { isComposerToggleKey, type ToggleKeyEvent } from "./composerToggle";
import { SHORTCUT_DEFAULTS } from "../stores/keybindingsStore";

// Exercise against the default toggleComposer binding (⌘J).
const CMDJ = SHORTCUT_DEFAULTS.toggleComposer;

const key = (over: Partial<ToggleKeyEvent>): ToggleKeyEvent => ({
  type: "keydown",
  key: "j",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("isComposerToggleKey (default ⌘J binding)", () => {
  it("matches Cmd+J on keydown (either case)", () => {
    expect(isComposerToggleKey(key({ key: "j" }), CMDJ)).toBe(true);
    expect(isComposerToggleKey(key({ key: "J" }), CMDJ)).toBe(true);
  });

  it("ignores J without the Cmd modifier", () => {
    expect(isComposerToggleKey(key({ key: "j", metaKey: false }), CMDJ)).toBe(false);
  });

  it("ignores other keys held with Cmd", () => {
    expect(isComposerToggleKey(key({ key: "k" }), CMDJ)).toBe(false);
  });

  it("ignores Cmd+J combined with Ctrl/Alt (reserve those for the app)", () => {
    expect(isComposerToggleKey(key({ ctrlKey: true }), CMDJ)).toBe(false);
    expect(isComposerToggleKey(key({ altKey: true }), CMDJ)).toBe(false);
  });

  it("only fires on keydown", () => {
    expect(isComposerToggleKey(key({ type: "keyup" }), CMDJ)).toBe(false);
  });

  it("matches a rebound chord (e.g. ⌘⇧K)", () => {
    const cmdShiftK = { kind: "chord", meta: true, ctrl: false, alt: false, shift: true, key: "k" } as const;
    expect(isComposerToggleKey(key({ key: "k", shiftKey: true }), cmdShiftK)).toBe(true);
    expect(isComposerToggleKey(key({ key: "k", shiftKey: false }), cmdShiftK)).toBe(false);
  });
});
