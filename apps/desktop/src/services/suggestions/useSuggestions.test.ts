import { describe, it, expect } from "vitest";
import {
  shouldRecompute,
  hashScrollback,
  withinRetryBudget,
  retryBackoffMs,
  isTerminalComputeError,
  RETRY_BACKOFF_MS,
} from "./useSuggestions";

describe("isTerminalComputeError (skips retries that can't succeed)", () => {
  // The message shape the proxy/anthropic layer actually throws.
  const proxy = (code: number) => `Claude request failed: ai request failed (HTTP ${code})`;

  it("treats a 4xx as permanent — an identical retry only wastes a paid call", () => {
    expect(isTerminalComputeError(proxy(404))).toBe(true);
    expect(isTerminalComputeError(proxy(400))).toBe(true);
    expect(isTerminalComputeError(proxy(401))).toBe(true);
  });

  it("keeps retrying the codes that mean 'try again later'", () => {
    expect(isTerminalComputeError(proxy(408))).toBe(false);
    expect(isTerminalComputeError(proxy(429))).toBe(false);
  });

  it("keeps retrying 5xx — that's the transient gateway blip the backoff exists for", () => {
    expect(isTerminalComputeError(proxy(500))).toBe(false);
    expect(isTerminalComputeError(proxy(502))).toBe(false);
    expect(isTerminalComputeError(proxy(503))).toBe(false);
  });

  it("retries anything with no HTTP status (transport errors, unknown rejections)", () => {
    expect(isTerminalComputeError("Claude request failed: ai request failed")).toBe(false);
    expect(isTerminalComputeError("bad JSON: unexpected token")).toBe(false);
    expect(isTerminalComputeError("")).toBe(false);
  });
});

describe("withinRetryBudget (bounds persistent-rejection retries)", () => {
  it("allows retries below the cap (3) and stops at it", () => {
    expect(withinRetryBudget(0)).toBe(true);
    expect(withinRetryBudget(1)).toBe(true);
    expect(withinRetryBudget(2)).toBe(true);
    expect(withinRetryBudget(3)).toBe(false);
    expect(withinRetryBudget(4)).toBe(false);
  });
});

describe("retryBackoffMs (spaces out failed-compute retries)", () => {
  it("grows exponentially from the base delay", () => {
    // `failures` = attempts already failed (1 after the first failure).
    expect(retryBackoffMs(1)).toBe(RETRY_BACKOFF_MS);
    expect(retryBackoffMs(2)).toBe(RETRY_BACKOFF_MS * 2);
    expect(retryBackoffMs(3)).toBe(RETRY_BACKOFF_MS * 4);
  });
  it("never returns less than the base (guards failures <= 0)", () => {
    expect(retryBackoffMs(0)).toBe(RETRY_BACKOFF_MS);
    expect(retryBackoffMs(-5)).toBe(RETRY_BACKOFF_MS);
  });
  it("is capped so it never stalls the UI", () => {
    expect(retryBackoffMs(100)).toBeLessThanOrEqual(4000);
  });
});

describe("suggestion recompute gating", () => {
  it("recomputes on a new scrollback hash", () => {
    expect(shouldRecompute({ lastHash: "x", nextHash: "y", composerEmpty: true })).toBe(true);
  });
  it("skips when hash unchanged", () => {
    expect(shouldRecompute({ lastHash: "x", nextHash: "x", composerEmpty: true })).toBe(false);
  });
  it("skips when composer is non-empty", () => {
    expect(shouldRecompute({ lastHash: "x", nextHash: "y", composerEmpty: false })).toBe(false);
  });
  it("recomputes on first run (null lastHash)", () => {
    expect(shouldRecompute({ lastHash: null, nextHash: "y", composerEmpty: true })).toBe(true);
  });
});

describe("hashScrollback", () => {
  it("is stable for the same input", () => {
    expect(hashScrollback("abc")).toBe(hashScrollback("abc"));
  });
  it("differs on change", () => {
    expect(hashScrollback("abc")).not.toBe(hashScrollback("abd"));
  });
});
