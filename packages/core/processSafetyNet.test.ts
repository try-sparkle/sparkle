// `installProcessSafetyNet` is the shared backstop for the long-lived stdio MCP servers: an unhandled
// rejection or an uncaught exception takes the server down for ALL future tool calls because Node's
// DEFAULT for both events is to terminate the process. The function registers handlers that LOG
// (never exit), so an escaped async error becomes a logged non-event instead of a dead server.
//
// These assert the SIDE EFFECT — each handler forwards the real reason/error, prefixed with the
// caller's label, to the injected logger — not the mere existence of a listener. A handler emptied of
// its body, wired to the wrong event name, or that dropped the label reds these. We deliberately do
// NOT assert the "does not call process.exit" direction by arming the real process: a mutant that
// exited would kill the test runner, not fail a test.
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { installProcessSafetyNet } from "./processSafetyNet";

describe("installProcessSafetyNet", () => {
  it("forwards an unhandledRejection reason to the logger", () => {
    const proc = new EventEmitter();
    const logError = vi.fn();
    installProcessSafetyNet({ label: "[mcp-test]", proc, logError });

    const reason = new Error("boom-rejection");
    proc.emit("unhandledRejection", reason);

    expect(logError).toHaveBeenCalledTimes(1);
    // The actual reason is passed through — a handler that logged a canned string and dropped the
    // reason would strip the one detail an operator needs.
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("unhandled rejection"), reason);
  });

  it("forwards an uncaughtException error to the logger", () => {
    const proc = new EventEmitter();
    const logError = vi.fn();
    installProcessSafetyNet({ label: "[mcp-test]", proc, logError });

    const err = new Error("boom-exception");
    proc.emit("uncaughtException", err);

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("uncaught exception"), err);
  });

  it("prefixes BOTH handlers' messages with the caller's label", () => {
    const proc = new EventEmitter();
    const logError = vi.fn();
    // The label is the one per-server difference this signature exists to carry. A shared function
    // that ignored it, or hardcoded one server's prefix, would strip the log line's server identity.
    installProcessSafetyNet({ label: "[mcp-alpha]", proc, logError });

    proc.emit("unhandledRejection", new Error("r"));
    proc.emit("uncaughtException", new Error("e"));

    expect(logError).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("[mcp-alpha]"),
      expect.any(Error),
    );
    expect(logError).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("[mcp-alpha]"),
      expect.any(Error),
    );
  });

  it("registers a handler for BOTH events, not just one", () => {
    const proc = new EventEmitter();
    installProcessSafetyNet({ label: "[mcp-test]", proc, logError: vi.fn() });

    // If either registration is dropped, one of these is 0 and the corresponding forward-test above
    // could still pass vacuously against a partially-wired net; this pins both are live.
    expect(proc.listenerCount("unhandledRejection")).toBe(1);
    expect(proc.listenerCount("uncaughtException")).toBe(1);
  });
});
