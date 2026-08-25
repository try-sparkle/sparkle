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
  conciergeFallbackConfigDirs,
  resetStickyAccounts,
  isStickyAccountKey,
  rotateStickyConsumerOffFailedAccount,
  rotateStickyConsumerOffSpentAccount,
  refreshLiveUsage,
  refreshDeadLogins,
  deadLoginIds,
  ACCOUNT_CACHE_TTL_MS,
  DEAD_LOGIN_TTL_MS,
  CONCIERGE_ACCOUNT_KEY,
} from "./accountSelection";
import type { ClaudeAuthStatus } from "../preflight";
import { CONCIERGE_CALLER_AGENT_ID } from "./controlListener";
import { SPARKLE_AGENT_ID, sparkleAgentIdFor, isSparkleAgentId } from "./sparkleAgent";
import { setPin, clearAllPins, setPreferredAccountId, clearPreferredAccount } from "./accountStore";
import { pauseRotation } from "./rotationState";

const ACCOUNTS = [
  { id: "def", nickname: "Default", configDir: "/home/.claude", isDefault: true, createdAt: 1 },
  { id: "work", nickname: "Work", configDir: "/data/accounts/work", isDefault: false, createdAt: 2 },
];

function mockBackend() {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
    if (cmd === "accounts_usage") return Promise.resolve([]); // no usage rows → all zero headroom
    if (cmd === "accounts_identities") return Promise.resolve([]); // no identities → nickname fallback
    if (cmd === "accounts_ceilings") return Promise.resolve([]); // nothing learned → lowest-usage rule
    // REAL Anthropic utilization, fetched per account on its OWN longer TTL and never awaited by a
    // load. Rejecting is a realistic answer here (no OAuth token in a test environment) and is the
    // path `refreshLiveUsage` absorbs per account, so selection degrades to the local tally.
    if (cmd === "account_usage_live") return Promise.reject(new Error("no token in tests"));
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  });
}

// listAccounts + getUsage + getIdentities + listCeilings fire together per (uncached) load.
const CALLS_PER_LOAD = 4;

/** The four commands that make up ONE account-snapshot load.
 *
 *  These suites are about the ACCOUNT cache's IPC economy, so they must count that cache's calls and
 *  nothing else. `account_usage_live` rides a separate cache with a much longer TTL and fires once
 *  per account, so folding it into a raw `invoke` count would make the assertions depend on how many
 *  accounts the fixture happens to have — and would go red for a background refresh that is working
 *  exactly as designed. */
const SNAPSHOT_COMMANDS = ["accounts_list", "accounts_usage", "accounts_identities", "accounts_ceilings"];
function snapshotCalls(): number {
  return invoke.mock.calls.filter((c) => SNAPSHOT_COMMANDS.includes(c[0] as string)).length;
}

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
    expect(snapshotCalls()).toBe(CALLS_PER_LOAD);
  });

  it("re-fetches after the TTL expires", async () => {
    const t0 = 2_000_000;
    await loadAccountState({ now: t0 });
    await loadAccountState({ now: t0 + ACCOUNT_CACHE_TTL_MS + 1 });
    expect(snapshotCalls()).toBe(CALLS_PER_LOAD * 2); // two loads
  });

  it("invalidateAccountState forces the next load to re-fetch", async () => {
    const t0 = 3_000_000;
    await loadAccountState({ now: t0 });
    invalidateAccountState();
    await loadAccountState({ now: t0 + 1 });
    expect(snapshotCalls()).toBe(CALLS_PER_LOAD * 2);
  });

  it("de-dupes concurrent loads into a single IPC batch", async () => {
    const t0 = 4_000_000;
    await Promise.all([loadAccountState({ now: t0 }), loadAccountState({ now: t0 }), loadAccountState({ now: t0 })]);
    expect(snapshotCalls()).toBe(CALLS_PER_LOAD);
  });

  // ── withIdentities: false — the poller's opt-out (sparkle-608gg) ──────────────────────────────
  // `accounts_identities` reads and JSON-parses every account's whole `.claude.json`. The
  // usage-limit banner polls every 10s against a 5s TTL, so no tick is ever cache-served and that
  // parse was being paid six times a minute for a field the banner never reads.

  it("skips the identities IPC entirely when the caller opts out", async () => {
    await loadAccountState({ now: 6_100_000, withIdentities: false });
    const commands = invoke.mock.calls.map((c) => c[0]);
    expect(commands).toContain("accounts_list");
    expect(commands).toContain("accounts_usage");
    // The whole point: the expensive leg is not merely ignored, it is never issued.
    expect(commands).not.toContain("accounts_identities");
  });

  it("does not let an identity-less load poison the shared cache", async () => {
    const t0 = 6_200_000;
    await loadAccountState({ now: t0, withIdentities: false });
    invoke.mockClear();
    // A full reader arriving inside the TTL must still get a real load, not the identity-less
    // snapshot — `identities: []` is indistinguishable from "nobody is signed in", and auto-pick
    // gates on it, so a poisoned cache would strand every spawn at a login prompt.
    const full = await loadAccountState({ now: t0 + 1 });
    expect(invoke.mock.calls.map((c) => c[0])).toContain("accounts_identities");
    expect(full.failed).toBe(false);
  });

  it("does not let an identity-less load satisfy a concurrent full reader", async () => {
    const t0 = 6_300_000;
    const [lean, full] = await Promise.all([
      loadAccountState({ now: t0, withIdentities: false }),
      loadAccountState({ now: t0 }),
    ]);
    // Two separate loads: the lean one never publishes itself as the in-flight load.
    expect(invoke.mock.calls.map((c) => c[0]).filter((c) => c === "accounts_identities")).toHaveLength(1);
    expect(lean.accounts).toHaveLength(ACCOUNTS.length);
    expect(full.accounts).toHaveLength(ACCOUNTS.length);
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

// ── The LEARNED-CEILING ESTIMATE NO LONGER DIVERTS SPAWNS ────────────────────────────────────────
//
// This used to be "proactive rotation": an account at >= CEILING_AVOID_FRACTION of its LEARNED
// ceiling was removed from auto-pick, so the next spawn skipped it BEFORE it hit the wall. The
// founder retired that estimate as a driver — it read "90% of its usual limit" on accounts whose
// REAL Anthropic numbers were clear, steering spawns off healthy accounts. So the estimate is now
// inert on the spawn path: selection ranks by raw/real usage, with the OBSERVED wall
// (`exhaustedUntil`) and the REAL live utilization (`PickOptions.live`) as the only exclusions.
//
// The fixture keeps its shape (`hot` is near its learned ceiling but has the LOWEST raw tally) so it
// can prove the estimate is ignored: `hot` now WINS despite sitting at 0.90 of its ceiling.
describe("the learned-ceiling estimate no longer diverts spawns", () => {
  // hot: 90/100 of its learned ceiling = 0.90, and the lowest raw tally.
  // cool: 200/1000 = 0.20 — more tokens, far more room.
  const ROT_ACCOUNTS = [
    { id: "hot", nickname: "Hot", configDir: "/data/accounts/hot", isDefault: true, createdAt: 1 },
    { id: "cool", nickname: "Cool", configDir: "/data/accounts/cool", isDefault: false, createdAt: 2 },
  ];
  const ROT_USAGE = [
    { id: "hot", tokens5h: 90, tokens7d: 90, exhaustedUntil: null },
    { id: "cool", tokens5h: 200, tokens7d: 200, exhaustedUntil: null },
  ];
  const ROT_CEILINGS = [
    { id: "hot", samples: [98, 100, 102], ceiling: 100 },
    { id: "cool", samples: [990, 1000, 1010], ceiling: 1000 },
  ];
  const ROT_IDENTITIES = [
    { id: "hot", email: "hot@example.com", organization: null, accountUuid: "uuid-hot" },
    { id: "cool", email: "cool@example.com", organization: null, accountUuid: "uuid-cool" },
  ];

  beforeEach(() => {
    invoke.mockReset();
    invalidateAccountState();
    resetStickyAccounts();
    clearAllPins();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "accounts_list") return Promise.resolve(ROT_ACCOUNTS);
      if (cmd === "accounts_usage") return Promise.resolve(ROT_USAGE);
      if (cmd === "accounts_identities") return Promise.resolve(ROT_IDENTITIES);
      if (cmd === "accounts_ceilings") return Promise.resolve(ROT_CEILINGS);
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });
  });

  it("sends the NEXT spawn to the lowest-usage account even at 0.90 of its learned ceiling", async () => {
    // `hot` is at 0.90 of its estimated ceiling — the OLD trigger to divert away from it. The
    // estimate no longer gates, so lowest raw usage wins and `hot` gets the agent. Re-add
    // `isNearLearnedCeiling` to `partitionAccounts` and this flips to `cool`.
    const dir = await accountConfigDirFor("agent-next", { now: 7_000_000 });
    expect(dir).toBe("/data/accounts/hot");
  });

  // REMOVED "does NOT move a STICKY key off its account on the ESTIMATE alone". With the learned-
  // ceiling gate gone from EVERY path, no code can move a sticky key on the estimate, so that test
  // was vacuous — deleting the whole `if (previousId) { keep }` block left all three legs green
  // (`hot` is the plain lowest-usage winner, and `pickAccount` evicts an OBSERVED-exhausted account
  // on its own, so even the "observed wall moves it" leg did not exercise the keep block). The keep
  // path — a sticky key retained on an account that is no longer the lowest-usage pick — is covered
  // non-vacuously by the usage-drift test earlier in this suite. (roborev review 64135, F3.)

  it("does NOT apply the ceiling estimate to a sticky key's FIRST pick either — lowest usage wins", async () => {
    // The estimate used to inform a fresh sticky selection (settle the concierge onto the account
    // with the most estimated room). It no longer does: `hot` is at 0.90 of its ceiling but is the
    // lowest raw tally, so a first-time sticky pick lands on it just like an ordinary spawn.
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: 7_500_000 })).toBe(
      "/data/accounts/hot",
    );
  });

  it("picks the same account whether or not learned ceilings are supplied — the estimate is inert", async () => {
    // With the ceilings withheld, `hot` (the lower raw tally) wins. The test above shows it wins WITH
    // the ceilings too, which is the whole point: the learned ceiling changes nothing on the spawn
    // path any more.
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "accounts_list") return Promise.resolve(ROT_ACCOUNTS);
      if (cmd === "accounts_usage") return Promise.resolve(ROT_USAGE);
      if (cmd === "accounts_identities") return Promise.resolve(ROT_IDENTITIES);
      if (cmd === "accounts_ceilings") return Promise.resolve([]); // no learned ceilings yet
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });
    const dir = await accountConfigDirFor("agent-next", { now: 7_100_000 });
    expect(dir).toBe("/data/accounts/hot");
  });
});

// ── TRANSCRIPT AFFINITY ──────────────────────────────────────────────────────────────────────
//
// A `claude` conversation lives under the CLAUDE_CONFIG_DIR it ran with, so choosing an account
// chooses which history the agent can see. These pin the rule that a relaunch must not re-pick its
// way out of its own conversation.
//
// The defect these were written against, measured on one agent: it spawned under account A and took
// its opening brief; an app restart's resurrection sweep remounted it two hours later;
// `chooseAccountForAgent` re-picked by lowest usage and returned B; the resume probe correctly found
// no session under B; claude launched fresh and empty while the agent's hour of work sat intact
// under A. The UI still rendered the row, the header and the brief — so it read as "build agents are
// being created with no task", and nothing pointed at the account.
describe("transcript affinity", () => {
  // `hist` deliberately carries the HIGHER usage tally, so plain lowest-usage picks `fresh`. Without
  // that the suite would pass with the affinity rule deleted.
  const AFF_ACCOUNTS = [
    { id: "fresh", nickname: "Fresh", configDir: "/data/accounts/fresh", isDefault: false, createdAt: 1 },
    { id: "hist", nickname: "Historied", configDir: "/data/accounts/hist", isDefault: false, createdAt: 2 },
  ];
  const AFF_USAGE: Array<{
    id: string;
    tokens5h: number;
    tokens7d: number;
    exhaustedUntil: number | null;
  }> = [
    { id: "fresh", tokens5h: 0, tokens7d: 0, exhaustedUntil: null },
    { id: "hist", tokens5h: 900_000, tokens7d: 900_000, exhaustedUntil: null },
  ];
  const AFF_IDENTITIES = [
    { id: "fresh", email: "a@x.com", organization: null, accountUuid: "u-fresh" },
    { id: "hist", email: "b@x.com", organization: null, accountUuid: "u-hist" },
  ];
  const WT = "/worktrees/proj/agent-1";

  function mockAffBackend(usage = AFF_USAGE) {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "accounts_list") return Promise.resolve(AFF_ACCOUNTS);
      if (cmd === "accounts_usage") return Promise.resolve(usage);
      if (cmd === "accounts_identities") return Promise.resolve(AFF_IDENTITIES);
      if (cmd === "accounts_ceilings") return Promise.resolve([]);
      if (cmd === "account_usage_live") return Promise.reject(new Error("no token in tests"));
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });
  }

  beforeEach(() => {
    invoke.mockReset();
    invalidateAccountState();
    resetStickyAccounts();
    clearAllPins();
    mockAffBackend();
  });

  it("would pick the OTHER account on usage alone — the premise these tests rest on", async () => {
    // The positive control. If `fresh` ever stops winning here for an unrelated reason, the two
    // tests below stop proving anything and this one says so.
    const { chosen } = await chooseAccountForAgent("agent-1", { now: 1_000 });
    expect(chosen?.id).toBe("fresh");
  });

  it("resumes under the account that HOLDS the conversation, not the emptier one", async () => {
    const { chosen } = await chooseAccountForAgent("agent-1", {
      now: 1_000,
      worktreePath: WT,
      // The probe answers with CONFIG DIRS, newest transcript first — the shape
      // `preflight.claudeSessionAccounts` returns.
      sessionAccounts: async () => ["/data/accounts/hist"],
    });
    expect(chosen?.id).toBe("hist");
  });

  it("drives the REAL probe when no `sessionAccounts` is injected — the production seam, exercised", async () => {
    // roborev finding (the `sparkle-lgbwf` shape). Every other test here injects `sessionAccounts`,
    // and `AgentPane` — the one caller that does not — is covered by nothing. So the default arm
    // `opts.sessionAccounts ?? claudeSessionAccounts` and `preflight.claudeSessionAccounts`'s
    // `invoke("claude_session_accounts", { worktreePath, configDirs })` were untested by
    // construction: delete the fallback, misspell an argument key, or drop the `lib.rs`
    // registration, and the whole suite still passed. The failure is silent by design — a rejected
    // invoke is caught and downgraded to a `console.warn`, and selection falls back to
    // lowest-usage, i.e. THIS BUG, permanently, with green tests.
    //
    // So this test injects nothing and answers the command from the `invoke` mock instead, which is
    // the real IPC boundary. It asserts the command NAME and the ARGUMENT SHAPE (a misnamed key
    // would reach the backend as undefined and probe the wrong thing), then that `hist` wins.
    const inner = invoke.getMockImplementation()!;
    invoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "claude_session_accounts") {
        expect(args).toEqual({ worktreePath: WT, configDirs: ["/data/accounts/fresh", "/data/accounts/hist"] });
        return Promise.resolve(["/data/accounts/hist"]);
      }
      return inner(cmd, args);
    });
    const { chosen } = await chooseAccountForAgent("agent-1", { now: 1_000, worktreePath: WT });
    expect(chosen?.id).toBe("hist");
    expect(invoke.mock.calls.some((c) => c[0] === "claude_session_accounts")).toBe(true);
  });

  it("still lets a human PIN override the account holding the conversation", async () => {
    // Affinity is a default, not a veto: a pin is someone deciding on purpose, and it outranks this
    // the same way it outranks every other judgement here.
    setPin("agent-1", "fresh");
    const { chosen } = await chooseAccountForAgent("agent-1", {
      now: 1_000,
      worktreePath: WT,
      sessionAccounts: async () => ["/data/accounts/hist"],
    });
    expect(chosen?.id).toBe("fresh");
  });

  it("warns even under a PIN — the human choice stands, the silent context loss does not", async () => {
    // roborev finding: the warning used to live inside the affinity helper, which is skipped
    // entirely when a pin or the fleet preference already answered. That made the LARGEST instance
    // of this failure the one nothing reported — activating an account fleet-wide moves every agent
    // off its own conversation at once. The pin still wins; it just no longer wins quietly.
    setPin("agent-1", "fresh");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { chosen } = await chooseAccountForAgent("agent-1", {
      now: 1_000,
      worktreePath: WT,
      sessionAccounts: async () => ["/data/accounts/hist"],
    });
    expect(chosen?.id).toBe("fresh");
    expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).toContain("FRESH session");
    warn.mockRestore();
  });

  it("does NOT warn when the account it settled on is the one holding the conversation", async () => {
    // The negative half. Without it the test above passes against a warning that fires every spawn,
    // which would be noise indistinguishable from the signal.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { chosen } = await chooseAccountForAgent("agent-1", {
      now: 1_000,
      worktreePath: WT,
      sessionAccounts: async () => ["/data/accounts/hist"],
    });
    expect(chosen?.id).toBe("hist");
    expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).not.toContain("FRESH session");
    warn.mockRestore();
  });

  it("records a STICKY key's affinity answer, so the headless caller cannot diverge from the pane", async () => {
    // roborev finding, and the sharpest of the three. `autoPick` is the only writer of
    // `stickySelections`, and affinity bypasses it. Improve Sparkle is resolved by BOTH an
    // AgentPane (which now names a worktree, so affinity can answer) and the headless hourly pass
    // (which names none, so it cannot) — for ONE SHARED WORKTREE. With the slot left unwritten the
    // pass auto-picks fresh and the two land on different accounts, which is the precise failure
    // `isStickyAccountKey` exists to prevent.
    const pane = await chooseAccountForAgent(SPARKLE_AGENT_ID, {
      now: 1_000,
      worktreePath: WT,
      sessionAccounts: async () => ["/data/accounts/hist"],
    });
    expect(pane.chosen?.id).toBe("hist");
    // The headless caller names no worktree, so affinity cannot answer for it. It must still land on
    // `hist` — via the sticky slot the pane just wrote — rather than on the emptier `fresh`.
    const headless = await chooseAccountForAgent(SPARKLE_AGENT_ID, { now: 1_100 });
    expect(headless.chosen?.id).toBe("hist");
  });

  it("does not let two accounts sharing one config dir collapse onto the first", async () => {
    // roborev finding. A login registered twice yields two accounts with one config dir. The probe
    // answers per DIRECTORY, so `find` would return whichever account was listed first — hiding a
    // usable duplicate behind an exhausted one.
    const DUP_ACCOUNTS = [
      { id: "dup-a", nickname: "A", configDir: "/data/accounts/hist", isDefault: false, createdAt: 1 },
      { id: "dup-b", nickname: "B", configDir: "/data/accounts/hist", isDefault: false, createdAt: 2 },
      { id: "fresh", nickname: "Fresh", configDir: "/data/accounts/fresh", isDefault: false, createdAt: 3 },
    ];
    const probe = vi.fn(async () => ["/data/accounts/hist"]);
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "accounts_list") return Promise.resolve(DUP_ACCOUNTS);
      if (cmd === "accounts_usage")
        // The FIRST duplicate is exhausted; the second is fine. Collapsing onto the first would skip
        // both and lose the conversation for no reason.
        //
        // `dup-b` also carries the HIGHEST tally, which is what makes this test non-vacuous: with a
        // flat tally the auto-pick fallback lands on `dup-b` by accident, so the assertion held even
        // with the collapse restored (measured — the mutation passed). Now lowest-usage would answer
        // `fresh`, so only affinity reaching THROUGH the exhausted duplicate can produce `dup-b`.
        return Promise.resolve([
          { id: "dup-a", tokens5h: 0, tokens7d: 0, exhaustedUntil: 9_000_000 },
          { id: "dup-b", tokens5h: 900_000, tokens7d: 900_000, exhaustedUntil: null },
          { id: "fresh", tokens5h: 0, tokens7d: 0, exhaustedUntil: null },
        ]);
      if (cmd === "accounts_identities")
        return Promise.resolve([
          { id: "dup-a", email: "a@x.com", organization: null, accountUuid: "u" },
          { id: "dup-b", email: "a@x.com", organization: null, accountUuid: "u" },
          { id: "fresh", email: "f@x.com", organization: null, accountUuid: "u2" },
        ]);
      if (cmd === "accounts_ceilings") return Promise.resolve([]);
      if (cmd === "account_usage_live") return Promise.reject(new Error("no token in tests"));
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });
    const { chosen } = await chooseAccountForAgent("agent-dup", {
      now: 1_000,
      worktreePath: WT,
      sessionAccounts: probe,
    });
    expect(chosen?.id).toBe("dup-b");
    // And the shared dir is sent ONCE — a duplicate would make one conversation look like two.
    expect(probe).toHaveBeenCalledWith(WT, ["/data/accounts/hist", "/data/accounts/fresh"]);
  });

  it("refuses to park the agent on an EXHAUSTED holder, and says the context will be lost", async () => {
    // The unavoidable case — the measured agent's own account was rate-limiting when it moved. There
    // is no selection that keeps the conversation here, so what matters is that the loss is REPORTED
    // rather than silent: the silence is what made this present as a spawn bug for a day.
    mockAffBackend([
      { id: "fresh", tokens5h: 0, tokens7d: 0, exhaustedUntil: null },
      { id: "hist", tokens5h: 900_000, tokens7d: 900_000, exhaustedUntil: 9_000_000 },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { chosen } = await chooseAccountForAgent("agent-1", {
      now: 1_000,
      worktreePath: WT,
      sessionAccounts: async () => ["/data/accounts/hist"],
    });
    expect(chosen?.id).toBe("fresh");
    expect(warn).toHaveBeenCalled();
    const said = warn.mock.calls.map((c) => String(c[0])).join(" ");
    expect(said).toContain("FRESH session");
    warn.mockRestore();
  });

  it("selects on usage alone when no account holds a conversation, and never probes without a worktree", async () => {
    // A fresh worktree has nothing to be loyal to, and a caller with no path to give (the concierge,
    // the hourly pass) must behave exactly as it did before this rule existed.
    const probe = vi.fn(async () => []);
    const fresh = await chooseAccountForAgent("agent-1", {
      now: 1_000,
      worktreePath: WT,
      sessionAccounts: probe,
    });
    expect(fresh.chosen?.id).toBe("fresh");
    expect(probe).toHaveBeenCalledTimes(1);

    probe.mockClear();
    const noPath = await chooseAccountForAgent("agent-2", { now: 1_000, sessionAccounts: probe });
    expect(noPath.chosen?.id).toBe("fresh");
    expect(probe).not.toHaveBeenCalled();
  });

  it("passes EVERY account's config dir to the probe, so no account can be invisible to it", async () => {
    // The probe can only report a holder it was asked about. Handing it a filtered list would make
    // affinity silently miss exactly the account an agent had moved off.
    const probe = vi.fn(async () => []);
    await chooseAccountForAgent("agent-1", { now: 1_000, worktreePath: WT, sessionAccounts: probe });
    expect(probe).toHaveBeenCalledWith(WT, ["/data/accounts/fresh", "/data/accounts/hist"]);
  });

  // ── LIVE-SPENT holder (sparkle-m1bjo1 in the override path) ─────────────────────────────────
  //
  // Auto-pick already excludes an account Anthropic reports at ≥ LIVE_AVOID_PERCENT (partitionAccounts
  // `isLiveSpent`). Transcript affinity used to check ONLY the observed wall (`exhaustedUntil`), so it
  // could resume a spawn under a holder at 99% of its real weekly limit — the exact account a fresh
  // pick would refuse — landing the agent ~1% from a wall it would hit within the session and then
  // move accounts mid-task (a proactive move has no stale-resume retry, by design). These tests pin
  // that `firstUsableHolder` now applies the SAME live-spent gate, and — the load-bearing negative —
  // that it never does so at the cost of breaking a spawn or over-skipping a usable holder.
  //
  // Live rows are seeded through the exported `refreshLiveUsage` with an injected `fetch`, because the
  // production refresh is fire-and-forget and its rows land only for the NEXT pick. Seeding at the
  // same `now` the pick uses keeps the row inside LIVE_USAGE_TTL_MS, so the load's own (rejected)
  // background refresh no-ops instead of clobbering it.

  /** Percentages by config dir → the shape `getAccountUsageLive` resolves. */
  function seedLive(
    accounts: typeof AFF_ACCOUNTS,
    byDir: Record<string, { five: number | null; seven: number | null }>,
    now: number,
  ): Promise<void> {
    return refreshLiveUsage(accounts, now, {
      fetch: async (configDir: string) => {
        const p = byDir[configDir];
        if (!p) throw new Error(`no live row for ${configDir}`);
        // `refreshLiveUsage` reads only the two percents; the rest of `AccountUsageLive` is filled to
        // satisfy the type (the production seam returns the whole shape).
        return {
          fiveHourPercent: p.five,
          sevenDayPercent: p.seven,
          fiveHourResetsAt: null,
          sevenDayResetsAt: null,
          limits: [],
        };
      },
    });
  }

  it("refuses to resume under a LIVE-SPENT holder when a healthy account exists, and says the context will be lost", async () => {
    // The holder `hist` is at 99% of its REAL Anthropic weekly limit — not yet walled, so the old
    // observed-wall-only gate would have parked the agent there. `fresh` is healthy. Non-vacuous:
    // drop the `isAccountLiveSpent` clause from `firstUsableHolder` and `hist` is chosen, so this
    // assertion goes red — the mutation is caught.
    await seedLive(AFF_ACCOUNTS, {
      "/data/accounts/hist": { five: 99, seven: null },
      "/data/accounts/fresh": { five: 5, seven: 5 },
    }, 1_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { chosen } = await chooseAccountForAgent("agent-1", {
      now: 1_000,
      worktreePath: WT,
      sessionAccounts: async () => ["/data/accounts/hist"],
    });
    expect(chosen?.id).toBe("fresh");
    expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).toContain("FRESH session");
    warn.mockRestore();
  });

  it("STILL resumes under a live-spent holder when it is the ONLY account — continuity kept, spawn never blocked", async () => {
    // The paired safety negative. Skipping the holder must only ever fall THROUGH to auto-pick, whose
    // all-excluded fallback (`leastBad`) returns the sole account anyway. So a single spent holder is
    // still resumed under — no spawn is broken, and because the account it settled on IS the holder,
    // there is no lost-context warning. Without this, a fail-closed reading of the gate above could
    // strand the one account that exists.
    const ONE = [
      { id: "solo", nickname: "Solo", configDir: "/data/accounts/solo", isDefault: false, createdAt: 1 },
    ];
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "accounts_list") return Promise.resolve(ONE);
      if (cmd === "accounts_usage")
        return Promise.resolve([{ id: "solo", tokens5h: 0, tokens7d: 0, exhaustedUntil: null }]);
      if (cmd === "accounts_identities")
        return Promise.resolve([{ id: "solo", email: "s@x.com", organization: null, accountUuid: "u-solo" }]);
      if (cmd === "accounts_ceilings") return Promise.resolve([]);
      if (cmd === "account_usage_live") return Promise.reject(new Error("no token in tests"));
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });
    await refreshLiveUsage(ONE, 1_000, {
      fetch: async () => ({
        fiveHourPercent: 99,
        sevenDayPercent: null,
        fiveHourResetsAt: null,
        sevenDayResetsAt: null,
        limits: [],
      }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { chosen } = await chooseAccountForAgent("agent-solo", {
      now: 1_000,
      worktreePath: WT,
      sessionAccounts: async () => ["/data/accounts/solo"],
    });
    expect(chosen?.id).toBe("solo");
    expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).not.toContain("FRESH session");
    warn.mockRestore();
  });

  it("STILL resumes under the holder when its live usage is present but BELOW the avoid threshold", async () => {
    // The other half of the pair: the new gate must not over-trigger. With live data present but the
    // holder at a merely-busy 50%, affinity still wins — proving the change excludes on the ≥ LIVE_AVOID_PERCENT
    // FACT, not on the presence of any live row. Non-vacuous against negating the clause: flip
    // `!isAccountLiveSpent` and this usable holder is skipped, `fresh` is chosen, and this reds.
    await seedLive(AFF_ACCOUNTS, {
      "/data/accounts/hist": { five: 50, seven: 20 },
      "/data/accounts/fresh": { five: 5, seven: 5 },
    }, 1_000);
    const { chosen } = await chooseAccountForAgent("agent-1", {
      now: 1_000,
      worktreePath: WT,
      sessionAccounts: async () => ["/data/accounts/hist"],
    });
    expect(chosen?.id).toBe("hist");
  });
});

// ── Reactive rotation off a dead account (bead sparkle-08mq3t) ──────────────────────────────────
// The concierge is a STICKY consumer, and `autoPick`'s eviction is blind to an OAuth expiry: the
// account keeps reading "signed in" in recorded state, so nothing moves the concierge off it and
// every turn fails identically. `rotateStickyConsumerOffFailedAccount` drives the move from the
// turn-failure signal instead. These assert the SIDE EFFECT — the dead account is benched and the
// resolution lands on the healthy one — with paired negatives so a ranker that always returns `work`
// cannot pass.
describe("reactive rotation off a failed concierge account", () => {
  // Two SIGNED-IN accounts, distinct logins (so neither is the other's sibling). `def` is the
  // cheaper account, so a first resolve parks the concierge there.
  const TWO = [
    { id: "def", nickname: "Personal", configDir: "/home/.claude", isDefault: true, createdAt: 1 },
    { id: "work", nickname: "Work", configDir: "/data/accounts/work", isDefault: false, createdAt: 2 },
  ];

  // Stateful backend: `accounts_mark_exhausted` records a bench (epoch SECONDS, Rust's unit) that
  // `accounts_usage` then reflects, exactly as the real boundary does. Without this the re-resolve
  // could not observe the bench the rotation just wrote — the test would be vacuous.
  let exhausted: Record<string, number | null>;
  function mockFleet(signedIn: string[] = ["def", "work"]) {
    exhausted = {};
    invoke.mockImplementation((cmd: string, args?: { id: string; untilEpoch: number }) => {
      if (cmd === "accounts_list") return Promise.resolve(TWO);
      if (cmd === "accounts_usage")
        return Promise.resolve([
          { id: "def", tokens5h: 0, tokens7d: 10, exhaustedUntil: exhausted["def"] ?? null },
          { id: "work", tokens5h: 0, tokens7d: 50, exhaustedUntil: exhausted["work"] ?? null },
        ]);
      if (cmd === "accounts_identities")
        return Promise.resolve(
          signedIn.map((id) => ({ id, email: `${id}@example.com`, organization: null })),
        );
      if (cmd === "accounts_ceilings") return Promise.resolve([]);
      if (cmd === "account_usage_live") return Promise.reject(new Error("no token in tests"));
      if (cmd === "accounts_mark_exhausted") {
        // markExhausted already converted ms → seconds; store it verbatim so accounts_usage → getUsage
        // (× 1000) round-trips back to ~the same ms instant.
        exhausted[args!.id] = args!.untilEpoch;
        return Promise.resolve();
      }
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    invalidateAccountState();
  }

  function markExhaustedIds(): string[] {
    return invoke.mock.calls
      .filter((c) => c[0] === "accounts_mark_exhausted")
      .map((c) => (c[1] as { id: string }).id);
  }

  beforeEach(() => {
    invoke.mockReset();
    invalidateAccountState();
    resetStickyAccounts();
    clearAllPins();
  });

  it("rotates the concierge to a HEALTHY account when its own account's auth fails", async () => {
    mockFleet();
    const t = 20_000_000;
    // Parked on `def`.
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t })).toBe("/home/.claude");

    // THE TRAP, proven: `def`'s OAuth has died but recorded state cannot see it — it still reads
    // signed-in and unexhausted — so a plain re-resolve STAYS on the dead account. This is the bug.
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t + 1 })).toBe("/home/.claude");

    // The failure signal drives the rotation.
    const result = await rotateStickyConsumerOffFailedAccount(CONCIERGE_ACCOUNT_KEY, "auth", {
      now: t + 2,
    });

    // SIDE EFFECT 1: the dead account (and only it — `work` is a different login) was benched.
    expect(markExhaustedIds()).toEqual(["def"]);
    // SIDE EFFECT 2: resolution moved to the healthy account, and the sticky pointer with it.
    expect(result.rotated).toBe(true);
    expect(result.from).toBe("def");
    expect(result.to).toBe("work");
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t + 3 })).toBe(
      "/data/accounts/work",
    );
  });

  it("does NOT rotate — or bench anything — for an unclassified (unknown) failure", async () => {
    mockFleet();
    const t = 21_000_000;
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t })).toBe("/home/.claude");

    const result = await rotateStickyConsumerOffFailedAccount(CONCIERGE_ACCOUNT_KEY, "unknown", {
      now: t + 1,
    });

    expect(result).toEqual({ rotated: false, reason: "not-unusable" });
    expect(markExhaustedIds()).toEqual([]);
    // Still on `def`: a transient failure must not churn a healthy account.
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t + 2 })).toBe("/home/.claude");
  });

  it("does NOT rotate when every OTHER account is unusable — leaving the sign-in dead-end intact", async () => {
    // Only `def` is signed in; `work` is a config dir nobody logged into, so it is not a healthy
    // alternative. Benching `def` would strand the concierge with no account at all.
    mockFleet(["def"]);
    const t = 22_000_000;
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t })).toBe("/home/.claude");

    const result = await rotateStickyConsumerOffFailedAccount(CONCIERGE_ACCOUNT_KEY, "auth", {
      now: t + 1,
    });

    expect(result.rotated).toBe(false);
    expect(result.reason).toBe("no-healthy-alternative");
    // Critically: the last usable account was NOT benched — the next turn still resolves to it and
    // fails into the existing sign-in path rather than a null-account spawn.
    expect(markExhaustedIds()).toEqual([]);
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t + 2 })).toBe("/home/.claude");
  });

  it("respects a human pin (Manual Override) and does not rotate", async () => {
    mockFleet();
    const t = 23_000_000;
    setPin(CONCIERGE_ACCOUNT_KEY, "def");
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t })).toBe("/home/.claude");

    const result = await rotateStickyConsumerOffFailedAccount(CONCIERGE_ACCOUNT_KEY, "auth", {
      now: t + 1,
    });

    expect(result).toEqual({ rotated: false, reason: "pinned" });
    expect(markExhaustedIds()).toEqual([]);
    // The pin still wins on the next resolve.
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t + 2 })).toBe("/home/.claude");
  });

  it("does NOT re-resolve onto a DEAD-LOGIN account even when it is cheaper (the third invalidation site)", async () => {
    // roborev 67736 / sparkle-50m03: rotateStickyConsumerOffFailedAccount is the third non-credential
    // caller converted to invalidateAccountState({ credentials: false }), and it reads the dead-login
    // verdict one line later (via chooseAccountForAgent). If that call wiped the verdict, the concierge
    // would re-resolve onto a cheaper DEAD-LOGIN account. `dead` is cheaper than `alt` but expired, so
    // the rotation must land on `alt`. Revert :1232 to invalidateAccountState() and this reds (→ dead).
    const t = 24_000_000;
    const THREE = [
      { id: "def", nickname: "Personal", configDir: "/home/.claude", isDefault: true, createdAt: 1 },
      { id: "dead", nickname: "Dead", configDir: "/data/accounts/dead", isDefault: false, createdAt: 2 },
      { id: "alt", nickname: "Alt", configDir: "/data/accounts/alt", isDefault: false, createdAt: 3 },
    ];
    const ex: Record<string, number | null> = {};
    invoke.mockImplementation((cmd: string, args?: { id: string; untilEpoch: number }) => {
      if (cmd === "accounts_list") return Promise.resolve(THREE);
      if (cmd === "accounts_usage")
        return Promise.resolve([
          { id: "def", tokens5h: 0, tokens7d: 10, exhaustedUntil: ex["def"] ?? null },
          { id: "dead", tokens5h: 0, tokens7d: 20, exhaustedUntil: ex["dead"] ?? null },
          { id: "alt", tokens5h: 0, tokens7d: 50, exhaustedUntil: ex["alt"] ?? null },
        ]);
      if (cmd === "accounts_identities")
        return Promise.resolve([
          { id: "def", email: "def@x", organization: null },
          { id: "dead", email: "dead@x", organization: null },
          { id: "alt", email: "alt@x", organization: null },
        ]);
      if (cmd === "accounts_ceilings") return Promise.resolve([]);
      if (cmd === "account_usage_live") return Promise.reject(new Error("no token in tests"));
      if (cmd === "accounts_mark_exhausted") {
        ex[args!.id] = args!.untilEpoch;
        return Promise.resolve();
      }
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    invalidateAccountState();
    // Seed the dead verdict at the test clock so loadAccountState's TTL-guarded refresh won't overwrite it.
    await refreshDeadLogins(THREE, t, {
      probe: async (dir?: string) =>
        dir === "/data/accounts/dead"
          ? { loggedIn: false, source: "cli", email: "dead@x", authMethod: null, subscriptionType: null }
          : { loggedIn: true, source: "cli", email: "x@x", authMethod: "oauth", subscriptionType: "max" },
    });

    // Parked on the cheapest signed-in account, `def`.
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t })).toBe("/home/.claude");

    // def's auth fails → rotate. `dead` is cheaper than `alt` but its login is dead, so the rotation
    // must skip it and land on `alt`.
    const result = await rotateStickyConsumerOffFailedAccount(CONCIERGE_ACCOUNT_KEY, "auth", {
      now: t + 1,
    });
    expect(result.rotated).toBe(true);
    expect(result.to).toBe("alt");
  });

  // ══ BURST ATTRIBUTION (the founder's fleet-exhaustion cause) ══════════════════════════════════
  // On a burst, the async handler for failure #2 runs AFTER an earlier rotation has already moved the
  // sticky pointer to a HEALTHY account. Attributing by the sticky pointer (the old code) benches that
  // healthy account — and its whole login group, fleet-wide. Attributing by the account that ACTUALLY
  // ran the failing turn does not. `failedAccount` may be given as an account id OR a config dir (the
  // concierge's identity form via `turnAccountFor`); both must normalise to the same account.
  it("does NOT bench the healthy successor when a later burst failure names an account already rotated away", async () => {
    mockFleet();
    const t = 25_000_000;
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t })).toBe("/home/.claude");

    // Rotation #1: def's quota wall fails → benches def, moves the sticky pointer to work.
    const r1 = await rotateStickyConsumerOffFailedAccount(CONCIERGE_ACCOUNT_KEY, "quota", {
      now: t + 1,
      failedAccount: "def",
    });
    expect(r1.rotated).toBe(true);
    expect(r1.to).toBe("work");
    expect(markExhaustedIds()).toEqual(["def"]);
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t + 2 })).toBe(
      "/data/accounts/work",
    );

    // Rotation #2: the burst straggler for the SAME failed turn (def, named here by its CONFIG DIR)
    // lands late — the pointer is already on healthy work.
    const r2 = await rotateStickyConsumerOffFailedAccount(CONCIERGE_ACCOUNT_KEY, "quota", {
      now: t + 3,
      failedAccount: "/home/.claude",
    });
    expect(r2.rotated).toBe(false);
    expect(r2.reason).toBe("already-rotated");

    // THE POINT: work (healthy) was NEVER benched. The old `stickySelections.get(key)` attribution
    // read `work` here and benched it — this line reds against pre-fix code.
    expect(markExhaustedIds()).toEqual(["def"]);
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t + 4 })).toBe(
      "/data/accounts/work",
    );
  });

  // ══ SINGLE FAILURE via the CONFIG-DIR identity form (proves the id↔configDir normalisation) ══════
  it("benches and rotates when the failed account is attributed by config dir", async () => {
    mockFleet();
    const t = 26_000_000;
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t })).toBe("/home/.claude");
    const r = await rotateStickyConsumerOffFailedAccount(CONCIERGE_ACCOUNT_KEY, "quota", {
      now: t + 1,
      failedAccount: "/home/.claude",
    });
    expect(r.rotated).toBe(true);
    expect(r.from).toBe("def");
    expect(r.to).toBe("work");
    expect(markExhaustedIds()).toEqual(["def"]);
  });

  // ══ RE-ENTRANCY — two failures for the SAME dead account fired concurrently ═══════════════════════
  it("de-dupes concurrent failures for the same account — one bench, never the healthy successor", async () => {
    mockFleet();
    const t = 27_000_000;
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t })).toBe("/home/.claude");

    const [a, b] = await Promise.all([
      rotateStickyConsumerOffFailedAccount(CONCIERGE_ACCOUNT_KEY, "quota", {
        now: t + 1,
        failedAccount: "def",
      }),
      rotateStickyConsumerOffFailedAccount(CONCIERGE_ACCOUNT_KEY, "quota", {
        now: t + 1,
        failedAccount: "def",
      }),
    ]);

    // Exactly one pass did the work; the other was deduped as in-flight. def is benched ONCE and work
    // (healthy) is never benched. Without the guard the second pass re-resolves after the first moved
    // the pointer and benches work.
    expect(markExhaustedIds()).toEqual(["def"]);
    const reasons = [a.reason, b.reason];
    expect(reasons).toContain("in-flight");
    expect(a.rotated || b.rotated).toBe(true);
  });

  // ══ DEGRADE-SAFE — unknown/unmappable attribution falls back to the sticky pointer ═══════════════
  it("falls back to the sticky pointer when the attributed account maps to nothing", async () => {
    mockFleet();
    const t = 28_000_000;
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t })).toBe("/home/.claude");
    const r = await rotateStickyConsumerOffFailedAccount(CONCIERGE_ACCOUNT_KEY, "quota", {
      now: t + 1,
      failedAccount: "/no/such/config/dir",
    });
    // Pre-fix behaviour: benches the sticky account (def) and rotates to work.
    expect(r.rotated).toBe(true);
    expect(r.from).toBe("def");
    expect(markExhaustedIds()).toEqual(["def"]);
  });

  it("with no attributed account (undefined) benches the sticky account exactly as before", async () => {
    mockFleet();
    const t = 29_000_000;
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t })).toBe("/home/.claude");
    const r = await rotateStickyConsumerOffFailedAccount(CONCIERGE_ACCOUNT_KEY, "quota", {
      now: t + 1,
    });
    expect(r.rotated).toBe(true);
    expect(r.from).toBe("def");
    expect(markExhaustedIds()).toEqual(["def"]);
  });
});

describe("concierge fallback config dirs (single-turn auth-failover candidates)", () => {
  // A dedicated primary + a healthy dedicated alternative + a CLOBBERED default (terminal signed into
  // a different account than Sparkle runs it as). The dedicated primary is cheapest so the concierge
  // parks on it; the clobbered default reads "signed in / healthy" in recorded state.
  const FLEET = [
    { id: "primary", nickname: "Primary", configDir: "/data/accounts/primary", isDefault: false, createdAt: 1 },
    { id: "alt", nickname: "Alt", configDir: "/data/accounts/alt", isDefault: false, createdAt: 2 },
    { id: "home", nickname: "Home", configDir: "", isDefault: true, createdAt: 3 },
  ];
  // `alt` carries slightly MORE local usage than `primary`, so `primary` wins the initial park and
  // `alt` is the (only) healthy fallback — a deterministic ranking the assertions can pin.
  function mockFleet(over: { clobberHome?: boolean; signedIn?: string[] } = {}) {
    const { clobberHome = true, signedIn = ["primary", "alt", "home"] } = over;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "accounts_list") return Promise.resolve(FLEET);
      if (cmd === "accounts_usage")
        return Promise.resolve([
          { id: "primary", tokens5h: 0, tokens7d: 10, exhaustedUntil: null },
          { id: "alt", tokens5h: 0, tokens7d: 20, exhaustedUntil: null },
          // `home` carries the MOST usage, so it never wins the primary park — the concierge lands on a
          // dedicated account whether or not `home` is clobbered, which keeps every assertion below
          // about the FALLBACK list rather than about which account happened to be cheapest.
          { id: "home", tokens5h: 0, tokens7d: 100, exhaustedUntil: null },
        ]);
      if (cmd === "accounts_identities")
        return Promise.resolve(
          signedIn.map((id) => ({
            id,
            email: `${id}@example.com`,
            organization: null,
            accountUuid: `uuid-${id}`,
            // The default `home` is CLOBBERED: its terminal ~/.claude.json is a different account.
            ...(id === "home" && clobberHome
              ? { shellAccountUuid: "uuid-terminal", shellEmail: "terminal@example.com" }
              : {}),
          })),
        );
      if (cmd === "accounts_ceilings") return Promise.resolve([]);
      if (cmd === "account_usage_live") return Promise.reject(new Error("no token in tests"));
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    invalidateAccountState();
  }

  beforeEach(() => {
    invoke.mockReset();
    invalidateAccountState();
    resetStickyAccounts();
    clearAllPins();
  });

  it("offers the healthy DEDICATED alternatives, excluding the primary and the clobbered default", async () => {
    mockFleet();
    const t = 30_000_000;
    // Parks on the cheapest DEDICATED account — the clobbered default is routed away from even for the
    // primary pick (avoidClobberedDefault), and `home`'s empty dir would never be a dedicated pick anyway.
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t, avoidClobberedDefault: true })).toBe(
      "/data/accounts/primary",
    );
    // SIDE EFFECT: the fallback list is exactly the OTHER healthy dedicated account — not the primary
    // (rotating off it), not the clobbered default, not the shared default's empty dir.
    expect(await conciergeFallbackConfigDirs({ now: t })).toEqual(["/data/accounts/alt"]);
  });

  it("returns [] — the last-account guard — when the primary is the only healthy DEDICATED account", async () => {
    // Only `primary` and the clobbered default `home` are signed in; `alt` is not. There is no healthy
    // dedicated alternative, so the turn must fail into the sign-in dead-end rather than rotate.
    mockFleet({ signedIn: ["primary", "home"] });
    const t = 31_000_000;
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t, avoidClobberedDefault: true })).toBe(
      "/data/accounts/primary",
    );
    expect(await conciergeFallbackConfigDirs({ now: t })).toEqual([]);
  });

  it("a HEALTHY (non-clobbered) default is still excluded from fallbacks — the concierge rotates to a dedicated account, never the shared default", async () => {
    mockFleet({ clobberHome: false });
    const t = 32_000_000;
    // `home` is healthy now, but its config dir is the shared empty default; fallbacks stay dedicated-only.
    expect(await conciergeFallbackConfigDirs({ now: t })).toEqual(["/data/accounts/alt"]);
  });

  it("returns [] when the accounts backend is unreadable (never rotates on a hiccup)", async () => {
    invoke.mockImplementation(() => Promise.reject(new Error("backend down")));
    invalidateAccountState();
    expect(await conciergeFallbackConfigDirs({ now: 33_000_000 })).toEqual([]);
  });
});

describe("deadLoginIds — the shared DEFINITELY-expired-login cache", () => {
  const acc = (id: string) => ({
    id,
    nickname: id,
    configDir: `/cfg/${id}`,
    isDefault: false,
    createdAt: 1,
  });
  const expired = (): ClaudeAuthStatus => ({
    loggedIn: false,
    source: "cli", // a live CLI "no" — the only shape authIsDefinitelyExpired accepts
    email: "x@example.test",
    authMethod: null,
    subscriptionType: null,
  });
  const alive = (): ClaudeAuthStatus => ({
    loggedIn: true,
    source: "cli",
    email: "x@example.test",
    authMethod: "oauth",
    subscriptionType: "max",
  });
  const absent = (): ClaudeAuthStatus => ({
    loggedIn: false,
    source: "absent", // never signed in — NOT "definitely expired"
    email: null,
    authMethod: null,
    subscriptionType: null,
  });

  beforeEach(() => {
    invalidateAccountState(); // clears the dead-login cache too
  });

  it("collects ONLY the accounts whose live probe says definitely-expired", async () => {
    const probe = vi.fn(async (dir?: string) =>
      dir === "/cfg/dead" ? expired() : dir === "/cfg/new" ? absent() : alive(),
    );
    await refreshDeadLogins([acc("dead"), acc("healthy"), acc("new")], 1_000, { probe });
    const ids = deadLoginIds();
    expect(ids.has("dead")).toBe(true); // live CLI "no"
    expect(ids.has("healthy")).toBe(false); // logged in
    expect(ids.has("new")).toBe(false); // never signed in is NOT expired
  });

  it("absorbs a probe that cannot run — a flaky probe never manufactures a dead login", async () => {
    const probe = vi.fn(async (dir?: string) => {
      if (dir === "/cfg/flaky") throw new Error("probe failed");
      return expired();
    });
    await refreshDeadLogins([acc("flaky"), acc("dead")], 2_000, { probe });
    expect(deadLoginIds().has("flaky")).toBe(false); // errored → not dead
    expect(deadLoginIds().has("dead")).toBe(true);
  });

  it("serves the cache within the TTL and re-probes only after it lapses", async () => {
    const probe = vi.fn(async () => expired());
    await refreshDeadLogins([acc("dead")], 10_000, { probe });
    expect(probe).toHaveBeenCalledTimes(1);
    // Within the TTL: no re-probe.
    await refreshDeadLogins([acc("dead")], 10_000 + DEAD_LOGIN_TTL_MS - 1, { probe });
    expect(probe).toHaveBeenCalledTimes(1);
    // Past the TTL: re-probe.
    await refreshDeadLogins([acc("dead")], 10_000 + DEAD_LOGIN_TTL_MS, { probe });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("invalidateAccountState drops the verdict — a re-login re-probes rather than migrating off the fixed account", async () => {
    const probe = vi.fn(async () => expired());
    await refreshDeadLogins([acc("dead")], 20_000, { probe });
    expect(deadLoginIds().has("dead")).toBe(true);
    invalidateAccountState();
    expect(deadLoginIds().size).toBe(0); // stale "expired" cannot outlive the remedy
  });

  it("a probe IN FLIGHT when a re-login lands does not re-pin the stale verdict, and the next refresh re-probes", async () => {
    // The race the generation guard closes (roborev 67535). The `invalidateAccountState` test above
    // awaits the probe FIRST, so it only covers the settled case; this drives the interleaving that
    // actually bites: a probe kicked at T resolves AFTER the user re-logs in at T+ε. Without the guard
    // it writes `{dead}` back and the fleet migrates off the account the user just fixed.
    let releaseFirst!: () => void;
    const firstProbe = vi.fn(
      () =>
        new Promise<ClaudeAuthStatus>((res) => {
          releaseFirst = () => res(expired());
        }),
    );
    const p = refreshDeadLogins([acc("dead")], 30_000, { probe: firstProbe }); // in flight, not settled
    invalidateAccountState(); // the re-login lands mid-probe
    releaseFirst(); // now the stale "expired" answer arrives
    await p;
    expect(deadLoginIds().has("dead")).toBe(false); // discarded by the generation guard

    // …and the in-flight handle was dropped, so the NEXT refresh actually re-probes (post-login creds)
    // rather than returning the stale in-flight promise.
    const secondProbe = vi.fn(async () => alive());
    await refreshDeadLogins([acc("dead")], 31_000, { probe: secondProbe });
    expect(secondProbe).toHaveBeenCalledTimes(1);
    expect(deadLoginIds().has("dead")).toBe(false);
  });

  it("a NON-credential invalidation (an agent move) keeps the dead-login verdict; a credential one drops it", async () => {
    // roborev 67627: phase 2 calls invalidateAccountState() on every agent move (~3s). If that dropped
    // the dead-login verdict it would be empty for most of a migration, making the mid-migration
    // re-target / demotion / firstUsableHolder exclusion inert. So a non-credential invalidation must
    // preserve it; only a credential event (login/add/remove) drops it.
    const probe = vi.fn(async () => expired());
    await refreshDeadLogins([acc("dead")], 60_000, { probe });
    expect(deadLoginIds().has("dead")).toBe(true);

    invalidateAccountState({ credentials: false }); // an agent move
    expect(deadLoginIds().has("dead")).toBe(true); // preserved

    invalidateAccountState(); // a credential event (default)
    expect(deadLoginIds().size).toBe(0); // dropped
  });
});

describe("a fleet preference / pause pointing at a DEFINITELY-expired login falls through to auto-pick", () => {
  // The preference and the freeze are honoured by routing them through `pickAccount`'s pinnedAccountId
  // slot, which deliberately OVERRIDES the dead-login demotion in `partitionAccounts` (a human pin
  // wins). So without an explicit gate in `usablePreferredAccount`/`usablePausedAccount`, a fleet
  // preference on an EXPIRED account keeps spawning every new agent there to 401 whenever the fleet
  // switch does not fire. (roborev 67535)
  const ACCTS = [
    { id: "dead", nickname: "Dead", configDir: "/data/accounts/dead", isDefault: false, createdAt: 1 },
    { id: "live", nickname: "Live", configDir: "/data/accounts/live", isDefault: false, createdAt: 2 },
  ];
  // `dead` has the LOWER tally, so auto-pick would prefer it on usage alone — but it is dead-login, so
  // `partitionAccounts` demotes it and the healthy `live` is chosen once the preference is refused.
  const USE = [
    { id: "dead", tokens5h: 10, tokens7d: 10, exhaustedUntil: null },
    { id: "live", tokens5h: 500, tokens7d: 500, exhaustedUntil: null },
  ];
  const IDS = [
    { id: "dead", email: "dead@example.com", organization: null, accountUuid: "u-dead" },
    { id: "live", email: "live@example.com", organization: null, accountUuid: "u-live" },
  ];

  beforeEach(async () => {
    invoke.mockReset();
    localStorage.clear(); // preferred account, pins, pause, rotation-out are all localStorage-backed
    invalidateAccountState();
    resetStickyAccounts();
    clearAllPins();
    clearPreferredAccount();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "accounts_list") return Promise.resolve(ACCTS);
      if (cmd === "accounts_usage") return Promise.resolve(USE);
      if (cmd === "accounts_identities") return Promise.resolve(IDS);
      if (cmd === "accounts_ceilings") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });
    // Populate the shared dead-login cache at the SAME clock the pick uses, so `loadAccountState`'s own
    // (real-probe) refresh is within TTL and does not overwrite it.
    await refreshDeadLogins(ACCTS, 40_000_000, {
      probe: async (dir?: string) =>
        dir === "/data/accounts/dead"
          ? { loggedIn: false, source: "cli", email: "dead@example.com", authMethod: null, subscriptionType: null }
          : { loggedIn: true, source: "cli", email: "live@example.com", authMethod: "oauth", subscriptionType: "max" },
    });
  });

  it("does not route a non-sticky spawn to the preferred account when its login is dead", async () => {
    setPreferredAccountId("dead");
    const { chosen } = await chooseAccountForAgent("agent-x", { now: 40_000_000 });
    // Refused as a preference (dead login) AND demoted as an auto-pick candidate → the healthy account.
    // Remove the dead-login gate in `usablePreferredAccount` and the preference wins via the pin slot,
    // sending the agent to `dead`.
    expect(chosen?.id).toBe("live");
  });

  it("HOLDS a non-sticky spawn while paused instead of routing it anywhere", async () => {
    // The pause is now a SPEND HALT, not a "freeze onto the leading account": a brand-new non-sticky
    // agent is HELD outright while paused, so it is never routed to a frozen account at all — dead
    // login or otherwise — and the spawn path refuses to start rather than spending on the default.
    pauseRotation("dead", 40_000_000);
    const { chosen, held } = await chooseAccountForAgent("agent-y", { now: 40_000_000 });
    expect(chosen).toBeNull();
    expect(held).toBe(true);
  });
});

// ── PROACTIVE rotation off a spent/expired account BEFORE the first turn dispatches ──────────────
// The first prompt after an app restart resolves an account while the live-usage and dead-login
// caches are process-COLD, so a spend-limited account reads as "no live figure yet" and an EXPIRED
// login reads as the HEALTHIEST account on the machine (no wall, no utilization, signed-in by email).
// It gets chosen, the turn spawns into the hard "out of room / login expired" error, and only
// ~1-2 min later does the reactive/poll path rotate off it. `rotateStickyConsumerOffSpentAccount`
// closes that window: it warms the probes and, if the account is spent with a healthy alternative,
// rotates BEFORE dispatch. These assert the SIDE EFFECT (the selection MOVES to the healthy account)
// with a paired negative so a rotation that always fires cannot pass.
describe("proactive rotation off a spent/expired concierge account", () => {
  // `def` is the cheaper account, so a cold first resolve parks the concierge there — exactly the
  // account that is actually spent/expired in each case below.
  const TWO = [
    { id: "def", nickname: "Personal", configDir: "/home/.claude", isDefault: true, createdAt: 1 },
    { id: "work", nickname: "Work", configDir: "/data/accounts/work", isDefault: false, createdAt: 2 },
  ];

  let exhausted: Record<string, number | null>;
  /** `dead` = config dirs whose `claude auth status` returns a live CLI "no"; `live` = per-config-dir
   *  utilization percentages the live-usage probe reports. Everything else is healthy. */
  function mockFleet(
    opts: {
      dead?: string[];
      live?: Record<string, number>;
      signedIn?: string[];
      /** Config dirs whose `account_usage_live` is RATE-LIMITED (429) — the Rust command rejects with
       *  its `rate-limited` marker, exactly as a capped account produces in production. */
      rateLimited?: string[];
    } = {},
  ) {
    exhausted = {};
    const dead = new Set(opts.dead ?? []);
    const live = opts.live ?? {};
    const rateLimited = new Set(opts.rateLimited ?? []);
    const signedIn = opts.signedIn ?? ["def", "work"];
    invoke.mockImplementation((cmd: string, args?: { id?: string; untilEpoch?: number; configDir?: string }) => {
      if (cmd === "accounts_list") return Promise.resolve(TWO);
      if (cmd === "accounts_usage")
        return Promise.resolve([
          { id: "def", tokens5h: 0, tokens7d: 10, exhaustedUntil: exhausted["def"] ?? null },
          { id: "work", tokens5h: 0, tokens7d: 50, exhaustedUntil: exhausted["work"] ?? null },
        ]);
      if (cmd === "accounts_identities")
        return Promise.resolve(
          signedIn.map((id) => ({ id, email: `${id}@example.com`, organization: null })),
        );
      if (cmd === "accounts_ceilings") return Promise.resolve([]);
      if (cmd === "claude_auth_status") {
        const cfg = args?.configDir ?? "";
        const isDead = dead.has(cfg);
        return Promise.resolve({
          loggedIn: !isDead,
          source: "cli", // only a live CLI reading is trusted to say NO — see authIsDefinitelyExpired
          email: isDead ? null : "someone@example.com",
          authMethod: null,
          subscriptionType: null,
        } satisfies ClaudeAuthStatus);
      }
      if (cmd === "account_usage_live") {
        const cfg = args?.configDir ?? "";
        if (rateLimited.has(cfg))
          return Promise.reject(
            new Error("usage fetch failed: rate-limited (usage temporarily unavailable)"),
          );
        const pct = live[cfg];
        if (pct == null) return Promise.reject(new Error("no live figure in tests"));
        return Promise.resolve({
          fiveHourPercent: pct,
          fiveHourResetsAt: null,
          sevenDayPercent: pct,
          sevenDayResetsAt: null,
          limits: [],
        });
      }
      if (cmd === "accounts_mark_exhausted") {
        exhausted[args!.id!] = args!.untilEpoch!;
        return Promise.resolve();
      }
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    invalidateAccountState();
  }

  function markExhaustedIds(): string[] {
    return invoke.mock.calls
      .filter((c) => c[0] === "accounts_mark_exhausted")
      .map((c) => (c[1] as { id: string }).id);
  }

  beforeEach(() => {
    invoke.mockReset();
    invalidateAccountState();
    resetStickyAccounts();
    clearAllPins();
  });

  it("rotates the concierge off an EXPIRED-login account before dispatch", async () => {
    // `def`'s OAuth is dead (a live CLI "no"), `work` is healthy. The cold first resolve parks on
    // `def` because recorded state (and the still-cold dead-login cache) reads it healthiest.
    mockFleet({ dead: ["/home/.claude"] });
    const t = 30_000_000;
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t })).toBe("/home/.claude");

    const result = await rotateStickyConsumerOffSpentAccount(CONCIERGE_ACCOUNT_KEY, { now: t + 1 });

    // SIDE EFFECT: warmed the dead-login probe, saw `def` is unusable, benched it and re-resolved to
    // the healthy account — the sticky pointer moved with it.
    expect(result.rotated).toBe(true);
    expect(result.from).toBe("def");
    expect(result.to).toBe("work");
    expect(markExhaustedIds()).toEqual(["def"]);
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t + 2 })).toBe(
      "/data/accounts/work",
    );
  });

  it("rotates the concierge off a SPEND-LIMITED account before dispatch", async () => {
    // `def` is at 95% of its real Anthropic quota (≥ LIVE_AVOID_PERCENT), `work` is at 5%. The cold
    // first resolve parks on `def` because the live-usage cache is empty at that instant.
    mockFleet({ live: { "/home/.claude": 95, "/data/accounts/work": 5 } });
    const t = 31_000_000;
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t })).toBe("/home/.claude");

    const result = await rotateStickyConsumerOffSpentAccount(CONCIERGE_ACCOUNT_KEY, { now: t + 1 });

    expect(result.rotated).toBe(true);
    expect(result.from).toBe("def");
    expect(result.to).toBe("work");
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t + 2 })).toBe(
      "/data/accounts/work",
    );
  });

  it("rotates the concierge off a RATE-LIMITED account before dispatch", async () => {
    // `def`'s usage read is 429'd by Anthropic — the account is at a session/weekly cap. This is the
    // founder's incident: before the fix a 429 dropped the live row entirely, so `def` looked
    // available (lowest local tally, no exhaustedUntil wall) and kept winning the pick. Now the 429 is
    // classified and the row is marked `rateLimited`, which `isAccountLiveSpent` excludes. `work`
    // reads a healthy 5%. NON-VACUOUS end-to-end: revert either the `refreshLiveUsage` rate-limit
    // emit or the `isAccountLiveSpent` clause and `def` gets no row → is not excluded → the concierge
    // stays parked on it and `rotated` is false, reddening this test.
    mockFleet({ rateLimited: ["/home/.claude"], live: { "/data/accounts/work": 5 } });
    const t = 32_000_000;
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t })).toBe("/home/.claude");

    const result = await rotateStickyConsumerOffSpentAccount(CONCIERGE_ACCOUNT_KEY, { now: t + 1 });

    expect(result.rotated).toBe(true);
    expect(result.from).toBe("def");
    expect(result.to).toBe("work");
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t + 2 })).toBe(
      "/data/accounts/work",
    );
  });

  it("does NOT rotate when the chosen account is HEALTHY (paired negative)", async () => {
    // Both accounts authenticate and are well under quota. Warming the probes reveals nothing spent,
    // so the imminent turn stays on the account it already had — a rotation that always fired would
    // fail here. `def` (95%? no — 5%) stays chosen.
    mockFleet({ live: { "/home/.claude": 5, "/data/accounts/work": 5 } });
    const t = 32_000_000;
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t })).toBe("/home/.claude");

    const result = await rotateStickyConsumerOffSpentAccount(CONCIERGE_ACCOUNT_KEY, { now: t + 1 });

    expect(result.rotated).toBe(false);
    expect(result.reason).toBe("not-unusable");
    expect(markExhaustedIds()).toEqual([]);
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t + 2 })).toBe("/home/.claude");
  });

  it("does NOT rotate when there is no healthy alternative (never benches the last account)", async () => {
    // Both logins are dead. Rotating anywhere just relocates the 401, and benching the last account
    // would strand the concierge on a null account — so it must leave selection alone.
    mockFleet({ dead: ["/home/.claude", "/data/accounts/work"] });
    const t = 33_000_000;
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t })).toBe("/home/.claude");

    const result = await rotateStickyConsumerOffSpentAccount(CONCIERGE_ACCOUNT_KEY, { now: t + 1 });

    expect(result.rotated).toBe(false);
    expect(markExhaustedIds()).toEqual([]);
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t + 2 })).toBe("/home/.claude");
  });

  it("respects a human pin (Manual Override) and does not rotate off an expired account", async () => {
    mockFleet({ dead: ["/home/.claude"] });
    const t = 34_000_000;
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t })).toBe("/home/.claude");
    setPin(CONCIERGE_ACCOUNT_KEY, "def"); // the human deliberately put the concierge on `def`

    const result = await rotateStickyConsumerOffSpentAccount(CONCIERGE_ACCOUNT_KEY, { now: t + 1 });

    expect(result).toEqual({ rotated: false, reason: "pinned" });
    expect(markExhaustedIds()).toEqual([]);
  });

  it("does not touch the probes at all when there is no second account to rotate to", async () => {
    // The founder's single-signed-in-account machine: `bestHealthyTarget` can only return null, so
    // the check is a no-op and must pay NO `claude auth status` subprocess to discover that. This
    // guards the early bail placed BEFORE the probe warm-up.
    mockFleet({ signedIn: ["def"], dead: ["/home/.claude"] });
    const t = 35_000_000;
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t })).toBe("/home/.claude");
    const deadSpy = vi.fn(refreshDeadLogins);
    const liveSpy = vi.fn(refreshLiveUsage);

    const result = await rotateStickyConsumerOffSpentAccount(CONCIERGE_ACCOUNT_KEY, {
      now: t + 1,
      deps: { refreshDeadLogins: deadSpy, refreshLiveUsage: liveSpy },
    });

    expect(result.reason).toBe("no-healthy-alternative");
    expect(deadSpy).not.toHaveBeenCalled();
    expect(liveSpy).not.toHaveBeenCalled();
  });

  it("AWAITS the cold probes only ONCE per process, not on every turn", async () => {
    // The latency guard (roborev 68216): the cache TTLs (90s/120s) are shorter than the gap between
    // typed turns, so awaiting the probes on EVERY turn would block the chat path on a subprocess
    // whenever a turn lands after the TTL. The blocking warm-up must run at most once per process.
    mockFleet({ live: { "/home/.claude": 5, "/data/accounts/work": 5 } }); // both healthy
    const t = 36_000_000;
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t })).toBe("/home/.claude");
    const deadSpy = vi.fn(refreshDeadLogins);
    const liveSpy = vi.fn(refreshLiveUsage);
    const deps = { refreshDeadLogins: deadSpy, refreshLiveUsage: liveSpy };

    // First turn after "restart": the warm-up is awaited.
    await rotateStickyConsumerOffSpentAccount(CONCIERGE_ACCOUNT_KEY, { now: t + 1, deps });
    expect(deadSpy).toHaveBeenCalledTimes(1);
    expect(liveSpy).toHaveBeenCalledTimes(1);

    // A later turn, deliberately PAST both cache TTLs so nothing but the once-per-process flag can
    // suppress the wait: the probes are NOT awaited again.
    await rotateStickyConsumerOffSpentAccount(CONCIERGE_ACCOUNT_KEY, {
      now: t + DEAD_LOGIN_TTL_MS + 200_000,
      deps,
    });
    expect(deadSpy).toHaveBeenCalledTimes(1);
    expect(liveSpy).toHaveBeenCalledTimes(1);
  });

  it("rotates even when the SPENT sticky account itself is not signed in (dead default)", async () => {
    // The divergence the early bail must respect (roborev 68233): a terminal `claude logout` cleared
    // the shared default's oauthAccount, so `def` is NOT in signedInAccountIds (email null) yet the
    // concierge is still parked on it and its login is dead; `work` is signed in and healthy. A naive
    // "< 2 signed-in accounts" bail would give up here (only `work` is signed in) and dispatch onto
    // the dead account — the exact hard-error window this branch closes. The correct bail is weaker,
    // so the rotation still fires.
    mockFleet({ signedIn: ["work"], dead: ["/home/.claude"] });
    const t = 37_000_000;
    // Prime the sticky pointer onto `def` even though it is unauthed: pin it (a pin overrides the
    // signed-in filter), resolve once to write the sticky slot, then drop the pin so the proactive
    // path — not the pin — governs.
    setPin(CONCIERGE_ACCOUNT_KEY, "def");
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t })).toBe("/home/.claude");
    clearAllPins();

    const result = await rotateStickyConsumerOffSpentAccount(CONCIERGE_ACCOUNT_KEY, { now: t + 1 });

    expect(result.rotated).toBe(true);
    expect(result.from).toBe("def");
    expect(result.to).toBe("work");
    expect(await accountConfigDirFor(CONCIERGE_ACCOUNT_KEY, { now: t + 2 })).toBe(
      "/data/accounts/work",
    );
  });
});
