import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { submitPrompt, PtyGoneError, writePty } from "./pty";

const ESC = String.fromCharCode(27);

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("submitPrompt", () => {
  it("wraps the text in a bracketed paste, then sends a carriage return", async () => {
    vi.useFakeTimers();
    try {
      const p = submitPrompt("a1", "give me a status update");
      await vi.runAllTimersAsync();
      await p;
      expect(invoke).toHaveBeenNthCalledWith(1, "pty_write", {
        id: "a1",
        data: `${ESC}[200~give me a status update${ESC}[201~`,
      });
      expect(invoke).toHaveBeenNthCalledWith(2, "pty_write", { id: "a1", data: "\r" });
    } finally {
      vi.useRealTimers();
    }
  });

  // The bug: an agent whose PTY died kept accepting prompts. pty_write returned
  // Err("no such pty"), writePty swallowed it, submitPrompt resolved as success, and the
  // composer recorded the prompt into history — so the prompt vanished with no feedback.
  // A deliberate user submit must NEVER be silently dropped.
  it("rejects with PtyGoneError when the paste lands on a dead PTY", async () => {
    invoke.mockRejectedValueOnce(new Error("no such pty"));
    await expect(submitPrompt("dead", "land it to main")).rejects.toBeInstanceOf(PtyGoneError);
  });

  it("rejects with PtyGoneError when the PTY dies between the paste and the carriage return", async () => {
    invoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("no such pty"));
    vi.useFakeTimers();
    try {
      const p = submitPrompt("dead", "land it to main");
      const assertion = expect(p).rejects.toBeInstanceOf(PtyGoneError);
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries the agent id on the error so the caller can restart that agent", async () => {
    invoke.mockRejectedValueOnce(new Error("no such pty"));
    await expect(submitPrompt("agent-7", "hi")).rejects.toMatchObject({ id: "agent-7" });
  });

  it("does not send the carriage return when the paste failed", async () => {
    invoke.mockRejectedValueOnce(new Error("no such pty"));
    await expect(submitPrompt("dead", "hi")).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("propagates a non-teardown write error unchanged", async () => {
    invoke.mockRejectedValueOnce(new Error("disk on fire"));
    await expect(submitPrompt("a1", "hi")).rejects.toThrow("disk on fire");
  });

  // Fire-and-forget callers (stray keystrokes, resizes) still swallow the teardown race —
  // that swallow was correct for them, it was only wrong on the deliberate submit path.
  it("leaves writePty's teardown-race swallow intact for fire-and-forget callers", async () => {
    invoke.mockRejectedValueOnce(new Error("no such pty"));
    await expect(writePty("dead", "x")).resolves.toBeUndefined();
  });

  // Two concurrent submits to the SAME agent must not interleave their paste/CR writes,
  // which would submit one prompt's text with the other's carriage return.
  it("serializes concurrent submits to the same agent", async () => {
    vi.useFakeTimers();
    try {
      const a = submitPrompt("same", "first");
      const b = submitPrompt("same", "second");
      await vi.runAllTimersAsync();
      await Promise.all([a, b]);
      const data = invoke.mock.calls.map((c) => (c[1] as { data: string }).data);
      expect(data).toEqual([
        `${ESC}[200~first${ESC}[201~`,
        "\r",
        `${ESC}[200~second${ESC}[201~`,
        "\r",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a failed submit wedge the agent's queue", async () => {
    invoke.mockRejectedValueOnce(new Error("no such pty"));
    await expect(submitPrompt("same", "doomed")).rejects.toThrow();
    invoke.mockResolvedValue(undefined);
    vi.useFakeTimers();
    try {
      const p = submitPrompt("same", "recovered");
      await vi.runAllTimersAsync();
      await p;
    } finally {
      vi.useRealTimers();
    }
    expect(invoke).toHaveBeenLastCalledWith("pty_write", { id: "same", data: "\r" });
  });
});
