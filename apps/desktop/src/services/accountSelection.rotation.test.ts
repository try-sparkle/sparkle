// THE TOGGLE AND THE PAUSE HAVE TO MOVE REAL SPAWNS, or they are worse than not shipping them.
//
// The founder asked for two controls on the accounts screen: take an account out of rotation from
// its kebab, and pause the fleet's rotation from the header. Both are one line of UI state away from
// being decorative, and a decorative one would be the exact failure this screen keeps producing — a
// row whose dot says one thing while the router does another. So these tests drive the REAL resolver
// (`chooseAccountForAgent`) against a mocked backend and assert on the account it returns and the
// ledger line it wrote. Asserting the localStorage round-trip is `rotationState.test.ts`'s job; this
// file only cares that routing reads it.
//
// WHAT MAKES THESE NON-VACUOUS: the tallies below are chosen so plain auto-pick always lands on
// `work`. Every assertion that names a DIFFERENT account is therefore evidence something overrode
// the usage rule, and the baseline test at the top is what makes that argument available.
import { describe, it, expect, beforeEach, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  chooseAccountForAgent,
  invalidateAccountState,
  resetStickyAccounts,
  CONCIERGE_ACCOUNT_KEY,
} from "./accountSelection";
import { resetSelectionLog, type SpawnLogEntry } from "./accountLedger";
import {
  clearAllPins,
  clearPreferredAccount,
  setPin,
  setPreferredAccountId,
} from "./accountStore";
import { moveAgent } from "./accountSwitch";
import {
  setAccountInRotation,
  rotationOutIds,
  pauseRotation,
  resumeRotation,
  ROTATION_OUT_STORAGE_KEY,
  ROTATION_PAUSED_STORAGE_KEY,
} from "./rotationState";

const ACCOUNTS = [
  { id: "def", nickname: "Default", configDir: "/home/.claude", isDefault: true, createdAt: 1 },
  { id: "work", nickname: "Work", configDir: "/data/work", isDefault: false, createdAt: 2 },
  { id: "cloud", nickname: "Cloud", configDir: "/data/cloud", isDefault: false, createdAt: 3 },
];

const NOW = 5_000_000;

/** `work` is the least used, so it is what auto-pick returns whenever nothing overrides it. */
const USAGE = [
  { id: "def", tokens5h: 50, tokens7d: 500, exhaustedUntil: null as number | null },
  { id: "work", tokens5h: 10, tokens7d: 100, exhaustedUntil: null as number | null },
  { id: "cloud", tokens5h: 90, tokens7d: 900, exhaustedUntil: null as number | null },
];

// SECONDS on the wire — `getUsage` multiplies by 1000. A fixture written in ms lands ~1000× further
// out than intended and quietly turns "already reset" into "exhausted for two months".
const FUTURE_S = NOW / 1000 + 60;

const identity = (id: string) => ({
  id,
  email: `${id}@example.invalid`,
  organization: null,
  accountUuid: `u-${id}`,
});

function mockBackend(opts: { notSignedIn?: string[]; usage?: typeof USAGE } = {}) {
  const excluded = new Set(opts.notSignedIn ?? []);
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
    if (cmd === "accounts_usage") return Promise.resolve(opts.usage ?? USAGE);
    if (cmd === "accounts_identities")
      return Promise.resolve(
        ACCOUNTS.map((a) =>
          excluded.has(a.id)
            ? { id: a.id, email: null, organization: null, accountUuid: null }
            : identity(a.id),
        ),
      );
    if (cmd === "accounts_ceilings") return Promise.resolve([]);
    if (cmd === "accounts_record_spawn") return Promise.resolve(null);
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  });
}

function ledger(): SpawnLogEntry[] {
  return invoke.mock.calls
    .filter((c) => c[0] === "accounts_record_spawn")
    .map((c) => (c[1] as { entry: SpawnLogEntry }).entry);
}

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
  localStorage.removeItem(ROTATION_OUT_STORAGE_KEY);
  localStorage.removeItem(ROTATION_PAUSED_STORAGE_KEY);
  mockBackend();
});

describe("taking an account OUT of rotation", () => {
  it("baseline: with nothing excluded, auto-pick lands on the least-used account", async () => {
    // The control. Without it "work stopped winning" is not evidence of anything.
    expect((await resolve("agent-1"))?.id).toBe("work");
  });

  it("stops sending new agents to an account the user took out", async () => {
    setAccountInRotation("work", false);
    // `def` is the next-least-used. Not `cloud`: if the exclusion accidentally removed the wrong
    // account, or removed nothing and simply reordered, this would land elsewhere.
    expect((await resolve("agent-1"))?.id).toBe("def");
  });

  it("puts it straight back when the user toggles it in again", async () => {
    // The paired positive. Without it, the test above passes against an exclusion that is permanent,
    // one that excludes everything, or one keyed on the wrong thing entirely.
    setAccountInRotation("work", false);
    expect((await resolve("agent-1"))?.id).toBe("def");
    setAccountInRotation("work", true);
    expect((await resolve("agent-2"))?.id).toBe("work");
  });

  // ── IT DEMOTES, IT DOES NOT BLOCK ────────────────────────────────────────────────────────────
  // The single most important property here. Taking accounts out of rotation is a preference; a
  // preference must never be able to stop the app spawning. `partitionAccounts` keeps excluded
  // accounts in `eligible` for exactly this, the same way it does for a clobbered or unauthed one.
  it("still returns an account when the user has taken EVERY account out", async () => {
    for (const a of ACCOUNTS) setAccountInRotation(a.id, false);
    const chosen = await resolve("agent-1");
    expect(chosen).not.toBeNull();
    expect(ACCOUNTS.map((a) => a.id)).toContain(chosen!.id);
    // And the ledger says the pool was empty, so this reads back as the least-bad fallback rather
    // than as an ordinary pick — the distinction someone debugging a stalled fleet needs.
    expect(ledger().at(-1)?.reason).toBe("fallback");
  });

  it("honours a preference onto the REDUNDANT half of a duplicate pair", async () => {
    // PINS THE HEADER'S ASSUMPTION WHERE THE ROUTER LIVES. `AccountsScreen` deliberately announces a
    // manual override onto a duplicate row, on the grounds that `usablePreferredAccount` does not
    // gate on duplicates and the spawns really do go there. That claim is about THIS function, and a
    // component test cannot see it — `routableDeps` stubs the preference reader, so the real gate is
    // never invoked. If a duplicate gate is added here tomorrow, the header's copy becomes false and
    // this is what fails alongside it.
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
      if (cmd === "accounts_usage") return Promise.resolve(USAGE);
      if (cmd === "accounts_identities")
        // `work` and `cloud` are ONE Claude login behind two config dirs, so `cloud` is the
        // redundant half — out of `rotationReadiness.usable`, and out of the screen's pool.
        return Promise.resolve([
          identity("def"),
          { id: "work", email: "shared@example.invalid", organization: null, accountUuid: "u-shared" },
          { id: "cloud", email: "shared@example.invalid", organization: null, accountUuid: "u-shared" },
        ]);
      if (cmd === "accounts_ceilings") return Promise.resolve([]);
      if (cmd === "accounts_record_spawn") return Promise.resolve(null);
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });
    setPreferredAccountId("cloud");
    expect((await resolve("agent-1"))?.id).toBe("cloud");
    expect(ledger().at(-1)?.reason).toBe("preferred");
  });

  it("an ACTIVATED account taken out of rotation stops winning", async () => {
    // The mirror of the pause gate. Both are fleet-level and both are the user's own choice, so the
    // tie goes to the one the screen is showing: the card says "out of rotation, you took it out",
    // and a preference that kept routing there would be the same dot-versus-router contradiction.
    setPreferredAccountId("cloud");
    expect((await resolve("agent-1"))?.id).toBe("cloud"); // the control: the preference does work
    setAccountInRotation("cloud", false);
    expect((await resolve("agent-2"))?.id).toBe("work");
  });

  it("RELOCATING agents onto an account puts it back in rotation", async () => {
    // Driven through `moveAgent`, which is the seam the two production callers actually reach — an
    // earlier cut put the flag on `setPinFromSwitch` and tested it there, where BOTH callers took the
    // same branch, so the parameter was dead and the defect reproduced unchanged. A direct-call test
    // is exactly what made it invisible the first time.
    //
    // Pins are deliberately exempt from the opt-out, which is what makes a migration onto an
    // opted-out account possible at all; the resulting state is the one this surface exists to
    // remove — the card reads "out of rotation, you took it out" while the machinery re-pins running
    // agents there.
    setAccountInRotation("cloud", false);
    expect(rotationOutIds().has("cloud")).toBe(true);

    moveAgent("agent-migrating", "cloud", () => true, true);

    expect(rotationOutIds().has("cloud")).toBe(false);
    // …and it is a REVISION, not a sweep: every other opt-out stands.
    setAccountInRotation("def", false);
    moveAgent("agent-2", "cloud", () => true, true);
    expect(rotationOutIds().has("def")).toBe(true);
  });

  it("re-pinning an agent to the account it is ALREADY on revises nothing", async () => {
    // `authRecovery.resumeAll` calls `moveAgent` with the account the agent is already on, so the
    // re-spawn cannot auto-pick a different, still-walled one. Nothing moves and nothing is said
    // about the fleet. Concretely: take A out precisely so NEW agents stop landing there, re-log-in A
    // to unstick an agent already on it, and A must not silently rejoin the pool.
    setAccountInRotation("cloud", false);
    moveAgent("agent-stuck", "cloud", () => true); // no `relocating` — the default
    expect(rotationOutIds().has("cloud")).toBe(true);
  });

  it("a per-agent pin set BY A HUMAN does not touch the pool", async () => {
    // The paired negative, and the distinction that keeps the rule narrow. `setPin` is the manual
    // per-agent override in `AgentPane`; it moves nothing and asks nothing about the fleet, so it has
    // no business revising a statement the user made about the rotation pool.
    setAccountInRotation("cloud", false);
    setPin("agent-human", "cloud");
    expect(rotationOutIds().has("cloud")).toBe(true);
    // …and the pin still wins for that one agent, which is the whole point of the exemption.
    expect((await resolve("agent-human"))?.id).toBe("cloud");
  });

  it("an explicit per-agent pin still wins over the exclusion", async () => {
    // Out of the ROTATION pool is not the same as forbidden. A human naming one agent and one
    // account is the most specific instruction on the screen and `pickAccount` honours it — the same
    // override that already covers an exhausted or never-signed-in pin.
    setAccountInRotation("cloud", false);
    setPin("agent-pinned", "cloud");
    expect((await resolve("agent-pinned"))?.id).toBe("cloud");
  });
});

describe("pausing rotation", () => {
  it("freezes new agents onto the account it was paused on", async () => {
    pauseRotation("cloud", NOW);
    // `cloud` is the BUSIEST account, so auto-pick would never choose it. Naming it proves the
    // freeze decided the outcome.
    expect((await resolve("agent-1"))?.id).toBe("cloud");
    // …and the ledger records the freeze DISTINCTLY from a preference or an ordinary pick. "The
    // founder paused the fleet" and "this account kept winning" produce identical-looking runs of
    // rows otherwise.
    expect(ledger().at(-1)).toMatchObject({ accountId: "cloud", reason: "paused" });
  });

  it("goes back to ranking by headroom when resumed", async () => {
    pauseRotation("cloud", NOW);
    expect((await resolve("agent-1"))?.id).toBe("cloud");
    resumeRotation();
    expect((await resolve("agent-2"))?.id).toBe("work");
  });

  // ── EVERY WAY THE FREEZE HAS TO FAIL SAFELY ──────────────────────────────────────────────────
  // A pause is a convenience. It is never worth a dead agent, so each of these falls through to
  // ordinary auto-pick rather than honouring a target that cannot serve.

  it("falls through to auto-pick when the frozen account was signed out", async () => {
    mockBackend({ notSignedIn: ["cloud"] });
    pauseRotation("cloud", NOW);
    expect((await resolve("agent-1"))?.id).toBe("work");
  });

  it("falls through to auto-pick when the frozen account hit a real rate limit", async () => {
    mockBackend({
      usage: USAGE.map((u) => (u.id === "cloud" ? { ...u, exhaustedUntil: FUTURE_S } : u)),
    });
    pauseRotation("cloud", NOW);
    expect((await resolve("agent-1"))?.id).toBe("work");
  });

  it("falls through to auto-pick when the frozen account no longer exists", async () => {
    pauseRotation("deleted-account", NOW);
    expect((await resolve("agent-1"))?.id).toBe("work");
  });

  it("falls through to auto-pick when paused with nothing frozen", async () => {
    pauseRotation(null, NOW);
    expect((await resolve("agent-1"))?.id).toBe("work");
  });

  it("does not move the sticky consumers — they have their own control", async () => {
    // Moving the concierge mid-conversation nulls both session pointers and re-probes. Pausing
    // ROTATION is a statement about the agent fleet; the concierge and Improve Sparkle are sticky by
    // design and are steered from their own pins in the accounts modal.
    pauseRotation("cloud", NOW);
    expect((await resolve(CONCIERGE_ACCOUNT_KEY))?.id).toBe("work");
  });

  it("taking the FROZEN account out of rotation beats the freeze", async () => {
    // ONE GESTURE produces the worst contradiction these two controls can make together: pause the
    // fleet while it is on `cloud`, then take `cloud` out from its kebab. The frozen id is routed
    // through `pickAccount`'s PIN slot, which returns a pinned account outright — before
    // `partitionAccounts` and therefore before `outOfRotationIds` — so without an explicit gate every
    // spawn keeps landing on a card that reads "out of rotation — you took it out".
    //
    // A pause names an account only as a side effect of declining to re-rank. It has no standing to
    // override a choice the user made about that account directly.
    pauseRotation("cloud", NOW);
    setAccountInRotation("cloud", false);
    expect((await resolve("agent-1"))?.id).toBe("work");
    // The paired positive is the freeze test at the top of this block: without the opt-out, the same
    // pause DOES land on `cloud`. So this is evidence about the gate, not about the freeze being
    // broken generally.
  });

  it("honours the opt-out on a sticky consumer's FIRST pick, where nothing is stranded", async () => {
    // The exemption below is about not MOVING a live session. It is not a licence to ignore the
    // user's choice when there is no session yet — and this branch is not exotic:
    // `stickySelections` is process-lifetime memory, so it runs on the concierge's first turn after
    // every single launch. Exempting the whole options object would put the concierge on `work`
    // while `work`'s own card reads "out of rotation, you took it out".
    setAccountInRotation("work", false);
    expect((await resolve(CONCIERGE_ACCOUNT_KEY))?.id).toBe("def");
  });

  it("does not relocate a sticky consumer when its account is taken out of rotation", async () => {
    // `outOfRotationIds` also reaches the branch that decides whether a sticky key KEEPS its account.
    // Relocating the concierge mid-conversation nulls both session pointers and re-probes, with no
    // stale-resume retry by design — until now only OBSERVED facts (a rate limit, real utilization)
    // could trigger that, and a menu click is not one.
    //
    // Establish the sticky key on `work` first, THEN take `work` out. Asserting on a fresh key would
    // pass whatever the exemption did, since there would be no existing account to keep.
    expect((await resolve(CONCIERGE_ACCOUNT_KEY))?.id).toBe("work");
    setAccountInRotation("work", false);
    expect((await resolve(CONCIERGE_ACCOUNT_KEY))?.id).toBe("work");
    // The paired positive, in the same state: an ORDINARY agent does move off it. Without this the
    // exemption could be doing nothing at all and the assertion above would still hold.
    expect((await resolve("agent-ordinary"))?.id).toBe("def");
  });

  it("an activated account still outranks the freeze", async () => {
    // Precedence, asserted rather than assumed. The preference is a human naming ONE account; the
    // pause is a human declining to name one. The more specific instruction wins.
    setPreferredAccountId("def");
    pauseRotation("cloud", NOW);
    expect((await resolve("agent-1"))?.id).toBe("def");
    expect(ledger().at(-1)?.reason).toBe("preferred");
  });
});
