// @vitest-environment jsdom
//
// The shared mic control (MicButton): the composer-left mic and the top waveform ring both consume
// useMicToggle/micVisual, so this pins the ComposerMic's visibility gating and that its click runs
// the identical tri-state cycle. The ring's own rendering is covered in LogoWaveform.render.test.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ComposerMic, MicMenu } from "./MicButton";
import { useDictationStore } from "../stores/dictationStore";

beforeEach(() => {
  // modelProgress must be reset too: it now drives the "preparing" state, so a case that leaves a
  // download in flight would otherwise bleed that state into the next test.
  useDictationStore.setState({ enabled: true, status: "idle", phase: "passive", modelProgress: null });
});
afterEach(() => cleanup());

describe("ComposerMic — visibility", () => {
  it("is HIDDEN entirely when the mic is off", () => {
    useDictationStore.setState({ enabled: false, status: "idle" });
    render(<ComposerMic />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is visible while PAUSED (on, but not routing)", () => {
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

describe("ComposerMic — preparing (voice-model download) is visibly its own state", () => {
  // Bug 3: while the 631 MB model unpacks from its ~482 MB download, the mic used to draw the
  // "paused" glyph — pixel-identical to a healthy, ready mic. The user had no way to tell a
  // multi-minute first-run wait from a mic that was simply armed and idle.
  const downloading = { done: 100_000_000, total: 482_000_000 };

  it("does NOT draw the healthy paused/ready affordance while the model is downloading", () => {
    useDictationStore.setState({
      enabled: true,
      status: "listening",
      phase: "passive",
      modelProgress: downloading,
    });
    render(<ComposerMic />);
    // The paused glyph's control is labelled "Turn off microphone"; preparing gets its own label,
    // so the two can never render the same button.
    expect(screen.queryByRole("button", { name: "Turn off microphone" })).toBeNull();
    expect(screen.getByRole("button", { name: "Setting up voice — turn off microphone" })).toBeTruthy();
  });

  it("stays clickable so the user can back out of the download", () => {
    useDictationStore.setState({
      enabled: true,
      status: "listening",
      phase: "passive",
      modelProgress: downloading,
    });
    render(<ComposerMic />);
    fireEvent.click(screen.getByRole("button", { name: "Setting up voice — turn off microphone" }));
    expect(useDictationStore.getState().enabled).toBe(false);
  });

  it("WARM start (model already on disk) shows the ordinary paused mic — no preparing state", () => {
    useDictationStore.setState({
      enabled: true,
      status: "listening",
      phase: "passive",
      modelProgress: null,
    });
    render(<ComposerMic />);
    expect(screen.getByRole("button", { name: "Turn off microphone" })).toBeTruthy();
  });
});

// roborev 56208. `AudioInputPicker` was mounted inside this popover, then MOVED into Settings and
// re-laid-out for a wide pane — its `width: 230` root constraint (sized to fit the concierge column)
// was deleted in the move. This popover has no width of its own (`left: 50%; translateX(-50%)`,
// shrink-to-fit), so the widened picker made it size to its `whiteSpace: nowrap` status rows, whose
// max-content width is a whole device-name string. Past ~242px it spills into the neighbouring
// column or is clipped by an `overflow: hidden` ancestor, cutting off the very device names it
// exists to show.
//
// Asserted on the picker's OWN root landmark (`role="group"`, "Microphone input device") rather
// than on a measured width: jsdom has no layout engine, so any width assertion here would read 0
// and pass vacuously. The picker renders that landmark unconditionally, so this is red the moment
// the mount comes back.
describe("MicMenu — the device picker is NOT mounted here (it lives in Settings)", () => {
  it("renders no input-device picker", () => {
    render(<MicMenu surface="concierge" />);
    expect(screen.queryByRole("group", { name: "Microphone input device" })).toBeNull();
  });

  it("carries exactly the three mode options and nothing else clickable", () => {
    render(<MicMenu surface="concierge" />);
    // The picker contributes a device list of `menuitemradio`s and a `checkbox` for the system-audio
    // opt-in, so counting the menu's own controls catches a partial re-mount too.
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
    expect(screen.queryByRole("checkbox")).toBeNull();
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
