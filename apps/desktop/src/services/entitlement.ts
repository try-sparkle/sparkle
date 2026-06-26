// Pure auth/entitlement helpers for the desktop gate (design spec §8). No IO — the React
// AuthGate feeds these the current loading/token/me state and renders the derived view.

export interface Me {
  clerkUserId: string;
  entitled: boolean;
  balanceCents: number;
  tokenVersion: number;
}

export type AuthView = "loading" | "unauthenticated" | "unpaid" | "entitled";

/** Derive which gate screen to show from the current auth state. */
export function deriveAuthView(input: {
  loading: boolean;
  hasToken: boolean;
  me: Me | null;
}): AuthView {
  if (input.loading) return "loading";
  if (!input.hasToken || !input.me) return "unauthenticated";
  return input.me.entitled ? "entitled" : "unpaid";
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
