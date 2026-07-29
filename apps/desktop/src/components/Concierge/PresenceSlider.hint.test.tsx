// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PresenceSlider } from "./PresenceSlider";
import { usePresenceStore } from "../../stores/presenceStore";
import { CHROME_HINTS, HINT_JUMP_ATTR } from "../../keyboardHints/hintTargets";

// The keyboard hint for presence. One key that TOGGLES, riding the AWAY segment because badges
// anchor to their element's left edge and Away's left edge is the Here|Away seam — see the
// component. That makes Away's onClick mean two different things, which is what this file pins.

beforeEach(() => {
  usePresenceStore.getState().setHere();
});

afterEach(cleanup);

/** Activate an element the way HintOverlay does: marked as a hint JUMP for the duration of the
 *  click, which is the signal the handler branches on. */
function hintJump(el: HTMLElement) {
  el.setAttribute(HINT_JUMP_ATTR, "");
  try {
    fireEvent.click(el);
  } finally {
    el.removeAttribute(HINT_JUMP_ATTR);
  }
}

const away = () => screen.getByRole("button", { name: /^Away/ });
const here = () => screen.getByRole("button", { name: /^Here/ });

describe("PresenceSlider — the keyboard hint", () => {
  it("tags the Away segment, and only the Away segment", () => {
    render(<PresenceSlider />);
    expect(away().dataset.hint).toBe("presence");
    // Not the Here segment and not the pin: a second tag in the same control would take a letter
    // away from the pool for a badge nobody asked for, and the two would sit on top of each other.
    expect(here().dataset.hint).toBeUndefined();
    expect(screen.getByTestId("presence-pin").dataset.hint).toBeUndefined();
    expect(screen.getByTestId("presence-slider").dataset.hint).toBeUndefined();
  });

  it("is reachable at the character the founder approved", () => {
    expect(CHROME_HINTS.presence).toBe("h");
  });

  it("toggles Here → Away on a hint jump", () => {
    render(<PresenceSlider />);
    expect(usePresenceStore.getState().mode).toBe("here");
    hintJump(away());
    expect(usePresenceStore.getState().mode).toBe("away");
  });

  // THE HALF A ONE-WAY "set Away" HINT WOULD MISS. Pressing the key a second time has to come back.
  it("toggles Away → Here on a hint jump, pinning Here exactly as the segment click does", () => {
    render(<PresenceSlider />);
    usePresenceStore.getState().setAway();
    hintJump(away());
    expect(usePresenceStore.getState().mode).toBe("here");
    // setHere is what the Here SEGMENT calls, and it pins. The hint inherits that rather than
    // reimplementing the flip, so the two paths can't drift into subtly different controls.
    expect(usePresenceStore.getState().pinnedHere).toBe(true);
  });

  it("still means Away — never a toggle — on a real click", () => {
    render(<PresenceSlider />);
    usePresenceStore.getState().setAway();
    fireEvent.click(away());
    expect(usePresenceStore.getState().mode).toBe("away");
  });

  it("leaves the Here segment alone: a hint jump on it is still just Here", () => {
    render(<PresenceSlider />);
    usePresenceStore.getState().setAway();
    hintJump(here());
    expect(usePresenceStore.getState().mode).toBe("here");
  });
});
