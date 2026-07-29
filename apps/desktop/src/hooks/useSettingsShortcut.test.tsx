// @vitest-environment jsdom
//
// ⌘, must open Settings from ANY focus context. These tests assert the SIDE EFFECT — that
// `uiStore.settingsRequest` actually carries a category afterwards — never merely that a listener
// got registered, and they drive each case by focusing a real element and dispatching the keydown
// AT THAT ELEMENT, so the event travels the same path a real press does.
//
// The production listener is on `window` (capture). Every dispatch below therefore either targets
// `window` itself or an element inside `document.body`, whose capture path runs through `window` —
// never `document.dispatchEvent`, which would be the vacuous cross-target form the
// `no-cross-target-event-dispatch` lint rule exists to catch.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isSettingsShortcut,
  SETTINGS_SHORTCUT_CATEGORY,
  useSettingsShortcut,
} from "./useSettingsShortcut";
import { useUiStore } from "../stores/uiStore";

const key = (over: Partial<KeyboardEvent> = {}) => ({
  key: ",",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

/** Press ⌘, at `target` the way the browser would: bubbling, cancelable, from the focused node. */
function pressCommandComma(target: EventTarget) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true, cancelable: true }),
    );
  });
}

/** Mount an element into the document, focus it, and return it. Cleaned up per-test. */
function mountFocused(el: HTMLElement): HTMLElement {
  document.body.appendChild(el);
  el.focus();
  return el;
}

beforeEach(() => {
  // Start from "no request pending" so a passing assertion can only come from THIS press.
  useUiStore.setState({ settingsRequest: null });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isSettingsShortcut", () => {
  it("matches ⌘, and Ctrl+, and nothing else", () => {
    expect(isSettingsShortcut(key({ metaKey: true }))).toBe(true);
    expect(isSettingsShortcut(key({ ctrlKey: true }))).toBe(true);
    // A bare comma is someone typing a sentence — must never open Settings.
    expect(isSettingsShortcut(key())).toBe(false);
    expect(isSettingsShortcut(key({ metaKey: true, key: "." }))).toBe(false);
    expect(isSettingsShortcut(key({ metaKey: true, altKey: true }))).toBe(false);
    // shift+comma is "<" on a US layout; the guard holds where it isn't.
    expect(isSettingsShortcut(key({ metaKey: true, shiftKey: true }))).toBe(false);
  });
});

describe("useSettingsShortcut — the four focus contexts the user will try", () => {
  it("opens Settings when focus is on body (nothing focused)", () => {
    renderHook(() => useSettingsShortcut());
    // No element focused: activeElement is body, the case the focus-trace warnings reported.
    expect(document.activeElement).toBe(document.body);

    pressCommandComma(document.body);

    expect(useUiStore.getState().settingsRequest).toBe(SETTINGS_SHORTCUT_CATEGORY);
  });

  it("opens Settings when focus is in a text input (the composer)", () => {
    renderHook(() => useSettingsShortcut());
    const input = mountFocused(document.createElement("textarea"));
    expect(document.activeElement).toBe(input);

    pressCommandComma(input);

    expect(useUiStore.getState().settingsRequest).toBe(SETTINGS_SHORTCUT_CATEGORY);
  });

  it("opens Settings when a modal is already open and focus is inside it", () => {
    renderHook(() => useSettingsShortcut());
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    button.focus();
    expect(document.activeElement).toBe(button);

    pressCommandComma(button);

    expect(useUiStore.getState().settingsRequest).toBe(SETTINGS_SHORTCUT_CATEGORY);
  });

  it("opens Settings when focus is in a terminal that swallows the key on the bubble path", () => {
    renderHook(() => useSettingsShortcut());
    // Stand-in for xterm.js: it consumes keys arriving at its hidden textarea, but only once they
    // have reached the target — it cannot act during capture. Model the MAXIMAL swallow (stop
    // propagation AND preventDefault) so this fails the moment the production binding stops being
    // capture-phase. `true` → `false` in the hook's addEventListener is exactly the mutation this
    // catches; every other context above would still pass under it.
    const textarea = mountFocused(document.createElement("textarea"));
    textarea.addEventListener("keydown", (e) => {
      e.stopPropagation();
      e.preventDefault();
    });

    pressCommandComma(textarea);

    expect(useUiStore.getState().settingsRequest).toBe(SETTINGS_SHORTCUT_CATEGORY);
  });
});

describe("useSettingsShortcut — the rest of the contract", () => {
  it("requests the same pane the menu's Settings entry opens", () => {
    // SettingsDialog does `initialCategory ?? "ai"`; a drift here means ⌘, and the menu disagree.
    expect(SETTINGS_SHORTCUT_CATEGORY).toBe("ai");
  });

  it("cancels the press so macOS does not beep at a focused field", () => {
    renderHook(() => useSettingsShortcut());
    const input = mountFocused(document.createElement("textarea"));
    const e = new KeyboardEvent("keydown", {
      key: ",",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      input.dispatchEvent(e);
    });

    expect(e.defaultPrevented).toBe(true);
  });

  it("leaves a bare comma alone — typing a comma must not open Settings", () => {
    renderHook(() => useSettingsShortcut());
    const input = mountFocused(document.createElement("textarea"));

    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: ",", bubbles: true, cancelable: true }),
      );
    });

    expect(useUiStore.getState().settingsRequest).toBeNull();
  });

  it("stops listening once unmounted", () => {
    const { unmount } = renderHook(() => useSettingsShortcut());
    unmount();

    pressCommandComma(document.body);

    expect(useUiStore.getState().settingsRequest).toBeNull();
  });
});

// The "is it actually mounted?" guard lives in useSettingsShortcut.wiring.test.ts — it reads
// App.tsx off disk, which needs the node environment (under jsdom `import.meta.url` is an http URL
// and `fileURLToPath` throws).
