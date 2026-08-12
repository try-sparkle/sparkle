// @vitest-environment jsdom
// THE COPY'S OWN READ of "why is the mic paused". Every surface that renders words about the pause
// goes through this hook, so it is the last place the gate and the copy can disagree — and it had no
// test at all when `terminalRoutes` was threaded into it (roborev 56056).
//
// The failure it guards is not cosmetic: a terminal that IS receiving dictated speech, described to
// the user as "Listening paused: Your cursor is in a terminal. Click the message box to resume." —
// an instruction to undo the thing they just did, printed over a pipeline that is working.
import { describe, expect, it, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDictationStore } from "../stores/dictationStore";
import { useDictationPauseReason } from "./useDictationPauseReason";

function set(over: Record<string, unknown>) {
  useDictationStore.setState({
    windowFocused: true,
    focusOwner: "other",
    enabled: true,
    status: "idle",
    phase: "passive",
    ...over,
  });
}

beforeEach(() => set({}));

describe("useDictationPauseReason", () => {
  it("is null in the ordinary case — composer caret, nothing to explain", () => {
    set({});
    expect(renderHook(() => useDictationPauseReason()).result.current).toBeNull();
  });

  it("says TERMINAL while dictation is not routing, because the caret really is a dead end there", () => {
    set({ focusOwner: "terminal", phase: "passive" });
    expect(renderHook(() => useDictationPauseReason()).result.current).toBe("terminal");
  });

  // ══ THE ONE THAT PINS `terminalRoutes` ═══════════════════════════════════════════════════════
  it("is NULL with the caret in a terminal once dictation is WOKEN — it is a destination, not a pause", () => {
    set({ focusOwner: "terminal", phase: "active" });
    expect(renderHook(() => useDictationPauseReason()).result.current).toBeNull();
  });

  it("says TERMINAL again when dictation is faulted, since a faulted mic types nowhere", () => {
    // `woken` alone is not enough: the routing gate also excludes an errored mic, and the copy has
    // to track the gate exactly or it resumes lying in the other direction.
    set({ focusOwner: "terminal", phase: "active", status: "error" });
    expect(renderHook(() => useDictationPauseReason()).result.current).toBe("terminal");
  });

  it("says WINDOW ahead of a terminal — the useful thing is 'you're in another app'", () => {
    set({ windowFocused: false, focusOwner: "terminal", phase: "active" });
    expect(renderHook(() => useDictationPauseReason()).result.current).toBe("window");
  });

  it("is null for a muted mic: OFF is not PAUSED, whatever the caret is doing", () => {
    set({ enabled: false, focusOwner: "terminal" });
    expect(renderHook(() => useDictationPauseReason()).result.current).toBeNull();
  });
});
