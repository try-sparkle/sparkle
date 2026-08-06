import { describe, expect, it } from "vitest";

import { currentUsageLimit, oneshotAccountId, USAGE_LIMIT_RECHECK_MS } from "./usageLimit";
import type { Usage } from "../services/accountStore";

const T0 = 1_700_000_000_000;
const MINE = "mine";

function acct(id: string, exhaustedUntil: number | null): Usage {
  return { id, tokens5h: 0, tokens7d: 0, exhaustedUntil };
}

describe("currentUsageLimit", () => {
  it("reports the limit, with its real reset instant, while one is live", () => {
    const until = T0 + 60_000;
    expect(currentUsageLimit([acct(MINE, until)], MINE, T0)).toEqual({ accountId: MINE, until });
  });

  // THE SELF-CLEARING PROPERTY, reduced to arithmetic: the only thing that changes between these
  // assertions is the clock. No successful AI call, no reload, no dismissal.
  it("stops reporting once the reset instant passes, with no user action", () => {
    const until = T0 + 60_000;
    const usage = [acct(MINE, until)];
    expect(currentUsageLimit(usage, MINE, T0)).not.toBeNull();
    expect(currentUsageLimit(usage, MINE, until)).toBeNull();
    expect(currentUsageLimit(usage, MINE, until + 1)).toBeNull();
  });

  // Sparkle's one-shots keep the ambient CLAUDE_CONFIG_DIR and never rotate accounts — only AGENT
  // spawns do. So a free OTHER account does not mean AI works.
  it("still reports a limit when MY account is benched and another is free", () => {
    expect(currentUsageLimit([acct(MINE, T0 + 60_000), acct("other", null)], MINE, T0)).not.toBeNull();
  });

  it.each([
    ["no account could be determined", [acct(MINE, T0 + 60_000)], null],
    ["my account has no usage row", [acct("other", T0 + 60_000)], MINE],
    ["there are no accounts at all", [], MINE],
    ["my account is not benched", [acct(MINE, null), acct("other", T0 + 60_000)], MINE],
  ])("reports no positive evidence when %s", (_label, usage, id) => {
    // null means NO POSITIVE EVIDENCE, never "not limited" — the caller must not suppress on it.
    expect(currentUsageLimit(usage as Usage[], id, T0)).toBeNull();
  });

  it("does not mutate the caller's list", () => {
    const usage = [acct(MINE, T0 + 60_000), acct("other", T0 + 30_000)];
    const snapshot = JSON.stringify(usage);
    currentUsageLimit(usage, MINE, T0);
    expect(JSON.stringify(usage)).toBe(snapshot);
  });
});

describe("oneshotAccountId", () => {
  it.each([
    ["prefers the account flagged default", [{ id: "a", isDefault: false }, { id: "b", isDefault: true }], "b"],
    ["falls back to the only account", [{ id: "a", isDefault: false }], "a"],
    ["returns null when there are none", [], null],
  ])("%s", (_label, accounts, expected) => {
    expect(oneshotAccountId(accounts as { id: string; isDefault: boolean }[])).toBe(expected);
  });
});

describe("USAGE_LIMIT_RECHECK_MS", () => {
  it("is fine enough that a lifted limit retires promptly", () => {
    expect(USAGE_LIMIT_RECHECK_MS).toBeLessThanOrEqual(15_000);
    expect(USAGE_LIMIT_RECHECK_MS).toBeGreaterThan(0);
  });
});
