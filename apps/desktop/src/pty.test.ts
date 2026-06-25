import { afterEach, describe, expect, it, vi } from "vitest";
import { ignorePtyGone } from "./pty";

// ignorePtyGone guards the fire-and-forget writePty/resizePty/killPty calls in
// Terminal.tsx: a late resize/input after an agent's PTY exits rejects with
// "no such pty" (pty.rs), which is a benign race — but any OTHER failure should
// still be surfaced rather than silently dropped.
describe("ignorePtyGone", () => {
  afterEach(() => vi.restoreAllMocks());

  it("swallows the benign 'no such pty' race (string reject)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    ignorePtyGone("no such pty");
    expect(spy).not.toHaveBeenCalled();
  });

  it("swallows 'no such pty' wrapped in an Error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    ignorePtyGone(new Error("no such pty"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("swallows a non-Error object payload carrying the message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    ignorePtyGone({ message: "no such pty" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("logs unexpected errors instead of dropping them", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    ignorePtyGone(new Error("permission denied"));
    expect(spy).toHaveBeenCalledOnce();
  });

  it("does not throw on null/undefined input", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => ignorePtyGone(undefined)).not.toThrow();
    expect(() => ignorePtyGone(null)).not.toThrow();
    // Both are unexpected (no "no such pty"), so they surface rather than drop.
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
