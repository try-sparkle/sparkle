import { describe, expect, it } from "vitest";

import { currentUsageLimit, USAGE_LIMIT_RECHECK_MS } from "./usageLimit";
import type { Usage } from "../services/accountStore";

const T0 = 1_700_000_000_000;

function acct(id: string, exhaustedUntil: number | null): Usage {
  return { id, tokens5h: 0, tokens7d: 0, exhaustedUntil };
}

describe("currentUsageLimit", () => {
  it("asserts nothing before the accounts have been read", () => {
    // An empty list is an ABSENCE of evidence, not evidence of health. The banner must stay hidden
    // rather than announce a pause nobody observed.
    expect(currentUsageLimit([], T0)).toBeNull();
  });

  it("reports no limit while an account is usable", () => {
    expect(currentUsageLimit([acct("a", null)], T0)).toBeNull();
  });

  it("reports the limit, with its real reset instant, while one is live", () => {
    const until = T0 + 60_000;
    expect(currentUsageLimit([acct("a", until)], T0)).toEqual({ accountId: "a", until });
  });

  // ── THE SELF-CLEARING PROPERTY ────────────────────────────────────────────────────────────────
  // This is the bug the founder reported, reduced to arithmetic: the ONLY thing that changes
  // between these two assertions is the clock. No successful AI call, no reload, no dismissal, no
  // user action of any kind. The latched design could not do this at any poll rate, because its
  // clear path required a *different* subsystem to emit a success event.
  it("clears itself once the reset instant passes, with no user action", () => {
    const until = T0 + 60_000;
    const usage = [acct("a", until)];

    expect(currentUsageLimit(usage, T0)).not.toBeNull();
    expect(currentUsageLimit(usage, until)).toBeNull();
    expect(currentUsageLimit(usage, until + 1)).toBeNull();
  });

  it("counts the reset instant itself as recovered, not as one tick more of outage", () => {
    // `<= now`, not `< now`. A banner that outlives its own stated deadline is the "it's old"
    // complaint in miniature.
    const until = T0 + 5_000;
    expect(currentUsageLimit([acct("a", until)], until)).toBeNull();
  });

  // ── FAILOVER ──────────────────────────────────────────────────────────────────────────────────
  it("reports no pause when any account can still serve the next call", () => {
    // Multi-Max failover: accountStore skips benched accounts, so one bench out of two means AI is
    // fine. Firing here would assert a pause that is not happening — the same false claim as the
    // stale banner, arriving from the opposite direction.
    const usage = [acct("a", T0 + 60_000), acct("b", null)];
    expect(currentUsageLimit(usage, T0)).toBeNull();
  });

  it("reports a pause only when every account is benched", () => {
    const usage = [acct("a", T0 + 60_000), acct("b", T0 + 30_000)];
    expect(currentUsageLimit(usage, T0)).not.toBeNull();
  });

  it("names the account that frees up SOONEST, because that is when the pause ends", () => {
    // The first account back serves the next call, so the earliest reset is the honest answer.
    // Reporting the latest would overstate the outage to the user.
    const usage = [acct("late", T0 + 600_000), acct("soon", T0 + 60_000)];
    expect(currentUsageLimit(usage, T0)).toEqual({ accountId: "soon", until: T0 + 60_000 });
  });

  it("ignores an account whose bench already lapsed when ranking the rest", () => {
    // A lapsed bench makes the account USABLE, which short-circuits the whole question — it must
    // not be treated as "limited, a long time ago" and let the others decide.
    const usage = [acct("lapsed", T0 - 1), acct("live", T0 + 60_000)];
    expect(currentUsageLimit(usage, T0)).toBeNull();
  });

  it("survives an account switch, because the answer is derived and never latched", () => {
    // The founder logged into a NEW Claude account while the old one's banner was showing. The
    // latched store had no account identity and kept asserting the old limit. Derived state simply
    // reads whatever accounts exist now.
    const before = [acct("old", T0 + 3_600_000)];
    const after = [acct("new", null)];
    expect(currentUsageLimit(before, T0)).not.toBeNull();
    expect(currentUsageLimit(after, T0)).toBeNull();
  });

  it("does not mutate the caller's list", () => {
    const usage = [acct("a", T0 + 60_000), acct("b", T0 + 30_000)];
    const snapshot = JSON.stringify(usage);
    currentUsageLimit(usage, T0);
    expect(JSON.stringify(usage)).toBe(snapshot);
  });
});

describe("USAGE_LIMIT_RECHECK_MS", () => {
  it("is fine enough that a lifted limit retires promptly", () => {
    // Only runs while the banner is up, so this costs nothing on a healthy machine. Asserted so the
    // constant cannot drift up into "stale again" territory without this failing.
    expect(USAGE_LIMIT_RECHECK_MS).toBeLessThanOrEqual(15_000);
    expect(USAGE_LIMIT_RECHECK_MS).toBeGreaterThan(0);
  });
});
