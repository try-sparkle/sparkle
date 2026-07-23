// Desktop client for the orchestration API (design spec §8, handoff §B). The bearer token
// lives in the OS keychain on the RUST side and never enters JS — every authenticated call is a
// Tauri command that does the HTTP in Rust (mirrors bridge.rs/naming.rs using ureq, and dodges
// the webview CSP). This module is the thin JS surface over those commands plus the browser
// hand-off via the opener plugin.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Me } from "./entitlement";
import { withCredits, type ConsumeResult, type CreditAction, type CreditDeps } from "./credits";
import { useSettingsStore, aiFeatureMode } from "../stores/settingsStore";

// The marketing/auth web app. Override with VITE_WEB_BASE_URL for local dev (http://localhost:3000).
// Exported so other UI (e.g. the support-ticket status banner) can build `${WEB_BASE_URL}/…` links
// against the same base as the sign-in / paywall hand-offs.
export const WEB_BASE_URL =
  (import.meta.env.VITE_WEB_BASE_URL as string | undefined) ?? "https://sparkle.ai";

/** The two URLs the app hands off to the system browser. Exported so the UI can offer them as a
 *  copy/paste fallback when the launch fails (no default browser, opener-scope regression, etc.). */
export const SIGN_IN_URL = `${WEB_BASE_URL}/desktop/callback`;
export const PAYWALL_URL = `${WEB_BASE_URL}/paywall`;

// Hand off a URL to the OS browser via the opener plugin, but NEVER reject: openUrl() rejects when
// the URL falls outside the `opener:allow-open-url` scope, when there's no default browser, or on an
// OS denial. Left unhandled (callers used `() => void openSignIn()`) that surfaced as an "Unhandled
// rejection: Not allowed to open url" burst AND a dead button with no feedback. Swallow + log here
// and report success so the caller can show a manual-link fallback instead.
export async function launch(url: string): Promise<boolean> {
  try {
    await openUrl(url);
    return true;
  } catch (e) {
    console.error("Failed to open URL in system browser:", url, e);
    return false;
  }
}

// The exact sign-in URL last built by openSignIn (base + state + code_challenge). The URL is
// dynamic now (login-CSRF binding, sparkle-kqg0), so the copy/paste fallback must show THIS URL,
// not the bare SIGN_IN_URL — pasting the base without the state/challenge would sign in unbound.
let _lastSignInUrl: string | null = null;

/** The full sign-in URL openSignIn last attempted (with state + code_challenge), or null before
 *  the first attempt. Used by AuthGate for the manual copy/paste fallback when launch fails. */
export function lastSignInUrl(): string | null {
  return _lastSignInUrl;
}

/** Begin a sign-in in Rust (generates + stashes the state/PKCE secrets) and build the browser URL
 *  carrying the public `state` + `code_challenge`. The verifier stays in Rust. */
async function buildSignInUrl(): Promise<string> {
  const { state, codeChallenge } = await invoke<{ state: string; codeChallenge: string }>(
    "desktop_begin_signin",
  );
  const url = new URL(SIGN_IN_URL);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  const built = url.toString();
  _lastSignInUrl = built;
  return built;
}

/** Open the system browser to the Clerk sign-in → desktop hand-off, binding this instance's
 *  state/PKCE to the sign-in (sparkle-kqg0). Resolves `false` (never rejects) when the browser
 *  couldn't be launched — the caller offers lastSignInUrl() manually. If beginning the sign-in in
 *  Rust fails, we fall back to the bare (unbound) URL so sign-in isn't fully bricked. */
export async function openSignIn(): Promise<boolean> {
  let url: string;
  try {
    url = await buildSignInUrl();
  } catch (e) {
    console.error("Failed to begin sign-in (state/PKCE); falling back to the bare URL:", e);
    _lastSignInUrl = SIGN_IN_URL;
    url = SIGN_IN_URL;
  }
  return launch(url);
}

/** Open the system browser to the $99 paywall checkout. Resolves `false` (never rejects) when the
 *  browser couldn't be launched. */
export function openPaywall(): Promise<boolean> {
  return launch(PAYWALL_URL);
}

/** True if a desktop bearer token is stored in the keychain. */
export async function hasToken(): Promise<boolean> {
  try {
    return await invoke<boolean>("desktop_has_token");
  } catch {
    return false;
  }
}

/** Redeem a one-time auth code (from the sparkle:// deep link) for the long-lived bearer. `state`
 *  is the value echoed back in the deep link; Rust rejects it unless it matches the sign-in this
 *  instance started (login-CSRF binding, sparkle-kqg0), so a planted code never reaches the server. */
export async function exchangeCode(code: string, state: string): Promise<void> {
  await invoke("desktop_exchange_code", { code, state });
}

/** Redeem a promo/override code. Resolves on success (caller then refreshes entitlement);
 *  rejects with "invalid_code" when the server rejects the code, or another message on failure. */
export async function redeemPromo(code: string): Promise<void> {
  await invoke("desktop_redeem_promo", { code });
}

/** Result of redeeming an admin-issued coupon (POST /billing/coupon). A `credit_grant` coupon has
 *  already added `grantedCents` to the balance server-side; a `discount` coupon grants nothing here
 *  — it carries a Stripe promotion code the user applies at checkout. */
export interface CouponRedeemResult {
  type: "credit_grant" | "discount";
  grantedCents?: number;
  balanceCents?: number;
  promotionCode?: string | null;
  /** True when the coupon also cleared the $99 paywall (an `entitles` credit_grant), so the caller
   *  can say "you're unlocked" rather than just "credits added". */
  entitled?: boolean;
}

/** Redeem an admin-issued coupon (the `/admin coupons` system) via /billing/coupon. Resolves with
 *  the coupon result on success; rejects with the server's stable code — "invalid_or_expired"
 *  (unknown/expired/capped) or "already_redeemed" — or another message on failure. Distinct from
 *  redeemPromo, which targets the single-code PROMO_CODE override. */
export async function redeemCoupon(code: string): Promise<CouponRedeemResult> {
  return await invoke<CouponRedeemResult>("desktop_redeem_coupon", { code });
}

/** Fetch entitlement + balance. Returns null on any auth/network failure (caller treats as
 *  signed-out). */
export async function fetchMe(): Promise<Me | null> {
  try {
    return await invoke<Me>("desktop_me");
  } catch {
    return null;
  }
}

/** Mint a 6-char pairing code for signing a phone in (15-min TTL, single-use). Rejects with the
 *  Rust error string on failure (not signed in, relay unreachable). */
export async function mintPairCode(): Promise<string> {
  return await invoke<string>("desktop_pair_code");
}

/** One paired device as reported by the relay device registry (GET /devices). */
export interface PairedDevice {
  id: string;
  name: string;
  platform: string;
  createdAt: string;
  lastSeenAt: string | null;
  /** True when this row is the caller — i.e. this Mac's own token. */
  current: boolean;
}

/** List devices paired to this account. Rejects with the stable string "devices_unsupported"
 *  when the deployed relay predates the device registry (the UI shows a graceful pending state). */
export async function listPairedDevices(): Promise<PairedDevice[]> {
  const resp = await invoke<{ devices?: PairedDevice[] }>("list_paired_devices");
  if (!Array.isArray(resp?.devices)) {
    throw new Error("unexpected device list response from relay");
  }
  return resp.devices;
}

/** Unpair one device by id (server enforces it belongs to this user). Idempotent: the Rust
 *  side treats a 404 (already revoked, or pre-registry relay) as success. */
export async function revokePairedDevice(id: string): Promise<void> {
  await invoke("revoke_paired_device", { id });
}

/** Clear the stored token (sign out locally). */
export async function signOut(): Promise<void> {
  try {
    await invoke("desktop_sign_out");
  } catch {
    // best-effort
  }
}

// CreditDeps for withCredits, backed by the Rust API + the "Use AI features" master. AI is
// considered enabled (and the credits gate active) whenever the master isn't fully Off — i.e. any
// AI feature is on. This is the single source of truth, derived from the per-feature flags.
export const creditDeps: CreditDeps = {
  isAiEnabled: () => aiFeatureMode(useSettingsStore.getState()) !== "off",
  consume: (cents, reason, meta, idempotencyKey) =>
    invoke<ConsumeResult>("desktop_consume", {
      cents,
      reason,
      meta: meta ?? {},
      idempotencyKey: idempotencyKey ?? null,
    }),
  refund: async (ledgerId) => {
    await invoke("desktop_refund", { ledgerId });
  },
};

/** Run an AI action through the credit meter (AI-off short-circuit + server debit + refund-on-
 *  throw), wired to the real Rust-backed credit API. Throws AiDisabledError / OutOfCreditsError. */
export function meteredAi<T>(action: CreditAction, run: () => Promise<T>): Promise<T> {
  return withCredits(action, run, creditDeps);
}
