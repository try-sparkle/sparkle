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
const WEB_BASE_URL =
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
async function launch(url: string): Promise<boolean> {
  try {
    await openUrl(url);
    return true;
  } catch (e) {
    console.error("Failed to open URL in system browser:", url, e);
    return false;
  }
}

/** Open the system browser to the Clerk sign-in → desktop hand-off. Resolves `false` (never
 *  rejects) when the browser couldn't be launched, so the caller can offer the URL manually. */
export function openSignIn(): Promise<boolean> {
  return launch(SIGN_IN_URL);
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

/** Redeem a one-time auth code (from the sparkle:// deep link) for the long-lived bearer. */
export async function exchangeCode(code: string): Promise<void> {
  await invoke("desktop_exchange_code", { code });
}

/** Redeem a promo/override code. Resolves on success (caller then refreshes entitlement);
 *  rejects with "invalid_code" when the server rejects the code, or another message on failure. */
export async function redeemPromo(code: string): Promise<void> {
  await invoke("desktop_redeem_promo", { code });
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
