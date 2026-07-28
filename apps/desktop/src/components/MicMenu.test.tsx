// @vitest-environment jsdom
//
// The mic hover pill (MicMenu): hovering either mic (the composer-left mic or the top waveform
// ring) reveals a vertical pill with three EXPLICIT choices — listening (green) / muted (orange) /
// off (red) — and clicking one drives the dictation store straight to that state (no cycling). This
// pins the option set, the click→state mapping, the current-selection indicator, and the green
// active tint (matching the left-column "working" green).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MicMenu, micVisual } from "./MicButton";
import { C, DANGER } from "../theme/colors";
import { useDictationStore } from "../stores/dictationStore";
import { useAuthStore } from "../stores/authStore";

beforeEach(() => {
  useDictationStore.setState({ enabled: true, status: "listening", phase: "passive" });
  // Arming the mic now requires credits (see MicButton.shouldBlockMicArm). Seed a credited user so
  // the explicit setActive/setMuted picks actually arm; the out-of-credits path is covered separately.
  useAuthStore.setState({ me: { clerkUserId: "u1", entitled: true, balanceCents: 500, tokenVersion: 1 } });
});
afterEach(() => cleanup());

describe("micVisual — active is the left-column green (not blue)", () => {
  it("draws the active mic in successInk (the working-status green)", () => {
    expect(micVisual("active", false)).toEqual({ color: C.successInk, variant: "open" });
  });
  it("still draws off (gray slash) and paused (amber pause) unchanged", () => {
    expect(micVisual("off", false)).toEqual({ color: C.muted, variant: "slash" });
    expect(micVisual("paused", false)).toEqual({ color: C.amber, variant: "pause" });
  });
});

describe("MicMenu — the three-option hover pill", () => {
  it("renders exactly three options: listening, muted, off", () => {
    render(<MicMenu surface="concierge" />);
    expect(screen.getByRole("menuitemradio", { name: "Set microphone to listening" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Set microphone to muted" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Set microphone to off" })).toBeTruthy();
  });

  it("marks the current intent as checked (muted when enabled + passive)", () => {
    useDictationStore.setState({ enabled: true, status: "listening", phase: "passive" });
    render(<MicMenu surface="concierge" />);
    expect(
      screen.getByRole("menuitemradio", { name: "Set microphone to muted" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("menuitemradio", { name: "Set microphone to off" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("marks OFF as checked when the mic is disabled", () => {
    useDictationStore.setState({ enabled: false, status: "idle", phase: "passive" });
    render(<MicMenu surface="concierge" />);
    expect(
      screen.getByRole("menuitemradio", { name: "Set microphone to off" }).getAttribute("aria-checked"),
    ).toBe("true");
  });
});

describe("MicMenu — clicking an option drives the store straight to that state", () => {
  it("LISTENING → enabled + phase active", () => {
    useDictationStore.setState({ enabled: false, status: "idle", phase: "passive" });
    render(<MicMenu surface="concierge" />);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Set microphone to listening" }));
    expect(useDictationStore.getState().enabled).toBe(true);
    expect(useDictationStore.getState().phase).toBe("active");
  });

  it("MUTED → enabled + phase passive", () => {
    useDictationStore.setState({ enabled: false, status: "idle", phase: "active" });
    render(<MicMenu surface="concierge" />);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Set microphone to muted" }));
    expect(useDictationStore.getState().enabled).toBe(true);
    expect(useDictationStore.getState().phase).toBe("passive");
  });

  it("OFF → disabled", () => {
    useDictationStore.setState({ enabled: true, status: "listening", phase: "active" });
    render(<MicMenu surface="concierge" />);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Set microphone to off" }));
    expect(useDictationStore.getState().enabled).toBe(false);
  });

  it("fires onChoose after a pick (so the parent can dismiss the pill)", () => {
    let chosen = 0;
    render(<MicMenu surface="concierge" onChoose={() => { chosen += 1; }} />);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Set microphone to off" }));
    expect(chosen).toBe(1);
  });

  it("LISTENING while OUT OF CREDITS is refused: mic stays off, notice shown", () => {
    useAuthStore.setState({ me: null }); // no credits
    useDictationStore.setState({ enabled: false, status: "idle", phase: "passive", outOfCreditsNotice: false });
    render(<MicMenu surface="concierge" />);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Set microphone to listening" }));
    // The arm was refused — the mic never enabled — and the shared notice is now up.
    expect(useDictationStore.getState().enabled).toBe(false);
    expect(useDictationStore.getState().outOfCreditsNotice).toBe(true);
    useDictationStore.getState().clearOutOfCreditsNotice(); // tidy the pending 5s timer
  });

  it("MUTED while OUT OF CREDITS is refused: mic stays off, notice shown", () => {
    useAuthStore.setState({ me: { clerkUserId: "u", entitled: true, balanceCents: 0, tokenVersion: 1 } });
    useDictationStore.setState({ enabled: false, status: "idle", phase: "active", outOfCreditsNotice: false });
    render(<MicMenu surface="concierge" />);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Set microphone to muted" }));
    expect(useDictationStore.getState().enabled).toBe(false);
    expect(useDictationStore.getState().outOfCreditsNotice).toBe(true);
    useDictationStore.getState().clearOutOfCreditsNotice();
  });
});

describe("MicMenu — a pick names the surface that owns the transcript", () => {
  // A pick here is one of the ways the mic goes live, so it has to arbitrate ownership exactly as
  // a click on the mic glyph does. Getting this wrong doesn't throw — it just quietly sends the
  // user's words to a box in another column (dictationStore.voiceSurface).
  it("records the pill's own surface BEFORE the pick takes effect", () => {
    useDictationStore.setState({ enabled: false, phase: "passive", voiceSurface: "agent" });
    render(<MicMenu surface="concierge" />);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Set microphone to listening" }));
    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
    expect(useDictationStore.getState().phase).toBe("active");
  });

  it("an agent composer's pill claims the other way", () => {
    useDictationStore.setState({ enabled: false, phase: "passive", voiceSurface: "concierge" });
    render(<MicMenu surface="agent" />);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Set microphone to listening" }));
    expect(useDictationStore.getState().voiceSurface).toBe("agent");
  });

  it("records the surface even when the pick is REFUSED for credits", () => {
    // Harmless but deliberate: the refusal leaves the mic off, so nothing is routing and no box can
    // claim anything. Pinned so nobody "fixes" it by moving the call after the arm, which would
    // leave the live-and-unowned window the ordering above exists to close.
    useAuthStore.setState({ me: null });
    useDictationStore.setState({ enabled: false, phase: "passive", voiceSurface: "agent", outOfCreditsNotice: false });
    render(<MicMenu surface="concierge" />);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Set microphone to listening" }));
    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
    expect(useDictationStore.getState().enabled).toBe(false);
    useDictationStore.getState().clearOutOfCreditsNotice();
  });
});

// Keep DANGER referenced so the off-option color contract is documented alongside the test even
// though micVisual owns the resting off color; the pill paints the off glyph in DANGER red.
void DANGER;
