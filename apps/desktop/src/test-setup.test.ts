// The setup file's own contract. Every store test leans on `localStorage` being WRITABLE — our
// zustand stores persist through it — and that guarantee silently evaporated on Node 25, which
// defines a method-less `localStorage` global that the old `typeof … === "undefined"` guard
// mistook for the real thing. These tests fail on that regression instead of letting it surface
// as `storage.setItem is not a function` from deep inside unrelated suites.
import { describe, expect, it } from "vitest";

describe("test-setup localStorage shim", () => {
  it("exposes the Storage methods the persist middleware calls", () => {
    for (const method of ["getItem", "setItem", "removeItem", "clear", "key"] as const) {
      expect(typeof localStorage[method]).toBe("function");
    }
  });

  it("round-trips a value rather than swallowing the write", () => {
    localStorage.setItem("sparkle:test-setup-probe", "kept");
    expect(localStorage.getItem("sparkle:test-setup-probe")).toBe("kept");

    localStorage.removeItem("sparkle:test-setup-probe");
    expect(localStorage.getItem("sparkle:test-setup-probe")).toBeNull();
  });

  it("supports prefix enumeration, which cold-start key sweeps depend on", () => {
    localStorage.setItem("sparkle:enum-probe", "1");
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));

    expect(keys).toContain("sparkle:enum-probe");
    localStorage.removeItem("sparkle:enum-probe");
  });
});
