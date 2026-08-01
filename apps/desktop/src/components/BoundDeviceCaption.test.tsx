// @vitest-environment jsdom
//
// The "Listening: <device>" line, driven END TO END from the `dictation://device` event: this file
// emits the real event through the real subscription and asserts the RENDERED TEXT changed. A test
// that set `audioInputStore.bound` by hand and checked the render would pass with the listener
// deleted — i.e. with the caption frozen on a device that is no longer being captured, which is
// precisely the failure the caption exists to make visible.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listeners: Record<string, ((e: { payload: unknown }) => void)[]> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    (listeners[name] ??= []).push(cb);
    return Promise.resolve(() => {
      listeners[name] = (listeners[name] ?? []).filter((c) => c !== cb);
    });
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: () => Promise.resolve(undefined),
}));
const openUrl = vi.fn((_url: string) => Promise.resolve());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (u: string) => openUrl(u) }));

import { act } from "@testing-library/react";
import { BoundDeviceCaption } from "./BoundDeviceCaption";
import { LogoWaveform } from "./LogoWaveform";
import { useAudioInputStore, resetAudioInputStore } from "../stores/audioInputStore";
import { useDictationStore } from "../stores/dictationStore";
import { useAuthStore } from "../stores/authStore";
import { useAudioInputSync, BOUND_VIRTUAL_WARNING } from "../services/audioInputs";

/** The real wiring: the sync hook every device surface mounts, plus the caption it feeds. */
function Host() {
  useAudioInputSync();
  return <BoundDeviceCaption />;
}

function emitBind(payload: unknown) {
  listeners["dictation://device"]?.forEach((cb) => cb({ payload }));
}

/** Wait for the subscription to be registered (listen() resolves on a microtask). */
async function renderHost() {
  render(<Host />);
  await waitFor(() => {
    expect(listeners["dictation://device"]?.length).toBeGreaterThan(0);
  });
}

beforeEach(() => {
  for (const k of Object.keys(listeners)) delete listeners[k];
  resetAudioInputStore();
  // Armed AND capturing, so the caption's default register is the present-tense "Listening:".
  // `windowFocused`/`focusOwner` are reset here too: `deriveMicPresentation` now takes the pause as
  // an INPUT (roborev 57117), so a row that demotes via the window would otherwise leak that pause
  // into every row after it — which is exactly what happened when the background-window case below
  // was first added.
  useDictationStore.setState({ enabled: true, status: "listening", phase: "passive", error: null, modelProgress: null, outOfCreditsNotice: false, windowFocused: true, focusOwner: "other" });
  useAuthStore.setState({ me: { clerkUserId: "u1", entitled: true, balanceCents: 500, tokenVersion: 1 } });
});
afterEach(() => cleanup());

describe("BoundDeviceCaption — the event drives the rendered device name", () => {
  it("renders nothing until a bind is reported", async () => {
    await renderHost();
    expect(document.body.textContent).not.toMatch(/Listening:/);
  });

  it("a dictation://device event puts the device name on screen", async () => {
    await renderHost();
    emitBind({ name: "MacBook Pro Microphone", uid: "builtin-mic", isVirtual: false });
    await waitFor(() => {
      expect(screen.getByText("Listening: MacBook Pro Microphone")).toBeTruthy();
    });
  });

  it("a REBIND replaces the name on screen — the old device is gone, not appended", async () => {
    await renderHost();
    emitBind({ name: "MacBook Pro Microphone", uid: "builtin-mic", isVirtual: false });
    await waitFor(() => {
      expect(screen.getByText("Listening: MacBook Pro Microphone")).toBeTruthy();
    });

    emitBind({ name: "Yeti Stereo Microphone", uid: "usb-yeti", isVirtual: false });
    await waitFor(() => {
      expect(screen.getByText("Listening: Yeti Stereo Microphone")).toBeTruthy();
    });
    expect(screen.queryByText("Listening: MacBook Pro Microphone")).toBeNull();
  });
});

describe("BoundDeviceCaption — a non-microphone bind says so", () => {
  it("a virtual device carries the system-audio warning", async () => {
    await renderHost();
    emitBind({ name: "BlackHole 2ch", uid: "hal-loopback", isVirtual: true });
    await waitFor(() => {
      expect(screen.getByText("Listening: BlackHole 2ch")).toBeTruthy();
    });
    expect(screen.getByText(BOUND_VIRTUAL_WARNING)).toBeTruthy();
  });

  it("a real microphone does NOT carry it", async () => {
    // The discriminating half: a warning shown on every bind would be ignored within a day.
    await renderHost();
    emitBind({ name: "MacBook Pro Microphone", uid: "builtin-mic", isVirtual: false });
    await waitFor(() => {
      expect(screen.getByText("Listening: MacBook Pro Microphone")).toBeTruthy();
    });
    expect(screen.queryByText(BOUND_VIRTUAL_WARNING)).toBeNull();
  });

  it("uses a POINTING verb in a BACKGROUND window, where `status` never drops", async () => {
    // ── roborev 57277 ───────────────────────────────────────────────────────────────────────────
    // The row below demotes by writing `status: "idle"` — which `deriveMicPresentation` already
    // honoured before `pauseReason` became an input, so it cannot fail without that wiring.
    //
    // THIS is the snapshot that needed it: the per-window blur path deliberately leaves `status` at
    // "listening" (`tearDownOwnedStream` touches interim/level/speaking and not status, and the
    // app-level `dictation://focus(false)` never fires while another Sparkle window is active). So
    // without the pause term this caption printed "Listening: MacBook Pro Microphone" two lines
    // under LogoWaveform's freshly demoted "Listening paused" — the present-tense re-assertion this
    // component's own header forbids (roborev 55289).
    await renderHost();
    emitBind({ name: "MacBook Pro Microphone", uid: "builtin-mic", isVirtual: false });
    await waitFor(() => {
      expect(screen.getByText("Listening: MacBook Pro Microphone")).toBeTruthy();
    });
    act(() => {
      // `status` STAYS "listening" — that is the whole point of the case.
      useDictationStore.setState({ windowFocused: false, phase: "active" });
    });
    await waitFor(() => {
      expect(screen.getByText("Mic: MacBook Pro Microphone")).toBeTruthy();
    });
    expect(screen.queryByText("Listening: MacBook Pro Microphone")).toBeNull();
  });

  it("uses a POINTING verb when armed but not actually capturing", async () => {
    // Focus-paused: LogoWaveform's own caption right above reads "Listening paused: Will
    // auto-resume…". Claiming "Listening: <device>" underneath contradicts it in the present tense.
    await renderHost();
    emitBind({ name: "MacBook Pro Microphone", uid: "builtin-mic", isVirtual: false });
    await waitFor(() => {
      expect(screen.getByText("Listening: MacBook Pro Microphone")).toBeTruthy();
    });
    act(() => {
      useDictationStore.setState({ status: "idle" });
    });
    await waitFor(() => {
      expect(screen.getByText("Mic: MacBook Pro Microphone")).toBeTruthy();
    });
    expect(screen.queryByText("Listening: MacBook Pro Microphone")).toBeNull();
  });

  it("does not claim to be LISTENING under a notice that says voice failed", async () => {
    // roborev 55289. `dictation://error` sets the error and never touches `status`, so a
    // mid-session backend failure leaves status === "listening" while LogoWaveform right above
    // renders the "voice failed, here's the remedy" notice. Reading `status` raw made this line
    // answer "Listening: Yeti" directly beneath it — a live capture asserted under a notice
    // declaring it dead, which is the whole class of dishonesty this branch exists to remove.
    // The verb must come from the SHARED presentation, which the notice also switches on.
    await renderHost();
    emitBind({ name: "Yeti Stereo Microphone", uid: "yeti", isVirtual: false });
    await waitFor(() => {
      expect(screen.getByText("Listening: Yeti Stereo Microphone")).toBeTruthy();
    });
    act(() => {
      // Exactly what the dictation://error listener does: the error lands, status is untouched.
      useDictationStore.setState({ error: 'No audio from "Yeti Stereo Microphone".' });
    });
    await waitFor(() => {
      expect(screen.getByText("Mic: Yeti Stereo Microphone")).toBeTruthy();
    });
    expect(screen.queryByText("Listening: Yeti Stereo Microphone")).toBeNull();
  });

  it("does not claim to be LISTENING while the voice model is still downloading", async () => {
    // Same shape one state over: armed and optimistic, model not down yet, nothing being heard.
    await renderHost();
    emitBind({ name: "MacBook Pro Microphone", uid: "builtin-mic", isVirtual: false });
    await waitFor(() => {
      expect(screen.getByText("Listening: MacBook Pro Microphone")).toBeTruthy();
    });
    act(() => {
      useDictationStore.setState({ modelProgress: { done: 12_000_000, total: 482_000_000 } });
    });
    await waitFor(() => {
      expect(screen.getByText("Mic: MacBook Pro Microphone")).toBeTruthy();
    });
  });

  it("rebinding from a loopback back to a microphone CLEARS the warning", async () => {
    // A warning that latches would train the user to ignore it on a device that is now fine.
    await renderHost();
    emitBind({ name: "BlackHole 2ch", uid: "hal-loopback", isVirtual: true });
    await waitFor(() => {
      expect(screen.getByText(BOUND_VIRTUAL_WARNING)).toBeTruthy();
    });

    emitBind({ name: "MacBook Pro Microphone", uid: "builtin-mic", isVirtual: false });
    await waitFor(() => {
      expect(screen.getByText("Listening: MacBook Pro Microphone")).toBeTruthy();
    });
    expect(screen.queryByText(BOUND_VIRTUAL_WARNING)).toBeNull();
  });
});

describe("BoundDeviceCaption — a disarmed mic has no bound device", () => {
  it("DISARMING clears the bind, so a re-arm claims nothing until a fresh one arrives", async () => {
    // `dictation://device` only fires on a SUCCESSFUL bind, so without an explicit clear the store
    // latches the last device that ever bound. The user mutes with the Yeti bound, unplugs it,
    // re-arms — and the caption reappears naming hardware that is not connected, before any bind
    // has occurred. If the re-bind then fails, no event ever corrects it.
    await renderHost();
    emitBind({ name: "Yeti Stereo Microphone", uid: "usb-yeti", isVirtual: false });
    await waitFor(() => {
      expect(screen.getByText("Listening: Yeti Stereo Microphone")).toBeTruthy();
    });

    act(() => {
      useDictationStore.setState({ enabled: false, status: "idle" });
    });
    await waitFor(() => {
      expect(useAudioInputStore.getState().bound).toBeNull();
    });

    // Re-arm with the Yeti now unplugged: nothing may be claimed until a real bind is reported.
    act(() => {
      useDictationStore.setState({ enabled: true, status: "listening" });
    });
    await waitFor(() => {
      expect(screen.queryByText(/Yeti Stereo Microphone/)).toBeNull();
    });
    expect(document.body.textContent).not.toMatch(/Listening:|Mic:/);
  });

  it("a latched VIRTUAL warning cannot outlive the disarm", async () => {
    await renderHost();
    emitBind({ name: "BlackHole 2ch", uid: "hal-loopback", isVirtual: true });
    await waitFor(() => {
      expect(screen.getByText(BOUND_VIRTUAL_WARNING)).toBeTruthy();
    });
    act(() => {
      useDictationStore.setState({ enabled: false, status: "idle" });
    });
    await waitFor(() => {
      expect(screen.queryByText(BOUND_VIRTUAL_WARNING)).toBeNull();
    });
  });
});

describe("LogoWaveform — the REAL tree's enabled gate", () => {
  // Rendered through LogoWaveform, not a hand-built Host: the gate this asserts
  // (`{enabled ? <BoundDeviceCaption /> : null}`) exists only there, so a Host that renders the
  // caption unconditionally would leave it completely uncovered.
  beforeEach(() => {
    globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  });

  it("shows the device while the mic is armed", async () => {
    render(<LogoWaveform />);
    await waitFor(() => {
      expect(listeners["dictation://device"]?.length).toBeGreaterThan(0);
    });
    emitBind({ name: "MacBook Pro Microphone", uid: "builtin-mic", isVirtual: false });
    await waitFor(() => {
      expect(screen.getByText("Listening: MacBook Pro Microphone")).toBeTruthy();
    });
  });

  it("a MUTED mic advertises no device at all", async () => {
    render(<LogoWaveform />);
    await waitFor(() => {
      expect(listeners["dictation://device"]?.length).toBeGreaterThan(0);
    });
    emitBind({ name: "BlackHole 2ch", uid: "hal-loopback", isVirtual: true });
    await waitFor(() => {
      expect(screen.getByText("Listening: BlackHole 2ch")).toBeTruthy();
    });

    act(() => {
      useDictationStore.setState({ enabled: false, status: "idle" });
    });
    await waitFor(() => {
      expect(screen.queryByText(/BlackHole 2ch/)).toBeNull();
    });
    expect(screen.queryByText(BOUND_VIRTUAL_WARNING)).toBeNull();
  });
});
