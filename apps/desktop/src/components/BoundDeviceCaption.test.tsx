// @vitest-environment jsdom
//
// The VIRTUAL-AUDIO-DEVICE warning, driven END TO END from the `dictation://device` event: this file
// emits the real event through the real subscription and asserts the RENDERED TEXT changed. A test
// that set `audioInputStore.bound` by hand and checked the render would pass with the listener
// deleted — i.e. with the warning frozen on a device that is no longer being captured, which is
// precisely the failure it exists to make visible.
//
// ══ THE ORDINARY "Listening: MacBook Pro Microphone" LINE IS GONE (sparkle-bbfsx) ═══════════════
// The founder cut it: *"take out the listening MacBook Pro microphone completely… We shouldn't have
// that line on either push to talk or speak."* So a REAL microphone now renders nothing here at all,
// and the rows below say so. What survives is the amber warning for a VIRTUAL bind — a different
// fact, kept deliberately (confirmed with him), because that one is the guard against dictating into
// silence for nine minutes with every surface claiming to listen.
//
// The verb rows further down still exist and still matter: they are the "never re-assert a capture
// the notice above just retracted" invariant, and they now ride on the virtual bind because that is
// the case still on screen.
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

  it("A REAL MICROPHONE RENDERS NOTHING — the line the founder cut", async () => {
    // THE ROW THIS CHANGE IS ABOUT, and it is the overwhelmingly common case: the ordinary bind is
    // a real mic, and that is exactly the state he wanted the space back from.
    await renderHost();
    emitBind({ name: "MacBook Pro Microphone", uid: "builtin-mic", isVirtual: false });
    await waitFor(() => {
      expect(useAudioInputStore.getState().bound?.name).toBe("MacBook Pro Microphone");
    });
    // The BIND still happened — this is a rendering decision, not a wiring one. Every other surface
    // that reads `bound` (the input picker, the sync hook) is untouched.
    expect(document.body.textContent).toBe("");
  });

  it("a dictation://device event puts a VIRTUAL device's warning on screen", async () => {
    await renderHost();
    emitBind({ name: "BlackHole 2ch", uid: "hal-loopback", isVirtual: true });
    await waitFor(() => {
      expect(screen.getByText("Listening: BlackHole 2ch")).toBeTruthy();
    });
  });

  it("a REBIND replaces the name on screen — the old device is gone, not appended", async () => {
    await renderHost();
    emitBind({ name: "BlackHole 2ch", uid: "hal-loopback", isVirtual: true });
    await waitFor(() => {
      expect(screen.getByText("Listening: BlackHole 2ch")).toBeTruthy();
    });

    emitBind({ name: "Loopback Audio", uid: "hal-loopback-2", isVirtual: true });
    await waitFor(() => {
      expect(screen.getByText("Listening: Loopback Audio")).toBeTruthy();
    });
    expect(screen.queryByText("Listening: BlackHole 2ch")).toBeNull();
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
    // The discriminating half: a warning shown on every bind would be ignored within a day. Since
    // sparkle-bbfsx a real bind draws NOTHING, which is a stronger version of the same claim.
    await renderHost();
    emitBind({ name: "MacBook Pro Microphone", uid: "builtin-mic", isVirtual: false });
    await waitFor(() => {
      expect(useAudioInputStore.getState().bound?.isVirtual).toBe(false);
    });
    expect(screen.queryByText(BOUND_VIRTUAL_WARNING)).toBeNull();
    expect(document.body.textContent).toBe("");
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
    //
    // ON A VIRTUAL BIND since sparkle-bbfsx, because that is the one still rendered — the invariant
    // is unchanged and so is what it protects: this row sits under LogoWaveform's own caption and
    // must never re-assert a capture that line has just retracted.
    await renderHost();
    emitBind({ name: "BlackHole 2ch", uid: "hal-loopback", isVirtual: true });
    await waitFor(() => {
      expect(screen.getByText("Listening: BlackHole 2ch")).toBeTruthy();
    });
    act(() => {
      // `status` STAYS "listening" — that is the whole point of the case.
      useDictationStore.setState({ windowFocused: false, phase: "active" });
    });
    await waitFor(() => {
      expect(screen.getByText("Mic: BlackHole 2ch")).toBeTruthy();
    });
    expect(screen.queryByText("Listening: BlackHole 2ch")).toBeNull();
  });

  it("uses a POINTING verb when armed but not actually capturing", async () => {
    // Focus-paused: LogoWaveform's own caption right above reads "Listening paused: Will
    // auto-resume…". Claiming "Listening: <device>" underneath contradicts it in the present tense.
    await renderHost();
    emitBind({ name: "BlackHole 2ch", uid: "hal-loopback", isVirtual: true });
    await waitFor(() => {
      expect(screen.getByText("Listening: BlackHole 2ch")).toBeTruthy();
    });
    act(() => {
      useDictationStore.setState({ status: "idle" });
    });
    await waitFor(() => {
      expect(screen.getByText("Mic: BlackHole 2ch")).toBeTruthy();
    });
    expect(screen.queryByText("Listening: BlackHole 2ch")).toBeNull();
  });

  it("does not claim to be LISTENING under a notice that says voice failed", async () => {
    // roborev 55289. `dictation://error` sets the error and never touches `status`, so a
    // mid-session backend failure leaves status === "listening" while LogoWaveform right above
    // renders the "voice failed, here's the remedy" notice. Reading `status` raw made this line
    // answer "Listening: Yeti" directly beneath it — a live capture asserted under a notice
    // declaring it dead, which is the whole class of dishonesty this branch exists to remove.
    // The verb must come from the SHARED presentation, which the notice also switches on.
    await renderHost();
    emitBind({ name: "Loopback Audio", uid: "hal-loopback", isVirtual: true });
    await waitFor(() => {
      expect(screen.getByText("Listening: Loopback Audio")).toBeTruthy();
    });
    act(() => {
      // Exactly what the dictation://error listener does: the error lands, status is untouched.
      useDictationStore.setState({ error: 'No audio from "Loopback Audio".' });
    });
    await waitFor(() => {
      expect(screen.getByText("Mic: Loopback Audio")).toBeTruthy();
    });
    expect(screen.queryByText("Listening: Loopback Audio")).toBeNull();
  });

  it("does not claim to be LISTENING while the voice model is still downloading", async () => {
    // Same shape one state over: armed and optimistic, model not down yet, nothing being heard.
    await renderHost();
    emitBind({ name: "BlackHole 2ch", uid: "hal-loopback", isVirtual: true });
    await waitFor(() => {
      expect(screen.getByText("Listening: BlackHole 2ch")).toBeTruthy();
    });
    act(() => {
      useDictationStore.setState({ modelProgress: { done: 12_000_000, total: 482_000_000 } });
    });
    await waitFor(() => {
      expect(screen.getByText("Mic: BlackHole 2ch")).toBeTruthy();
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
      expect(screen.queryByText(BOUND_VIRTUAL_WARNING)).toBeNull();
    });
    // …and with the warning cleared there is nothing left to draw at all.
    expect(document.body.textContent).toBe("");
  });
});

describe("BoundDeviceCaption — a disarmed mic has no bound device", () => {
  it("DISARMING clears the bind, so a re-arm claims nothing until a fresh one arrives", async () => {
    // `dictation://device` only fires on a SUCCESSFUL bind, so without an explicit clear the store
    // latches the last device that ever bound. The user mutes with the Yeti bound, unplugs it,
    // re-arms — and the caption reappears naming hardware that is not connected, before any bind
    // has occurred. If the re-bind then fails, no event ever corrects it.
    await renderHost();
    emitBind({ name: "Yeti Stereo Microphone", uid: "usb-yeti", isVirtual: true });
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

  it("shows a VIRTUAL device's warning while the mic is armed", async () => {
    render(<LogoWaveform />);
    await waitFor(() => {
      expect(listeners["dictation://device"]?.length).toBeGreaterThan(0);
    });
    emitBind({ name: "BlackHole 2ch", uid: "hal-loopback", isVirtual: true });
    await waitFor(() => {
      expect(screen.getByText("Listening: BlackHole 2ch")).toBeTruthy();
    });
  });

  it("…and NOTHING for an ordinary microphone — the reclaimed row (sparkle-bbfsx)", async () => {
    // Through the REAL tree, so this covers the whole path the founder was looking at: the gate in
    // LogoWaveform, the component, and the new virtual-only guard inside it.
    render(<LogoWaveform />);
    await waitFor(() => {
      expect(listeners["dictation://device"]?.length).toBeGreaterThan(0);
    });
    emitBind({ name: "MacBook Pro Microphone", uid: "builtin-mic", isVirtual: false });
    await waitFor(() => {
      expect(useAudioInputStore.getState().bound?.name).toBe("MacBook Pro Microphone");
    });
    expect(document.body.textContent ?? "").not.toMatch(/MacBook Pro Microphone/);
    expect(document.body.textContent ?? "").not.toMatch(/Listening:|Mic:/);
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
