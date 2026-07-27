import { describe, it, expect } from "vitest";
import {
  TERMINAL_OVERLAY_GAP,
  TERMINAL_STAGE_PADDING,
  terminalSuggestionAnchorStyle,
} from "./terminalStageAnchor";
import { SUGGESTION_PILL_HEIGHT } from "./composer/SuggestionRow";

describe("terminalSuggestionAnchorStyle", () => {
  const style = terminalSuggestionAnchorStyle(SUGGESTION_PILL_HEIGHT);

  // The rail MUST be zero-height. SuggestionRow's overlay layout centres itself on its positioned
  // ancestor (`top: 50%; translateY(-50%)`); against a full-height ancestor that parks the pill in
  // the middle of the terminal instead of on the CLI's input line. A regression here is invisible
  // in a jsdom render — nothing throws, the pill just ends up in the wrong place — so it is pinned.
  it("is a zero-height rail, so the row's own centring lands the pill on it", () => {
    expect(style.height).toBe(0);
    expect(style.position).toBe("absolute");
  });

  // Bottom-right: the pill's bottom EDGE sits one padding + one gap above the stage floor, which
  // means the rail (the pill's CENTRE line) sits half a pill higher.
  it("places the pill's bottom edge a padding + gap above the stage floor", () => {
    expect(style.bottom).toBe(TERMINAL_STAGE_PADDING + TERMINAL_OVERLAY_GAP + SUGGESTION_PILL_HEIGHT / 2);
    const bottomEdge = (style.bottom as number) - SUGGESTION_PILL_HEIGHT / 2;
    expect(bottomEdge).toBe(TERMINAL_STAGE_PADDING + TERMINAL_OVERLAY_GAP);
  });

  it("insets the right edge by the stage padding, leaving the row's own 8px offset on top", () => {
    expect(style.right).toBe(TERMINAL_STAGE_PADDING);
    expect(style.left).toBe(0);
  });

  // The rail spans the full width of the stage. If it swallowed pointer events the user could not
  // select text or click the TUI anywhere along that line.
  it("never intercepts pointer events meant for the terminal", () => {
    expect(style.pointerEvents).toBe("none");
  });

  // Above the terminal canvas and the Terminal component's own overlays (which top out at 10)…
  it("sits above the terminal canvas and its overlays", () => {
    expect(style.zIndex as number).toBeGreaterThan(10);
  });

  // …and BELOW the AccountBadge's layer (20). The badge's open menu lays a full-screen click-away
  // backdrop inside its own z-20 box; at an equal z-index the tie breaks on DOM order, and this
  // rail is a portal child that commonly lands last — so the pill would paint over the backdrop
  // with pointer events live and a click would dispatch the action (immediately, no confirm)
  // instead of dismissing the menu. Pinned so the two layers can't silently re-converge.
  it("stays under the AccountBadge's layer, so its click-away backdrop still covers the pill", () => {
    expect(style.zIndex as number).toBeLessThan(20);
  });
});
