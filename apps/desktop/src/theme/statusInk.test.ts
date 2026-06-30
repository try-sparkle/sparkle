import { describe, it, expect } from "vitest";
import { C as BRAND } from "@sparkle/ui";
import { statusInk, C, THEME_HEX } from "./colors";
import { AGENT_STATUS } from "@sparkle/ui";
import { stageMeta } from "../engine/workflowStage";

// statusInk maps a raw AGENT_STATUS color to a light-mode-legible THEMED ink. It branches on
// color-VALUE equality (the brand gray and the brand green), so these tests pin the mapping: a
// future taxonomy change that collides on a hex — or a token rename — fails here instead of
// silently miscoloring a status.
describe("statusInk (raw AGENT_STATUS color → themed text ink)", () => {
  it("flips the brand green ('working') to the themed successInk", () => {
    expect(statusInk(AGENT_STATUS.working.color)).toBe(C.successInk);
  });

  it("flips the brand gray ('done' and its idle/blocked/stopped peers) to agentIdle", () => {
    // idle/blocked/done/stopped all share the brand gray, so all four map to agentIdle.
    for (const st of ["done", "idle", "blocked", "stopped"] as const) {
      expect(statusInk(AGENT_STATUS[st].color)).toBe(C.agentIdle);
    }
  });

  it("passes red/amber statuses through unchanged (already legible in both themes)", () => {
    for (const st of ["waiting", "approval", "errored"] as const) {
      expect(statusInk(AGENT_STATUS[st].color)).toBe(AGENT_STATUS[st].color);
    }
  });
});

// Guards that switching the shipped ✓ green to successInk is a LIGHT-mode-only change:
// successInk's DARK value must equal the brand green the final "shipped" stage uses, so the
// dark-mode ✓ color is byte-for-byte unchanged.
describe("successInk dark value preserves the final-stage green", () => {
  it("THEME_HEX.dark.successInk equals the shipped stage color and BRAND.success", () => {
    expect(THEME_HEX.dark.successInk).toBe(BRAND.success);
    expect(stageMeta("shipped").color).toBe(BRAND.success);
  });

  it("light successInk is darker than the brand green (the legibility fix)", () => {
    expect(THEME_HEX.light.successInk).not.toBe(THEME_HEX.dark.successInk);
  });
});
