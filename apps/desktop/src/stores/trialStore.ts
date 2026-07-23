// Mirrors the SERVER-authoritative trial meter into a Zustand store the gate + composer read.
// `started` = the user tapped "Try it now" (a local UX flag); everything that meters money —
// `remaining`, `blocked` — comes from orchestration via Rust (trial_remote.rs), keyed by the
// keychain device token. Deleting trial.json therefore can't re-grant a trial.
//
// Three reads, deliberately distinct:
//   • refresh()    — local, instant, no network. Runs at startup so the gate never waits on HTTP.
//   • syncRemote() — the authoritative reconcile. AuthGate runs it once auth resolves, and ONLY for
//                    a non-entitled user, so a paid user never touches the trial endpoints at all.
//   • consume()    — the hot path (one prompt), via trialMeter.recordTrialSend.
import { create } from "zustand";
import {
  fetchTrial,
  startTrial,
  syncTrial,
  consumeTrial,
  TRIAL_LIMIT,
  type TrialMeter,
} from "../services/trialApi";

// Re-exported so trial consumers (the meter, chrome) get the cap from one place.
export { TRIAL_LIMIT };

interface TrialStore {
  started: boolean;
  promptsUsed: number;
  /** Last-known remaining prompts; null until the server has been reached on this machine. */
  remaining: number | null;
  cap: number | null;
  /** HARD BLOCK — the server affirmatively refused. Never set by a network failure. */
  blocked: boolean;
  loading: boolean;
  /** The last trial read/write threw (e.g. a corrupt device-local `trial.json`, which Rust treats
   *  as a HARD error — deliberately, so corruption can't paint a bogus "fresh trial" UI). Surfaced
   *  as a recoverable UI state (a Welcome banner) rather than leaving the gate stuck on `loading`
   *  forever. Cleared on the next successful read. */
  error: boolean;
  refresh: () => Promise<void>;
  syncRemote: () => Promise<void>;
  start: () => Promise<void>;
  consume: () => Promise<void>;
}

/** Fold a meter reading from Rust into store state. */
function fromMeter(m: TrialMeter) {
  return {
    started: m.started,
    promptsUsed: m.promptsUsed,
    remaining: m.remaining,
    cap: m.cap,
    blocked: m.blocked,
  };
}

export const useTrialStore = create<TrialStore>((set) => ({
  started: false,
  promptsUsed: 0,
  remaining: null,
  cap: null,
  blocked: false,
  loading: true,
  error: false,
  refresh: async () => {
    try {
      set({ ...fromMeter(await fetchTrial()), loading: false, error: false });
    } catch (e) {
      // A throw here (corrupt trial.json → Rust hard error, or an IPC failure) MUST NOT leave the
      // gate pinned on `loading` forever. Resolve to a safe, non-stuck state: clear `loading` and
      // do NOT grant a trial (started:false), so a token-less user lands on the recoverable Welcome
      // screen (sign in / pay) with an error banner — never a re-granted trial, never a dead spinner.
      // `blocked` is left ALONE: a local read failure is not the server saying "you're fine".
      console.warn("trial refresh failed; resolving to a recoverable state:", e);
      set({
        started: false,
        promptsUsed: 0,
        remaining: null,
        cap: null,
        loading: false,
        error: true,
      });
    }
  },
  syncRemote: async () => {
    try {
      // Rust already fails open internally (an unreachable server returns the cached mirror), so a
      // throw here means local I/O, not a network blip.
      set({ ...fromMeter(await syncTrial()), loading: false, error: false });
    } catch (e) {
      // Never downgrade the UI on a sync failure — refresh() has already produced a usable state.
      console.warn("trial sync failed; keeping the cached meter:", e);
    }
  },
  start: async () => {
    try {
      set({ ...fromMeter(await startTrial()), error: false });
    } catch (e) {
      // "Try it now" couldn't persist the opt-in — surface it rather than swallowing it as an
      // unhandled rejection. loading is already false by now, so this only flips the error flag.
      console.warn("trial start failed:", e);
      set({ error: true });
    }
  },
  consume: async () => {
    try {
      // The authoritative debit. `blocked` coming back true is an AFFIRMATIVE server 402 (or a
      // debit that left 0 remaining) — that, and only that, flips the app into the upgrade state.
      set(fromMeter(await consumeTrial()));
    } catch (e) {
      // A metering call that throws must not become an unhandled rejection; the caller (composer)
      // already tolerates a best-effort meter, and the prompt has already been delivered. Do NOT
      // flip the shared `error` flag (it gates the token-less Welcome path) and do NOT block.
      console.warn("trial consume failed:", e);
    }
  },
}));

/** Prompts remaining in the free trial, floored at 0. Prefers the server's number; falls back to
 *  the cap-minus-used estimate only before the first server answer lands. */
export function trialPromptsLeft(s: {
  promptsUsed: number;
  remaining?: number | null;
  cap?: number | null;
}): number {
  if (s.remaining != null) return Math.max(0, s.remaining);
  return Math.max(0, (s.cap ?? TRIAL_LIMIT) - s.promptsUsed);
}

/** The hard-block predicate: show the "trial ended — upgrade" state and refuse NEW submissions.
 *  Exactly the server's affirmative verdict — never a local count, never a network failure. */
export function trialExhausted(s: { blocked: boolean }): boolean {
  return s.blocked;
}
