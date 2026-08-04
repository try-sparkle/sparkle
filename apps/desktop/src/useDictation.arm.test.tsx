// @vitest-environment jsdom
/**
 * THE PRODUCTION ARM PATH — `useAmbientVoice`'s `enabled` effect.
 *
 * Its own file, and in jsdom, for one reason: this is the path that actually runs when a user arms
 * the mic, and it had no coverage. `useDictation.test.ts` runs under node (no `document`, so
 * `focusOwnerNow()` can only ever answer "other") and its arming cases drive
 * `createDictationController().toggle()` — which, as roborev 55555 found, has ZERO callers in the
 * app. The mic button and the voice menu both arm through `setEnabled(true)`
 * (MicButton.tsx:120,183,194 / VoiceControlsMenu.tsx:159), which lands in the effect exercised here.
 *
 * So the earlier tests pinned a dead path while the live one was free to regress: reverting just the
 * effect's `armedStatus(...)` call to a bare `setStatus("listening")` left every one of them green.
 * These fail on exactly that mutation, with a REAL focused xterm element rather than an injected seam.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

const listeners: Record<string, Array<(e: { payload: unknown }) => void>> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    (listeners[name] ??= []).push(cb);
    return Promise.resolve(() => {
      listeners[name] = (listeners[name] ?? []).filter((c) => c !== cb);
    });
  },
}));
const invoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

// The sink is the far end of the terminal path. Mocked so the REAL hook wiring in between —
// `advance()` → the surviving text → the controller → here — is what the assertions travel through.
const routeToTerminal = vi
  .fn()
  .mockResolvedValue({ kind: "delivered", agentId: "a1", text: "x" });
vi.mock("./services/dictationTerminalSink", () => ({
  routeDictationToTerminal: (...a: unknown[]) => routeToTerminal(...a),
}));

import { useDictationStore } from "./stores/dictationStore";
import { useAmbientVoice } from "./useDictation";

/** Emit a real Tauri broadcast into every registered listener. */
function emit(name: string, payload: unknown) {
  for (const cb of listeners[name] ?? []) cb({ payload });
}

/** A real xterm helper textarea, focused — the exact shape the field focus-trace recorded while the
 *  mic was live (`activeElement=textarea .xterm-helper-textarea`). Not a stub: `classifyFocusOwner`
 *  matches on `closest()`, so the DOM has to genuinely be this shape for the test to mean anything. */
function focusATerminal(): void {
  const pane = document.createElement("div");
  pane.setAttribute("data-terminal-surface", "");
  const ta = document.createElement("textarea");
  ta.className = "xterm-helper-textarea";
  pane.appendChild(ta);
  document.body.appendChild(pane);
  ta.focus();
}

function focusTheComposer(): void {
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  ta.focus();
}

beforeEach(() => {
  document.body.innerHTML = "";
  invoke.mockClear();
  for (const k of Object.keys(listeners)) delete listeners[k];
  // `enabled: false` so the effect's ARM branch is what the render below triggers.
  useDictationStore.setState({ enabled: false, status: "idle", error: null, modelProgress: null });
});

describe("arming the mic through the real path (setEnabled → the enabled effect)", () => {
  it("reads as PAUSED when the caret is already in a terminal", async () => {
    focusATerminal();
    useDictationStore.setState({ enabled: true });
    renderHook(() => useAmbientVoice());
    // THE ASSERTION. deriveMicPresentation maps any non-"listening" status to `focusPaused`, the one
    // presentation that renders the paused copy WITH its cause; "listening" would render
    // `passiveWaiting` — "Mic paused. Say Hey Sparkle to activate" — over a gate discarding every word.
    expect(useDictationStore.getState().status).toBe("idle");
    // It is a PAUSE, not a refusal to arm: capture really starts, so leaving the terminal resumes
    // without the user clicking the mic again. `start_dictation` is awaited behind the controller
    // promise (the listeners must attach before capture opens, so the first segment isn't dropped),
    // so this needs the microtask queue drained — asserting synchronously reads only the earlier
    // cloud-teardown call and would pass for the wrong reason.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledWith("start_dictation");
    expect(useDictationStore.getState().enabled).toBe(true);
    // The pause survives the arm completing — nothing in the async tail re-claims "listening".
    expect(useDictationStore.getState().status).toBe("idle");
  });

  it("still claims LISTENING when the caret is in the composer", () => {
    // The other half of the pin: `armedStatus` hard-wired to "idle" would satisfy the case above
    // while muting every ordinary arm, and the mic would never claim to listen at all.
    focusTheComposer();
    useDictationStore.setState({ enabled: true });
    renderHook(() => useAmbientVoice());
    expect(useDictationStore.getState().status).toBe("listening");
  });

  it("claims LISTENING when nothing holds the caret — the hands-free case must not self-pause", () => {
    // `activeElement` is <body> after a wake word, with no caret anywhere. Pausing here would break
    // the flow this whole feature is built around, so "nothing focused" must read as routable.
    useDictationStore.setState({ enabled: true });
    renderHook(() => useAmbientVoice());
    expect(useDictationStore.getState().status).toBe("listening");
  });

  // ══ THE TERMINAL IS A DESTINATION WHEN DICTATION IS WOKEN (roborev 56057) ═══════════════════
  // The other half of the terminal case above, and the one that pins the `terminalRoutes` argument
  // on THIS call site. Without it the argument is dead weight: the existing case runs with the
  // store's default `phase: "passive"`, where the term is false either way, so deleting it left the
  // suite green while restoring "Listening paused" over a sink busy typing.
  it("claims LISTENING with the caret in a terminal once dictation is WOKEN", () => {
    focusATerminal();
    useDictationStore.setState({ enabled: true, phase: "active" });
    renderHook(() => useAmbientVoice());
    expect(useDictationStore.getState().status).toBe("listening");
  });
});

// ══ THE REAL ROUTING GATE ON THE TERMINAL PATH ════════════════════════════════════════════════
// Every controller-level test injects a FAKE segment handler, so none of them proves that the real
// hook delivers the text — mutate `useAmbientVoice`'s `onSegment` to return null and terminal
// dictation types nothing, ever, with the whole suite green (roborev 56056). These drive the
// genuine handler through `useAmbientVoice`.
//
// WHAT CHANGED HERE. This block used to be about the STOP WORD: saying "Sparkle, pause" with the
// caret in a terminal had to end the session rather than be typed onto the agent's command line,
// and the handler stripped the phrase and delivered only the remainder. The wake word is retired,
// so no phrase is stripped and no segment moves the phase — what is left to prove is the gate
// itself: words go through iff the mic is ROUTING, and they go through UNTOUCHED.
describe("committed speech, with the caret in a terminal", () => {
  beforeEach(() => {
    useDictationStore.setState({ enabled: true, phase: "active", status: "listening" });
    routeToTerminal.mockClear();
  });

  /** Mount the hook and let the controller finish attaching. `createDictationController` awaits its
   *  `listen()` calls before subscribing to the store, and the event mock registers callbacks
   *  synchronously — so emitting straight after `renderHook` reaches the LISTENERS but outruns the
   *  SUBSCRIBER, and the phase-edge reconciliation silently wouldn't be under test. */
  async function mountVoice(): Promise<void> {
    renderHook(() => useAmbientVoice());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("types the words VERBATIM — nothing is stripped out of them any more", async () => {
    focusATerminal();
    await mountVoice();
    act(() => {
      emit("dictation://partial", "run the tests sparkle pause");
    });
    // THE ASSERTION THAT WOULD HAVE FAILED BEFORE: the matcher recognised a trailing stop phrase
    // and delivered only "run the tests", so a user whose sentence happened to contain those words
    // silently lost the tail of it (and had capture ended under them). Every committed word is the
    // user's now.
    expect(routeToTerminal).toHaveBeenCalledWith("run the tests sparkle pause");
    // …and no segment moves the phase. The tray is its only writer.
    expect(useDictationStore.getState().phase).toBe("active");
  });

  it("types NOTHING while the mic is armed but not routing — push to talk between holds", async () => {
    // The routing gate, which is all that survives of the old machine. An armed-but-passive mic
    // near an open terminal must stay inert: `terminalRoutingArmed` requires phase "active", and
    // this is what proves the real hook honours it rather than a stubbed one.
    useDictationStore.setState({ phase: "passive" });
    focusATerminal();
    await mountVoice();
    act(() => {
      emit("dictation://partial", "ls minus la");
    });
    expect(routeToTerminal).not.toHaveBeenCalled();
  });
});
