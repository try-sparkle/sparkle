import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Phase } from "../voice/wakeMachine";

/** localStorage key for the persisted slice (only `enabled`). Exported so the cross-window
 *  sync service can rehydrate on the browser `storage` event. */
export const DICTATION_PERSIST_KEY = "sparkle-dictation";

/** How long the "out of credits" mic notice stays up before we auto-deactivate the mic and clear
 *  it. Voice spends credits, so an arm attempt while the balance is empty is refused: we flash this
 *  notice, then after this delay force the mic off (belt-and-braces: it was never armed) and drop
 *  the notice. Exported so tests can advance fake timers by exactly this amount. */
export const OUT_OF_CREDITS_NOTICE_MS = 5000;

// Single pending auto-clear timer for the out-of-credits notice. Module-level (not stored in the
// zustand state) so a fresh attempt can cancel-and-restart the 5s countdown without threading a
// timer id through the store — see showOutOfCreditsNotice/clearOutOfCreditsNotice.
let outOfCreditsTimer: ReturnType<typeof setTimeout> | null = null;

type Status = "idle" | "listening" | "error";

interface ModelProgress {
  done: number;
  total: number | null;
}

interface DictationState {
  status: Status;
  level: number;
  /** Real-time "is the user speaking right now?" flag from the backend Silero VAD
   *  (`dictation://speaking`). Drives the waveform animation: the meter only moves while
   *  this is true, so it sits as a flat, static line in silence instead of wiggling on
   *  ambient noise. Distinct from `level` (raw loudness, used only for bar HEIGHT). */
  speaking: boolean;
  error: string | null;
  /** Non-null ONLY while the backend is downloading the whisper model — which makes it the one
   *  signal that tells a cold first run apart from a warm start (an install that already has the
   *  model never emits it). The mic surfaces derive their "preparing" state from exactly that (see
   *  MicButton.deriveMicState), so an armed-but-not-yet-usable mic stops impersonating a ready one.
   *
   *  `done`/`total` count the COMPRESSED tarball as it streams (~482 MB — that's the response's
   *  content-length), NOT the ~631 MB the model occupies once unpacked on disk. So 100% here means
   *  "fully downloaded, unpack still to go", which is why the copy says "Setting up voice" rather
   *  than "Downloading" — see voice/dictationCopy.ts. `total` is null when the server sends no
   *  content-length, in which case there is no honest percentage to show. */
  modelProgress: ModelProgress | null;
  /** Live, un-committed transcript from the cloud streaming engine (Deepgram interim results).
   *  Shown as a ghosted preview that updates word-by-word; replaced in place on each interim and
   *  cleared when the segment finalizes (committed via the normal partial → insert path). Always
   *  "" on the on-device path, which has no interim results. */
  interim: string;

  // --- ambient always-listening ---
  /** Mic hot (master mute). Default FALSE — the ambient mic is opt-in, so a fresh install doesn't
   *  fire the OS mic-permission prompt or load the VAD/wake-word model during cold start. Persisted
   *  and synced across all windows, so a user who turns it on stays on across windows and relaunch
   *  (only the DEFAULT changed — existing persisted `enabled: true` preferences are untouched). */
  enabled: boolean;
  /** passive = hearing but not typing; active = routing speech to the box. Persisted and synced
   *  across all windows (like `enabled`), so the active/paused status the user selects carries when
   *  they focus a different project — reset to `passive` on a true cold start (see windowContext). */
  phase: Phase;
  /** Transient: the "You are out of credits. Refill to activate voice." notice is showing. Set
   *  when the user tries to ARM the mic while out of credits (the arm is refused instead). Both mic
   *  surfaces (composer + top-left bar) subscribe to it, so the message shows in both at once. Runtime
   *  only — never persisted (partialize keeps just `enabled`), so it can't survive a relaunch. */
  outOfCreditsNotice: boolean;
  /** The active composer's append fn, or null. Set via registerInsert. */
  insertTarget: ((text: string) => void) | null;

  setStatus: (s: Status) => void;
  setLevel: (l: number) => void;
  setSpeaking: (v: boolean) => void;
  /** Replace the live interim preview (cloud path). Pass "" to clear it. */
  setInterim: (text: string) => void;
  /** Setting a non-null value also transitions status to "error". Clearing with
   *  null only returns to "idle" if we were in the "error" state — an active
   *  "listening" session is left untouched. */
  setError: (e: string | null) => void;
  setModelProgress: (p: ModelProgress | null) => void;

  setEnabled: (v: boolean) => void;
  setPhase: (p: Phase) => void;
  togglePhase: () => void;
  /** Refuse-to-arm feedback: show the out-of-credits notice and start (or restart) the 5s
   *  auto-deactivate countdown. Does NOT arm the mic — the caller skips setEnabled(true) entirely.
   *  When the timer fires it forces `enabled: false` (safety) and clears the notice. */
  showOutOfCreditsNotice: () => void;
  /** Clear the notice immediately and cancel any pending auto-deactivate timer. */
  clearOutOfCreditsNotice: () => void;
  registerInsert: (fn: ((text: string) => void) | null) => void;
  insert: (text: string) => void;
}

export const useDictationStore = create<DictationState>()(
  persist(
    (set, get) => ({
      status: "idle",
      level: 0,
      speaking: false,
      error: null,
      modelProgress: null,
      interim: "",

      enabled: false, // opt-in: no mic-permission prompt / model load on a fresh cold start
      phase: "passive",
      outOfCreditsNotice: false,
      insertTarget: null,

      setStatus: (status) => set({ status }),
      setLevel: (level) => set({ level }),
      setSpeaking: (speaking) => set({ speaking }),
      setInterim: (interim) => set({ interim }),
      setError: (error) =>
        set((s) => ({
          error,
          status: error ? "error" : s.status === "error" ? "idle" : s.status,
        })),
      setModelProgress: (modelProgress) => set({ modelProgress }),

      setEnabled: (enabled) => set({ enabled }),
      setPhase: (phase) => set({ phase }),
      togglePhase: () => set((s) => ({ phase: s.phase === "passive" ? "active" : "passive" })),
      showOutOfCreditsNotice: () => {
        set({ outOfCreditsNotice: true });
        // Cancel any in-flight countdown so each new attempt gets a fresh 5s of notice.
        if (outOfCreditsTimer) clearTimeout(outOfCreditsTimer);
        outOfCreditsTimer = setTimeout(() => {
          outOfCreditsTimer = null;
          // Force the mic off (belt-and-braces: an arm attempt never armed it) and drop the notice.
          set({ enabled: false, outOfCreditsNotice: false });
        }, OUT_OF_CREDITS_NOTICE_MS);
      },
      clearOutOfCreditsNotice: () => {
        if (outOfCreditsTimer) {
          clearTimeout(outOfCreditsTimer);
          outOfCreditsTimer = null;
        }
        set({ outOfCreditsNotice: false });
      },
      registerInsert: (insertTarget) => set({ insertTarget }),
      insert: (text) => {
        const fn = get().insertTarget;
        if (fn) fn(text);
      },
    }),
    {
      name: DICTATION_PERSIST_KEY,
      storage: createJSONStorage(() => localStorage),
      // Persist the two user-facing mic settings so they carry across all windows (and relaunch):
      // `enabled` (on/off) and `phase` (paused vs. actively listening). Everything else (mic level,
      // status, download progress, the live insert callback) is per-session runtime that must not
      // persist. NOTE: a persisted `phase: "active"` is reset to "passive" on a true cold start by
      // the main window (see windowContext.tsx) so relaunching never resumes mid-dictation.
      partialize: (s) => ({ enabled: s.enabled, phase: s.phase }),
    },
  ),
);
