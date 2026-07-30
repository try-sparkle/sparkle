// @vitest-environment jsdom
//
// The palette controller: the ⌘K/Ctrl+K binding (capture-phase, window-level) toggles the
// palette, the imperative API opens/closes it, and the shortcut predicate is pinned so a
// re-binding can't silently drift (alt-K glyph input must NOT trigger it).
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { isPaletteShortcut, useCommandPalette } from "./useCommandPalette";
import { useKeybindingsStore } from "../../stores/keybindingsStore";

afterEach(() => useKeybindingsStore.setState({ capturingShortcut: null }));

const key = (over: Partial<KeyboardEvent> = {}) => ({
  key: "k",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("isPaletteShortcut", () => {
  it("matches ⌘K and Ctrl+K (either case), nothing else", () => {
    expect(isPaletteShortcut(key({ metaKey: true }))).toBe(true);
    expect(isPaletteShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isPaletteShortcut(key({ metaKey: true, key: "K" }))).toBe(true);
    expect(isPaletteShortcut(key())).toBe(false); // bare k — just typing
    expect(isPaletteShortcut(key({ metaKey: true, key: "j" }))).toBe(false);
    expect(isPaletteShortcut(key({ metaKey: true, altKey: true }))).toBe(false); // option-K glyph
    expect(isPaletteShortcut(key({ metaKey: true, shiftKey: true }))).toBe(false); // ⌘⇧K is not ours
  });
});

describe("useCommandPalette", () => {
  it("starts closed; ⌘K toggles open and closed again", () => {
    const { result } = renderHook(() => useCommandPalette());
    expect(result.current.open).toBe(false);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    });
    expect(result.current.open).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    });
    expect(result.current.open).toBe(false);
  });

  it("ignores a bare k keydown", () => {
    const { result } = renderHook(() => useCommandPalette());
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k" }));
    });
    expect(result.current.open).toBe(false);
  });

  it("openPalette / closePalette / togglePalette drive the state imperatively", () => {
    const { result } = renderHook(() => useCommandPalette());
    act(() => result.current.openPalette());
    expect(result.current.open).toBe(true);
    act(() => result.current.openPalette()); // idempotent
    expect(result.current.open).toBe(true);
    act(() => result.current.closePalette());
    expect(result.current.open).toBe(false);
    act(() => result.current.togglePalette());
    expect(result.current.open).toBe(true);
  });

  // roborev 55487. This listener is window/capture and registers at Workspace mount, so it runs
  // BEFORE the Shortcuts pane's "Press a key…" recorder (which registers on click) and the
  // recorder's stopPropagation() cannot reach it — stopPropagation does not stop other listeners on
  // the same node. Pressing ⌘K to record it therefore both recorded the chord AND opened the palette
  // on top of the pane. It stands down by reading keybindingsStore.capturingShortcut.
  it("stands down while the Shortcuts pane is recording a binding", () => {
    const { result } = renderHook(() => useCommandPalette());
    useKeybindingsStore.setState({ capturingShortcut: "toggleComposer" });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    });

    expect(result.current.open).toBe(false);
  });

  it("resumes the moment the recording ends", () => {
    const { result } = renderHook(() => useCommandPalette());
    useKeybindingsStore.setState({ capturingShortcut: "toggleComposer" });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    });
    expect(result.current.open).toBe(false);

    // Read live per-press, so ending the capture must re-arm without a remount.
    useKeybindingsStore.setState({ capturingShortcut: null });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    });

    expect(result.current.open).toBe(true);
  });

  it("unmounting removes the window listener", () => {
    const { result, unmount } = renderHook(() => useCommandPalette());
    unmount();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    });
    expect(result.current.open).toBe(false);
  });
});
