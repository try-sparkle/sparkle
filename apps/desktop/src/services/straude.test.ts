// The straude staleness predicate — the only logic in this service that is not a thin IPC wrapper,
// and the thing that decides whether the Tools row shows its "Not publishing" alarm.
import { describe, expect, it } from "vitest";
import {
  STRAUDE_STALE_AFTER_SECS,
  straudeReportFailing,
  straudeSignInExpiring,
  type StraudeStatus,
} from "./straude";

const NOW = 1_800_000_000;

const LIVE: StraudeStatus = {
  enabled: true,
  username: "drodio",
  hasToken: true,
  consented: true,
  deviceId: "abc",
  deviceName: "Sparkle",
  reportDays: 7,
  lastReportAt: NOW - 60,
  lastStatus: "Reported 7 day(s).",
  blockedBy: null,
  blockedCode: null,
  expiresInDays: null,
  expired: false,
  serverUrl: "https://straude.com",
};

describe("straudeReportFailing", () => {
  it("a healthy reporter that just landed is not failing", () => {
    expect(straudeReportFailing(LIVE, NOW)).toBe(false);
  });

  // The one thing this must never do. An install that never opted in is the NORMAL state, and
  // rendering it as an alarm teaches the user to ignore the badge — including on the day it is
  // real. Checked first and winning outright, even over a stored failure message from before the
  // toggle went off.
  it("a BENIGN blocked reporter is never failing, even carrying a stale failure message", () => {
    // The normal state of an un-opted-in install. Rendering it as an alarm teaches the user to
    // ignore the badge — including on the day it is real.
    for (const blockedCode of ["disabled", "no_consent", "cooling_down"]) {
      expect(
        straudeReportFailing(
          {
            ...LIVE,
            blockedCode,
            blockedBy: "some prose",
            lastStatus: "Last report failed — network error: nope.",
          },
          NOW,
        ),
      ).toBe(false);
    }
  });

  // THE BUG THIS PREDICATE SHIPPED WITH, and the reason it is an allow-list of codes rather than
  // `blockedBy != null`. straude's blocked_by runs the FULL gate, unlike the Builder Index's, so it
  // also carries the states the badge exists for. Exempting any non-null value made the row go
  // silent for a broken sign-in and for a rate-limited account.
  it("an ACTIONABLE block is a failure the badge must show", () => {
    for (const blockedCode of ["bad_token", "token_expired", "no_token"]) {
      expect(straudeReportFailing({ ...LIVE, blockedCode, blockedBy: "prose" }, NOW)).toBe(true);
    }
  });

  // `no_token` READS like "never signed in", which is why it was on the benign list. It cannot be:
  // consent_gate reports the toggle and consent first, so this code is only reachable once the
  // install is enabled AND consented — an opted-in user whose keychain entry was deleted, or whose
  // keychain is locked. Reporting is dead until they sign in again, and nothing else says so.
  it("a MISSING token on an opted-in install is a failure, not the un-opted-in normal state", () => {
    expect(
      straudeReportFailing(
        { ...LIVE, blockedCode: "no_token", blockedBy: "not signed in to straude" },
        NOW,
      ),
    ).toBe(true);
  });

  it("a rate-limited reporter is not exempt, so a chronic backoff still goes stale", () => {
    // A 429 can set a six-hour backoff while the loop cycles every two, so a chronically limited
    // account is in backoff nearly all the time. Under the old exemption the badge could
    // essentially never fire. Not an INSTANT alarm — reporting may genuinely resume — but it must
    // not be muted, so the staleness rule still reaches it.
    const limited = {
      ...LIVE,
      blockedCode: "rate_limited",
      blockedBy: "straude is rate-limiting this account",
      lastStatus: "straude is rate-limiting this account",
    };
    expect(straudeReportFailing(limited, NOW)).toBe(false);
    expect(
      straudeReportFailing({ ...limited, lastReportAt: NOW - STRAUDE_STALE_AFTER_SECS - 1 }, NOW),
    ).toBe(true);
  });

  it("an unrecognized block code is not treated as benign", () => {
    // A gate reason added later must SURFACE rather than silently mute the badge.
    expect(
      straudeReportFailing(
        { ...LIVE, blockedCode: "some_future_reason", lastReportAt: null },
        NOW,
      ),
    ).toBe(true);
  });

  it("no cycle has recorded an outcome yet is not failing", () => {
    // Reporting starts five minutes after launch; there is nothing to call failed before then.
    expect(straudeReportFailing({ ...LIVE, lastStatus: null, lastReportAt: null }, NOW)).toBe(false);
  });

  it("the failure prefix is the fast path, so the badge appears on the first bad cycle", () => {
    expect(
      straudeReportFailing(
        { ...LIVE, lastStatus: "Last report failed — straude returned 500." },
        NOW,
      ),
    ).toBe(true);
  });

  // The LOAD-BEARING rule, and it is structural rather than textual: straude.rs advances
  // `last_report_at` only where every submitted day landed. A live reporter whose last success is
  // many cycles old is a reporter whose cycles are running and being discarded — a conclusion
  // reached without reading a word of the message.
  it("a live reporter whose last SUCCESS is stale is failing, whatever the message says", () => {
    const stale = { ...LIVE, lastReportAt: NOW - STRAUDE_STALE_AFTER_SECS - 1 };
    expect(straudeReportFailing(stale, NOW)).toBe(true);
    // And the boundary is not crossed a second early.
    expect(straudeReportFailing({ ...LIVE, lastReportAt: NOW - STRAUDE_STALE_AFTER_SECS }, NOW)).toBe(
      false,
    );
  });

  it("a null lastReportAt with a recorded status is failing", () => {
    // `== null` covers the serde shape: a Rust Option with no skip_serializing_if always emits the
    // key, so "never succeeded" arrives as an explicit null rather than an absent field.
    expect(straudeReportFailing({ ...LIVE, lastReportAt: null }, NOW)).toBe(true);
  });

  // A rate-limited cycle records the skip reason, NOT the failure prefix, and leaves lastReportAt
  // alone — so it is not an immediate alarm, but a long backoff eventually trips the staleness rule.
  // That is correct: reporting really has stopped by then.
});

describe("straudeSignInExpiring", () => {
  it("is true only when Rust decided the expiry is worth showing", () => {
    expect(straudeSignInExpiring(LIVE)).toBe(false);
    expect(straudeSignInExpiring({ ...LIVE, expiresInDays: 3 })).toBe(true);
    // An already-lapsed sign-in carries `expired`, NOT `expiresInDays: 0` — Rust keeps them apart
    // so "expires today" cannot render as "already dead". A predicate reading only the number
    // would miss the one state that actually needs the user to act.
    expect(straudeSignInExpiring({ ...LIVE, expired: true })).toBe(true);
  });
});
