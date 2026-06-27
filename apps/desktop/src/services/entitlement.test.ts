import { describe, expect, it } from "vitest";
import { deriveAuthView, parseAuthCode, type Me } from "./entitlement";

const me = (over: Partial<Me> = {}): Me => ({
  clerkUserId: "u",
  entitled: true,
  balanceCents: 20000,
  tokenVersion: 1,
  ...over,
});

const base = { trialStarted: false, trialLoading: false };

describe("deriveAuthView", () => {
  it("is loading while either auth or trial is still loading", () => {
    expect(deriveAuthView({ ...base, loading: true, hasToken: true, me: me() })).toBe("loading");
    expect(deriveAuthView({ ...base, loading: false, hasToken: false, me: null, trialLoading: true })).toBe(
      "loading",
    );
  });
  it("no token + trial not started -> welcome", () => {
    expect(deriveAuthView({ ...base, loading: false, hasToken: false, me: null })).toBe("welcome");
  });
  it("no token + trial started -> trial", () => {
    expect(
      deriveAuthView({ ...base, loading: false, hasToken: false, me: null, trialStarted: true }),
    ).toBe("trial");
  });
  it("token present but /me not yet loaded falls back to welcome", () => {
    expect(deriveAuthView({ ...base, loading: false, hasToken: true, me: null })).toBe("welcome");
  });
  it("is unpaid when authenticated but not entitled (regardless of trial)", () => {
    expect(
      deriveAuthView({ ...base, loading: false, hasToken: true, me: me({ entitled: false }), trialStarted: true }),
    ).toBe("unpaid");
  });
  it("is entitled when paid", () => {
    expect(deriveAuthView({ ...base, loading: false, hasToken: true, me: me({ entitled: true }) })).toBe(
      "entitled",
    );
  });
});

describe("parseAuthCode", () => {
  it("extracts the code from a sparkle://auth deep link", () => {
    expect(parseAuthCode("sparkle://auth?code=abc123")).toBe("abc123");
  });
  it("url-decodes the code", () => {
    expect(parseAuthCode("sparkle://auth?code=a%2Bb")).toBe("a+b");
  });
  it("returns null for a missing code", () => {
    expect(parseAuthCode("sparkle://auth")).toBeNull();
    expect(parseAuthCode("sparkle://auth?code=")).toBeNull();
  });
  it("returns null for the wrong scheme", () => {
    expect(parseAuthCode("https://example.com/auth?code=abc")).toBeNull();
  });
  it("returns null for a sparkle:// route other than auth (host gating)", () => {
    expect(parseAuthCode("sparkle://open?code=abc")).toBeNull();
    expect(parseAuthCode("sparkle://logout?code=abc")).toBeNull();
  });
  it("returns null for malformed input", () => {
    expect(parseAuthCode("not a url")).toBeNull();
    expect(parseAuthCode("")).toBeNull();
  });
});
