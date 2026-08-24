// ── THE QUIET-PATH PIN ──────────────────────────────────────────────────────────────────────────
//
// `account_usage_live` is the only thing in Sparkle that can raise the macOS
// 'Sparkle wants to access key "Claude Code-credentials-<hex>"' dialog — Sparkle reads that keychain
// item in-process, so macOS names Sparkle because Sparkle IS the caller. `refreshLiveUsage` is on a
// TIMER: `loadAccountState` kicks it, and three independent polls drive `loadAccountState` (the 10s
// provider-unavailable banner, the 60s limit sync, the 120s account switch). So anything this
// function can reach, it reaches several times a minute, forever — which is exactly how the founder
// came to be clicking "Always Allow" on a dialog that came straight back (sparkle-dkxuf6,
// sparkle-oe9y1k).
//
// The fix was structural: the force flag stopped being a boolean parameter and became a second
// export (`getAccountUsageLiveForced`), so no timer path can turn the quiet read into the loud one by
// flipping an argument. These tests hold that line by driving the REAL `refreshLiveUsage` with a spy
// dep and asserting on the ARGUMENTS it actually passed — not on a mock's configuration, which would
// only prove the mock was configured.
//
// THE PAIR for these lives in AccountsScreen.test.tsx ("Check usage levels" DOES call the
// interactive reader) and in accountUsage.test.ts (`force: false` here, `force: true` there). Absence
// on its own is ambiguous — it also passes for an app that never force-reads at all.
import { describe, it, expect, beforeEach, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { refreshLiveUsage, invalidateAccountState } from "./accountSelection";
import { getAccountUsageLive, type AccountUsageLive } from "./accountUsage";
import type { Account } from "./accountStore";

const ACCOUNTS: Account[] = [
  { id: "def", nickname: "Default", configDir: "/home/.claude", isDefault: true, createdAt: 1 },
  { id: "work", nickname: "Work", configDir: "/data/accounts/work", isDefault: false, createdAt: 2 },
];

function live(fiveHour: number): AccountUsageLive {
  return {
    fiveHourPercent: fiveHour,
    fiveHourResetsAt: null,
    sevenDayPercent: null,
    sevenDayResetsAt: null,
    limits: [],
  };
}

describe("refreshLiveUsage is structurally incapable of forcing a keychain read", () => {
  beforeEach(() => {
    invoke.mockReset();
    // Drop the module-level live cache AND the account cache, or a TTL hit from a previous test
    // would make the next `refreshLiveUsage` a no-op — and a no-op trivially "never forces".
    invalidateAccountState();
  });

  it("passes ONE argument (the config dir) to its fetch dep — never a force flag", async () => {
    // Drives the real function with a spy standing in for the dep, then reads back what the
    // production code handed it. The assertion is on `mock.calls`, so it can only pass if the real
    // call site really passed those arguments.
    const fetch = vi.fn(async (_configDir: string) => live(10));
    await refreshLiveUsage(ACCOUNTS, 1_000, { fetch });

    expect(fetch).toHaveBeenCalledTimes(ACCOUNTS.length);
    for (const call of fetch.mock.calls) {
      // Arity, not just "the second arg wasn't literally true": `[dir, false]` would also be wrong,
      // because the quiet reader takes no second parameter at all and a caller passing one has been
      // written against the OLD signature.
      expect(call).toHaveLength(1);
      expect(call[0]).toMatch(/^\//);
    }
    // Every account got exactly one read, and nothing was dropped — so the arity claim above is about
    // real work rather than an empty call list.
    expect(fetch.mock.calls.map((c) => c[0]).sort()).toEqual(
      ACCOUNTS.map((a) => a.configDir).sort(),
    );
  });

  it("its DEFAULT dep is the quiet reader, which invokes the Rust command with force:false", async () => {
    // The test above proves the CALL SITE is quiet; this proves the DEFAULT it calls is too. Both are
    // needed — a defaulted seam every test injects is covered by nothing (AGENTS.md), and this seam is
    // exactly that shape: delete `{ fetch: getAccountUsageLive }` and swap in the forced reader, and
    // the arity test above stays green while every poll starts prompting again.
    invoke.mockResolvedValue(live(20));
    await refreshLiveUsage(ACCOUNTS, 2_000); // no deps → the production default

    const usageCalls = invoke.mock.calls.filter((c) => c[0] === "account_usage_live");
    expect(usageCalls).toHaveLength(ACCOUNTS.length);
    for (const c of usageCalls) {
      expect(c[1]).toEqual({ configDir: expect.any(String), force: false });
    }
  });

  it("exposes the same quiet reader the rest of the app imports", () => {
    // Cheap identity check so a future refactor that clones the wrapper (and quietly adds a force
    // parameter back to the clone) does not slip past the two tests above.
    expect(getAccountUsageLive.length).toBe(1);
  });

  it("absorbs a `usage unknown: ` rejection into NO ROW rather than failing the batch", async () => {
    // After the Rust split, a healthy account whose cached OAuth token has lapsed rejects every quiet
    // read with `usage unknown: …` until the user checks it by hand. Selection must read that as "we
    // know nothing about this account", NOT as an error and NOT as zero usage — a zero would make the
    // lapsed account look like the emptiest one on the machine and route every spawn at it.
    //
    // NON-VACUOUS: the healthy account in the same batch DOES get a row, so a `refreshLiveUsage` that
    // dropped the whole batch on any rejection fails here.
    const fetch = vi.fn(async (configDir: string) => {
      if (configDir === "/home/.claude") throw new Error("usage unknown: no cached token");
      return live(33);
    });
    await refreshLiveUsage(ACCOUNTS, 3_000, { fetch });

    const { liveUsageRows } = await import("./accountSelection");
    expect(liveUsageRows().map((r) => r.id)).toEqual(["work"]);
    expect(liveUsageRows()[0]?.fiveHourPercent).toBe(33);
  });
});
