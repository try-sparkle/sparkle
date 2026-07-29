// The audio INPUT DEVICE contract: which microphone Sparkle actually opens, and whether it is
// allowed to open something that is not a microphone at all.
//
// WHY THIS MODULE EXISTS. Sparkle used to open "whatever macOS calls the default input" and never
// told the user what that was. Two incidents on the same day, same root cause:
//
//   (a) A screen recorder's CoreAudio HAL plug-in took the default-input slot, and Sparkle captured
//       ZERO audio for nine minutes while every mic surface cheerfully rendered "listening".
//   (b) Sparkle transcribed a Twitch stream the user was merely LISTENING to straight into the
//       composer — and, earlier the same day, fragments of other people's conversations.
//
// Neither is a transcription bug. Both are the same missing fact: several HAL plug-ins exist
// specifically to republish system AUDIO OUTPUT as an input device, so "the default input" is not
// reliably a microphone. On the machine that hit this, EIGHT were installed.
//
// THE PROMISE THIS MODULE PROTECTS. "Sparkle listens to your microphone" and "Sparkle can
// transcribe anything playing on this machine" are materially different promises, and users assume
// the first. So: the chosen device is always visible, a non-microphone input is always MARKED as
// one, and binding to a non-microphone requires an explicit, off-by-default opt-in whose label
// states the consequence rather than the mechanism.
//
// STATE LIVES IN ../stores/audioInputStore — deliberately NOT in dictationStore. This is device
// identity, not dictation phase, and the two have different lifetimes (a device rebind happens
// without any phase change, and a phase change must not invalidate the device).
//
// Every wrapper here is `async` and swallows its own failure. That is load-bearing rather than
// sloppy: `invoke` THROWS SYNCHRONOUSLY outside a Tauri webview (no `__TAURI_INTERNALS__`), and
// these run from render/hover paths that are also exercised in jsdom tests with no Tauri at all.
// Being async turns that sync throw into a rejection the caller's `.catch` can actually see, and
// swallowing keeps a missing backend from taking down a mic menu.
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { safeUnlisten } from "./safeUnlisten";
import { useAudioInputStore } from "../stores/audioInputStore";
// READ-ONLY dependency: this module never writes dictation state, it only needs to know when the
// mic disarms so a stale bind can be cleared. Device state deliberately stays in its own store.
import { useDictationStore } from "../stores/dictationStore";

/** One selectable capture device, as reported by the Rust side's CoreAudio enumeration. */
export interface AudioInput {
  /** Stable per-device identity. This — never the display name — is what we persist and send back,
   *  because names collide ("Microphone") and are localized. */
  uid: string;
  name: string;
  /** This is what macOS would pick on its own. Shown as a hint on the Automatic row. */
  isDefault: boolean;
  /** NOT a microphone: a HAL plug-in / loopback / aggregate that can publish system OUTPUT as an
   *  input. The single most important bit in this module — every privacy affordance keys off it. */
  isVirtual: boolean;
  /** The machine's own built-in mic. Purely informational (a reassuring hint), never a gate. */
  isBuiltin: boolean;
}

/** The user's persisted choice. `chosenUid === null` means AUTOMATIC — let the backend follow the
 *  system default. That is the default state, and it is why the picker needs an explicit Automatic
 *  row rather than treating "nothing selected" as an empty list. */
export interface AudioInputSettings {
  chosenUid: string | null;
  allowVirtual: boolean;
}

/** The authoritative "what am I listening to RIGHT NOW" signal, emitted by Rust on every bind.
 *  Distinct from {@link AudioInputSettings.chosenUid} on purpose: the chosen uid is an INTENT that
 *  can silently fail to bind (device unplugged, taken by another app), and reporting an intent as
 *  though it were a live capture is exactly the nine-minutes-of-silence failure. */
export interface BoundDevice {
  name: string;
  uid: string | null;
  isVirtual: boolean;
}

/** The Automatic row's label. Exported so the picker and its tests can't drift on the wording. */
export const AUTOMATIC_LABEL = "Automatic (recommended)";

/** The marker shown on every non-microphone input, in the list AND next to the live device. Says
 *  what the device IS from the user's point of view ("system audio"), not what it is technically
 *  ("virtual HAL device") — the user is deciding whether their calls and videos get transcribed,
 *  and the technical term does not answer that question. */
export const VIRTUAL_MARKER = "System audio";

/** The advanced opt-in's label. States the CONSEQUENCE, not the mechanism: a label reading
 *  "Allow virtual audio devices" is one a user can agree to without ever learning that agreeing
 *  lets Sparkle hear their Zoom calls. */
export const ALLOW_VIRTUAL_LABEL = "Allow non-microphone inputs (advanced)";

/** The full consequence, shown under the toggle. */
export const ALLOW_VIRTUAL_CAPTION =
  "Lets Sparkle bind to a loopback or virtual input. It can then transcribe anything playing on this machine — calls, videos, streams — not just your voice.";

/** Shown in the menu whenever the opt-in is ON, so an enabled advanced setting is never something
 *  the user has to go looking for. */
export const ALLOW_VIRTUAL_ACTIVE_WARNING =
  "Non-microphone inputs are allowed — Sparkle can transcribe what's playing on this machine, not just your voice.";

/** Shown beside the live device whenever the thing Sparkle is actually bound to is not a mic. */
export const BOUND_VIRTUAL_WARNING =
  "This is not a microphone — it can capture system audio.";

/**
 * Shown when a GRANT was refused by the backend.
 *
 * Because the grant only applies once Rust confirms it, a failure otherwise leaves the checkbox
 * simply un-ticked — identical to never having clicked it. The user gets no way to tell "it worked",
 * "it is still going" and "it will never work" apart, and their only recourse is to keep clicking a
 * dead control.
 *
 * It does NOT say "nothing changed", which an earlier draft did. The frontend cannot know that: an
 * `invoke` rejection also covers a transport failure that happened AFTER Rust persisted the grant,
 * so the reassuring version was a claim about the backend made with no evidence — on the one
 * control protecting the "we listen to your microphone" promise (roborev 55351). The failure arm
 * re-reads the backend instead, and this string only reports what we actually observed.
 */
export const ALLOW_VIRTUAL_FAILED =
  "Couldn't confirm this — Sparkle's audio backend didn't respond. Check the box again.";

/**
 * The caption for the live device — `Listening: MacBook Pro Microphone` while capture is genuinely
 * live, `Mic: MacBook Pro Microphone` when it is not.
 *
 * THE VERB IS PHASE-AWARE, and that is not decoration. This line renders directly beneath
 * captionFor's output, and in the focus-paused state that line reads "Listening paused: Will
 * auto-resume when you re-focus on this project." A fixed "Listening: …" underneath re-asserts, in
 * the present tense, the exact capture the line above just retracted — reintroducing the class of
 * lie this feature exists to remove, one line below the honest version of it. So `live` false
 * switches to a POINTING statement ("Mic:" — this is what it is aimed at) rather than an ACTIVITY
 * one ("Listening:" — this is what it is doing right now).
 *
 * Returns null when nothing has bound, so the surface renders nothing rather than a placeholder
 * that would imply a capture that isn't happening. Pure, so the wording is pinned by a unit test
 * instead of by a DOM assertion.
 */
export function boundDeviceCaption(bound: BoundDevice | null, live: boolean): string | null {
  if (!bound) return null;
  return `${live ? "Listening" : "Mic"}: ${bound.name}`;
}

/**
 * May the user bind to this device right now?
 *
 * A virtual input stays visible in the list while the opt-in is off — hiding it would leave the
 * user unable to understand why Sparkle picked something odd, and unable to find the setting that
 * governs it. It is simply not SELECTABLE until they turn the advanced toggle on and read what it
 * costs them. Pure, and the picker's click handler is gated on it, so "shown but refused" is one
 * decision rather than two that can drift.
 */
export function isDeviceSelectable(device: AudioInput, allowVirtual: boolean): boolean {
  return allowVirtual || !device.isVirtual;
}

/** Enumerate the machine's capture devices. Returns [] rather than throwing when the backend is
 *  unavailable, so a mic menu opened outside Tauri (or before the backend is ready) still renders
 *  its Automatic row instead of blowing up. */
export async function listAudioInputs(): Promise<AudioInput[]> {
  try {
    return (await invoke<AudioInput[]>("list_audio_inputs")) ?? [];
  } catch (e) {
    console.debug("audioInputs: list_audio_inputs failed", e);
    return [];
  }
}

/** Read the persisted choice + advanced opt-in. Returns null when unavailable so the caller can
 *  leave the store at its safe defaults (automatic, virtual NOT allowed) rather than inventing a
 *  permissive one. */
export async function getAudioInputSettings(): Promise<AudioInputSettings | null> {
  try {
    return (await invoke<AudioInputSettings>("get_audio_input_settings")) ?? null;
  } catch (e) {
    console.debug("audioInputs: get_audio_input_settings failed", e);
    return null;
  }
}

/** Bind capture to `uid`, or back to the system default when null. Optimistically records the
 *  choice so the picker's checkmark moves immediately; the authoritative confirmation is the
 *  `dictation://device` event that follows the actual rebind.
 *
 *  On failure the optimistic write is ROLLED BACK to the previous choice. Leaving it applied would
 *  park a checkmark on a device that was never bound — a small lie, but the same kind as the one
 *  this module exists to remove, and the user has no other way to notice it. */
export async function setAudioInput(uid: string | null): Promise<void> {
  const store = useAudioInputStore.getState();
  const previous = store.chosenUid;
  store.setChosenUid(uid);
  // Sampled AFTER our own write, so it only moves if someone else's intent lands later.
  const epoch = useAudioInputStore.getState().intentEpoch;
  try {
    await invoke("set_audio_input", { uid });
  } catch (e) {
    // warn, not debug: a rebind that did not happen leaves the UI claiming the wrong microphone.
    console.warn("audioInputs: set_audio_input failed", e);
    // ONLY roll back our own write. A CoreAudio rebind is exactly the slow, failure-prone
    // operation this module is about, so two picks can overlap: pick Yeti (slow, will fail), pick
    // Built-in (fast, succeeds), then Yeti's rejection arrives. An unconditional rollback would
    // restore "Yeti" — parking the checkmark on the device whose bind FAILED while capture runs on
    // the built-in mic, and leaving the caption and the list contradicting each other. That is the
    // very failure the rollback was added to prevent, merely aimed at a different wrong device.
    if (useAudioInputStore.getState().intentEpoch !== epoch) {
      console.debug("audioInputs: not rolling back — a newer choice superseded this one");
      return;
    }
    store.setChosenUid(previous);
  }
}

/**
 * Turn the advanced non-microphone opt-in on/off.
 *
 * ASYMMETRIC ON PURPOSE — this is the one setting whose two directions have different failure
 * costs, so they get different treatments:
 *
 *   • REVOKE (`false`) applies immediately, before the round-trip. If the call then fails, the UI
 *     is stricter than the backend, which is the harmless direction.
 *   • GRANT (`true`) applies ONLY after Rust confirms. Optimism here is a fail-OPEN: `isDeviceSelectable`
 *     is gated purely on this flag, so a grant that never reached the backend would let the user
 *     pick a loopback input the backend still refuses — the UI would show a system-audio device
 *     selected and bound when it is neither. That directly contradicts the fail-closed invariant
 *     audioInputStore documents, and fails open on the single control protecting the "we listen to
 *     your microphone" promise.
 */
export async function setAllowVirtualInput(allow: boolean): Promise<void> {
  const store = useAudioInputStore.getState();

  if (!allow) {
    // REVOKE — apply at once and tell the backend after. A UI stricter than the backend is the
    // harmless direction, so this never waits on a round-trip.
    store.setAllowVirtual(false);
    store.setGrantFailed(false);
    try {
      await invoke("set_allow_virtual_input", { allow: false });
    } catch (e) {
      console.warn("audioInputs: set_allow_virtual_input(false) failed", e);
    }
    return;
  }

  // GRANT — confirm first, then apply ONLY if the user has not changed their mind meanwhile.
  //
  // The epoch guard is not belt-and-braces; without it the fail-open simply moves one step later.
  // The grant deliberately leaves the store untouched while in flight, so `intentEpoch` does not
  // move — meaning a `refreshAudioInputs` already pending can apply the backend's persisted
  // `{allowVirtual: true}` (setSettings does not bump the epoch), the checkbox renders checked, the
  // user unchecks it, and THEN the original grant resolves and re-opens the gate. The backend saw
  // `true, false` and refuses virtual inputs; the store would say `true`, offering every loopback
  // row under an "allowed" banner for a permission that is off.
  // One grant at a time. A grant does not bump `intentEpoch` while in flight (deliberately — see
  // above), so two clicks on the still-unchecked box fire two grants against the SAME epoch. If one
  // fails and the other succeeds, the failure arm runs first, bumps the epoch via
  // setAllowVirtual(false), and the epoch guard then discards the SUCCESSFUL grant — leaving the
  // backend allowing virtual inputs while the UI says it is off (roborev 55351).
  if (grantInFlight) {
    console.debug("audioInputs: ignoring a grant — one is already in flight");
    return;
  }
  // Clear the previous failure NOW, not on success: leaving it up for the whole retry window
  // recreates the exact "still going or will never work?" ambiguity this message exists to remove.
  store.setGrantFailed(false);
  grantInFlight = true;
  const epoch = store.intentEpoch;
  try {
    await invoke("set_allow_virtual_input", { allow: true });
    if (useAudioInputStore.getState().intentEpoch !== epoch) {
      console.debug("audioInputs: dropping a late grant — the user revoked while it was in flight");
      return;
    }
    store.setAllowVirtual(true);
    store.setGrantFailed(false);
  } catch (e) {
    // warn, not debug: the opt-in silently not taking effect is a privacy-relevant failure, not
    // routine noise.
    console.warn("audioInputs: set_allow_virtual_input(true) failed", e);
    // Same guard on the failure arm: a stale rejection must not shut a gate the user has since
    // legitimately re-opened.
    if (useAudioInputStore.getState().intentEpoch !== epoch) return;
    // RECONCILE, don't assert. A rejection does not prove the grant didn't land — the transport can
    // fail after Rust persisted it — and guessing "off" here is not the safe default it looks like:
    // the very next refreshAudioInputs (every menu open) would read the backend's `true`, re-open
    // the gate, and leave a red "couldn't enable" banner beside a now-checked box. So ask the
    // backend what it actually believes, and fail CLOSED only when it will not say.
    const actual = await getAudioInputSettings();
    if (useAudioInputStore.getState().intentEpoch !== epoch) return;
    store.setAllowVirtual(actual?.allowVirtual ?? false);
    store.setGrantFailed(true);
  } finally {
    grantInFlight = false;
  }
}

/** Whether a GRANT round-trip is outstanding. Module-level because it guards a user gesture, not a
 *  render: two clicks land in two separate calls, and both must see the same flag. */
let grantInFlight = false;

/**
 * Pull the device list + settings into the store. Called when a picker opens (devices are hot-
 * pluggable, so a list cached at startup goes stale the moment a headset is plugged in).
 *
 * The settings write is guarded by `intentEpoch` because this call OVERLAPS ordinary interaction:
 * the menu's list is already rendered and clickable from the previous open, so a click can land
 * while this round-trip is still in flight. Applying a response that predates the user's choice
 * would revert the checkmark onto a device capture is no longer using — and silently flip a
 * just-granted opt-in back off. The DEVICE LIST is applied unconditionally; it is hardware state,
 * not user intent, so it can never be stale in a way that contradicts the user.
 */
export async function refreshAudioInputs(): Promise<void> {
  const epoch = useAudioInputStore.getState().intentEpoch;
  const [devices, settings] = await Promise.all([listAudioInputs(), getAudioInputSettings()]);
  const store = useAudioInputStore.getState();
  store.setDevices(devices);
  if (!settings) return;
  if (store.intentEpoch !== epoch) {
    console.debug("audioInputs: dropping stale settings — the user chose while it was in flight");
    return;
  }
  store.setSettings(settings);
}

/**
 * Is this event payload actually a {@link BoundDevice}?
 *
 * A truthiness check is not enough, and the reason is concrete: serde defaults to SNAKE_CASE, so a
 * Rust struct that lands without `#[serde(rename_all = "camelCase")]` emits `is_virtual` and a
 * `name` this side never reads. That payload is perfectly truthy — it would sail through, render
 * "Listening: undefined", and mark a loopback device as a microphone, with no diagnostic anywhere.
 * That is the precise failure this whole feature exists to prevent, arriving through the door we
 * built to prevent it.
 *
 * So: validate, and on a mismatch say NOTHING (render no device) and warn loudly, rather than
 * assert something false. `uid` is deliberately not required — null is its legitimate "system
 * default" value.
 */
function isBoundDevice(payload: unknown): payload is BoundDevice {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return typeof p.name === "string" && p.name.length > 0 && typeof p.isVirtual === "boolean";
}

/**
 * Subscribe to `dictation://device` — Rust emits it every time capture BINDS to a device, which
 * makes it the only trustworthy answer to "what is Sparkle hearing". Writes straight into the
 * store so every surface reads one value.
 */
export async function subscribeBoundDevice(): Promise<UnlistenFn | null> {
  try {
    return await listen<unknown>("dictation://device", (e) => {
      if (isBoundDevice(e.payload)) {
        useAudioInputStore.getState().setBound(e.payload);
        return;
      }
      console.warn(
        "audioInputs: ignoring malformed dictation://device payload (wire-contract mismatch?)",
        e.payload,
      );
    });
  } catch (e) {
    console.warn("audioInputs: dictation://device subscribe failed", e);
    return null;
  }
}

/**
 * Mount-once wiring for any surface that shows the live device: loads the persisted settings and
 * keeps the store's `bound` field current from the event stream. Safe to call from more than one
 * component — each gets its own listener and tears it down through {@link safeUnlisten}.
 *
 * EVERY surface that renders the device must call this itself rather than relying on a sibling
 * having done so. A component whose headline feature only works when some other component happens
 * to be mounted is inert in any window that does not mount it — and its test still passes, because
 * a test can poke the store directly.
 */
export function useAudioInputSync(): void {
  useEffect(() => {
    let unlisten: Promise<UnlistenFn | null> | null = subscribeBoundDevice();
    void refreshAudioInputs();
    return () => {
      const pending = unlisten;
      unlisten = null;
      void safeUnlisten(pending);
    };
  }, []);

  // A DISARMED MIC HAS NO BOUND DEVICE, and nothing else will say so: `dictation://device` is only
  // emitted on a successful BIND, so without this the store latches the last device that ever bound
  // — for the rest of the process. The user mutes with a Yeti bound, unplugs it, re-arms, and the
  // caption reappears naming a microphone that is not connected, before any bind has occurred. If
  // the re-bind then fails, no event ever arrives to correct it, so it asserts a live capture from
  // absent hardware indefinitely — the nine-minutes-of-silence state, reconstructed by the very
  // component meant to expose it. The latched virtual case is worse: an amber "this can capture
  // system audio" warning that outlives the rebind to a real microphone.
  const enabled = useDictationStore((s) => s.enabled);
  useEffect(() => {
    if (!enabled) useAudioInputStore.getState().setBound(null);
  }, [enabled]);
}
