// React bindings for the cloud-agents gating layer (Service B, W5). The DECISIONS live in
// services/cloudAgents/gating.ts (pure, exhaustively tested); these hooks only assemble that
// module's inputs from the two stores that hold them — authStore (`/me`: capability, entitlement,
// balance) and cloudAuthStore (whether a Claude credential is saved server-side).
//
// Everything cloud is gated on ONE fact: the server advertised `cloudAgentsEnabled` for this
// account. Absent (older server, flag off, signed out) ⇒ false ⇒ no cloud surface renders at all,
// which is what "ships dark" means for a local-only user.

import { useAuthStore } from "../stores/authStore";
import { useCloudAuthStore } from "../stores/cloudAuthStore";
import {
  cloudOptionVisible,
  evaluateCloudGate,
  type CloudGate,
} from "../services/cloudAgents/gating";

/** True when the Cloud runtime may be OFFERED at all (server capability + signed in). */
export function useCloudAgentsEnabled(): boolean {
  const featureEnabled = useAuthStore((s) => s.me?.cloudAgentsEnabled === true);
  const signedIn = useAuthStore((s) => s.tokenPresent);
  return cloudOptionVisible({ featureEnabled, signedIn });
}

/** The full precondition check for STARTING a cloud agent (feature → signed in → paid → auth →
 *  credits), including the Settings section to deep-link to for a self-serve fix. */
export function useCloudGate(): CloudGate {
  const featureEnabled = useAuthStore((s) => s.me?.cloudAgentsEnabled === true);
  const signedIn = useAuthStore((s) => s.tokenPresent);
  const entitled = useAuthStore((s) => s.me?.entitled === true);
  const balanceCents = useAuthStore((s) => s.me?.balanceCents ?? 0);
  // `method != null` is the ONLY honest reading of "auth configured": cloudAuthStore starts at
  // method=null/loaded=false, so an un-probed store reads as not-configured and the click
  // deep-links to Settings instead of round-tripping to a guaranteed 400.
  const authConfigured = useCloudAuthStore((s) => s.method != null);
  return evaluateCloudGate({ featureEnabled, signedIn, entitled, authConfigured, balanceCents });
}
