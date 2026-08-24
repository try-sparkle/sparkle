import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Mock the Tauri boundary the same way the rest of the desktop suite does.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (c: string, a: unknown) => invokeMock(c, a),
}));

import {
  getAccountUsageLive,
  getAccountUsageLiveForced,
  isUsageUnknownError,
  USAGE_UNKNOWN_PREFIX,
  KEYCHAIN_DENIED_PREFIX,
  KEYCHAIN_MAIN_THREAD_PREFIX,
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

  it("takes NO force argument — the quiet reader cannot be turned into the loud one", () => {
    // THE STRUCTURAL PIN. `force` used to be a boolean parameter, so every timer path on this screen
    // was one argument away from raising a macOS keychain prompt several times a minute, with nothing
    // but prose stopping it (sparkle-dkxuf6 / sparkle-oe9y1k). Splitting it into two exports makes
    // that unreachable rather than merely discouraged. Arity is the machine-checkable half of that
    // claim: `tsc` rejects a second argument at every call site, and this asserts the same fact at
    // runtime so the guarantee survives a stray `as any` too.
    //
    // NON-VACUOUS against the pair below: the forced reader is a DIFFERENT function, so this cannot
    // pass by there being no force path at all.
    expect(getAccountUsageLive.length).toBe(1);
    expect(getAccountUsageLiveForced.length).toBe(1);
    expect(getAccountUsageLiveForced).not.toBe(getAccountUsageLive);
  });

  it("propagates a rejection so the caller can fall back to the local estimate", async () => {
    invokeMock.mockRejectedValueOnce(new Error("no access token in stored credentials"));
    await expect(getAccountUsageLive("/some/config/dir")).rejects.toThrow(
      "no access token",
    );
  });
});

describe("getAccountUsageLiveForced", () => {
  beforeEach(() => invokeMock.mockReset());

  it("passes force=true so the Rust command re-reads credentials (the user-initiated path)", async () => {
    // The whole point of the interactive reader: an on-demand check must bypass the cached token and
    // re-read the account's credentials — keychain included — instead of serving a stale one. A macOS
    // prompt HERE is expected and wanted, because a click asked for it.
    //
    // PAIRED with the quiet-path assertion above, which pins `force: false` on the very same invoke
    // for the very same command. Neither test can pass by the wrapper hard-coding one value: a
    // wrapper stuck on false fails this, and one stuck on true fails that.
    invokeMock.mockResolvedValueOnce({
      fiveHourPercent: 1,
      fiveHourResetsAt: null,
      sevenDayPercent: 2,
      sevenDayResetsAt: null,
      limits: [],
    } satisfies AccountUsageLive);

    await getAccountUsageLiveForced("/some/config/dir");

    expect(invokeMock).toHaveBeenCalledWith("account_usage_live", {
      configDir: "/some/config/dir",
      force: true,
    });
  });
});

// ── "usage unknown" vs a GENUINE error ──────────────────────────────────────────────────────────
// The quiet path rejects with a stable `usage unknown: ` prefix when it has no usable cached token —
// the ordinary outcome for a healthy account whose OAuth token lapsed, since answering it would mean
// reading the keychain and a background poll must never do that. Misclassifying it as an error is
// what put "Check your connection or sign in again" in front of users with nothing wrong.
describe("isUsageUnknownError", () => {
  it("recognises the prefix on the three shapes a rejected Tauri invoke can hand back", () => {
    // Rust `Err(String)` reaches JS as a bare string; wrapped by some callers into an Error; and any
    // object carrying a string `message` must behave the same, or the classification would depend on
    // which layer re-threw.
    expect(isUsageUnknownError(`${USAGE_UNKNOWN_PREFIX}no cached token for /cfg/a`)).toBe(true);
    expect(isUsageUnknownError(new Error(`${USAGE_UNKNOWN_PREFIX}token expired`))).toBe(true);
    expect(isUsageUnknownError({ message: `${USAGE_UNKNOWN_PREFIX}token expired` })).toBe(true);
  });

  it("does NOT claim a genuine failure is merely unknown", () => {
    // The other half of the pair — without it, `() => true` would pass the test above. Each of these
    // is a real problem the user should hear about, and each must keep the error state.
    expect(isUsageUnknownError(new Error("error sending request: connection refused"))).toBe(false);
    expect(isUsageUnknownError("HTTP 401 from usage endpoint")).toBe(false);
    expect(isUsageUnknownError(new Error("failed to parse usage response"))).toBe(false);
    // …and the prefix has to be at the FRONT. A message that merely mentions the phrase is not the
    // command's structured signal, so a `includes()` implementation must fail here.
    expect(isUsageUnknownError(new Error("network down, so usage unknown: retry later"))).toBe(false);
    // Non-string / absent rejections classify as a genuine failure (fail toward telling the user).
    expect(isUsageUnknownError(undefined)).toBe(false);
    expect(isUsageUnknownError(null)).toBe(false);
    expect(isUsageUnknownError({ code: 500 })).toBe(false);
  });

  // ── THE INTERACTIVE PATH'S TWO OTHER NOT-AN-ERROR OUTCOMES ──────────────────────────────────
  // The quiet path can only ever reject with `usage unknown: `, which is why matching that alone
  // looked complete. It is not: a FORCED read has two further outcomes that are equally not the
  // user's problem, and both used to fall through to the amber "Check your connection or sign in
  // again" — advice that is wrong in both halves, shown to someone who had just answered a keychain
  // dialog. A remedy message is an instruction people follow, so this is a user-facing defect.
  it("treats a DECLINED keychain prompt as unknown, never as a broken connection", () => {
    expect(isUsageUnknownError(`${KEYCHAIN_DENIED_PREFIX}: user declined`)).toBe(true);
    expect(
      isUsageUnknownError(
        new Error(`${KEYCHAIN_DENIED_PREFIX}: a previous prompt was declined; suppressed until 12`),
      ),
    ).toBe(true);
    expect(isUsageUnknownError({ message: `${KEYCHAIN_DENIED_PREFIX}: -25308` })).toBe(true);
  });

  it("treats a main-thread REFUSAL as unknown — it is our bug report, not their account", () => {
    expect(isUsageUnknownError(`${KEYCHAIN_MAIN_THREAD_PREFIX}`)).toBe(true);
    expect(
      isUsageUnknownError(new Error(`${KEYCHAIN_MAIN_THREAD_PREFIX} (config /cfg/a)`)),
    ).toBe(true);
  });

  it("still requires these prefixes at the FRONT, like the first one", () => {
    // Pairs with the two above: without this they would also pass an `includes()` implementation,
    // which would start swallowing genuine errors that merely quote the phrase.
    expect(isUsageUnknownError(new Error(`http 500 — ${KEYCHAIN_DENIED_PREFIX}`))).toBe(false);
    expect(isUsageUnknownError(new Error(`panic: ${KEYCHAIN_MAIN_THREAD_PREFIX}`))).toBe(false);
  });
});

// ── CROSS-LANGUAGE DRIFT GUARD ────────────────────────────────────────────────────────────────
// These three literals are a contract with `src-tauri/src/account_usage.rs`, and the failure mode
// if they drift is SILENT: the Rust side keeps rejecting with a prefix this file no longer matches,
// every affected account flips back into the scary error state, and nothing throws. Nothing in the
// Rust suite can see this side, and nothing in this suite can see that side — so the only thing
// that can catch a reword is a test that reads both. Assert on the Rust source directly rather than
// on a copied fixture, because a fixture is one more thing that can drift.
describe("the keychain-outcome prefixes match the Rust constants that produce them", () => {
  const RUST = readFileSync(
    join(__dirname, "..", "..", "src-tauri", "src", "account_usage.rs"),
    "utf8",
  );

  it.each([
    ["USAGE_UNKNOWN_PREFIX", USAGE_UNKNOWN_PREFIX],
    ["KEYCHAIN_DENIED_PREFIX", KEYCHAIN_DENIED_PREFIX],
    ["KEYCHAIN_MAIN_THREAD_PREFIX", KEYCHAIN_MAIN_THREAD_PREFIX],
  ])("%s is spelled identically on both sides", (rustName, tsValue) => {
    const decl = new RegExp(`const ${rustName}: &str = "([^"]*)"`).exec(RUST);
    expect(
      decl,
      `${rustName} is gone from account_usage.rs — if it was renamed, rename it here too; if the ` +
        `outcome it named no longer exists, delete this row rather than leaving a dead contract`,
    ).not.toBeNull();
    expect(
      decl?.[1],
      `${rustName} was reworded in Rust but not here, so this outcome now falls through to the ` +
        `amber "Check your connection or sign in again" for every affected account, silently`,
    ).toBe(tsValue);
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
