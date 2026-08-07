// @vitest-environment jsdom
// The WATCHER half of "dictation follows focus". The pure classifier and the precedence rule are
// covered by dictationFocus.test.ts; this file covers the thing that was shipped with NO tests at
// all — the event wiring — which is exactly why the `focusout` gap below went out green.
//
// The seams (`doc`, `win`) are documented as injected for tests, so everything here drives real
// jsdom events against a real document rather than calling the module's internals.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { installDictationFocusTracker } from "./dictationFocusTracker";
import { TERMINAL_SURFACE_ATTR } from "./dictationFocus";

/** Build the DOM shape the app actually renders: xterm's host carries our marker, and the thing
 *  that really holds the caret is xterm's hidden helper textarea inside it. */
function mountTerminal() {
  const host = document.createElement("div");
  host.setAttribute(TERMINAL_SURFACE_ATTR, "");
  host.innerHTML =
    '<div class="xterm"><div class="xterm-screen"></div>' +
    '<textarea class="xterm-helper-textarea"></textarea></div>';
  document.body.appendChild(host);
  return host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")!;
}

function mountComposer() {
  const ta = document.createElement("textarea");
  ta.id = "composer";
  document.body.appendChild(ta);
  return ta;
}

let uninstall: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
});
afterEach(() => {
  uninstall?.();
  uninstall = null;
  vi.useRealTimers();
});

describe("installDictationFocusTracker — the event wiring", () => {
  it("seeds the store from the LIVE DOM before any event fires", () => {
    // A mic armed at launch with the caret already in a terminal must read as paused immediately,
    // not on the next click. Without the seed the store would sit at its default until something
    // happened to move focus.
    const term = mountTerminal();
    term.focus();
    const setFocusOwner = vi.fn();
    const setWindowFocused = vi.fn();
    uninstall = installDictationFocusTracker({ setFocusOwner, setWindowFocused });
    expect(setFocusOwner).toHaveBeenCalledWith("terminal");
    expect(setWindowFocused).toHaveBeenCalledWith(true);
  });

  it("reports the terminal when focus moves INTO an xterm pane", () => {
    const composer = mountComposer();
    const term = mountTerminal();
    composer.focus();
    const setFocusOwner = vi.fn();
    uninstall = installDictationFocusTracker({ setFocusOwner, setWindowFocused: vi.fn() });
    setFocusOwner.mockClear();

    term.focus();
    vi.runAllTimers();
    expect(setFocusOwner).toHaveBeenCalledWith("terminal");
  });

  it("THE REGRESSION: leaving a terminal for a NON-FOCUSABLE target still reports 'other'", () => {
    // No browser fires `focusin` when focus leaves an element for something non-focusable —
    // `focusout` fires and `activeElement` reverts to <body>. Clicking app chrome, a scroll region
    // or the page background does exactly that, and on WKWebView (this app's webview) so does
    // clicking a plain <button>.
    //
    // With only a `focusin` listener, `focusOwner` stayed "terminal" forever: the routing gate
    // re-read the live DOM and resumed transcribing while the store-fed copy still said "your
    // cursor is in a terminal", so text landed and the auto-send clock armed while both mic
    // surfaces claimed to be paused. This asserts the SIDE EFFECT — the store is told "other" —
    // which is impossible without a focusout listener.
    const term = mountTerminal();
    term.focus();
    const setFocusOwner = vi.fn();
    uninstall = installDictationFocusTracker({ setFocusOwner, setWindowFocused: vi.fn() });
    setFocusOwner.mockClear();

    term.blur(); // focusout, activeElement falls back to <body>, NO focusin follows
    vi.runAllTimers();
    expect(setFocusOwner).toHaveBeenCalledWith("other");
  });

  it("does not flap when focus moves BETWEEN two nodes of the same terminal", () => {
    // The deferred read is what buys this: read synchronously inside `focusout` and `activeElement`
    // is transiently <body>, so an intra-terminal click would report "other" and pause/unpause the
    // mic for a frame. Settling first means the change guard sees no change at all.
    const term = mountTerminal();
    const sibling = document.querySelector<HTMLElement>(".xterm-screen")!;
    sibling.tabIndex = 0;
    term.focus();
    const setFocusOwner = vi.fn();
    uninstall = installDictationFocusTracker({ setFocusOwner, setWindowFocused: vi.fn() });
    setFocusOwner.mockClear();

    sibling.focus();
    vi.runAllTimers();
    expect(setFocusOwner).not.toHaveBeenCalled();
  });

  it("writes only on CHANGE — moving between two non-terminal elements is silent", () => {
    const a = mountComposer();
    const b = mountComposer();
    a.focus();
    const setFocusOwner = vi.fn();
    uninstall = installDictationFocusTracker({ setFocusOwner, setWindowFocused: vi.fn() });
    setFocusOwner.mockClear();

    b.focus();
    vi.runAllTimers();
    expect(setFocusOwner).not.toHaveBeenCalled();
  });

  it("re-reads the caret on a window transition, not just on focusin", () => {
    // Returning to the window restores focus to whatever held it before without necessarily
    // emitting a focusin we would see, so a tracker that only listened to focusin could come back
    // believing the caret is where it was two windows ago.
    const term = mountTerminal();
    const setFocusOwner = vi.fn();
    const setWindowFocused = vi.fn();
    uninstall = installDictationFocusTracker({ setFocusOwner, setWindowFocused });
    setFocusOwner.mockClear();
    setWindowFocused.mockClear();

    term.focus();
    vi.runAllTimers();
    setFocusOwner.mockClear();

    // `hasFocus` is stubbed FALSE because this case is a REAL window blur, and the tracker now
    // refuses a blur the DOM contradicts (see the next test). jsdom reports `hasFocus() === true`
    // regardless of dispatched events, so without this the event here would describe a window that
    // is simultaneously blurred and focused — a state the app never reaches.
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    window.dispatchEvent(new Event("blur"));
    expect(setWindowFocused).toHaveBeenCalledWith(false);
    hasFocus.mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
    expect(setWindowFocused).toHaveBeenCalledWith(true);
    hasFocus.mockRestore();
  });

  it("IGNORES a blur the DOM contradicts, so a stand-down pulse cannot strand the mic", () => {
    // This latch is LEVEL-HELD: it drives the `"window"` pause reason and clears only on a real
    // `focus`. The input-release hatch (services/inputRelease) dispatches a synthetic blur on
    // purpose, to stand down the EDGE-triggered latches (hint mode, push-to-talk, the drag shield).
    // Believing it would pause dictation with nothing able to un-pause it until the user left the
    // app and came back — the hatch wedging the mic to free the keyboard (roborev 59651).
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const setWindowFocused = vi.fn();
    uninstall = installDictationFocusTracker({ setFocusOwner: vi.fn(), setWindowFocused });
    setWindowFocused.mockClear();

    window.dispatchEvent(new Event("blur"));

    expect(setWindowFocused).not.toHaveBeenCalled();
    hasFocus.mockRestore();
  });

  it("IGNORES a blur in a window that is ALREADY background — the edge, not the level", () => {
    // The contradicted-blur guard only covers the FOCUSED window. `app_menu.rs` broadcasts the
    // release to every webview, and in a BACKGROUND window `hasFocus()` is already false — so that
    // guard falls straight through exactly where believing the pulse is destructive (the relay is
    // global; see useDictation). Acting only on a true -> false transition makes it a no-op there.
    //
    // ASSERTED ON `setFocusOwner`, NOT `setWindowFocused` — and that is the whole difficulty.
    // `writeWindowFocused` already dedupes by VALUE, and the install seeds `false` here, so a
    // re-write of `false` is invisible and an assertion on it passes with the guard REMOVED. It did:
    // the first version of this test survived deleting the very line it names. `writeWindowFocused`
    // also unconditionally re-reads the caret, and THAT is observable — so the terminal is torn out
    // of the DOM first, making a re-read report a different owner (roborev 59763).
    const term = mountTerminal();
    term.focus();
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const setFocusOwner = vi.fn();
    uninstall = installDictationFocusTracker({ setFocusOwner, setWindowFocused: vi.fn() });
    setFocusOwner.mockClear();

    // activeElement falls back to <body> with NO focusin, so only a re-read would notice.
    document.body.innerHTML = "";
    window.dispatchEvent(new Event("blur"));

    expect(setFocusOwner).not.toHaveBeenCalled();
    hasFocus.mockRestore();
  });

  it("still reports the FIRST real background transition — the edge fires once", () => {
    // The half that makes the case above non-vacuous: a guard that suppressed every blur would pass
    // it too, while breaking the window-focus handoff this listener exists for.
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const setWindowFocused = vi.fn();
    uninstall = installDictationFocusTracker({ setFocusOwner: vi.fn(), setWindowFocused });
    setWindowFocused.mockClear();

    hasFocus.mockReturnValue(false); // the window really went background
    window.dispatchEvent(new Event("blur"));
    expect(setWindowFocused).toHaveBeenCalledWith(false);

    // …and a SECOND blur while still background is not another edge.
    setWindowFocused.mockClear();
    window.dispatchEvent(new Event("blur"));
    expect(setWindowFocused).not.toHaveBeenCalled();
    hasFocus.mockRestore();
  });

  it("uninstall detaches every listener AND cancels a pending deferred read", () => {
    // A pending read firing after teardown would write to a store the tracker no longer owns.
    const term = mountTerminal();
    term.focus();
    const setFocusOwner = vi.fn();
    const off = installDictationFocusTracker({ setFocusOwner, setWindowFocused: vi.fn() });
    setFocusOwner.mockClear();

    term.blur(); // schedules the deferred read…
    off(); // …and this must cancel it
    vi.runAllTimers();
    expect(setFocusOwner).not.toHaveBeenCalled();

    // And nothing reattached: a later transition is ignored too.
    mountTerminal().focus();
    vi.runAllTimers();
    expect(setFocusOwner).not.toHaveBeenCalled();
    uninstall = null;
  });
});
