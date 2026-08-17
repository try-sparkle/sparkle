import { describe, it, expect } from "vitest";
import {
  parseResetInstant,
  resetInstantFor,
  SESSION_WINDOW_MS,
  type LimitEvent,
} from "./rateLimitWatch";

/** Helper: the epoch-ms instant at which wall clock in `tz` reads the given Y/M/D H:M. Computed
 *  independently of the module under test (via Intl offset lookup) so the assertions don't just
 *  re-run the implementation. */
function instantAt(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const off = (ms: number) => {
    const p: Record<string, string> = {};
    for (const { type, value } of new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(ms)))
      p[type] = value;
    const hour = p.hour === "24" ? 0 : Number(p.hour);
    return (
      Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second)) - ms
    );
  };
  return guess - off(guess - off(guess));
}

describe("parseResetInstant — real messages Claude Code emits", () => {
  // The exact event that stalled a real agent on 2026-07-26. The Phase-1 parser scored a double
  // miss on this string: the phrase matcher didn't contain "session limit", and the time parser
  // required the word "at" (absent here), so it fell through to a blind 4h backoff.
  it("parses 'resets 2:20pm (America/Bogota)' exactly", () => {
    const at = Date.parse("2026-07-26T15:55:24.145Z"); // 10:55:24 in Bogota
    const got = parseResetInstant(
      "You've hit your session limit · resets 2:20pm (America/Bogota)",
      at,
    );
    expect(got).toBe(instantAt("America/Bogota", 2026, 7, 26, 14, 20));
    // Sanity: ~3h25m out, NOT the 4h blind backoff the old code produced.
    expect(got - at).toBeGreaterThan(3 * 3600_000);
    expect(got - at).toBeLessThan(3.5 * 3600_000);
    expect(got).not.toBe(at + SESSION_WINDOW_MS);
  });

  it("parses a whole-hour reset in a different zone from the machine's", () => {
    const at = Date.parse("2026-07-24T23:40:26.360Z");
    const got = parseResetInstant(
      "You've hit your session limit · resets 8pm (America/Los_Angeles)",
      at,
    );
    // 23:40Z is 16:40 in LA → 8pm the SAME LA day.
    expect(got).toBe(instantAt("America/Los_Angeles", 2026, 7, 24, 20, 0));
  });

  it("rolls to the next day when the named time already passed in that zone", () => {
    const at = Date.parse("2026-07-25T04:08:00.000Z"); // 21:08 on Jul 24 in LA
    const got = parseResetInstant("You've hit your session limit · resets 9pm (America/Los_Angeles)", at);
    // 9pm Jul 24 LA already passed → next occurrence is Jul 25.
    expect(got).toBe(instantAt("America/Los_Angeles", 2026, 7, 25, 21, 0));
    expect(got).toBeGreaterThan(at);
  });

  it("still accepts the older 'will reset at 3pm' phrasing", () => {
    const at = Date.parse("2026-07-26T15:00:00.000Z");
    const got = parseResetInstant("Claude usage limit reached — will reset at 3pm (America/Bogota)", at);
    expect(got).toBe(instantAt("America/Bogota", 2026, 7, 26, 15, 0));
  });

  it("parses a WEEKLY-limit message the same as a session one (bead sparkle-hbyae)", () => {
    // The founder's real wall: "You've hit your weekly limit · resets 4pm". Detection is agnostic to
    // session-vs-weekly — it parses the reset clock, not the noun — so a weekly cap benches just like
    // a session one. This locks that: the parser must NOT fall back to the 5h SESSION window for a
    // weekly message, which would return the account to rotation while it is still weekly-walled.
    const at = Date.parse("2026-08-13T22:00:00.000Z"); // 3pm LA
    const got = parseResetInstant(
      "You've hit your weekly limit · resets 4pm (America/Los_Angeles)",
      at,
    );
    expect(got).toBe(instantAt("America/Los_Angeles", 2026, 8, 13, 16, 0));
    expect(got).not.toBe(at + SESSION_WINDOW_MS);
  });
});

describe("parseResetInstant — falls back rather than guessing wrong", () => {
  const at = Date.parse("2026-07-26T15:55:24.145Z");
  const FALLBACK = at + SESSION_WINDOW_MS;

  it("falls back when no reset time is present at all", () => {
    expect(parseResetInstant("You've hit your session limit", at)).toBe(FALLBACK);
    expect(parseResetInstant("", at)).toBe(FALLBACK);
  });

  it("falls back when a wall time carries no zone (it can't be placed on the timeline)", () => {
    expect(parseResetInstant("resets 2:20pm", at)).toBe(FALLBACK);
  });

  it("falls back on an ambiguous bare hour instead of guessing AM", () => {
    expect(parseResetInstant("resets 3 (America/Bogota)", at)).toBe(FALLBACK);
    expect(parseResetInstant("resets 12 (America/Bogota)", at)).toBe(FALLBACK);
  });

  it("falls back on an out-of-range time rather than producing a bad date", () => {
    expect(parseResetInstant("resets 99pm (America/Bogota)", at)).toBe(FALLBACK);
    expect(parseResetInstant("resets 7:88pm (America/Bogota)", at)).toBe(FALLBACK);
  });

  it("falls back on an unknown time zone", () => {
    expect(parseResetInstant("resets 2:20pm (Mars/Olympus_Mons)", at)).toBe(FALLBACK);
  });

  it("accepts an unambiguous 24h hour with a zone", () => {
    expect(parseResetInstant("resets 18:30 (America/Bogota)", at)).toBe(
      instantAt("America/Bogota", 2026, 7, 26, 18, 30),
    );
  });

  it("never returns an instant in the past", () => {
    for (const text of [
      "resets 2:20pm (America/Bogota)",
      "resets 9pm (America/Los_Angeles)",
      "resets 18:30 (America/Bogota)",
      "resets 1:10am (America/Los_Angeles)",
    ]) {
      expect(parseResetInstant(text, at)).toBeGreaterThan(at);
    }
  });
});

describe("parseResetInstant — DST correctness", () => {
  it("resolves a wall time across a spring-forward boundary without drifting an hour", () => {
    // US DST began 2026-03-08. An event on Mar 7 naming 9pm must land on Mar 7 PST, not shift.
    const at = Date.parse("2026-03-08T02:00:00.000Z"); // 18:00 Mar 7 in LA
    const got = parseResetInstant("resets 9pm (America/Los_Angeles)", at);
    expect(got).toBe(instantAt("America/Los_Angeles", 2026, 3, 7, 21, 0));
  });
});

describe("resetInstantFor", () => {
  it("resolves a structured LimitEvent to its account's free-up instant", () => {
    const ev: LimitEvent = {
      accountId: "ef6ce18fe79bcf53",
      at: Date.parse("2026-07-26T15:55:24.145Z"),
      text: "You've hit your session limit · resets 2:20pm (America/Bogota)",
    };
    expect(resetInstantFor(ev)).toBe(instantAt("America/Bogota", 2026, 7, 26, 14, 20));
  });
});

describe("the Phase-1 false-positive class is structurally impossible now", () => {
  // Phase 1 scraped raw PTY text for `rate limit|usage limit|limit reached|too many requests`, so an
  // agent's OWN prose benched a healthy account for 4 hours. That bug is not fixed by a better
  // regex — it's fixed by only ever being handed a STRUCTURED event (error === "rate_limit"). This
  // module no longer has an "is this a limit message?" entry point at all; the only question it
  // answers is "given a confirmed event, when does it reset?". These strings are the exact prose
  // that benched two real accounts, and there is now no API that could act on them.
  it("exposes no text-classification entry point", async () => {
    const mod = await import("./rateLimitWatch");
    expect(Object.keys(mod).sort()).toEqual(
      ["SESSION_WINDOW_MS", "parseResetInstant", "resetInstantFor"].sort(),
    );
    // The removed Phase-1 API is gone for good.
    expect((mod as Record<string, unknown>).detectRateLimitReset).toBeUndefined();
    expect((mod as Record<string, unknown>).DEFAULT_BACKOFF_MS).toBeUndefined();
  });

  it("treats agent prose about limits as ordinary text with no reset time", () => {
    const at = Date.parse("2026-07-26T15:55:24.145Z");
    const prose = [
      "rateLimitWatch.ts:24 matches only `rate limit | usage limit | limit reached | too many requests`.",
      "The detector doesn't match the message Claude Code actually prints.",
      "429 Too Many Requests — check rate limit headers for retry timing",
    ];
    // Each yields only the neutral session-window fallback; none can name an earlier or later
    // instant, and none can *originate* an exhaustion (that requires a structured event).
    for (const p of prose) expect(parseResetInstant(p, at)).toBe(at + SESSION_WINDOW_MS);
  });
});
