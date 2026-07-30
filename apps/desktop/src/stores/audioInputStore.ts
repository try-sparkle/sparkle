// Which capture device Sparkle is bound to, and which one the user asked for.
//
// A SEPARATE store from dictationStore on purpose. dictationStore owns the dictation SESSION —
// armed/phase/interim/level — all of which churn many times a second and reset whenever the user
// mutes. Device identity has an entirely different lifetime: a rebind happens with no phase change
// at all (a headset is unplugged mid-sentence), and muting the mic must not forget which device the
// user chose. Folding these together would also put a hot, per-audio-frame store in the dependency
// path of a menu that only ever changes when hardware does.
//
// NOT persisted here. The chosen uid and the advanced opt-in are owned by the Rust side
// (`get_audio_input_settings`), because the BACKEND is what has to honour them when it opens the
// stream — a localStorage copy could disagree with what is actually being captured, which is the
// precise class of lie this whole feature exists to eliminate. This store is a cache of that truth
// plus the live bind reported over `dictation://device`.
import { create } from "zustand";
import type { AudioInput, AudioInputSettings, BoundDevice } from "../services/audioInputs";

interface AudioInputState {
  /** Every capture device the machine currently publishes. Hot-pluggable, so refreshed when a
   *  picker opens rather than cached once at startup. */
  devices: AudioInput[];
  /** The user's INTENT. null = automatic (follow the system default). */
  chosenUid: string | null;
  /** The advanced opt-in. OFF by default, and the default matters: it is what keeps a fresh install
   *  from ever binding to a loopback device that would transcribe the user's calls. */
  allowVirtual: boolean;
  /** What capture is ACTUALLY bound to, straight from `dictation://device`. null until the first
   *  bind — surfaces must render nothing rather than guess, since guessing here is what let a
   *  silent nine-minute capture look healthy. */
  bound: BoundDevice | null;

  /**
   * Monotonic counter bumped by every LOCAL user intent ({@link setChosenUid} /
   * {@link setAllowVirtual}), and deliberately NOT by {@link setSettings}.
   *
   * It exists to settle a last-writer race that is otherwise invisible. A picker refreshes its
   * settings each time it opens, but the list is already rendered and clickable from the previous
   * open — so a fast click lands while that round-trip is still in flight, and the older response
   * then resolves and reverts the user's choice to whatever the backend knew a moment ago. The
   * checkmark would sit on a device capture is no longer using, which is the exact
   * UI-disagrees-with-reality class this module exists to eliminate. `refreshAudioInputs` samples
   * this before its awaits and drops the settings write if it moved.
   */
  intentEpoch: number;

  /** The last GRANT of the advanced opt-in was refused by the backend. Drives the picker's inline
   *  error; without it a failed grant is indistinguishable from never having clicked, because the
   *  grant deliberately does not apply optimistically. Cleared by a success or any revoke. */
  grantFailed: boolean;

  /**
   * A GRANT round-trip is outstanding. Deduplicates the impatient second click, which would
   * otherwise fire a second grant against the same {@link intentEpoch} (roborev 55351).
   *
   * IN THE STORE, not a module-level `let` in audioInputs.ts, and that is a testing property rather
   * than a rendering one. As module state it had no reset path reachable from outside the module,
   * so any test leaving a grant unsettled — the natural shape for testing pending behaviour — made
   * every later `setAllowVirtualInput(true)` in that file a silent no-op, and the tests after it
   * passed VACUOUSLY against state a previous test had left behind (roborev 55411). Here the
   * suite's existing `setState` reset clears it like any other field.
   */
  grantPending: boolean;

  setDevices: (devices: AudioInput[]) => void;
  /** Apply the BACKEND's persisted view. Does not bump {@link intentEpoch} — it is not an intent,
   *  and bumping here would make every refresh look like a user action to the next refresh. */
  setSettings: (settings: AudioInputSettings) => void;
  setChosenUid: (uid: string | null) => void;
  setAllowVirtual: (allow: boolean) => void;
  setBound: (bound: BoundDevice | null) => void;
  setGrantFailed: (failed: boolean) => void;
  setGrantPending: (pending: boolean) => void;
}

export const useAudioInputStore = create<AudioInputState>()((set) => ({
  devices: [],
  chosenUid: null,
  // Fail CLOSED. Anything that reads this before the backend answers must conclude "not allowed",
  // never "allowed" — a permissive default would open a window in which a virtual input is
  // selectable purely because the settings round-trip hadn't finished.
  allowVirtual: false,
  bound: null,
  intentEpoch: 0,
  grantFailed: false,
  grantPending: false,

  setDevices: (devices) => set({ devices }),
  setSettings: ({ chosenUid, allowVirtual }) => set({ chosenUid, allowVirtual }),
  setChosenUid: (chosenUid) => set((s) => ({ chosenUid, intentEpoch: s.intentEpoch + 1 })),
  setAllowVirtual: (allowVirtual) => set((s) => ({ allowVirtual, intentEpoch: s.intentEpoch + 1 })),
  setBound: (bound) => set({ bound }),
  setGrantFailed: (grantFailed) => set({ grantFailed }),
  setGrantPending: (grantPending) => set({ grantPending }),
}));
