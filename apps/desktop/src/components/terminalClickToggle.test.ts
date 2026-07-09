import { describe, it, expect } from "vitest";
import { shouldToggleComposerOnClick, CLICK_MOVE_TOLERANCE_PX } from "./terminalClickToggle";

const P = (x: number, y: number) => ({ x, y });

describe("shouldToggleComposerOnClick", () => {
  it("toggles on a stationary left-click with no selection and no mouse tracking", () => {
    expect(shouldToggleComposerOnClick(0, P(100, 100), P(100, 100), false, false)).toBe(true);
  });

  it("tolerates a few pixels of click jitter", () => {
    const d = CLICK_MOVE_TOLERANCE_PX;
    expect(shouldToggleComposerOnClick(0, P(100, 100), P(100 + d, 100 - d), false, false)).toBe(
      true,
    );
  });

  it("does NOT toggle on a drag (moved past the tolerance)", () => {
    expect(
      shouldToggleComposerOnClick(
        0,
        P(100, 100),
        P(100 + CLICK_MOVE_TOLERANCE_PX + 1, 100),
        false,
        false,
      ),
    ).toBe(false);
    expect(
      shouldToggleComposerOnClick(
        0,
        P(100, 100),
        P(100, 100 + CLICK_MOVE_TOLERANCE_PX + 1),
        false,
        false,
      ),
    ).toBe(false);
  });

  it("does NOT toggle when the gesture produced a selection (select-to-copy wins)", () => {
    // Even a stationary end-point shouldn't toggle if xterm reports a live selection.
    expect(shouldToggleComposerOnClick(0, P(100, 100), P(100, 100), true, false)).toBe(false);
  });

  it("does NOT toggle while a TUI is tracking the mouse (the click belongs to the app)", () => {
    expect(shouldToggleComposerOnClick(0, P(100, 100), P(100, 100), false, true)).toBe(false);
  });

  it("ignores non-primary buttons (right/middle click)", () => {
    expect(shouldToggleComposerOnClick(2, P(100, 100), P(100, 100), false, false)).toBe(false);
    expect(shouldToggleComposerOnClick(1, P(100, 100), P(100, 100), false, false)).toBe(false);
  });
});
