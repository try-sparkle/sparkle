import { describe, expect, it } from "vitest";
import {
  authIdentity,
  avatarLetter,
  deriveAuthControl,
  deriveAuthView,
  parseAuthCode,
  parseAuthState,
  type Me,
} from "./entitlement";

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

describe("deriveAuthControl", () => {
  it("is loading while either auth or trial is still loading", () => {
    expect(deriveAuthControl({ ...base, loading: true, hasToken: false, me: null })).toBe("loading");
    expect(
      deriveAuthControl({ ...base, loading: false, hasToken: false, me: null, trialLoading: true }),
    ).toBe("loading");
  });
  it("no token + trial not started -> new (Sign up), matching the welcome first-run signal", () => {
    expect(deriveAuthControl({ ...base, loading: false, hasToken: false, me: null })).toBe("new");
  });
  it("no token + trial started -> returning (Log in)", () => {
    expect(
      deriveAuthControl({ ...base, loading: false, hasToken: false, me: null, trialStarted: true }),
    ).toBe("returning");
  });
  it("token present -> signedIn (even before /me resolves, e.g. offline)", () => {
    expect(deriveAuthControl({ ...base, loading: false, hasToken: true, me: null })).toBe("signedIn");
    expect(deriveAuthControl({ ...base, loading: false, hasToken: true, me: me() })).toBe("signedIn");
  });
});

describe("authIdentity", () => {
  it("prefers name, then email, then clerkUserId, trimmed", () => {
    expect(authIdentity(me({ name: "  Ada  ", email: "z@x.io" }))).toBe("Ada");
    expect(authIdentity(me({ name: null, email: " bob@x.io " }))).toBe("bob@x.io");
    expect(authIdentity(me({ name: null, email: null, clerkUserId: " zeta " }))).toBe("zeta");
  });
  it("treats a blank/whitespace field as absent (falls through for BOTH letter and label)", () => {
    expect(authIdentity(me({ name: "   ", email: "bob@x.io" }))).toBe("bob@x.io");
    // The letter and the identity agree on the same source — no glyph/label mismatch.
    expect(avatarLetter(me({ name: "   ", email: "bob@x.io" }))).toBe("B");
  });
  it("is null when nothing is resolvable", () => {
    expect(authIdentity(null)).toBeNull();
    expect(authIdentity(me({ name: "", email: "", clerkUserId: "" }))).toBeNull();
  });
});

describe("avatarLetter", () => {
  it("prefers name, uppercased", () => {
    expect(avatarLetter(me({ name: "ada", email: "z@x.io" }))).toBe("A");
  });
  it("falls back to email, then clerkUserId", () => {
    expect(avatarLetter(me({ name: null, email: "bob@x.io" }))).toBe("B");
    expect(avatarLetter(me({ name: null, email: null, clerkUserId: "zeta" }))).toBe("Z");
  });
  it("an empty-but-present field falls through (|| not ??)", () => {
    expect(avatarLetter(me({ name: "", email: "bob@x.io" }))).toBe("B");
    expect(avatarLetter(me({ name: "", email: "", clerkUserId: "zeta" }))).toBe("Z");
  });
  it("reads the first code point of an astral identity (no broken surrogate)", () => {
    // The whole first code point comes back intact (𝔸 has no case mapping) — not a lone UTF-16
    // surrogate, which would have length 1 and render as a replacement glyph.
    const letter = avatarLetter(me({ name: "𝔸da" }));
    expect(letter).toBe("𝔸");
    expect(Array.from(letter)).toHaveLength(1);
  });
  it("ignores leading whitespace", () => {
    expect(avatarLetter(me({ name: "  ne0" }))).toBe("N");
  });
  it("returns '' when nothing is resolvable (caller shows a neutral glyph)", () => {
    expect(avatarLetter(null)).toBe("");
    expect(avatarLetter(me({ name: "", email: "", clerkUserId: "" }))).toBe("");
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

describe("parseAuthState", () => {
  it("extracts the echoed state from a sparkle://auth deep link", () => {
    expect(parseAuthState("sparkle://auth?code=abc&state=st8-xyz")).toBe("st8-xyz");
  });
  it("url-decodes the state", () => {
    expect(parseAuthState("sparkle://auth?code=abc&state=a%2Bb")).toBe("a+b");
  });
  it("returns '' (never null) when the state is absent, so exchangeCode always gets a string", () => {
    expect(parseAuthState("sparkle://auth?code=abc")).toBe("");
    expect(parseAuthState("sparkle://auth?code=abc&state=")).toBe("");
  });
  it("returns '' for the wrong scheme or a non-auth host (mirrors parseAuthCode gating)", () => {
    expect(parseAuthState("https://example.com/auth?state=x")).toBe("");
    expect(parseAuthState("sparkle://open?state=x")).toBe("");
  });
  it("returns '' for malformed input", () => {
    expect(parseAuthState("not a url")).toBe("");
    expect(parseAuthState("")).toBe("");
  });
});
