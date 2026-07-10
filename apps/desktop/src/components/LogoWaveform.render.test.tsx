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
import { useAuthStore } from "../stores/authStore";
import { useUiStore } from "../stores/uiStore";
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
    outOfCreditsNotice: false,
  });
  // Arming the mic now requires credits (MicButton.shouldBlockMicArm) and the sidebar force-offs an
  // armed mic when the balance is empty. Seed a credited user so the honest-listening cases behave
  // as before; the out-of-credits behavior is exercised in its own describe block below.
  useAuthStore.setState({ me: { clerkUserId: "u1", entitled: true, balanceCents: 500, tokenVersion: 1 } });
});
afterEach(() => cleanup());

describe("LogoWaveform — honest listening", () => {
  // The waveform strip button shares the "Activate Sparkle voice" aria-label, and the live
  // caption now splits across TWO lines / many nodes ("Mic paused." +
  // "Say" / <span>Hey Sparkle</span> / "to activate"). Match the BUTTON whose text carries
  // both the status line and the wake phrase — a stable signal that can't be fooled by the bare
  // word "Sparkle" turning up elsewhere (an aria-label or title).
  const wakeHintButton = () =>
    screen.queryByText((_content, el) => {
      if (el?.tagName !== "BUTTON") return false;
      const t = el.textContent?.replace(/\s+/g, " ").trim() ?? "";
      return /Mic paused\./.test(t) && /Hey Sparkle/.test(t);
    });

  it("armed + actually listening → shows the live wake hint, not 'Listening paused'", () => {
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

  it("mic hover cue is direction-aware: paused rests ORANGE→RED on hover; off rests gray→TEAL", () => {
    // Probe jsdom's normalized form of each hex so the assertions are format-agnostic.
    const probe = document.createElement("span");
    probe.style.color = DANGER;
    const RED = probe.style.color;
    probe.style.color = C.teal;
    const TEAL = probe.style.color;
    probe.style.color = C.amber;
    const ORANGE = probe.style.color;

    // Paused (on, waiting for the wake word): rests ORANGE (the pause affordance), turns RED on
    // hover — telegraphing the destructive "click to turn off".
    useDictationStore.setState({ enabled: true, status: "listening", phase: "passive" });
    render(<LogoWaveform />);
    const micOn = screen.getByRole("button", { name: "Turn off microphone" });
    expect(micOn.style.color).toBe(ORANGE);
    fireEvent.mouseEnter(micOn);
    expect(micOn.style.color).toBe(RED);
    cleanup();

    // Off: rests gray, turns TEAL (not red) on hover — the constructive "click to turn on" cue.
    useDictationStore.setState({ enabled: false, status: "idle" });
    render(<LogoWaveform />);
    const micOff = screen.getByRole("button", { name: "Turn on microphone" });
    const offRest = micOff.style.color;
    expect(offRest).not.toBe(TEAL); // rests gray, proving the teal is hover-driven
    fireEvent.mouseEnter(micOff);
    expect(micOff.style.color).toBe(TEAL);
    expect(micOff.style.color).not.toBe(RED);
  });

  it("active mic rests on the live tint and turns ORANGE (pause) on hover, never red", () => {
    const probe = document.createElement("span");
    probe.style.color = C.amber;
    const ORANGE = probe.style.color;
    probe.style.color = DANGER;
    const RED = probe.style.color;

    useDictationStore.setState({ enabled: true, status: "listening", phase: "active" });
    render(<LogoWaveform />);
    const micActive = screen.getByRole("button", { name: "Pause listening" });
    expect(micActive.style.color).not.toBe(ORANGE); // rests on the live tint
    expect(micActive.style.color).not.toBe(RED); // active never shows the destructive red
    fireEvent.mouseEnter(micActive);
    expect(micActive.style.color).toBe(ORANGE); // hover = "click to pause"
  });

  it("clicking the mic while ACTIVE pauses (phase→passive) instead of turning it off", () => {
    useDictationStore.setState({ enabled: true, status: "listening", phase: "active" });
    render(<LogoWaveform />);
    fireEvent.click(screen.getByRole("button", { name: "Pause listening" }));
    // Paused, NOT off: enabled stays true, phase drops to passive.
    expect(useDictationStore.getState().enabled).toBe(true);
    expect(useDictationStore.getState().phase).toBe("passive");
  });

  it("clicking the mic while PAUSED turns it off", () => {
    useDictationStore.setState({ enabled: true, status: "listening", phase: "passive" });
    render(<LogoWaveform />);
    fireEvent.click(screen.getByRole("button", { name: "Turn off microphone" }));
    expect(useDictationStore.getState().enabled).toBe(false);
  });

  it("clicking the mic while OFF turns it back on (to paused)", () => {
    useDictationStore.setState({ enabled: false, status: "idle" });
    render(<LogoWaveform />);
    fireEvent.click(screen.getByRole("button", { name: "Turn on microphone" }));
    expect(useDictationStore.getState().enabled).toBe(true);
  });

  it("muted → no caption at all, mic offers to turn on", () => {
    useDictationStore.setState({ enabled: false, status: "idle" });
    render(<LogoWaveform />);
    expect(screen.queryByText(/Listening paused/)).toBeNull();
    expect(wakeHintButton()).toBeNull();
    expect(screen.getByRole("button", { name: "Turn on microphone" })).toBeTruthy();
  });
});

describe("LogoWaveform — out of credits", () => {
  it("clicking the OFF mic while out of credits does NOT arm it — shows the credits notice", () => {
    useAuthStore.setState({ me: null }); // no credits
    useDictationStore.setState({ enabled: false, status: "idle", outOfCreditsNotice: false });
    render(<LogoWaveform />);
    fireEvent.click(screen.getByRole("button", { name: "Turn on microphone" }));
    // Refused: the mic never armed, and the shared notice is up in the sidebar.
    expect(useDictationStore.getState().enabled).toBe(false);
    expect(useDictationStore.getState().outOfCreditsNotice).toBe(true);
    expect(screen.getByText("You are out of credits.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refill" })).toBeTruthy();
    useDictationStore.getState().clearOutOfCreditsNotice(); // tidy the pending 5s timer
  });

  it("clicking Refill deep-opens the ⋯ settings dialog on the Credits pane", () => {
    useAuthStore.setState({ me: null });
    useUiStore.setState({ settingsRequest: null });
    useDictationStore.setState({ enabled: false, status: "idle", outOfCreditsNotice: true });
    render(<LogoWaveform />);
    fireEvent.click(screen.getByRole("button", { name: "Refill" }));
    // The link requests the Credits category; TopBar consumes settingsRequest to open the dialog.
    expect(useUiStore.getState().settingsRequest).toBe("credits");
    useDictationStore.getState().clearOutOfCreditsNotice();
  });

  it("renders the two-line notice whenever the shared flag is set (both surfaces stay in sync)", () => {
    useAuthStore.setState({ me: null }); // still out of credits, so the notice isn't auto-cleared
    useDictationStore.setState({ enabled: false, status: "idle", outOfCreditsNotice: true });
    render(<LogoWaveform />);
    expect(screen.getByText("You are out of credits.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refill" })).toBeTruthy();
    // The normal paused/wake caption must not co-render.
    expect(screen.queryByText(/Mic paused/)).toBeNull();
    useDictationStore.getState().clearOutOfCreditsNotice();
  });

  it("safety: an armed mic is forced off when the balance is empty", () => {
    // Credits ran out mid-session while the mic was on. The sidebar effect releases it so voice
    // detection can't keep running without credits.
    useAuthStore.setState({ me: null });
    useDictationStore.setState({ enabled: true, status: "listening", phase: "passive" });
    render(<LogoWaveform />);
    expect(useDictationStore.getState().enabled).toBe(false);
  });

  it("a lingering notice is dropped once credits arrive (never sits next to a usable mic)", () => {
    // beforeEach seeds a credited user, so the effect should clear the notice on mount.
    useDictationStore.setState({ enabled: false, status: "idle", outOfCreditsNotice: true });
    render(<LogoWaveform />);
    expect(useDictationStore.getState().outOfCreditsNotice).toBe(false);
    expect(screen.queryByText("You are out of credits.")).toBeNull();
  });
});
