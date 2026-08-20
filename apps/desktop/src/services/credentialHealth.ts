// THE ONE CREDENTIAL-HEALTH STATE — "are ALL of this machine's Claude accounts OAuth-expired?"
//
// ══ THE OUTAGE THIS EXISTS FOR ═════════════════════════════════════════════════════════════════
// Every account's OAuth refresh token can die system-wide ("OAuth session expired and could not be
// refreshed"). A dead refresh token cannot be refreshed by the app — it needs a human `/login`. When
// that happens the concierge is a SINGLE serial session, so:
//
//   • every user turn dead-ends: `concierge.rs::plan_retry` rotates to a healthy fallback on an
//     auth-expiry failure, but when NO account is healthy it returns None and the turn just fails;
//   • the research auto-dispatch keeps spawning metered `sparkle_research` children that die on the
//     same dead auth; and
//   • proactive pushes keep hitting the dead pinned account every couple of minutes.
//
// The founder, meanwhile, keeps queuing prompts against a provably-dead credential, each one failing
// the same way with nothing telling him the ONE thing that would fix it: sign in again.
//
// ══ WHAT THIS MODULE IS ════════════════════════════════════════════════════════════════════════
// A single, in-process source of truth for that fact — `"expired"` vs `"ok"` — that the send path,
// the research auto-dispatch and the proactive scheduler all READ, so the app stops piling work onto
// a dead credential and surfaces ONE clear "sign in again" state instead of failing every turn.
//
// It is DERIVED, not guessed. The authoritative computer is `ReadinessGate`, which runs a live
// `claude auth status` probe plus an account-store rotation read and decides block-vs-banner-vs-none
// (`readiness.authGateDecision`). A `"block"` decision is exactly the composite this state needs:
// the default account cannot authenticate AND no other account is usable — i.e. auth-expiry detected
// AND no healthy fallback, the frontend twin of `plan_retry` returning None. The gate publishes here
// (`setCredentialHealth`) and the state SELF-HEALS: when the human runs `/login` the gate re-probes
// (on focus, on the auth-failure signal, on a confirmed sign-in), the decision flips off `"block"`,
// and this returns to `"ok"` with no manual reset.
//
// Deliberately a plain module-level value + listener set rather than a store framework: there is one
// boolean's worth of state and three readers, and the pattern mirrors `claudeAuthSignal` beside it.
// It publishes nothing to disk and decides nothing itself — the gate owns the decision, this owns the
// distribution.

/** Whether the machine's Claude credentials are all provably dead. `"ok"` is the healthy default —
 *  the state a fresh mount holds until the gate positively CONFIRMS the all-expired dead end, so a
 *  probe that has not run yet never gates anything. */
export type CredentialHealth = "ok" | "expired";

let state: CredentialHealth = "ok";

type Listener = () => void;
const listeners = new Set<Listener>();

/** The current credential-health state. */
export function getCredentialHealth(): CredentialHealth {
  return state;
}

/** Are ALL Claude accounts OAuth-expired right now? The one predicate the consumers gate on. */
export function isCredentialExpired(): boolean {
  return state === "expired";
}

/**
 * Publish the credential-health state. Called only by the authoritative computer (`ReadinessGate`).
 *
 * A no-op when the value is unchanged, so a gate that re-publishes the same decision every render
 * does not wake every subscriber each time — the subscribers re-run real work (a `useSyncExternalStore`
 * snapshot read, a scheduler re-arm), and a stream of identical notifications is how a cheap publish
 * becomes an expensive one. A throwing listener must not stop the others from being told, or one
 * broken subscriber would leave the rest reading a stale state — the same rule `claudeAuthSignal` keeps.
 */
export function setCredentialHealth(next: CredentialHealth): void {
  if (next === state) return;
  state = next;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      console.warn("credential-health listener threw:", e);
    }
  }
}

/** Subscribe to credential-health changes. Returns an unsubscribe function (the shape `useEffect`
 *  and `useSyncExternalStore` both want). */
export function subscribeCredentialHealth(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Test-only: return to the healthy default and drop every subscriber so one suite's mounts cannot
 *  leak a state or a listener into the next. */
export function resetCredentialHealthForTests(): void {
  state = "ok";
  listeners.clear();
}
