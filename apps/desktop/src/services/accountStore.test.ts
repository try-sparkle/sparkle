import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  pickAccount,
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
  DEFAULT_NEAR_CAP,
  getPin,
  setPin,
  clearPin,
  clearAllPins,
  signedInAccountIds,
  duplicateAccountGroups,
  identityKey,
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
    expect(forkNotice(d)).toBe(
      "Sparkle runs this account as drodio@storytell.ai; your terminal is signed in as drodio@gmail.com.",
    );
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
    expect(forkNotice(d)).toBe(
      "Sparkle runs this account as a@example.com; your terminal is signed in as b@example.com.",
    );
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

    const notice = forkNotice(d);
    expect(notice).not.toContain("isn't signed in");
    expect(notice).toBe(
      "Sparkle runs this account as the account Sparkle is signed into; your terminal is signed in as them@example.com.",
    );
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

  it("identityKey mirrors the Rust ladder: uuid, else email:<addr>, else null", () => {
    // Direct coverage, because this is a CROSS-LANGUAGE mirror of `accounts::identity_key` and the
    // ledger + ceiling gate key on the Rust side of it. With nothing exercising it here the two
    // halves could drift silently and disagree about who an account is — which is the whole failure
    // this branch exists to remove (roborev 58175).
    expect(identityKey(ident("a", { accountUuid: "u1", email: "e@x.com" }))).toBe("u1");
    expect(identityKey(ident("a", { email: "e@x.com" }))).toBe("email:e@x.com");
    expect(identityKey(ident("a", {}))).toBeNull();
    expect(identityKey(undefined)).toBeNull();
    // The uuid WINS when both are present — it is the stronger discriminator, and two config dirs
    // can hold logins to one account under one email, which is why accountUuid exists at all.
    expect(identityKey(ident("a", { accountUuid: "u2", email: "same@x.com" }))).toBe("u2");
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

  it("names an unverified account by state, not by nickname, in prose", () => {
    const d = accountDisplay(DEFAULT, ident("d", { shellEmail: "drodio@gmail.com", shellAccountUuid: "5fb3d67c" }));
    expect(d.shellForked).toBe(true);
    const notice = forkNotice(d) ?? "";
    expect(notice).not.toContain("DROdio Personal");
    expect(notice).toContain("drodio@gmail.com");
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

    const notice = forkNotice(d);
    expect(notice).not.toContain("isn't signed in");
    expect(notice).toBe(
      "Sparkle runs this account as the account Sparkle is signed into; your terminal is signed in as them@example.com.",
    );
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
