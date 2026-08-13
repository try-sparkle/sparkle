// The FLEET-WIDE preferred account ("Activate this account") inside the one resolver.
//
// WHAT MAKES THESE NON-VACUOUS: in every test the preferred account is deliberately NOT the account
// auto-pick would have chosen. `cloud` always carries the highest tally, so plain auto-pick picks
// `work` — asserting `cloud` therefore proves the preference decided the outcome. Asserting the
// account auto-pick already liked would pass with the whole feature deleted.
//
// The escape-hatch tests come in PAIRS for the same reason. "A not-signed-in preference does not
// win" is satisfied by a preference that never works at all; the paired case, identical except that
// the account IS signed in, is what shows the gate is the cause.
import { describe, it, expect, beforeEach, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  chooseAccountForAgent,
  invalidateAccountState,
  resetStickyAccounts,
  CONCIERGE_ACCOUNT_KEY,
  SPARKLE_SELF_ACCOUNT_PREFIX,
} from "./accountSelection";
import { resetSelectionLog, type SpawnLogEntry } from "./accountLedger";
import {
  setPin,
  clearAllPins,
  getPreferredAccountId,
  setPreferredAccountId,
  clearPreferredAccount,
  removeAccount,
} from "./accountStore";

const ACCOUNTS = [
  { id: "def", nickname: "Default", configDir: "/home/.claude", isDefault: true, createdAt: 1 },
  { id: "work", nickname: "Work", configDir: "/data/work", isDefault: false, createdAt: 2 },
  { id: "cloud", nickname: "Cloud", configDir: "/data/cloud", isDefault: false, createdAt: 3 },
];

const NOW = 5_000_000;

/** Tallies chosen so plain auto-pick lands on `work`: `cloud` is the BUSIEST, so it can only ever
 *  be chosen because something overrode the usage rule. */
const USAGE = [
  { id: "def", tokens5h: 50, tokens7d: 500, exhaustedUntil: null as number | null },
  { id: "work", tokens5h: 10, tokens7d: 100, exhaustedUntil: null as number | null },
  { id: "cloud", tokens5h: 90, tokens7d: 900, exhaustedUntil: null as number | null },
];

// UNITS: the `accounts_usage` WIRE carries `exhaustedUntil` in SECONDS and `getUsage` multiplies it
// by 1000 (accountStore's MS_PER_SEC). A fixture written in ms therefore lands ~1000× further in the
// future than intended, which silently turns "this limit already expired" into "exhausted for the
// next two months" — and the paired test that is supposed to prove the gate lets a healthy account
// through fails for a reason that has nothing to do with the gate.
const FUTURE_S = NOW / 1000 + 60; // resets a minute after NOW
const PAST_S = NOW / 1000 - 60; // reset a minute before NOW

const exhaustedCloud = (untilSeconds: number) =>
  USAGE.map((u) => (u.id === "cloud" ? { ...u, exhaustedUntil: untilSeconds } : u));

const identity = (id: string) => ({ id, email: `${id}@example.invalid`, organization: null, accountUuid: `u-${id}` });

/** Every account signed in unless named in `notSignedIn`. */
function mockBackend(opts: { notSignedIn?: string[]; usage?: typeof USAGE; reject?: boolean } = {}) {
  const excluded = new Set(opts.notSignedIn ?? []);
  invoke.mockImplementation((cmd: string) => {
    if (opts.reject && cmd !== "accounts_record_spawn") return Promise.reject(new Error("backend down"));
    if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
    if (cmd === "accounts_usage") return Promise.resolve(opts.usage ?? USAGE);
    if (cmd === "accounts_identities")
      // A registered-but-never-logged-in dir reports a null email — that is the signed-in signal.
      return Promise.resolve(
        ACCOUNTS.map((a) =>
          excluded.has(a.id) ? { id: a.id, email: null, organization: null, accountUuid: null } : identity(a.id),
        ),
      );
    if (cmd === "accounts_ceilings") return Promise.resolve([]);
    if (cmd === "accounts_record_spawn") return Promise.resolve(null);
    if (cmd === "accounts_remove") return Promise.resolve(null);
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  });
}

/** The ledger lines this resolution appended — the ledger is the second half of the side effect. */
function ledgerEntries(): SpawnLogEntry[] {
  return invoke.mock.calls
    .filter((c) => c[0] === "accounts_record_spawn")
    .map((c) => (c[1] as { entry: SpawnLogEntry }).entry);
}

/** Resolve for a FRESH key, uncached, at a fixed instant. */
async function resolve(key: string) {
  invalidateAccountState();
  const { chosen } = await chooseAccountForAgent(key, { now: NOW });
  return chosen;
}

beforeEach(() => {
  invoke.mockReset();
  invalidateAccountState();
  resetStickyAccounts();
  resetSelectionLog();
  clearAllPins();
  clearPreferredAccount();
  mockBackend();
});

describe("preferred account — the fleet-wide activation", () => {
  it("baseline: with no preference, auto-pick chooses the least-used account", async () => {
    // The control every other test is measured against. Without it, "cloud won" would not be
    // evidence of anything — it has to be the account that LOSES by default.
    expect((await resolve("agent-1"))?.id).toBe("work");
  });

  it("an activated account wins over the account auto-pick would have chosen", async () => {
    setPreferredAccountId("cloud");
    expect((await resolve("agent-1"))?.id).toBe("cloud");
    // …and the ledger records WHY, distinctly from a pin and from auto-pick. A reader asking "was
    // the founder's choice actually in force at this spawn" has no other way to tell.
    expect(ledgerEntries().at(-1)).toMatchObject({ key: "agent-1", accountId: "cloud", reason: "preferred" });
  });

  it("governs agents that did not exist when it was set", async () => {
    setPreferredAccountId("cloud");
    await resolve("agent-1");
    // A brand-new key, never seen before: the whole point of persisting a preference rather than
    // pinning the panes that happened to be mounted.
    expect((await resolve("agent-created-later"))?.id).toBe("cloud");
  });

  // ── ESCAPE HATCHES, each PAIRED with the same setup minus the disqualifier ────────────────────

  it("does NOT win when the activated account is not signed in", async () => {
    mockBackend({ notSignedIn: ["cloud"] });
    setPreferredAccountId("cloud");
    // Falls through to auto-pick rather than stranding the spawn at a login prompt.
    expect((await resolve("agent-1"))?.id).toBe("work");
    expect(ledgerEntries().at(-1)?.reason).toBe("auto");
  });

  it("…but DOES win under the identical setup once that account is signed in", async () => {
    mockBackend(); // same fixtures, cloud signed in
    setPreferredAccountId("cloud");
    expect((await resolve("agent-1"))?.id).toBe("cloud");
  });

  it("does NOT win while the activated account is rate-limited", async () => {
    mockBackend({ usage: exhaustedCloud(FUTURE_S) });
    setPreferredAccountId("cloud");
    expect((await resolve("agent-1"))?.id).toBe("work");
  });

  it("…but DOES win once that limit has expired", async () => {
    // Same row, reset instant now in the PAST — the only difference from the test above.
    mockBackend({ usage: exhaustedCloud(PAST_S) });
    setPreferredAccountId("cloud");
    expect((await resolve("agent-1"))?.id).toBe("cloud");
  });

  it("a preference naming an account that is not in the list is ignored", async () => {
    setPreferredAccountId("removed-account");
    expect((await resolve("agent-1"))?.id).toBe("work");
    expect(ledgerEntries().at(-1)?.reason).toBe("auto");
  });

  it("…and the SPAWN PATH does not erase it — only `removeAccount` prunes", async () => {
    // PAIRED with the test above: ignoring and deleting are different acts, and the spawn path is
    // entitled to only the first. `state` is served from a 5s per-window cache invalidated only by
    // the window that made the change, so an id that is genuinely fine can read as absent here —
    // on a freshly ADDED account, or in a second window. Deleting on that evidence would be a
    // silent, irreversible write to shared localStorage derived from a stale read. The prune lives
    // in `removeAccount`, where the removal is a fact rather than a snapshot.
    setPreferredAccountId("added-in-another-window");
    await resolve("agent-1");
    expect(getPreferredAccountId()).toBe("added-in-another-window");
  });

  it("removing the activated account prunes the preference, and the next spawn auto-picks", async () => {
    setPreferredAccountId("cloud");
    expect((await resolve("agent-1"))?.id).toBe("cloud"); // in force to begin with
    await removeAccount("cloud");
    expect(getPreferredAccountId()).toBeUndefined();
    // The half that matters: a NEW agent stops landing on the account that is gone. Asserting only
    // the storage key would pass with the resolver ignoring the prune entirely.
    expect((await resolve("agent-2"))?.id).toBe("work");
  });

  it("…but removing a DIFFERENT account leaves the preference in force", async () => {
    // PAIRED: a prune that fires on every removal would be indistinguishable from the right one in
    // the test above, and would quietly cancel the founder's choice whenever any account is tidied.
    setPreferredAccountId("cloud");
    await removeAccount("def");
    expect(getPreferredAccountId()).toBe("cloud");
    expect((await resolve("agent-1"))?.id).toBe("cloud");
  });

  it("an unreadable backend does NOT erase the preference", async () => {
    setPreferredAccountId("cloud");
    mockBackend({ reject: true });
    // Every account looks absent when the load fails, so the "does it still exist" test would
    // delete a perfectly good choice on the strength of an IPC hiccup.
    await resolve("agent-never-seen");
    expect(getPreferredAccountId()).toBe("cloud");
  });

  it("is still honoured on an install where NO account reports an email", async () => {
    // `signedInAccountIds` keys on Identity.email, which accounts.rs leaves null for any config dir
    // whose .claude.json has no `oauthAccount` or could not be parsed — so on such an install every
    // account reads "not signed in". `partitionAccounts` already refuses to let that mean "nothing
    // is usable"; a bare `includes` in the gate would instead drop the founder's choice on every
    // spawn, permanently, with the ledger recording a bland "auto" and nothing on screen to explain
    // it. The gate degrades the same way the pool does.
    mockBackend({ notSignedIn: ACCOUNTS.map((a) => a.id) });
    setPreferredAccountId("cloud");
    expect((await resolve("agent-1"))?.id).toBe("cloud");
    expect(ledgerEntries().at(-1)?.reason).toBe("preferred");
  });

  it("…but a SINGLE not-signed-in account is still disqualified when the signal exists", async () => {
    // PAIRED with the degradation above, and the reason it is not a hole: the escape only applies
    // when the signal is absent WHOLESALE. One account missing its email among others that have one
    // is real evidence about that account, and it still loses.
    mockBackend({ notSignedIn: ["cloud"] });
    setPreferredAccountId("cloud");
    expect((await resolve("agent-1"))?.id).toBe("work");
  });

  // ── Precedence ───────────────────────────────────────────────────────────────────────────────

  it("a per-agent pin still beats the fleet preference", async () => {
    setPreferredAccountId("cloud");
    setPin("agent-1", "def");
    expect((await resolve("agent-1"))?.id).toBe("def");
    expect(ledgerEntries().at(-1)?.reason).toBe("pinned");
    // …and the preference still governs everyone else, so the pin narrowed nothing but itself.
    expect((await resolve("agent-2"))?.id).toBe("cloud");
  });

  it("leaves the sticky consumers alone — activation is about the agent fleet", async () => {
    setPreferredAccountId("cloud");
    // Moving the concierge mid-conversation nulls both session pointers and re-probes, so a
    // fleet-wide setting must not do it as a side effect. They get their own control instead.
    expect((await resolve(CONCIERGE_ACCOUNT_KEY))?.id).toBe("work");
    expect((await resolve(SPARKLE_SELF_ACCOUNT_PREFIX))?.id).toBe("work");
    // The agents DID move, in the same run — so "sticky stayed" is not "the preference was inert".
    expect((await resolve("agent-1"))?.id).toBe("cloud");
  });

  it("a pin on the Improve Sparkle key covers its per-window variants", async () => {
    // The modal can only name the base key, while a satellite window resolves under
    // `__sparkle_self__-win-<uuid>`. Without the fallback, pinning would park half the namespace
    // and leave the rest auto-picking — two accounts, one shared worktree.
    setPin(SPARKLE_SELF_ACCOUNT_PREFIX, "def");
    expect((await resolve(`${SPARKLE_SELF_ACCOUNT_PREFIX}-win-abc123`))?.id).toBe("def");
    // A variant's own pin still wins over the base one.
    setPin(`${SPARKLE_SELF_ACCOUNT_PREFIX}-win-abc123`, "cloud");
    expect((await resolve(`${SPARKLE_SELF_ACCOUNT_PREFIX}-win-abc123`))?.id).toBe("cloud");
    // And an ordinary agent id is untouched by the base key's pin.
    expect((await resolve("agent-1"))?.id).toBe("work");
  });
});
