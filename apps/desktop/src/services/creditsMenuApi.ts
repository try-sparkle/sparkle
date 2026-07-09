// Service layer for the Credits settings pane (credits-menu spec §2–§4). Thin typed JS surface
// over the Rust commands added in auth.rs (desktop_topup_checkout / desktop_credit_history /
// desktop_auto_topup_get / desktop_auto_topup_set) plus the system-browser hand-off. The server
// owns the pack table — this file only mirrors it for button labels; the client sends a pack ID,
// never an amount.

import { invoke } from "@tauri-apps/api/core";
import { launch } from "./sparkleApi";

export type PackId = "pack_10" | "pack_25" | "pack_100" | "pack_500" | "pack_1000";

/** The five 1:1 top-up packs, ascending (display mirror of the server's TOPUP_PACKS). */
export const PACKS: { id: PackId; amountCents: number }[] = [
  { id: "pack_10", amountCents: 1000 },
  { id: "pack_25", amountCents: 2500 },
  { id: "pack_100", amountCents: 10000 },
  { id: "pack_500", amountCents: 50000 },
  { id: "pack_1000", amountCents: 100000 },
];

export interface AutoTopup {
  enabled: boolean;
  thresholdCents: number;
  packId: PackId;
  hasSavedCard: boolean;
  lastFailure: string | null;
}

export interface LedgerEntry {
  id: string;
  createdAt: string;
  reason: string;
  deltaCents: number;
  /** Optional human description surfaced from the ledger row's `meta.description` (the metering-only
   *  `purpose` threaded through the AI proxy — e.g. "Renamed agent to 'Fix OAuth loop'"). The server
   *  sends `description: string | null`; absent/null falls back to the static reason label. */
  description?: string | null;
}

// The checkout URL from the most recent startTopup/startCardSetup whose browser launch FAILED —
// the caller renders it in the copy/paste LaunchFallback (same recovery as sign-in/paywall).
let failedCheckoutUrl: string | null = null;

/** The checkout URL behind the last failed launch (for the manual-link fallback), else null. */
export function lastCheckoutUrl(): string | null {
  return failedCheckoutUrl;
}

async function startCheckout(
  kind: "paywall" | "topup" | "card_setup",
  pack: PackId | null,
): Promise<boolean> {
  failedCheckoutUrl = null;
  const url = await invoke<string>("desktop_topup_checkout", { kind, pack });
  const ok = await launch(url);
  if (!ok) failedCheckoutUrl = url;
  return ok;
}

/** Open the $99 paywall Stripe Checkout DIRECTLY in the system browser — one click, no
 *  intermediate web page. Authenticated with the desktop bearer token via the same
 *  desktop_topup_checkout command the top-ups use (server creates the session and returns the
 *  hosted checkout.stripe.com URL). Requires a signed-in desktop.
 *
 *  Resolves `false` (never rejects for launch problems) when the browser couldn't be opened — the
 *  URL is then available via lastCheckoutUrl(). Rejects when the server refuses (e.g. no bearer
 *  token) so the caller can fall back to the web sign-in→paywall flow. */
export function openPaywallCheckout(): Promise<boolean> {
  return startCheckout("paywall", null);
}

/** Open Stripe Checkout for a credit pack in the system browser. Resolves `false` (never rejects
 *  for launch problems) when the browser couldn't be opened — the URL is then available via
 *  lastCheckoutUrl(). Rejects when the server refuses the checkout (e.g. "bad_pack"). */
export function startTopup(pack: PackId): Promise<boolean> {
  return startCheckout("topup", pack);
}

/** Open a Stripe setup-mode Checkout (save a card, no charge) — same launch contract. */
export function startCardSetup(): Promise<boolean> {
  return startCheckout("card_setup", null);
}

/** One page of the credit ledger (newest first). Omit `cursor` for the first page. */
export function fetchHistory(cursor?: string): Promise<{ entries: LedgerEntry[]; nextCursor?: string }> {
  return invoke<{ entries: LedgerEntry[]; nextCursor?: string }>("desktop_credit_history", {
    cursor: cursor ?? null,
    limit: null,
  });
}

/** Current auto-top-up settings (server-authoritative). */
export function fetchAutoTopup(): Promise<AutoTopup> {
  return invoke<AutoTopup>("desktop_auto_topup_get");
}

/** Save auto-top-up settings; returns the server's post-save state (render from THIS, not the
 *  optimistic local value — the server may e.g. keep `enabled` false without a saved card). */
export function saveAutoTopup(next: {
  enabled: boolean;
  thresholdCents: number;
  packId: PackId;
}): Promise<AutoTopup> {
  return invoke<AutoTopup>("desktop_auto_topup_set", next);
}

// Human labels for ledger reasons (spec §4). One map, desktop-side; unknown reasons render
// verbatim so a new server-side reason never breaks the history list.
const REASON_LABELS: Record<string, string> = {
  paywall_topup: "Signup grant",
  credit_topup: "Top-up",
  credit_topup_auto: "Auto refill",
  promo_grant: "Promo",
  coupon_grant: "Coupon",
  anthropic_debit: "AI (Claude)",
  chief_debit: "Chief",
  deepgram_debit: "Cloud dictation",
  refund: "Refund",
  stripe_clawback: "Refund clawback",
};

/** Human label for a ledger reason; unknown reasons pass through verbatim. */
export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}

// Compact reason tags used ONLY when a row carries a human `description` — the label then reads
// "<tag>: <description>" (e.g. "AI: Renamed agent to 'Fix OAuth loop'"), keeping the row terse.
// Reasons without a compact tag fall back to their full reasonLabel() as the tag.
const REASON_TAGS: Record<string, string> = {
  anthropic_debit: "AI",
  chief_debit: "Chief",
  deepgram_debit: "Dictation",
};

/** Longest description we inline before ellipsizing, so one history row stays one line even before
 *  the CSS clip kicks in (belt-and-braces with the row's overflow styling). */
const MAX_DESCRIPTION_CHARS = 120;

function truncateDescription(desc: string): string {
  const t = desc.trim();
  // Count/slice by codepoints (not UTF-16 units) so an emoji/surrogate pair is never split into a
  // lone unit — matches the Rust side's `chars().take(...)` truncation on non-BMP input.
  const cps = [...t];
  return cps.length > MAX_DESCRIPTION_CHARS
    ? `${cps.slice(0, MAX_DESCRIPTION_CHARS - 1).join("").trimEnd()}…`
    : t;
}

/** Display label for a ledger row. When the row carries a human `description` (the metering `purpose`
 *  the server persisted into `meta.description`), render "<tag>: <description>" — e.g.
 *  "AI: Renamed agent to 'Fix OAuth loop'". With no description, fall back to the static reason
 *  label ("AI (Claude)", "Chief", "Cloud dictation", …). */
export function historyLabel(entry: Pick<LedgerEntry, "reason" | "description">): string {
  const desc = entry.description?.trim();
  if (desc) {
    const tag = REASON_TAGS[entry.reason] ?? reasonLabel(entry.reason);
    return `${tag}: ${truncateDescription(desc)}`;
  }
  return reasonLabel(entry.reason);
}
