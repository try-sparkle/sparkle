import { afterEach, describe, it, expect } from "vitest";
import {
  assessHeadroom,
  bestHealthyTarget,
  switchRecommendation,
  describeRecommendation,
  rotationReadiness,
  exhaustionOutlook,
  WARN_FRACTION,
  type Ceiling,
  type SwitchRecommendation,
} from "./headroom";
import { accountDisplay, CEILING_AVOID_FRACTION, LIVE_AVOID_PERCENT } from "./accountStore";
import type { Account, Usage, Identity } from "./accountStore";
import { setAccountInRotation, ROTATION_OUT_STORAGE_KEY } from "./rotationState";

const NOW = 1_000_000;

// The opt-out persists in localStorage by design (the spawn path reads it and is not React), so a
// test that sets one would otherwise leak into its neighbours.
afterEach(() => localStorage.removeItem(ROTATION_OUT_STORAGE_KEY));

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

  // TRIGGER IS THE OBSERVED WALL, NOT THE ESTIMATE. A recommendation is made only when `from` has
  // actually hit a rate limit (`exhaustedUntil` in the future). The learned-ceiling `warn` estimate
  // no longer produces one (founder's call — see `switchRecommendation`). These cases still pin
  // WHERE it recommends switching TO; `from` is exhausted so the recommendation exists to test that.
  it("recommends the account with the most headroom", () => {
    const u = [usage("a", 90, NOW + 60_000), usage("b", 50), usage("c", 10)];
    const c = [ceil("a", 100), ceil("b", 100), ceil("c", 100)];
    const rec = switchRecommendation("a", accounts, u, c, idents, NOW);
    expect(rec?.from.id).toBe("a");
    expect(rec?.to.id).toBe("c");
    expect(rec?.reason).toBe("exhausted");
    expect(rec?.fraction).toBeCloseTo(0.9);
  });

  it("does NOT recommend off the learned-ceiling ESTIMATE alone (the retired proactive nudge)", () => {
    // `a` is at 90% of its learned ceiling — the old "approaching" trigger — but has NOT hit a real
    // wall. The estimate no longer drives a recommendation, so this is silence now. Pins the removal:
    // restore the `warn` clause in `switchRecommendation` and this goes from null to a recommendation.
    const u = [usage("a", 90), usage("b", 10)];
    const c = [ceil("a", 100), ceil("b", 100)];
    expect(switchRecommendation("a", accounts, u, c, idents, NOW)).toBeNull();
  });

  // THE WEEKLY-WALL TRIGGER (bead sparkle-hbyae). The founder's account hit its 7-DAY limit (Anthropic
  // "Current week: 100% used") while its 5-HOUR SESSION was at 0%. A weekly cap records no session
  // rate-limit event, so `exhaustedUntil` stays null and `state` never becomes "exhausted" — yet the
  // fleet is walled until the weekly window resets. Before the fix, `switchRecommendation` triggered
  // ONLY on the observed session wall, so it returned null and auto-switch never moved the fleet; the
  // founder activated a healthy account by hand. These pin that Anthropic's OWN weekly number now
  // triggers the migration, the SAME signal the target-exclusion filter already used.
  const twoIdents = [ident("a"), ident("b")];
  const twoAccts = [acct("a"), acct("b")];
  const bigCeil = [ceil("a", 1000), ceil("b", 1000)];
  const healthy = usage("a", 10); // session fine, no wall
  it("TRIGGERS on a live WEEKLY wall even with the session at 0% and no rate-limit event", () => {
    const u = [healthy, usage("b", 10)];
    const live = [
      { id: "a", fiveHourPercent: 0, sevenDayPercent: 100 }, // weekly 100%, session 0%
      { id: "b", fiveHourPercent: 20, sevenDayPercent: 56 }, // the healthy target
    ];
    const rec = switchRecommendation("a", twoAccts, u, bigCeil, twoIdents, NOW, live);
    // THE SIDE EFFECT: a recommendation to move the fleet OFF the weekly-walled account, which
    // `useAccountSwitch` then auto-migrates on because `reason === "exhausted"`.
    expect(rec?.from.id).toBe("a");
    expect(rec?.to.id).toBe("b");
    expect(rec?.reason).toBe("exhausted");
  });

  it("does NOT trigger when the current account's live usage is BELOW the avoid threshold", () => {
    // The paired negative. `a` one point UNDER LIVE_AVOID_PERCENT and with no wall is not spent — the
    // boundary that proves the THRESHOLD drives the trigger, not the mere presence of a live row.
    // Symbolic in the constant so it holds at any threshold: bump to LIVE_AVOID_PERCENT and the
    // recommendation appears.
    const u = [healthy, usage("b", 10)];
    const live = [
      { id: "a", fiveHourPercent: 10, sevenDayPercent: LIVE_AVOID_PERCENT - 1 },
      { id: "b", fiveHourPercent: 20, sevenDayPercent: 56 },
    ];
    expect(switchRecommendation("a", twoAccts, u, bigCeil, twoIdents, NOW, live)).toBeNull();
  });

  it("pins LIVE_AVOID_PERCENT at exactly 90 (founder product decision, 2026-08-21)", () => {
    // The intent test below pins the threshold from ABOVE (reds if > 92). This anchors the exact
    // value so a drift ANYWHERE — e.g. to 70 — reds a test instead of silently moving the switch
    // trigger, the spawn gate (partitionAccounts), the affinity gate (firstUsableHolder), and the
    // "all accounts near their limit" banner (exhaustionOutlook) together. The value is a founder
    // product decision with no other durable record in code; change it here on purpose, not by
    // accident. See LIVE_AVOID_PERCENT's docblock for why 90.
    expect(LIVE_AVOID_PERCENT).toBe(90);
  });

  it("TRIGGERS at the INCIDENT value of 92% — pins the threshold at ≤92, not the mechanism", () => {
    // The symbolic boundary tests above prove the threshold DRIVES the trigger, but they hold at any
    // threshold, so a revert of LIVE_AVOID_PERCENT to 95 would leave them all green while the founder's
    // reported symptom returns. This pins the VALUE: an account at 92% (the measured incident — reached
    // on Auto without switching under the old 95 bar) must now produce a recommendation. Goes RED if
    // the constant drifts back above 92.
    const u = [healthy, usage("b", 10)];
    const live = [
      { id: "a", fiveHourPercent: 10, sevenDayPercent: 92 }, // the incident value
      { id: "b", fiveHourPercent: 20, sevenDayPercent: 56 }, // healthy target
    ];
    const rec = switchRecommendation("a", twoAccts, u, bigCeil, twoIdents, NOW, live);
    expect(rec?.from.id).toBe("a");
    expect(rec?.to.id).toBe("b");
    expect(rec?.reason).toBe("exhausted");
  });

  it("TRIGGERS on a live SESSION wall too — the trigger is symmetric across both windows", () => {
    const u = [healthy, usage("b", 10)];
    const live = [
      { id: "a", fiveHourPercent: 100, sevenDayPercent: 5 }, // session 100%, weekly clear
      { id: "b", fiveHourPercent: 10, sevenDayPercent: 5 },
    ];
    expect(switchRecommendation("a", twoAccts, u, bigCeil, twoIdents, NOW, live)?.to.id).toBe("b");
  });

  it("a live-walled current account with NOWHERE healthy to go still returns null", () => {
    // The whole pool is weekly-spent — the modal's genuine no-target case. Auto-switch cannot help, so
    // no recommendation, and `useLimitSync` correctly falls through to the manual modal.
    const u = [healthy, usage("b", 10)];
    const live = [
      { id: "a", fiveHourPercent: 0, sevenDayPercent: 100 },
      { id: "b", fiveHourPercent: 0, sevenDayPercent: 99 }, // also weekly-spent
    ];
    expect(switchRecommendation("a", twoAccts, u, bigCeil, twoIdents, NOW, live)).toBeNull();
  });

  it("carries the CURRENT account's identity-change flag onto the recommendation", () => {
    // The ceiling itself is the guard: `ceiling_for_account` returns null while an identity change
    // leaves too few attributable samples, so a recommendation that HAS a fraction is already one
    // measured only against the current login. Nothing about the change needs to ride the wire.
    // `a` is exhausted (the only trigger now); its ceiling still quantifies the recommendation.
    const u = [usage("a", 90, NOW + 60_000), usage("b", 10)];
    const c = [ceil("a", 100), ceil("b", 100)];
    const changed = [{ ...ident("a"), identityChanged: true }, ident("b"), ident("c")];
    const rec = switchRecommendation("a", accounts, u, c, changed, NOW);
    expect(rec?.fraction).toBe(0.9);
    expect(rec).not.toHaveProperty("identityChanged");
  });

  it("stays silent while the current account has room", () => {
    const u = [usage("a", 10), usage("b", 50)];
    const c = [ceil("a", 100), ceil("b", 100)];
    expect(switchRecommendation("a", accounts, u, c, idents, NOW)).toBeNull();
  });

  it("never recommends an account that isn't signed in", () => {
    // Moving to a login prompt is not a fix. `c` has the most headroom but no identity. `a` is
    // exhausted so a recommendation is warranted.
    const u = [usage("a", 90, NOW + 60_000), usage("b", 50), usage("c", 0)];
    const c2 = [ceil("a", 100), ceil("b", 100), ceil("c", 100)];
    const rec = switchRecommendation("a", accounts, u, c2, [ident("a"), ident("b"), ident("c", null)], NOW);
    expect(rec?.to.id).toBe("b");
  });

  // SAME LOGIN IS NOT A SWITCH. Two registrations of one Anthropic account share one quota, so
  // moving every agent across gains nothing and re-hits the identical limit immediately — under a
  // banner naming both sides with the same email. `duplicateAccountGroups` (display) and
  // `siblingMap` (benching) already deduped on identity; this decision never did.
  it.each([
    ["they share an accountUuid", "u-same", "u-same", "a@x.com", "b@x.com"],
    // The uuid is absent on a login predating the field, so the email carries it — matching
    // `identityKey` and the Rust ledger rather than a fourth rule.
    ["neither has a uuid but the emails match", null, null, "same@x.com", "same@x.com"],
    ["one has no uuid and the emails match", null, "u-b", "same@x.com", "same@x.com"],
  ])("never recommends a registration of the same login when %s", (_case, ua, ub, ea, eb) => {
    const dup: Identity[] = [
      { id: "a", email: ea, organization: null, accountUuid: ua },
      ident("b"),
      { id: "c", email: eb, organization: null, accountUuid: ub },
    ];
    const u = [usage("a", 90, NOW + 60_000), usage("b", 50), usage("c", 1)];
    const c2 = [ceil("a", 100), ceil("b", 100), ceil("c", 100)];
    // `a` hit a real wall; `c` looks like the emptiest account in the world but is the same quota.
    expect(switchRecommendation("a", accounts, u, c2, dup, NOW)?.to.id).toBe("b");
    // …and when the duplicate is the ONLY candidate, stay silent rather than offer a no-op.
    expect(switchRecommendation("a", [acct("a"), acct("c")], u, c2, dup, NOW)).toBeNull();
  });

  it("excludes on the UUID clause alone, when no email is readable on `from`", () => {
    // Pins the other half of the `comparable` disjunction. Every row above that proves exclusion
    // also has emails on both sides, so the email clause alone keeps them comparable and deleting
    // the uuid clause leaves them green — the guard would be half-unpinned. Here sameness is
    // provable ONLY by the uuid, so dropping that clause makes the pair incomparable → "not same"
    // → recommended, restoring the duplicate-quota no-op switch this exclusion exists to prevent.
    const sameUuidNoEmailOnFrom: Identity[] = [
      { id: "a", email: null, organization: null, accountUuid: "u-same" },
      { id: "b", email: "b@x.com", organization: null, accountUuid: "u-same" },
    ];
    const u = [usage("a", 10, NOW + 60_000), usage("b", 1)];
    const c2 = [ceil("a", 100), ceil("b", 100)];
    expect(
      switchRecommendation("a", [acct("a"), acct("b")], u, c2, sameUuidNoEmailOnFrom, NOW),
    ).toBeNull();
  });

  it("still recommends when `from`'s email is AMBIGUOUS across two uuid accounts", () => {
    // knightwatch probe 2 on PR #1261, and the case where the local pairwise policy this file used
    // to carry disagreed with `duplicateAccountGroups`.
    //
    // `from` has an email and no uuid. Both candidates carry a uuid AND the same email — an email
    // that therefore identifies TWO Anthropic accounts. The old rule asked "are these two
    // identities comparable, and do they agree?" pairwise: both sides have an email, the emails
    // match, so EVERY candidate read as the same login and all were excluded. The switcher went
    // silent for an exhausted account with two perfectly good alternatives.
    //
    // `duplicateAccountGroups` refuses that inference explicitly — an email-only row whose email
    // maps to more than one uuid group is grouped with NOTHING, because guessing would bench an
    // account that is not actually a sibling. Deriving from it makes this case eligible again.
    // This assertion fails against the deleted policy, which is the point.
    const ambiguousEmail: Identity[] = [
      { id: "a", email: "shared@x.com", organization: null, accountUuid: null },
      { id: "b", email: "shared@x.com", organization: null, accountUuid: "u-b" },
      { id: "c", email: "shared@x.com", organization: null, accountUuid: "u-c" },
    ];
    // `a` is exhausted by a real limit event; `b` and `c` are nearly untouched.
    const u = [usage("a", 10, NOW + 60_000), usage("b", 1), usage("c", 50)];
    const c2 = [ceil("a", 100), ceil("b", 100), ceil("c", 100)];
    expect(
      switchRecommendation("a", [acct("a"), acct("b"), acct("c")], u, c2, ambiguousEmail, NOW)?.to
        .id,
    ).toBe("b");
  });

  it("still recommends when the CURRENT account's identity is unreadable — unknown is not same", () => {
    // THE REACHABLE HALF of "unknown is not same", and the only one that discriminates. Candidates
    // are already filtered by `signedInAccountIds` (email != null), so a candidate is always
    // resolvable — an unreadable one is dropped by that filter, not by this rule. `from` is NOT
    // filtered that way: it is whichever account agents are running under, and it can be exhausted
    // by a real limit event with no readable identity at all.
    //
    // `identitiesDiffer` answers false both for "provably same" and for "cannot tell". Without the
    // resolvable guard an unreadable `from` therefore reads as the SAME login as every candidate,
    // all of them are excluded, and the switcher goes silent exactly when the user most needs it.
    // Only positive evidence of sameness may exclude.
    const unreadableFrom: Identity[] = [
      { id: "a", email: null, organization: null, accountUuid: null },
      { id: "b", email: "b@x.com", organization: null, accountUuid: "u-b" },
    ];
    // `a` is exhausted by a real limit event, so a recommendation is warranted regardless of its
    // ceiling or its identity.
    const u = [usage("a", 10, NOW + 60_000), usage("b", 1)];
    const c2 = [ceil("a", 100), ceil("b", 100)];
    expect(
      switchRecommendation("a", [acct("a"), acct("b")], u, c2, unreadableFrom, NOW)?.to.id,
    ).toBe("b");
  });

  it("still recommends when the two identities are INCOMPARABLE, not merely non-empty", () => {
    // The subtler half, and the one a per-side "is this non-empty" guard lets through.
    // `identitiesDiffer` only decides when both sides carry the SAME field, so `from` with a uuid
    // and no email, against a candidate with an email and no uuid (a login predating the field),
    // is undecidable — it takes neither branch and returns false. A guard that only asks whether
    // each side is individually resolvable passes both, and `!false` then excludes the candidate on
    // zero evidence. With every candidate predating the uuid field, the switcher would go silent
    // for an exhausted account.
    const incomparable: Identity[] = [
      { id: "a", email: null, organization: null, accountUuid: "u-a" },
      { id: "b", email: "b@x.com", organization: null, accountUuid: null },
    ];
    const u = [usage("a", 10, NOW + 60_000), usage("b", 1)];
    const c2 = [ceil("a", 100), ceil("b", 100)];
    expect(
      switchRecommendation("a", [acct("a"), acct("b")], u, c2, incomparable, NOW)?.to.id,
    ).toBe("b");
  });

  it("never recommends an EXHAUSTED target, but a merely-warn one is now ELIGIBLE (ranked last)", () => {
    // The learned-ceiling `warn` estimate no longer EXCLUDES a switch target — it only ranks it last
    // (dropping the estimate-veto on the escape route). So with `a` walled: `b` is near its ceiling
    // (warn) but not walled, `c` is exhausted. `c` is excluded on the observed wall; `b` is the only
    // eligible target and IS recommended — the fleet is not stranded behind a real wall by a guess.
    const u = [usage("a", 90, NOW + 60_000), usage("b", 95), usage("c", 10, NOW + 60_000)];
    const c2 = [ceil("a", 100), ceil("b", 100), ceil("c", 100)];
    expect(switchRecommendation("a", accounts, u, c2, idents, NOW)?.to.id).toBe("b");
    // When every alternative is itself EXHAUSTED (observed), there is nothing to move to → null.
    const allWalled = [
      usage("a", 90, NOW + 60_000),
      usage("b", 95, NOW + 60_000),
      usage("c", 10, NOW + 60_000),
    ];
    expect(switchRecommendation("a", accounts, allWalled, c2, idents, NOW)).toBeNull();
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
    // `a` hit a real wall. c is least-used but unmeasurable; b is known-comfortable. Prefer the one
    // we can vouch for.
    const u = [usage("a", 90, NOW + 60_000), usage("b", 20), usage("c", 1)];
    const c2 = [ceil("a", 100), ceil("b", 100), ceil("c", null)];
    expect(switchRecommendation("a", accounts, u, c2, idents, NOW)?.to.id).toBe("b");
  });

  it("EXCLUDES a target that is live-spent on Anthropic's own number (parity with the spawn gate)", () => {
    // `a` hit a real wall; `b` has no wall but reads 99% on Anthropic's own number. `partitionAccounts`
    // refuses `b` for a new spawn (`isLiveSpent`), so recommending/auto-switching onto it would wall
    // the fleet immediately — and AC8 would already be calling `b` at-limit. With `b` the only
    // alternative, the recommendation is null. Drop the live clause from the candidate filter and this
    // returns `b`, contradicting the spawn gate.
    const u = [usage("a", 5, NOW + 60_000), usage("b", 1)];
    const c2 = [ceil("a", 100), ceil("b", 100)];
    const live = [{ id: "b", fiveHourPercent: 99, sevenDayPercent: 10 }];
    expect(switchRecommendation("a", [acct("a"), acct("b")], u, c2, [ident("a"), ident("b")], NOW, live)).toBeNull();
    // Without the live signal `b` is a fine target — proving the exclusion above is the live clause,
    // not something incidental to the fixture.
    expect(
      switchRecommendation("a", [acct("a"), acct("b")], u, c2, [ident("a"), ident("b")], NOW)?.to.id,
    ).toBe("b");
  });

  it("judges a live-spent target PER LOGIN — a duplicate of a spent login is not an escape route", () => {
    // `x` hit a real wall. `a` and `b` are two registrations of ONE login (shared uuid). Only `a` has
    // a live row (99%); `b`'s fetch failed → no row. A quota belongs to the LOGIN, so `b` is just as
    // spent as `a`, and `switchRecommendation` (which builds the login grouping and judges live per
    // login) excludes BOTH → null. The per-DIR filter would read `b` as unknown and offer it, then
    // auto-switch would wall the fleet on the shared quota. `null` vs `b` is the discriminator, and it
    // is the same per-login judgement the spawn gate and AC8 use, so the three cannot disagree.
    const accounts3 = [acct("x"), acct("a"), acct("b")];
    const idents3: Identity[] = [
      ident("x"),
      { id: "a", email: "dup@x.com", organization: null, accountUuid: "u-dup" },
      { id: "b", email: "dup@x.com", organization: null, accountUuid: "u-dup" },
    ];
    const u = [usage("x", 5, NOW + 60_000), usage("a", 1), usage("b", 1)];
    const c2 = [ceil("x", 100), ceil("a", 100), ceil("b", 100)];
    const live = [{ id: "a", fiveHourPercent: 99, sevenDayPercent: 10 }]; // only `a` reported
    expect(switchRecommendation("x", accounts3, u, c2, idents3, NOW, live)).toBeNull();
  });

  it("prefers an UNKNOWN-ceiling target over a near-ceiling (warn) one — tiered ranking", () => {
    // `a` hit a real wall. `b` is at 0.9 of its LEARNED ceiling (warn, admitted as a last-resort
    // target now), `c` has NO learned ceiling and zero usage (a freshly-added account). The unknown,
    // untouched account is the better bet than one the estimate says is near its wall, so `c` wins.
    // The old flat rank (fraction, else 1+used/(used+1)) scored `b` at 0.9 and `c` at ~1.0, preferring
    // the near-ceiling `b`; the tiered rank puts warn behind unknown.
    const u = [usage("a", 90, NOW + 60_000), usage("b", 90), usage("c", 0)];
    const c2 = [ceil("a", 100), ceil("b", 100), ceil("c", null)];
    expect(switchRecommendation("a", accounts, u, c2, idents, NOW)?.to.id).toBe("c");
  });

  it("returns null when there is nowhere to go", () => {
    // `a` hit a real wall but is the only account → no candidate → null.
    const u = [usage("a", 90, NOW + 60_000)];
    const c2 = [ceil("a", 100)];
    expect(switchRecommendation("a", [acct("a")], u, c2, [ident("a")], NOW)).toBeNull();
  });

  it("returns null for an unknown or absent current account", () => {
    const u = [usage("a", 90)];
    const c2 = [ceil("a", 100)];
    expect(switchRecommendation(null, accounts, u, c2, idents, NOW)).toBeNull();
    expect(switchRecommendation("ghost", accounts, u, c2, idents, NOW)).toBeNull();
  });

  // THE EXPIRED-LOGIN TRIGGER (the P0). An account whose OAuth session has DIED (a live
  // `claude auth status` "no") records NO rate-limit event and returns NO utilization figure — its
  // live probe 401s too — so `loginLiveWorstPercent` is null, `?? 0` scores it 0%, and before this
  // arm it read as the HEALTHIEST account on the machine and the fleet was stranded on it, unable to
  // authenticate, with nothing moving. The caller folds `authIsDefinitelyExpired` per account into
  // the `deadLoginIds` argument; here it is passed directly so the pure decision is what's under test.
  describe("a DEFINITELY-EXPIRED login triggers the switch", () => {
    // NEITHER account is walled and NEITHER has any live-usage row — so the ONLY thing that can move
    // the fleet is the dead-login signal. That is what makes these non-vacuous: with `deadLoginIds`
    // empty (the negative), every other signal says "healthy" and the answer must be null.
    const u = [usage("a", 10), usage("b", 10)];
    const c = [ceil("a", 1000), ceil("b", 1000)];

    it("recommends moving to the healthy account when the current login is dead", () => {
      // THE SIDE EFFECT: a recommendation to move the fleet OFF the dead account `a` and ONTO the
      // healthy `b` — which `useAccountSwitch` then auto-migrates because `reason === "exhausted"`.
      const rec = switchRecommendation(
        "a",
        twoAccts,
        u,
        c,
        twoIdents,
        NOW,
        [],
        new Set(["a"]),
      );
      expect(rec?.from.id).toBe("a");
      expect(rec?.to.id).toBe("b");
      expect(rec?.reason).toBe("exhausted");
      // Flags this as an EXPIRED login (no wall, no live-spend) so the banner says "renew", not the
      // false "has hit its limit" — but `reason` stays "exhausted" so every gate still fires.
      expect(rec?.expired).toBe(true);
    });

    it("does NOT flag `expired` when the trigger was a real wall, not a dead login", () => {
      // The contrast: a wall-triggered recommendation must NOT get the expired sentence. Same target,
      // but the reason is a real rate-limit event and no login is dead.
      const walled = [usage("a", 10, NOW + 60_000), usage("b", 10)];
      const rec = switchRecommendation("a", twoAccts, walled, c, twoIdents, NOW, [], new Set());
      expect(rec?.reason).toBe("exhausted");
      expect(rec?.expired).toBe(false);
    });

    it("does NOT flag `expired` when the account is BOTH walled and dead (the wall message stands)", () => {
      // A dead login that ALSO hit a real wall is not "expired-only"; the generic out-of-room copy is
      // still accurate, so `expired` stays false.
      const walled = [usage("a", 10, NOW + 60_000), usage("b", 10)];
      const rec = switchRecommendation("a", twoAccts, walled, c, twoIdents, NOW, [], new Set(["a"]));
      expect(rec?.expired).toBe(false);
    });

    it("does NOT flag `expired` when the account is BOTH live-over-utilized and dead", () => {
      // The third conjunct of `expiredOnly`. `a` is dead AND at 95% of its real weekly quota — the
      // "your login has expired, sign back in" remedy would be wrong (re-authenticating does not
      // restore spent quota), so `expired` must be false. Delete `currentLiveWorst < LIVE_AVOID_PERCENT`
      // from the conjunction and this reds.
      const live = [
        { id: "a", fiveHourPercent: 5, sevenDayPercent: 95 },
        { id: "b", fiveHourPercent: 10, sevenDayPercent: 5 },
      ];
      const rec = switchRecommendation("a", twoAccts, u, c, twoIdents, NOW, live, new Set(["a"]));
      expect(rec?.expired).toBe(false);
    });

    it("does NOT trigger when the probe merely errored / is pending / offline (paired negative)", () => {
      // The paired negative that makes the test above non-vacuous. An account whose probe could not
      // decisively say "expired" is ABSENT from `deadLoginIds` — exactly the errored/pending/offline/
      // before-first-poll case — so with no wall and no live row the fleet must NOT move. Revert the
      // `|| deadLoginIds.has(...)` arm and the case above still passes on this same empty set, which
      // is why BOTH are needed: only their split proves the dead-login signal is what drives it.
      expect(switchRecommendation("a", twoAccts, u, c, twoIdents, NOW, [], new Set())).toBeNull();
    });

    it("returns null when the current login is dead but there is NO healthy target", () => {
      // The founder's genuine stranded case — every account is spent/dead. `b` is ALSO dead, so it is
      // excluded as a target (an expired login keeps its recorded email, so it still reads "signed
      // in" and would otherwise be offered). No candidate → null → the caller falls through to the
      // manual modal, which is correct.
      const rec = switchRecommendation(
        "a",
        twoAccts,
        u,
        c,
        twoIdents,
        NOW,
        [],
        new Set(["a", "b"]),
      );
      expect(rec).toBeNull();
    });

    it("never picks a dead-login account as the destination even when it looks emptiest", () => {
      // `c` has the most headroom (0 usage) and is signed in, but its login is dead — moving there
      // just relocates the 401. The switch must pick the healthy `b` instead.
      const u3 = [usage("a", 90, NOW + 60_000), usage("b", 50), usage("c", 0)];
      const rec = switchRecommendation("a", accounts, u3, c, idents, NOW, [], new Set(["c"]));
      expect(rec?.to.id).toBe("b");
    });
  });
});

describe("describeRecommendation", () => {
  /** The real wiring: name each account from its VERIFIED identity, exactly as AccountSwitchHost
   *  does. Any account missing from `identities` has no login and must not be named. */
  const displayFor =
    (identities: Identity[]) =>
    (a: Account) =>
      accountDisplay(a, identities.find((i) => i.id === a.id));

  const FROM = acct("a", { nickname: "Storytell" });
  const TO = acct("b", { nickname: "Gmail" });
  const signedIn = displayFor([ident("a", "drodio@storytell.ai"), ident("b", "drodio@gmail.com")]);

  it("states a reached limit plainly, naming both accounts by their verified email", () => {
    const rec = { from: FROM, to: TO, fraction: null, reason: "exhausted" as const };
    expect(describeRecommendation(rec, signedIn)).toBe(
      "drodio@storytell.ai has hit its limit. Switch to drodio@gmail.com to keep working.",
    );
  });

  it("says the LOGIN EXPIRED (not 'hit its limit') when the trigger was a dead login", () => {
    // The remedy-copy fix: an expired session must not be described as a usage limit, or the user is
    // told to wait out a reset that never comes instead of signing back in. The switch is still
    // offered (the fleet keeps working on the healthy account), and the copy points at the real fix.
    const rec = { from: FROM, to: TO, fraction: null, reason: "exhausted" as const, expired: true };
    const out = describeRecommendation(rec, signedIn);
    expect(out).toBe(
      "drodio@storytell.ai's login has expired. Switch to drodio@gmail.com to keep working, then sign back in.",
    );
    // The misleading usage-limit phrasing must be ABSENT.
    expect(out).not.toContain("has hit its limit");
  });

  it("NEVER quotes a '% of its usual limit' estimate, even when a fraction is present", () => {
    // The estimate wording is GONE with the learned-ceiling nudge. `describeRecommendation` now
    // returns the observed-wall sentence regardless of `reason`/`fraction`, so a stale producer that
    // still sends a fraction (or the legacy "approaching" reason) can no longer make it quote a
    // percentage. Reintroduce the estimate branch and this goes red.
    const rec = {
      from: FROM,
      to: TO,
      fraction: 0.87,
      reason: "approaching" as const,
    } as unknown as SwitchRecommendation;
    const out = describeRecommendation(rec, signedIn);
    expect(out).toBe(
      "drodio@storytell.ai has hit its limit. Switch to drodio@gmail.com to keep working.",
    );
    expect(out).not.toContain("usual limit");
    expect(out).not.toContain("87%");
  });

  it("NEVER names an account by a nickname it cannot verify", () => {
    // The banner asks the user to move work between real Anthropic logins. Naming an unverified
    // account "Storytell" asserts a login nobody read. Assert the nicknames are ABSENT — asserting
    // only that the not-signed-in phrasing appears would pass even if the nickname came along too.
    const rec = { from: FROM, to: TO, fraction: null, reason: "exhausted" as const };
    const out = describeRecommendation(rec, displayFor([]));
    expect(out).not.toContain("Storytell");
    expect(out).not.toContain("Gmail");
    expect(out).toBe(
      "An account that isn't signed in has hit its limit. " +
        "Switch to an account that isn't signed in to keep working.",
    );
  });

  it("never claims a surviving estimate is partly someone else's (knightwatch probe 4)", () => {
    // There USED to be an identity caveat here, appended when `rec.identityChanged && fraction`.
    // The whole estimate branch is gone, so the formatter can never append it — but the flag is
    // still CARRIED and IGNORED, and setting it true is the discriminator that makes this able to
    // fail: a formatter that reads it (old or reintroduced) would append the caveat, the current one
    // returns the plain observed-wall sentence. The cast is deliberate — the field is gone from the
    // type, so this asserts the formatter ignores it even if a stale producer sends it.
    const rec = {
      from: FROM,
      to: TO,
      fraction: 0.87,
      reason: "exhausted" as const,
      identityChanged: true,
    } as unknown as SwitchRecommendation;
    const text = describeRecommendation(rec, signedIn);
    expect(text).toBe(
      "drodio@storytell.ai has hit its limit. Switch to drodio@gmail.com to keep working.",
    );
    expect(text).not.toMatch(/isn't its own|rough|different Claude sign-in/i);
  });
});

describe("rotationReadiness", () => {
  // Identity helpers that can express every real state, including the two `ident()` above cannot:
  // a config dir with no login at all, and a login carrying a uuid but no readable email.
  const signedInAs = (id: string, email: string, uuid: string | null = `uuid-${id}`): Identity => ({
    id,
    email,
    organization: null,
    accountUuid: uuid,
  });
  const neverLoggedIn = (id: string): Identity => ({
    id,
    email: null,
    organization: null,
    accountUuid: null,
  });

  it("THE FOUNDER'S STATE: two registered accounts, exactly ONE of which can receive a spawn", () => {
    // Measured on the real machine. `DROdio Personal` is signed in; `DROdio Gmail` is a config dir
    // whose `.claude.json` has no `oauthAccount` key at all — registered, never `claude login`ed.
    // The list showed two rows, so "rotation is broken" was the only conclusion available. It was
    // never running: `signedInAccountIds` keeps only non-null emails and `pickAccount` narrows to
    // those, so the candidate pool had ONE member and returned the same account every time.
    const accounts = [
      acct("personal", { nickname: "DROdio Personal", isDefault: true }),
      acct("gmail", { nickname: "DROdio Gmail" }),
    ];
    const got = rotationReadiness(accounts, [
      signedInAs("personal", "drodio@gmail.com"),
      neverLoggedIn("gmail"),
    ]);
    // The whole point: TWO rows, ONE usable login.
    expect(got.usableLogins).toBe(1);
    expect(got.usable.map((a) => a.id)).toEqual(["personal"]);
    // And the dead one is named, not silently dropped — being invisible is what made it look alive.
    expect(got.notSignedIn.map((a) => a.nickname)).toEqual(["DROdio Gmail"]);
    expect(got.noEmail).toEqual([]);
    expect(got.redundant).toEqual([]);
  });

  it("counts ZERO usable logins when nothing is signed in", () => {
    const accounts = [acct("a"), acct("b")];
    const got = rotationReadiness(accounts, [neverLoggedIn("a"), neverLoggedIn("b")]);
    expect(got.usableLogins).toBe(0);
    expect(got.notSignedIn).toHaveLength(2);
  });

  it("counts an account with NO identity row at all as not signed in", () => {
    // Identities can be missing entirely (never read, IPC hiccup), not merely null-valued.
    const got = rotationReadiness([acct("a")], []);
    expect(got.usableLogins).toBe(0);
    expect(got.notSignedIn.map((a) => a.id)).toEqual(["a"]);
  });

  it("counts two genuinely different logins as two", () => {
    const got = rotationReadiness(
      [acct("a"), acct("b")],
      [signedInAs("a", "one@example.com", "u1"), signedInAs("b", "two@example.com", "u2")],
    );
    expect(got.usableLogins).toBe(2);
    expect(got.redundant).toEqual([]);
  });

  it("two registrations of the SAME login count as ONE usable account, not two", () => {
    // Two config dirs, one Anthropic account, one quota — so "switch" moves sideways into the same
    // wall. Reporting 2 here would announce rotation as available when it is not.
    const UUID = "5fb3d67c-f4ed-417b-9bf2-f9156450eb73";
    const got = rotationReadiness(
      [acct("s", { nickname: "Storytell" }), acct("g", { nickname: "Gmail" })],
      [signedInAs("s", "drodio@gmail.com", UUID), signedInAs("g", "drodio@gmail.com", UUID)],
    );
    expect(got.usableLogins).toBe(1);
    expect(got.usable.map((a) => a.id)).toEqual(["s"]);
    expect(got.redundant.map((a) => a.id)).toEqual(["g"]);
  });

  it("pairs a uuid-less registration with its uuid-bearing twin by email", () => {
    // `accountUuid` is absent on logins predating the field, so an email-only row and its modern
    // twin are the same login. Counting them as two is the same over-count one level down.
    const got = rotationReadiness(
      [acct("old"), acct("new")],
      [signedInAs("old", "drodio@gmail.com", null), signedInAs("new", "drodio@gmail.com", "u1")],
    );
    expect(got.usableLogins).toBe(1);
  });

  it("does NOT merge an ambiguous email-only row — it stays its own login", () => {
    // The canonical grouping refuses to pair a row whose email maps to more than one uuid group,
    // because guessing benches an account that may not be a sibling. Deriving sameness from it
    // rather than re-deciding here is what carries that guard over: a local "same email → same
    // login" rule would report 2 usable logins for these three rows.
    const got = rotationReadiness(
      [acct("a"), acct("b"), acct("c")],
      [
        signedInAs("a", "shared@example.com", "u1"),
        signedInAs("b", "shared@example.com", "u2"),
        signedInAs("c", "shared@example.com", null),
      ],
    );
    expect(got.usableLogins).toBe(3);
    expect(got.redundant).toEqual([]);
  });

  it("counts a uuid-only login OUT of the pool — without calling it 'not signed in'", () => {
    // It has a real login, so "not signed in" would be false; auto-pick keys on EMAIL, so it still
    // cannot receive a spawn. Two different facts, two different buckets, so the copy can be honest
    // about each.
    const got = rotationReadiness(
      [acct("a")],
      [{ id: "a", email: null, organization: null, accountUuid: "u1" }],
    );
    expect(got.usableLogins).toBe(0);
    expect(got.noEmail.map((a) => a.id)).toEqual(["a"]);
    expect(got.notSignedIn).toEqual([]);
  });

  it("puts every registered account in exactly one bucket", () => {
    // A partition, not a filter: an account that fell through every bucket would vanish from the
    // banner's accounting entirely — which is precisely the failure being fixed.
    const accounts = [acct("ok"), acct("dup"), acct("dead"), acct("uuidonly")];
    const got = rotationReadiness(accounts, [
      signedInAs("ok", "one@example.com", "u1"),
      signedInAs("dup", "one@example.com", "u1"),
      neverLoggedIn("dead"),
      { id: "uuidonly", email: null, organization: null, accountUuid: "u9" },
    ]);
    const placed = [...got.usable, ...got.redundant, ...got.notSignedIn, ...got.noEmail].map(
      (a) => a.id,
    );
    expect(placed.sort()).toEqual(accounts.map((a) => a.id).sort());
    expect(new Set(placed).size).toBe(accounts.length);
  });
});

describe("exhaustionOutlook (AC8)", () => {
  const CEIL = 100;
  // At/above the ACT line (0.9) but comfortably below the ceiling itself.
  const OVER_ACT = CEILING_AVOID_FRACTION * CEIL;

  it("reports every usable account at its limit, with the EARLIEST reset across them", () => {
    const got = exhaustionOutlook(
      ["a", "b"],
      [usage("a", 1, NOW + 90 * 60_000), usage("b", 1, NOW + 20 * 60_000)],
      [ceil("a", CEIL), ceil("b", CEIL)],
      NOW,
    );
    expect(got.allAtLimit).toBe(true);
    expect(got.earliestReset).toBe(NOW + 20 * 60_000);
  });

  it("is FALSE while any usable account still has room", () => {
    const got = exhaustionOutlook(
      ["a", "b"],
      [usage("a", 1, NOW + 60_000), usage("b", 10)],
      [ceil("a", CEIL), ceil("b", CEIL)],
      NOW,
    );
    expect(got.allAtLimit).toBe(false);
    // The reset is still reported — one account IS limited, and the caller may want to say so.
    expect(got.earliestReset).toBe(NOW + 60_000);
  });

  it("does NOT count an account over its estimated ceiling as at-limit without an observed wall", () => {
    // OBSERVED-ONLY now. An account over the learned-ceiling estimate but with no real rate-limit
    // event is NOT "at its limit" — the estimate was retired as a driver (it read "90% of its usual
    // limit" while the real Anthropic numbers were clear). Reintroduce the `fraction >= ACT` clause
    // and this flips to true, which is exactly the behaviour that was removed.
    const got = exhaustionOutlook(["a"], [usage("a", OVER_ACT)], [ceil("a", CEIL)], NOW);
    expect(got.allAtLimit).toBe(false);
    expect(got.earliestReset).toBeNull();
  });

  it("counts REAL Anthropic utilization at/above LIVE_AVOID_PERCENT as at-limit (matches the spawn gate)", () => {
    // The banner must track the SAME signal `partitionAccounts` excludes on. An account at 99% of its
    // real Anthropic limit with NO rate-limit event yet is out of room to auto-pick, so it counts.
    const live = [{ id: "a", fiveHourPercent: 99, sevenDayPercent: 10 }];
    const got = exhaustionOutlook(["a"], [usage("a", 1)], [ceil("a", CEIL)], NOW, live);
    expect(got.allAtLimit).toBe(true);
    // ...but it has no observed rate-limit event, so there is NO reset instant to quote.
    expect(got.earliestReset).toBeNull();
    // Just under the line → still has room → not all-at-limit. Symbolic (LIVE_AVOID_PERCENT - 1) so it
    // holds at any threshold. Remove the live clause from exhaustionOutlook and the first assertion
    // flips to false (out of step with the gate again).
    const under = [{ id: "a", fiveHourPercent: LIVE_AVOID_PERCENT - 1, sevenDayPercent: 10 }];
    expect(exhaustionOutlook(["a"], [usage("a", 1)], [ceil("a", CEIL)], NOW, under).allAtLimit).toBe(
      false,
    );
  });

  it("judges the live signal PER LOGIN, matching switchRecommendation and the spawn gate", () => {
    // usable = [x, a] (the reps). `x` walled; `a` has NO live row but its login twin `b` reads 99%.
    // Per-login `a`'s quota is spent, so the pool IS all-at-limit — the SAME verdict the switch and
    // spawn paths reach for `a`/`b`. The per-DIR reading (no siblingIds) would call `a` healthy and
    // the banner would disagree with them; the sibling map is the discriminator.
    const siblingIds = new Map([
      ["a", ["a", "b"]],
      ["b", ["a", "b"]],
    ]);
    const usableIds = ["x", "a"];
    const u = [usage("x", 5, NOW + 60_000), usage("a", 1)];
    const c2 = [ceil("x", CEIL), ceil("a", CEIL)];
    const live = [{ id: "b", fiveHourPercent: 99, sevenDayPercent: 10 }]; // only the TWIN reported
    expect(exhaustionOutlook(usableIds, u, c2, NOW, live, siblingIds).allAtLimit).toBe(true);
    expect(exhaustionOutlook(usableIds, u, c2, NOW, live).allAtLimit).toBe(false); // per-dir
  });

  it("all-at-limit is decided by the OBSERVED wall or REAL usage, not the learned-ceiling estimate", () => {
    // An account well over its ESTIMATED ceiling still does not make the pool "all at their limit";
    // only an account that actually hit a wall (or reads spent on Anthropic's own number) does. The
    // paired case (same account, now walled) pins that the observed signal DOES flip it — so the
    // false above is about the estimate, not an unconditional false.
    expect(
      exhaustionOutlook(["a"], [usage("a", OVER_ACT)], [ceil("a", CEIL)], NOW).allAtLimit,
    ).toBe(false);
    expect(
      exhaustionOutlook(["a"], [usage("a", OVER_ACT, NOW + 60_000)], [ceil("a", CEIL)], NOW)
        .allAtLimit,
    ).toBe(true);
  });

  it("an UNMEASURED account is not evidence of exhaustion", () => {
    // No learned ceiling → `unknown`. Treating that as at-the-limit would print "all accounts are
    // at their limit" about a pool that was never measured.
    const got = exhaustionOutlook(
      ["a", "b"],
      [usage("a", 1, NOW + 60_000), usage("b", 999_999_999)],
      [ceil("a", CEIL), ceil("b", null)],
      NOW,
    );
    expect(got.allAtLimit).toBe(false);
  });

  it("an account with no usage row at all has the most headroom, not the least", () => {
    const got = exhaustionOutlook(
      ["a", "silent"],
      [usage("a", 1, NOW + 60_000)],
      [ceil("a", CEIL)],
      NOW,
    );
    expect(got.allAtLimit).toBe(false);
  });

  it("an EMPTY usable pool is not vacuously 'all at their limit'", () => {
    // Zero usable accounts is a sign-in problem, not a rate-limit problem, and saying the latter
    // sends the user to wait for a reset that will never fix it.
    const got = exhaustionOutlook([], [usage("a", 999, NOW + 60_000)], [ceil("a", CEIL)], NOW);
    expect(got.allAtLimit).toBe(false);
    expect(got.earliestReset).toBeNull();
  });

  it("ignores an EXPIRED exhaustion when choosing the earliest reset", () => {
    const got = exhaustionOutlook(
      ["stale", "live"],
      [usage("stale", 1, NOW - 60_000), usage("live", 1, NOW + 60_000)],
      [ceil("stale", CEIL), ceil("live", CEIL)],
      NOW,
    );
    expect(got.earliestReset).toBe(NOW + 60_000);
    // ...and the expired one is back in play, so the pool is not all at its limit.
    expect(got.allAtLimit).toBe(false);
  });

  it("only judges the accounts it was given", () => {
    // An exhausted account that is NOT in the usable pool (never signed in, say) must not drag the
    // verdict — it was never a rotation target.
    const got = exhaustionOutlook(
      ["healthy"],
      [usage("healthy", 1), usage("dead", 999, NOW + 60_000)],
      [ceil("healthy", CEIL), ceil("dead", CEIL)],
      NOW,
    );
    expect(got.allAtLimit).toBe(false);
    expect(got.earliestReset).toBeNull();
  });
});

describe("bestHealthyTarget — the AUTOMATIC switch's choice", () => {
  const ACCOUNTS = [acct("a"), acct("b")];
  const USAGE = [usage("a", 10), usage("b", 10)];
  const IDENTS = [ident("a"), ident("b")];

  // ── THE OPT-OUT DEMOTES; IT DOES NOT BLOCK — HERE TOO ────────────────────────────────────────
  // An earlier cut of this branch excluded opted-out accounts from this oracle, and it was wrong in
  // the most expensive direction. This function has no least-bad fallback — it returns null — and it
  // feeds the advisory banner a human accepts by hand and the stranded-helper rescue, neither of
  // which writes the fleet preference. So with the fleet walled on `a` and `b` the only healthy
  // account but opted out, excluding it produced no banner, no rescue, and a retired plan: a fleet
  // stranded on a dead account with nothing on screen offering the escape it used to offer.
  //
  // The failure that exclusion reached for is closed at the WRITE instead — every preference write
  // routes through `recordActivation`, which puts the target back in rotation, so an inert
  // preference cannot exist. This asserts the oracle stays out of it.
  it("still offers an opted-out account as an escape rather than stranding the fleet", () => {
    setAccountInRotation("b", false);
    expect(bestHealthyTarget(ACCOUNTS, USAGE, [], IDENTS, NOW, [], ["a"])?.id).toBe("b");
  });

  it("is decidable from its arguments alone", () => {
    // The other half of the same correction: callers pass a snapshot up to HEADROOM_POLL_MS old, so
    // mixing in a live localStorage read made the answer depend on when it was called rather than on
    // what it was given. Same inputs, same answer, whatever the stored state says.
    setAccountInRotation("b", false);
    const withOptOut = bestHealthyTarget(ACCOUNTS, USAGE, [], IDENTS, NOW, [], ["a"])?.id;
    setAccountInRotation("b", true);
    expect(bestHealthyTarget(ACCOUNTS, USAGE, [], IDENTS, NOW, [], ["a"])?.id).toBe(withOptOut);
  });

  // ── A DEAD-LOGIN ACCOUNT IS NEVER A TARGET ────────────────────────────────────────────────────
  // `signedInAccountIds` keys on the recorded EMAIL, which an EXPIRED login still carries, so a
  // dead-login account reads "signed in" and would be a valid destination unless dropped explicitly.
  it("excludes a dead-login account as a destination", () => {
    // `b` is the only other account and its login is dead → nowhere healthy to go → null. Without the
    // `deadLoginIds` filter, `b` reads signed-in and would be returned as the (unusable) target.
    expect(bestHealthyTarget(ACCOUNTS, USAGE, [], IDENTS, NOW, [], ["a"], new Set(["b"]))).toBeNull();
  });

  it("picks the live account over a dead-login one with more headroom", () => {
    // The paired positive: `c` has zero usage (emptiest) but a dead login; `b` is chosen instead.
    const three = [acct("a"), acct("b"), acct("c")];
    const usage3 = [usage("a", 10), usage("b", 50), usage("c", 0)];
    const idents3 = [ident("a"), ident("b"), ident("c")];
    expect(bestHealthyTarget(three, usage3, [], idents3, NOW, [], ["a"])?.id).toBe("c"); // control
    expect(bestHealthyTarget(three, usage3, [], idents3, NOW, [], ["a"], new Set(["c"]))?.id).toBe(
      "b",
    );
  });
});
