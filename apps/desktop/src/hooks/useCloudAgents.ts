// React bindings for the cloud-agents gating layer (Service B, W5). The DECISIONS live in
// services/cloudAgents/gating.ts (pure, exhaustively tested); these hooks only assemble that
// module's inputs from the two stores that hold them — authStore (`/me`: balance) and cloudAuthStore
// (whether a Claude credential is saved server-side).
//
// Cloud surfaces render for any SIGNED-IN user. They used to be gated on `me.cloudAgentsEnabled`
// too, which hid them from everyone — that capability is a global server switch, not a per-account
// entitlement, and it shipped off. Hiding is the worst failure mode available here: a user who
// cannot see the button cannot be told why. Now the button is always there and the gate names the
// one precondition to fix.

import { useEffect } from "react";

import { useAuthStore } from "../stores/authStore";
import { useCloudAuthStore } from "../stores/cloudAuthStore";
import {
  cloudOptionVisible,
  evaluateCloudGate,
  type CloudGate,
} from "../services/cloudAgents/gating";

/** True when the Cloud runtime may be OFFERED at all — i.e. the user is signed in. */
export function useCloudAgentsEnabled(): boolean {
  const signedIn = useAuthStore((s) => s.tokenPresent);
  return cloudOptionVisible({ signedIn });
}

/** The full precondition check for STARTING a cloud agent (signed in → auth → credits), including
 *  the Settings section to deep-link to for a self-serve fix. */
export function useCloudGate(): CloudGate {
  const signedIn = useAuthStore((s) => s.tokenPresent);
  const balanceCents = useAuthStore((s) => s.me?.balanceCents ?? 0);
  const saved = useCloudAuthStore((s) => s.method != null);
  const probed = useCloudAuthStore((s) => s.loaded);
  const attempted = useCloudAuthStore((s) => s.attempted);
  const refresh = useCloudAuthStore((s) => s.refresh);

  // HYDRATE THE STORE THIS GATE DEPENDS ON, HERE, ONCE.
  //
  // `cloudAuthStore` is deliberately not persisted, so it is cold on every launch and `method` is
  // meaningless until `loaded`. Every surface that reads this gate therefore needs it probed — and
  // before this lived here, each one carried its own copy of the effect (the create dialog had one;
  // the promote dialog did not, and the new always-mounted button would have needed a third). One
  // seam beats N: a consumer cannot forget it, and the ones that already existed are deleted.
  //
  // BOUNDED ON `attempted`, NOT ON `loaded` — the difference is a live-site outage, not a nicety.
  // `refresh` leaves `loaded` false when the GET fails, so gating on `!loaded` retries forever for
  // anyone offline or behind a 5xx, with no backoff and several consumers re-triggering each other
  // through the shared store (roborev 58470). `attempted` survives failure, so this fires at most
  // once per sign-in; `reset` clears it, so signing back in probes again.
  //
  // Concurrent consumers are deduped INSIDE the store, not here: a value read at render is stale by
  // the time a sibling's effect runs in the same flush. Still gated on signed-in, which is the part
  // that mattered — without a bearer token the GET is unauthenticated and can only 401.
  useEffect(() => {
    if (signedIn && !attempted) void refresh();
  }, [signedIn, attempted, refresh]);

  // UNPROBED IS UNKNOWN, AND UNKNOWN IS NOT "NO CREDENTIAL" — for every consumer, which is why this
  // is unconditional rather than an opt-in. `loaded` is false in two situations and neither is
  // evidence of absence: nothing has asked yet, and the ask FAILED (`refresh` deliberately leaves
  // `loaded` false on error). Blocking on either states as fact something nobody looked up — and it
  // does so for the whole sign-in, since a transient GET failure never retries. The definitive
  // check is `POST /sessions/start`, which refuses honestly with the server's own reason; a client
  // that guesses ahead of it can only be wrong in the direction that blocks a working account.
  const authConfigured = saved || !probed;
  // Fed through the SAME `evaluateCloudGate` rather than patched afterwards, and that matters: the
  // checks are ORDERED (signed in → auth → credits) and return the FIRST block, so rewriting a
  // `no_auth` result to "ok" after the fact would also swallow the `insufficient_credits` the
  // evaluation never reached. Adjusting the INPUT lets the ordering carry on to the next check.
  return evaluateCloudGate({ signedIn, authConfigured, balanceCents });
}
