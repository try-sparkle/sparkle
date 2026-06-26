import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  pickAccount,
  getUsage,
  addAccount,
  setNickname,
  removeAccount,
  markExhausted,
  DEFAULT_NEAR_CAP,
  getPin,
  setPin,
  clearPin,
  clearAllPins,
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

describe("getUsage snake_case → camelCase mapping", () => {
  beforeEach(() => invoke.mockReset());

  it("maps tokens_5h/tokens_7d/exhausted_until and defaults null", async () => {
    invoke.mockResolvedValue([
      { id: "a", tokens_5h: 11, tokens_7d: 22, exhausted_until: 1234 },
      { id: "b", tokens_5h: 0, tokens_7d: 0, exhausted_until: null },
    ]);
    const out = await getUsage();
    expect(invoke).toHaveBeenCalledWith("accounts_usage");
    expect(out).toEqual([
      { id: "a", tokens5h: 11, tokens7d: 22, exhaustedUntil: 1234 },
      { id: "b", tokens5h: 0, tokens7d: 0, exhaustedUntil: null },
    ]);
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

  it("markExhausted", async () => {
    await markExhausted("a", 9999);
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
