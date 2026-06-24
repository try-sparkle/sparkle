import { describe, it, expect } from "vitest";
import { shouldRouteToComposer, type TermKeyEvent } from "./terminalInput";

const key = (over: Partial<TermKeyEvent>): TermKeyEvent => ({
  type: "keydown",
  key: "a",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...over,
});

describe("shouldRouteToComposer", () => {
  it("routes a bare printable char in the normal buffer", () => {
    expect(shouldRouteToComposer(key({ key: "a" }), "normal")).toBe(true);
    expect(shouldRouteToComposer(key({ key: "Y" }), "normal")).toBe(true);
    expect(shouldRouteToComposer(key({ key: " " }), "normal")).toBe(true);
    expect(shouldRouteToComposer(key({ key: "1" }), "normal")).toBe(true);
  });

  it("does NOT route in the alternate screen (TUIs keep raw input)", () => {
    expect(shouldRouteToComposer(key({ key: "y" }), "alternate")).toBe(false);
    expect(shouldRouteToComposer(key({ key: "2" }), "alternate")).toBe(false);
  });

  it("never routes modifier combos (copy/paste/shortcuts)", () => {
    expect(shouldRouteToComposer(key({ key: "c", metaKey: true }), "normal")).toBe(false);
    expect(shouldRouteToComposer(key({ key: "v", ctrlKey: true }), "normal")).toBe(false);
    expect(shouldRouteToComposer(key({ key: "a", altKey: true }), "normal")).toBe(false);
  });

  it("never routes non-printable keys (arrows/Enter/Tab/Esc)", () => {
    for (const k of ["ArrowDown", "Enter", "Tab", "Escape", "Backspace"]) {
      expect(shouldRouteToComposer(key({ key: k }), "normal")).toBe(false);
    }
  });

  it("ignores non-keydown events", () => {
    expect(shouldRouteToComposer(key({ type: "keyup", key: "a" }), "normal")).toBe(false);
  });
});
