// @vitest-environment jsdom
//
// useHintMode must STAND DOWN while the Shortcuts pane is recording a binding (roborev 55487).
//
// This is the handler the collision hurt most, and the one easiest to miss. `toggleHints` is the
// FIRST row of the Shortcuts pane and its default binding is a bare Control TAP — so the very act of
// rebinding it drives this hook's tap state machine, popping the gold chiclet overlay across the
// whole UI in the middle of the gesture the user is trying to record.
//
// The recorder cannot defend itself: it is on `window` in the capture phase and so is this hook,
// `stopPropagation` does not stop other listeners on the same node, and this hook registers at mount
// while the recorder registers when the user clicks "Press a key…" — so this one always runs first.
// Reading `capturingShortcut` is the only mechanism that works against an earlier same-node listener.
//
// Asserts the SIDE EFFECT — `active`, i.e. whether the overlay would show — not that a guard exists.
// The keyUP half matters independently: a tap needs press AND release, so guarding only keydown
// would still let a tap begun before the capture started complete through it.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useHintMode } from "./useHintMode";
import { SHORTCUT_DEFAULTS, useKeybindingsStore } from "../stores/keybindingsStore";

/** A clean tap of Control: press then release, nothing in between. The default toggleHints gesture. */
function tapControl() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
  });
}

beforeEach(() =>
  useKeybindingsStore.setState({
    capturingShortcut: null,
    bindings: { ...SHORTCUT_DEFAULTS },
  }),
);
afterEach(() => useKeybindingsStore.setState({ capturingShortcut: null }));

describe("useHintMode during a rebinding capture", () => {
  it("a Control tap opens the overlay normally — the baseline this test depends on", () => {
    // Without this, the stand-down assertion below could pass because the tap never worked at all.
    const { result } = renderHook(() => useHintMode());
    expect(result.current.active).toBe(false);

    tapControl();

    expect(result.current.active).toBe(true);
  });

  it("does NOT open the overlay while a binding is being recorded", () => {
    const { result } = renderHook(() => useHintMode());
    // The user clicked "Press a key…" on the toggleHints row and is now pressing Control to record.
    useKeybindingsStore.setState({ capturingShortcut: "toggleHints" });

    tapControl();

    expect(result.current.active).toBe(false);
  });

  it("does not complete a tap whose keydown landed before the capture began", () => {
    // The keyUP guard specifically: arm the tap, then start capturing, then release. Guarding only
    // keydown would let this finish and pop the overlay mid-capture.
    const { result } = renderHook(() => useHintMode());
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
    });
    useKeybindingsStore.setState({ capturingShortcut: "toggleHints" });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
    });

    expect(result.current.active).toBe(false);
  });

  // The keyDOWN guard needs its own case, and finding that out is why this file was mutation-checked.
  // With the DEFAULT tap binding, removing the keydown guard changes nothing observable: a tap needs
  // both halves, so the keyUp guard alone already keeps `active` false. Every tap test above stayed
  // green with the keydown guard deleted — they were vacuous for that half.
  //
  // A CHORD binding is where keydown carries the effect: it toggles on the keydown AND calls
  // preventDefault + stopPropagation. Unguarded, pressing it during a capture would flip the overlay
  // and swallow the very keystroke the recorder was trying to read.
  describe("with a CHORD binding, where keydown carries the effect", () => {
    const chord = { kind: "chord", meta: true, ctrl: false, alt: false, shift: false, key: "h" } as const;
    const pressChord = () => {
      const e = new KeyboardEvent("keydown", { key: "h", metaKey: true, cancelable: true });
      act(() => {
        window.dispatchEvent(e);
      });
      return e;
    };

    it("toggles the overlay normally — the baseline", () => {
      useKeybindingsStore.setState({ bindings: { ...SHORTCUT_DEFAULTS, toggleHints: chord } });
      const { result } = renderHook(() => useHintMode());

      pressChord();

      expect(result.current.active).toBe(true);
    });

    it("neither toggles NOR swallows the key while a binding is being recorded", () => {
      useKeybindingsStore.setState({ bindings: { ...SHORTCUT_DEFAULTS, toggleHints: chord } });
      const { result } = renderHook(() => useHintMode());
      useKeybindingsStore.setState({ capturingShortcut: "toggleHints" });

      const e = pressChord();

      expect(result.current.active).toBe(false);
      // Not swallowed either: the recorder still needs to see this press to record it.
      expect(e.defaultPrevented).toBe(false);
    });
  });

  it("resumes the moment the recording ends", () => {
    const { result } = renderHook(() => useHintMode());
    useKeybindingsStore.setState({ capturingShortcut: "toggleHints" });
    tapControl();
    expect(result.current.active).toBe(false);

    // The flag is read live per-event, so ending the capture must re-arm without a remount.
    useKeybindingsStore.setState({ capturingShortcut: null });
    tapControl();

    expect(result.current.active).toBe(true);
  });
});
