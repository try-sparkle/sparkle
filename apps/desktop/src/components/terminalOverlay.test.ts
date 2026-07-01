import { describe, it, expect } from "vitest";
import { resolveTerminalOverlay } from "./terminalOverlay";

describe("resolveTerminalOverlay", () => {
  it("shows the loading hint before any output (Starting / Resuming)", () => {
    expect(resolveTerminalOverlay(null, false, false)).toEqual({ kind: "loading", message: "Starting…" });
    expect(resolveTerminalOverlay(null, false, true)).toEqual({ kind: "loading", message: "Resuming conversation…" });
  });

  it("shows nothing once output has streamed", () => {
    expect(resolveTerminalOverlay(null, true, false)).toEqual({ kind: "none" });
  });

  it("shows a retryable fail state — never a silent blank — when spawn fails or exits empty", () => {
    expect(resolveTerminalOverlay("failed", false, false)).toEqual({
      kind: "fail", canRetry: true, message: "Couldn't start the agent.",
    });
    expect(resolveTerminalOverlay("exited", false, false)).toEqual({
      kind: "fail", canRetry: true, message: "Agent exited.",
    });
  });

  it("lets a failure win over the loading hint regardless of firstOutput", () => {
    expect(resolveTerminalOverlay("exited", true, true).kind).toBe("fail");
  });
});
