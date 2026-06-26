import { describe, it, expect } from "vitest";
import { detectRateLimitReset, DEFAULT_BACKOFF_MS } from "./rateLimitWatch";

// Fixed reference instant: 2026-06-26T12:00:00 local.
const NOW = new Date(2026, 5, 26, 12, 0, 0, 0).getTime();

describe("detectRateLimitReset", () => {
  it("returns null for ordinary terminal output", () => {
    expect(detectRateLimitReset("Running tests… all green", NOW)).toBeNull();
    expect(detectRateLimitReset("", NOW)).toBeNull();
  });

  it("does NOT trip on ordinary 'reset … at' text without a limit phrase (no false failover)", () => {
    // The whole point of narrowing the trigger: a coding agent printing/discussing these must not
    // bench a healthy account.
    expect(detectRateLimitReset("Cache resets at 9am during startup", NOW)).toBeNull();
    expect(detectRateLimitReset("git reset --hard, then look at HEAD", NOW)).toBeNull();
    expect(detectRateLimitReset("The timer will reset at midnight", NOW)).toBeNull();
  });

  it("detects usage/rate-limit phrasing and defaults to a backoff when no reset time is given", () => {
    expect(detectRateLimitReset("You've hit your usage limit for this account.", NOW)).toBe(
      NOW + DEFAULT_BACKOFF_MS,
    );
    expect(detectRateLimitReset("Error: rate limit exceeded", NOW)).toBe(NOW + DEFAULT_BACKOFF_MS);
    expect(detectRateLimitReset("429 Too Many Requests", NOW)).toBe(NOW + DEFAULT_BACKOFF_MS);
  });

  it("parses a 'resets at <time>' later today into that instant (when a limit phrase is present)", () => {
    const until = detectRateLimitReset("Claude usage limit reached — your limit will reset at 3pm.", NOW);
    expect(until).toBe(new Date(2026, 5, 26, 15, 0, 0, 0).getTime());
  });

  it("rolls a reset time that already passed today to tomorrow", () => {
    // 9am already passed at NOW (noon) → next 9am is tomorrow.
    const until = detectRateLimitReset("usage limit — resets at 9:00 AM", NOW);
    expect(until).toBe(new Date(2026, 5, 27, 9, 0, 0, 0).getTime());
  });

  it("handles 24h-style reset times", () => {
    const until = detectRateLimitReset("limit reached; reset at 18:30", NOW);
    expect(until).toBe(new Date(2026, 5, 26, 18, 30, 0, 0).getTime());
  });

  it("defers an ambiguous bare hour (≤12, no am/pm) to the backoff instead of guessing", () => {
    // "reset at 3" could be 3pm; guessing 3am would bench the account ~15h. Fall back to backoff.
    expect(detectRateLimitReset("usage limit; reset at 3", NOW)).toBe(NOW + DEFAULT_BACKOFF_MS);
    // A bare "12" is midnight-vs-noon ambiguous → backoff too.
    expect(detectRateLimitReset("usage limit; reset at 12", NOW)).toBe(NOW + DEFAULT_BACKOFF_MS);
  });

  it("falls back to backoff on an out-of-range parsed time rather than producing a bad date", () => {
    // Matches the limit phrase but the hour is invalid → backoff, not NaN.
    expect(detectRateLimitReset("usage limit reached; reset at 99", NOW)).toBe(NOW + DEFAULT_BACKOFF_MS);
  });
});
