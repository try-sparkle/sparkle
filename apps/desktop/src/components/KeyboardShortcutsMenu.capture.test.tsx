// @vitest-environment jsdom
//
// The "Press a key…" recorder publishes its in-progress state to `keybindingsStore.capturingShortcut`
// so GLOBAL chord handlers can stand down while a binding is being recorded (roborev 55310 — ⌘,
// otherwise both recorded the chord and opened Settings, unmounting this pane mid-gesture).
//
// Making that flag global creates a failure mode local state never had: if the pane unmounts while
// still listening — the user closes Settings, or just switches category — the flag would stay set
// and every global chord would be dead until relaunch, with nothing on screen to explain it. These
// tests cover both directions, and assert the STORE (the thing other code reads), not the button's
// styling.
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyboardShortcutsMenu } from "./KeyboardShortcutsMenu";
import { SHORTCUT_DEFAULTS, useKeybindingsStore } from "../stores/keybindingsStore";

beforeEach(() =>
  useKeybindingsStore.setState({
    capturingShortcut: null,
    bindings: { ...SHORTCUT_DEFAULTS },
  }),
);
afterEach(() => useKeybindingsStore.setState({ capturingShortcut: null }));

/** The first row's capture button. It is labelled with the CURRENT BINDING (e.g. "⌘J"), not with
 *  static text, so it is addressed by position rather than by an accessible name that changes the
 *  moment someone rebinds anything. Throws rather than returning undefined: if the pane stops
 *  rendering buttons these tests must go red, not silently no-op into a passing assertion. */
function captureButton(c: HTMLElement): HTMLButtonElement {
  const b = c.querySelectorAll("button")[0];
  if (!b) throw new Error("no capture button rendered — the Shortcuts pane changed shape");
  return b;
}

describe("the rebinding capture publishes its state globally", () => {
  it("starts out not capturing", () => {
    render(<KeyboardShortcutsMenu />);
    expect(useKeybindingsStore.getState().capturingShortcut).toBeNull();
  });

  it("clicking a capture button marks that shortcut as capturing", () => {
    const { container } = render(<KeyboardShortcutsMenu />);
    act(() => captureButton(container).click());

    expect(useKeybindingsStore.getState().capturingShortcut).toBe("toggleHints");
  });

  it("unmounting mid-capture CLEARS the flag — otherwise every global chord stays dead", () => {
    const { container, unmount } = render(<KeyboardShortcutsMenu />);
    act(() => captureButton(container).click());
    expect(useKeybindingsStore.getState().capturingShortcut).not.toBeNull();

    // Closing Settings (or switching category) unmounts the pane while it is still listening.
    unmount();

    expect(useKeybindingsStore.getState().capturingShortcut).toBeNull();
  });
});

describe("keybindingsStore.capturingShortcut is transient", () => {
  it("is not written to the persisted blob", () => {
    // A relaunch that came back believing it was mid-capture would leave every global chord
    // standing down with no visible cause and no way out.
    useKeybindingsStore.setState({ capturingShortcut: "toggleComposer" });
    const persisted = localStorage.getItem("sparkle-keybindings");
    expect(persisted ?? "").not.toContain("capturingShortcut");
  });
});
