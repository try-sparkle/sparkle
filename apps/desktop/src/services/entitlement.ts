// Pure auth/entitlement helpers for the desktop gate (design spec §8). No IO — the React
// AuthGate feeds these the current loading/token/me state and renders the derived view.
//
// The credit predicate is split across this module and services/aiGate, because aiGate imports
// useAuthStore for its hooks and an authStore → aiGate import would close a cycle. This module
// imports no store, so it is safe from anywhere:
//   • `hasCreditsAbove(me, floorCents)` — the pure rule, here.
//   • `aiGate.hasAiCredits(me, floorCents = store)` — the store-bound binding EVERY feature gate
//     uses; it respects the credit floor (a balance the server has refused).
//   • `hasPositiveBalance(me)` — the zero-floor form, here, for the one consumer that must ask about
//     the balance itself rather than the gate: the "$0" banner.

import type { AutoTopup } from "./creditsMenuApi";

/** The server's cloud-agent price list, quoted verbatim on `/me`. Both fields are the SERVER's
 *  numbers — the client never computes, adjusts or defaults them. */
export interface CloudAgentPricing {
  /** Charged per RUNNING sandbox-minute. Fractional (0.9 today); paused minutes are free. */
  centsPerMinute: number;
  /** Balance required to START, which is a floor and NOT a charge — a run cancelled after ten
   *  seconds costs ten seconds, not this. */
  minStartCents: number;
}

export interface Me {
  clerkUserId: string;
  entitled: boolean;
  balanceCents: number;
  tokenVersion: number;
  /** Display profile for "Signed in as …". Null/absent when the server predates the fields
   *  or the Clerk lookup failed soft server-side. */
  email?: string | null;
  name?: string | null;
  /** Auto-top-up settings (credits-menu spec §3). Optional so an older orchestration server that
   *  doesn't send it yet reads as "settings unavailable" rather than breaking /me parsing. */
  autoTopup?: AutoTopup;
  /** The server's cloud-agents KILL SWITCH — global, never per-account, and on by default. It is
   *  NOT an entitlement and must not be used to gate any surface: doing that hid every cloud
   *  control from every user and produced a refusal with nothing to click. "May this account run
   *  agents in the cloud" is answered by credits + a saved Claude credential
   *  (services/cloudAgents/gating.ts). Kept on the type because the server still sends it and a
   *  future outage banner is the one legitimate reader. */
  cloudAgentsEnabled?: boolean;
  /** The user's own Social Coding handle, or null/absent until they claim one. NEVER derive a
   *  display name from `email`/`name` when this is absent — §5 of the social design forbids
   *  auto-filling an identity from the Clerk account. */
  username?: string | null;
  /** The user's own durable availability INTENT: `public` | `connections` | `unavailable`. Distinct
   *  from liveness (is a socket open right now) — a user is routinely public AND offline. Absent
   *  reads as `unavailable`, since social is opt-in and nobody becomes discoverable by upgrading. */
  visibility?: string | null;
  /** Whether this account may use Social Coding — a single server-computed boolean folding the
   *  global kill switch and the per-account state together. Absent (an older server, or the flag
   *  off) reads as FALSE everywhere, which hides every social surface. Never infer it from
   *  `username` being set: an account can hold a handle and still be cut off. */
  socialEnabled?: boolean;
  /** What a cloud agent COSTS, stated by the server. The client holds NO rate of its own and must
   *  not derive one — a duplicated pricing rule already shipped a bug here (the 50¢ client floor
   *  that refused starts the server would have accepted; see `cloudAgents/gating.ts`). Absent means
   *  an older server: show no estimate rather than guessing. */
  cloudAgentPricing?: CloudAgentPricing;
}

export type AuthView = "loading" | "welcome" | "trial" | "unpaid" | "entitled";

/**
 * How long a locally-cached entitlement is honored WITHOUT a fresh affirmative server confirmation
 * (offline grace window). A paying customer who is offline or whose backend is unreachable keeps
 * their workspace instead of being bounced to the paywall; but a token that is silently rotated or
 * revoked server-side (which, at the JS layer, is indistinguishable from a network failure — both
 * surface as a null /me) eventually re-gates once this window lapses. 14 days comfortably covers a
 * long offline stretch (travel, a down backend) while keeping a lost/rotated token from granting
 * indefinite access.
 */
export const ENTITLEMENT_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Whether a cached `me` may still be trusted to render the workspace optimistically. True only for
 * an ENTITLED cache stamped within {@link ENTITLEMENT_GRACE_MS} of `now`. A future-dated stamp
 * (clock skew / a clock rolled backward since caching) is treated as "recent", never as expired, so
 * a benign clock wobble can't lock a paying user out. `now` is injected so this stays pure/testable.
 */
export function isEntitlementCacheValid(
  me: Me | null,
  cachedAt: number | null,
  now: number,
): boolean {
  return !!me?.entitled && cachedAt != null && now - cachedAt < ENTITLEMENT_GRACE_MS;
}

/** Derive which gate screen to show from the current auth + trial state.
 *  Signed-in users (token present) keep the existing unpaid/entitled behavior; the
 *  trial layer only governs token-less users. */
export function deriveAuthView(input: {
  loading: boolean;
  hasToken: boolean;
  me: Me | null;
  trialStarted: boolean;
  trialLoading: boolean;
  /** A signed-in-but-unpaid user dismissed the paywall to stay on the trial (authStore). When set
   *  (and a trial is active) they render the trial workspace instead of the unpaid wall — so both
   *  AuthGate and TopBar agree and the in-bar counter shows. */
  paywallDismissed?: boolean;
}): AuthView {
  if (input.loading || input.trialLoading) return "loading";
  if (input.hasToken && input.me) {
    if (input.me.entitled) return "entitled";
    // Dismissed the $99 wall while a trial is active → back to the trial workspace (matches
    // AuthGate's "stay on the free trial" escape hatch).
    if (input.paywallDismissed && input.trialStarted) return "trial";
    return "unpaid";
  }
  // Token-less: either the first-run welcome or the active anonymous trial.
  return input.trialStarted ? "trial" : "welcome";
}

/** Visual state of the TopBar profile / auth-status control (the button just right of the ⋯
 *  menu). "signedIn" shows the user's avatar; the two token-less states differ only by whether
 *  the app has ever seen this person (Sign up for brand-new, Log in for a returning user). */
export type AuthControlState = "loading" | "signedIn" | "returning" | "new";

/** Derive the profile control's state, staying consistent with {@link deriveAuthView}'s first-run
 *  signal: "new" (→ Sign up) is exactly the token-less, never-trialed "welcome" condition; any
 *  other token-less state is a returning user (→ Log in). A stored token counts as signed in even
 *  when `me` hasn't resolved (e.g. offline) — the caller falls back to a neutral avatar glyph. */
export function deriveAuthControl(input: {
  loading: boolean;
  hasToken: boolean;
  me: Me | null;
  trialStarted: boolean;
  trialLoading: boolean;
}): AuthControlState {
  if (input.loading || input.trialLoading) return "loading";
  if (input.hasToken) return "signedIn";
  return input.trialStarted ? "returning" : "new";
}

/** The signed-in identity to display: the first non-blank of name → email, trimmed. Returns null
 *  when neither resolves. The raw `clerkUserId` is deliberately NOT a fallback: surfacing an opaque
 *  `user_…` id reads to the user as a "wonky username" (this is exactly what a degraded /me — a
 *  Clerk profile lookup that soft-failed to null email+name — produced). Callers must treat null as
 *  "signed in, identity not resolvable" and render a clean "Signed in" / neutral avatar, never the
 *  id. Single source of truth so the avatar letter and the accessible label can never disagree —
 *  e.g. a whitespace-only name falls through to the email for BOTH, not just one. */
export function authIdentity(me: Me | null): string | null {
  // Trim each candidate BEFORE the `||`, so a blank/whitespace field falls through to the next
  // rather than being picked and then trimmed away.
  return me?.name?.trim() || me?.email?.trim() || null;
}

/** First letter (uppercased) of the signed-in identity for the avatar circle (see authIdentity).
 *  Returns "" when nothing is resolvable, so the caller can render a neutral fallback glyph
 *  instead of an empty circle. Never an emoji. */
export function avatarLetter(me: Me | null): string {
  // Read the first CODE POINT, not the first UTF-16 unit, so an astral first character (an emoji
  // name, some CJK-extension glyphs) doesn't get sliced into a broken lone surrogate.
  const ch = Array.from(authIdentity(me) ?? "")[0] ?? "";
  return ch ? ch.toUpperCase() : "";
}

/**
 * Stable sentinel Rust's `desktop_exchange_code` returns (auth.rs `NO_PENDING_SIGNIN`) when an auth
 * callback arrives but this instance has no in-flight sign-in to bind it to — i.e. the user quit
 * mid-sign-in and the returning `sparkle://auth?code=…` deep link relaunched a fresh process whose
 * in-memory pending sign-in is empty. Kept byte-identical to the Rust constant.
 */
export const NO_PENDING_SIGNIN = "no_pending_signin";

/**
 * True when a failed code exchange was the recoverable "no pending sign-in" case (see
 * {@link NO_PENDING_SIGNIN}) rather than a genuine state mismatch / expired code / server error.
 * The Tauri invoke rejects with the Rust error string (sometimes wrapped in an Error), so accept
 * either shape. Callers use this to offer a clean "start sign-in again" affordance instead of
 * dead-ending silently.
 */
export function isNoPendingSignIn(err: unknown): boolean {
  const msg =
    typeof err === "string" ? err : ((err as { message?: string } | null)?.message ?? String(err));
  return msg.includes(NO_PENDING_SIGNIN);
}

/**
 * Parse the one-time auth code out of a `sparkle://auth?code=…` deep link. Returns null for any
 * non-matching URL (wrong scheme, missing code, malformed) so the handler can ignore noise.
 */
export function parseAuthCode(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Only the auth deep link (sparkle://auth?code=…) carries an auth code. Gating on the host
  // keeps a future sparkle:// route (e.g. sparkle://open) carrying a `code` param from being
  // misrouted as an auth-code exchange.
  if (parsed.protocol !== "sparkle:" || parsed.host !== "auth") return null;
  const code = parsed.searchParams.get("code");
  return code && code.length > 0 ? code : null;
}

/**
 * Parse the `state` echoed back in a `sparkle://auth?code=…&state=…` deep link. Returns "" (not
 * null) when absent so the caller always passes a string to exchangeCode — Rust rejects an empty
 * or non-matching state against the sign-in it started (login-CSRF binding, sparkle-kqg0).
 */
export function parseAuthState(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  if (parsed.protocol !== "sparkle:" || parsed.host !== "auth") return "";
  return parsed.searchParams.get("state") ?? "";
}

/** The single definition of "has credits", as a PURE function of a balance and a floor: signed in,
 *  and holding strictly more than the floor. Store-free so both the store-bound gate and the stores
 *  themselves can route through one rule — see the header note on the import cycle.
 *
 *  `floorCents` is the balance the server last refused a call at. services/aiGate's `hasAiCredits`
 *  binds it to `authStore.creditFloorCents` for every feature gate; pass 0 for the literal
 *  "is the balance itself gone?" question. */
export function hasCreditsAbove(me: Me | null, floorCents: number): boolean {
  return me != null && me.balanceCents > Math.max(0, floorCents);
}

/** Does the user hold a positive balance — no inferred floor, just `balanceCents > 0`?
 *
 *  NAMED for the rule rather than the feature, and deliberately NOT `hasAiCredits`: that name belongs
 *  to services/aiGate's floor-aware gate, and two same-named exports in sibling modules would let an
 *  auto-import (or a "fixed" import path) silently swap one gate for the other with no compile error.
 *
 *  The "$0 balance" banner is the one consumer that must ask THIS question instead of the gate's. Its
 *  copy states "Your Sparkle credit balance is $0", and the floor can be in force at a genuinely
 *  positive balance — showing that sentence to someone holding 3¢ would be a false statement about
 *  their money on the surface that exists to be honest about it. The floor case is also self-healing
 *  within one `refresh()` (see authStore); a false claim is not. See services/zeroCreditBanner. */
export function hasPositiveBalance(me: Me | null): boolean {
  return hasCreditsAbove(me, 0);
}
