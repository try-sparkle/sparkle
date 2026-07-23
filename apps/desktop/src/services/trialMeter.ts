// Meters worker sends against the SERVER-authoritative free-trial cap. Split into a pre-send check
// and a post-send consume so a send that fails to deliver is never charged a trial prompt:
//   1. trialSendAllowed() — gate BEFORE delivery; a pure, synchronous read of the last known
//      server verdict. Consumes nothing and never touches the network.
//   2. recordTrialSend()  — debit one prompt on the SERVER (trial_consume) AFTER the prompt is
//      actually delivered.
// Entitled users bypass both (requirement: a paid user never touches the trial endpoints).
//
// WHY THE GATE IS SYNCHRONOUS AND THE DEBIT IS NOT: awaiting a round-trip before every send would
// put up to a 15s network timeout in front of the user's Enter key. Instead the gate reads the
// server's LAST verdict (sticky in the Rust mirror, so it survives a relaunch), and the debit runs
// async behind the delivered prompt. The moment the server answers 402, `blocked` flips and the
// NEXT submission is refused — plus AuthGate's full-screen upgrade overlay covers the app, which is
// what actually hard-blocks new agents and raw-terminal typing. The bounded cost is that a device
// can be at most ONE prompt past the cap before the block lands; that is the deliberate trade for
// not putting a network wait on every keystroke, and the server still refuses to debit past the cap.
import { useAuthStore } from "../stores/authStore";
import { useTrialStore } from "../stores/trialStore";
import { aiEnhancementsEnabled } from "./aiGate";

/** Whether this worker send is allowed. Entitled users always pass. A trial user passes unless the
 *  SERVER affirmatively said the trial is spent — so an offline/unreachable server never blocks
 *  (fail-open), and a network hiccup can never read as "trial expired". Pure: does NOT consume a
 *  prompt (call recordTrialSend after delivery), so an aborted/failed send isn't charged. */
export function trialSendAllowed(): boolean {
  if (aiEnhancementsEnabled(useAuthStore.getState().me)) return true;
  return !useTrialStore.getState().blocked;
}

/** Consume one trial prompt against the server — call ONLY after the send is delivered. Entitled
 *  users are never metered. Best-effort: the Rust command already fails open on an unreachable
 *  server (debiting the durable local cache instead), and the store swallows anything else, so a
 *  delivered prompt is never punished by a metering failure. */
export async function recordTrialSend(): Promise<void> {
  if (aiEnhancementsEnabled(useAuthStore.getState().me)) return;
  try {
    await useTrialStore.getState().consume();
  } catch {
    // Fail-open: never penalize a delivered prompt for a transient counter failure.
  }
}
