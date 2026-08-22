import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Per-kick isolation: a throw from the FIRST refresher must not skip the SECOND ─────────────────
//
// Sibling of `accountSelection.loadResilience.test.ts`. That file pins the dead-login direction; this
// one pins the LIVE-USAGE direction AND the sequencing property the two kicks must have.
//
// `loadAccountState` kicks `refreshLiveUsage` first, then `refreshDeadLogins`. Both evaluate their
// `deps` defaults SYNCHRONOUSLY at the call site. Here `./accountUsage` is mocked WITHOUT
// `getAccountUsageLive`, so `refreshLiveUsage`'s `{ fetch: getAccountUsageLive }` throws on access,
// while `../preflight` is REAL so `refreshDeadLogins` can run.
//
// The load-valid assertion alone would pass even if both kicks shared ONE try (the throw is still
// caught). What makes this test sequencing-sensitive is asserting the SECOND kick STILL RAN: with a
// single shared try, the first kick's throw jumps straight to `catch` and `refreshDeadLogins` is
// never invoked — so `claude_auth_status` is never issued and the dead-login probe silently stops
// refreshing forever. Each kick therefore needs its OWN guard.
//
// The mock DELIBERATELY omits `getAccountUsageLive` — do not "complete" it, or this test stops
// exercising the guard it exists to pin.

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("./accountUsage", () => ({
  // getAccountUsageLive is INTENTIONALLY absent — accessing it throws (vitest mock proxy), which is
  // the synchronous call-site throw from the FIRST refresher kick. The other two are provided so any
  // incidental importer in the graph is unaffected.
  summarizeMeter: vi.fn(() => ({})),
  scopedModelName: vi.fn(() => null),
}));

import { loadAccountState, invalidateAccountState } from "./accountSelection";

const ACCOUNTS = [
  { id: "def", nickname: "Default", configDir: "/home/.claude", isDefault: true, createdAt: 1 },
  { id: "work", nickname: "Work", configDir: "/data/accounts/work", isDefault: false, createdAt: 2 },
];

describe("loadAccountState resilience — the live-usage kick throws, the dead-login kick must still run", () => {
  beforeEach(() => {
    invoke.mockReset();
    invalidateAccountState();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
      if (cmd === "accounts_usage") return Promise.resolve([]);
      if (cmd === "accounts_identities") return Promise.resolve([]);
      if (cmd === "accounts_ceilings") return Promise.resolve([]);
      // The dead-login probe (real checkClaudeAuthStatus) issues this per account; a benign reply.
      if (cmd === "claude_auth_status")
        return Promise.resolve({
          loggedIn: true,
          source: "cli",
          email: "x@y.z",
          authMethod: null,
          subscriptionType: null,
        });
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });
  });

  it("keeps the load valid AND still runs the dead-login probe when the live-usage kick throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const state = await loadAccountState({ now: 2_000_000 });
      // Outer-try isolation: the first kick's synchronous throw did not fail the load.
      expect(state.failed).toBe(false);
      expect(state.accounts.map((a) => a.id)).toEqual(["def", "work"]);
      // Per-kick isolation (the sequencing property): the SECOND kick still ran despite the first
      // throwing, so the dead-login probe issued one `claude_auth_status` per account. Under a single
      // shared try this count is 0.
      expect(invoke.mock.calls.filter((c) => c[0] === "claude_auth_status").length).toBe(ACCOUNTS.length);
      // The guard actually FIRED, and named the FIRST refresher (`live-usage`). This pins the label
      // (swap it → red) and proves the throw was synchronous and reached the guard rather than being
      // absorbed later inside the fetch's own per-account `.catch` — otherwise this suite would pass
      // vacuously even with `kickBackgroundRefresh` deleted.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("live-usage refresh kick threw"),
        expect.anything(),
      );
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
