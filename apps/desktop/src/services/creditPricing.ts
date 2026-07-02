// Credit pricing (design spec §7.2). All amounts in US cents.
//
// SOURCE OF TRUTH (task #10): AI pricing for the SERVER-METERED services — Anthropic (Haiku, 10×)
// and Chief (at cost, 1× = 0.1¢/credit) — now lives ONLY on the server, in
// apps/orchestration/src/lib/aiPricing.ts. Those calls go through the `/ai/anthropic` and
// `/ai/chief` proxies, which debit on ACTUAL vendor usage AFTER the call, so the desktop no longer
// estimates or debits them up front. The old client-side rate tables + flat up-front estimates for
// Anthropic/Chief were REMOVED here so a stale duplicate can't double-charge or charge the wrong
// rate. (The proxy response also carries the authoritative post-debit `balanceCents`; the balance
// badge picks it up on its next `/me` refresh rather than each proxy call threading it through.)
//
// What remains client-side:
//   • Deepgram cloud dictation — NOW metered SERVER-side by the `/ai/deepgram` relay (task #13), so
//     the desktop no longer debits per minute. Only the raw vendor cost survives below as reference
//     (the server owns the marked-up rate it actually charges).
//   • formatBalance — display helper for the balance the server reports.

/** Every client-metered service charges the user this multiple of our vendor cost. */
export const CREDIT_MARKUP = 10;

const cents = (dollars: number) => dollars * 100;

// --- Deepgram Nova-3 Multilingual streaming STT (cloud dictation) --------------------------------
// Vendor cost: $0.0058 per streaming audio-minute (input only — STT bills audio in, not text out).
// Source: Deepgram product page, Nova-3 Multilingual streaming line (per founder, 2026-06). Our
// client requests Nova-3 Multilingual (`model=nova-3&language=multi` in cloud.rs), so this rate
// matches what we call. https://deepgram.com/pricing
export const DEEPGRAM_NOVA3_COST_CENTS_PER_MIN = cents(0.0058); // 0.58¢/min
// NOTE: the marked-up per-minute charge (10× the vendor cost) now lives SERVER-side in
// apps/orchestration/src/lib/aiPricing.ts (the relay meters), so the old client
// CLOUD_DICTATION_CENTS_PER_MIN constant was removed with the client-side meter (task #13).

/** Dollars string for display; never negative (design spec §7.3 — ledger may be negative). */
export function formatBalance(balanceCents: number): string {
  return `$${(Math.max(0, balanceCents) / 100).toFixed(2)}`;
}
