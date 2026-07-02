import { describe, expect, it } from "vitest";
import {
  CREDIT_MARKUP,
  DEEPGRAM_NOVA3_COST_CENTS_PER_MIN,
  formatBalance,
} from "./creditPricing";

// NOTE (tasks #10/#13): Anthropic, Chief AND Deepgram-dictation pricing all moved server-side
// (apps/orchestration aiPricing.ts) — those calls/streams are metered on actual usage by the
// /ai/anthropic + /ai/chief + /ai/deepgram proxies, so the desktop no longer owns their rate tables,
// up-front estimates, or the per-minute dictation meter. Only the raw Deepgram vendor cost (reference)
// and the balance-display helper remain here.

describe("Deepgram cloud-dictation pricing (reference vendor cost)", () => {
  it("keeps the raw vendor cost the server marks up 10x", () => {
    expect(CREDIT_MARKUP).toBe(10);
    // Deepgram Nova-3 Multilingual: $0.0058/min cost (the relay charges 10× = 5.8¢/min server-side).
    expect(DEEPGRAM_NOVA3_COST_CENTS_PER_MIN).toBeCloseTo(0.58, 5);
  });
});

describe("formatBalance", () => {
  it("formats cents as dollars", () => {
    expect(formatBalance(20000)).toBe("$200.00");
    expect(formatBalance(18250)).toBe("$182.50");
  });
  it("clamps a negative ledger balance to $0.00 for display", () => {
    expect(formatBalance(-500)).toBe("$0.00");
  });
});
