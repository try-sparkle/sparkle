// Credit pricing (design spec §7.2). All amounts in US cents.
//
// PRICING RULE: we charge the user 10x our underlying vendor cost for every service. Each service's
// vendor cost and the resulting user charge live in the mapping table below, so the markup is
// applied consistently and the rates are auditable in one place.
//
// METERING NOTE: only the Deepgram cloud-dictation rate is wired into live metering today (a fixed,
// known per-minute cost that the frontend debits per elapsed minute — see cloudDictationMeter.ts).
// The Anthropic-per-token and Chief-per-credit rates below are ACTUAL-usage rates: billing them
// correctly needs the credits gate extended to reconcile actuals reported by the API *after* a call
// (the current `withCredits` debits a fixed estimate up front). That reconciliation + wiring metering
// into naming/brainstorm is a credits-system follow-up; the rates are defined here so that work has a
// single source of truth.

/** Every service charges the user this multiple of our vendor cost. */
export const CREDIT_MARKUP = 10;

const cents = (dollars: number) => dollars * 100;

// --- Deepgram Nova-3 Multilingual streaming STT (cloud dictation) --------------------------------
// Vendor cost: $0.0058 per streaming audio-minute (input only — STT bills audio in, not text out).
// Source: Deepgram product page, Nova-3 Multilingual streaming line (per founder, 2026-06). Our
// client requests Nova-3 Multilingual (`model=nova-3&language=multi` in cloud.rs), so this rate
// matches what we call. https://deepgram.com/pricing
export const DEEPGRAM_NOVA3_COST_CENTS_PER_MIN = cents(0.0058); // 0.58¢/min
/** What we charge per minute of cloud dictation (10x cost). Wired into cloudDictationMeter.ts. */
export const CLOUD_DICTATION_CENTS_PER_MIN = DEEPGRAM_NOVA3_COST_CENTS_PER_MIN * CREDIT_MARKUP; // 5.8¢/min

// --- Anthropic per-token (Haiku 4.5; add other models here as we start metering them) -------------
// Vendor cost per million tokens (MTok), split input vs output. Charged at 10x per token. NOTE: the
// agents run on the user's own `claude` CLI auth (not our credits); the only Anthropic call we pay
// for today is the Haiku naming call, which is not yet metered — see METERING NOTE above.
interface TokenRate {
  /** Vendor cost in cents per input MTok. */
  inputCostCentsPerMTok: number;
  /** Vendor cost in cents per output MTok. */
  outputCostCentsPerMTok: number;
}
const ANTHROPIC_TOKEN_COST: Record<string, TokenRate> = {
  // Haiku 4.5: $1 / MTok input, $5 / MTok output.
  "claude-haiku-4-5": { inputCostCentsPerMTok: cents(1), outputCostCentsPerMTok: cents(5) },
};

/** Strip a trailing dated suffix (`-YYYYMMDD`) so a dated model id (claude-haiku-4-5-20251001)
 *  resolves to its base rate key (claude-haiku-4-5). Anthropic ids in this codebase are dated. */
function baseModelId(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

/** Credits (cents) to charge for an Anthropic call, from actual input/output token counts (10x cost). */
export function anthropicTokenCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rate = ANTHROPIC_TOKEN_COST[baseModelId(model)];
  if (!rate) return 0; // unknown model → not metered here (see ANTHROPIC_TURN_CENTS fallback below)
  const inCost = (rate.inputCostCentsPerMTok / 1_000_000) * inputTokens;
  const outCost = (rate.outputCostCentsPerMTok / 1_000_000) * outputTokens;
  return (inCost + outCost) * CREDIT_MARKUP;
}

// --- Chief (Storytell) ---------------------------------------------------------------------------
// Chief's API returns the number of Chief credits consumed per request. Our cost is $0.001 (0.1¢)
// per Chief credit; we charge the user 10x = 1¢ per Chief credit.
export const CHIEF_COST_CENTS_PER_CREDIT = 0.1;
/** What we charge per Chief credit the API reports (10x cost). */
export const CHIEF_CENTS_PER_CREDIT = CHIEF_COST_CENTS_PER_CREDIT * CREDIT_MARKUP; // 1¢/credit
/** Credits (cents) to charge for a Chief request, from the credits it reports consuming. */
export function chiefCents(chiefCreditsUsed: number): number {
  return chiefCreditsUsed * CHIEF_CENTS_PER_CREDIT;
}

// --- Legacy flat estimates (still used by the existing up-front credit gate) ----------------------
// These pre-date the per-actual table above and are what `withCredits` debits as an ESTIMATE before
// a call runs (BrainstormPanel's Chief call). They stay until the actual-usage reconciliation lands.
const ANTHROPIC_TURN_CENTS: Record<string, number> = {
  "claude-opus-4-8": 25,
  "claude-sonnet-4-6": 8,
  "claude-haiku-4-5": 1,
};
const ANTHROPIC_DEFAULT_TURN_CENTS = 10;

/** Per Chief (Storytell) think call — flat up-front estimate (legacy; see CHIEF_CENTS_PER_CREDIT). */
export const CHIEF_CALL_CENTS = 5;

export function anthropicTurnCents(model?: string): number {
  const known = model ? ANTHROPIC_TURN_CENTS[model] : undefined;
  return known ?? ANTHROPIC_DEFAULT_TURN_CENTS;
}

/** Dollars string for display; never negative (design spec §7.3 — ledger may be negative). */
export function formatBalance(balanceCents: number): string {
  return `$${(Math.max(0, balanceCents) / 100).toFixed(2)}`;
}
