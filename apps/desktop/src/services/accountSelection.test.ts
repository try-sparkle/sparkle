import { describe, it, expect, beforeEach, vi } from "vitest";

// Drive the accountStore IPC wrappers through a mocked tauri `invoke` so we can count calls and
// assert the TTL cache / de-dup behavior without a backend.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  loadAccountState,
  chooseAccountForAgent,
  invalidateAccountState,
  accountConfigDirFor,
  resetStickyAccounts,
  isStickyAccountKey,
  ACCOUNT_CACHE_TTL_MS,
  CONCIERGE_ACCOUNT_KEY,
} from "./accountSelection";
import { CONCIERGE_CALLER_AGENT_ID } from "./controlListener";
import { SPARKLE_AGENT_ID, sparkleAgentIdFor, isSparkleAgentId } from "./sparkleAgent";
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
    resetStickyAccounts();
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

  it("resolves a config dir for a consumer with no agent pane, honouring its pin", async () => {
    // The concierge and the hourly Improve Sparkle pass have no AgentTab, so they address the SAME
    // selection under a stable key. Auto-pick first — both accounts have zero usage here, so the
    // tie-break keeps input order and `def` wins.
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: 8_000_000 })).toBe("/home/.claude");
    // …then a pin on that key wins, which is what makes "pin the concierge to one account" work at
    // all — and is a real CHANGE from the line above, not a value auto-pick would have produced
    // anyway.
    setPin(CONCIERGE_ACCOUNT_KEY, "work");
    invalidateAccountState();
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: 8_000_001 })).toBe(
      "/data/accounts/work",
    );
  });

  it("reports the DEFAULT account's empty config dir as null, not an empty string", async () => {
    // The default account stores `configDir: ""` to mean "export no CLAUDE_CONFIG_DIR" (accounts.rs).
    // Passing that through as "" would make the Rust side set an EMPTY var, and Claude Code would
    // then resolve a relative `projects/` against the cwd instead of falling back to $HOME/.claude.
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "accounts_list")
        return Promise.resolve([
          { id: "def", nickname: "Default", configDir: "", isDefault: true, createdAt: 1 },
        ]);
      if (cmd === "accounts_usage") return Promise.resolve([]);
      if (cmd === "accounts_identities") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    invalidateAccountState();
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: 8_100_000 })).toBeNull();
  });

  // ── Stickiness ─────────────────────────────────────────────────────────────────────────────
  // `pickAccount` auto-picks the LOWEST 7-day usage, and that number moves continuously as build
  // agents run. For a pane that is fine — each agent picks once, at spawn. For the concierge it is
  // not: it resolves per TURN, so plain auto-pick would hand consecutive turns to different
  // accounts with no user action, and each flip silently restarts the conversation (the stored
  // session id lives in the previous account's tree). These pin the drift-resistance.

  /** Plant a specific usage table (the thing that drifts) behind the same two accounts. */
  function mockUsage(usage: Array<{ id: string; tokens5h: number; tokens7d: number; exhaustedUntil: number | null }>) {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
      if (cmd === "accounts_usage") return Promise.resolve(usage);
      if (cmd === "accounts_identities") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    invalidateAccountState();
  }

  it("keeps last call's account when USAGE drifts, instead of flipping mid-conversation", async () => {
    // `def` is the cheaper account, so it is chosen.
    mockUsage([
      { id: "def", tokens5h: 0, tokens7d: 10, exhaustedUntil: null },
      { id: "work", tokens5h: 0, tokens7d: 50, exhaustedUntil: null },
    ]);
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: 9_000_000 })).toBe("/home/.claude");

    // Build agents burn `def` past `work`. A plain re-pick would now return `work` — this is the
    // flip, and it is the ONLY thing this assertion can be measuring, since the same usage table
    // fed to a fresh key does return `work` (asserted below).
    mockUsage([
      { id: "def", tokens5h: 0, tokens7d: 900, exhaustedUntil: null },
      { id: "work", tokens5h: 0, tokens7d: 50, exhaustedUntil: null },
    ]);
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: 9_000_001 })).toBe("/home/.claude");

    // The control: nothing sticky about that table — a key with no history picks `work`.
    expect(await accountConfigDirFor("some-other-key", { now: 9_000_002 })).toBe("/data/accounts/work");
  });

  it("re-picks when the sticky account stops being a healthy choice", async () => {
    mockUsage([
      { id: "def", tokens5h: 0, tokens7d: 10, exhaustedUntil: null },
      { id: "work", tokens5h: 0, tokens7d: 50, exhaustedUntil: null },
    ]);
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: 9_100_000 })).toBe("/home/.claude");

    // `def` hits its limit. Stickiness must NOT hold us on a dead account — that would be the very
    // failure Phase 0 exists to end, reintroduced by the fix for the flipping.
    mockUsage([
      { id: "def", tokens5h: 0, tokens7d: 10, exhaustedUntil: 9_200_000 },
      { id: "work", tokens5h: 0, tokens7d: 50, exhaustedUntil: null },
    ]);
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: 9_100_001 })).toBe(
      "/data/accounts/work",
    );
  });

  it("lets an explicit pin override a sticky selection", async () => {
    mockUsage([
      { id: "def", tokens5h: 0, tokens7d: 10, exhaustedUntil: null },
      { id: "work", tokens5h: 0, tokens7d: 50, exhaustedUntil: null },
    ]);
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: 9_300_000 })).toBe("/home/.claude");

    // A pin is a deliberate human choice and outranks "what we settled on last time" — which is
    // also the seam Phase 2's rotation will use to move these consumers on purpose.
    setPin(CONCIERGE_ACCOUNT_KEY, "work");
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: 9_300_001 })).toBe(
      "/data/accounts/work",
    );
  });

  it("gives Improve Sparkle's TWO resolution paths the same account", async () => {
    // Improve Sparkle is reachable both ways for the SAME key: the interactive pane is an AgentPane
    // whose agent.id IS SPARKLE_AGENT_ID (→ chooseAccountForAgent), and the hourly headless pass
    // goes through accountConfigDirFor. They share one worktree, so if they disagree the pane's
    // resume probe reads the wrong tree and the shared conversation restarts.
    mockUsage([
      { id: "def", tokens5h: 0, tokens7d: 10, exhaustedUntil: null },
      { id: "work", tokens5h: 0, tokens7d: 50, exhaustedUntil: null },
    ]);
    const pass = await accountConfigDirFor(SPARKLE_AGENT_ID, { now: 9_400_000 });
    expect(pass).toBe("/home/.claude");

    // Usage drifts — enough that a NON-sticky path would now prefer `work` (proved by the control).
    mockUsage([
      { id: "def", tokens5h: 0, tokens7d: 900, exhaustedUntil: null },
      { id: "work", tokens5h: 0, tokens7d: 50, exhaustedUntil: null },
    ]);
    const pane = await chooseAccountForAgent(SPARKLE_AGENT_ID, { now: 9_400_001 });
    expect(pane.chosen?.configDir).toBe(pass);

    const control = await chooseAccountForAgent("ordinary-agent-id", { now: 9_400_002 });
    expect(control.chosen?.configDir).toBe("/data/accounts/work");
  });

  it("keeps the signed-in filter when a pin names an account that no longer exists", async () => {
    // sparkle-gms0, re-openable through the pinned branch. `pickAccount` honours a pin only if it
    // names an EXISTING account; a pin left behind by a deleted account falls through to auto-pick,
    // and without `signedInIds` a never-logged-in config dir wins on its zero usage and strands the
    // job at a login prompt. Nothing prunes pins when an account is removed, so this is reachable.
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "accounts_list")
        return Promise.resolve([
          { id: "signed-in", nickname: "Real", configDir: "/data/accounts/real", isDefault: false, createdAt: 1 },
          { id: "never-used", nickname: "Fresh dir", configDir: "/data/accounts/fresh", isDefault: false, createdAt: 2 },
        ]);
      // `never-used` looks the cheapest of all — it has no transcripts because nobody ever logged in.
      if (cmd === "accounts_usage")
        return Promise.resolve([{ id: "signed-in", tokens5h: 5, tokens7d: 5, exhaustedUntil: null }]);
      if (cmd === "accounts_identities")
        return Promise.resolve([{ id: "signed-in", email: "a@b.c", organization: null }]);
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    invalidateAccountState();
    setPin("agent-x", "deleted-account");
    const { chosen } = await chooseAccountForAgent("agent-x", { now: 9_500_000 });
    expect(chosen?.configDir).toBe("/data/accounts/real");
  });

  it("keeps a sticky key STICKY when its pin is stale", async () => {
    // A stale pin used to bypass stickiness entirely: the branch was chosen on the pin's mere
    // presence, but `pickAccount` ignores a `pinnedAccountId` that names no existing account and
    // falls through to plain lowest-usage auto-pick. So a sticky key silently stopped being sticky
    // — the divergence `isStickyAccountKey` exists to prevent, on the key it was written for.
    // Reachable: nothing prunes a pin when its account is removed.
    setPin(SPARKLE_AGENT_ID, "deleted-account");
    mockUsage([
      { id: "def", tokens5h: 0, tokens7d: 10, exhaustedUntil: null },
      { id: "work", tokens5h: 0, tokens7d: 50, exhaustedUntil: null },
    ]);
    expect(await accountConfigDirFor(SPARKLE_AGENT_ID, { now: 9_450_000 })).toBe("/home/.claude");

    // Usage drifts past the point where a non-sticky pick would switch (see the control below).
    mockUsage([
      { id: "def", tokens5h: 0, tokens7d: 900, exhaustedUntil: null },
      { id: "work", tokens5h: 0, tokens7d: 50, exhaustedUntil: null },
    ]);
    expect(await accountConfigDirFor(SPARKLE_AGENT_ID, { now: 9_450_001 })).toBe("/home/.claude");
    expect(await accountConfigDirFor("plain-agent", { now: 9_450_002 })).toBe("/data/accounts/work");
  });

  it("carries a key through a hiccup, and gives BOTH its callers the same answer", async () => {
    // The rule lives in the resolver, not in one caller. Improve Sparkle is reached by two callers
    // on one key — the headless pass (accountConfigDirFor) and its pane (chooseAccountForAgent) —
    // sharing ONE worktree, so a fallback implemented in only one of them means the other relocates
    // to the default tree during a hiccup and then cannot find the transcript the first just wrote.
    setPin(SPARKLE_AGENT_ID, "work");
    mockUsage([{ id: "work", tokens5h: 0, tokens7d: 1, exhaustedUntil: null }]);
    expect(await accountConfigDirFor(SPARKLE_AGENT_ID, { now: 9_800_000 })).toBe(
      "/data/accounts/work",
    );

    invoke.mockReset();
    invoke.mockRejectedValue(new Error("ipc down"));
    invalidateAccountState();
    // Both paths keep the account, rather than one silently falling to the default.
    expect(await accountConfigDirFor(SPARKLE_AGENT_ID, { now: 9_800_001 })).toBe(
      "/data/accounts/work",
    );
    const pane = await chooseAccountForAgent(SPARKLE_AGENT_ID, { now: 9_800_002 });
    expect(pane.chosen?.configDir).toBe("/data/accounts/work");

    // A key that never resolved has nothing to carry, so it still reports "unknown" rather than
    // inventing an account.
    expect(await accountConfigDirFor("never-resolved", { now: 9_800_003 })).toBeUndefined();
  });

  it("reports an unresolvable backend as undefined, distinct from the default account's null", async () => {
    // Both spawn identically (neither sets the variable), but a caller that ACTS on a change of
    // account must not read a transient IPC failure as "the user moved to the default account".
    invoke.mockReset();
    invoke.mockRejectedValue(new Error("ipc down"));
    invalidateAccountState();
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: 9_600_000 })).toBeUndefined();

    // A REAL empty account list is null, not undefined — "you have no accounts" is an answer.
    invoke.mockReset();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "accounts_list") return Promise.resolve([]);
      if (cmd === "accounts_usage") return Promise.resolve([]);
      if (cmd === "accounts_identities") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    invalidateAccountState();
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: 9_600_001 })).toBeNull();
  });

  it("treats a malformed (non-array) reply as a failure, not as an empty account list", async () => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined); // a bridge that resolves the wrong shape
    invalidateAccountState();
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: 9_700_000 })).toBeUndefined();
  });

  it("marks exactly the app-owned consumers as sticky", () => {
    expect(isStickyAccountKey(CONCIERGE_ACCOUNT_KEY)).toBe(true);
    expect(isStickyAccountKey(SPARKLE_AGENT_ID)).toBe(true);
    // Per-window Improve Sparkle ids share the namespace and must share the rule.
    expect(isStickyAccountKey(sparkleAgentIdFor("win-abc"))).toBe(true);
    // An ordinary agent id is NOT sticky: a pane resolves once at spawn, so re-picking costs it
    // nothing, and pinning every agent to its first account would quietly change build-agent
    // behaviour.
    expect(isStickyAccountKey("6f3aa7bc-85e9-4df8-8d45-2d6ed5f646d9")).toBe(false);
    // The namespace predicate must agree with sparkleAgent's own, which is what production uses to
    // recognise these ids everywhere else. Imported here (test-only) — a production import would be
    // a cycle, which is why the prefix is re-declared in accountSelection at all.
    for (const id of [SPARKLE_AGENT_ID, sparkleAgentIdFor("win-abc"), "not-sparkle"]) {
      expect(isStickyAccountKey(id)).toBe(isSparkleAgentId(id) || id === CONCIERGE_ACCOUNT_KEY);
    }
  });

  it("addresses the concierge by the same id every other surface uses", () => {
    // Re-declared rather than imported in production code (controlListener would be an import
    // cycle), so the two literals are pinned equal here instead. If they drift, the concierge's
    // account pin silently stops matching the identity it is known by everywhere else.
    expect(CONCIERGE_ACCOUNT_KEY).toBe(CONCIERGE_CALLER_AGENT_ID);
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
