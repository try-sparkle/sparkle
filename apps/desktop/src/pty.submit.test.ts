import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { submitPrompt } from "./pty";

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
});
