// Thin wrappers over the Rust trial-meter commands. The 100-prompt cap is enforced SERVER-side
// (orchestration, keyed by the keychain device token — see src-tauri/src/trial_remote.rs);
// `trial.json` is only a local mirror, so deleting it or reinstalling never re-grants a trial.
import { invoke } from "@tauri-apps/api/core";

/** Fallback cap for display only, used until the server reports the real one. */
export const TRIAL_LIMIT = 100;

/** One shape for every path — local read, remote sync, remote consume (Rust `TrialMeter`). */
export interface TrialMeter {
  /** Anonymous per-install id for usage telemetry. NOT the trial identity — that is the keychain
   *  device token, which is why regenerating this (a reinstall) grants nothing. */
  installId: string;
  /** The user tapped "Try it now". A local UX flag; it grants nothing. */
  started: boolean;
  promptsUsed: number;
  /** Best-known remaining prompts; null when the server has never been reached on this machine. */
  remaining: number | null;
  cap: number | null;
  /** Hard block: the SERVER affirmatively said the trial is spent (402, or 0 remaining). */
  blocked: boolean;
  /** Whether the server confirmed these numbers just now (false for a local read / offline call). */
  serverConfirmed: boolean;
}

/** Local, no-network read of the cached mirror. Resolves the gate instantly at startup. */
export function fetchTrial(): Promise<TrialMeter> {
  return invoke<TrialMeter>("trial_status");
}

export function startTrial(): Promise<TrialMeter> {
  return invoke<TrialMeter>("trial_start");
}

/** Read-only reconcile with the server; clamps the local mirror to the authoritative counter. */
export function syncTrial(): Promise<TrialMeter> {
  return invoke<TrialMeter>("trial_sync");
}

/** Debit one prompt against the SERVER counter. Fails open (offline → cached decrement). */
export function consumeTrial(): Promise<TrialMeter> {
  return invoke<TrialMeter>("trial_consume");
}
