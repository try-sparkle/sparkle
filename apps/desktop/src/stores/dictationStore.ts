import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Phase } from "../voice/wakeMachine";
import type { FocusOwner } from "../voice/dictationFocus";

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

/** The mic surfaces that can own dictated speech. See {@link DictationState.voiceSurface}. */
export type VoiceSurface = "concierge" | "agent";

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
  /** The FAULT, tracked separately from the NOTICE that reports it: the frame-liveness watchdog has
   *  said audio stopped arriving and has not yet said it resumed.
   *
   *  Why this is not just `classifyVoiceError(error) === "no-audio"`. The notice is dismissible, the
   *  fault is not — the mic does not start working because the user clicked an X. Deriving the fault
   *  from the visible string means a dismissed notice erases the app's memory that the mic is dead,
   *  and the `dictation://audio-recovered` event then arrives with nothing to act on: capture is
   *  live and frames are flowing, but status stays "idle", which `deriveMicState` draws as a PAUSED
   *  mic over a working one, indefinitely, for a user who never leaves the window. Keeping the fact
   *  here lets Dismiss clear only what is on screen while real positive evidence can still land.
   *
   *  Set when a `no-audio` error arrives and cleared by the recovery event; also cleared wherever a
   *  session is torn down, so a stale fault can't outlive the capture it described. Runtime only
   *  (see `partialize`) — a relaunch starts a new capture and knows nothing about the old one. */
  deadMicSilent: boolean;
  /** The active composer's append fn, or null. Set via registerInsert. */
  insertTarget: ((text: string) => void) | null;
  /** WHICH mic surface the user last operated, and therefore where dictated speech belongs.
   *
   *  There is one app-wide `insertTarget` but more than one box that can hold it, so something has
   *  to say who wins. That used to be implicit in the click: the concierge compose box had its own
   *  mic button and claimed the target from its handler, and the agent composer's ComposerMic
   *  claimed from its own (Composer.tsx `claimDictationRef`). Removing the concierge's button left
   *  the wake word — and the top ring, which has no box of its own — with nothing to claim on, so
   *  speech went wherever the last-mounted agent pane had registered. That is the bug this field
   *  fixes: the decision is now explicit state rather than a side effect of which button existed.
   *
   *  Defaults to "concierge" because the ring in the concierge header is the app's primary mic
   *  control and sits directly above the box you talk to Sparkle in — so wake-word activation, which
   *  involves no click at all, routes there. "agent" is set only by an explicit arm on an agent
   *  composer's own mic. Runtime only (never persisted): a relaunch should come back pointing at
   *  the always-present ring, not at whichever pane happened to be focused last session. */
  voiceSurface: VoiceSurface;
  /**
   * Monotonic count of SPEECH-END signals (`dictation://speech-end`) — the auto-send rail's silence
   * clock (PRD §4). Bumped once per utterance the engine believes has ended.
   *
   * A COUNTER, not a boolean, and for the same reason `ConciergeAnnouncement.seq` is one: two
   * consecutive utterances end identically, and a `speechEnded: true` that is already true is a
   * state change nothing can subscribe to. The rail arms its clock on each increment.
   *
   * Deliberately NOT derived from {@link speaking}. That flag is the on-device Silero VAD's edge; on
   * the CLOUD path dictation.rs holds it `true` for the whole stream, so it never falls and a rail
   * watching it would arm and never count. Nor is it "no partial for a while" — that measures
   * transcription LAG, which under load starts ticking while the user is still mid-sentence.
   *
   * Runtime only (see `partialize`): a relaunch must not resurrect a stale utterance boundary.
   */
  speechEndSeq: number;
  /**
   * The ON-DEVICE speaker is talking RIGHT NOW (`dictation://on-device-speech`) — the auto-send
   * countdown's CANCEL, and the on-device counterpart of {@link interim}.
   *
   * A speech-end ARMS the clock on both capture paths. On the cloud path an arriving `interim`
   * un-arms it ("keep talking and it waits"); the on-device path has no interim results at all, so
   * when on-device arming was added, cancelling had no equivalent — a mid-thought pause long enough
   * for the VAD to close a segment could start a clock that resumed speech was unable to stop.
   *
   * A LEVEL, not a pulse, deliberately: the on-device decode runs hundreds of ms behind the audio,
   * so a user who resumes during that gap produces resume-then-arm IN THAT ORDER. A pulse would be
   * consumed before the arm it needs to prevent; a level is still true when the arm lands.
   *
   * ALWAYS FALSE while the cloud owns the audio — Rust guarantees that (`frame_on_device_speech`).
   * The reason is that on the cloud path the cancel belongs to `interim`, which tracks Deepgram's own
   * view of the utterance; a local VAD flag in the same role would fight it, and the VAD is not
   * trustworthy while the relay is consuming the audio. (It is NOT, as this comment previously said,
   * because the waveform's `speaking` flag is pinned true for the whole stream — that stopped being
   * so in the 2026-07-29 dead-mic fix, which made `speaking` the raw VAD on both paths. See
   * roborev 55503.) Runtime only.
   */
  onDeviceSpeech: boolean;
  /** WHO holds the DOM caret in this window right now — "terminal" when it sits in an xterm pane,
   *  "other" for everything else INCLUDING nothing at all (the hands-free wake-word case).
   *
   *  Written only by the focus tracker (voice/dictationFocusTracker), and only when the answer
   *  changes. It is an OBSERVATION, not a decision: `dictationPauseReason` turns it (plus
   *  {@link windowFocused} and {@link enabled}) into the one verdict that both the routing gate and
   *  both mic surfaces' copy read, so what we transcribe and what we claim can't disagree.
   *
   *  Runtime only (never in `partialize`): where the caret was last session says nothing about
   *  where it is now, and a persisted "terminal" would come back as a mic paused for no visible
   *  reason. */
  focusOwner: FocusOwner;
  /** Is THIS window the active OS window? Tracked alongside {@link focusOwner} purely so the paused
   *  COPY is reactive — a component can't subscribe to `document.hasFocus()`. The routing gate in
   *  useDictation keeps using its own live per-window check (`isWindowActive`), which is the
   *  authoritative, race-free signal for "should this window consume the broadcast".
   *
   *  Defaults TRUE so a window-less/test environment, or the moment before the tracker installs,
   *  fails OPEN (dictation routes) rather than pausing a mic nothing can un-pause. Runtime only. */
  windowFocused: boolean;

  setStatus: (s: Status) => void;
  setLevel: (l: number) => void;
  setSpeaking: (v: boolean) => void;
  /** The engine says the speaker stopped — bump {@link speechEndSeq}. */
  noteSpeechEnd: () => void;
  /** The on-device speaker started/stopped talking — see {@link onDeviceSpeech}. */
  setOnDeviceSpeech: (v: boolean) => void;
  /** Replace the live interim preview (cloud path). Pass "" to clear it. */
  setInterim: (text: string) => void;
  /** Setting a non-null value also transitions status to "error". Clearing with
   *  null only returns to "idle" if we were in the "error" state — an active
   *  "listening" session is left untouched. */
  setError: (e: string | null) => void;
  /** Record (or clear) the dead-mic fault — see {@link deadMicSilent}. */
  setDeadMicSilent: (v: boolean) => void;
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
  /** Record which mic surface the user just operated. Called from the mic controls themselves —
   *  the concierge ring (LogoWaveform) and the agent composer's ComposerMic — so the arbiter is
   *  set by the same gesture that arms the mic. */
  setVoiceSurface: (s: VoiceSurface) => void;
  /** Record who holds the caret (focus tracker only). No-op when unchanged, so a focus move between
   *  two non-terminal elements never wakes a subscriber. */
  setFocusOwner: (o: FocusOwner) => void;
  /** Record whether this window is the active OS window (focus tracker only). No-op when
   *  unchanged. */
  setWindowFocused: (v: boolean) => void;
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
      deadMicSilent: false,
      insertTarget: null,
      voiceSurface: "concierge",
      speechEndSeq: 0,
      onDeviceSpeech: false,
      focusOwner: "other",
      windowFocused: true,

      setStatus: (status) => set({ status }),
      setLevel: (level) => set({ level }),
      setSpeaking: (speaking) => set({ speaking }),
      noteSpeechEnd: () => set((s) => ({ speechEndSeq: s.speechEndSeq + 1 })),
      setOnDeviceSpeech: (onDeviceSpeech) =>
        set((s) => (s.onDeviceSpeech === onDeviceSpeech ? s : { onDeviceSpeech })),
      setInterim: (interim) => set({ interim }),
      setError: (error) =>
        set((s) => ({
          error,
          status: error ? "error" : s.status === "error" ? "idle" : s.status,
        })),
      setDeadMicSilent: (deadMicSilent) => set({ deadMicSilent }),
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
      setVoiceSurface: (voiceSurface) => set({ voiceSurface }),
      // Returning the SAME state object is how zustand is told "nothing changed" — it skips the
      // notification entirely, so an unchanged focus observation costs no subscriber wakeups.
      setFocusOwner: (focusOwner) => set((s) => (s.focusOwner === focusOwner ? s : { focusOwner })),
      setWindowFocused: (windowFocused) =>
        set((s) => (s.windowFocused === windowFocused ? s : { windowFocused })),
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
