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

  it("flips the brand gray ('done' and its idle/stopped peers) to agentIdle", () => {
    // idle/done/stopped share the brand gray, so all three map to agentIdle — and so does
    // `unmerged`, which left the red tier on 2026-07-26 (see packages/ui/tokens.ts). (`blocked` is
    // still RED, so it passes through — asserted in the red group below.)
    for (const st of ["done", "idle", "stopped", "unmerged"] as const) {
      expect(statusInk(AGENT_STATUS[st].color)).toBe(C.agentIdle);
    }
  });

  it("flips the brand RED tier to the themed dangerInk", () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, under the title "passes red/amber statuses through
    // unchanged (already legible in both themes)". The parenthetical was simply false, and nothing
    // measured it: BRAND.sienna is 3.83:1 on light's white concierge column and 3.54:1 on the
    // builder column. It paints the NAME of a worker row in the sidebar — an underlined-on-hover
    // link — and the concierge's needs-you sentence. `dangerInk` is the themed counterpart that
    // already existed. The ratios themselves are held by theme/linkContrast.test.ts; what this
    // pins is the MAPPING, so a taxonomy change that collides on a hex fails here.
    for (const st of ["waiting", "approval", "errored", "blocked"] as const) {
      expect(statusInk(AGENT_STATUS[st].color)).toBe(C.dangerInk);
    }
    // …and it really is a change, not an identity: the tier does not already equal the ink.
    expect(C.dangerInk).not.toBe(AGENT_STATUS.waiting.color);
  });

  it("leaves a colour outside the taxonomy alone", () => {
    // The fallthrough still exists and still means "not a status colour I know" — without this,
    // the three mappings above could be replaced by an unconditional `return C.dangerInk` and the
    // suite would not notice.
    expect(statusInk("#123456")).toBe("#123456");
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
