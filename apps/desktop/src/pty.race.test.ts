import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { writePty, resizePty } from "./pty";

beforeEach(() => {
  invoke.mockReset();
});

// A PTY can exit (and have its session reaped on the Rust side) a beat before a stray
// keystroke or a ResizeObserver-driven resize reaches it. The backing command then returns
// Err("no such pty"). That's an expected teardown race, not a real failure — these wrappers
// swallow it so it never surfaces as an app-level "unhandled rejection" ERROR in the log.
describe("writePty / resizePty exited-session race", () => {
  it("writePty swallows a 'no such pty' rejection", async () => {
    invoke.mockRejectedValue("no such pty");
    await expect(writePty("dead", "y\n")).resolves.toBeUndefined();
  });

  it("resizePty swallows a 'no such pty' rejection", async () => {
    invoke.mockRejectedValue("no such pty");
    await expect(resizePty("dead", 80, 24)).resolves.toBeUndefined();
  });

  it("writePty still propagates any other error", async () => {
    invoke.mockRejectedValue("disk full");
    await expect(writePty("a1", "y\n")).rejects.toBe("disk full");
  });

  it("resizePty still propagates any other error", async () => {
    invoke.mockRejectedValue(new Error("boom"));
    await expect(resizePty("a1", 80, 24)).rejects.toThrow("boom");
  });

  it("writePty resolves normally on success and forwards args", async () => {
    invoke.mockResolvedValue(undefined);
    await expect(writePty("a1", "hi")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("pty_write", { id: "a1", data: "hi" });
  });
});
