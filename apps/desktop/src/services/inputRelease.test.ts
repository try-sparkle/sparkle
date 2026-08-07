// @vitest-environment jsdom
//
// The escape hatch for bead sparkle-thm9o. Every assertion here is a SIDE EFFECT of the release —
// a latch that was set becoming clear, a node that was covering the app being gone. None of them
// assert a precondition, and each is set up in the wedged state first so it could genuinely fail.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted`, because `vi.mock`'s factory is lifted above every top-level statement in the file —
// a plain `const listenMock = vi.fn()` above it is still in the temporal dead zone when the factory
// runs, and the suite fails to COLLECT (0 tests) rather than failing an assertion.
// Parameters are DECLARED even though the body ignores them: `vi.fn(async () => …)` types
// `mock.calls` as the empty tuple `[]`, so reading `calls[0][0]` is a typecheck error (TS2493)
// rather than the assertion it looks like.
// The unlisten is a `vi.fn` rather than a bare `() => {}` so that "uninstall actually unsubscribes"
// is ASSERTABLE. With a bare arrow, deleting `un?.()` from the uninstall fn leaks a Tauri listener
// per mount — and now that BOTH roots install one, that leak compounds — while failing no test.
const { listenMock, unlistenMock } = vi.hoisted(() => {
  const unlistenMock = vi.fn();
  return {
    unlistenMock,
    listenMock: vi.fn(async (_event: string, _handler: () => void) => unlistenMock),
  };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { DRAG_SHIELD_SELECTOR } from "../components/ColumnPullTab";
import { useCableStore } from "../stores/cableStore";
import { useKeybindingsStore } from "../stores/keybindingsStore";
import {
  INPUT_RELEASE_EVENT,
  installInputRelease,
  isReleaseChord,
  releaseAllInputCapture,
  resetInputReleaseCoalescing,
  COALESCE_MS,
} from "./inputRelease";

describe("isReleaseChord — the chord app_menu.rs advertises", () => {
  const chord = { key: "Escape", shiftKey: true, metaKey: true, ctrlKey: false };

  it("matches CmdOrCtrl+Shift+Escape on either primary modifier", () => {
    expect(isReleaseChord(chord)).toBe(true);
    expect(isReleaseChord({ ...chord, metaKey: false, ctrlKey: true })).toBe(true);
  });

  it("does not fire on a bare Escape, which the cable ladder owns", () => {
    // A bare Escape here would spend the cable's Escape on a full input release — two state changes
    // for one press, and the rung the user actually wanted silently skipped.
    expect(isReleaseChord({ ...chord, shiftKey: false, metaKey: false })).toBe(false);
    expect(isReleaseChord({ ...chord, metaKey: false, ctrlKey: false })).toBe(false);
    expect(isReleaseChord({ ...chord, shiftKey: false })).toBe(false);
    expect(isReleaseChord({ ...chord, key: "u" })).toBe(false);
  });
});

/** Put the app into the state the founder was stuck in: a rebind latch swallowing every key, a
 *  patched cable, a stranded shield covering everything, and focus parked on a non-editable node. */
function wedgeTheApp(): HTMLButtonElement {
  useKeybindingsStore.getState().setCapturingShortcut("toggleHints");
  useCableStore.setState({ wired: "left" } as never);

  const shield = document.createElement("div");
  shield.setAttribute("data-testid", "column-drag-shield");
  shield.style.cssText = "position:fixed;inset:0;z-index:2147483647";
  document.body.appendChild(shield);

  const button = document.createElement("button");
  document.body.appendChild(button);
  button.focus();
  return button;
}

describe("releaseAllInputCapture — the way out of an app that stopped accepting input", () => {
  beforeEach(() => {
    // `restoreAllMocks` first: the `document.hasFocus` spies below outlive their test otherwise, and
    // a leaked `false` would silently disable the focus-restore assertions in every later case.
    vi.restoreAllMocks();
    // Successive cases run milliseconds apart, well inside the coalescing window, so without this
    // every test after the first would exercise the suppression path instead of the release.
    resetInputReleaseCoalescing();
    document.body.innerHTML = "";
    useKeybindingsStore.getState().setCapturingShortcut(null);
    listenMock.mockClear();
  });

  it("clears the rebind latch that preventDefaults every key in the app", () => {
    wedgeTheApp();
    expect(useKeybindingsStore.getState().capturingShortcut).not.toBeNull();

    releaseAllInputCapture("test");

    expect(useKeybindingsStore.getState().capturingShortcut).toBeNull();
  });

  it("unmounts the concierge — the symptom the founder reported by name", () => {
    wedgeTheApp();
    expect(useCableStore.getState().wired).not.toBe("off");

    releaseAllInputCapture("test");

    expect(useCableStore.getState().wired).toBe("off");
  });

  it("sweeps a stranded drag shield, which blocks every click while invisible", () => {
    wedgeTheApp();
    expect(document.querySelector(DRAG_SHIELD_SELECTOR)).not.toBeNull();

    releaseAllInputCapture("test");

    expect(document.querySelector(DRAG_SHIELD_SELECTOR)).toBeNull();
  });

  it("drops the caret so the next click can land anywhere", () => {
    const button = wedgeTheApp();
    expect(document.activeElement).toBe(button);

    releaseAllInputCapture("test");

    expect(document.activeElement).not.toBe(button);
  });

  it("dispatches the window blur every other latch already stands down on", () => {
    // useHintMode, usePushToTalk and ColumnPullTab each close on `blur`. The hatch reuses those
    // tested exits rather than reimplementing them, so the dispatch itself is the contract.
    const onBlur = vi.fn();
    window.addEventListener("blur", onBlur);
    wedgeTheApp();

    releaseAllInputCapture("test");

    expect(onBlur).toHaveBeenCalled();
    window.removeEventListener("blur", onBlur);
  });

  it("never broadcasts a synthetic focus — that would bill a relay restart and re-probe auth", () => {
    // The obvious repair for the level-held dictation latches was a corrective `focus` after the
    // blur. It is the wrong one (roborev 59651): `useDictation` would tear down and reopen the
    // billable Deepgram relay in one tick — a fresh first-minute debit plus an unordered
    // stop/start race that can leave the relay dead — and a window `focus` reaches ~10 unrelated
    // listeners, including an auth re-probe that can mount a blocking gate over the very user who
    // just asked to be un-blocked. The correction lives in the two trackers instead.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const onFocus = vi.fn();
    window.addEventListener("focus", onFocus);
    wedgeTheApp();

    releaseAllInputCapture("test");

    expect(onFocus).not.toHaveBeenCalled();
    window.removeEventListener("focus", onFocus);
  });

  it("coalesces an auto-repeat burst into ONE release, whatever fired it", () => {
    // The e.repeat guard on the DOM fallback does not cover the shipping path: with the accelerator
    // attached, AppKit routes the chord through the MENU BAR and the webview never sees the keydown
    // — but macOS re-invokes a menu key equivalent on auto-repeat and on_menu_event emits to every
    // webview each time. ~20 repeats x 2 subscribed roots = ~40 releases and ~40 WARN lines,
    // drowning the log line that is this bead's recurrence signal (roborev 59717). Coalescing lives
    // at the shared entry point so it covers every trigger, not just the one that can see `repeat`.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    wedgeTheApp();

    for (let i = 0; i < 20; i++) releaseAllInputCapture("burst");

    expect(useCableStore.getState().wired).toBe("off");
    // Re-wedge: if the burst had run 20 times it would have swept this too.
    useCableStore.setState({ wired: "left" } as never);
    for (let i = 0; i < 5; i++) releaseAllInputCapture("burst");
    expect(useCableStore.getState().wired).toBe("left");
    warn.mockRestore();
  });

  // THE WINDOW ITSELF, on a controlled clock. The burst/deliberate cases above pass for ANY
  // COALESCE_MS — including infinity — because neither one advances time; they only prove that
  // *some* suppression happens. These pin the actual boundary and the debounce behaviour
  // (roborev 59763).
  const atTime = (t: number, fn: () => void) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(t);
    try {
      fn();
    } finally {
      now.mockRestore();
    }
  };
  const wiredAgain = () => useCableStore.setState({ wired: "left" } as never);
  const released = () => useCableStore.getState().wired === "off";

  // Each boundary is probed from a FRESH leading edge, deliberately. Chaining them in one timeline
  // does not work — and the reason is the behaviour under test: a suppressed call EXTENDS the
  // window, so a probe at +249 moves the mark to 249 and the "+250" probe is then 1ms after it, not
  // 250. Testing the two boundaries against one shared history measures the debounce, not the edge.
  const leadingEdgeAt = (t: number) => {
    resetInputReleaseCoalescing();
    wedgeTheApp();
    atTime(t, () => releaseAllInputCapture("leading edge"));
    expect(released()).toBe(true);
    wiredAgain();
  };

  it("pins the window to an ABSOLUTE range, not just to its own constant", () => {
    // Every other case here is expressed in terms of the imported COALESCE_MS, so they all stay
    // green if someone widens it to 3000 — while that silently breaks the contract the deliberate-
    // press case claims to protect, since a real second press ~1s later would then be eaten
    // (roborev 59911). These bounds are absolute on purpose.
    //
    // Lower bound: must outlast an OS auto-repeat interval (~30ms) by a wide margin, or the burst
    // this exists to collapse leaks through. Upper bound: must stay under the ~1s at which a
    // deliberate second press — press, read the screen, press again — becomes plausible.
    expect(COALESCE_MS).toBeGreaterThanOrEqual(100);
    expect(COALESCE_MS).toBeLessThanOrEqual(500);
  });

  it("does NOT eat a deliberate second press one second later — on an absolute clock", () => {
    // The contract stated in absolute time rather than in units of the thing under test. This is
    // what actually goes red if COALESCE_MS is widened past a second.
    leadingEdgeAt(1_000);
    atTime(2_000, () => releaseAllInputCapture("a real second press"));
    expect(released()).toBe(true);
  });

  it("suppresses a repeat just INSIDE the window", () => {
    leadingEdgeAt(1_000);
    atTime(1_000 + COALESCE_MS - 1, () => releaseAllInputCapture("inside"));
    expect(released()).toBe(false);
  });

  it("fires again once the window has fully elapsed", () => {
    leadingEdgeAt(1_000);
    atTime(1_000 + COALESCE_MS, () => releaseAllInputCapture("outside"));
    expect(released()).toBe(true);
  });

  it("a HELD chord stays suppressed — a repeat extends the window, it does not restart the clock", () => {
    // The defect this replaces: a fixed window lapses on schedule while the key is still down, so a
    // continuous ~30ms auto-repeat stream fired ~4 releases a second indefinitely.
    wedgeTheApp();
    atTime(1_000, () => releaseAllInputCapture("leading edge"));
    expect(released()).toBe(true);
    wiredAgain();

    // Repeats arriving every 30ms for a full second — each inside the PREVIOUS one's window.
    for (let t = 1_030; t <= 2_000; t += 30) atTime(t, () => releaseAllInputCapture("repeat"));

    expect(released()).toBe(false);
  });

  it("still honours a DELIBERATE second press, once the window has passed", () => {
    // Coalescing must not eat a real second gesture — press, look at the screen, press again.
    wedgeTheApp();
    releaseAllInputCapture("first");
    expect(useCableStore.getState().wired).toBe("off");

    useCableStore.setState({ wired: "left" } as never);
    resetInputReleaseCoalescing(); // stands in for the window elapsing
    releaseAllInputCapture("second");

    expect(useCableStore.getState().wired).toBe("off");
  });

  it("finishes the remaining steps when one of them throws", () => {
    // The hatch runs in a state nobody predicted, so a single failing step must not abandon the
    // rest. Force the FIRST step to throw and assert a LATER one still happened.
    wedgeTheApp();
    const el = document.activeElement as HTMLElement;
    const boom = vi.spyOn(el, "blur").mockImplementation(() => {
      throw new Error("torn down");
    });

    expect(() => releaseAllInputCapture("test")).not.toThrow();

    expect(useCableStore.getState().wired).toBe("off");
    expect(document.querySelector(DRAG_SHIELD_SELECTOR)).toBeNull();
    boom.mockRestore();
  });
});

describe("installInputRelease", () => {
  // EVERY install is torn down. The fallback listener is on `window`, which outlives the test, so a
  // leaked one fires during later cases and makes them pass for the wrong reason — the
  // "stops listening after uninstall" case below caught exactly that.
  const installs: Array<() => void> = [];
  const install = () => {
    const un = installInputRelease();
    installs.push(un);
    return un;
  };
  afterEach(() => {
    while (installs.length) installs.pop()?.();
  });
  // THIS describe needs its own reset: the `listenMock.mockClear()` above lives in the OTHER
  // describe's beforeEach and does not run here. Without it `mock.calls[0]` stays the FIRST test's
  // call forever — so `waitFor(toHaveBeenCalled)` is satisfied by a stale record and `calls[0][1]`
  // invokes a handler belonging to an already-uninstalled subscription. Every later case would pass
  // even if its own install never subscribed, which is the precise opposite of the isolation the
  // teardown above exists for. Reads below use `calls.at(-1)` for the same reason.
  beforeEach(() => {
    resetInputReleaseCoalescing();
    listenMock.mockClear();
    unlistenMock.mockClear();
    document.body.innerHTML = "";
    useKeybindingsStore.getState().setCapturingShortcut(null);
  });

  it("subscribes to the event name the native menu emits", async () => {
    install();
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalled());
    expect(listenMock.mock.calls.at(-1)?.[0]).toBe(INPUT_RELEASE_EVENT);
  });

  it("releases on the keyboard fallback, which is the only hatch in a dev server", async () => {
    // `app_menu.rs` documents this fallback for the two cases the native path cannot reach: no Tauri
    // runtime at all, and a menu item that degraded to no key equivalent. It was documented but not
    // implemented — the exact "the hatch is not actually installed" failure this bead is about.
    const uninstall = install();
    wedgeTheApp();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", shiftKey: true, metaKey: true, bubbles: true }),
    );

    expect(useKeybindingsStore.getState().capturingShortcut).toBeNull();
    expect(useCableStore.getState().wired).toBe("off");
    uninstall();
  });

  it("unsubscribes the Tauri listener on uninstall, not just the keydown one", async () => {
    // Both app roots install this now, so a leaked subscription compounds per mount.
    const uninstall = install();
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalled());

    uninstall();

    expect(unlistenMock).toHaveBeenCalled();
  });

  it("ignores an autorepeat, so holding the chord is one release and not thirty", () => {
    // Holding a key emits a keydown every ~30ms. Without the `e.repeat` guard the whole release
    // runs on each, flooding the WARN line that IS this bead's recurrence signal.
    const uninstall = install();
    wedgeTheApp();

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape", shiftKey: true, metaKey: true, repeat: true, bubbles: true,
      }),
    );

    expect(useCableStore.getState().wired).not.toBe("off");
    uninstall();
  });

  it("stops listening after uninstall", () => {
    const uninstall = install();
    uninstall();
    wedgeTheApp();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", shiftKey: true, metaKey: true, bubbles: true }),
    );

    // Still wedged: a removed listener must not keep firing, or every later mount stacks another.
    expect(useCableStore.getState().wired).not.toBe("off");
  });

  it("releases when the native menu item fires", async () => {
    install();
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalled());
    const handler = listenMock.mock.calls.at(-1)?.[1] as unknown as () => void;
    wedgeTheApp();

    handler();

    expect(useKeybindingsStore.getState().capturingShortcut).toBeNull();
    expect(useCableStore.getState().wired).toBe("off");
  });
});
