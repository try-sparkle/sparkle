import { describe, expect, it } from "vitest";
import { shouldForwardConsole } from "./logger";

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
});
