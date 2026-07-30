// TERMINAL'S TWO FOCUS REQUESTS ARE NOT INTERCHANGEABLE.
//
//   reveal  the app asking — pane shown, agent changed, layout re-fit.
//   chord   the ⌘J keypress. The USER naming the box they want.
//
// Only the second may ever move the dictation surface, and getting them backwards is a shipped bug
// in either direction (roborev 54245 / 54252 / 54259).
//
// This lived inside SparkleAgentPane.focus.test.tsx, which drove the map with that pane's real
// handlers. That pane's composer is gone, so it supplies neither handler now and the suite went with
// it — but the MAP is still what Terminal routes its two call sites through, so the distinction is
// pinned here directly rather than dropped. Pure functions, no DOM needed.
import { describe, expect, it, vi } from "vitest";

import { composerFocusRequest } from "./Terminal";

describe("composerFocusRequest", () => {
  it("routes the ⌘J chord to onUserRequestFocus and nothing else", () => {
    const onRequestFocus = vi.fn();
    const onUserRequestFocus = vi.fn();

    composerFocusRequest.chord({ onRequestFocus, onUserRequestFocus });

    expect(onUserRequestFocus).toHaveBeenCalledTimes(1);
    expect(onRequestFocus).not.toHaveBeenCalled();
  });

  it("routes a reveal to onRequestFocus and nothing else", () => {
    const onRequestFocus = vi.fn();
    const onUserRequestFocus = vi.fn();

    composerFocusRequest.reveal({ onRequestFocus, onUserRequestFocus });

    expect(onRequestFocus).toHaveBeenCalledTimes(1);
    expect(onUserRequestFocus).not.toHaveBeenCalled();
  });

  it("is inert for a pane that supplies no handlers — the post-composer default", () => {
    // AgentPane has always passed neither, and SparkleAgentPane now does too. Both call sites must
    // therefore be safe to invoke on an empty handler set: Terminal calls the map unconditionally
    // and swallows the chord either way.
    expect(() => composerFocusRequest.chord({})).not.toThrow();
    expect(() => composerFocusRequest.reveal({})).not.toThrow();
  });
});
