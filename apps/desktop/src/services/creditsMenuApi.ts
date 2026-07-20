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

// ── Checkout failure diagnosis ──────────────────────────────────────────────────────────────
// A failed credit purchase must diagnose itself instead of collapsing to one "try again". The Rust
// `desktop_topup_checkout` command hands us a machine-readable error (a compact JSON string —
// `{class, status, code}` — see auth.rs `checkout_error`); we turn it into a user-appropriate
// guidance object. Everything below is PURE and unit-tested, and it DEGRADES GRACEFULLY: a sibling
// worker is reshaping the server error body, so we key off `class`+`status` and never hard-depend on
// the `code` string, and we fall back to string heuristics when the error isn't our structured JSON.

/** Coarse failure buckets, each mapping to a distinct recovery path. */
export type CheckoutErrorClass =
  | "not_signed_in" // session/token gone → route to sign-in
  | "offline" //        transport failure → tell them, let them retry
  | "config" //         our-side problem (Stripe/permission/5xx) → retry won't help, point to support
  | "generic"; //       anything else → a plain retry

/** What the Credits pane should render for a failed checkout. */
export interface CheckoutGuidance {
  cls: CheckoutErrorClass;
  /** The message to show the user. Never contains raw Stripe/internal text. */
  message: string;
  /** Surface the "Contact support" affordance — true only for the our-side `config` class. */
  showSupport: boolean;
  /** This is fixed by (re-)authenticating, not retrying — offer a sign-in path. */
  needsSignIn: boolean;
}

/** Shape of the structured error the Rust command emits in its `Err` channel. */
interface RawCheckoutError {
  class?: string;
  status?: number | null;
  code?: string | null;
}

/** Best-effort parse of the Rust error into its structured form; null if it isn't our JSON. */
function parseRawError(raw: unknown): RawCheckoutError | null {
  if (raw && typeof raw === "object" && "class" in raw) return raw as RawCheckoutError;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s.startsWith("{")) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as RawCheckoutError) : null;
  } catch {
    return null;
  }
}

/** The error's string form, for the heuristic fallback (Error message, raw string, or JSON dump). */
function rawErrorText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Error) return raw.message;
  try {
    return String(raw);
  } catch {
    return "";
  }
}

/**
 * Classify a failed `desktop_topup_checkout` into a recovery bucket. Prefers the structured
 * `{class, status}` from Rust; when the body is opaque (an evolving/failed server contract, or a
 * plain string like "bad_pack") it degrades to conservative string heuristics.
 */
export function classifyCheckoutError(raw: unknown): CheckoutErrorClass {
  const parsed = parseRawError(raw);
  if (parsed?.class) {
    if (parsed.class === "not_signed_in") return "not_signed_in";
    if (parsed.class === "offline") return "offline";
    if (parsed.class === "server") {
      const status = typeof parsed.status === "number" ? parsed.status : undefined;
      // 401 = token rejected → re-auth. 403 (the prod restricted-key StripePermissionError) and any
      // 5xx are our-side config/outage problems. A missing status (e.g. 2xx-with-no-URL) is also our
      // contract break. Benign 4xx (bad_pack, 404, 409) fall through to a plain retry.
      if (status === 401) return "not_signed_in";
      if (status === undefined || status === 403 || status >= 500) return "config";
      return "generic";
    }
  }

  // Heuristic fallback for an opaque error (never trust it over the structured signal above).
  const text = rawErrorText(raw).toLowerCase();
  if (/not signed in|unauthorized|no token|sign in|401/.test(text)) return "not_signed_in";
  if (/offline|network|timed out|timeout|dns|connect|unreachable|transport/.test(text))
    return "offline";
  if (/permission|forbidden|stripe|misconfig|config|\b403\b|\b5\d\d\b|server error/.test(text))
    return "config";
  return "generic";
}

/** Turn a failed checkout into the exact guidance the Credits pane renders. Pure + unit-tested. */
export function checkoutGuidance(raw: unknown): CheckoutGuidance {
  const cls = classifyCheckoutError(raw);
  switch (cls) {
    case "not_signed_in":
      return {
        cls,
        message: "Your session has expired. Sign in again to buy credits.",
        showSupport: false,
        needsSignIn: true,
      };
    case "offline":
      return {
        cls,
        message: "You appear to be offline. Check your connection and try again.",
        showSupport: false,
        needsSignIn: false,
      };
    case "config":
      return {
        cls,
        message:
          "Payments are temporarily unavailable — this is a problem on Sparkle's side, not yours. " +
          "Retrying won't help right now. Please contact support and we'll get it fixed.",
        showSupport: true,
        needsSignIn: false,
      };
    case "generic":
    default:
      return {
        cls: "generic",
        // Kept verbatim so the existing "server refuses the checkout" copy stays stable.
        message: "Couldn't start checkout — try again.",
        showSupport: false,
        needsSignIn: false,
      };
  }
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
