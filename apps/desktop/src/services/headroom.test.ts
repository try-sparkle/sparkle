import { describe, it, expect } from "vitest";
import {
  assessHeadroom,
  switchRecommendation,
  describeRecommendation,
  WARN_FRACTION,
  type Ceiling,
} from "./headroom";
import type { Account, Usage, Identity } from "./accountStore";

const NOW = 1_000_000;

function acct(id: string, over: Partial<Account> = {}): Account {
  return { id, nickname: id, configDir: `/cfg/${id}`, isDefault: false, createdAt: 0, ...over };
}
function usage(id: string, tokens5h: number, exhaustedUntil: number | null = null): Usage {
  return { id, tokens5h, tokens7d: tokens5h, exhaustedUntil };
}
function ceil(id: string, ceiling: number | null): Ceiling {
  return { id, samples: ceiling == null ? [] : [ceiling], ceiling };
}
function ident(id: string, email: string | null = `${id}@example.com`): Identity {
  return { id, email, organization: null, accountUuid: `uuid-${id}` };
}

describe("assessHeadroom", () => {
  it("classifies against the LEARNED ceiling, not a constant", () => {
    // Same absolute usage, different learned ceilings → different verdicts. This is the whole point
    // of learning per account: a Max 5x and a Max 20x can't share a threshold.
    const u = [usage("small", 45_000_000), usage("big", 45_000_000)];
    const c = [ceil("small", 44_000_000), ceil("big", 400_000_000)];
    const got = assessHeadroom(u, c, NOW);
    expect(got.find((h) => h.accountId === "small")?.state).toBe("warn");
    expect(got.find((h) => h.accountId === "big")?.state).toBe("ok");
  });

  it("reports 'unknown' — never 'ok' — when there is no learned ceiling", () => {
    // Presenting a guess as a measurement is the failure mode this avoids.
    const got = assessHeadroom([usage("a", 999)], [ceil("a", null)], NOW);
    expect(got[0]!.state).toBe("unknown");
    expect(got[0]!.fraction).toBeNull();
  });

  it("an observed limit outranks any estimate", () => {
    // Barely any usage, but it actually hit the wall — the observation wins.
    const got = assessHeadroom([usage("a", 1, NOW + 60_000)], [ceil("a", 44_000_000)], NOW);
    expect(got[0]!.state).toBe("exhausted");
  });

  it("an EXPIRED exhaustion no longer counts", () => {
    const got = assessHeadroom([usage("a", 1, NOW - 1)], [ceil("a", 44_000_000)], NOW);
    expect(got[0]!.state).toBe("ok");
  });

  it("crosses into warn exactly at the threshold", () => {
    const c = [ceil("a", 100)];
    expect(assessHeadroom([usage("a", WARN_FRACTION * 100 - 1)], c, NOW)[0]!.state).toBe("ok");
    expect(assessHeadroom([usage("a", WARN_FRACTION * 100)], c, NOW)[0]!.state).toBe("warn");
  });

  it("handles a zero ceiling without dividing by zero", () => {
    const got = assessHeadroom([usage("a", 10)], [ceil("a", 0)], NOW);
    expect(got[0]!.fraction).toBeNull();
    expect(got[0]!.state).toBe("unknown");
  });
});

describe("switchRecommendation", () => {
  const accounts = [acct("a"), acct("b"), acct("c")];
  const idents = [ident("a"), ident("b"), ident("c")];

  it("recommends the account with the most headroom", () => {
    const u = [usage("a", 90), usage("b", 50), usage("c", 10)];
    const c = [ceil("a", 100), ceil("b", 100), ceil("c", 100)];
    const rec = switchRecommendation("a", accounts, u, c, idents, NOW);
    expect(rec?.from.id).toBe("a");
    expect(rec?.to.id).toBe("c");
    expect(rec?.reason).toBe("approaching");
    expect(rec?.fraction).toBeCloseTo(0.9);
  });

  it("stays silent while the current account has room", () => {
    const u = [usage("a", 10), usage("b", 50)];
    const c = [ceil("a", 100), ceil("b", 100)];
    expect(switchRecommendation("a", accounts, u, c, idents, NOW)).toBeNull();
  });

  it("never recommends an account that isn't signed in", () => {
    // Moving to a login prompt is not a fix. `c` has the most headroom but no identity.
    const u = [usage("a", 90), usage("b", 50), usage("c", 0)];
    const c2 = [ceil("a", 100), ceil("b", 100), ceil("c", 100)];
    const rec = switchRecommendation("a", accounts, u, c2, [ident("a"), ident("b"), ident("c", null)], NOW);
    expect(rec?.to.id).toBe("b");
  });

  it("never recommends an account that is itself exhausted or warning", () => {
    const u = [usage("a", 90), usage("b", 95), usage("c", 10, NOW + 60_000)];
    const c2 = [ceil("a", 100), ceil("b", 100), ceil("c", 100)];
    // b is warning, c is exhausted → nothing safe to move to.
    expect(switchRecommendation("a", accounts, u, c2, idents, NOW)).toBeNull();
  });

  it("recommends a move when the current account has actually hit its limit", () => {
    const u = [usage("a", 5, NOW + 60_000), usage("b", 10)];
    const c2 = [ceil("a", null), ceil("b", 100)];
    const rec = switchRecommendation("a", accounts, u, c2, idents, NOW);
    expect(rec?.reason).toBe("exhausted");
    expect(rec?.to.id).toBe("b");
    expect(rec?.fraction).toBeNull(); // no ceiling learned — recommendation stands, unquantified
  });

  it("prefers a quantified account over one with an unknown ceiling", () => {
    const u = [usage("a", 90), usage("b", 20), usage("c", 1)];
    // c is least-used but unmeasurable; b is known-comfortable. Prefer the one we can vouch for.
    const c2 = [ceil("a", 100), ceil("b", 100), ceil("c", null)];
    expect(switchRecommendation("a", accounts, u, c2, idents, NOW)?.to.id).toBe("b");
  });

  it("returns null when there is nowhere to go", () => {
    const u = [usage("a", 90)];
    const c2 = [ceil("a", 100)];
    expect(switchRecommendation("a", [acct("a")], u, c2, [ident("a")], NOW)).toBeNull();
  });

  it("returns null for an unknown or absent current account", () => {
    const u = [usage("a", 90)];
    const c2 = [ceil("a", 100)];
    expect(switchRecommendation(null, accounts, u, c2, idents, NOW)).toBeNull();
    expect(switchRecommendation("ghost", accounts, u, c2, idents, NOW)).toBeNull();
  });
});

describe("describeRecommendation", () => {
  const label = (a: Account) => a.nickname;

  it("quantifies an approaching limit", () => {
    const rec = {
      from: acct("a", { nickname: "Storytell" }),
      to: acct("b", { nickname: "Gmail" }),
      fraction: 0.87,
      reason: "approaching" as const,
    };
    expect(describeRecommendation(rec, label)).toBe(
      "Storytell is 87% of its usual limit. Switch to Gmail before it runs out.",
    );
  });

  it("states a reached limit plainly", () => {
    const rec = {
      from: acct("a", { nickname: "Storytell" }),
      to: acct("b", { nickname: "Gmail" }),
      fraction: null,
      reason: "exhausted" as const,
    };
    expect(describeRecommendation(rec, label)).toBe(
      "Storytell has hit its limit. Switch to Gmail to keep working.",
    );
  });
});
