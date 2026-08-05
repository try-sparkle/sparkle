import { describe, it, expect } from "vitest";
import {
  assessHeadroom,
  switchRecommendation,
  describeRecommendation,
  WARN_FRACTION,
  type Ceiling,
  type SwitchRecommendation,
} from "./headroom";
import { accountDisplay } from "./accountStore";
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

  it("carries the CURRENT account's identity-change flag onto the recommendation", () => {
    // The ceiling itself is the guard: `ceiling_for_account` returns null while an identity change
    // leaves too few attributable samples, so a recommendation that HAS a fraction is already one
    // measured only against the current login. Nothing about the change needs to ride the wire.
    const u = [usage("a", 90), usage("b", 10)];
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
    // Moving to a login prompt is not a fix. `c` has the most headroom but no identity.
    const u = [usage("a", 90), usage("b", 50), usage("c", 0)];
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
    const u = [usage("a", 90), usage("b", 50), usage("c", 1)];
    const c2 = [ceil("a", 100), ceil("b", 100), ceil("c", 100)];
    // `c` looks like the emptiest account in the world; it is the same quota as `a`.
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
  /** The real wiring: name each account from its VERIFIED identity, exactly as AccountSwitchHost
   *  does. Any account missing from `identities` has no login and must not be named. */
  const displayFor =
    (identities: Identity[]) =>
    (a: Account) =>
      accountDisplay(a, identities.find((i) => i.id === a.id));

  const FROM = acct("a", { nickname: "Storytell" });
  const TO = acct("b", { nickname: "Gmail" });
  const signedIn = displayFor([ident("a", "drodio@storytell.ai"), ident("b", "drodio@gmail.com")]);

  it("quantifies an approaching limit, naming both accounts by their verified email", () => {
    const rec = { from: FROM, to: TO, fraction: 0.87, reason: "approaching" as const };
    expect(describeRecommendation(rec, signedIn)).toBe(
      "drodio@storytell.ai is 87% of its usual limit. Switch to drodio@gmail.com before it runs out.",
    );
  });

  it("states a reached limit plainly", () => {
    const rec = { from: FROM, to: TO, fraction: null, reason: "exhausted" as const };
    expect(describeRecommendation(rec, signedIn)).toBe(
      "drodio@storytell.ai has hit its limit. Switch to drodio@gmail.com to keep working.",
    );
  });

  it("NEVER names an account by a nickname it cannot verify", () => {
    // The banner asks the user to move work between real Anthropic logins. Naming an unverified
    // account "Storytell" asserts a login nobody read. Assert the nicknames are ABSENT — asserting
    // only that the not-signed-in phrasing appears would pass even if the nickname came along too.
    const rec = { from: FROM, to: TO, fraction: 0.9, reason: "approaching" as const };
    const out = describeRecommendation(rec, displayFor([]));
    expect(out).not.toContain("Storytell");
    expect(out).not.toContain("Gmail");
    expect(out).toBe(
      "An account that isn't signed in is 90% of its usual limit. " +
        "Switch to an account that isn't signed in before it runs out.",
    );
  });

  it("never claims a surviving estimate is partly someone else's (knightwatch probe 4)", () => {
    // There USED to be an identity caveat here. It was false wherever it could appear: it required
    // `fraction != null`, i.e. a ceiling to divide by — and `ceiling_for_account` cuts every
    // pre-takeover and boundary-crossing episode BEFORE returning a non-null ceiling. A number that
    // survives to reach this banner therefore contains only the current login's samples. The reset
    // already carries the doubt by yielding `null` while the evidence is insufficient; saying it
    // again in prose said something untrue about the user's own data.
    // The flag is CARRIED but IGNORED — and carrying it is what makes this test able to fail.
    // My first version omitted `identityChanged` entirely, so the pre-fix formatter (which appended
    // the caveat only when `rec.identityChanged && rec.fraction != null`) returned the same plain
    // string: the assertion held against the very code it was written to pin. Vacuous, and
    // knightwatch caught it. Setting it true is the discriminator — the old formatter appends here,
    // the new one does not. The cast is deliberate: the field is gone from the type, and this
    // asserts the FORMATTER ignores it even if a stale producer still sends it over the wire.
    const rec = {
      from: FROM,
      to: TO,
      fraction: 0.87,
      reason: "approaching" as const,
      identityChanged: true,
    } as unknown as SwitchRecommendation;
    const text = describeRecommendation(rec, signedIn);
    expect(text).toBe(
      "drodio@storytell.ai is 87% of its usual limit. Switch to drodio@gmail.com before it runs out.",
    );
    expect(text).not.toMatch(/isn't its own|rough|different Claude sign-in/i);
  });

  it("NEVER names an account by a nickname it cannot verify", () => {
    // The banner asks the user to move work between real Anthropic logins. Naming an unverified
    // account "Storytell" asserts a login nobody read. Assert the nicknames are ABSENT — asserting
    // only that the not-signed-in phrasing appears would pass even if the nickname came along too.
    const rec = { from: FROM, to: TO, fraction: 0.9, reason: "approaching" as const };
    const out = describeRecommendation(rec, displayFor([]));
    expect(out).not.toContain("Storytell");
    expect(out).not.toContain("Gmail");
    expect(out).toBe(
      "An account that isn't signed in is 90% of its usual limit. " +
        "Switch to an account that isn't signed in before it runs out.",
    );
  });

});
