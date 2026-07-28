// @vitest-environment jsdom
//
// The slider's contract: it REPORTS the current mode (including one it never set — the idle timer
// and blur both move it under the user) and it SETS the mode on click, pinning Here.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresenceSlider, presenceTitle } from "./PresenceSlider";
import { IDLE_AWAY_MS, usePresenceStore } from "../../stores/presenceStore";
import { ComposeBox } from "./ComposeBox";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
  // The pin is persisted now (presenceStore.PRESENCE_PIN_STORAGE_KEY) and `reset()` deliberately
  // leaves storage alone, so a leftover key would leak a pin between cases.
  localStorage.clear();
  usePresenceStore.getState().reset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const here = () => screen.getByRole("button", { name: /^Here —/ });
const away = () => screen.getByRole("button", { name: /^Away —/ });
const pin = () => screen.getByRole("button", { name: /^Pin Here/ });

/** A real double-click, in the order a browser sends it: the two clicks land FIRST, then dblclick.
 *  `fireEvent.dblClick` alone skips the clicks, which would hide the exact interaction the
 *  component has to survive — the segment's own onClick running before the gesture is recognized. */
function dblClick(el: Element) {
  fireEvent.mouseDown(el, { detail: 1 });
  fireEvent.click(el, { detail: 1 });
  fireEvent.mouseDown(el, { detail: 2 });
  fireEvent.click(el, { detail: 2 });
  fireEvent.dblClick(el, { detail: 2 });
}

describe("PresenceSlider", () => {
  it("shows Here pressed at rest", () => {
    render(<PresenceSlider />);
    expect(here().getAttribute("aria-pressed")).toBe("true");
    expect(away().getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking Away sets Away; clicking Here sets Here AND pins it", () => {
    render(<PresenceSlider />);
    fireEvent.click(away());
    expect(usePresenceStore.getState().mode).toBe("away");
    expect(away().getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(here());
    expect(usePresenceStore.getState().mode).toBe("here");
    // The pin is the point: a manual Here must outlast the idle timer.
    expect(usePresenceStore.getState().pinnedHere).toBe(true);
  });

  it("follows a mode the user did NOT set — the idle timer moving it", () => {
    render(<PresenceSlider />);
    vi.advanceTimersByTime(IDLE_AWAY_MS);
    act(() => usePresenceStore.getState().evaluate());
    expect(away().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("presence-slider").getAttribute("data-mode")).toBe("away");
  });

  it("paints the active Away label in themed ink, with the brand amber left as the fill", () => {
    // The one control that tells the user autonomy is unblocked has to be readable in BOTH themes,
    // and brand amber as 11px TEXT is ~1.9:1 on the light composer bar (roborev 53631-M4). The
    // ink/fill split is the fix: themed `amberInk` for the label, constant brand amber for the
    // 16% tint behind it. Contrast arithmetic lives in theme/amberInk.test.ts.
    render(<PresenceSlider />);
    fireEvent.click(away());
    expect(away().style.color).toBe("var(--c-amber-ink)");
    // jsdom normalises the hex inside color-mix() to rgb() — #e0982f is the brand amber constant.
    expect(away().style.background).toContain("rgb(224, 152, 47)");
  });

  it("follows a blur when nothing is pinned", () => {
    render(<PresenceSlider />);
    act(() => usePresenceStore.getState().setFocused(false));
    expect(away().getAttribute("aria-pressed")).toBe("true");
    act(() => usePresenceStore.getState().setFocused(true));
    expect(here().getAttribute("aria-pressed")).toBe("true");
  });

  it("a PINNED Here ignores the blur entirely (founder override)", () => {
    render(<PresenceSlider />);
    fireEvent.click(here());
    act(() => usePresenceStore.getState().setFocused(false));
    expect(here().getAttribute("aria-pressed")).toBe("true");
    act(() => usePresenceStore.getState().evaluate());
    expect(screen.getByTestId("presence-slider").getAttribute("data-mode")).toBe("here");
  });
});

// The pin survives blur, screen lock and overnight, so a user who cannot SEE that it is on has no
// way to explain why the app never went Away. The icon is the whole mitigation for that.
describe("the pin affordance", () => {
  it("shows the pin as pressed exactly when Here is pinned", () => {
    render(<PresenceSlider />);
    expect(pin().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(here());
    expect(pin().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("presence-slider").getAttribute("data-pinned")).toBe("true");
  });

  it("is a real button, so the pin is reachable without a double-click", () => {
    render(<PresenceSlider />);
    fireEvent.click(pin());
    expect(usePresenceStore.getState().pinnedHere).toBe(true);
    expect(usePresenceStore.getState().mode).toBe("here");
    fireEvent.click(pin());
    expect(usePresenceStore.getState().pinnedHere).toBe(false);
  });

  it("double-clicking the slider TOGGLES the pin", () => {
    render(<PresenceSlider />);
    dblClick(screen.getByTestId("presence-slider"));
    expect(usePresenceStore.getState().pinnedHere).toBe(true);
    dblClick(screen.getByTestId("presence-slider"));
    expect(usePresenceStore.getState().pinnedHere).toBe(false);
  });

  it("double-clicking the Here segment toggles it too — the clicks underneath don't invert it", () => {
    // The subtle one. Clicking Here ALSO pins (setHere), so a handler that toggled off the
    // post-click state would read "already pinned" and unpin — making a double-click on Here always
    // end up unpinned rather than toggling. The gesture is resolved against the state BEFORE it.
    render(<PresenceSlider />);
    dblClick(here());
    expect(usePresenceStore.getState().pinnedHere).toBe(true);
    dblClick(here());
    expect(usePresenceStore.getState().pinnedHere).toBe(false);
  });

  it("a fast double-tap ON THE PIN means the same as two deliberate single taps: nothing", () => {
    // The pin button stops the gesture from reaching the group, so its own two clicks are the
    // whole interaction. Without that, the group's dblclick would ALSO fire — resolved against the
    // pre-gesture value — and a double-tap on the pin would end pinned while two slow taps on the
    // same button ended unpinned.
    render(<PresenceSlider />);
    dblClick(pin());
    expect(usePresenceStore.getState().pinnedHere, "two taps, back where it started").toBe(false);
    // …and the same from the other side: pinned, double-tapped, still pinned.
    fireEvent.click(pin());
    expect(usePresenceStore.getState().pinnedHere).toBe(true);
    dblClick(pin());
    expect(usePresenceStore.getState().pinnedHere).toBe(true);
  });

  it("a pin round-trip does not silently revoke an explicit Away (roborev 54146-M1)", () => {
    // The user says "I'm stepping out", then double-taps the pin — a gesture that visibly ends
    // where it began. Presence has to end where it began too. It used to come back Here with the
    // pin unlit, i.e. autonomy re-gated with nothing on screen explaining why.
    render(<PresenceSlider />);
    fireEvent.click(away());
    dblClick(pin());
    expect(usePresenceStore.getState().mode).toBe("away");
    expect(away().getAttribute("aria-pressed")).toBe("true");
    expect(pin().getAttribute("aria-pressed")).toBe("false");
  });

  it("is a real <button>, so Enter/Space reach it the same way a click does", () => {
    // Keyboard activation of a native button IS a click event — the assertion that matters is
    // that this is a real button (focusable, in the tab order, type=button so it can't submit)
    // rather than a div with an onClick, which is what would silently break it.
    render(<PresenceSlider />);
    const el = pin();
    expect(el.tagName).toBe("BUTTON");
    expect(el.getAttribute("type")).toBe("button");
    el.focus();
    expect(document.activeElement).toBe(el);
    fireEvent.click(el); // what the browser dispatches for Enter and Space on a focused button
    expect(usePresenceStore.getState().pinnedHere).toBe(true);
  });

  it("double-clicking Away does NOT pin — it just means Away, twice", () => {
    render(<PresenceSlider />);
    dblClick(away());
    expect(usePresenceStore.getState().mode).toBe("away");
    expect(usePresenceStore.getState().pinnedHere, "Away cannot pin Here").toBe(false);
  });
});

describe("presenceTitle — names the CAUSE, not just the state", () => {
  it("distinguishes a pinned Here from an ordinary one", () => {
    expect(presenceTitle("here", true)).toContain("pinned");
    expect(presenceTitle("here", false)).not.toContain("pinned");
  });

  it("says the pin outlasts a blur, rather than promising it comes back from one", () => {
    // Pre-override the pinned-Here tooltip explained that Away would revoke the pin until refocus.
    // It no longer can, so promising a return would describe a transition that never happens.
    expect(presenceTitle("here", true)).toContain("until you unpin");
    expect(presenceTitle("here", true)).not.toContain("comes back");
  });

  it("Away reads the same whatever the pin says, because Away un-pins", () => {
    // `setAway` clears the pin, so away+pinned is unreachable through the store; a tooltip that
    // described it would be describing nothing. Both spellings tell the user what Away MEANS.
    expect(presenceTitle("away", true)).toBe(presenceTitle("away", false));
    expect(presenceTitle("away", false)).toContain("may act on its own");
  });
});

describe("ComposeBox integration", () => {
  it("renders the slider above Send", () => {
    render(<ComposeBox onSend={vi.fn()} onAttach={vi.fn()} />);
    const slider = screen.getByTestId("presence-slider");
    const send = screen.getByRole("button", { name: "Send" });
    // Document order is the accessible reading order, and it is what "above" means in a column
    // layout: the slider sits in the attach row, which precedes the compose row Send lives in.
    expect(slider.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("typing in the box resets the idle timer", () => {
    render(<ComposeBox onSend={vi.fn()} onAttach={vi.fn()} />);
    vi.advanceTimersByTime(IDLE_AWAY_MS - 1000);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "still here" },
    });
    vi.advanceTimersByTime(2000); // past the ORIGINAL deadline, short of the new one
    usePresenceStore.getState().evaluate();
    expect(usePresenceStore.getState().mode).toBe("here");
  });
});
