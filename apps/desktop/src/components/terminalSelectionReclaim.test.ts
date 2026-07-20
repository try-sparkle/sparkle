import { describe, it, expect } from "vitest";
import { shouldReclaimPlainDrag } from "./terminalSelectionReclaim";

describe("shouldReclaimPlainDrag", () => {
  it("reclaims a plain drag when the composer feature is on AND open", () => {
    expect(shouldReclaimPlainDrag(true, /* minimized */ false)).toBe(true);
  });

  it("does NOT reclaim when the composer is minimized (closed = TUI mode)", () => {
    expect(shouldReclaimPlainDrag(true, /* minimized */ true)).toBe(false);
  });

  it("does NOT reclaim when the composer feature is off", () => {
    expect(shouldReclaimPlainDrag(false, /* minimized */ false)).toBe(false);
    expect(shouldReclaimPlainDrag(false, /* minimized */ true)).toBe(false);
  });
});
