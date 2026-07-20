import { describe, it, expect, beforeEach, vi } from "vitest";

// Drive the accountStore IPC wrappers through a mocked tauri `invoke` so we can count calls and
// assert the TTL cache / de-dup behavior without a backend.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { loadAccountState, chooseAccountForAgent, invalidateAccountState, ACCOUNT_CACHE_TTL_MS } from "./accountSelection";
import { setPin, clearAllPins } from "./accountStore";

const ACCOUNTS = [
  { id: "def", nickname: "Default", configDir: "/home/.claude", isDefault: true, createdAt: 1 },
  { id: "work", nickname: "Work", configDir: "/data/accounts/work", isDefault: false, createdAt: 2 },
];

function mockBackend() {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
    if (cmd === "accounts_usage") return Promise.resolve([]); // no usage rows → all zero headroom
    if (cmd === "accounts_identities") return Promise.resolve([]); // no identities → nickname fallback
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  });
}

// listAccounts + getUsage + getIdentities fire together per (uncached) load.
const CALLS_PER_LOAD = 3;

describe("accountSelection cache", () => {
  beforeEach(() => {
    invoke.mockReset();
    invalidateAccountState();
    clearAllPins();
    mockBackend();
  });

  it("serves a cached snapshot within the TTL (one IPC pair for a burst)", async () => {
    const t0 = 1_000_000;
    await loadAccountState({ now: t0 });
    await loadAccountState({ now: t0 + 100 });
    await loadAccountState({ now: t0 + ACCOUNT_CACHE_TTL_MS - 1 });
    // One uncached load's worth of calls total — the later reads hit the cache.
    expect(invoke).toHaveBeenCalledTimes(CALLS_PER_LOAD);
  });

  it("re-fetches after the TTL expires", async () => {
    const t0 = 2_000_000;
    await loadAccountState({ now: t0 });
    await loadAccountState({ now: t0 + ACCOUNT_CACHE_TTL_MS + 1 });
    expect(invoke).toHaveBeenCalledTimes(CALLS_PER_LOAD * 2); // two loads
  });

  it("invalidateAccountState forces the next load to re-fetch", async () => {
    const t0 = 3_000_000;
    await loadAccountState({ now: t0 });
    invalidateAccountState();
    await loadAccountState({ now: t0 + 1 });
    expect(invoke).toHaveBeenCalledTimes(CALLS_PER_LOAD * 2);
  });

  it("de-dupes concurrent loads into a single IPC batch", async () => {
    const t0 = 4_000_000;
    await Promise.all([loadAccountState({ now: t0 }), loadAccountState({ now: t0 }), loadAccountState({ now: t0 })]);
    expect(invoke).toHaveBeenCalledTimes(CALLS_PER_LOAD);
  });

  it("chooseAccountForAgent auto-picks lowest-usage, and honors a manual pin", async () => {
    const t0 = 5_000_000;
    // No usage rows → tie at zero → first account (default) wins the stable reduce.
    const auto = await chooseAccountForAgent("agent-1", { now: t0 });
    expect(auto.chosen?.id).toBe("def");
    expect(auto.state.accounts).toHaveLength(2);

    // Pin overrides selection for that agent only.
    setPin("agent-1", "work");
    const pinned = await chooseAccountForAgent("agent-1", { now: t0 });
    expect(pinned.chosen?.id).toBe("work");
  });

  it("skips an account that is not signed in, even though it has the lowest usage (sparkle-gms0)", async () => {
    // "def" has zero usage (no rows) so it would win auto-pick, but it has no authenticated
    // identity — spawning under it drops the user at a login prompt. "work" is signed in and must
    // win despite carrying real usage. This is the restart symptom: every agent asked to log in.
    invoke.mockReset();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
      if (cmd === "accounts_usage")
        return Promise.resolve([{ id: "work", tokens5h: 10, tokens7d: 99_999, exhaustedUntil: null }]);
      if (cmd === "accounts_identities")
        return Promise.resolve([
          { id: "def", email: null, organization: null }, // config dir exists, never logged in
          { id: "work", email: "drodio@storytell.ai", organization: null },
        ]);
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });
    invalidateAccountState();

    const { chosen } = await chooseAccountForAgent("agent-2", { now: 6_000_000 });
    expect(chosen?.id).toBe("work");
  });

  it("an invalidate during an in-flight load discards that load's stale snapshot", async () => {
    // Deferred backend: the first load is in flight when we invalidate.
    let resolveList: (v: typeof ACCOUNTS) => void = () => {};
    invoke.mockReset();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "accounts_list") return new Promise((r) => (resolveList = r as typeof resolveList));
      if (cmd === "accounts_usage") return Promise.resolve([]);
      if (cmd === "accounts_identities") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });

    const t0 = 7_000_000;
    const inFlight = loadAccountState({ now: t0 }); // starts, awaits accounts_list
    invalidateAccountState(); // user changed accounts mid-load → bump generation
    resolveList(ACCOUNTS); // the stale load now resolves
    await inFlight;

    // The stale load must NOT have repopulated the cache: the next read re-fetches fresh data.
    mockBackend();
    await loadAccountState({ now: t0 + 1 });
    // Two accounts_list calls total: the stale (deferred) load's, plus the fresh load's. If the
    // stale load had repopulated the cache, the fresh read (1ms later, well within the 5s TTL)
    // would have been served from cache → only 1 list call. Seeing 2 proves the cache was empty.
    const listCalls = invoke.mock.calls.filter((c) => c[0] === "accounts_list").length;
    expect(listCalls).toBe(2);
  });

  it("falls back to empty state (default spawn behavior) when the backend errors", async () => {
    invoke.mockReset();
    invoke.mockRejectedValue(new Error("ipc down"));
    invalidateAccountState();
    const { chosen, state } = await chooseAccountForAgent("agent-x", { now: 6_000_000 });
    expect(chosen).toBeNull();
    expect(state.accounts).toEqual([]);
  });
});
