// Pure auth/entitlement helpers for the desktop gate (design spec §8). No IO — the React
// AuthGate feeds these the current loading/token/me state and renders the derived view.

import type { AutoTopup } from "./creditsMenuApi";

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
}

export type AuthView = "loading" | "welcome" | "trial" | "unpaid" | "entitled";

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

/** The signed-in identity to display: first non-blank of name → email → clerkUserId, trimmed
 *  (the `Me` shape carries no username). Returns null when none is resolvable. Single source of
 *  truth so the avatar letter and the accessible label can never disagree — e.g. a whitespace-only
 *  name falls through to the email for BOTH, not just one. */
export function authIdentity(me: Me | null): string | null {
  // Trim each candidate BEFORE the `||`, so a blank/whitespace field falls through to the next
  // rather than being picked and then trimmed away.
  return me?.name?.trim() || me?.email?.trim() || me?.clerkUserId?.trim() || null;
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
