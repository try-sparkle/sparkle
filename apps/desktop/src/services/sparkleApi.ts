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

/** Open the system browser to the Clerk sign-in → desktop hand-off. */
export function openSignIn(): Promise<void> {
  return openUrl(`${WEB_BASE_URL}/desktop/callback`);
}

/** Open the system browser to the $99 paywall checkout. */
export function openPaywall(): Promise<void> {
  return openUrl(`${WEB_BASE_URL}/paywall`);
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
