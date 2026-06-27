// @vitest-environment jsdom
//
// Honest-listening render gating. The pure helpers (captionFor/barFraction) are covered in
// logoWaveform.test.ts; this exercises the regression-prone render branch that the helpers
// can't reach: the caption must switch on ACTUAL capture (`status === "listening"`), not on
// the armed `enabled` flag, so an armed-but-focus-paused mic never claims to be hearing you.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LogoWaveform } from "./LogoWaveform";
import { useDictationStore } from "../stores/dictationStore";

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
  // caption splits its text across nodes ("Just say" / <span>Hey Sparkle</span> / "to talk to me").
  // So we match the FULL caption phrase on the button's textContent — a stable signal that
  // can't be fooled by the bare word "Sparkle" turning up elsewhere (an aria-label or title).
  const wakeHintButton = () =>
    screen.queryByText(
      (_content, el) =>
        el?.tagName === "BUTTON" &&
        el.textContent?.replace(/\s+/g, " ").trim() ===
          "Listening for wake word: Just say Hey Sparkle to talk to me",
    );

  it("armed + actually listening → shows the live wake hint, not 'Mic paused'", () => {
    useDictationStore.setState({ enabled: true, status: "listening", phase: "passive" });
    render(<LogoWaveform />);
    expect(wakeHintButton()).not.toBeNull();
    expect(screen.queryByText("Mic paused")).toBeNull();
  });

  it("armed but paused (not listening) → 'Mic paused', not the wake hint", () => {
    useDictationStore.setState({ enabled: true, status: "idle", phase: "passive" });
    render(<LogoWaveform />);
    expect(screen.getByText("Mic paused")).toBeTruthy();
    // The wake-hint caption must NOT render when paused.
    expect(wakeHintButton()).toBeNull();
  });

  it("muted → no caption at all, mic offers to unmute", () => {
    useDictationStore.setState({ enabled: false, status: "idle" });
    render(<LogoWaveform />);
    expect(screen.queryByText("Mic paused")).toBeNull();
    expect(wakeHintButton()).toBeNull();
    expect(screen.getByRole("button", { name: "Unmute microphone" })).toBeTruthy();
  });
});
