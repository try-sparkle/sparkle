// @vitest-environment jsdom
//
// The picker, asserted at the side effect: a click has to produce a COMMAND to Rust with the right
// uid, and the privacy affordances have to be present on the virtual device and absent on the real
// one. Rendering assertions alone would pass against a picker that draws a perfect list and rebinds
// nothing.
//
// The clarity rules are asserted here too, because they are the reason this component was rewritten
// and they are exactly the kind of property that decays back: a loopback device must not appear as
// a PEER of the microphones, and the status block must answer "what is being captured" and "is
// system audio included" without the user reading a paragraph to find out.
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

import { AudioInputPicker, MICROPHONE_GROUP_LABEL, NO_SYSTEM_AUDIO_INPUTS } from "./AudioInputPicker";
import { useAudioInputStore, resetAudioInputStore } from "../stores/audioInputStore";
import { useDictationStore } from "../stores/dictationStore";
import {
  ALLOW_VIRTUAL_FAILED,
  ALLOW_VIRTUAL_LABEL,
  AUTOMATIC_LABEL,
  SYSTEM_AUDIO_ALLOWED,
  SYSTEM_AUDIO_CAPTURING,
  SYSTEM_AUDIO_OFF,
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
/** A second one, because the shipped machine had FOUR and that is the complaint: they filled the
 *  menu as though they were alternatives to the built-in microphone. */
const TEAMS: AudioInput = {
  uid: "hal-teams",
  name: "Microsoft Teams Audio",
  isDefault: false,
  isVirtual: true,
  isBuiltin: false,
};

let devices: AudioInput[] = [];
let settings: AudioInputSettings = { chosenUid: null, allowVirtual: false };

function callsTo(command: string): unknown[][] {
  return invoke.mock.calls.filter((c) => c[0] === command).map((c) => c.slice(1));
}

/** The MICROPHONE group's rows, by accessible name — the list a user reads as "things I can talk
 *  into". Scoped to the group so the assertion is about that list and not about the whole pane. */
function microphoneRowNames(): string[] {
  const group = screen.getByRole("group", { name: MICROPHONE_GROUP_LABEL });
  return within(group)
    .getAllByRole("menuitemradio")
    .map((el) => el.getAttribute("aria-label") ?? "");
}

/** Render and wait for the async device load to land, so assertions run against a settled list. */
async function renderPicker() {
  render(<AudioInputPicker />);
  await waitFor(() => {
    expect(screen.getByRole("menuitemradio", { name: BUILTIN.name })).toBeTruthy();
  });
}

beforeEach(() => {
  invoke.mockReset();
  for (const k of Object.keys(listeners)) delete listeners[k];
  // Armed AND capturing: useAudioInputSync clears `bound` whenever the mic is disarmed, so a
  // default-off store would wipe every bind these tests emit.
  useDictationStore.setState({ enabled: true, status: "listening", phase: "passive" });
  devices = [BUILTIN, USB, LOOPBACK, TEAMS];
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
    fireEvent.click(screen.getByRole("menuitemradio", { name: USB.name }));
    expect(callsTo("set_audio_input")).toEqual([[{ uid: "usb-yeti" }]]);
  });

  it("each row sends its OWN uid (the list is not wired to a single device)", async () => {
    await renderPicker();
    fireEvent.click(screen.getByRole("menuitemradio", { name: BUILTIN.name }));
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
      expect(screen.getByRole("menuitemradio", { name: USB.name }).getAttribute("aria-checked")).toBe("true");
    });
    expect(screen.getByRole("menuitemradio", { name: AUTOMATIC_LABEL }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });
});

describe("AudioInputPicker — loopback devices are not peers of the microphone", () => {
  it("the microphone list contains ONLY real microphones", async () => {
    // THE BUG THIS COMPONENT WAS REWRITTEN FOR. The shipped menu listed the built-in mic and then
    // four HAL loopback devices in one flat list, which a user read as five comparable choices —
    // "a recommended microphone, then maybe system audio". They are not comparable: four of them
    // cannot hear a voice at all.
    await renderPicker();
    expect(microphoneRowNames()).toEqual([AUTOMATIC_LABEL, BUILTIN.name, USB.name]);
  });

  it("a loopback device is not offerable at all while the opt-in is off", async () => {
    await renderPicker();
    // Not merely dimmed-in-place, which is what it used to be: absent from the pane, so there is no
    // row to click and no way to rebind capture onto it.
    expect(screen.queryByTestId("audio-input-hal-loopback")).toBeNull();
    expect(screen.queryByTestId("audio-input-hal-teams")).toBeNull();
    // The side effect that matters: nothing can send a rebind for one. The control is a live
    // picker — the microphone beside it rebinds fine — so this is a refusal, not a dead component.
    fireEvent.click(screen.getByRole("menuitemradio", { name: USB.name }));
    expect(callsTo("set_audio_input")).toEqual([[{ uid: "usb-yeti" }]]);
  });

  it("the opt-in reveals them under System audio, and one then rebinds capture", async () => {
    settings = { chosenUid: null, allowVirtual: true };
    await renderPicker();
    await waitFor(() => {
      expect(screen.getByTestId("audio-input-hal-loopback")).toBeTruthy();
    });
    // Revealed under the heading that governs them, NOT back in the microphone list.
    expect(microphoneRowNames()).toEqual([AUTOMATIC_LABEL, BUILTIN.name, USB.name]);
    const systemAudio = screen.getByRole("group", { name: VIRTUAL_MARKER });
    expect(within(systemAudio).getByRole("menuitemradio", { name: LOOPBACK.name })).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitemradio", { name: LOOPBACK.name }));
    expect(callsTo("set_audio_input")).toEqual([[{ uid: "hal-loopback" }]]);
  });

  it("says so when the opt-in is on but the machine has no loopback device", async () => {
    // Otherwise turning it on produces visible emptiness, which reads as a broken control.
    devices = [BUILTIN];
    settings = { chosenUid: null, allowVirtual: true };
    await renderPicker();
    await waitFor(() => {
      expect(screen.getByText(NO_SYSTEM_AUDIO_INPUTS)).toBeTruthy();
    });
  });
});

describe("AudioInputPicker — the status block answers the two questions", () => {
  it("(a) names the device capture is actually BOUND to, not the one that was requested", async () => {
    // The nine-minutes-of-silence shape: the user picked their USB mic, and something else got the
    // stream. The block must report the BIND, not the intent.
    //
    // Driven by a REAL `dictation://device` event through the picker's OWN subscription — not a
    // store poke. A direct setState would pass even if the picker never subscribed, which is
    // exactly what it did once: the line was inert in the app while the test stayed green.
    settings = { chosenUid: "usb-yeti", allowVirtual: false };
    await renderPicker();
    await waitFor(() => {
      expect(listeners["dictation://device"]?.length).toBeGreaterThan(0);
    });

    listeners["dictation://device"]?.forEach((cb) =>
      cb({ payload: { name: LOOPBACK.name, uid: "hal-loopback", isVirtual: true } }),
    );

    const capture = () => screen.getByTestId("audio-status-capture");
    await waitFor(() => {
      expect(within(capture()).getByText(LOOPBACK.name)).toBeTruthy();
    });
    expect(within(capture()).getByText("Listening")).toBeTruthy();
    // The chosen row is still the Yeti — the two facts are shown separately, not conflated.
    expect(screen.getByRole("menuitemradio", { name: USB.name }).getAttribute("aria-checked")).toBe("true");
  });

  it("(a) reports the CHOICE, not a capture, when nothing has bound", async () => {
    // The pane is routinely open with the mic off. "Listening: …" there would assert a capture that
    // is not happening, so the label switches to a word that claims nothing about capture.
    settings = { chosenUid: "usb-yeti", allowVirtual: false };
    await renderPicker();
    const capture = () => screen.getByTestId("audio-status-capture");
    await waitFor(() => {
      expect(within(capture()).getByText(USB.name)).toBeTruthy();
    });
    expect(within(capture()).getByText("Selected")).toBeTruthy();
    expect(within(capture()).queryByText("Listening")).toBeNull();
  });

  it("(b) says system audio is OFF by default", async () => {
    await renderPicker();
    expect(within(screen.getByTestId("audio-status-system-audio")).getByText(SYSTEM_AUDIO_OFF)).toBeTruthy();
  });

  it("(b) distinguishes ALLOWED from being captured right now", async () => {
    // These are different situations and the old UI had one amber banner for both: a user who
    // opted in last week and is on their built-in mic, and a user whose calls are being
    // transcribed this second.
    settings = { chosenUid: null, allowVirtual: true };
    await renderPicker();
    const row = () => screen.getByTestId("audio-status-system-audio");
    await waitFor(() => {
      expect(within(row()).getByText(SYSTEM_AUDIO_ALLOWED)).toBeTruthy();
    });

    await waitFor(() => {
      expect(listeners["dictation://device"]?.length).toBeGreaterThan(0);
    });
    listeners["dictation://device"]?.forEach((cb) =>
      cb({ payload: { name: LOOPBACK.name, uid: "hal-loopback", isVirtual: true } }),
    );

    await waitFor(() => {
      expect(within(row()).getByText(SYSTEM_AUDIO_CAPTURING)).toBeTruthy();
    });
    expect(within(row()).queryByText(SYSTEM_AUDIO_ALLOWED)).toBeNull();
  });

  it("(b) reports a loopback bind even when the opt-in is off and the device is not listed", async () => {
    // The case hiding the dimmed rows had to keep covering, and the reason hiding them is safe: a
    // stale bind from a since-revoked grant. Nothing else on this pane would say a word about it.
    await renderPicker();
    await waitFor(() => {
      expect(listeners["dictation://device"]?.length).toBeGreaterThan(0);
    });
    listeners["dictation://device"]?.forEach((cb) =>
      cb({ payload: { name: LOOPBACK.name, uid: "hal-loopback", isVirtual: true } }),
    );

    await waitFor(() => {
      expect(
        within(screen.getByTestId("audio-status-system-audio")).getByText(SYSTEM_AUDIO_CAPTURING),
      ).toBeTruthy();
    });
    // And it is named, so the user knows WHICH non-microphone is on the stream.
    expect(within(screen.getByTestId("audio-status-capture")).getByText(LOOPBACK.name)).toBeTruthy();
    // Still not selectable — the report is not a grant.
    expect(screen.queryByTestId("audio-input-hal-loopback")).toBeNull();
  });
});

describe("AudioInputPicker — binding to system audio is opt-in", () => {
  it("the opt-in is OFF by default", async () => {
    await renderPicker();
    expect(screen.getByRole("checkbox", { name: ALLOW_VIRTUAL_LABEL }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("toggling the opt-in sends set_allow_virtual_input to the backend", async () => {
    await renderPicker();
    fireEvent.click(screen.getByRole("checkbox", { name: ALLOW_VIRTUAL_LABEL }));
    expect(callsTo("set_allow_virtual_input")).toEqual([[{ allow: true }]]);
  });

  it("a REFUSED grant says so, instead of silently staying unchecked", async () => {
    // The grant only applies once Rust confirms it, so without this the checkbox on a refusal looks
    // exactly like never having clicked — the user cannot tell "worked" from "still going" from
    // "will never work", and hammers a dead control.
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
    expect(screen.queryByTestId("audio-input-hal-loopback")).toBeNull();
  });

  it("a RETRY clears the previous failure instead of leaving it up", async () => {
    // roborev 55351 called an earlier version of this test vacuous, correctly: beforeEach already
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
    // refresh, i.e. every time this pane opens, reads the backend's `true` and silently re-opens
    // the privacy gate, with a red "couldn't enable" banner beside a now-checked box (roborev 55351).
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
});

describe("AudioInputPicker — it works wherever it is mounted", () => {
  it("subscribes on its OWN, without any sibling surface being mounted", async () => {
    // Rendered here alone. If it relied on LogoWaveform's subscription, no listener would exist and
    // its headline "the current device is always visible" rule would be dead in any window that
    // does not mount that ring — which now includes the mic indicator it used to hang off.
    await renderPicker();
    await waitFor(() => {
      expect(listeners["dictation://device"]?.length).toBeGreaterThan(0);
    });
  });
});
