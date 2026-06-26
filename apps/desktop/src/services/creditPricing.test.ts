import { describe, expect, it } from "vitest";
import {
  CHIEF_CALL_CENTS,
  CREDIT_MARKUP,
  CLOUD_DICTATION_CENTS_PER_MIN,
  CHIEF_CENTS_PER_CREDIT,
  anthropicTokenCents,
  chiefCents,
  anthropicTurnCents,
  formatBalance,
} from "./creditPricing";

describe("anthropicTurnCents", () => {
  it("prices known models", () => {
    expect(anthropicTurnCents("claude-opus-4-8")).toBe(25);
    expect(anthropicTurnCents("claude-sonnet-4-6")).toBe(8);
    expect(anthropicTurnCents("claude-haiku-4-5")).toBe(1);
  });
  it("falls back to a default for unknown/absent models", () => {
    expect(anthropicTurnCents("some-future-model")).toBe(10);
    expect(anthropicTurnCents(undefined)).toBe(10);
  });
});

describe("CHIEF_CALL_CENTS", () => {
  it("is a positive estimate", () => {
    expect(CHIEF_CALL_CENTS).toBeGreaterThan(0);
  });
});

describe("10x pricing table", () => {
  it("charges 10x the vendor cost across services", () => {
    expect(CREDIT_MARKUP).toBe(10);
    // Deepgram Nova-3 Multilingual: $0.0058/min cost → 5.8¢/min charged.
    expect(CLOUD_DICTATION_CENTS_PER_MIN).toBeCloseTo(5.8, 5);
    // Chief: 0.1¢/credit cost → 1¢/credit charged.
    expect(CHIEF_CENTS_PER_CREDIT).toBeCloseTo(1, 5);
  });

  it("anthropicTokenCents bills input and output tokens at 10x (Haiku $1/$5 per MTok)", () => {
    // 1M input tokens: $1 cost → $10 = 1000¢.
    expect(anthropicTokenCents("claude-haiku-4-5", 1_000_000, 0)).toBeCloseTo(1000, 5);
    // 1M output tokens: $5 cost → $50 = 5000¢.
    expect(anthropicTokenCents("claude-haiku-4-5", 0, 1_000_000)).toBeCloseTo(5000, 5);
    // Mixed scales linearly.
    expect(anthropicTokenCents("claude-haiku-4-5", 500_000, 200_000)).toBeCloseTo(500 + 1000, 5);
    // A DATED model id (as Anthropic actually returns) resolves to the base rate, not 0.
    expect(anthropicTokenCents("claude-haiku-4-5-20251001", 1_000_000, 0)).toBeCloseTo(1000, 5);
    // Unknown model isn't metered by the token table.
    expect(anthropicTokenCents("some-future-model", 1_000_000, 1_000_000)).toBe(0);
  });

  it("chiefCents charges 1¢ per Chief credit reported", () => {
    expect(chiefCents(50)).toBeCloseTo(50, 5);
    expect(chiefCents(0)).toBe(0);
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
