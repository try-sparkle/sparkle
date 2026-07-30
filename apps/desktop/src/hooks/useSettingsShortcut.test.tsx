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
import { lazy, Suspense } from "react";
import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isSettingsShortcut,
  SETTINGS_SHORTCUT_CATEGORY,
  useSettingsShortcut,
} from "./useSettingsShortcut";
import { useUiStore } from "../stores/uiStore";
import { useKeybindingsStore } from "../stores/keybindingsStore";

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
  // …and not mid-rebind, which legitimately suppresses the shortcut (see the capture tests).
  useKeybindingsStore.setState({ capturingShortcut: null });
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

  // roborev 55310. The Shortcuts pane's "Press a key…" recorder is ALSO a window/capture listener,
  // but it registers when the user clicks the button — long after this hook did at mount — so this
  // one runs first and the recorder's stopPropagation() cannot reach it (stopPropagation does not
  // stop other listeners already on the same node). Pressing ⌘, to BIND it therefore recorded the
  // chord and opened Settings on the "ai" pane, unmounting the recorder mid-gesture.
  it("stands down while the Shortcuts pane is recording a new binding", () => {
    renderHook(() => useSettingsShortcut());
    useKeybindingsStore.setState({ capturingShortcut: "toggleComposer" });

    pressCommandComma(document.body);

    expect(useUiStore.getState().settingsRequest).toBeNull();
  });

  it("resumes the moment the recording ends", () => {
    renderHook(() => useSettingsShortcut());
    useKeybindingsStore.setState({ capturingShortcut: "toggleComposer" });
    pressCommandComma(document.body);
    expect(useUiStore.getState().settingsRequest).toBeNull();

    // The flag is read live per-press, so ending capture must re-arm without a remount.
    useKeybindingsStore.setState({ capturingShortcut: null });
    pressCommandComma(document.body);

    expect(useUiStore.getState().settingsRequest).toBe(SETTINGS_SHORTCUT_CATEGORY);
  });

  it("stops listening once unmounted", () => {
    const { unmount } = renderHook(() => useSettingsShortcut());
    unmount();

    pressCommandComma(document.body);

    expect(useUiStore.getState().settingsRequest).toBeNull();
  });
});

// roborev 55487. The binding must not be LIVE anywhere its consumer isn't mounted: nothing clears a
// request nobody consumed, and the consumer opens the dialog off a pre-existing `settingsRequest` on
// its first render — so a press in that window silently latches and the dialog springs open
// uninvited later. In production the consumer sits under a React.lazy Workspace, so the <Suspense>
// boundary is that window, and the fix is to mount the binding INSIDE the boundary.
//
// This asserts the React semantics the fix depends on rather than assuming them: a suspended
// boundary commits none of its children, so a sibling of the lazy component does not register its
// effects until the chunk resolves. Written with a hand-held promise so "still loading" is a real
// state and not a timing guess.
describe("useSettingsShortcut — not armed before its consumer can exist", () => {
  it("stays inert while the lazy chunk is pending, then arms once it resolves", async () => {
    let resolveChunk!: (m: { default: () => null }) => void;
    const Lazy = lazy(() => new Promise<{ default: () => null }>((res) => (resolveChunk = res)));
    const Binding = () => {
      useSettingsShortcut();
      return null;
    };

    // Mounted as a SIBLING inside the boundary — exactly App.tsx's shape.
    render(
      <Suspense fallback={null}>
        <Lazy />
        <Binding />
      </Suspense>,
    );

    // Suspended: the boundary showed its fallback, so `Binding`'s effect never ran.
    pressCommandComma(document.body);
    expect(useUiStore.getState().settingsRequest).toBeNull();

    await act(async () => {
      resolveChunk({ default: () => null });
    });

    // Resolved: the consumer can exist now, so the binding may.
    pressCommandComma(document.body);
    expect(useUiStore.getState().settingsRequest).toBe(SETTINGS_SHORTCUT_CATEGORY);
  });
});

// The "is it actually mounted, and WHERE?" guard lives in useSettingsShortcut.wiring.test.ts — it
// reads App.tsx off disk, which needs the node environment (under jsdom `import.meta.url` is an http
// URL and `fileURLToPath` throws).
