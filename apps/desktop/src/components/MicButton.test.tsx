// @vitest-environment jsdom
//
// The shared mic control (MicButton): the composer-left mic and the top waveform ring both consume
// useMicToggle/micVisual, so this pins the ComposerMic's visibility gating and that its click runs
// the identical tri-state cycle. The ring's own rendering is covered in LogoWaveform.render.test.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ComposerMic } from "./MicButton";
import { useDictationStore } from "../stores/dictationStore";

beforeEach(() => {
  useDictationStore.setState({ enabled: true, status: "idle", phase: "passive" });
});
afterEach(() => cleanup());

describe("ComposerMic — visibility", () => {
  it("is HIDDEN entirely when the mic is off", () => {
    useDictationStore.setState({ enabled: false, status: "idle" });
    render(<ComposerMic />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is visible while PAUSED (on, waiting for the wake word)", () => {
    useDictationStore.setState({ enabled: true, status: "listening", phase: "passive" });
    render(<ComposerMic />);
    expect(screen.getByRole("button", { name: "Turn off microphone" })).toBeTruthy();
  });

  it("is visible while ACTIVELY listening", () => {
    useDictationStore.setState({ enabled: true, status: "listening", phase: "active" });
    render(<ComposerMic />);
    expect(screen.getByRole("button", { name: "Pause listening" })).toBeTruthy();
  });
});

describe("ComposerMic — click drives the same tri-state cycle as the top ring", () => {
  it("ACTIVE → click → paused (phase passive, still enabled — not off)", () => {
    useDictationStore.setState({ enabled: true, status: "listening", phase: "active" });
    render(<ComposerMic />);
    fireEvent.click(screen.getByRole("button", { name: "Pause listening" }));
    expect(useDictationStore.getState().enabled).toBe(true);
    expect(useDictationStore.getState().phase).toBe("passive");
  });

  it("PAUSED → click → off (and the button then disappears)", () => {
    useDictationStore.setState({ enabled: true, status: "listening", phase: "passive" });
    const { rerender } = render(<ComposerMic />);
    fireEvent.click(screen.getByRole("button", { name: "Turn off microphone" }));
    expect(useDictationStore.getState().enabled).toBe(false);
    rerender(<ComposerMic />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
