import { describe, it, expect, beforeEach, vi } from "vitest";

// ── A fire-and-forget refresher must NEVER fail an account load that already succeeded ────────────
//
// This file pins the DEAD-LOGIN direction: `../preflight` is mocked WITHOUT `checkClaudeAuthStatus`,
// so `refreshDeadLogins`'s default `{ probe: checkClaudeAuthStatus }` throws on access. Its SIBLING
// file (`accountSelection.loadResilience.liveUsage.test.ts`) pins the other direction and the
// per-kick sequencing property. Together they cover both refreshers.
//
// `loadAccountState` builds and caches its snapshot, then kicks two best-effort refreshers
// (`refreshLiveUsage`, `refreshDeadLogins`) whose `deps` defaults dereference module bindings
// SYNCHRONOUSLY at the call site. This reproduces the exact footgun that shipped an all-green build
// with a release-blocking failure: a caller (here, and originally `improvementPass.watchdog.test.ts`)
// mocks `../preflight` without `checkClaudeAuthStatus` after the dead-login probe was added, so that
// dereference throws.
//
// Before the fix the throw was caught by `loadAccountState`'s OUTER try and silently downgraded a
// perfectly good load to `failed: true`, which every consumer reads as "the accounts backend is
// broken" — so `chooseAccountForAgent` returns `chosen: null` and the hourly improvement pass (plus
// every pane / concierge spawn) loses its per-account `CLAUDE_CONFIG_DIR` and inherits the default
// `$HOME/.claude`. The refresher is best-effort by contract; it may not gate a load.
//
// The mock DELIBERATELY omits `checkClaudeAuthStatus` — do not "complete" it, or this test stops
// exercising the guard it exists to pin.

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("../preflight", () => ({
  // checkClaudeAuthStatus is INTENTIONALLY absent — accessing it throws (vitest mock proxy), which is
  // the synchronous call-site throw the guard must absorb. See the header above.
  claudeSessionAccounts: vi.fn(() => Promise.resolve([])),
  authIsDefinitelyExpired: vi.fn(() => false),
}));

import { loadAccountState, invalidateAccountState } from "./accountSelection";

const ACCOUNTS = [
  { id: "def", nickname: "Default", configDir: "/home/.claude", isDefault: true, createdAt: 1 },
  { id: "work", nickname: "Work", configDir: "/data/accounts/work", isDefault: false, createdAt: 2 },
];

describe("loadAccountState resilience — the dead-login probe kick throws synchronously", () => {
  beforeEach(() => {
    invoke.mockReset();
    invalidateAccountState();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
      if (cmd === "accounts_usage") return Promise.resolve([]);
      if (cmd === "accounts_identities") return Promise.resolve([]);
      if (cmd === "accounts_ceilings") return Promise.resolve([]);
      if (cmd === "account_usage_live") return Promise.reject(new Error("no token in tests"));
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });
  });

  it("returns the loaded snapshot, not a failed one, when the dead-login probe kick throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const state = await loadAccountState({ now: 1_000_000 });
      // The load SUCCEEDED — the refresher's synchronous throw was isolated. Without the guard this
      // reads `failed: true` with zero accounts (EMPTY), which is what stranded the binding at null.
      expect(state.failed).toBe(false);
      expect(state.accounts.map((a) => a.id)).toEqual(["def", "work"]);
      // The OTHER, healthy refresher still ran despite its sibling throwing — the live-usage kick
      // issues one `account_usage_live` per account. (This kick runs first here, so it also proves the
      // throw did not tear down the load mid-way.)
      expect(invoke.mock.calls.filter((c) => c[0] === "account_usage_live").length).toBe(ACCOUNTS.length);
      // The guard actually FIRED, and named the right refresher. This pins two things nothing else
      // does: (a) the `dead-login` label — swap it and this goes red; (b) that the throw was truly
      // SYNCHRONOUS and reached the guard. If the harness ever returned `undefined` for the missing
      // export instead of throwing, the TypeError would relocate inside the probe's own per-account
      // `.catch` and this assertion would fail loudly rather than passing vacuously with the guard gone.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("dead-login refresh kick threw"),
        expect.anything(),
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
