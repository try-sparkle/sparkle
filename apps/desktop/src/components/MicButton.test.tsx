// @vitest-environment jsdom
//
// The shared mic control (MicButton): the composer-left mic and the top waveform ring both consume
// useMicToggle/micVisual, so this pins the ComposerMic's visibility gating and that its click runs
// the identical tri-state cycle. The ring's own rendering is covered in LogoWaveform.render.test.
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ComposerMic, MicMenu, useMicToggle } from "./MicButton";
import { useDictationStore } from "../stores/dictationStore";
import { useAuthStore } from "../stores/authStore";
import type { Me } from "../services/entitlement";
import { deliveryErrorFor } from "../voice/deliveryWatchdog";
import { C } from "../theme/colors";

const meWith = (balanceCents: number): Me => ({
  clerkUserId: "u1",
  entitled: true,
  balanceCents,
  tokenVersion: 1,
});

beforeEach(() => {
  // modelProgress must be reset too: it now drives the "preparing" state, so a case that leaves a
  // download in flight would otherwise bleed that state into the next test.
  // `error` resets here for the same reason `modelProgress` does: the delivery-notice rows below
  // set it, and a leaked notice would demote the glyph in every later case (roborev 71218).
  useDictationStore.setState({ enabled: true, status: "idle", phase: "passive", modelProgress: null, error: null });
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

// ── THE PAINT SITE ITSELF, NOT THE HOOK THAT FEEDS IT (roborev 71218) ─────────────────────────
// `useMicToggle` returns an undemoted `state` (click cycle + labels) and a notice-demoted
// `glyphState` (paint). The hook half is asserted in useDictation.delivery.test.tsx; this is the
// CONSUMPTION half — that `ComposerMic` actually paints from `glyphState`. Reverting
// `micVisual(glyphState, hover)` to `micVisual(state, hover)` restores the green live-mic glyph in
// the composer while every recognised word is being discarded, and without this row the entire
// suite stays green — the `sparkle-50m03` shape, twice over in this branch.
//
// A delivery drop is the ONLY fault class that leaves `status` on "listening" (status is a routing
// input — roborev 71065), which is why no pre-existing ComposerMic test reaches this shape: they
// all leave `error` null.
describe("ComposerMic — a delivery notice dims the glyph without changing the control", () => {
  const notice = {
    enabled: true,
    status: "listening" as const,
    phase: "active" as const,
    modelProgress: null,
    error: deliveryErrorFor("no-target"),
  };

  it("does not paint the green live-mic glyph while words are being discarded", () => {
    useDictationStore.setState(notice);
    render(<ComposerMic />);
    const button = screen.getByRole("button", { name: "Pause listening" });

    // `micVisual("active", false)` is `{ color: C.successInk, variant: "open" }` — the live mic.
    // Compared through the browser's own normalisation, since React writes the raw token.
    const probe = document.createElement("span");
    probe.style.color = C.successInk;
    expect(button.style.color).not.toBe(probe.style.color);
  });

  // The other half of the split, in the same shape: the notice may dim the glyph and must NOT
  // touch what a click does. Demoting the shared value made this button read "Turn off" and
  // disarm capture instead of pausing it.
  it("still offers Pause, and a click pauses rather than disarms", () => {
    useDictationStore.setState(notice);
    render(<ComposerMic />);
    const button = screen.getByRole("button", { name: "Pause listening" });
    expect(button.getAttribute("title")).toBe("Pause");

    fireEvent.click(button);

    expect(useDictationStore.getState().phase).toBe("passive");
    expect(useDictationStore.getState().enabled).toBe(true);
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

// bead sparkle-yvvu27 — the primary mic click used to cycle off → paused → off and could NEVER
// reach the routing ("active") state, so a plain click gave a HOT-BUT-SILENT mic (enabled, phase
// passive: capturing audio, routing/transcribing nothing) with no on-screen sign routing was off.
// The click now arms AND routes. These drive the real shared hook (useMicToggle) directly because
// the ComposerMic renders nothing while OFF, so the off→click transition can't be exercised through
// the component. Both mic surfaces consume this same hook, so this pins the behavior for both.
describe("useMicToggle — a plain click REACHES the routing (active) state", () => {
  beforeEach(() => {
    useAuthStore.setState({ me: meWith(500) }); // credits present: arming is allowed
    useDictationStore.setState({ outOfCreditsNotice: false });
  });
  afterEach(() => {
    useAuthStore.setState({ me: null });
    useDictationStore.setState({ outOfCreditsNotice: false });
  });

  it("OFF → click → routes: phase becomes 'active', not the old hot-but-silent 'passive'", () => {
    useDictationStore.setState({ enabled: false, status: "idle", phase: "passive", modelProgress: null });
    const { result } = renderHook(() => useMicToggle());
    expect(result.current.state).toBe("off");
    act(() => result.current.onClick());
    // The SIDE EFFECT that matters is the routing intent, not merely that the mic armed. Before the
    // fix `enabled` flipped true while `phase` stayed "passive" — exactly the hot-but-silent mic.
    // Asserting phase === "active" (the routing flag), not just enabled, is what pins that the click
    // reaches the ROUTING state rather than stopping at the paused intermediate.
    expect(useDictationStore.getState().enabled).toBe(true);
    expect(useDictationStore.getState().phase).toBe("active");
  });

  it("full cycle off → active → paused → off — every state reachable from a plain click", () => {
    // status 'listening' so that, once armed with phase active, deriveMicState reports ACTIVE (the
    // derived state, not just the raw store fields, is what the glyph and both surfaces render).
    useDictationStore.setState({ enabled: false, status: "listening", phase: "passive", modelProgress: null });
    const { result, rerender } = renderHook(() => useMicToggle());
    expect(result.current.state).toBe("off");

    act(() => result.current.onClick()); // off → active
    rerender();
    expect(result.current.state).toBe("active");

    act(() => result.current.onClick()); // active → paused
    rerender();
    expect(useDictationStore.getState().phase).toBe("passive");
    expect(result.current.state).toBe("paused");

    act(() => result.current.onClick()); // paused → off
    rerender();
    expect(useDictationStore.getState().enabled).toBe(false);
    expect(result.current.state).toBe("off");
  });

  it("OFF + OUT OF CREDITS → click is refused: mic never arms, never routes, notice shown", () => {
    useAuthStore.setState({ me: meWith(0) }); // no credits
    useDictationStore.setState({ enabled: false, status: "idle", phase: "passive", outOfCreditsNotice: false });
    const { result } = renderHook(() => useMicToggle());
    act(() => result.current.onClick());
    // The credits guard must still short-circuit BEFORE arming or routing — the new setPhase("active")
    // must sit behind it, not in front. So both enabled and phase are untouched, and the notice shows.
    expect(useDictationStore.getState().enabled).toBe(false);
    expect(useDictationStore.getState().phase).toBe("passive");
    expect(useDictationStore.getState().outOfCreditsNotice).toBe(true);
  });
});
