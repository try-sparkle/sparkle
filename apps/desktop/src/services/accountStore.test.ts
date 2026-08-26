import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  pickAccount,
  eligibleAccounts,
  clobberedDefaultIds,
  getUsage,
  getIdentities,
  accountLabel,
  accountDisplay,
  accountSentenceName,
  adoptionOutcome,
  forkNotice,
  identityChanged,
  NOT_SIGNED_IN,
  addAccount,
  setNickname,
  removeAccount,
  markExhausted,
  ensureProjectTrusted,
  DEFAULT_NEAR_CAP,
  getPin,
  setPin,
  clearPin,
  clearAllPins,
  signedInAccountIds,
  signedInFilterApplies,
  notSignedInAccountIds,
  duplicateAccountGroups,
  identityKey,
  accountsAreSame,
  duplicateAccountIds,
  PINS_STORAGE_KEY,
  type Account,
  type Identity,
  type Usage,
} from "./accountStore";

function acct(id: string, over: Partial<Account> = {}): Account {
  return { id, nickname: id, configDir: `/cfg/${id}`, isDefault: false, createdAt: 0, ...over };
}
function usage(id: string, over: Partial<Usage> = {}): Usage {
  return { id, tokens5h: 0, tokens7d: 0, exhaustedUntil: null, ...over };
}

describe("pickAccount", () => {
  const NOW = 1_000_000;

  it("returns null for an empty account list", () => {
    expect(pickAccount([], [], { now: NOW })).toBeNull();
  });

  // ── Real Anthropic utilization outranks the local estimate ──────────────────────────────────
  //
  // The local tally is computed by scanning each account's OWN transcripts, so it measures what
  // THIS machine ran under that account — not what the account has spent. When those diverge, the
  // tally is not merely imprecise, it is inverted: an account that spent its whole weekly limit
  // elsewhere has a local tally of zero, which is the most headroom there is.

  it("does not send spawns to an account Anthropic reports as spent, even when its LOCAL tally is zero", () => {
    // The founder's card, verbatim: session 0% / weekly 100% real, and BOTH local estimates 0.
    // Under the token rule `spent` wins outright — it is the emptiest account on the machine — so
    // the single most exhausted account was next in line for every spawn.
    const accounts = [acct("spent"), acct("fresh")];
    const u = [
      usage("spent", { tokens7d: 0, tokens5h: 0 }),
      usage("fresh", { tokens7d: 5_000_000, tokens5h: 1_000_000 }),
    ];
    const live = [
      { id: "spent", fiveHourPercent: 0, sevenDayPercent: 100 },
      { id: "fresh", fiveHourPercent: 12, sevenDayPercent: 20 },
    ];
    expect(pickAccount(accounts, u, { now: NOW, live })?.id).toBe("fresh");
    // PAIRED, so the test above is pinning the live figure rather than some unrelated exclusion:
    // same accounts, same tallies, live data withheld → the old rule applies and `spent` wins.
    expect(pickAccount(accounts, u, { now: NOW })?.id).toBe("spent");
  });

  it("ranks by real utilization among accounts that have it", () => {
    const accounts = [acct("a"), acct("b"), acct("c")];
    // Token tallies deliberately ordered AGAINST the live figures, so a pass cannot come from the
    // fallback path accidentally agreeing.
    const u = [
      usage("a", { tokens7d: 1 }),
      usage("b", { tokens7d: 2 }),
      usage("c", { tokens7d: 3 }),
    ];
    const live = [
      { id: "a", fiveHourPercent: 10, sevenDayPercent: 80 },
      { id: "b", fiveHourPercent: 5, sevenDayPercent: 60 },
      { id: "c", fiveHourPercent: 70, sevenDayPercent: 30 },
    ];
    // Ranked on the WORST window: a=80, b=60, c=70.
    expect(pickAccount(accounts, u, { now: NOW, live })?.id).toBe("b");
  });

  it("reads the 5-hour window too, not just the 7-day one", () => {
    // An account at 0% weekly but 100% of its session window cannot take a spawn right now either.
    // Reading `sevenDayPercent` alone would rank this account as completely free.
    const accounts = [acct("session-spent"), acct("ok")];
    const u = [usage("session-spent"), usage("ok")];
    const live = [
      { id: "session-spent", fiveHourPercent: 100, sevenDayPercent: 0 },
      { id: "ok", fiveHourPercent: 30, sevenDayPercent: 40 },
    ];
    expect(pickAccount(accounts, u, { now: NOW, live })?.id).toBe("ok");
  });

  it("treats an unreported live figure as UNKNOWN, never as zero", () => {
    // `null` is what the wire sends for a window Anthropic did not report. Coercing it to 0 would
    // recreate the original bug in a new place: the unmeasured account becomes the emptiest one.
    const accounts = [acct("unknown"), acct("known")];
    const u = [
      usage("unknown", { tokens7d: 9_000_000 }), // locally, clearly the busier account
      usage("known", { tokens7d: 10 }),
    ];
    const live = [
      { id: "unknown", fiveHourPercent: null, sevenDayPercent: null },
      { id: "known", fiveHourPercent: 50, sevenDayPercent: 50 },
    ];
    // `known` is verified at 50%; `unknown` has no figure at all and must not outrank it on a zero
    // it never reported.
    expect(pickAccount(accounts, u, { now: NOW, live })?.id).toBe("known");
  });

  it("falls back to the token rule when NO account has live data (offline)", () => {
    const accounts = [acct("a"), acct("b")];
    const u = [usage("a", { tokens7d: 30 }), usage("b", { tokens7d: 10 })];
    expect(pickAccount(accounts, u, { now: NOW, live: [] })?.id).toBe("b");
  });

  it("still returns an account when EVERY account is spent, rather than blocking the spawn", () => {
    // Same reasoning as the exhausted/near-cap fallback: refusing to spawn on the strength of a
    // utilization reading would let one bad fetch halt the fleet.
    const accounts = [acct("a"), acct("b")];
    const u = [usage("a"), usage("b")];
    const live = [
      { id: "a", fiveHourPercent: 100, sevenDayPercent: 100 },
      { id: "b", fiveHourPercent: 99, sevenDayPercent: 99 },
    ];
    expect(pickAccount(accounts, u, { now: NOW, live })).not.toBeNull();
  });

  it("picks the LOWEST 7d tally", () => {
    const accounts = [acct("a"), acct("b"), acct("c")];
    const u = [
      usage("a", { tokens7d: 30, tokens5h: 1 }),
      usage("b", { tokens7d: 10, tokens5h: 9 }),
      usage("c", { tokens7d: 20, tokens5h: 1 }),
    ];
    expect(pickAccount(accounts, u, { now: NOW })?.id).toBe("b");
  });

  it("ranks by lowest usage even when both accounts dwarf the old static caps (no fallback-to-default)", () => {
    // Real-world: heavy cache-read usage puts both accounts far above the former 5M/30M guess. With
    // the default cap neutralized, the near-cap filter no longer excludes everyone (which used to
    // collapse to the default account); selection picks the genuinely-lower account.
    const accounts = [acct("a", { isDefault: true }), acct("b")];
    const u = [
      usage("a", { tokens7d: 9_000_000_000 }), // the default, but the heavier one
      usage("b", { tokens7d: 2_000_000_000 }),
    ];
    expect(pickAccount(accounts, u, { now: NOW })?.id).toBe("b");
  });

  it("tie-breaks equal 7d on the lowest 5h", () => {
    const accounts = [acct("a"), acct("b")];
    const u = [
      usage("a", { tokens7d: 10, tokens5h: 8 }),
      usage("b", { tokens7d: 10, tokens5h: 3 }),
    ];
    expect(pickAccount(accounts, u, { now: NOW })?.id).toBe("b");
  });

  it("treats an account with no usage row as zero-tokens (most headroom)", () => {
    const accounts = [acct("a"), acct("b")];
    const u = [usage("a", { tokens7d: 100 })]; // b has no row → 0
    expect(pickAccount(accounts, u, { now: NOW })?.id).toBe("b");
  });

  it("excludes accounts whose exhaustedUntil is in the future", () => {
    const accounts = [acct("a"), acct("b")];
    const u = [
      usage("a", { tokens7d: 1, exhaustedUntil: NOW + 5000 }), // exhausted despite low usage
      usage("b", { tokens7d: 50 }),
    ];
    expect(pickAccount(accounts, u, { now: NOW })?.id).toBe("b");
  });

  it("does NOT exclude an account whose exhaustedUntil is in the past", () => {
    const accounts = [acct("a"), acct("b")];
    const u = [
      usage("a", { tokens7d: 1, exhaustedUntil: NOW - 5000 }), // reset already
      usage("b", { tokens7d: 50 }),
    ];
    expect(pickAccount(accounts, u, { now: NOW })?.id).toBe("a");
  });

  it("excludes accounts near a window cap (5h or 7d)", () => {
    const accounts = [acct("a"), acct("b")];
    const u = [
      usage("a", { tokens7d: 1, tokens5h: DEFAULT_NEAR_CAP.tokens5h }), // at the 5h ceiling
      usage("b", { tokens7d: 500 }),
    ];
    expect(pickAccount(accounts, u, { now: NOW })?.id).toBe("b");

    const u2 = [
      usage("a", { tokens7d: DEFAULT_NEAR_CAP.tokens7d }), // at the 7d ceiling
      usage("b", { tokens7d: 500 }),
    ];
    expect(pickAccount(accounts, u2, { now: NOW })?.id).toBe("b");
  });

  it("honours a custom nearCap threshold", () => {
    const accounts = [acct("a"), acct("b")];
    const u = [usage("a", { tokens7d: 100 }), usage("b", { tokens7d: 50 })];
    // With a tiny 7d cap of 75, only `a` is excluded.
    const picked = pickAccount(accounts, u, { now: NOW, nearCap: { tokens5h: 1e9, tokens7d: 75 } });
    expect(picked?.id).toBe("b");
  });

  it("a valid pin overrides everything, even exhausted/near-cap", () => {
    const accounts = [acct("a"), acct("b")];
    const u = [
      usage("a", { tokens7d: 1 }),
      usage("b", { tokens7d: 999, exhaustedUntil: NOW + 5000, tokens5h: DEFAULT_NEAR_CAP.tokens5h }),
    ];
    expect(pickAccount(accounts, u, { now: NOW, pinnedAccountId: "b" })?.id).toBe("b");
  });

  it("ignores a pin that names no existing account (falls through to auto-pick)", () => {
    const accounts = [acct("a"), acct("b")];
    const u = [usage("a", { tokens7d: 50 }), usage("b", { tokens7d: 10 })];
    expect(pickAccount(accounts, u, { now: NOW, pinnedAccountId: "ghost" })?.id).toBe("b");
  });

  it("does NOT skip an account near its learned ceiling — the estimate spawn-gate was removed", () => {
    const accounts = [acct("hot"), acct("cool")];
    // hot has FEWER tokens than cool, so lowest-usage picks it. It USED to be EXCLUDED for sitting
    // at 0.90 of its learned ceiling — the retired "stops taking new agents at 90%" gate. The
    // founder retired that estimate as a driver, so it no longer gates: the account near its
    // ESTIMATED ceiling but low on raw/real usage is eligible again.
    const u = [usage("hot", { tokens5h: 90, tokens7d: 90 }), usage("cool", { tokens5h: 200, tokens7d: 200 })];
    const ceilings = [
      { id: "hot", samples: [100], ceiling: 100 }, // 0.90 of its learned ceiling
      { id: "cool", samples: [1000], ceiling: 1000 },
    ];
    // Whether ceilings are supplied or not, the answer is the same now — the learned-ceiling
    // estimate has NO effect on auto-pick. Re-add `isNearLearnedCeiling` to `partitionAccounts` and
    // the first line flips to "cool", which is exactly the behaviour that was removed.
    expect(pickAccount(accounts, u, { now: NOW, ceilings })?.id).toBe("hot");
    expect(pickAccount(accounts, u, { now: NOW })?.id).toBe("hot");
  });

  it("has NO proactive exclusion for an account with no live row — only real usage / the observed wall", () => {
    // When live data is present it gates (real Anthropic ≥ LIVE_AVOID_PERCENT), and when it is
    // MISSING there is no proactive exclusion — the retired learned ceiling is NOT reinstated as a
    // fallback, because it is the same local tally that read zero for a fully-spent account on the
    // founder's machine. So a no-live-row account is judged by lowest local usage, with the observed
    // wall as the only backstop.
    const accounts = [acct("nolive"), acct("spent")];
    // `spent` has the LOWEST local tally (0) — it would win lowest-usage outright — but reads 99% on
    // Anthropic's own number. `nolive` has a higher local tally and NO live row.
    const u = [usage("nolive", { tokens5h: 10, tokens7d: 10 }), usage("spent", { tokens5h: 0, tokens7d: 0 })];
    const live = [{ id: "spent", fiveHourPercent: 99, sevenDayPercent: 10 }];
    // With live data: `spent` is excluded on its REAL number, so `nolive` wins despite the higher tally.
    expect(pickAccount(accounts, u, { now: NOW, live })?.id).toBe("nolive");
    // With NO live rows at all: lowest LOCAL tally wins outright (`spent`) — no estimate gate steps in
    // to exclude it. This is the window the docblock documents; the observed wall is the only backstop.
    expect(pickAccount(accounts, u, { now: NOW })?.id).toBe("spent");
  });

  it("excludes a DUPLICATE of a spent login even when its own live fetch failed (per-login siblingIds)", () => {
    // `a` and `b` are two dirs of ONE login. Only `a` reports 99% live; `b`'s fetch failed (no row).
    // `cool` is a healthy different login. Per config-dir, `b` reads eligible and — being the lowest
    // tally — would win, landing agents on the shared, spent quota. With the login grouping, `b` is
    // excluded via its twin `a`, so `cool` wins. This is the SAME per-login judgement AC8 and the
    // switch path use, so the spawn gate cannot disagree with them.
    const accounts = [acct("a"), acct("b"), acct("cool")];
    const u = [
      usage("a", { tokens5h: 500, tokens7d: 500 }),
      usage("b", { tokens5h: 0, tokens7d: 0 }), // lowest tally → would win per-dir
      usage("cool", { tokens5h: 100, tokens7d: 100 }),
    ];
    const live = [{ id: "a", fiveHourPercent: 99, sevenDayPercent: 10 }]; // only `a` reported
    const siblingIds = new Map<string, readonly string[]>([
      ["a", ["a", "b"]],
      ["b", ["a", "b"]],
    ]);
    expect(pickAccount(accounts, u, { now: NOW, live, siblingIds })?.id).toBe("cool");
    // Without the grouping (per-dir), `b` is not excluded and its zero tally wins — the hole.
    expect(pickAccount(accounts, u, { now: NOW, live })?.id).toBe("b");
  });

  it("treats an unlearned ceiling as unknown, never as zero", () => {
    // A null ceiling must not read as "0 tokens used, infinite room" — that would make an account
    // Sparkle knows nothing about beat one it has measured as healthy, on every single pick.
    const accounts = [acct("known"), acct("unlearned")];
    const u = [usage("known", { tokens5h: 10, tokens7d: 10 }), usage("unlearned", { tokens5h: 500, tokens7d: 500 })];
    const ceilings = [
      { id: "known", samples: [1000], ceiling: 1000 },
      { id: "unlearned", samples: [], ceiling: null },
    ];
    // Neither is near a cap, so ordinary lowest-usage ranking applies and the null changes nothing.
    expect(pickAccount(accounts, u, { now: NOW, ceilings })?.id).toBe("known");
  });

  it("honours a pin even when the pinned account is over its learned ceiling", () => {
    // A human choosing an account on purpose outranks an estimate. Pinned selection must not quietly
    // acquire the proactive gate — that would make a deliberate choice un-actionable.
    const accounts = [acct("hot"), acct("cool")];
    const u = [usage("hot", { tokens5h: 99 }), usage("cool", { tokens5h: 1 })];
    const ceilings = [{ id: "hot", samples: [100], ceiling: 100 }];
    expect(pickAccount(accounts, u, { now: NOW, ceilings, pinnedAccountId: "hot" })?.id).toBe("hot");
  });

  it("prefers a MEASURED account over an unmeasured one in the fallback, even at f > 1", () => {
    // The tier this pins is the one the other fallback tests structurally cannot reach: they give
    // BOTH accounts a learned ceiling or NEITHER, so known-vs-unknown is equal in both and reverting
    // `leastBad` to its old folded score `f ?? 1 + tokens5h/(tokens5h+1)` leaves them all green
    // (roborev 59940). That is the vacuity shape, sitting on the very assertion the re-tiering was
    // written for.
    //
    // Why f > 1 is the ordinary case and not an exotic one: the ceiling is the MEDIAN 5h consumption
    // at past limit episodes, so by construction about half of all episodes sit ABOVE it. Under the
    // old scoring a measured account at 1.2 lost to an unmeasured one scoring 1.0 — and an account
    // with no usage row at all gets a synthesized ZERO from `usageLookup`, so the least-known
    // account in the pool could win the fallback outright.
    //
    // Both accounts are exhausted so the pool is empty and the fallback runs, and so that the
    // limited tier is EQUAL — otherwise the assertion would pass on tier 1 without ever consulting
    // the known/unknown tier this test exists for.
    const accounts = [acct("known"), acct("unknown", { isDefault: true })];
    const u = [
      usage("known", { tokens5h: 120, exhaustedUntil: NOW + 60_000 }),
      usage("unknown", { tokens5h: 0, exhaustedUntil: NOW + 60_000 }),
    ];
    const ceilings = [{ id: "known", samples: [100], ceiling: 100 }]; // f = 1.2; `unknown` has none
    // `unknown` is ALSO the default, so the isDefault tie-break would hand it the win if the tiers
    // above it ever compared equal. `known` winning can therefore only come from the known/unknown
    // tier — which is exactly the discrimination being pinned.
    expect(pickAccount(accounts, u, { now: NOW, ceilings })?.id).toBe("known");
  });

  it("falls back to the LEAST-BAD account, not the default, when the default is the dead one", () => {
    // The shape observed on the real machine: the default account is the one everything lands on, so
    // it is the one that runs out first. `DROdio Personal` was both `isDefault` and the account
    // carrying an `exhaustedUntil` when the fleet stalled. An unconditional default-preference sends
    // every new agent at exactly that account.
    const accounts = [acct("dead", { isDefault: true }), acct("tired")];
    const u = [
      usage("dead", { tokens5h: 100, exhaustedUntil: NOW + 60_000 }), // observed rate limit
      usage("tired", { tokens5h: 95 }), // merely near its ceiling — no observed failure
    ];
    const ceilings = [
      { id: "dead", samples: [100], ceiling: 100 },
      { id: "tired", samples: [100], ceiling: 100 }, // 0.95 → excluded, but not LIMITED
    ];
    // Both are excluded from `candidates`, so this exercises the fallback. An observed limit is fact
    // and a ceiling is an estimate, so the un-limited account wins despite both being over the line.
    expect(pickAccount(accounts, u, { now: NOW, ceilings })?.id).toBe("tired");
  });

  it("falls back to the DEFAULT account when all are excluded", () => {
    const accounts = [acct("a"), acct("b", { isDefault: true }), acct("c")];
    const u = [
      usage("a", { exhaustedUntil: NOW + 1 }),
      usage("b", { exhaustedUntil: NOW + 1 }),
      usage("c", { exhaustedUntil: NOW + 1 }),
    ];
    expect(pickAccount(accounts, u, { now: NOW })?.id).toBe("b");
  });

  it("falls back to the first account when all are excluded and none is default", () => {
    const accounts = [acct("a"), acct("b")];
    const u = [
      usage("a", { tokens7d: DEFAULT_NEAR_CAP.tokens7d }),
      usage("b", { tokens7d: DEFAULT_NEAR_CAP.tokens7d }),
    ];
    expect(pickAccount(accounts, u, { now: NOW })?.id).toBe("a");
  });
});

describe("getUsage — reads the REAL camelCase wire shape and converts seconds→ms", () => {
  beforeEach(() => invoke.mockReset());

  // These fixture keys are the ones `AccountUsage` actually serializes (pinned by the Rust test
  // `account_usage_serializes_camel_case_keys`). This suite used to mock snake_case rows Rust never
  // emits, so it certified a mapper that read `undefined` for every tally — the bars showed 0 for
  // every account while the tests stayed green.
  it("maps tokens5h/tokens7d, converts exhaustedUntil seconds→ms, and defaults null", async () => {
    invoke.mockResolvedValue([
      { id: "a", tokens5h: 11, tokens7d: 22, exhaustedUntil: 1234 }, // seconds from Rust
      { id: "b", tokens5h: 0, tokens7d: 0, exhaustedUntil: null },
    ]);
    const out = await getUsage();
    expect(invoke).toHaveBeenCalledWith("accounts_usage");
    expect(out).toEqual([
      { id: "a", tokens5h: 11, tokens7d: 22, exhaustedUntil: 1_234_000 }, // ms on this side
      { id: "b", tokens5h: 0, tokens7d: 0, exhaustedUntil: null },
    ]);
  });
});

describe("getIdentities", () => {
  beforeEach(() => invoke.mockReset());

  it("invokes accounts_identities and returns identity rows verbatim", async () => {
    invoke.mockResolvedValue([
      { id: "a", email: "drodio@storytell.ai", organization: "drodio@storytell.ai's Organization" },
      { id: "b", email: null, organization: null, accountUuid: null },
    ]);
    const out = await getIdentities();
    expect(invoke).toHaveBeenCalledWith("accounts_identities");
    expect(out).toEqual([
      { id: "a", email: "drodio@storytell.ai", organization: "drodio@storytell.ai's Organization" },
      { id: "b", email: null, organization: null, accountUuid: null },
    ]);
  });
});

/** An {@link Identity} row, defaulting the three optional Rust-side fields to ABSENT so each test
 *  that cares about them has to opt in — which is also the shape a backend predating them sends. */
function ident(id: string, over: Partial<Identity> = {}): Identity {
  return { id, email: null, organization: null, accountUuid: null, ...over };
}

describe("accountDisplay — the verified email or nothing; the nickname is never the identity", () => {
  it("renders the real authenticated email in the identity slot", () => {
    const d = accountDisplay(acct("a", { nickname: "DROdio Gmail" }), ident("a", { email: "drodio@storytell.ai" }));
    expect(d.primary).toBe("drodio@storytell.ai");
    expect(d.signedIn).toBe(true);
  });

  it("an account with NO completed login does not put its nickname in the identity slot", () => {
    // The bug: `identity?.email ?? account.nickname` rendered a user-typed string as though it were
    // the Anthropic account the work runs under. Assert the nickname's ABSENCE — asserting only
    // that NOT_SIGNED_IN appears would pass even if the nickname were still leaking through.
    const a = acct("a", { nickname: "DROdio Gmail" });
    for (const identity of [ident("a"), undefined]) {
      const d = accountDisplay(a, identity);
      expect(d.primary).not.toBe("DROdio Gmail");
      expect(d.primary).toBe(NOT_SIGNED_IN);
      expect(d.signedIn).toBe(false);
      // …and it is still carried, so a surface can show it as a clearly secondary alias.
      expect(d.nickname).toBe("DROdio Gmail");
    }
  });

  it("accountLabel keeps its signature and is exactly accountDisplay(...).primary", () => {
    // Another worker calls accountLabel; it must not have to change at merge, but it must also not
    // be a second, softer definition of the identity slot.
    const a = acct("a", { nickname: "DROdio Gmail" });
    for (const identity of [ident("a", { email: "drodio@storytell.ai" }), ident("a"), undefined]) {
      expect(accountLabel(a, identity)).toBe(accountDisplay(a, identity).primary);
    }
    expect(accountLabel(a, ident("a"))).not.toBe("DROdio Gmail");
  });

  it("carries the org and the anthropic account uuid through", () => {
    const d = accountDisplay(acct("a"), ident("a", { email: "x@y.z", organization: "Acme", accountUuid: "u1" }));
    expect(d.organization).toBe("Acme");
    expect(d.accountUuid).toBe("u1");
  });
});

describe("accountDisplay — the shell fork (default account only)", () => {
  const DEFAULT = acct("d", { nickname: "DROdio Personal", isDefault: true });

  it("PAIRED: a mixed-identity account produces the warning, a clean one does not (same nickname)", () => {
    // The whole point of task #4: a forked/mixed-identity account is made VISIBLE. Same DEFAULT
    // (same nickname) both ways, so the ONLY thing that flips the outcome is the fork itself — not
    // some incidental difference in the fixture. Mutating `forkNotice` to always return null (or the
    // old email-spelling copy) breaks exactly one half of this pair.
    const forked = accountDisplay(
      DEFAULT,
      ident("d", { email: "sparkle@x.test", shellEmail: "base@x.test", shellAccountUuid: "u-base" }),
    );
    expect(forked.shellForked).toBe(true);
    const warning = forkNotice(forked);
    expect(warning).not.toBeNull();
    expect(warning!).toContain('"DROdio Personal"'); // named by nickname, the user's own label
    expect(warning!).toContain("forked login identity");
    expect(warning!).not.toContain("@"); // no email, either side (privacy directive)

    const clean = accountDisplay(
      DEFAULT,
      ident("d", { email: "sparkle@x.test", shellEmail: "sparkle@x.test", shellAccountUuid: "u-base" }),
    );
    expect(clean.shellForked).toBe(false);
    expect(forkNotice(clean)).toBeNull(); // no fork → no warning at all
  });

  it("NEVER leaks an email even when the nickname IS one (the auto-populated production shape)", () => {
    // roborev 69233/69232 (High): a nickname is ROUTINELY the login email — AccountLimitModal and the
    // placeholder-completion path both set it to the identity's email, which in the mixed-identity case
    // may be a DIFFERENT person's address. Naming by such a nickname would spell out the exact email the
    // directive forbids. forkNotice must degrade an `@`-bearing nickname to the unnamed sentence.
    const emailNick = acct("d", { nickname: "superadmin@storytell.ai", isDefault: true });
    const d = accountDisplay(emailNick, ident("d", { shellEmail: "base@x.test", shellAccountUuid: "u-base" }));
    expect(d.shellForked).toBe(true);
    const notice = forkNotice(d) ?? "";
    expect(notice).toContain("forked login identity"); // still warns
    expect(notice).not.toContain("@"); // …but with NO email, even though the nickname was one
    expect(notice).not.toContain("superadmin@storytell.ai");
    expect(notice).not.toContain('("'); // fell back to the unnamed sentence, no quoted name at all
  });

  it("flags the fork when the terminal is signed in as a DIFFERENT anthropic account", () => {
    const d = accountDisplay(
      DEFAULT,
      ident("d", {
        email: "drodio@storytell.ai",
        accountUuid: "c70bea4e",
        shellEmail: "drodio@gmail.com",
        shellAccountUuid: "5fb3d67c",
      }),
    );
    expect(d.shellForked).toBe(true);
    const notice = forkNotice(d) ?? "";
    // PRIVACY (founder directive): the notice must NAME the account by its nickname and NEVER spell
    // out an email — not Sparkle's own (`drodio@storytell.ai`) and above all not the base sign-in's
    // (`drodio@gmail.com`), which may be a DIFFERENT person's login. `@` never appears.
    expect(notice).toContain('"DROdio Personal"');
    expect(notice).toContain("forked login identity");
    expect(notice).toContain("Sign this account out and back in");
    expect(notice).not.toContain("@");
    expect(notice).not.toContain("drodio@storytell.ai");
    expect(notice).not.toContain("drodio@gmail.com");
  });

  it("does NOT invent a fork when only ONE side records a uuid but the emails match", () => {
    // THE LADDER, pinned. `shellForked` used to be a bare `shellAccountUuid !== accountUuid`, which
    // reads `null !== "u1"` as a difference — announcing that the terminal is on a different
    // account when both sides are demonstrably the same login. roborev found that my fix for this
    // was not pinned by ANY test: reverting it to the one-liner kept all 59 green. It now fails.
    const d = accountDisplay(
      DEFAULT,
      ident("d", { email: "same@example.com", shellEmail: "same@example.com", shellAccountUuid: "u1" }),
    );
    expect(d.shellForked).toBe(false);
    expect(forkNotice(d)).toBeNull();
  });

  it("DOES report a fork when neither side has a uuid and the emails differ", () => {
    // The other half of the ladder: with no uuids at all the email decides, so a real difference
    // must still surface. The old one-liner returned false here (both uuids null), silently hiding
    // a genuine fork — the failure this PR exists to fix, in the opposite direction.
    const d = accountDisplay(DEFAULT, ident("d", { email: "a@example.com", shellEmail: "b@example.com" }));
    expect(d.shellForked).toBe(true);
    const notice = forkNotice(d) ?? "";
    expect(notice).toContain("forked login identity");
    // Neither the account's own email nor the base sign-in's email may leak.
    expect(notice).not.toContain("@");
    expect(notice).not.toContain("a@example.com");
    expect(notice).not.toContain("b@example.com");
  });

  it("never calls a signed-in account 'not signed in' — a uuid with no email is still a login", () => {
    // roborev 58018. `signedIn` is email-only, and it was driving PROSE and AVAILABILITY as well as
    // the label. For an `oauthAccount` carrying a uuid but no readable `emailAddress` — which
    // AccountsScreen's own affordance and `duplicateAccountGroups` both treat as signed in — the
    // fork notice emitted the flatly false "Sparkle runs this account as an account that isn't
    // signed in", about the user's own account, in the dropdown and the tooltip.
    const d = accountDisplay(
      DEFAULT,
      ident("d", { email: null, accountUuid: "u1", shellEmail: "them@example.com", shellAccountUuid: "u2" }),
    );

    expect(d.hasLogin).toBe(true);
    expect(d.signedIn).toBe(false); // still no email to PRINT — the slot rule is unchanged
    expect(d.shellForked).toBe(true);

    const notice = forkNotice(d) ?? "";
    expect(notice).not.toContain("isn't signed in");
    expect(notice).toContain("forked login identity");
    // A uuid-only login has no email to leak, and the base side's email must not leak either.
    expect(notice).not.toContain("@");
    expect(notice).not.toContain("them@example.com");
  });

  it("groups two registrations of ONE pre-accountUuid login as duplicates (knightwatch probe 1)", () => {
    // THE CONSEQUENCE, not just the rule. duplicateAccountGroups keyed on `accountUuid` alone and
    // `continue`d on a null one, so two registrations of the SAME login predating that field were
    // never seen as duplicates. limitSync's siblingMap is derived from this, so only ONE of them
    // got benched when the shared quota ran out — and auto-pick then routed work straight back into
    // the same exhausted account. Fails against the uuid-only keying.
    const a = acct("a", { nickname: "one" });
    const b = acct("b", { nickname: "two" });
    const groups = duplicateAccountGroups(
      [a, b],
      [ident("a", { email: "same@example.com" }), ident("b", { email: "same@example.com" })],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.accounts.map((x) => x.id)).toEqual(["a", "b"]);
    expect(groups[0]!.accountUuid).toBeNull(); // email-keyed group: no uuid to report
    expect(groups[0]!.email).toBe("same@example.com");
  });

  it("identityKey mirrors the Rust ladder: uuid, else email:<addr>, else null — ORG-BLIND", () => {
    // The base login key, a cross-language mirror of `accounts::identity_key`. It is deliberately
    // org-BLIND: it drives identity-CHANGE detection, and `organizationName` is sometimes null even
    // for a completed login, so folding org in here would masquerade a null->named transition on ONE
    // login as a different account. The org distinction lives in `accountsAreSame` (pairwise).
    expect(identityKey(ident("a", { accountUuid: "u1", email: "e@x.com" }))).toBe("u1");
    expect(identityKey(ident("a", { email: "e@x.com" }))).toBe("email:e@x.com");
    expect(identityKey(ident("a", {}))).toBeNull();
    expect(identityKey(undefined)).toBeNull();
    // The uuid WINS over the email as the base when both are present.
    expect(identityKey(ident("a", { accountUuid: "u2", email: "same@x.com" }))).toBe("u2");
    // ORG-BLIND: two orgs of ONE uuid still key the same here — they are told apart by accountsAreSame.
    expect(identityKey(ident("t", { accountUuid: "u1", email: "e@x.com", organization: "Amforge" }))).toBe(
      identityKey(ident("p", { accountUuid: "u1", email: "e@x.com", organization: "Personal" })),
    );
  });

  it("accountsAreSame separates a Team org from a Personal Max under ONE email (same uuid, two orgs)", () => {
    // The founder's `amforge` case: two DISTINCT Anthropic accounts under one email share an
    // accountUuid but sit in different organizations. Same login key, but NOT the same account.
    const team = ident("t", { accountUuid: "u1", email: "e@x.com", organization: "Amforge" });
    const personal = ident("p", { accountUuid: "u1", email: "e@x.com", organization: "Personal" });
    expect(accountsAreSame(team, personal)).toBe(false);

    // A GENUINE duplicate — same uuid AND same org (two config dirs, one login) — IS the same.
    const dupA = ident("a", { accountUuid: "u1", email: "e@x.com", organization: "Amforge" });
    const dupB = ident("b", { accountUuid: "u1", email: "e@x.com", organization: "Amforge" });
    expect(accountsAreSame(dupA, dupB)).toBe(true);

    // A NULL org is "unknown", never a difference: org can only SPLIT a shared login, so a null-org
    // sibling of the same uuid is still the same account (the 3-config-dir tolerance case).
    const noOrg = ident("n", { accountUuid: "u1", email: "e@x.com" });
    expect(accountsAreSame(team, noOrg)).toBe(true);
    expect(accountsAreSame(personal, noOrg)).toBe(true);

    // Two DIFFERENT logins are never the same, org or no org.
    expect(accountsAreSame(ident("x", { accountUuid: "u1" }), ident("y", { accountUuid: "u2" }))).toBe(false);
    // An unresolvable identity is the same as nothing.
    expect(accountsAreSame(ident("z", {}), team)).toBe(false);
  });

  it("groups a uuid-bearing row with its email-only TWIN (knightwatch probe 1)", () => {
    // The subtler split, and the one a single identityKey pass still gets wrong: ONE Anthropic
    // login registered twice, where the modern client recorded `accountUuid` and the older login in
    // the other config dir did not. Keyed per-identity they land in different buckets — `<uuid>` and
    // `email:<addr>` — so siblingMap benches only one when their SHARED quota runs out and auto-pick
    // routes straight back into the exhausted account. Fails against single-key bucketing.
    const groups = duplicateAccountGroups(
      [acct("modern", {}), acct("legacy", {})],
      [
        ident("modern", { email: "same@example.com", accountUuid: "u1" }),
        ident("legacy", { email: "same@example.com" }), // no uuid — pre-field login
      ],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.accounts.map((x) => x.id).sort()).toEqual(["legacy", "modern"]);
    expect(groups[0]!.accountUuid).toBe("u1"); // the uuid group absorbed the twin
    expect(groups[0]!.key).toBe("u1"); // stable, non-null — usable as a React key
  });

  it("does NOT guess when one email maps to TWO different uuids — including with each other", () => {
    // FOUR rows, and the fourth is the point. My first version of this test had ONE orphan, so its
    // `for (const g of groups) expect(...)` body ran ZERO assertions on the passing path — vacuous,
    // and it hid a real bug: the ambiguity guard refused to attribute an orphan to u1 or u2, then
    // fell through and grouped the orphans WITH EACH OTHER under `email:X`. That is the same
    // unfounded guess, except it produced a group of two that survived the length filter — so
    // siblingMap benched `d` when `c` exhausted, and the banner claimed they were the same login.
    // c may be u1 and d may be u2; we established we cannot tell (roborev 58175).
    const groups = duplicateAccountGroups(
      [acct("a", {}), acct("b", {}), acct("c", {}), acct("d", {})],
      [
        ident("a", { email: "shared@example.com", accountUuid: "u1" }),
        ident("b", { email: "shared@example.com", accountUuid: "u2" }),
        ident("c", { email: "shared@example.com" }),
        ident("d", { email: "shared@example.com" }),
      ],
    );
    expect(groups).toEqual([]);
  });

  it("still pairs email-only rows when NO uuid group claims that email", () => {
    // The narrowness twin of the guard above: skipping on ambiguity must not also stop the ordinary
    // case, where the email is the only discriminator anyone has.
    const groups = duplicateAccountGroups(
      [acct("c", {}), acct("d", {})],
      [ident("c", { email: "only@example.com" }), ident("d", { email: "only@example.com" })],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("email:only@example.com");
    expect(groups[0]!.accounts.map((x) => x.id).sort()).toEqual(["c", "d"]);
  });

  it("does NOT group two different logins that merely both lack a uuid", () => {
    // Narrowness guard: the email is the discriminator when the uuid is absent, so different
    // emails must stay separate rather than collapsing into one bogus "duplicate" group.
    const groups = duplicateAccountGroups(
      [acct("a", {}), acct("b", {})],
      [ident("a", { email: "one@example.com" }), ident("b", { email: "two@example.com" })],
    );
    expect(groups).toHaveLength(0);
  });

  it("does NOT group a Team org and a Personal Max under ONE email (same uuid, different org)", () => {
    // THE FOUNDER'S CASE (`amforge`): two genuinely distinct Anthropic accounts under one email that
    // share an accountUuid but sit in different organizations. Grouped, the second could never be
    // registered (handleAdd's guard) and one would be benched when the other ran out. They are NOT a
    // duplicate. Keyed on `accountUuid` alone (the old rule) this returned a group of two.
    const groups = duplicateAccountGroups(
      [acct("team", {}), acct("personal", {})],
      [
        ident("team", { email: "amforge@example.com", accountUuid: "u1", organization: "Amforge" }),
        ident("personal", { email: "amforge@example.com", accountUuid: "u1", organization: "Personal" }),
      ],
    );
    expect(groups).toEqual([]);
  });

  it("does NOT pair UNKNOWN-org rows once the login is proven to front two distinct orgs", () => {
    // The mixed known/unknown-org group. `a`(Team) and `b`(Personal) prove this uuid fronts TWO
    // distinct accounts, so `c` and `d` — both `organization: null` under that uuid — are
    // UNATTRIBUTABLE: `c` may be the Team's and `d` the Personal's. Pairing them into a duplicate
    // group would be the roborev-58175 wrong-pairing (the banner would call two independent accounts
    // one, `siblingMap` would bench the healthy one, `switchRecommendation` would drop a real escape
    // target). So no group is returned — every row is a singleton after the split.
    const groups = duplicateAccountGroups(
      [acct("a", {}), acct("b", {}), acct("c", {}), acct("d", {})],
      [
        ident("a", { email: "e@example.com", accountUuid: "u1", organization: "Team" }),
        ident("b", { email: "e@example.com", accountUuid: "u1", organization: "Personal" }),
        ident("c", { email: "e@example.com", accountUuid: "u1" }), // org null → unattributable
        ident("d", { email: "e@example.com", accountUuid: "u1" }), // org null → unattributable
      ],
    );
    expect(groups).toEqual([]);
    // (Known limitation, org-uuid follow-up: a null-org row that IS a genuine duplicate of one sub-
    // group goes un-benched here — the safe direction, since we cannot attribute it without guessing.)
  });

  it("STILL groups a genuine duplicate — same uuid AND same org (two dirs, one login)", () => {
    // The real dedup the founder relies on must survive: two config dirs holding the SAME login
    // record the SAME organizationName, so org-awareness never splits them.
    const groups = duplicateAccountGroups(
      [acct("storytell", {}), acct("gmail", {})],
      [
        ident("storytell", { email: "e@example.com", accountUuid: "u1", organization: "Acme" }),
        ident("gmail", { email: "e@example.com", accountUuid: "u1", organization: "Acme" }),
      ],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.accounts.map((x) => x.id).sort()).toEqual(["gmail", "storytell"]);
    expect(groups[0]!.accountUuid).toBe("u1");
  });

  it("keeps calling a genuinely login-less account not signed in", () => {
    // The narrowness guard: widening to `hasLogin` must not make an empty config dir claim a login.
    const d = accountDisplay(
      DEFAULT,
      ident("d", { email: null, accountUuid: null, shellEmail: "them@example.com", shellAccountUuid: "u2" }),
    );
    expect(d.hasLogin).toBe(false);
    expect(accountSentenceName(d)).toBe("an account that isn't signed in");
  });

  it("does NOT flag a fork when the terminal is the same anthropic account", () => {
    const d = accountDisplay(
      DEFAULT,
      ident("d", {
        email: "drodio@storytell.ai",
        accountUuid: "c70bea4e",
        shellEmail: "drodio@storytell.ai",
        shellAccountUuid: "c70bea4e",
      }),
    );
    expect(d.shellForked).toBe(false);
    expect(forkNotice(d)).toBeNull();
  });

  it("does NOT flag a fork on a NON-default account — the shell's login says nothing about it", () => {
    const d = accountDisplay(
      acct("n", { nickname: "DROdio Gmail" }),
      ident("n", { email: "a@b.c", accountUuid: "u1", shellEmail: "z@y.x", shellAccountUuid: "u2" }),
    );
    expect(d.shellForked).toBe(false);
    expect(forkNotice(d)).toBeNull();
  });

  it("a backend that does not yet send the shell fields claims NO fork (and does not throw)", () => {
    // This UI can land before the Rust does. A missing shell uuid is UNKNOWN, and unknown must
    // never render as a warning about an identity nobody read.
    const d = accountDisplay(DEFAULT, ident("d", { email: "drodio@storytell.ai", accountUuid: "c70bea4e" }));
    expect(d.shellForked).toBe(false);
    expect(d.shellEmail).toBeNull();
    expect(forkNotice(d)).toBeNull();
  });

  it("the fork notice names the account by nickname and leaks NO email, even when the base has one", () => {
    const d = accountDisplay(DEFAULT, ident("d", { shellEmail: "drodio@gmail.com", shellAccountUuid: "5fb3d67c" }));
    expect(d.shellForked).toBe(true);
    const notice = forkNotice(d) ?? "";
    // The account is named by its user-chosen nickname (a label the user picked, not an identity)…
    expect(notice).toContain('"DROdio Personal"');
    // …and the base sign-in's real email is NEVER spelled out (founder privacy directive).
    expect(notice).not.toContain("@");
    expect(notice).not.toContain("drodio@gmail.com");
    // `accountSentenceName` (dropdown prose, a DIFFERENT surface) is unchanged: still state, not nickname.
    expect(accountSentenceName(d)).toBe("an account that isn't signed in");
  });
});

describe("hasLogin — availability is a WIDER question than 'can I name it'", () => {
  const DEFAULT = acct("d", { nickname: "DROdio Personal", isDefault: true });

  it("never calls a signed-in account 'not signed in' — a uuid with no email is still a login", () => {
    // roborev 58018. `signedIn` is email-only, and it was driving PROSE and AVAILABILITY as well as
    // the label. For an `oauthAccount` carrying a uuid but no readable `emailAddress` — which
    // AccountsScreen's own affordance and `duplicateAccountGroups` both treat as signed in — the
    // fork notice emitted the flatly false "Sparkle runs this account as an account that isn't
    // signed in", about the user's own account, in the dropdown and the tooltip.
    const d = accountDisplay(
      DEFAULT,
      ident("d", { email: null, accountUuid: "u1", shellEmail: "them@example.com", shellAccountUuid: "u2" }),
    );

    expect(d.hasLogin).toBe(true);
    expect(d.signedIn).toBe(false); // still no email to PRINT — the slot rule is unchanged
    expect(d.shellForked).toBe(true);

    const notice = forkNotice(d) ?? "";
    expect(notice).not.toContain("isn't signed in");
    expect(notice).toContain("forked login identity");
    expect(notice).not.toContain("@");
    expect(notice).not.toContain("them@example.com");
  });

  it("keeps calling a genuinely login-less account not signed in", () => {
    // The narrowness guard: widening to `hasLogin` must not make an empty config dir claim a login.
    const d = accountDisplay(
      DEFAULT,
      ident("d", { email: null, accountUuid: null, shellEmail: "them@example.com", shellAccountUuid: "u2" }),
    );
    expect(d.hasLogin).toBe(false);
    expect(accountSentenceName(d)).toBe("an account that isn't signed in");
  });
});

describe("identityChanged", () => {
  it("is true only when the backend says the config dir hosted another login", () => {
    expect(identityChanged(ident("a", { identityChanged: true }))).toBe(true);
    expect(identityChanged(ident("a", { identityChanged: false }))).toBe(false);
  });

  it("an ABSENT field means 'not known to have changed', never a manufactured caveat", () => {
    expect(identityChanged(ident("a"))).toBe(false);
    expect(identityChanged(undefined)).toBe(false);
  });
});

describe("command wrappers pass camelCase args to invoke", () => {
  beforeEach(() => invoke.mockReset());

  it("addAccount", async () => {
    invoke.mockResolvedValue(acct("new"));
    await addAccount("Work");
    expect(invoke).toHaveBeenCalledWith("accounts_add", { nickname: "Work" });
  });

  it("setNickname", async () => {
    await setNickname("a", "Renamed");
    expect(invoke).toHaveBeenCalledWith("accounts_set_nickname", { id: "a", nickname: "Renamed" });
  });

  it("removeAccount", async () => {
    await removeAccount("a");
    expect(invoke).toHaveBeenCalledWith("accounts_remove", { id: "a" });
  });

  it("markExhausted converts the epoch-ms arg to seconds for the Rust side", async () => {
    // Caller passes a Date.now()-based ms instant; Rust stores + future-filters in seconds, so the
    // wrapper must divide by 1000 (sparkle-ggvp — persisting ms made the future-filter a no-op).
    await markExhausted("a", 9_999_000);
    expect(invoke).toHaveBeenCalledWith("accounts_mark_exhausted", { id: "a", untilEpoch: 9999 });
  });

  it("ensureProjectTrusted passes the worktree AND the chosen account's configDir", async () => {
    // The command name and BOTH args are the seam: a wrong command name silently no-ops (the trust
    // record never lands and the worker still wedges on the dialog), and dropping configDir would
    // seed the WRONG account's .claude.json. Pin both.
    await ensureProjectTrusted("/wt/acme/agent-7", "/data/accounts/ab12");
    expect(invoke).toHaveBeenCalledWith("ensure_project_trusted", {
      worktree: "/wt/acme/agent-7",
      configDir: "/data/accounts/ab12",
    });
  });

  it("ensureProjectTrusted forwards an undefined configDir for the default account", async () => {
    // The default account has no configDir; Rust resolves that to $HOME/.claude.json. The wrapper
    // must forward `undefined` rather than omit the key or coerce it.
    await ensureProjectTrusted("/wt/acme/agent-7");
    expect(invoke).toHaveBeenCalledWith("ensure_project_trusted", {
      worktree: "/wt/acme/agent-7",
      configDir: undefined,
    });
  });
});

describe("pin map", () => {
  beforeEach(() => clearAllPins());

  it("set / get / clear a per-agent pin", () => {
    expect(getPin("agent1")).toBeUndefined();
    setPin("agent1", "acctX");
    expect(getPin("agent1")).toBe("acctX");
    clearPin("agent1");
    expect(getPin("agent1")).toBeUndefined();
  });

  it("clearAllPins drops every pin", () => {
    setPin("a1", "x");
    setPin("a2", "y");
    clearAllPins();
    expect(getPin("a1")).toBeUndefined();
    expect(getPin("a2")).toBeUndefined();
  });
});

describe("pin persistence across an app restart (sparkle-gms0)", () => {
  // The bug: pins lived in a module-level Map, so restarting Sparkle dropped every pin, auto-pick
  // resumed, and agents landed on a different (possibly never-logged-in) account. Re-importing the
  // module after vi.resetModules() is the in-test stand-in for that restart.
  beforeEach(() => clearAllPins());

  it("a pin survives a module reload", async () => {
    setPin("agent1", "acctX");
    vi.resetModules();
    const fresh = await import("./accountStore");
    expect(fresh.getPin("agent1")).toBe("acctX");
  });

  it("clearPin removes the persisted copy, not just the in-memory one", async () => {
    setPin("agent1", "acctX");
    clearPin("agent1");
    vi.resetModules();
    const fresh = await import("./accountStore");
    expect(fresh.getPin("agent1")).toBeUndefined();
  });

  it("clearAllPins clears the persisted copy too", async () => {
    setPin("agent1", "acctX");
    clearAllPins();
    vi.resetModules();
    const fresh = await import("./accountStore");
    expect(fresh.getPin("agent1")).toBeUndefined();
  });

  it("observes a pin another window wrote, rather than serving a stale module cache", () => {
    // Pins go through plain localStorage, which is shared across windows but broadcasts no event
    // we subscribe to. Reading through to storage on every access keeps a second window's pin (or
    // unpin) from being masked by this window's cached copy.
    setPin("agent1", "acctX");
    globalThis.localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify({ agent1: "acctY" }));
    expect(getPin("agent1")).toBe("acctY");
  });

  it("does not clobber another window's pin for a DIFFERENT agent on write", () => {
    setPin("agent1", "acctX");
    globalThis.localStorage.setItem(
      PINS_STORAGE_KEY,
      JSON.stringify({ agent1: "acctX", agent2: "acctFromOtherWindow" }),
    );
    setPin("agent3", "acctZ");
    expect(getPin("agent2")).toBe("acctFromOtherWindow");
    expect(getPin("agent3")).toBe("acctZ");
  });

  it("tolerates corrupt persisted JSON rather than throwing on load", async () => {
    globalThis.localStorage.setItem(PINS_STORAGE_KEY, "{not valid json");
    vi.resetModules();
    const fresh = await import("./accountStore");
    expect(fresh.getPin("anything")).toBeUndefined();
  });

  it("ignores non-string pin values in persisted data", async () => {
    globalThis.localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify({ good: "acctX", bad: 42 }));
    vi.resetModules();
    const fresh = await import("./accountStore");
    expect(fresh.getPin("good")).toBe("acctX");
    expect(fresh.getPin("bad")).toBeUndefined();
  });
});

describe("signedInAccountIds", () => {
  it("keeps only accounts with a real authenticated email", () => {
    expect(
      signedInAccountIds([
        { id: "a", email: "drodio@storytell.ai", organization: null, accountUuid: null },
        { id: "b", email: null, organization: null, accountUuid: null },
      ]),
    ).toEqual(["a"]);
  });

  it("returns empty for no identities at all", () => {
    expect(signedInAccountIds([])).toEqual([]);
  });
});

describe("pickAccount — signed-in filter (sparkle-gms0)", () => {
  const NOW = 1_000_000;

  it("never auto-picks an account that is not signed in, even at zero usage", () => {
    // The regression this fixes: a config dir created but never `claude login`ed has NO transcripts,
    // so its tokens7d is 0 — it wins the lowest-usage ranking for EVERY agent and drops the user at
    // a login prompt on each one.
    const accounts = [acct("live"), acct("neverLoggedIn")];
    const u = [usage("live", { tokens7d: 5_000_000 }), usage("neverLoggedIn", { tokens7d: 0 })];
    // Without the filter (caller supplied no identities) the zero-usage account still wins — the
    // pre-fix behavior, kept so an identity-less caller is unaffected.
    expect(pickAccount(accounts, u, { now: NOW })?.id).toBe("neverLoggedIn");
    // With it, the signed-in account wins despite being the heaviest.
    expect(pickAccount(accounts, u, { now: NOW, signedInIds: ["live"] })?.id).toBe("live");
  });

  it("ranks by lowest usage WITHIN the signed-in set", () => {
    const accounts = [acct("hi"), acct("lo"), acct("unauthed")];
    const u = [
      usage("hi", { tokens7d: 900 }),
      usage("lo", { tokens7d: 100 }),
      usage("unauthed", { tokens7d: 0 }),
    ];
    expect(pickAccount(accounts, u, { now: NOW, signedInIds: ["hi", "lo"] })?.id).toBe("lo");
  });

  it("still excludes an exhausted account within the signed-in set", () => {
    const accounts = [acct("a"), acct("b")];
    const u = [usage("a", { exhaustedUntil: NOW + 60_000 }), usage("b", { tokens7d: 500 })];
    expect(pickAccount(accounts, u, { now: NOW, signedInIds: ["a", "b"] })?.id).toBe("b");
  });

  it("falls back to every account when NONE is signed in, rather than blocking the spawn", () => {
    // Degrading to the old behavior matters: a fresh install whose identities haven't loaded (or an
    // IPC hiccup returning []) must still start an agent.
    const accounts = [acct("a", { isDefault: true }), acct("b")];
    expect(pickAccount(accounts, [], { now: NOW, signedInIds: [] })?.id).toBe("a");
  });

  it("a manual pin still wins even when that account is not signed in", () => {
    // A human chose it on purpose — same precedence the pin already has over exhausted/near-cap.
    const accounts = [acct("live"), acct("pinned")];
    const chosen = pickAccount(accounts, [], {
      now: NOW,
      signedInIds: ["live"],
      pinnedAccountId: "pinned",
    });
    expect(chosen?.id).toBe("pinned");
  });
});

describe("duplicateAccountGroups — two registrations, one real login", () => {
  // The bug this exists for, verbatim from a live machine: "DROdio Storytell" (~/.claude) and
  // "DROdio Gmail" (a separate config dir) both held a login to accountUuid 5fb3d67c-…. The UI
  // showed two independent headroom bars, and failover between them switched to the SAME quota
  // and re-hit the same limit immediately.
  const UUID = "5fb3d67c-f4ed-417b-9bf2-f9156450eb73";
  const storytell = acct("s", { nickname: "DROdio Storytell", isDefault: true });
  const gmail = acct("g", { nickname: "DROdio Gmail" });
  const sameLogin = [
    { id: "s", email: "drodio@gmail.com", organization: "drodio@gmail.com's Organization", accountUuid: UUID },
    { id: "g", email: "drodio@gmail.com", organization: "drodio@gmail.com's Organization", accountUuid: UUID },
  ];

  it("groups accounts that share an accountUuid, regardless of nickname", () => {
    const groups = duplicateAccountGroups([storytell, gmail], sameLogin);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.accountUuid).toBe(UUID);
    expect(groups[0]!.email).toBe("drodio@gmail.com");
    expect(groups[0]!.accounts.map((a) => a.id)).toEqual(["s", "g"]);
  });

  it("reports genuinely distinct logins as NOT duplicates", () => {
    const distinct = [
      { id: "s", email: "drodio@storytell.ai", organization: null, accountUuid: "uuid-storytell" },
      { id: "g", email: "drodio@gmail.com", organization: null, accountUuid: "uuid-gmail" },
    ];
    expect(duplicateAccountGroups([storytell, gmail], distinct)).toEqual([]);
  });

  it("does not treat two never-signed-in accounts as duplicates of each other", () => {
    // Both have accountUuid null. Grouping on null would report "not set up yet" as "same login".
    const none = [
      { id: "s", email: null, organization: null, accountUuid: null },
      { id: "g", email: null, organization: null, accountUuid: null },
    ];
    expect(duplicateAccountGroups([storytell, gmail], none)).toEqual([]);
  });

  it("keys on accountUuid, not email — a shared email with distinct uuids is not a duplicate", () => {
    // Defensive: email is a display label. Only the uuid identifies the account.
    const sameEmail = [
      { id: "s", email: "drodio@gmail.com", organization: null, accountUuid: "uuid-a" },
      { id: "g", email: "drodio@gmail.com", organization: null, accountUuid: "uuid-b" },
    ];
    expect(duplicateAccountGroups([storytell, gmail], sameEmail)).toEqual([]);
  });

  it("ignores identities for accounts that are not registered", () => {
    const groups = duplicateAccountGroups([storytell], sameLogin);
    expect(groups).toEqual([]); // only one registered account carries the uuid
  });

  it("duplicateAccountIds flattens the groups", () => {
    expect(duplicateAccountIds([storytell, gmail], sameLogin)).toEqual(new Set(["s", "g"]));
    expect(duplicateAccountIds([storytell, gmail], [])).toEqual(new Set());
  });

  it("handles three registrations of the same login", () => {
    const third = acct("t", { nickname: "DROdio Third" });
    const groups = duplicateAccountGroups(
      [storytell, gmail, third],
      [...sameLogin, { id: "t", email: "drodio@gmail.com", organization: null, accountUuid: UUID }],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.accounts.map((a) => a.id)).toEqual(["s", "g", "t"]);
  });
});

describe("adoptionOutcome — naming a fresh login, and refusing one that is already registered", () => {
  // The founder's question: "Do I need to type it in manually?" No — Claude Code writes the email
  // into the config dir it was pointed at, so the nickname is DERIVED.
  it("names a new login from its email", () => {
    const outcome = adoptionOutcome(
      "new",
      [acct("new", { nickname: "Signing in…" }), acct("old")],
      [ident("new", { email: "drodio@storytell.ai", accountUuid: "u-new" }), ident("old", { accountUuid: "u-old" })],
    );
    expect(outcome).toEqual({ kind: "named", nickname: "drodio@storytell.ai" });
  });

  // THE INVARIANT THIS WHOLE FEATURE EXISTS TO PROTECT. Two rows for one Anthropic login share a
  // quota but not their tallies, so each reads as half-used, both win auto-pick, and the learned
  // ceiling is computed from a fraction of real consumption — exactly the state the founder was in.
  it("refuses a login already registered under another account, by accountUuid", () => {
    const outcome = adoptionOutcome(
      "new",
      [acct("new"), acct("old", { nickname: "DROdio Personal" })],
      [ident("new", { email: "drodio@storytell.ai", accountUuid: "SAME" }), ident("old", { accountUuid: "SAME" })],
    );
    expect(outcome).toEqual({ kind: "duplicate", existingNickname: "DROdio Personal" });
  });

  // identityKey falls back to the email for a login predating accountUuid; sameness must follow it,
  // or a pre-uuid account and its twin both stay in rotation on one quota.
  it("refuses a duplicate proven only by a shared email", () => {
    const outcome = adoptionOutcome(
      "new",
      [acct("new"), acct("old", { nickname: "Legacy" })],
      [ident("new", { email: "same@x.com" }), ident("old", { email: "same@x.com" })],
    );
    expect(outcome).toEqual({ kind: "duplicate", existingNickname: "Legacy" });
  });

  it("an abandoned login is UNIDENTIFIED, never named", () => {
    // A dir with no oauthAccount is a login that did not finish. Registering it would put an
    // account that cannot run into the rotation.
    expect(adoptionOutcome("new", [acct("new")], [ident("new")])).toEqual({ kind: "unidentified" });
    expect(adoptionOutcome("new", [acct("new")], [])).toEqual({ kind: "unidentified" });
  });

  it("a login with a uuid but no readable email is not named after the uuid", () => {
    expect(adoptionOutcome("new", [acct("new")], [ident("new", { accountUuid: "u" })])).toEqual({
      kind: "unidentified",
    });
  });

  it("does not call its own row a duplicate of itself", () => {
    const outcome = adoptionOutcome("solo", [acct("solo")], [ident("solo", { email: "a@b.c", accountUuid: "u" })]);
    expect(outcome).toEqual({ kind: "named", nickname: "a@b.c" });
  });
});

// A signed-in reading whose only entries name accounts that NO LONGER EXIST is not a usable signal.
// This is the predicate `partitionAccounts`, `usablePreferredAccount` and `firstUsableHolder` now
// share; before they did, the first read this case as "no signal" (opening the pool to everything)
// while the other two read it as "signal present, nothing matches" (rejecting every account).
describe("signedInFilterApplies — the shared 'is this reading usable' predicate", () => {
  const NOW = 1_000_000;
  const accounts = [
    { id: "a", nickname: "A", configDir: "/a", isDefault: true, createdAt: 1 },
    { id: "b", nickname: "B", configDir: "/b", isDefault: false, createdAt: 2 },
  ];

  it("is false for a reading that names only a STALE id — the divergence this ends", () => {
    expect(signedInFilterApplies(accounts, ["ghost"])).toBe(false);
    // …and the spawn pool therefore stays open rather than emptying.
    expect(pickAccount(accounts, [], { now: NOW, signedInIds: ["ghost"] })?.id).toBe("a");
  });

  it("is true as soon as ONE listed id names a real account, stale siblings notwithstanding", () => {
    expect(signedInFilterApplies(accounts, ["ghost", "b"])).toBe(true);
    // The filter now bites: `a` is excluded even though it would otherwise win on zero usage.
    expect(pickAccount(accounts, [], { now: NOW, signedInIds: ["ghost", "b"] })?.id).toBe("b");
  });

  it("is false for an absent or empty reading — 'could not tell' never empties the pool", () => {
    expect(signedInFilterApplies(accounts, undefined)).toBe(false);
    expect(signedInFilterApplies(accounts, [])).toBe(false);
  });
});

// The degraded-filter path. `signedInFilterApplies` returning false opens the pool to every account
// — deliberately, so a spawn still happens — but that used to also discard what WAS read, letting a
// config dir positively known to hold no login win auto-pick on its zero tally.
describe("unauthedIds — a KNOWN-unauthenticated dir must not win the degraded pool", () => {
  const NOW = 1_000_000;

  it("demotes the never-logged-in dir even though the signed-in filter was skipped", () => {
    const accounts = [acct("heavy"), acct("neverLoggedIn")];
    const u = [usage("heavy", { tokens7d: 5_000_000 }), usage("neverLoggedIn", { tokens7d: 0 })];
    // The signal is UNUSABLE — the only listed id names no existing account — so the filter is
    // skipped and both accounts are eligible. That is the pre-existing, intended degradation.
    expect(signedInFilterApplies(accounts, ["ghost"])).toBe(false);
    expect(pickAccount(accounts, u, { now: NOW, signedInIds: ["ghost"] })?.id).toBe(
      "neverLoggedIn",
    );
    // But we DID read `neverLoggedIn`'s config dir and it holds no login. Carrying that reading
    // through the degradation is what stops the zero tally from winning.
    expect(
      pickAccount(accounts, u, {
        now: NOW,
        signedInIds: ["ghost"],
        unauthedIds: new Set(["neverLoggedIn"]),
      })?.id,
    ).toBe("heavy");
  });

  it("demotes, never blocks: every account unauthenticated still spawns one", () => {
    // The whole point of degrading open is that a spawn happens. Demoting out of `candidates`
    // rather than out of `eligible` is what preserves that when the demotion covers everyone.
    const accounts = [acct("a", { isDefault: true }), acct("b")];
    const chosen = pickAccount(accounts, [], {
      now: NOW,
      signedInIds: [],
      unauthedIds: new Set(["a", "b"]),
    });
    expect(chosen).not.toBeNull();
    expect(["a", "b"]).toContain(chosen?.id);
  });

  it("is inert when the signed-in filter DOES apply — those accounts are already gone", () => {
    const accounts = [acct("in"), acct("out")];
    const u = [usage("in", { tokens7d: 9_000 }), usage("out", { tokens7d: 0 })];
    const opts = { now: NOW, signedInIds: ["in"] };
    expect(pickAccount(accounts, u, opts)?.id).toBe("in");
    expect(pickAccount(accounts, u, { ...opts, unauthedIds: new Set(["out"]) })?.id).toBe("in");
  });

  it("omitting the option changes nothing", () => {
    const accounts = [acct("heavy"), acct("empty")];
    const u = [usage("heavy", { tokens7d: 5_000_000 }), usage("empty", { tokens7d: 0 })];
    expect(pickAccount(accounts, u, { now: NOW })?.id).toBe("empty");
  });
});

describe("deadLoginIds — a DEFINITELY-expired login must not win the pool", () => {
  const NOW = 1_000_000;

  it("demotes a dead-login account even though it is signed in with the lowest tally", () => {
    // The exact expired-login trap: `dead` is signed in (it keeps its recorded email) and, because it
    // can't spend, carries the LOWEST tally — so without the demotion it wins auto-pick and every
    // agent spawns into a 401. `live` is the healthy target.
    const accounts = [acct("dead"), acct("live")];
    const u = [usage("dead", { tokens7d: 0 }), usage("live", { tokens7d: 5_000 })];
    const opts = { now: NOW, signedInIds: ["dead", "live"] };
    // Control: with no dead-login set, the zero-tally `dead` wins — the bug.
    expect(pickAccount(accounts, u, opts)?.id).toBe("dead");
    // With it, the fleet is routed to the healthy account instead.
    expect(pickAccount(accounts, u, { ...opts, deadLoginIds: new Set(["dead"]) })?.id).toBe("live");
  });

  it("demotes, never blocks: a lone dead-login account still spawns (re-login prompt beats no agent)", () => {
    // This is what keeps a re-login reachable AND what makes the auto-switch helper rescue converge:
    // `eligible` keeps the dead account, so `leastBad` returns it rather than emptying the pool.
    const accounts = [acct("only")];
    const chosen = pickAccount(accounts, [usage("only", { tokens7d: 0 })], {
      now: NOW,
      signedInIds: ["only"],
      deadLoginIds: new Set(["only"]),
    });
    expect(chosen?.id).toBe("only");
  });

  it("omitting the option changes nothing", () => {
    const accounts = [acct("dead"), acct("live")];
    const u = [usage("dead", { tokens7d: 0 }), usage("live", { tokens7d: 5_000 })];
    expect(pickAccount(accounts, u, { now: NOW, signedInIds: ["dead", "live"] })?.id).toBe("dead");
  });

  it("eligibleAccounts drops a dead-login account so a sticky key is re-picked off it", () => {
    // `autoPick`'s "is my previous account still eligible?" reads `eligibleAccounts`. A dead login must
    // fall out of it, or a rescued sticky helper is judged still-healthy on its dead account and never
    // moves — the non-converging restart loop.
    const accounts = [acct("dead"), acct("live")];
    const u = [usage("dead", { tokens7d: 0 }), usage("live", { tokens7d: 5_000 })];
    const ids = eligibleAccounts(accounts, u, {
      now: NOW,
      signedInIds: ["dead", "live"],
      deadLoginIds: new Set(["dead"]),
    }).map((a) => a.id);
    expect(ids).toContain("live");
    expect(ids).not.toContain("dead");
  });
});

describe("notSignedInAccountIds — read-and-has-no-login, not merely unknown", () => {
  function id(idv: string, email: string | null): Identity {
    return { id: idv, email, organization: null, accountUuid: null };
  }

  it("is the complement of signedInAccountIds over the identities we HAVE", () => {
    const identities = [id("in", "a@example.test"), id("out", null)];
    expect(signedInAccountIds(identities)).toEqual(["in"]);
    expect(notSignedInAccountIds(identities)).toEqual(["out"]);
  });

  it("says nothing about an account with no identity row at all", () => {
    // Absent from `identities` is UNKNOWN, and unknown must not be reported as evidence of
    // no-login — that is the distinction the degraded path needs and `signedInIds` cannot make.
    expect(notSignedInAccountIds([id("out", null)])).not.toContain("unread");
  });
});

describe("clobbered default guard (concierge shared-default fragility)", () => {
  const NOW = 1_000_000;
  function ident(id: string, over: Partial<Identity> = {}): Identity {
    return { id, email: `${id}@x.com`, organization: null, accountUuid: `uuid-${id}`, ...over };
  }

  it("clobberedDefaultIds flags a default whose TERMINAL is signed into a different account (shellForked)", () => {
    const def = acct("def", { isDefault: true, configDir: "" });
    const dedicated = acct("ded");
    const identities = [
      // Default: Sparkle runs it as uuid-def, but the terminal ~/.claude.json is a DIFFERENT account.
      ident("def", { shellAccountUuid: "uuid-terminal", shellEmail: "terminal@x.com" }),
      ident("ded"),
    ];
    expect([...clobberedDefaultIds([def, dedicated], identities)]).toEqual(["def"]);
  });

  it("clobberedDefaultIds flags a default whose dir a different account took over recently (identityChanged), and NEVER a dedicated account", () => {
    const def = acct("def", { isDefault: true, configDir: "" });
    const dedicated = acct("ded", { isDefault: false });
    // Both carry identityChanged, but only the DEFAULT is shared with the terminal, so only it counts.
    const identities = [ident("def", { identityChanged: true }), ident("ded", { identityChanged: true })];
    expect([...clobberedDefaultIds([def, dedicated], identities)]).toEqual(["def"]);
  });

  it("a healthy default is NOT flagged", () => {
    const def = acct("def", { isDefault: true, configDir: "" });
    expect([...clobberedDefaultIds([def], [ident("def")])]).toEqual([]);
  });

  it("eligibleAccounts drops a clobbered account — but leastBad still returns it when it is the ONLY one", () => {
    const def = acct("def", { isDefault: true, configDir: "" });
    const dedicated = acct("ded");
    const u = [usage("def"), usage("ded")];
    const clobberedIds = new Set(["def"]);
    // SIDE EFFECT: with a healthy dedicated alternative, the clobbered default is neither eligible nor picked.
    expect(eligibleAccounts([def, dedicated], u, { now: NOW, clobberedIds }).map((a) => a.id)).toEqual([
      "ded",
    ]);
    expect(pickAccount([def, dedicated], u, { now: NOW, clobberedIds })?.id).toBe("ded");
    // Without the option nothing changes — the clobbered default is eligible again (proves the exclusion
    // is the clobberedIds set, not something else).
    expect(eligibleAccounts([def, dedicated], u, { now: NOW }).map((a) => a.id).sort()).toEqual([
      "ded",
      "def",
    ]);
    // Last-account guard: when the clobbered default is all there is, it is STILL returned — a login
    // prompt on the fragile default beats no account at all.
    expect(eligibleAccounts([def], u, { now: NOW, clobberedIds })).toEqual([]);
    expect(pickAccount([def], u, { now: NOW, clobberedIds })?.id).toBe("def");
  });

  it("a human PIN overrides the clobbered guard — a pinned account wins even when clobbered", () => {
    const def = acct("def", { isDefault: true, configDir: "" });
    const dedicated = acct("ded");
    const u = [usage("def"), usage("ded")];
    const clobberedIds = new Set(["def"]);
    expect(pickAccount([def, dedicated], u, { now: NOW, clobberedIds, pinnedAccountId: "def" })?.id).toBe(
      "def",
    );
  });
});
