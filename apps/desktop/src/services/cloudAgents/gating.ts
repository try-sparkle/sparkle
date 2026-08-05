// Pure gating logic for creating a CLOUD agent (Service B, W5). No IO — the creation UI feeds
// these the current auth/entitlement/credit state and renders the derived decision. Kept pure so
// the "no auth / no credits / feature disabled / not signed in / happy path" matrix is exhaustively
// unit-testable without a live server (design spec §"Desktop: a transport seam", plan §W5).
//
// The DEFINITIVE gate is server-side: POST /sessions/start verifies auth + affordability and
// returns an honest error (see startError.ts). This module is the CLIENT pre-check that decides
// (a) whether to show the Cloud option at all and (b) whether a click can proceed or must deep-link
// the user to the right Settings section first. It never claims a create will succeed — only that
// the locally-known preconditions are met.

import type { CategoryId } from "../../stores/uiStore";

/** Why a cloud create is blocked, most-fundamental first. */
export type CloudBlockReason =
  | "feature_disabled" // server hasn't advertised CLOUD_AGENTS_ENABLED for this account
  | "signed_out" //       no desktop bearer token
  | "no_paid_account" //  cloud agents require a paid account (no trial-funded sandboxes, v1)
  | "no_auth" //          no Claude auth saved (GET /claude-auth is null)
  | "insufficient_credits"; // balance below the minimum affordable run

/** The inputs the creation UI knows locally at click time. */
export interface CloudGateInput {
  /** Server-advertised capability (Me.cloudAgentsEnabled). Undefined/false → option hidden. */
  featureEnabled: boolean;
  /** A desktop bearer token is present (signed in). */
  signedIn: boolean;
  /** The account is entitled/paid (Me.entitled). Cloud requires a paid account in v1. */
  entitled: boolean;
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
      /** The Settings section to deep-link to so the user can fix it (undefined = no deep link,
       *  e.g. a pure feature-disabled state that the user can't self-serve). */
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
 * Whether the Cloud runtime option is even OFFERED. The whole toggle/option is hidden unless the
 * server advertises the capability for this account — the feature "ships dark" (spec §Feature flag).
 * A signed-out user can't have a capability yet, so this is also false for them.
 */
export function cloudOptionVisible(input: Pick<CloudGateInput, "featureEnabled" | "signedIn">): boolean {
  return input.featureEnabled && input.signedIn;
}

/**
 * Decide whether a cloud-agent create can proceed, or which precondition blocks it. Checks run
 * most-fundamental first so the surfaced reason is the one the user must fix first:
 * signed in → feature → paid → auth → credits.
 */
export function evaluateCloudGate(input: CloudGateInput): CloudGate {
  const minStart = input.minStartCents ?? CLOUD_MIN_START_CENTS;

  // SIGNED-IN FIRST, and the order is the whole point of this pair.
  //
  // `featureEnabled` comes from `/me`, so a signed-out user has no `/me` at all and reads as
  // feature-disabled — which would tell someone who has simply not signed in that "Cloud agents
  // aren't available on your account yet". That is a false statement about an account we have not
  // looked at, and it is unactionable: it points at nothing they can do, when the fix is one click.
  // We cannot know a capability we were never told, so "sign in" is the honest first answer.
  if (!input.signedIn) {
    return {
      ok: false,
      reason: "signed_out",
      message: "Sign in to run agents in the cloud.",
      needsSignIn: true,
    };
  }
  if (!input.featureEnabled) {
    return {
      ok: false,
      reason: "feature_disabled",
      message: "Cloud agents aren't available on your account yet.",
    };
  }
  if (!input.entitled) {
    return {
      ok: false,
      reason: "no_paid_account",
      message: "Cloud agents require a paid account. Upgrade to run agents in the cloud.",
      deepLink: "credits",
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
