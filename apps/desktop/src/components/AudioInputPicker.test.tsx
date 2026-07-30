// @vitest-environment jsdom
//
// The picker, asserted at the side effect: a click has to produce a COMMAND to Rust with the right
// uid, and the privacy affordances have to be present on the virtual device and absent on the real
// one. Rendering assertions alone would pass against a picker that draws a perfect list and rebinds
// nothing.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

/** Registered `dictation://device` handlers — the picker subscribes through useAudioInputSync. */
const listeners: Record<string, ((e: { payload: unknown }) => void)[]> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    (listeners[name] ??= []).push(cb);
    return Promise.resolve(() => {
      listeners[name] = (listeners[name] ?? []).filter((c) => c !== cb);
    });
  },
}));

import { AudioInputPicker } from "./AudioInputPicker";
import { useAudioInputStore, resetAudioInputStore } from "../stores/audioInputStore";
import { useDictationStore } from "../stores/dictationStore";
import {
  ALLOW_VIRTUAL_ACTIVE_WARNING,
  ALLOW_VIRTUAL_FAILED,
  ALLOW_VIRTUAL_LABEL,
  AUTOMATIC_LABEL,
  VIRTUAL_MARKER,
  type AudioInput,
  type AudioInputSettings,
} from "../services/audioInputs";

const BUILTIN: AudioInput = {
  uid: "builtin-mic",
  name: "MacBook Pro Microphone",
  isDefault: true,
  isVirtual: false,
  isBuiltin: true,
};
const USB: AudioInput = {
  uid: "usb-yeti",
  name: "Yeti Stereo Microphone",
  isDefault: false,
  isVirtual: false,
  isBuiltin: false,
};
/** The device class both incidents trace to: a HAL plug-in that republishes system OUTPUT. */
const LOOPBACK: AudioInput = {
  uid: "hal-loopback",
  name: "BlackHole 2ch",
  isDefault: false,
  isVirtual: true,
  isBuiltin: false,
};

let devices: AudioInput[] = [];
let settings: AudioInputSettings = { chosenUid: null, allowVirtual: false };

function callsTo(command: string): unknown[][] {
  return invoke.mock.calls.filter((c) => c[0] === command).map((c) => c.slice(1));
}

/** Render and wait for the async device load to land, so assertions run against a settled list. */
async function renderPicker() {
  render(<AudioInputPicker />);
  await waitFor(() => {
    expect(screen.getByRole("menuitemradio", { name: devices[0]!.name })).toBeTruthy();
  });
}

beforeEach(() => {
  invoke.mockReset();
  for (const k of Object.keys(listeners)) delete listeners[k];
  // Armed AND capturing: useAudioInputSync clears `bound` whenever the mic is disarmed, so a
  // default-off store would wipe every bind these tests emit.
  useDictationStore.setState({ enabled: true, status: "listening", phase: "passive" });
  devices = [BUILTIN, USB, LOOPBACK];
  settings = { chosenUid: null, allowVirtual: false };
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "list_audio_inputs") return Promise.resolve(devices);
    if (cmd === "get_audio_input_settings") return Promise.resolve(settings);
    return Promise.resolve(undefined);
  });
  resetAudioInputStore();
});
afterEach(() => cleanup());

describe("AudioInputPicker — choosing a device actually rebinds capture", () => {
  it("clicking a microphone sends set_audio_input with THAT device's uid", async () => {
    await renderPicker();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Yeti Stereo Microphone" }));
    expect(callsTo("set_audio_input")).toEqual([[{ uid: "usb-yeti" }]]);
  });

  it("each row sends its OWN uid (the list is not wired to a single device)", async () => {
    await renderPicker();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "MacBook Pro Microphone" }));
    expect(callsTo("set_audio_input")).toEqual([[{ uid: "builtin-mic" }]]);
  });

  it("clicking Automatic sends null — back to the system default", async () => {
    settings = { chosenUid: "usb-yeti", allowVirtual: false };
    await renderPicker();
    fireEvent.click(screen.getByRole("menuitemradio", { name: AUTOMATIC_LABEL }));
    expect(callsTo("set_audio_input")).toEqual([[{ uid: null }]]);
  });

  it("marks the persisted choice as the checked row, and Automatic when there is none", async () => {
    settings = { chosenUid: "usb-yeti", allowVirtual: false };
    await renderPicker();
    await waitFor(() => {
      expect(
        screen.getByRole("menuitemradio", { name: "Yeti Stereo Microphone" }).getAttribute("aria-checked"),
      ).toBe("true");
    });
    expect(screen.getByRole("menuitemradio", { name: AUTOMATIC_LABEL }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });
});

describe("AudioInputPicker — a non-microphone input is marked as one", () => {
  it("the virtual device carries the marker and the real microphones do not", async () => {
    await renderPicker();
    const loopbackRow = screen.getByTestId("audio-input-hal-loopback");
    const builtinRow = screen.getByTestId("audio-input-builtin-mic");
    const usbRow = screen.getByTestId("audio-input-usb-yeti");

    expect(within(loopbackRow).getByText(VIRTUAL_MARKER)).toBeTruthy();
    // The half that actually distinguishes: a marker painted on EVERY row would satisfy the
    // assertion above while telling the user nothing.
    expect(within(builtinRow).queryByText(VIRTUAL_MARKER)).toBeNull();
    expect(within(usbRow).queryByText(VIRTUAL_MARKER)).toBeNull();
  });
});

describe("AudioInputPicker — binding to system audio is opt-in", () => {
  it("the opt-in is OFF by default", async () => {
    await renderPicker();
    expect(screen.getByRole("checkbox", { name: ALLOW_VIRTUAL_LABEL }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("clicking a virtual device while the opt-in is OFF sends NO rebind command", async () => {
    await renderPicker();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "BlackHole 2ch" }));
    expect(callsTo("set_audio_input")).toEqual([]);
    // Control: the refusal is specific to the virtual device, not a dead picker.
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Yeti Stereo Microphone" }));
    expect(callsTo("set_audio_input")).toEqual([[{ uid: "usb-yeti" }]]);
  });

  it("clicking the SAME virtual device once the opt-in is ON does rebind", async () => {
    settings = { chosenUid: null, allowVirtual: true };
    await renderPicker();
    await waitFor(() => {
      expect(useAudioInputStore.getState().allowVirtual).toBe(true);
    });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "BlackHole 2ch" }));
    expect(callsTo("set_audio_input")).toEqual([[{ uid: "hal-loopback" }]]);
  });

  it("toggling the opt-in sends set_allow_virtual_input to the backend", async () => {
    await renderPicker();
    fireEvent.click(screen.getByRole("checkbox", { name: ALLOW_VIRTUAL_LABEL }));
    expect(callsTo("set_allow_virtual_input")).toEqual([[{ allow: true }]]);
  });

  it("a REFUSED grant says so, instead of silently staying unchecked", async () => {
    // The grant only applies once Rust confirms it, so without this the checkbox on a refusal looks
    // exactly like never having clicked — the user cannot tell "worked" from "still going" from
    // "will never work", and hammers a dead control. (Live in this tree today: the Rust command
    // does not exist yet, so every grant rejects.)
    await renderPicker();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_audio_inputs") return Promise.resolve(devices);
      if (cmd === "get_audio_input_settings") return Promise.resolve(settings);
      return Promise.reject(new Error("no such command"));
    });

    fireEvent.click(screen.getByRole("checkbox", { name: ALLOW_VIRTUAL_LABEL }));

    await waitFor(() => {
      expect(screen.getByText(ALLOW_VIRTUAL_FAILED)).toBeTruthy();
    });
    // And the gate genuinely stayed shut — the message is not covering for a half-applied grant.
    expect(screen.getByRole("checkbox", { name: ALLOW_VIRTUAL_LABEL }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(
      screen.getByRole("menuitemradio", { name: "BlackHole 2ch" }).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("a RETRY clears the previous failure instead of leaving it up", async () => {
    // roborev 55351 called the previous version of this test vacuous, correctly: beforeEach already
    // sets grantFailed: false, so `queryByText(...) === null` was true before the change and stayed
    // true with the clearing deleted. Seed the failed state and assert it GOES AWAY.
    //
    // The behaviour matters because leaving the banner up for the whole retry window recreates the
    // exact "still going or will never work?" ambiguity the message exists to remove.
    await renderPicker();
    act(() => {
      useAudioInputStore.setState({ grantFailed: true });
    });
    expect(screen.getByText(ALLOW_VIRTUAL_FAILED)).toBeTruthy();

    // Hold the grant PENDING: the banner must be gone during the in-flight window, which is the
    // whole point. Asserting only after the grant resolves proves nothing — the success path clears
    // the banner too, so the test would pass with the up-front clear deleted.
    let settle!: (v: unknown) => void;
    const pending = new Promise((res) => {
      settle = res;
    });
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_audio_inputs") return Promise.resolve(devices);
      if (cmd === "get_audio_input_settings") return Promise.resolve(settings);
      if (cmd === "set_allow_virtual_input") return pending;
      return Promise.resolve(undefined);
    });

    fireEvent.click(screen.getByRole("checkbox", { name: ALLOW_VIRTUAL_LABEL }));

    await waitFor(() => {
      expect(screen.queryByText(ALLOW_VIRTUAL_FAILED)).toBeNull();
    });
    // Still in flight — the box has NOT been checked yet (the grant applies only on confirmation),
    // so this is genuinely the retry window and not the post-success state.
    expect(screen.getByRole("checkbox", { name: ALLOW_VIRTUAL_LABEL }).getAttribute("aria-checked")).toBe(
      "false",
    );

    await act(async () => {
      settle(undefined);
      await pending;
    });
    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: ALLOW_VIRTUAL_LABEL }).getAttribute("aria-checked")).toBe(
        "true",
      );
    });
    expect(screen.queryByText(ALLOW_VIRTUAL_FAILED)).toBeNull();
  });

  it("a failed grant RECONCILES with the backend rather than asserting nothing changed", async () => {
    // The dangerous case: the invoke rejects, but Rust had already persisted the grant (a transport
    // failure after the write). Guessing "off" is not the safe default it looks like — the next
    // refresh, i.e. every menu open, reads the backend's `true` and silently re-opens the privacy
    // gate, with a red "couldn't enable" banner beside a now-checked box. So we ASK (roborev 55351).
    await renderPicker();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_audio_inputs") return Promise.resolve(devices);
      // The backend's truth: the grant DID land.
      if (cmd === "get_audio_input_settings") return Promise.resolve({ chosenUid: null, allowVirtual: true });
      return Promise.reject(new Error("transport died after the write"));
    });

    fireEvent.click(screen.getByRole("checkbox", { name: ALLOW_VIRTUAL_LABEL }));

    // The UI reflects what the backend actually believes, so the two cannot disagree about who is
    // allowed to be captured.
    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: ALLOW_VIRTUAL_LABEL }).getAttribute("aria-checked")).toBe(
        "true",
      );
    });
    // AND NO FAILURE BANNER. This test used to assert the opposite, which pinned a screen showing
    // a checked box, the "allowed" banner and "Couldn't confirm this — check the box again" all at
    // once (roborev 55411). The contradiction is not merely confusing: the checkbox's only handler
    // is a toggle, so obeying that instruction on a checked box REVOKES the grant the reconcile
    // just confirmed had landed.
    expect(screen.queryByText(ALLOW_VIRTUAL_FAILED)).toBeNull();
  });

  it("but DOES say so when the backend will not confirm either way", async () => {
    // The other half of the reconcile, and the reason the banner still exists. No evidence the
    // grant landed → fail closed AND tell the user, because a silently unticked box is
    // indistinguishable from never having clicked.
    await renderPicker();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_audio_inputs") return Promise.resolve(devices);
      return Promise.reject(new Error("backend is gone"));
    });

    fireEvent.click(screen.getByRole("checkbox", { name: ALLOW_VIRTUAL_LABEL }));

    await waitFor(() => {
      expect(screen.getByText(ALLOW_VIRTUAL_FAILED)).toBeTruthy();
    });
    // Here "check the box again" is safe advice: the box is UNCHECKED, so following it retries the
    // grant instead of undoing one.
    expect(screen.getByRole("checkbox", { name: ALLOW_VIRTUAL_LABEL }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("the opt-in's own label names the consequence, not the mechanism", async () => {
    await renderPicker();
    // "transcribe anything playing on this machine" is the promise the user is trading away; a
    // label that only said "allow virtual audio devices" would be agreed to without learning that.
    expect(document.body.textContent).toMatch(/transcribe anything playing on this machine/i);
  });
});

describe("AudioInputPicker — an ENABLED opt-in is visible in the menu itself", () => {
  it("shows the standing warning in the menu body when allowVirtual is on", async () => {
    settings = { chosenUid: null, allowVirtual: true };
    await renderPicker();
    // Requirement C: visible WITHOUT opening a submenu — the warning is in this component's own
    // output, reachable with no further interaction after the menu opens.
    await waitFor(() => {
      expect(screen.getByText(ALLOW_VIRTUAL_ACTIVE_WARNING)).toBeTruthy();
    });
  });

  it("does NOT show that warning while the opt-in is off", async () => {
    await renderPicker();
    expect(screen.queryByText(ALLOW_VIRTUAL_ACTIVE_WARNING)).toBeNull();
  });
});

describe("AudioInputPicker — the live device is shown, not the requested one", () => {
  it("names the device capture is actually bound to even when it differs from the choice", async () => {
    // The nine-minutes-of-silence shape: the user picked their USB mic, and something else got the
    // stream. The menu must report the BIND, not the intent.
    //
    // Driven by a REAL `dictation://device` event through the picker's OWN subscription — not a
    // store poke. A direct setState would pass even if the picker never subscribed, which is
    // exactly what it did: the line was inert in the app while this test stayed green.
    settings = { chosenUid: "usb-yeti", allowVirtual: false };
    await renderPicker();
    await waitFor(() => {
      expect(listeners["dictation://device"]?.length).toBeGreaterThan(0);
    });

    listeners["dictation://device"]?.forEach((cb) =>
      cb({ payload: { name: "BlackHole 2ch", uid: "hal-loopback", isVirtual: true } }),
    );

    await waitFor(() => {
      expect(screen.getByText("Listening: BlackHole 2ch")).toBeTruthy();
    });
    // The chosen row is still the Yeti — the two facts are shown separately, not conflated.
    expect(
      screen.getByRole("menuitemradio", { name: "Yeti Stereo Microphone" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("subscribes on its OWN, without any sibling surface being mounted", async () => {
    // The picker is rendered here alone. If it relied on LogoWaveform's subscription, no listener
    // would exist and its headline "current device is always visible" rule would be dead in any
    // window that does not mount that ring.
    await renderPicker();
    await waitFor(() => {
      expect(listeners["dictation://device"]?.length).toBeGreaterThan(0);
    });
  });
});
