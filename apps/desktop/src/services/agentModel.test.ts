import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { applyModelToRunningAgent } from "./agentModel";
import { useRuntimeStore } from "../stores/runtimeStore";

const CLEAR_LINE = "\x05\x15"; // Ctrl-E + Ctrl-U — whole-line clear regardless of cursor position

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  useRuntimeStore.setState({ openAgentIds: [], status: {} });
});

describe("applyModelToRunningAgent (mid-session /model, sparkle-i6rw)", () => {
  it("clears the line (Ctrl-U) + types /model <id>, then Enter in a SECOND write (popup-safe)", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"] });
    vi.useFakeTimers();
    try {
      const p = applyModelToRunningAgent("a1", "claude-opus-4-8");
      await vi.runAllTimersAsync();
      await p;
      expect(invoke).toHaveBeenNthCalledWith(1, "pty_write", {
        id: "a1",
        data: `${CLEAR_LINE}/model claude-opus-4-8`,
      });
      expect(invoke).toHaveBeenNthCalledWith(2, "pty_write", { id: "a1", data: "\r" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes rapid picks on the same agent — no interleaved writes (roborev 23524)", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"] });
    vi.useFakeTimers();
    try {
      // Both fired inside the submit-delay window; the chain must fully deliver the first
      // (text + Enter) before the second starts, so the last pick lands as its own command.
      const p1 = applyModelToRunningAgent("a1", "claude-opus-4-8");
      const p2 = applyModelToRunningAgent("a1", "claude-haiku-4-5");
      await vi.runAllTimersAsync();
      await Promise.all([p1, p2]);
      expect(invoke.mock.calls.map((c) => (c[1] as { data: string }).data)).toEqual([
        `${CLEAR_LINE}/model claude-opus-4-8`,
        "\r",
        `${CLEAR_LINE}/model claude-haiku-4-5`,
        "\r",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the trailing Enter if a live question pops up DURING the submit delay", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"], status: { a1: "working" } });
    vi.useFakeTimers();
    try {
      const p = applyModelToRunningAgent("a1", "claude-opus-4-8");
      // Let the command text land, then a permission prompt appears mid-delay — the Enter
      // would confirm IT, so it must be skipped (text is left benignly in the composer).
      await vi.advanceTimersByTimeAsync(0);
      useRuntimeStore.setState({ status: { a1: "approval" } });
      await vi.runAllTimersAsync();
      await p;
      expect(invoke.mock.calls.map((c) => (c[1] as { data: string }).data)).toEqual([
        `${CLEAR_LINE}/model claude-opus-4-8`,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-checks liveness at DELIVERY time: a queued pick is dropped if the PTY closes mid-wait", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"] });
    vi.useFakeTimers();
    try {
      const p1 = applyModelToRunningAgent("a1", "claude-opus-4-8");
      const p2 = applyModelToRunningAgent("a1", "claude-haiku-4-5");
      // Let the first delivery start (type its command, enter the submit-delay wait)…
      await vi.advanceTimersByTimeAsync(0);
      // …then the agent closes while it waits; the queued second pick must see the closed PTY
      // when its turn comes and write nothing.
      useRuntimeStore.setState({ openAgentIds: [] });
      await vi.runAllTimersAsync();
      await Promise.all([p1, p2]);
      // The in-flight delivery's Enter AND the whole queued pick are dropped — the pre-Enter
      // re-check sees the closed PTY too.
      expect(invoke.mock.calls.map((c) => (c[1] as { data: string }).data)).toEqual([
        `${CLEAR_LINE}/model claude-opus-4-8`,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is fire-and-forget safe: a PTY write rejection is swallowed, not surfaced", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"] });
    invoke.mockRejectedValue(new Error("pty backend exploded"));
    // Must resolve (not reject) — the void call site would otherwise raise an unhandled rejection.
    await expect(applyModelToRunningAgent("a1", "claude-opus-4-8")).resolves.toBeUndefined();
  });

  it("writes nothing while the REPL shows a live question — Enter must not confirm a dialog", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"], status: { a1: "approval" } });
    await applyModelToRunningAgent("a1", "claude-opus-4-8");
    expect(invoke).not.toHaveBeenCalled();
    useRuntimeStore.setState({ status: { a1: "waiting" } });
    await applyModelToRunningAgent("a1", "claude-opus-4-8");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("writes nothing when the agent has no live PTY (store-only change, applies next spawn)", async () => {
    await applyModelToRunningAgent("closed-agent", "claude-opus-4-8");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("writes nothing for the 'default' sentinel (no /model unset; next spawn drops the flag)", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"] });
    await applyModelToRunningAgent("a1", "default");
    expect(invoke).not.toHaveBeenCalled();
  });
});
