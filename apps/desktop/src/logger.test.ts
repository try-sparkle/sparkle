import { describe, expect, it } from "vitest";
import { isBenignTauriRejection, shouldForwardConsole } from "./logger";

// The console patch forwards captured console.* lines to the persistent log. Tauri's own
// JS runtime emits "[TAURI] Couldn't find callback id N" on every in-flight IPC callback
// when the webview reloads mid-async — thousands per reload — which is benign noise that
// buried real signal (~88% of one session's log volume). shouldForwardConsole keeps that
// noise out of the log file while letting genuine app warnings through.
describe("shouldForwardConsole", () => {
  it("drops the Tauri callback-id flood (exact message)", () => {
    expect(
      shouldForwardConsole(
        "[TAURI] Couldn't find callback id 1234567890 in the window. This might happen when the app is reloaded while Rust is running an asynchronous operation.",
      ),
    ).toBe(false);
  });

  it("drops the callback-id message regardless of surrounding text", () => {
    expect(shouldForwardConsole("prefix Couldn't find callback id 42 suffix")).toBe(false);
  });

  it("forwards genuine application warnings", () => {
    expect(shouldForwardConsole("refresh blocked: conflict")).toBe(true);
    expect(shouldForwardConsole("Failed to spawn agent: ENOENT")).toBe(true);
    expect(shouldForwardConsole("")).toBe(true);
  });

  // xterm's WebglAddon logs "webglcontextrestored event received" (at WARN) on every self-recovering
  // GPU context — dozens per loss/restore burst under GPU pressure. That auto-restore is pure good
  // news needing no action, so it's kept out of the log file. Its diagnostic siblings stay forwarded.
  it("drops xterm's benign webgl context-restored flood", () => {
    expect(shouldForwardConsole("webglcontextrestored event received")).toBe(false);
  });

  it("keeps the diagnostically useful xterm webgl lines", () => {
    expect(shouldForwardConsole("webglcontextlost event received")).toBe(true);
    expect(shouldForwardConsole("webgl context not restored; firing onContextLoss")).toBe(true);
  });
});

// The global unhandledrejection handler forwards every rejection at ERROR. Tauri's OWN injected
// event-dispatch script rejects during webview-reload/teardown races — the backend emits to a
// listener slot the frontend already tore down, so it evaluates `listeners[eventId].handlerId`
// on undefined. We never hold that promise, so we can't .catch it at the source; it's benign
// teardown noise that recovers on its own. isBenignTauriRejection downgrades it to debug so the
// ERROR stream stays meaningful, while every genuine rejection still logs at ERROR.
describe("isBenignTauriRejection", () => {
  it("matches the Tauri event-dispatch teardown race (WebKit message form)", () => {
    expect(
      isBenignTauriRejection(
        "Unhandled rejection: TypeError: undefined is not an object (evaluating 'listeners[eventId].handlerId')",
      ),
    ).toBe(true);
  });

  it("does not downgrade genuine rejections", () => {
    expect(isBenignTauriRejection("Unhandled rejection: TypeError: Load failed")).toBe(false);
    expect(
      isBenignTauriRejection("Unhandled rejection: pty_spawn: cwd is outside the managed worktrees directory"),
    ).toBe(false);
    expect(isBenignTauriRejection("Unhandled rejection: Error: something genuinely broke")).toBe(false);
    expect(isBenignTauriRejection("")).toBe(false);
  });
});
