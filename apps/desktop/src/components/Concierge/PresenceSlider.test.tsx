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
  usePresenceStore.getState().reset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const here = () => screen.getByRole("button", { name: /^Here —/ });
const away = () => screen.getByRole("button", { name: /^Away —/ });

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

  it("follows a blur, and comes back on refocus when Here is pinned", () => {
    render(<PresenceSlider />);
    fireEvent.click(here());
    act(() => usePresenceStore.getState().setFocused(false));
    expect(away().getAttribute("aria-pressed")).toBe("true");
    act(() => usePresenceStore.getState().setFocused(true));
    expect(here().getAttribute("aria-pressed")).toBe("true");
  });
});

describe("presenceTitle — names the CAUSE, not just the state", () => {
  it("distinguishes a pinned Here from an ordinary one", () => {
    expect(presenceTitle("here", true)).toContain("pinned");
    expect(presenceTitle("here", false)).not.toContain("pinned");
  });

  it("an Away that still holds a pin says the pin comes back", () => {
    expect(presenceTitle("away", true)).toContain("comes back");
    expect(presenceTitle("away", false)).toContain("may act on its own");
  });
});

describe("ComposeBox integration", () => {
  it("renders the slider above Send", () => {
    render(<ComposeBox onSend={vi.fn()} onMicToggle={vi.fn()} onAttach={vi.fn()} />);
    const slider = screen.getByTestId("presence-slider");
    const send = screen.getByRole("button", { name: "Send" });
    // Document order is the accessible reading order, and it is what "above" means in a column
    // layout: the slider sits in the attach row, which precedes the compose row Send lives in.
    expect(slider.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("typing in the box resets the idle timer", () => {
    render(<ComposeBox onSend={vi.fn()} onMicToggle={vi.fn()} onAttach={vi.fn()} />);
    vi.advanceTimersByTime(IDLE_AWAY_MS - 1000);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "still here" },
    });
    vi.advanceTimersByTime(2000); // past the ORIGINAL deadline, short of the new one
    usePresenceStore.getState().evaluate();
    expect(usePresenceStore.getState().mode).toBe("here");
  });
});
