// @vitest-environment jsdom
//
// The PRODUCTION WIRING of the stuck-agent fix, against the REAL runtime store.
//
// The fix is two lines — a module-level `useRuntimeStore.subscribe` — and every other test drives
// the exported body directly while mocking the store with an object that has no `subscribe`, so the
// `typeof subscribe === "function"` guard silently skipped registration. Delete the subscribe line
// and every one of those tests still passes while the bug returns in full (roborev 53203). This
// file exists to make that impossible: it lets the real store through and drives the clear by
// writing status, exactly as the app does.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ maybeAutoApprove: vi.fn(), scrollback: "" }));

vi.mock("./approvalsRuntime", () => ({
  maybeAutoApprove: h.maybeAutoApprove,
  maybeAutoResume: vi.fn(() => null),
  useSyncProjectApprovals: () => {},
}));
vi.mock("../terminalScrollback", () => ({ getAgentScrollback: () => h.scrollback }));
const e = vi.hoisted(() => ({ computeSuggestions: vi.fn() }));
vi.mock("./engine", () => ({ computeSuggestions: e.computeSuggestions }));
// NOTE: runtimeStore is deliberately NOT mocked — the whole point is the real `subscribe`.

import { useSuggestions, resetSuggestionMemory } from "./useSuggestions";
import { useRuntimeStore } from "../../stores/runtimeStore";

/** Answers once per distinct screen, recording into the set it is handed. */
function answerOncePerScreen(_agentId: string, scrollback: string, handled: Set<string>) {
  const sig = `sig:${scrollback}`;
  if (handled.has(sig)) return null;
  handled.add(sig);
  return "bash" as const;
}
const answered = () => h.maybeAutoApprove.mock.results.filter((r) => r.value).length;

beforeEach(() => {
  resetSuggestionMemory();
  h.scrollback = "Do you want to proceed?\n1. Yes\n2. No";
  h.maybeAutoApprove.mockReset();
  h.maybeAutoApprove.mockImplementation(answerOncePerScreen);
  e.computeSuggestions.mockReset();
  e.computeSuggestions.mockResolvedValue({ agentId: "a1", buttons: [] });
  useRuntimeStore.setState({ status: { a1: "approval" } });
});
afterEach(() => cleanup());

describe("the real store subscription clears the de-dupe set", () => {
  it("a status write to the REAL store clears an unmounted agent's signatures", async () => {
    const first = renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    expect(answered()).toBe(1);
    first.unmount(); // the user switches away

    // The agent finishes its turn. This goes through the module subscription, not a test helper —
    // if that line is ever deleted, this is what fails.
    await act(async () => {
      useRuntimeStore.setState({ status: { a1: "working" } });
    });

    // Back on the agent, a NEW prompt with the same options must be answered again.
    useRuntimeStore.setState({ status: { a1: "approval" } });
    renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    expect(answered()).toBe(2);
  });

  it("a status write that keeps the agent in your-turn does NOT clear it", async () => {
    renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    await act(async () => {
      useRuntimeStore.setState({ status: { a1: "waiting" } }); // still asking
    });
    cleanup();
    renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    expect(answered()).toBe(1);
  });
});

// A compute that resolves after the agent left your-turn must not type.
//
// HONEST SCOPE. In jsdom a zustand write re-renders through useSyncExternalStore before the
// compute's promise resolves, so the effect cleanup has already set `alive = false` and THAT is the
// guard these cases exercise — not the live-status re-read added for roborev 53203/53248. I could
// not construct the pre-commit window here (writing the store outside act() doesn't help; React
// still commits first), so the live-status gate remains defence-in-depth without a regression test
// that isolates it. Removing `isLive()` does not fail this file — verified — and that is recorded
// rather than papered over, because a test that reads as a guarantee and isn't is the exact failure
// mode this branch has been fixing. The behaviour below is still worth pinning: the outcome the
// user cares about (no keystroke into a moved-on agent) is asserted, whichever guard delivers it.
describe("a compute resolving after the turn flipped must not type", () => {
  it("does not auto-answer when the agent has moved on", async () => {
    let resolveCompute: (v: unknown) => void = () => {};
    e.computeSuggestions.mockReturnValueOnce(
      new Promise((r) => {
        resolveCompute = r;
      }),
    );
    renderHook(() => useSuggestions("a1", true));
    await act(async () => {}); // the compute is now in flight

    // The agent finishes its turn while the compute is outstanding — WITHOUT act(), so React has
    // not committed and the compute effect's `alive` is still true. That is the actual window: the
    // module watcher clears the de-dupe set synchronously inside `set`, and only the live-status
    // re-read stands between the resolving compute and a second keystroke. Wrapping this in act()
    // flushes the commit and the `alive` guard handles it instead, which tests the wrong thing.
    useRuntimeStore.setState({ status: { a1: "working" } });

    await act(async () => {
      resolveCompute({ agentId: "a1", buttons: [] });
    });
    expect(answered()).toBe(0); // nothing typed into an agent that has moved on
  });

  // The negative twin: still asking when it resolves → answered exactly once.
  it("DOES auto-answer when the agent is still asking at resolve", async () => {
    let resolveCompute: (v: unknown) => void = () => {};
    e.computeSuggestions.mockReturnValueOnce(
      new Promise((r) => {
        resolveCompute = r;
      }),
    );
    renderHook(() => useSuggestions("a1", true));
    await act(async () => {});
    await act(async () => {
      resolveCompute({ agentId: "a1", buttons: [] });
    });
    expect(answered()).toBe(1);
  });
});
