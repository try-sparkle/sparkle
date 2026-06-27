// Meters worker sends against the free-trial cap. Split into a pre-send check and a
// post-send consume so a send that fails to deliver is never charged a trial prompt:
//   1. trialSendAllowed() — gate BEFORE delivery; pure read, consumes nothing.
//   2. recordTrialSend()  — consume one prompt AFTER the prompt is actually delivered.
// Entitled users bypass both. The Rust counter (trial.rs) is the durable source of truth;
// recordTrialSend round-trips through it.
import { useAuthStore } from "../stores/authStore";
import { useTrialStore, TRIAL_LIMIT } from "../stores/trialStore";
import { aiEnhancementsEnabled } from "./aiGate";

/** Whether this worker send is allowed under the cap. Entitled users always pass; trial
 *  users pass while under TRIAL_LIMIT. Pure — does NOT consume a prompt (call
 *  recordTrialSend after delivery), so an aborted/failed send isn't charged. */
export function trialSendAllowed(): boolean {
  if (aiEnhancementsEnabled(useAuthStore.getState().me)) return true;
  return useTrialStore.getState().promptsUsed < TRIAL_LIMIT;
}

/** Consume one trial prompt — call ONLY after the send is delivered. Entitled users are
 *  never metered. Best-effort: a counter hiccup fails open (the prompt already went out, so
 *  a failed bump must neither block nor surface an error to the caller). */
export async function recordTrialSend(): Promise<void> {
  if (aiEnhancementsEnabled(useAuthStore.getState().me)) return;
  try {
    await useTrialStore.getState().increment();
  } catch {
    // Fail-open: never penalize a delivered prompt for a transient counter write failure.
  }
}
