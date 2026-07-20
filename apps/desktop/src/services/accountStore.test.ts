import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  pickAccount,
  getUsage,
  getIdentities,
  accountLabel,
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
  PINS_STORAGE_KEY,
  type Account,
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
      { id: "b", email: null, organization: null },
    ]);
    const out = await getIdentities();
    expect(invoke).toHaveBeenCalledWith("accounts_identities");
    expect(out).toEqual([
      { id: "a", email: "drodio@storytell.ai", organization: "drodio@storytell.ai's Organization" },
      { id: "b", email: null, organization: null },
    ]);
  });
});

describe("accountLabel — real email is authoritative, nickname is the fallback", () => {
  it("prefers the real authenticated email over the nickname", () => {
    expect(accountLabel(acct("a", { nickname: "DROdio Gmail" }), { id: "a", email: "drodio@storytell.ai", organization: null })).toBe(
      "drodio@storytell.ai",
    );
  });

  it("falls back to the nickname when the account has no identity (not signed in)", () => {
    expect(accountLabel(acct("a", { nickname: "DROdio Chief" }), { id: "a", email: null, organization: null })).toBe("DROdio Chief");
    expect(accountLabel(acct("a", { nickname: "DROdio Chief" }), undefined)).toBe("DROdio Chief");
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
        { id: "a", email: "drodio@storytell.ai", organization: null },
        { id: "b", email: null, organization: null },
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
