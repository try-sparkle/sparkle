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
import { formatBinding } from "../keyboardHints/keybindings";

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

// roborev 55540. Standing global handlers down during a capture removed the collision's only
// symptom (recording ⌘K used to open the palette on top of this pane) without removing the
// collision — so a colliding chord would be accepted, persisted, and permanent. The recorder now
// refuses it and keeps listening. Asserted on the STORE (what the app reads) plus the fact that the
// capture is still live, not on the button's styling.
describe("the recorder refuses a chord another handler already owns", () => {
  /** The composer row's CAPTURE button, identified by what it displays rather than by position.
   *
   *  It used to be `querySelectorAll("button")[2]`, which is only the second row's capture button if
   *  every row renders exactly [capture, reset] — and the guard fired only when the element was
   *  MISSING, never when index 2 had become a reset button. Driving a reset button instead would
   *  leave `capturingShortcut` null and make "the binding is unchanged" pass VACUOUSLY, which is the
   *  #1 failure mode AGENTS.md names (roborev 55581).
   *
   *  A capture button is labelled with its current binding, so the one showing toggleComposer's
   *  binding is unambiguous — and if it is absent or ambiguous this throws rather than guessing. */
  function composerButton(c: HTMLElement): HTMLButtonElement {
    const label = formatBinding(useKeybindingsStore.getState().bindings.toggleComposer);
    const hits = [...c.querySelectorAll("button")].filter((b) => b.textContent === label);
    if (hits.length !== 1) {
      throw new Error(
        `expected exactly one button labelled "${label}", found ${hits.length} — the Shortcuts pane changed shape`,
      );
    }
    return hits[0] as HTMLButtonElement;
  }

  /** Click the composer row's capture button and assert the capture really went live; returns the
   *  button.
   *
   *  It has to be resolved BEFORE the click — once listening, the label is the prompt (and once
   *  refused, the reason), so it can no longer be found by its binding text. Returning it is what
   *  lets a caller read the label afterwards without re-querying.
   *
   *  The precondition is asserted in EVERY test that depends on it, not just the first: without it a
   *  test whose click silently missed would still "pass" its main assertion. */
  function beginComposerCapture(c: HTMLElement): HTMLButtonElement {
    const btn = composerButton(c);
    act(() => btn.click());
    expect(useKeybindingsStore.getState().capturingShortcut).toBe("toggleComposer");
    return btn;
  }

  it("leaves the binding unchanged when ⌘K is pressed, and keeps listening", () => {
    const { container } = render(<KeyboardShortcutsMenu />);
    beginComposerCapture(container);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    });

    // Unchanged — still ⌘J, the default. Accepting ⌘K here is the durable bug.
    expect(useKeybindingsStore.getState().bindings.toggleComposer).toEqual(
      SHORTCUT_DEFAULTS.toggleComposer,
    );
    // And still recording, so the user gets another go rather than a silent no-op.
    expect(useKeybindingsStore.getState().capturingShortcut).toBe("toggleComposer");
  });

  it("says WHY on the button instead of just ignoring the press", () => {
    const { container } = render(<KeyboardShortcutsMenu />);
    const btn = beginComposerCapture(container);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    });

    expect(btn.textContent).toMatch(/command palette/);
  });

  it("does not show one row's refusal against the other row", () => {
    // The message is keyed to its ShortcutId, so a refusal recorded while the composer row was
    // listening must not appear on the hints row — `capturingShortcut` is a public store action, so
    // `listening` can move without this component's own button being clicked.
    const { container } = render(<KeyboardShortcutsMenu />);
    beginComposerCapture(container);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    });

    // Move the capture to the OTHER row by the store, bypassing the button's clear-on-click.
    act(() => useKeybindingsStore.getState().setCapturingShortcut("toggleHints"));

    expect(container.textContent).not.toMatch(/command palette/);
  });

  it("forgets the refusal when the user cancels with Escape", () => {
    // Keying the message stops it leaking to ANOTHER row, but not back onto the SAME row: cancel
    // after a refusal and re-enter, and a stale "⌘K already opens…" would greet a user who has
    // pressed nothing yet. Escape is the withdraw gesture, so it must clear the reason too.
    //
    // Re-entry goes through the STORE, not the button. The button's onClick clears the message
    // itself, so a button-driven re-entry passes whether or not Escape clears anything — this test
    // was written that way first and stayed green with the Escape clear deleted, i.e. vacuous. The
    // store is also the path that matters: `setCapturingShortcut` is public, which is exactly how a
    // capture can begin without this component's own click.
    const { container } = render(<KeyboardShortcutsMenu />);
    beginComposerCapture(container);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    });
    expect(container.textContent).toMatch(/command palette/);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(useKeybindingsStore.getState().capturingShortcut).toBeNull();

    act(() => useKeybindingsStore.getState().setCapturingShortcut("toggleComposer"));

    expect(container.textContent).not.toMatch(/command palette/);
  });

  it("still accepts a chord nobody owns", () => {
    // The baseline: without this, the test above could pass because recording is broken outright.
    const { container } = render(<KeyboardShortcutsMenu />);
    beginComposerCapture(container);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", metaKey: true }));
    });

    expect(useKeybindingsStore.getState().bindings.toggleComposer).toMatchObject({
      kind: "chord",
      key: "y",
      meta: true,
    });
    expect(useKeybindingsStore.getState().capturingShortcut).toBeNull();
  });
});

// bead sparkle-thm9o. The recorder's `onKey` calls `preventDefault()` UNCONDITIONALLY, on keydown
// AND keyup, from a capture-phase listener on `window` — which is what lets it record a chord
// without the chord also typing somewhere. The cost is that while `capturingShortcut` is set, EVERY
// key in the app is dead. That is fine for the length of a keypress and catastrophic if the gesture
// can be left mid-flight: ⌘Tab away from a live "Press a combo…" and macOS never delivers the
// keyup, so the capture never completes, the flag never clears, and the keyboard stays dead with no
// visible cause and no way back short of a relaunch.
//
// These assert the SIDE EFFECT — that a subsequent keypress is no longer swallowed — not just that
// the flag went null. The flag is the mechanism; a live keyboard is the thing the user cares about,
// and asserting it means a future change that clears the flag without releasing the keys still goes
// red.
describe("losing the window ends a capture instead of latching the keyboard", () => {
  /** Dispatch a keydown at `window` the way the app's own global handlers would receive it, and
   *  report whether the recorder swallowed it.
   *
   *  `cancelable: true` is load-bearing: `preventDefault()` on a non-cancelable event is a silent
   *  no-op, so `defaultPrevented` would read false even with the latch fully live — the assertion
   *  would pass for the wrong reason in BOTH directions and prove nothing. */
  function keyIsSwallowed(): boolean {
    const ev = new KeyboardEvent("keydown", { key: "a", cancelable: true, bubbles: true });
    act(() => {
      window.dispatchEvent(ev);
    });
    return ev.defaultPrevented;
  }

  it("releases the keyboard on window blur", () => {
    const { container } = render(<KeyboardShortcutsMenu />);
    act(() => captureButton(container).click());
    expect(useKeybindingsStore.getState().capturingShortcut).toBe("toggleHints");
    // The baseline the fix must not break: while a capture really is live, keys ARE swallowed.
    // Without this the test below could pass because the recorder never swallowed anything.
    expect(keyIsSwallowed()).toBe(true);

    // ⌘Tab / clicking another app. The keyup for the combo in flight is never delivered.
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(useKeybindingsStore.getState().capturingShortcut).toBeNull();
    // The part that matters to the user: typing works again.
    expect(keyIsSwallowed()).toBe(false);
  });

  it("forgets a refusal when the window is lost, so it can't greet the next capture", () => {
    // Same argument as Escape: abandoning the gesture must not leave "⌘K already opens…" behind for
    // a user who has pressed nothing yet. Re-entry goes through the STORE rather than the button,
    // because the button's own onClick clears the message — a button-driven re-entry would pass
    // whether or not blur clears anything, which is the vacuous shape.
    const { container } = render(<KeyboardShortcutsMenu />);
    const label = formatBinding(useKeybindingsStore.getState().bindings.toggleComposer);
    const btn = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
    if (!btn) throw new Error(`no button labelled "${label}" — the Shortcuts pane changed shape`);
    act(() => (btn as HTMLButtonElement).click());
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    });
    expect(container.textContent).toMatch(/command palette/);

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(useKeybindingsStore.getState().capturingShortcut).toBeNull();

    act(() => useKeybindingsStore.getState().setCapturingShortcut("toggleComposer"));

    expect(container.textContent).not.toMatch(/command palette/);
  });

  it("does not cancel a capture when focus merely moves INSIDE the app", () => {
    // The counterpart guard. `blur` does not bubble, so a non-capture listener on `window` hears the
    // window losing focus and not a button inside the pane losing it. Registering this in the
    // capture phase — or on `focusout`, which does bubble — would make clicking anywhere in the app
    // cancel a capture the user just started, trading a latch for an unusable recorder.
    const { container } = render(<KeyboardShortcutsMenu />);
    const btn = captureButton(container);
    act(() => btn.click());
    expect(useKeybindingsStore.getState().capturingShortcut).toBe("toggleHints");

    act(() => {
      btn.dispatchEvent(new FocusEvent("blur"));
    });

    expect(useKeybindingsStore.getState().capturingShortcut).toBe("toggleHints");
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
