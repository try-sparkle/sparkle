// @vitest-environment jsdom
//
// THE IN-TERMINAL ESCAPE GESTURE, at the layer that actually implements it.
//
// This file exists because the previous version of the feature was UNREACHABLE and its tests could not
// see that. It lived in `Workspace`'s `window` keydown listener, and an Escape typed into a focused
// xterm never gets there — xterm calls `cancel(ev, true)` for Escape, which is `preventDefault()` +
// `stopPropagation()`. Every test passed anyway because they fired `keyDown(window, …)` directly at a
// stub textarea with no xterm handler, bypassing the exact mechanism that blocked it (roborev 55722).
//
// So the assertions here are about the DECISION, driven through the function `Terminal.tsx` calls, with
// the cable store as the observable side effect. `Terminal.keyOwnership.test.tsx` covers the other half
// — that the handler is wired and still lets the byte through — including a case with an xterm double
// that stops propagation the way the real one does.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearTerminalEscapeToll,
  noteTerminalEscape,
  terminalEscapeTollPaid,
} from "./terminalEscapeRelease";
import {
  markTerminalAutoFocus,
  noteTerminalInteraction,
  resetTerminalFocusIntent,
} from "./terminalFocusIntent";
import { resetCable, useCableStore } from "../stores/cableStore";
import { RELEASE_ARM_WINDOW_MS } from "../engine/cable";

const wired = () => useCableStore.getState().wired;

beforeEach(() => {
  resetCable();
  resetTerminalFocusIntent();
  clearTerminalEscapeToll();
});
afterEach(() => {
  resetCable();
  resetTerminalFocusIntent();
  clearTerminalEscapeToll();
});

describe("a caret the APP parked — Escape keeps its old meaning", () => {
  // THE REGRESSION THE FIRST REVIEW CAUGHT (roborev 55614). `AgentPane` parks the caret in the
  // terminal whenever a pane is visible and ready, so this is the app's RESTING state — not a signal
  // that the user is working there. One Escape must still release, exactly as it has for years.
  it("releases on the FIRST press", () => {
    useCableStore.getState().patch("right", null);
    expect(noteTerminalEscape({ now: 1_000 })).toBe("release");
    expect(wired()).toBe("off");
  });

  it("charges no toll, so nothing is left half-armed behind it", () => {
    useCableStore.getState().patch("right", null);
    noteTerminalEscape({ now: 1_000 });
    expect(terminalEscapeTollPaid(1_000)).toBe(false);
  });
});

describe("a terminal the USER is working in — Escape twice unmounts", () => {
  // The founder's gesture: "when I'm in terminal … if I press escape twice, it unmounts the concierge."
  it("withholds the first press and releases on the second", () => {
    useCableStore.getState().patch("right", null);
    noteTerminalInteraction(); // the user typed, or clicked in
    expect(noteTerminalEscape({ now: 1_000 })).toBe("process-only");
    expect(wired()).toBe("right");
    expect(noteTerminalEscape({ now: 1_100 })).toBe("release");
    expect(wired()).toBe("off");
  });

  // A TOLL, NOT A PER-PRESS CHARGE. Paid once per sequence, so the gesture is two presses total rather
  // than two per rung — which is what someone would hit if the toll re-armed on every press.
  it("does not re-charge itself between the two presses", () => {
    useCableStore.getState().patch("right", null);
    noteTerminalInteraction();
    noteTerminalEscape({ now: 1_000 });
    expect(terminalEscapeTollPaid(1_050)).toBe(true);
    noteTerminalEscape({ now: 1_050 });
    expect(terminalEscapeTollPaid(1_060)).toBe(false);
  });

  // IT EXPIRES. Otherwise "the second Escape" is any later Escape, arbitrarily far away and in a
  // different context — roborev 55478's defect. The wall clock is the backstop that cannot be defeated
  // by xterm swallowing every intervening keystroke.
  it("re-charges the toll once the window has passed", () => {
    useCableStore.getState().patch("right", null);
    noteTerminalInteraction();
    noteTerminalEscape({ now: 1_000 });
    const late = 1_000 + RELEASE_ARM_WINDOW_MS + 1;
    expect(noteTerminalEscape({ now: late })).toBe("process-only");
    expect(wired()).toBe("right");
  });

  it("re-charges the toll after an intervening gesture clears it", () => {
    useCableStore.getState().patch("right", null);
    noteTerminalInteraction();
    noteTerminalEscape({ now: 1_000 });
    clearTerminalEscapeToll(); // a pointer press, or any non-Escape key
    expect(noteTerminalEscape({ now: 1_100 })).toBe("process-only");
    expect(wired()).toBe("right");
  });
});

describe("provenance is upgraded by interaction, not decided once at focus time", () => {
  // ══ THE MISCLASSIFICATION THE SECOND REVIEW CAUGHT (roborev 55722) ══════════════════════════════
  // Once the pane has parked the caret, the textarea is ALREADY the active element — so a click inside
  // it raises no `focusin`, and every keystroke is swallowed by xterm before any window listener sees
  // it. Provenance decided purely at focus time therefore stayed "automatic" for the whole session in
  // which the user was actually working there, and the wrong ladder applied.
  it("treats a parked caret the user has since typed at as deliberate", () => {
    markTerminalAutoFocus(); // the pane parks the caret…
    resetTerminalFocusIntent();
    useCableStore.getState().patch("right", null);
    // …and now the user types at it, which is the only signal available.
    noteTerminalInteraction();
    expect(noteTerminalEscape({ now: 1_000 })).toBe("process-only");
    expect(wired()).toBe("right");
  });

  it("is idempotent, because it runs once per keystroke", () => {
    useCableStore.getState().patch("right", null);
    noteTerminalInteraction();
    noteTerminalInteraction();
    noteTerminalInteraction();
    expect(noteTerminalEscape({ now: 1_000 })).toBe("process-only");
    expect(noteTerminalEscape({ now: 1_100 })).toBe("release");
  });
});

describe("nothing patched", () => {
  // A press with no cable has nothing to release — and must not spend the toll either, or the user's
  // FIRST press after patching would already be paid for and would unmount unexpectedly.
  it("is inert and leaves the toll uncharged", () => {
    noteTerminalInteraction();
    expect(noteTerminalEscape({ now: 1_000 })).toBe("inert");
    expect(wired()).toBe("off");
    expect(terminalEscapeTollPaid(1_000)).toBe(false);
    // …so once a cable IS patched, the gesture starts from the beginning.
    useCableStore.getState().patch("right", null);
    expect(noteTerminalEscape({ now: 1_100 })).toBe("process-only");
    expect(wired()).toBe("right");
  });
});
