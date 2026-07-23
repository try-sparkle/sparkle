import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn((..._a: unknown[]) => Promise.resolve());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { isBenignTauriRejection, shouldForwardConsole, log, setDebugForwarding } from "./logger";

// Exactly the methods initLogger() patches (logger.ts `patch(...)` calls). Kept here so the
// console-patch test can hand the globals back untouched.
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;
type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

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

// Debug lines are a hot path (suggestions/approvals across dozens of agents). Forwarding each to the
// persistent log paid a synchronous `frontend_log` IPC → disk write on the JS main thread — the
// jank/log-volume this gate exists to remove. info/warn/error must always forward.
describe("debug forwarding gate", () => {
  it("does NOT forward debug lines when disabled, while info still forwards", () => {
    setDebugForwarding(false);
    invoke.mockClear();
    log.debug("suggestions", "compute", { chars: 5000, learnedOn: true });
    expect(invoke).not.toHaveBeenCalled();
    log.info("suggestions", "computed", { buttons: 3 });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("forwards debug lines once enabled (e.g. for a support capture)", () => {
    setDebugForwarding(true);
    invoke.mockClear();
    log.debug("suggestions", "compute", { chars: 5000 });
    expect(invoke).toHaveBeenCalledTimes(1);
    setDebugForwarding(false);
  });

  it("gates the patched console.debug the same way (the other hot path)", async () => {
    // initLogger patches global console.* and installs window listeners — shim window for node env.
    const realWin = (globalThis as unknown as { window?: unknown }).window;
    // Snapshot the REAL console methods: initLogger patches them globally and process-wide, and a
    // patched console.debug forwards to the mocked invoke. Leaving them patched would make every
    // later test that happens to console.* silently trip this mock — order-dependent by construction.
    const realConsole = {} as Record<ConsoleMethod, typeof console.log>;
    for (const k of CONSOLE_METHODS) realConsole[k] = console[k];
    // (initLogger's own `installed` guard stays flipped for the process, so restoring here is
    // final — a second initLogger() in this file would no-op rather than re-patch.)
    const restore = () => {
      for (const k of CONSOLE_METHODS) console[k] = realConsole[k];
      (globalThis as unknown as { window?: unknown }).window = realWin;
      setDebugForwarding(false);
    };

    try {
      (globalThis as unknown as { window: unknown }).window = {
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      const { initLogger } = await import("./logger");
      initLogger();

      setDebugForwarding(false);
      invoke.mockClear();
      console.debug("hot path debug line", { a: 1 });
      expect(invoke).not.toHaveBeenCalled();

      setDebugForwarding(true);
      invoke.mockClear();
      console.debug("hot path debug line", { a: 1 });
      expect(invoke).toHaveBeenCalledTimes(1);
    } finally {
      // finally, not a trailing statement: an assertion failure above must not leak the patch either.
      restore();
    }

    // The global console is genuinely handed back — with forwarding ON (the state that would expose a
    // still-patched method), a console.debug must reach nothing.
    setDebugForwarding(true);
    invoke.mockClear();
    console.debug("after restore", { a: 1 });
    expect(invoke).not.toHaveBeenCalled();
    setDebugForwarding(false);
    for (const k of CONSOLE_METHODS) expect(console[k]).toBe(realConsole[k]);
  });
});
