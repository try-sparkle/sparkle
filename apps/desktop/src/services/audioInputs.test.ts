// The device contract, asserted at the SIDE EFFECT: which command went to Rust with which
// argument, and what the `dictation://device` event actually did to the store.
//
// The vacuous version of this file would assert that `setAudioInput("x")` leaves `chosenUid === "x"`
// in the store and stop there — which passes just as well if the invoke line is deleted, i.e. if
// Sparkle never actually rebinds and goes on capturing the wrong device while the UI shows the
// right one. That IS the bug this feature exists to prevent, so every test here pins the outbound
// command.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

/** Registered `dictation://device` handlers, so a test can emit a real bind event. */
const listeners: Record<string, ((e: { payload: unknown }) => void)[]> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    (listeners[name] ??= []).push(cb);
    return Promise.resolve(() => {
      listeners[name] = (listeners[name] ?? []).filter((c) => c !== cb);
    });
  },
}));

import {
  boundDeviceCaption,
  isDeviceSelectable,
  refreshAudioInputs,
  setAllowVirtualInput,
  setAudioInput,
  subscribeBoundDevice,
  type AudioInput,
} from "./audioInputs";
import { useAudioInputStore } from "../stores/audioInputStore";

const BUILTIN: AudioInput = {
  uid: "builtin-mic",
  name: "MacBook Pro Microphone",
  isDefault: true,
  isVirtual: false,
  isBuiltin: true,
};
const LOOPBACK: AudioInput = {
  uid: "hal-loopback",
  name: "BlackHole 2ch",
  isDefault: false,
  isVirtual: true,
  isBuiltin: false,
};

/** Every invocation of one command, so an assertion can ignore the list/settings chatter. */
function callsTo(command: string): unknown[][] {
  return invoke.mock.calls.filter((c) => c[0] === command).map((c) => c.slice(1));
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  for (const k of Object.keys(listeners)) delete listeners[k];
  useAudioInputStore.setState({ devices: [], chosenUid: null, allowVirtual: false, bound: null, intentEpoch: 0, grantFailed: false });
});

describe("setAudioInput — the choice reaches the BACKEND, not just the store", () => {
  it("sends set_audio_input with the chosen device's uid", async () => {
    await setAudioInput("hal-loopback");
    expect(callsTo("set_audio_input")).toEqual([[{ uid: "hal-loopback" }]]);
  });

  it("sends the uid it was given, not some other device's", async () => {
    // Pins the ARGUMENT, not merely that a command fired: binding to the wrong uid is silent —
    // capture succeeds, it is simply the wrong microphone.
    await setAudioInput("builtin-mic");
    expect(callsTo("set_audio_input")).toEqual([[{ uid: "builtin-mic" }]]);
  });

  it("null means AUTOMATIC and is sent as null (not omitted, not a string)", async () => {
    await setAudioInput(null);
    expect(callsTo("set_audio_input")).toEqual([[{ uid: null }]]);
  });

  it("does not throw when the backend is absent", async () => {
    // `invoke` throws SYNCHRONOUSLY outside a Tauri webview. The picker calls this from a click
    // handler, so a throw here would surface as an unhandled rejection in the UI.
    invoke.mockImplementation(() => {
      throw new Error("no __TAURI_INTERNALS__");
    });
    await expect(setAudioInput("builtin-mic")).resolves.toBeUndefined();
  });

  it("a FAILING slow rebind does not clobber a NEWER successful one", async () => {
    // A CoreAudio rebind is exactly the slow, failure-prone operation this module is about, so two
    // picks can overlap. Pick Yeti (slow, will fail); pick Built-in (fast, succeeds); then Yeti's
    // rejection arrives. An unconditional rollback restores "Yeti" — parking the checkmark on the
    // device whose bind FAILED while capture is on the built-in mic.
    let failYeti!: (e: unknown) => void;
    const yetiCall = new Promise((_res, rej) => {
      failYeti = rej;
    });
    invoke.mockImplementation((_cmd: string, args: { uid: string | null }) =>
      args.uid === "usb-yeti" ? yetiCall : Promise.resolve(undefined),
    );

    const slow = setAudioInput("usb-yeti");
    await setAudioInput("builtin-mic");
    failYeti(new Error("device taken by another app"));
    await slow;

    expect(useAudioInputStore.getState().chosenUid).toBe("builtin-mic");
  });

  it("ROLLS BACK the optimistic choice when the rebind fails", async () => {
    // Otherwise the checkmark parks on a device that was never bound — the UI asserting a
    // microphone the backend never opened, which is this module's whole failure class.
    useAudioInputStore.setState({ chosenUid: "usb-yeti" });
    invoke.mockRejectedValue(new Error("device vanished"));
    await setAudioInput("builtin-mic");
    expect(useAudioInputStore.getState().chosenUid).toBe("usb-yeti");
  });
});

describe("setAllowVirtualInput — the advanced opt-in reaches the backend", () => {
  it("sends set_allow_virtual_input with allow true", async () => {
    await setAllowVirtualInput(true);
    expect(callsTo("set_allow_virtual_input")).toEqual([[{ allow: true }]]);
  });

  it("sends allow FALSE when revoked — the revoke must travel, not just the grant", async () => {
    // The asymmetric case that a "did it invoke?" test would miss: a revoke that never reaches Rust
    // leaves the backend happily bound to a loopback device the UI now shows as disallowed.
    useAudioInputStore.setState({ allowVirtual: true });
    await setAllowVirtualInput(false);
    expect(callsTo("set_allow_virtual_input")).toEqual([[{ allow: false }]]);
    expect(useAudioInputStore.getState().allowVirtual).toBe(false);
  });

  it("a CONFIRMED grant opens the gate", async () => {
    await setAllowVirtualInput(true);
    expect(useAudioInputStore.getState().allowVirtual).toBe(true);
    expect(isDeviceSelectable(LOOPBACK, useAudioInputStore.getState().allowVirtual)).toBe(true);
  });

  it("a FAILED grant leaves the gate SHUT — the opt-in must never fail open", async () => {
    // The whole privacy control is this one flag: isDeviceSelectable reads nothing else. An
    // optimistic grant that never reached Rust would let the user select a loopback input the
    // backend still refuses, and the UI would show system audio selected and bound when it is
    // neither. This is the one direction the default is not allowed to move on its own.
    invoke.mockRejectedValue(new Error("backend refused"));
    await setAllowVirtualInput(true);
    expect(useAudioInputStore.getState().allowVirtual).toBe(false);
    expect(isDeviceSelectable(LOOPBACK, useAudioInputStore.getState().allowVirtual)).toBe(false);
  });

  it("a LATE grant cannot re-open an opt-in the user has since revoked", async () => {
    // The fail-open, moved one step later. The grant leaves the store untouched while in flight,
    // so a pending refresh can apply the backend's persisted `true` (setSettings does not bump the
    // epoch), the user unchecks it, and only THEN does the original grant resolve. Backend order is
    // true, false — it refuses virtual inputs — so a store saying `true` would offer every loopback
    // row under an "allowed" banner for a permission that is off.
    let confirmGrant!: (v: unknown) => void;
    const grantCall = new Promise((res) => {
      confirmGrant = res;
    });
    invoke.mockImplementation((_cmd: string, args: { allow: boolean }) =>
      args.allow ? grantCall : Promise.resolve(undefined),
    );

    const granting = setAllowVirtualInput(true);
    // An in-flight refresh lands the backend's persisted value without bumping the epoch.
    useAudioInputStore.getState().setSettings({ chosenUid: null, allowVirtual: true });
    // The user changes their mind and revokes.
    await setAllowVirtualInput(false);
    // Only now does the original grant come back.
    confirmGrant(undefined);
    await granting;

    expect(useAudioInputStore.getState().allowVirtual).toBe(false);
    expect(isDeviceSelectable(LOOPBACK, useAudioInputStore.getState().allowVirtual)).toBe(false);
  });

  it("a second click while a grant is in flight does not fire a second grant", async () => {
    // This used to assert that two CONCURRENT grants interleaved safely. roborev 55351 showed they
    // don't: a grant deliberately leaves the store untouched while in flight, so both fire against
    // the SAME epoch — and if one fails and the other succeeds, the failure arm runs first, bumps
    // the epoch, and the epoch guard then discards the SUCCESSFUL grant. The backend ends up
    // allowing virtual inputs while the UI says it is off.
    //
    // So the race is made unreachable rather than survived: one grant at a time. The correctness the
    // old test was reaching for is now carried by the reconcile below, which does not depend on
    // which of two racing calls happened to land first.
    let settle!: (v: unknown) => void;
    const inFlight = new Promise((res) => {
      settle = res;
    });
    let grants = 0;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "set_allow_virtual_input") {
        grants += 1;
        return inFlight;
      }
      return Promise.resolve(undefined);
    });

    const first = setAllowVirtualInput(true);
    await setAllowVirtualInput(true); // the impatient second click
    expect(grants).toBe(1);

    settle(undefined);
    await first;
    expect(useAudioInputStore.getState().allowVirtual).toBe(true);
  });

  it("a failed grant RECONCILES with the backend instead of guessing the gate is shut", async () => {
    // The hazard the old concurrency test was really about, reached the simple way: the invoke
    // rejects, but Rust had already persisted the grant (a transport failure after the write).
    // Guessing "off" looks fail-closed and isn't — the next refreshAudioInputs (every menu open)
    // reads the backend's `true` and silently re-opens the gate, leaving a "couldn't enable" banner
    // beside a now-checked box. Ask the backend what it believes (roborev 55351).
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_audio_input_settings") {
        return Promise.resolve({ chosenUid: null, allowVirtual: true });
      }
      return Promise.reject(new Error("transport died after the write"));
    });

    await setAllowVirtualInput(true);

    expect(useAudioInputStore.getState().allowVirtual).toBe(true);
    expect(useAudioInputStore.getState().grantFailed).toBe(true);
  });

  it("and still fails CLOSED when the backend will not say", async () => {
    // The other half: if we cannot read the backend either, the gate stays shut. Fail-closed is the
    // default when there is no evidence — never when the evidence says otherwise.
    invoke.mockRejectedValue(new Error("backend is gone"));

    await setAllowVirtualInput(true);

    expect(useAudioInputStore.getState().allowVirtual).toBe(false);
    expect(useAudioInputStore.getState().grantFailed).toBe(true);
  });

  it("records the failure so the picker can SAY the grant did not take", async () => {
    invoke.mockRejectedValue(new Error("backend refused"));
    await setAllowVirtualInput(true);
    expect(useAudioInputStore.getState().grantFailed).toBe(true);
  });

  it("clears that failure once a grant succeeds", async () => {
    useAudioInputStore.setState({ grantFailed: true });
    await setAllowVirtualInput(true);
    expect(useAudioInputStore.getState().grantFailed).toBe(false);
  });

  it("a FAILED revoke still shuts the gate locally (strict is the safe direction)", async () => {
    useAudioInputStore.setState({ allowVirtual: true });
    invoke.mockRejectedValue(new Error("backend refused"));
    await setAllowVirtualInput(false);
    expect(useAudioInputStore.getState().allowVirtual).toBe(false);
  });
});

describe("refreshAudioInputs — pulls the real list and the persisted settings", () => {
  it("loads devices and settings into the store", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_audio_inputs") return Promise.resolve([BUILTIN, LOOPBACK]);
      if (cmd === "get_audio_input_settings")
        return Promise.resolve({ chosenUid: "builtin-mic", allowVirtual: true });
      return Promise.resolve(undefined);
    });
    await refreshAudioInputs();
    const s = useAudioInputStore.getState();
    expect(s.devices.map((d) => d.uid)).toEqual(["builtin-mic", "hal-loopback"]);
    expect(s.chosenUid).toBe("builtin-mic");
    expect(s.allowVirtual).toBe(true);
  });

  it("does NOT clobber a choice the user made while the refresh was in flight", async () => {
    // The realistic trigger: the menu's list is already rendered and clickable from the previous
    // open, so a click lands ~instantly while this refresh is still pending. Applying a response
    // that predates the click reverts the checkmark onto a device capture is no longer using.
    let releaseSettings!: (s: unknown) => void;
    const pending = new Promise((res) => {
      releaseSettings = res;
    });
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_audio_inputs") return Promise.resolve([BUILTIN, LOOPBACK]);
      if (cmd === "get_audio_input_settings") return pending;
      return Promise.resolve(undefined);
    });

    const refreshing = refreshAudioInputs();
    // The user picks a device before the settings round-trip comes back.
    await setAudioInput("hal-loopback");
    // ...and only now does the STALE settings response resolve.
    releaseSettings({ chosenUid: "builtin-mic", allowVirtual: false });
    await refreshing;

    expect(useAudioInputStore.getState().chosenUid).toBe("hal-loopback");
  });

  it("does not clobber a just-granted opt-in either", async () => {
    let releaseSettings!: (s: unknown) => void;
    const pending = new Promise((res) => {
      releaseSettings = res;
    });
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_audio_inputs") return Promise.resolve([BUILTIN, LOOPBACK]);
      if (cmd === "get_audio_input_settings") return pending;
      return Promise.resolve(undefined);
    });

    const refreshing = refreshAudioInputs();
    await setAllowVirtualInput(true);
    releaseSettings({ chosenUid: null, allowVirtual: false });
    await refreshing;

    expect(useAudioInputStore.getState().allowVirtual).toBe(true);
  });

  it("still applies settings normally when the user did NOT intervene", async () => {
    // The control for the two tests above: the guard must not simply stop refresh from ever
    // working, which is how a race fix becomes a silent feature removal.
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "list_audio_inputs") return Promise.resolve([BUILTIN]);
      if (cmd === "get_audio_input_settings")
        return Promise.resolve({ chosenUid: "builtin-mic", allowVirtual: true });
      return Promise.resolve(undefined);
    });
    await refreshAudioInputs();
    expect(useAudioInputStore.getState().chosenUid).toBe("builtin-mic");
    expect(useAudioInputStore.getState().allowVirtual).toBe(true);
  });

  it("leaves the opt-in OFF when the backend cannot answer (fails closed)", async () => {
    // A permissive fallback would make a virtual device selectable purely because a round-trip
    // failed — the one direction this default is not allowed to move on its own.
    invoke.mockRejectedValue(new Error("backend down"));
    await refreshAudioInputs();
    expect(useAudioInputStore.getState().allowVirtual).toBe(false);
    expect(useAudioInputStore.getState().devices).toEqual([]);
  });
});

describe("dictation://device — the authoritative bind signal", () => {
  it("an emitted bind event updates the store's live device", async () => {
    await subscribeBoundDevice();
    expect(useAudioInputStore.getState().bound).toBeNull();

    listeners["dictation://device"]?.forEach((cb) =>
      cb({ payload: { name: "MacBook Pro Microphone", uid: "builtin-mic", isVirtual: false } }),
    );

    expect(useAudioInputStore.getState().bound).toEqual({
      name: "MacBook Pro Microphone",
      uid: "builtin-mic",
      isVirtual: false,
    });
  });

  it("a later REBIND replaces the previous device (the store never goes stale)", async () => {
    await subscribeBoundDevice();
    const emit = (payload: unknown) =>
      listeners["dictation://device"]?.forEach((cb) => cb({ payload }));

    emit({ name: "MacBook Pro Microphone", uid: "builtin-mic", isVirtual: false });
    emit({ name: "BlackHole 2ch", uid: "hal-loopback", isVirtual: true });

    // A handler that only ever recorded the FIRST bind would leave the app claiming a microphone
    // while capture had moved to a loopback device — incident (b), exactly.
    expect(useAudioInputStore.getState().bound?.name).toBe("BlackHole 2ch");
    expect(useAudioInputStore.getState().bound?.isVirtual).toBe(true);
  });

  it("IGNORES a snake_case payload instead of rendering it", async () => {
    // Serde defaults to snake_case. A Rust struct landing without `rename_all = "camelCase"` emits
    // a perfectly TRUTHY object that a `if (e.payload)` guard waves through — producing
    // "Listening: undefined" and marking a loopback device as a microphone. Saying nothing is the
    // only honest response to a payload we cannot read.
    await subscribeBoundDevice();
    listeners["dictation://device"]?.forEach((cb) =>
      cb({ payload: { name: "BlackHole 2ch", uid: "hal-loopback", is_virtual: true } }),
    );
    expect(useAudioInputStore.getState().bound).toBeNull();
  });

  it("ignores a payload with no usable name", async () => {
    await subscribeBoundDevice();
    listeners["dictation://device"]?.forEach((cb) => cb({ payload: { uid: "x", isVirtual: false } }));
    expect(useAudioInputStore.getState().bound).toBeNull();
  });

  it("accepts a well-formed payload whose uid is null (the system-default case)", async () => {
    // uid is legitimately null for "automatic", so validation must not reject it.
    await subscribeBoundDevice();
    listeners["dictation://device"]?.forEach((cb) =>
      cb({ payload: { name: "MacBook Pro Microphone", uid: null, isVirtual: false } }),
    );
    expect(useAudioInputStore.getState().bound?.name).toBe("MacBook Pro Microphone");
  });

  it("unsubscribing stops further events from touching the store", async () => {
    const unlisten = await subscribeBoundDevice();
    unlisten?.();
    listeners["dictation://device"]?.forEach((cb) =>
      cb({ payload: { name: "Ghost", uid: "g", isVirtual: false } }),
    );
    expect(useAudioInputStore.getState().bound).toBeNull();
  });
});

describe("boundDeviceCaption", () => {
  const MIC = { name: "MacBook Pro Microphone", uid: "b", isVirtual: false };

  it("names the live device in the present tense while capture IS live", () => {
    expect(boundDeviceCaption(MIC, true)).toBe("Listening: MacBook Pro Microphone");
  });

  it("switches to a POINTING verb when capture is not live", () => {
    // This line renders directly under "Listening paused: Will auto-resume…". A fixed "Listening:"
    // would re-assert, one line below, the exact capture that caption just retracted.
    expect(boundDeviceCaption(MIC, false)).toBe("Mic: MacBook Pro Microphone");
  });

  it("renders NOTHING before anything has bound — never a guess", () => {
    expect(boundDeviceCaption(null, true)).toBeNull();
    expect(boundDeviceCaption(null, false)).toBeNull();
  });
});

describe("isDeviceSelectable — the opt-in is what gates a non-microphone input", () => {
  it("a real microphone is always selectable", () => {
    expect(isDeviceSelectable(BUILTIN, false)).toBe(true);
    expect(isDeviceSelectable(BUILTIN, true)).toBe(true);
  });

  it("a virtual input is refused until the opt-in is on", () => {
    expect(isDeviceSelectable(LOOPBACK, false)).toBe(false);
    expect(isDeviceSelectable(LOOPBACK, true)).toBe(true);
  });
});
