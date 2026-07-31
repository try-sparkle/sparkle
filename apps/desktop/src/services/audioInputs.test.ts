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
  ALLOW_VIRTUAL_CAPTION,
  ALLOW_VIRTUAL_FAILED,
  ALLOW_VIRTUAL_LABEL,
  AUTOMATIC_LABEL,
  CHOSEN_DEVICE_GONE,
  INPUT_PICKER_LOCATION,
  SYSTEM_AUDIO_ALLOWED,
  SYSTEM_AUDIO_CAPTURING,
  SYSTEM_AUDIO_OFF,
  boundDeviceCaption,
  inputStatus,
  SYSTEM_AUDIO_OFF_STILL_SELECTED,
  isDeviceSelectable,
  refreshAudioInputs,
  setAllowVirtualInput,
  setAudioInput,
  subscribeBoundDevice,
  type AudioInput,
} from "./audioInputs";
import { useAudioInputStore, resetAudioInputStore } from "../stores/audioInputStore";

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
  // ONE helper, not a hand-listed setState. `grantPending` lives in the store rather than in a
  // module-level `let` precisely so a reset can reach it (roborev 55411) — and hand-listing let one
  // suite forget it anyway (roborev 55871). A test that leaves a grant unsettled would otherwise
  // turn every later grant in the file into a silent no-op, passing off state it never produced.
  resetAudioInputStore();
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

  it("a revoke also RELEASES a loopback that was still pinned", async () => {
    // Revoking flipped the permission and left the device pinned, which leaves the choice ARMED:
    // re-ticking the box re-binds system audio instantly, with no second pick and no fresh look at
    // which device. `SYSTEM_AUDIO_OFF_STILL_SELECTED` (roborev 56208) reports that state honestly;
    // this stops a revoke from creating it in the first place.
    //
    // Asserted at the COMMAND, not at the store: a local `setChosenUid(null)` would satisfy a
    // store-only assertion while the backend went on holding the loopback as the pinned device.
    useAudioInputStore.setState({
      allowVirtual: true,
      chosenUid: "hal-loopback",
      devices: [BUILTIN, LOOPBACK],
    });
    await setAllowVirtualInput(false);
    expect(callsTo("set_audio_input")).toEqual([[{ uid: null }]]);
    expect(useAudioInputStore.getState().chosenUid).toBeNull();
  });

  it("releases it from the live BIND when the device list is empty or stale", async () => {
    // The list is best-effort — `listAudioInputs` returns [] when the backend is unavailable, and
    // Rust degrades a join failure to an empty vec — while this checkbox stays clickable. Keying
    // the release only on the list skipped it in exactly the state that matters: a HAL enumeration
    // stall with the loopback pinned AND on the wire, which is the armed pin this exists to
    // prevent (roborev 56366). No device row, no list entry — the bind is the only witness.
    useAudioInputStore.setState({
      allowVirtual: true,
      chosenUid: "hal-loopback",
      devices: [],
      bound: { name: "BlackHole 2ch", uid: "hal-loopback", isVirtual: false },
    });
    // Control first: a bind that is NOT virtual must not trigger a release, or the fallback is just
    // "release whatever is pinned whenever the list is empty".
    await setAllowVirtualInput(false);
    expect(callsTo("set_audio_input")).toEqual([]);

    // Second control: a virtual bind on a DIFFERENT device says nothing about the pin. Capture can
    // sit on a loopback while a microphone is pinned (the pinned bind failed, or has not happened
    // yet), and releasing then would throw away that microphone and hand capture to automatic —
    // which is free to pick the loopback it is already on. The bind only stands in for the pin when
    // it IS the pin.
    invoke.mockClear();
    useAudioInputStore.setState({
      allowVirtual: true,
      chosenUid: "usb-yeti",
      devices: [],
      bound: { name: "BlackHole 2ch", uid: "hal-loopback", isVirtual: true },
    });
    await setAllowVirtualInput(false);
    expect(callsTo("set_audio_input")).toEqual([]);
    expect(useAudioInputStore.getState().chosenUid).toBe("usb-yeti");

    invoke.mockClear();
    useAudioInputStore.setState({
      allowVirtual: true,
      chosenUid: "hal-loopback",
      devices: [],
      bound: { name: "BlackHole 2ch", uid: "hal-loopback", isVirtual: true },
    });
    await setAllowVirtualInput(false);
    expect(callsTo("set_audio_input")).toEqual([[{ uid: null }]]);
    expect(useAudioInputStore.getState().chosenUid).toBeNull();
  });

  it("a revoke leaves a pinned MICROPHONE alone", async () => {
    // The half that makes the release specific rather than "any revoke clears your choice", which
    // would silently throw away a Yeti the user pinned weeks ago.
    useAudioInputStore.setState({
      allowVirtual: true,
      chosenUid: "builtin-mic",
      devices: [BUILTIN, LOOPBACK],
    });
    await setAllowVirtualInput(false);
    expect(callsTo("set_audio_input")).toEqual([]);
    expect(useAudioInputStore.getState().chosenUid).toBe("builtin-mic");
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
    // AND SAYS NOTHING FAILED, because nothing did. This assertion was `true` when the test was
    // written, which pinned the contradiction rather than the fix (roborev 55411): a CHECKED box,
    // the amber "non-microphone inputs are allowed" banner, and a red "Couldn't confirm this —
    // check the box again" all at once. The banner's remedy is the dangerous half. The checkbox's
    // only handler is a toggle, so a user following "check the box again" on a checked box REVOKES
    // the grant the reconcile just proved had landed — a remedy that inverts the user's intent, the
    // sparkle-8bvh failure mode. `grantFailed` may only mean "we could not confirm".
    expect(useAudioInputStore.getState().grantFailed).toBe(false);
  });

  it("a backend that answers NO is a refusal, not an unreachable backend", async () => {
    // The third reconcile outcome, and the one that had no test at all (roborev 55871). `actual`
    // resolving `{ allowVirtual: false }` means the backend responded and DECLINED — materially
    // different from `actual === null`, which means it would not say. Both fail closed, correctly,
    // but the notice used to assert "Sparkle's audio backend didn't respond" for both, which is
    // simply false here: it answered. Pinning this path is what keeps the copy honest.
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_audio_input_settings") {
        return Promise.resolve({ chosenUid: null, allowVirtual: false });
      }
      return Promise.reject(new Error("the write itself was refused"));
    });

    await setAllowVirtualInput(true);

    expect(useAudioInputStore.getState().allowVirtual).toBe(false);
    expect(useAudioInputStore.getState().grantFailed).toBe(true);
    // The notice must not describe HOW it failed, because this path and the unreachable-backend
    // path share one string and only one of them involves a backend that stayed silent.
    expect(ALLOW_VIRTUAL_FAILED).not.toMatch(/didn't respond|no response|unreachable/i);
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

  // THE PAIR BELOW IS ONE TEST IN TWO HALVES, and the order matters — it reproduces the leak the
  // module-level flag caused. The first half deliberately abandons a grant mid-flight; the second
  // half is the test that would have been silently disarmed by it.
  it("marks a grant PENDING in the store — and this one is abandoned in flight, on purpose", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "set_allow_virtual_input" ? new Promise(() => {}) : Promise.resolve(undefined),
    );
    void setAllowVirtualInput(true);
    await Promise.resolve();
    expect(useAudioInputStore.getState().grantPending).toBe(true);
    // No settle, no await. The next test inherits whatever this one leaves behind.
  });

  it("...and the NEXT grant still reaches the backend, rather than hitting a stale in-flight flag", async () => {
    // The assertion is on the outbound COMMAND, not on the store. That is the whole point: if the
    // pending flag were unreachable module state, the abandoned grant above would still be sitting
    // in it, this call would return at the dedupe guard having invoked NOTHING, and a store-only
    // assertion would pass anyway off the value the previous test left. Pinning the invoke is what
    // makes the vacuity visible (roborev 55411).
    invoke.mockResolvedValue(undefined);
    await setAllowVirtualInput(true);
    expect(callsTo("set_allow_virtual_input")).toEqual([[{ allow: true }]]);
    expect(useAudioInputStore.getState().allowVirtual).toBe(true);
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

describe("inputStatus — the two questions, answered without collapsing them into one", () => {
  const DEVICES = [BUILTIN, LOOPBACK];
  const base = { bound: null, live: false, chosenUid: null, devices: DEVICES, allowVirtual: false };

  it("reports a live bind with an ACTIVITY verb and the bound device's name", () => {
    const s = inputStatus({
      ...base,
      bound: { name: "Yeti Stereo Microphone", uid: "usb-yeti", isVirtual: false },
      live: true,
    });
    expect(s.captureLabel).toBe("Listening");
    expect(s.captureValue).toBe("Yeti Stereo Microphone");
  });

  it("switches to a POINTING verb when a device is bound but capture is not live", () => {
    const s = inputStatus({
      ...base,
      bound: { name: "Yeti Stereo Microphone", uid: "usb-yeti", isVirtual: false },
      live: false,
    });
    expect(s.captureLabel).toBe("Mic");
  });

  it("never lets the two rows contradict each other about a pinned loopback", () => {
    // ── roborev 56208 ───────────────────────────────────────────────────────────────────────────
    // Revoking the opt-in only flips the flag — neither `setAllowVirtualInput(false)` nor its Rust
    // side clears the persisted uid — so "loopback chosen, opt-in off" is reachable. Row 1 read an
    // amber "Selected: BlackHole 2ch" while row 2 read a calm "Off". Both strings were honest in
    // isolation; the PAIRING was the lie, which is exactly the failure `inputStatus` exists to stop.
    //
    // It is also the case where hiding the loopback rows bites: with the opt-in off the device is in
    // neither group, so this row is the ONLY remaining mention of the pinned choice.
    const s = inputStatus({ ...base, chosenUid: "hal-loopback", allowVirtual: false });
    expect(s.captureIsVirtual).toBe(true);
    expect(s.systemAudioValue).toBe(SYSTEM_AUDIO_OFF_STILL_SELECTED);
    // ASSERTED AS THE RELATIONSHIP, not as two literals: whenever row 1 flags a non-microphone, row
    // 2 must not be reading the calm default. That is the invariant; the wording can change.
    expect(s.systemAudioValue).not.toBe(SYSTEM_AUDIO_OFF);
    expect(s.systemAudioIsWarning).toBe(true);

    // …and the ordinary case is untouched: a real microphone with the opt-in off is a calm "Off".
    const clean = inputStatus({ ...base, chosenUid: "builtin-mic", allowVirtual: false });
    expect(clean.captureIsVirtual).toBe(false);
    expect(clean.systemAudioValue).toBe(SYSTEM_AUDIO_OFF);
    expect(clean.systemAudioIsWarning).toBe(false);
  });

  it("reports the CHOICE — never a capture — when nothing has bound", () => {
    // The substitution this refuses is the nine-minutes-of-silence bug: an intent rendered in the
    // present tense as though it were a live capture.
    expect(inputStatus({ ...base, live: true }).captureLabel).toBe("Selected");
    expect(inputStatus({ ...base, live: true }).captureValue).toBe(AUTOMATIC_LABEL);
    expect(inputStatus({ ...base, chosenUid: "builtin-mic" }).captureValue).toBe(BUILTIN.name);
  });

  it("says a pinned device is NOT CONNECTED rather than quietly reading as automatic", () => {
    // The uid is persisted by the backend and the device has since been unplugged. Falling back to
    // "Automatic" would tell the user a choice is in force that cannot be.
    expect(inputStatus({ ...base, chosenUid: "gone-forever" }).captureValue).toBe(CHOSEN_DEVICE_GONE);
  });

  it("marks a non-microphone whether it is BOUND or merely chosen", () => {
    expect(
      inputStatus({ ...base, bound: { name: "BlackHole 2ch", uid: "hal-loopback", isVirtual: true } })
        .captureIsVirtual,
    ).toBe(true);
    // Marked before capture even starts: a pinned loopback must not be the one thing on the pane
    // that looks like a microphone.
    expect(inputStatus({ ...base, chosenUid: "hal-loopback", allowVirtual: true }).captureIsVirtual).toBe(
      true,
    );
    expect(inputStatus({ ...base, chosenUid: "builtin-mic" }).captureIsVirtual).toBe(false);
  });

  it("system audio is OFF by default, and that is not a warning", () => {
    const s = inputStatus(base);
    expect(s.systemAudioValue).toBe(SYSTEM_AUDIO_OFF);
    expect(s.systemAudioIsWarning).toBe(false);
  });

  it("distinguishes merely ALLOWED from being captured RIGHT NOW", () => {
    // The old UI raised one paragraph-long amber banner for both, so a user who opted in last week
    // and is on their built-in mic read the same warning as one whose call is on the stream.
    const allowed = inputStatus({ ...base, allowVirtual: true });
    expect(allowed.systemAudioValue).toBe(SYSTEM_AUDIO_ALLOWED);
    expect(allowed.systemAudioIsWarning).toBe(true);

    const capturing = inputStatus({
      ...base,
      allowVirtual: true,
      bound: { name: "BlackHole 2ch", uid: "hal-loopback", isVirtual: true },
    });
    expect(capturing.systemAudioValue).toBe(SYSTEM_AUDIO_CAPTURING);
  });

  it("claims CAPTURING only from a real bind, never from the choice", () => {
    // The strongest sentence this block can say — your calls are on the stream this second — must
    // not rest on an intent that may never have bound.
    const chosenOnly = inputStatus({ ...base, chosenUid: "hal-loopback", allowVirtual: true });
    expect(chosenOnly.systemAudioValue).toBe(SYSTEM_AUDIO_ALLOWED);
    expect(chosenOnly.systemAudioValue).not.toBe(SYSTEM_AUDIO_CAPTURING);
  });

  it("reports a loopback bind even after the opt-in was revoked", () => {
    // A stale bind from a since-revoked grant. This is the case that makes it safe to hide the
    // loopback rows while the opt-in is off: the fact survives the device leaving the list.
    const s = inputStatus({
      ...base,
      allowVirtual: false,
      bound: { name: "BlackHole 2ch", uid: "hal-loopback", isVirtual: true },
    });
    expect(s.systemAudioValue).toBe(SYSTEM_AUDIO_CAPTURING);
    expect(s.captureIsVirtual).toBe(true);
  });
});

describe("the opt-in's copy — a budget, because the wordiness WAS the bug", () => {
  it("the label names the consequence AND rules out the misreading it produced", () => {
    // A user read "Allow non-microphone inputs (advanced)" as "a checkbox I assume lets me use
    // both" — i.e. as MIXING system audio into the microphone feed. It does not; it unlocks a
    // different device to bind to, one at a time. A label someone can agree to while believing the
    // opposite of what it does is worse than a technical one, because they never find out.
    expect(ALLOW_VIRTUAL_LABEL).toMatch(/system audio/i);
    expect(ALLOW_VIRTUAL_LABEL).toMatch(/instead of a microphone/i);
  });

  it("the consequence fits on ONE line", () => {
    // It was three lines and ~35 words. The founder's complaint — "it's really wordy and not super
    // clear" — is a product constraint, so it gets an assertion rather than a good intention.
    expect(ALLOW_VIRTUAL_CAPTION.split(/\s+/).length).toBeLessThanOrEqual(12);
    // And it still names what is actually at stake, which is the half that must survive the cut.
    expect(ALLOW_VIRTUAL_CAPTION).toMatch(/calls/i);
  });

  it("the status values are short enough to read at a glance", () => {
    for (const v of [SYSTEM_AUDIO_OFF, SYSTEM_AUDIO_ALLOWED, SYSTEM_AUDIO_CAPTURING]) {
      expect(v.split(/\s+/).length).toBeLessThanOrEqual(2);
    }
  });

  it("names where the picker lives, so remedy strings elsewhere cannot rot", () => {
    // voice/dictationCopy builds three user-facing remedies from this. They used to say "hover the
    // mic" and became false the moment the picker moved into Settings.
    expect(INPUT_PICKER_LOCATION).toMatch(/settings/i);
    expect(INPUT_PICKER_LOCATION).not.toMatch(/hover/i);
  });
});
