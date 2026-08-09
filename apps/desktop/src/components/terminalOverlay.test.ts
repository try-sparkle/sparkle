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

  // THE REASON MUST REACH THE USER (sparkle-mahbf). "Couldn't start the agent." on its own is
  // unactionable: the founder's embedded Claude login was being refused by pty_spawn's worktree-scope
  // guard on every attempt, and the only place that said so was a `console.debug` nobody reads. The
  // pane looked identical to a slow start, so a hard, permanent rejection was indistinguishable from
  // a transient one — and "Start again" looked like a dead button rather than a doomed retry.
  it("carries the real spawn error through as a detail line", () => {
    const o = resolveTerminalOverlay(
      "failed",
      false,
      false,
      "pty_spawn: cwd is outside the managed worktrees directory",
    );
    expect(o).toEqual({
      kind: "fail",
      canRetry: true,
      message: "Couldn't start the agent.",
      detail: "pty_spawn: cwd is outside the managed worktrees directory",
    });
  });

  it("omits the detail when there is no reason to show, rather than printing an empty line", () => {
    expect(resolveTerminalOverlay("failed", false, false, "   ")).toEqual({
      kind: "fail", canRetry: true, message: "Couldn't start the agent.",
    });
    expect(resolveTerminalOverlay("exited", false, false, undefined)).toEqual({
      kind: "fail", canRetry: true, message: "Agent exited.",
    });
  });
});
