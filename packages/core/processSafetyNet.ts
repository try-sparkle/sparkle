// The process-level backstop shared by every long-lived stdio MCP server (apps/mcp-control and
// apps/mcp-orchestrator). Each server serves ONE external user for the whole session over stdio, so
// an unhandled rejection or an uncaught exception does not fail one request — Node's DEFAULT for both
// events is to TERMINATE the process, which kills the server for ALL future tool calls. This is the
// backstop for the path nobody guarded yet: a handler added later, a transport-level `error`, a
// fire-and-forget send, or a rejection thrown deep in a dependency. It logs and keeps serving instead.
//
// WHY KEEPING ALIVE IS THE RIGHT TRADE FOR THESE SERVERS (it is NOT a blanket rule): the request path
// holds no half-written cross-request state to carry forward — each `BridgeClient` opens a FRESH
// Unix-socket connection per call and closes it, so the next tool call opens a clean socket exactly
// as the last one did and an escaped error from one call cannot corrupt the next. A dead server, by
// contrast, fails every future call with no diagnostic at all — the worse failure for an external user.
//
// The log goes to STDERR, never stdout: stdout is the JSON-RPC channel and a stray line there corrupts
// the protocol for the client. `proc`/`logError` are injected so the wiring is testable without arming
// a real process-global handler, and `label` is a PARAMETER — each server passes its own prefix
// (`[mcp-control]`, `[mcp-orchestrator]`) so a log line still names which server survived the error.
//
// This lived as two byte-identical copies (one per server) before it was extracted here; the only
// difference between them was the label, which is why the label is the one thing this signature takes.

export interface ProcessSafetyNetOptions {
  /**
   * Per-server log prefix, e.g. `[mcp-control]` — prepended to both handlers' messages so a survived
   * error names the server it came from. Required: there is no sensible default for "which server".
   */
  label: string;
  /**
   * The event source to register handlers on. Defaults to the real `process`; tests pass an
   * `EventEmitter` so they can drive the handlers without arming a real process-global listener.
   */
  proc?: Pick<NodeJS.EventEmitter, "on">;
  /**
   * The sink for the logged reason/error. Defaults to `console.error` (stderr). Injected so a test
   * asserts the reason is forwarded rather than the mere existence of a listener.
   */
  logError?: (message: string, detail: unknown) => void;
}

export function installProcessSafetyNet({
  label,
  proc = process,
  logError = (message, detail) => console.error(message, detail),
}: ProcessSafetyNetOptions): void {
  proc.on("unhandledRejection", (reason: unknown) => {
    logError(`${label} unhandled rejection (server kept alive):`, reason);
  });
  proc.on("uncaughtException", (err: unknown) => {
    logError(`${label} uncaught exception (server kept alive):`, err);
  });
}
