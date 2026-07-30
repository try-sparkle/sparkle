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

import { useDictationStore } from "./stores/dictationStore";
import { useAmbientVoice } from "./useDictation";

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
});
