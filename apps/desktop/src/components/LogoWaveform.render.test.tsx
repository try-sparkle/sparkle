// @vitest-environment jsdom
//
// Honest-listening render gating. The pure helpers (captionFor/barFraction) are covered in
// logoWaveform.test.ts; this exercises the regression-prone render branch that the helpers
// can't reach: the caption must switch on ACTUAL capture (`status === "listening"`), not on
// the armed `enabled` flag, so an armed-but-focus-paused mic never claims to be hearing you.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LogoWaveform } from "./LogoWaveform";
import { useDictationStore } from "../stores/dictationStore";
import { C, DANGER } from "../theme/colors";

// jsdom has no rAF by the time the effect runs in some setups; stub a no-op so the live
// loop can schedule without throwing. We assert on the rendered caption, not animation frames.
beforeEach(() => {
  globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  useDictationStore.setState({
    level: 0,
    phase: "passive",
    enabled: true,
    status: "idle",
    error: null,
    modelProgress: null,
  });
});
afterEach(() => cleanup());

describe("LogoWaveform — honest listening", () => {
  // The waveform strip button shares the "Activate Sparkle voice" aria-label, and the live
  // caption now splits across TWO lines / many nodes ("Listening for the wake word" +
  // "Just say" / <span>Hey Sparkle</span> / "to talk to me"). Match the BUTTON whose text carries
  // both the status line and the wake phrase — a stable signal that can't be fooled by the bare
  // word "Sparkle" turning up elsewhere (an aria-label or title).
  const wakeHintButton = () =>
    screen.queryByText((_content, el) => {
      if (el?.tagName !== "BUTTON") return false;
      const t = el.textContent?.replace(/\s+/g, " ").trim() ?? "";
      return /Listening for the wake word/.test(t) && /Hey Sparkle/.test(t);
    });

  it("armed + actually listening → shows the live wake hint, not 'Mic paused'", () => {
    useDictationStore.setState({ enabled: true, status: "listening", phase: "passive" });
    render(<LogoWaveform />);
    expect(wakeHintButton()).not.toBeNull();
    expect(screen.queryByText(/Listening paused/)).toBeNull();
  });

  it("armed but paused (not listening) → 'Listening paused' hint, not the wake hint", () => {
    useDictationStore.setState({ enabled: true, status: "idle", phase: "passive" });
    render(<LogoWaveform />);
    expect(
      screen.getByText(
        "Listening paused: Will auto-resume when you re-focus on this project.",
      ),
    ).toBeTruthy();
    // The wake-hint caption must NOT render when paused.
    expect(wakeHintButton()).toBeNull();
  });

  it("active + listening → 'Actively listening' status with the Sparkle, stop command", () => {
    useDictationStore.setState({ enabled: true, status: "listening", phase: "active" });
    render(<LogoWaveform />);
    const activeCaption = screen.queryByText((_c, el) => {
      if (el?.tagName !== "BUTTON") return false;
      const t = el.textContent?.replace(/\s+/g, " ").trim() ?? "";
      return /Actively listening/.test(t) && /Sparkle, stop/.test(t);
    });
    expect(activeCaption).not.toBeNull();
    // The passive wake hint must NOT show while actively dictating.
    expect(wakeHintButton()).toBeNull();
  });

  it("mic hover cue is direction-aware: RED to mute when enabled, TEAL to turn on when muted", () => {
    // Probe jsdom's normalized form of each hex so the assertions are format-agnostic.
    const probe = document.createElement("span");
    probe.style.color = DANGER;
    const RED = probe.style.color;
    probe.style.color = C.teal;
    const TEAL = probe.style.color;

    // Enabled (armed + capturing): rests on a non-red brand tint, turns RED on hover
    // (telegraphing the destructive "click to mute"). Also swaps to the slashed glyph.
    useDictationStore.setState({ enabled: true, status: "listening", phase: "passive" });
    render(<LogoWaveform />);
    const micOn = screen.getByRole("button", { name: "Mute microphone" });
    expect(micOn.style.color).not.toBe(RED);
    fireEvent.mouseEnter(micOn);
    expect(micOn.style.color).toBe(RED);
    cleanup();

    // Muted: rests gray, turns TEAL (not red) on hover — the constructive "click to turn on" cue.
    useDictationStore.setState({ enabled: false, status: "idle" });
    render(<LogoWaveform />);
    const micOff = screen.getByRole("button", { name: "Unmute microphone" });
    const mutedRest = micOff.style.color;
    expect(mutedRest).not.toBe(TEAL); // rests gray, proving the teal is hover-driven
    fireEvent.mouseEnter(micOff);
    expect(micOff.style.color).toBe(TEAL);
    expect(micOff.style.color).not.toBe(RED);
  });

  it("muted → no caption at all, mic offers to unmute", () => {
    useDictationStore.setState({ enabled: false, status: "idle" });
    render(<LogoWaveform />);
    expect(screen.queryByText(/Listening paused/)).toBeNull();
    expect(wakeHintButton()).toBeNull();
    expect(screen.getByRole("button", { name: "Unmute microphone" })).toBeTruthy();
  });
});
