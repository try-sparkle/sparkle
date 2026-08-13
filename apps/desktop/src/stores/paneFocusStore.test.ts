import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyPaneFocus, resetPaneFocus, usePaneFocusStore } from "./paneFocusStore";

beforeEach(resetPaneFocus);

describe("paneFocusStore", () => {
  it("records a request and hands it to exactly one consumer", () => {
    usePaneFocusStore.getState().request("a1");
    expect(usePaneFocusStore.getState().consume("a1")).not.toBeNull();
    // A second consume finds nothing — otherwise the pane would re-steal the caret on every
    // unrelated re-render for as long as the agent stayed selected.
    expect(usePaneFocusStore.getState().consume("a1")).toBeNull();
  });

  it("keeps requests per agent, so focusing one pane does not consume another's", () => {
    usePaneFocusStore.getState().request("a1");
    usePaneFocusStore.getState().request("a2");
    usePaneFocusStore.getState().consume("a1");
    expect(usePaneFocusStore.getState().consume("a2")).not.toBeNull();
  });

  it("TICKS rather than latching, so a repeated click is a repeated request", () => {
    // The value must CHANGE, or React's dependency comparison drops the second request and the
    // user's second click does nothing — the exact reason this is a counter and not a boolean.
    usePaneFocusStore.getState().request("a1");
    const first = usePaneFocusStore.getState().requests["a1"];
    usePaneFocusStore.getState().request("a1");
    expect(usePaneFocusStore.getState().requests["a1"]).not.toBe(first);
  });

  it("keeps ticking ACROSS a consume — the request/consume/request round trip", () => {
    // The realistic loop: click the row, the pane takes the caret, click it again. A counter derived
    // from the agent's own previous value restarts at 1 once the key is gone, so both asks carry the
    // same number and anything comparing them sees no second ask at all.
    usePaneFocusStore.getState().request("a1");
    const first = usePaneFocusStore.getState().requests["a1"];
    usePaneFocusStore.getState().consume("a1");
    usePaneFocusStore.getState().request("a1");
    expect(usePaneFocusStore.getState().requests["a1"]).not.toBe(first);
  });
});

describe("applyPaneFocus", () => {
  const run = (over: Partial<Parameters<typeof applyPaneFocus>[0]> = {}) => {
    const focusTerminal = vi.fn();
    const consume = vi.fn();
    const outcome = applyPaneFocus({
      request: 1,
      visible: true,
      ready: true,
      focusTerminal,
      consume,
      ...over,
    });
    return { outcome, focusTerminal, consume };
  };

  it("focuses the terminal and clears the request", () => {
    const { outcome, focusTerminal, consume } = run();
    expect(outcome).toBe("focused");
    expect(focusTerminal).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("does nothing with no request pending", () => {
    const { outcome, focusTerminal } = run({ request: undefined });
    expect(outcome).toBe("skipped");
    expect(focusTerminal).not.toHaveBeenCalled();
  });

  it("DECLINES while the user is mid-message — and spends the request doing so", () => {
    // Never out from under a half-typed message. The consume is the load-bearing half: a decline
    // that left the request pending would fire it on the next change to any input, dropping the
    // caret into a terminal at a moment the user made no gesture at all.
    const { outcome, focusTerminal, consume } = run({ typing: true });
    expect(outcome).toBe("declined");
    expect(focusTerminal).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("HOLDS the request while the pane is hidden or its PTY is not up yet", () => {
    // Both gates matter, and holding is the point: a request that arrived before the terminal
    // existed must still land once it does, rather than being spent on nothing. So neither branch
    // may consume.
    for (const gate of [{ visible: false }, { ready: false }]) {
      const { outcome, focusTerminal, consume } = run(gate);
      expect(outcome).toBe("skipped");
      expect(focusTerminal).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
    }
  });
});
