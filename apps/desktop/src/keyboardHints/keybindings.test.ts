import { describe, it, expect } from "vitest";
import {
  captureReduce,
  formatBinding,
  INITIAL_CAPTURE,
  matchesChord,
  type CaptureState,
  type KeyBinding,
} from "./keybindings";

const ev = (over: Partial<Parameters<typeof matchesChord>[0]>) => ({
  key: "j", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, type: "keydown", ...over,
});

describe("formatBinding", () => {
  it("labels a tap", () => {
    expect(formatBinding({ kind: "tap", modifier: "Control" })).toBe("Tap ⌃ Control");
  });
  it("labels chords with Apple modifier order", () => {
    expect(formatBinding({ kind: "chord", meta: true, ctrl: false, alt: false, shift: false, key: "j" })).toBe("⌘J");
    expect(formatBinding({ kind: "chord", meta: true, ctrl: true, alt: false, shift: true, key: "k" })).toBe("⌃⇧⌘K");
  });
});

describe("matchesChord", () => {
  const cmdJ: KeyBinding = { kind: "chord", meta: true, ctrl: false, alt: false, shift: false, key: "j" };
  it("matches the exact chord on keydown (case-insensitive key)", () => {
    expect(matchesChord(ev({ key: "j", metaKey: true }), cmdJ)).toBe(true);
    expect(matchesChord(ev({ key: "J", metaKey: true }), cmdJ)).toBe(true);
  });
  it("rejects wrong modifiers, wrong key, and keyup", () => {
    expect(matchesChord(ev({ key: "j", metaKey: true, ctrlKey: true }), cmdJ)).toBe(false);
    expect(matchesChord(ev({ key: "k", metaKey: true }), cmdJ)).toBe(false);
    expect(matchesChord(ev({ key: "j", metaKey: true, type: "keyup" }), cmdJ)).toBe(false);
  });
  it("never matches a tap binding", () => {
    expect(matchesChord(ev({ key: "Control", ctrlKey: true }), { kind: "tap", modifier: "Control" })).toBe(false);
  });
});

describe("captureReduce", () => {
  // Drive a sequence; return the first binding produced.
  function run(events: Array<Partial<Parameters<typeof matchesChord>[0]> & { type: "keydown" | "keyup" }>) {
    let s: CaptureState = INITIAL_CAPTURE;
    for (const e of events) {
      const out = captureReduce(s, ev(e) as never);
      s = out.state;
      if (out.binding) return out.binding;
    }
    return null;
  }

  it("captures a lone-modifier tap (down then up, nothing else)", () => {
    expect(run([
      { type: "keydown", key: "Control", ctrlKey: true },
      { type: "keyup", key: "Control", ctrlKey: false },
    ])).toEqual({ kind: "tap", modifier: "Control" });
  });

  it("captures a chord on the non-modifier keydown", () => {
    expect(run([
      { type: "keydown", key: "Meta", metaKey: true },
      { type: "keydown", key: "j", metaKey: true },
    ])).toEqual({ kind: "chord", meta: true, ctrl: false, alt: false, shift: false, key: "j" });
  });

  it("ignores a bare key with no real modifier (no footgun chord)", () => {
    expect(run([{ type: "keydown", key: "j" }])).toBeNull();
    // Shift-only (a capital letter) is not enough either.
    expect(run([{ type: "keydown", key: "J", shiftKey: true }])).toBeNull();
  });

  it("captures a chord when a real modifier is held (even with shift)", () => {
    expect(run([{ type: "keydown", key: "k", ctrlKey: true, shiftKey: true }])).toEqual({
      kind: "chord", meta: false, ctrl: true, alt: false, shift: true, key: "k",
    });
  });

  it("does NOT capture a tap when a second modifier was also pressed", () => {
    expect(run([
      { type: "keydown", key: "Control", ctrlKey: true },
      { type: "keydown", key: "Meta", ctrlKey: true, metaKey: true },
      { type: "keyup", key: "Control", metaKey: true },
    ])).toBeNull();
  });
});
