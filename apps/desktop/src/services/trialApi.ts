// Thin wrappers over the Rust trial-meter commands (trial.rs). The 100-prompt cap is
// the device-local source of truth in Rust; this just shuttles the state to JS.
import { invoke } from "@tauri-apps/api/core";

export const TRIAL_LIMIT = 100;

export interface TrialState {
  installId: string;
  started: boolean;
  promptsUsed: number;
}

export function fetchTrial(): Promise<TrialState> {
  return invoke<TrialState>("trial_status");
}

export function startTrial(): Promise<TrialState> {
  return invoke<TrialState>("trial_start");
}

export function incrementTrial(): Promise<TrialState> {
  return invoke<TrialState>("trial_increment");
}
