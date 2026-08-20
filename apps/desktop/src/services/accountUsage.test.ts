import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Tauri boundary the same way the rest of the desktop suite does.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (c: string, a: unknown) => invokeMock(c, a),
}));

import {
  getAccountUsageLive,
  summarizeMeter,
  scopedModelName,
  type AccountUsageLive,
} from "./accountUsage";

describe("getAccountUsageLive", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes account_usage_live with the configDir arg and returns the typed result", async () => {
    // The NEUTRAL confirmed shape (camelCase, as the Rust command serializes it). Nullable windows
    // arrive as `null`, never absent — the contract this wrapper is typed against.
    const result: AccountUsageLive = {
      fiveHourPercent: 42.0,
      fiveHourResetsAt: "2026-08-12T04:09:59.793055+00:00",
      sevenDayPercent: 15.0,
      sevenDayResetsAt: "2026-08-17T10:59:59.793078+00:00",
      limits: [
        {
          kind: "session",
          group: "session",
          percent: 42,
          severity: "warning",
          resetsAt: "2026-08-12T04:09:59.793055+00:00",
          isActive: true,
        },
      ],
    };
    invokeMock.mockResolvedValueOnce(result);

    const out = await getAccountUsageLive("/some/config/dir");

    // The Rust command name and the camelCase arg keys the Tauri bridge maps to `config_dir`/`force`.
    // Default is the quiet, cache-served path — force is explicitly false so the Rust command's
    // `Option<bool>` receives a concrete value rather than relying on an absent key.
    expect(invokeMock).toHaveBeenCalledWith("account_usage_live", {
      configDir: "/some/config/dir",
      force: false,
    });
    expect(out.fiveHourPercent).toBe(42.0);
    expect(out.sevenDayPercent).toBe(15.0);
    expect(out.limits[0]?.isActive).toBe(true);
  });

  it("passes force=true so the Rust command BYPASSES the TTL cache (the 'Refresh usage' path)", async () => {
    // The whole point of the force flag: a manual refresh must re-read the keychain and re-query
    // Anthropic instead of serving a cached token. Non-vacuous — the default call above proves the
    // flag is NOT always true, so a wrapper that dropped `force` would fail one of the two.
    invokeMock.mockResolvedValueOnce({
      fiveHourPercent: 1,
      fiveHourResetsAt: null,
      sevenDayPercent: 2,
      sevenDayResetsAt: null,
      limits: [],
    } satisfies AccountUsageLive);

    await getAccountUsageLive("/some/config/dir", true);

    expect(invokeMock).toHaveBeenCalledWith("account_usage_live", {
      configDir: "/some/config/dir",
      force: true,
    });
  });

  it("propagates a rejection so the caller can fall back to the local estimate", async () => {
    invokeMock.mockRejectedValueOnce(new Error("no access token in stored credentials"));
    await expect(getAccountUsageLive("/some/config/dir")).rejects.toThrow(
      "no access token",
    );
  });
});

// ── WHICH METER AM I SPENDING AGAINST ───────────────────────────────────────────────────────────
// These pin the null-vs-undefined shape of the two fields Rust newly projects. The wire form is the
// authority: a Rust `Option<T>` serializes as the key with an explicit `null` VALUE, so `null` is
// the COMMON case here and every one of these must read it as "no credits meter", not as a parse
// hole. `undefined` (the key absent) is only reachable from an older fixture, and must behave
// identically — a helper that distinguished them would make the feature's behaviour depend on
// which side of a version skew the payload came from.

/** The confirmed wire shape with every optional key EXPLICITLY null — what Rust actually sends. */
function nullShaped(): AccountUsageLive {
  return {
    fiveHourPercent: 42,
    fiveHourResetsAt: null,
    sevenDayPercent: 15,
    sevenDayResetsAt: null,
    limits: [
      {
        kind: "weekly_all",
        group: "weekly",
        percent: 15,
        severity: "normal",
        resetsAt: null,
        isActive: false,
        scope: null,
      },
    ],
    extraUsage: null,
  };
}

describe("summarizeMeter", () => {
  it("reads an explicit null extraUsage as the SUBSCRIPTION meter, not as missing data", () => {
    // The common case on the wire. `null`, not absent — this object would be a type error if
    // `extraUsage` had been typed `?: LiveExtraUsage` (undefined-only), which is the whole point.
    expect(summarizeMeter(nullShaped())).toEqual({
      meter: "subscription",
      usedCredits: null,
      monthlyLimit: null,
      spendLimitReached: false,
    });
  });

  it("treats an ABSENT extraUsage key identically to an explicit null", () => {
    // A fixture written before the field existed. Behaviour must not fork on null vs undefined.
    const absent: AccountUsageLive = {
      fiveHourPercent: 42,
      fiveHourResetsAt: null,
      sevenDayPercent: 15,
      sevenDayResetsAt: null,
      limits: [],
    };
    expect(summarizeMeter(absent)).toEqual(summarizeMeter(nullShaped()));
  });

  it("reports the USAGE-CREDITS meter with its spend figures when it is enabled", () => {
    // Non-vacuous against the subscription case above: same helper, different verdict, and the
    // figures come through rather than being flattened to null.
    const live: AccountUsageLive = {
      ...nullShaped(),
      extraUsage: {
        isEnabled: true,
        monthlyLimit: 200,
        usedCredits: 199.5,
        utilization: 99.75,
        spendLimitReached: true,
      },
    };
    expect(summarizeMeter(live)).toEqual({
      meter: "usageCredits",
      usedCredits: 199.5,
      monthlyLimit: 200,
      spendLimitReached: true,
    });
  });

  it("does NOT call the credits meter live on a null/undefined isEnabled", () => {
    // Only an explicit `true` flips the meter. A payload that reports credits fields without saying
    // the meter is on must not be rendered as "you are spending credits".
    const nullEnabled: AccountUsageLive = {
      ...nullShaped(),
      extraUsage: {
        isEnabled: null,
        monthlyLimit: null,
        usedCredits: null,
        utilization: null,
        spendLimitReached: null,
      },
    };
    expect(summarizeMeter(nullEnabled).meter).toBe("subscription");
    // …and a null spendLimitReached is NOT a warning.
    expect(summarizeMeter(nullEnabled).spendLimitReached).toBe(false);
  });

  it("carries usedCredits through even when the meter reports no monthly ceiling", () => {
    const live: AccountUsageLive = {
      ...nullShaped(),
      extraUsage: { isEnabled: true, monthlyLimit: null, usedCredits: 12.25, spendLimitReached: false },
    };
    expect(summarizeMeter(live)).toEqual({
      meter: "usageCredits",
      usedCredits: 12.25,
      monthlyLimit: null,
      spendLimitReached: false,
    });
  });
});

describe("scopedModelName", () => {
  it("names the model a scoped weekly window belongs to", () => {
    expect(
      scopedModelName({
        kind: "weekly_scoped",
        group: "weekly",
        percent: 0,
        severity: "normal",
        resetsAt: null,
        isActive: false,
        scope: { model: { id: null, displayName: "Fable" } },
      }),
    ).toBe("Fable");
  });

  it("returns null for an account-wide window whose scope the wire sent as null", () => {
    expect(scopedModelName(nullShaped().limits[0]!)).toBeNull();
  });

  it("returns null when the scope is present but carries no model", () => {
    expect(
      scopedModelName({
        kind: "weekly_scoped",
        group: "weekly",
        percent: 0,
        severity: "normal",
        resetsAt: null,
        isActive: false,
        scope: { model: null },
      }),
    ).toBeNull();
  });
});
