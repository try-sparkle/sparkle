import { describe, expect, it, vi } from "vitest";

import { getDateTimeFormat } from "./intlFormatCache";

// A fixed instant so every golden comparison is deterministic. 2026-08-17 22:59 UTC.
const FIXED = new Date(Date.UTC(2026, 7, 17, 22, 59));

// The cache is module-scoped and persists across the tests in this file. Rather than reset it
// between tests (which would need a test-only export the production app never calls — a dormant
// export), each construction-COUNTING test below uses an options object that appears in NO other
// test, so its cache key is provably empty when that test installs its spy. The golden tests do not
// count constructions, so they may share keys freely.

describe("getDateTimeFormat — the cache is what makes the renderer stop rebuilding ICU formatters", () => {
  it("constructs ONE Intl.DateTimeFormat across many identical requests, not one per call", () => {
    // The SIDE EFFECT under test is the amortized construction: a list rendering N rows must build
    // the ICU formatter once, not N times. Spy on the constructor and count. Revert the cache hoist
    // (construct fresh every call) and this reds at N instead of 1 — the mutation-check.
    // `weekday: long` is unique to this test, so its cache key is unpopulated before the spy.
    const realCtor = Intl.DateTimeFormat;
    const spy = vi
      .spyOn(Intl, "DateTimeFormat")
      .mockImplementation(
        (locale?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) =>
          new realCtor(locale, options),
      );
    try {
      const opts: Intl.DateTimeFormatOptions = { weekday: "long", hour: "numeric" };
      for (let i = 0; i < 25; i++) {
        getDateTimeFormat(undefined, opts).format(new Date(FIXED.getTime() + i * 60_000));
      }
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns the very same formatter instance for identical arguments", () => {
    const opts: Intl.DateTimeFormatOptions = { weekday: "short", year: "numeric" };
    expect(getDateTimeFormat("en-US", opts)).toBe(getDateTimeFormat("en-US", opts));
  });

  it("builds a separate formatter per distinct locale or options key", () => {
    // Caching must not over-share: a different locale or a different option set is a different
    // formatter, or some caller silently gets the wrong output. `era` keys are unique to this test.
    const realCtor = Intl.DateTimeFormat;
    const spy = vi
      .spyOn(Intl, "DateTimeFormat")
      .mockImplementation(
        (locale?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) =>
          new realCtor(locale, options),
      );
    try {
      getDateTimeFormat("en-US", { era: "short", year: "numeric" });
      getDateTimeFormat("en-US", { era: "short", year: "numeric" }); // repeat — no new construction
      getDateTimeFormat("en-GB", { era: "short", year: "numeric" }); // different locale
      getDateTimeFormat("en-US", { era: "long", year: "numeric" }); // different options
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("getDateTimeFormat — output is byte-identical to the uncached toLocale* paths it replaced", () => {
  // Each golden pins the cached formatter's string against the exact call the hot site used BEFORE
  // this change, so the cache can never silently alter what the user sees. If these drift, the
  // caching changed the rendered text — a regression, not a speedup.

  it("matches toLocaleTimeString([], {hour, minute}) — AccountsScreen / AccountLimitModal / ProviderUnavailableBanner", () => {
    const opts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
    expect(getDateTimeFormat(undefined, opts).format(FIXED)).toBe(
      FIXED.toLocaleTimeString([], opts),
    );
  });

  it("matches toLocaleDateString(undefined, {year, month, day}) — WhatsNewPanel / MobileDevicesPane", () => {
    const opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };
    expect(getDateTimeFormat(undefined, opts).format(FIXED)).toBe(
      FIXED.toLocaleDateString(undefined, opts),
    );
  });

  it("matches toLocaleString(undefined, {month, day, hour, minute}) — AccountSpawnLog", () => {
    const opts: Intl.DateTimeFormatOptions = {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    };
    expect(getDateTimeFormat(undefined, opts).format(FIXED)).toBe(
      FIXED.toLocaleString(undefined, opts),
    );
  });

  it("matches a fresh en-US formatter's format AND formatToParts — accountsView / rateLimitWatch / scrubberGeometry", () => {
    const opts: Intl.DateTimeFormatOptions = {
      timeZone: "America/Los_Angeles",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    };
    const fresh = new Intl.DateTimeFormat("en-US", opts);
    expect(getDateTimeFormat("en-US", opts).format(FIXED)).toBe(fresh.format(FIXED));
    // accountsView + rateLimitWatch read formatToParts, so pin that shape too.
    expect(getDateTimeFormat("en-US", opts).formatToParts(FIXED)).toEqual(
      fresh.formatToParts(FIXED),
    );
  });
});
