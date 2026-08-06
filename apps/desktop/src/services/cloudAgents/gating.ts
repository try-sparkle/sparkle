// Pure gating logic for creating a CLOUD agent (Service B, W5). No IO — the creation UI feeds
// these the current auth/credit state and renders the derived decision. Kept pure so the
// "not signed in / no auth / no credits / happy path" matrix is exhaustively unit-testable without
// a live server (design spec §"Desktop: a transport seam", plan §W5).
//
// The DEFINITIVE gate is server-side: POST /sessions/start verifies auth + affordability and
// returns an honest error (see startError.ts). This module is the CLIENT pre-check that decides
// (a) whether to show the Cloud option at all and (b) whether a click can proceed or must deep-link
// the user to the right Settings section first. It never claims a create will succeed — only that
// the locally-known preconditions are met.

import type { CategoryId } from "../../stores/uiStore";

/**
 * Why a cloud create is blocked, most-fundamental first.
 *
 * EVERY MEMBER MUST BE SELF-SERVE — each one ships with either a `deepLink` to the Settings section
 * that fixes it or `needsSignIn`. That is pinned by a test in gating.test.ts, so adding a reason
 * with no way out fails the suite rather than shipping as a dead end.
 *
 * Two reasons were REMOVED on 2026-08-05 and should not come back:
 *  - `feature_disabled` mirrored `Me.cloudAgentsEnabled`, read as a per-account entitlement. It never
 *    was one — that is a single global env var on the server with no per-account representation, so
 *    the message ("Cloud agents aren't available on your account yet") was a claim about an account
 *    nobody had looked at, pointing at nothing the user could do. It is now a kill switch, on by
 *    default, and a server-side outage is classified by startError.ts instead.
 *  - `no_paid_account` required `paid_at`. The founder's rule is that any FUNDED user may start one,
 *    and the check was near-vacuous regardless (credits arrive by a top-up that sets `paid_at`).
 */
export type CloudBlockReason =
  | "signed_out" //       no desktop bearer token
  | "no_auth" //          no Claude auth saved (GET /claude-auth is null)
  | "insufficient_credits"; // balance below the minimum affordable run

/** The inputs the creation UI knows locally at click time. */
export interface CloudGateInput {
  /** A desktop bearer token is present (signed in). */
  signedIn: boolean;
  /** GET /claude-auth returned a method (a key/token is saved server-side). */
  authConfigured: boolean;
  /** Current credit balance in cents (Me.balanceCents). */
  balanceCents: number;
  /** Obviously-empty floor. Defaults to {@link CLOUD_MIN_START_CENTS} — deliberately NOT the
   *  server's real affordability rule; see that constant. */
  minStartCents?: number;
}

export type CloudGate =
  | { ok: true }
  | {
      ok: false;
      reason: CloudBlockReason;
      /** User-facing one-liner explaining the block. */
      message: string;
      /** The Settings section to deep-link to so the user can fix it. Every reason carries this or
       *  {@link CloudGate.needsSignIn}; a block with neither is a dead end and is not allowed. */
      deepLink?: CategoryId;
      /** True when the fix is to sign in (the creation UI offers the sign-in hand-off, not Settings). */
      needsSignIn?: boolean;
    };

/**
 * OBVIOUSLY-EMPTY ONLY. The client does not get a say in what a cloud agent costs.
 *
 * The server enforces the real rule — `canStartCloudAgent` requires
 * `CLOUD_AGENT_MIN_START_MINUTES` (5) of affordable balance, which against the live 0.9¢/min
 * constant is **5¢**. This constant said 50¢ and described itself as "small and generous so it
 * never blocks a genuinely-affordable balance", which was simply false: every balance from 5¢ to
 * 49¢ was refused locally with "you don't have enough credits" for a start the server would have
 * accepted, and — because `CLOUD_MIN_CONTINUE_CENTS` derives from it — a running agent's
 * auto-continue was silently abandoned in the same band.
 *
 * A duplicated exact floor is a second copy of a pricing rule that can drift from the one that
 * decides, which is exactly what happened. So this is now only the check that needs no pricing
 * knowledge at all: an empty wallet deep-links to Credits instead of round-tripping to a guaranteed
 * 402. Anything above it is the server's call, and its refusal is surfaced verbatim
 * (`startError.ts`).
 */
export const CLOUD_MIN_START_CENTS = 1;

/**
 * Whether the Cloud runtime option is even OFFERED — now simply "is this user signed in".
 *
 * It used to also require `featureEnabled`, which HID every cloud surface from everyone, because the
 * capability it read is a global server flag that shipped off. Hiding is the worst of the options
 * here: a user who cannot see the button cannot be told why, so there is nothing to click and
 * nothing to read. Showing it and letting {@link evaluateCloudGate} name the one fixable
 * precondition is what makes the feature discoverable at all.
 */
export function cloudOptionVisible(input: Pick<CloudGateInput, "signedIn">): boolean {
  return input.signedIn;
}

/**
 * Decide whether a cloud-agent create can proceed, or which precondition blocks it. Checks run
 * most-fundamental first so the surfaced reason is the one the user must fix first:
 * signed in → auth → credits. Each is one click from its own fix.
 */
export function evaluateCloudGate(input: CloudGateInput): CloudGate {
  const minStart = input.minStartCents ?? CLOUD_MIN_START_CENTS;

  // SIGNED-IN FIRST. Everything below is read from `/me` or from a server-side credential, and a
  // signed-out user has neither — so any other reason would be a statement about an account we have
  // never looked at. "Sign in" is the only honest first answer, and the fix is one click.
  if (!input.signedIn) {
    return {
      ok: false,
      reason: "signed_out",
      message: "Sign in to run agents in the cloud.",
      needsSignIn: true,
    };
  }
  if (!input.authConfigured) {
    return {
      ok: false,
      reason: "no_auth",
      message: "Add your Claude authentication to run agents in the cloud.",
      deepLink: "cloudauth",
    };
  }
  if (input.balanceCents < minStart) {
    return {
      ok: false,
      reason: "insufficient_credits",
      message: "You don't have enough credits to start a cloud agent. Add credits to continue.",
      deepLink: "credits",
    };
  }
  return { ok: true };
}

/**
 * The label for the button that takes a blocked user to the fix. ONE definition, because the
 * ternary it replaces (`deepLink === "cloudauth" ? "Add Claude auth" : "Open credits"`) was written
 * out verbatim at three call sites — the create dialog twice and the promote dialog once — so a
 * fourth Settings destination would have silently read "Open credits" at whichever site was missed.
 *
 * Returns null for a destination with no copy of its own rather than guessing, so the caller renders
 * nothing instead of a button that lies about where it goes.
 */
export function deepLinkActionLabel(deepLink: CategoryId): string | null {
  if (deepLink === "cloudauth") return "Add Claude auth";
  if (deepLink === "credits") return "Open credits";
  return null;
}
