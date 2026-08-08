// Does an account approaching its ceiling actually stop receiving new spawns — and can anyone SEE
// that it did?
//
// These tests drive the real production resolver (`chooseAccountForAgent`) against a mocked accounts
// backend and then assert on THE LEDGER LINE IT WROTE, not on the function's return value. That is
// deliberate: the founder's complaint is not that the selection rule is wrong, it is that nothing
// anywhere records which account a spawn used, so "it works" has never been checkable. A test that
// asserted `chosen.id` would pass just as happily with the ledger deleted.
//
// The near-cap pair below is the load-bearing one. This repo's most common defect is the VACUOUS
// test — an assertion already true before the change — and the specific trap here is that an account
// can be absent from the pick for reasons that have nothing to do with its ceiling (not signed in,
// already exhausted, a stale pin). So the exclusion is asserted TWICE against the same fixture:
// once with usage above the act line (excluded) and once with usage below it (chosen). Only the pair
// pins the ceiling as the cause.
import { describe, it, expect, beforeEach, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  chooseAccountForAgent,
  invalidateAccountState,
  resetStickyAccounts,
  CONCIERGE_ACCOUNT_KEY,
} from "./accountSelection";
import { clearAllPins, setPin, CEILING_AVOID_FRACTION } from "./accountStore";
import { resetSelectionLog, type SpawnLogEntry } from "./accountLedger";

const ACCOUNTS = [
  { id: "personal", nickname: "Personal", configDir: "/home/.claude", isDefault: true, createdAt: 1 },
  { id: "second", nickname: "Second", configDir: "/data/accounts/second", isDefault: false, createdAt: 2 },
];

/** Both accounts genuinely `claude login`ed — the state the founder does NOT currently have, and
 *  the precondition without which rotation cannot happen at all. */
const BOTH_SIGNED_IN = [
  { id: "personal", email: "a@example.com", organization: "Org A", accountUuid: "uuid-a" },
  { id: "second", email: "b@example.com", organization: "Org B", accountUuid: "uuid-b" },
];

const CEILING = 1_000_000;
/** Comfortably past the act line (0.9 of the learned ceiling) without being exhausted. */
const OVER_ACT_LINE = Math.ceil(CEILING * (CEILING_AVOID_FRACTION + 0.05));
/** Comfortably below it, so the ONLY difference between the paired tests is the ceiling verdict. */
const UNDER_ACT_LINE = Math.floor(CEILING * (CEILING_AVOID_FRACTION - 0.3));

function mockBackend(opts: {
  usage?: Array<{ id: string; tokens5h: number; tokens7d: number; exhaustedUntil: number | null }>;
  identities?: unknown[];
  ceilings?: Array<{ id: string; samples: number[]; ceiling: number | null }>;
}) {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
    if (cmd === "accounts_usage") return Promise.resolve(opts.usage ?? []);
    if (cmd === "accounts_identities") return Promise.resolve(opts.identities ?? BOTH_SIGNED_IN);
    if (cmd === "accounts_ceilings") return Promise.resolve(opts.ceilings ?? []);
    if (cmd === "accounts_record_spawn") return Promise.resolve(null);
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  });
}

/** Every entry the resolver wrote to the ledger, oldest first. Reads the actual IPC payload rather
 *  than a spy on our own wrapper, so a change that stopped reaching the backend would fail here. */
function recorded(): SpawnLogEntry[] {
  return invoke.mock.calls
    .filter((c) => c[0] === "accounts_record_spawn")
    .map((c) => (c[1] as { entry: SpawnLogEntry }).entry);
}

function lastEntry(): SpawnLogEntry {
  const all = recorded();
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1]!;
}

describe("the spawn ledger records which account a spawn used", () => {
  beforeEach(() => {
    invoke.mockReset();
    invalidateAccountState();
    resetStickyAccounts();
    resetSelectionLog();
    clearAllPins();
  });

  it("writes one entry per ordinary agent spawn, naming the account and the authenticated email", async () => {
    mockBackend({
      usage: [
        { id: "personal", tokens5h: 500, tokens7d: 500, exhaustedUntil: null },
        { id: "second", tokens5h: 10, tokens7d: 10, exhaustedUntil: null },
      ],
    });

    await chooseAccountForAgent("agent-1");

    const e = lastEntry();
    // The SIDE EFFECT: the ledger says which account, under which real login, and why.
    expect(e.accountId).toBe("second"); // lowest usage wins
    expect(e.nickname).toBe("Second");
    expect(e.configDir).toBe("/data/accounts/second");
    expect(e.email).toBe("b@example.com");
    expect(e.reason).toBe("auto");
    expect(e.key).toBe("agent-1");
    expect(e.signedInCount).toBe(2);
    expect(e.candidateIds).toEqual(expect.arrayContaining(["personal", "second"]));
  });

  // ── THE PAIR ─────────────────────────────────────────────────────────────────────────────────
  // Same fixture, same two signed-in accounts, same learned ceiling. The ONLY thing that differs
  // between these two tests is whether `personal` is above or below the act line.

  it("stops sending spawns to an account at its learned ceiling, and the ledger says so", async () => {
    mockBackend({
      usage: [
        // Over the act line, but NOT exhausted and with the LOWER 7d tally — so under the plain
        // lowest-usage rule this account would still win. Only the ceiling can move it.
        { id: "personal", tokens5h: OVER_ACT_LINE, tokens7d: 1, exhaustedUntil: null },
        { id: "second", tokens5h: 10, tokens7d: 999_999, exhaustedUntil: null },
      ],
      ceilings: [
        { id: "personal", samples: [CEILING, CEILING, CEILING], ceiling: CEILING },
        { id: "second", samples: [], ceiling: null },
      ],
    });

    await chooseAccountForAgent("agent-nearcap");

    const e = lastEntry();
    expect(e.accountId).toBe("second"); // moved OFF the near-cap account
    expect(e.reason).toBe("auto");
    // The near-cap account was removed from the pool — this is the proactive gate firing.
    expect(e.candidateIds).toEqual(["second"]);
    expect(e.candidateIds).not.toContain("personal");
    expect(e.eligibleCount).toBe(1);
  });

  it("…and sends them right back to that same account once it is below the line", async () => {
    mockBackend({
      usage: [
        { id: "personal", tokens5h: UNDER_ACT_LINE, tokens7d: 1, exhaustedUntil: null },
        { id: "second", tokens5h: 10, tokens7d: 999_999, exhaustedUntil: null },
      ],
      ceilings: [
        { id: "personal", samples: [CEILING, CEILING, CEILING], ceiling: CEILING },
        { id: "second", samples: [], ceiling: null },
      ],
    });

    await chooseAccountForAgent("agent-undercap");

    const e = lastEntry();
    // Identical setup to the test above except the tally — so the exclusion there was caused by the
    // ceiling and by nothing upstream of it.
    expect(e.accountId).toBe("personal");
    expect(e.candidateIds).toEqual(expect.arrayContaining(["personal", "second"]));
    expect(e.eligibleCount).toBe(2);
    // And the ledger quantifies how close it is, so a reader can see the gate coming.
    expect(e.ceiling).toBe(CEILING);
    expect(e.fraction).toBeCloseTo(UNDER_ACT_LINE / CEILING, 5);
  });

  it("records signedInCount:1 — the state in which rotation is impossible however good the rule is", async () => {
    mockBackend({
      // Only one account ever completed a `claude login`; the other is a registered-but-dead dir.
      identities: [
        { id: "personal", email: "a@example.com", organization: "Org A", accountUuid: "uuid-a" },
        { id: "second", email: null, organization: null, accountUuid: null },
      ],
      usage: [
        // The signed-in account is the BUSIER one. Under lowest-usage alone `second` would win; it
        // loses only because it cannot receive work at all.
        { id: "personal", tokens5h: 900_000, tokens7d: 900_000, exhaustedUntil: null },
        { id: "second", tokens5h: 0, tokens7d: 0, exhaustedUntil: null },
      ],
    });

    await chooseAccountForAgent("agent-lonely");

    const e = lastEntry();
    expect(e.accountId).toBe("personal");
    // THE DIAGNOSTIC THAT MAKES AN UNANIMOUS PICK LEGIBLE. Without this a reader cannot tell a
    // healthy rotation that happened to re-pick from a pool that never had an alternative.
    expect(e.signedInCount).toBe(1);
    expect(e.candidateIds).toEqual(["personal"]);
  });

  it("marks the least-bad fallback as 'fallback', not as an ordinary auto-pick", async () => {
    mockBackend({
      usage: [
        { id: "personal", tokens5h: OVER_ACT_LINE, tokens7d: 1, exhaustedUntil: null },
        { id: "second", tokens5h: OVER_ACT_LINE, tokens7d: 1, exhaustedUntil: null },
      ],
      ceilings: [
        { id: "personal", samples: [CEILING, CEILING, CEILING], ceiling: CEILING },
        { id: "second", samples: [CEILING, CEILING, CEILING], ceiling: CEILING },
      ],
    });

    await chooseAccountForAgent("agent-allspent");

    const e = lastEntry();
    // Every account is over its act line, so nothing is a healthy candidate — but a spawn still
    // happens (refusing to spawn on an ESTIMATE would let a mis-learned ceiling halt the fleet).
    expect(e.candidateIds).toEqual([]);
    expect(e.eligibleCount).toBe(0);
    expect(e.reason).toBe("fallback");
    expect(e.accountId).not.toBeNull();
  });

  it("records a pin as 'pinned', so a human override is never mistaken for the rule choosing", async () => {
    mockBackend({
      usage: [
        { id: "personal", tokens5h: 900_000, tokens7d: 900_000, exhaustedUntil: null },
        { id: "second", tokens5h: 1, tokens7d: 1, exhaustedUntil: null },
      ],
    });
    setPin("agent-pinned", "personal"); // deliberately the BUSIER account

    await chooseAccountForAgent("agent-pinned");

    const e = lastEntry();
    expect(e.accountId).toBe("personal");
    expect(e.reason).toBe("pinned");
  });
});

describe("the ledger never invents a measurement it did not take", () => {
  beforeEach(() => {
    invoke.mockReset();
    invalidateAccountState();
    resetStickyAccounts();
    resetSelectionLog();
    clearAllPins();
  });

  it("records NULL counts when the accounts backend could not be read", async () => {
    // First a healthy resolve, so this key has an account to be carried through on. BOTH usage rows
    // are given explicitly: an account with no row is treated as having zero usage — the most
    // headroom — so omitting one silently hands it the win.
    mockBackend({
      usage: [
        { id: "personal", tokens5h: 7, tokens7d: 7, exhaustedUntil: null },
        { id: "second", tokens5h: 999, tokens7d: 999, exhaustedUntil: null },
      ],
    });
    await chooseAccountForAgent("agent-hiccup");
    expect(lastEntry().reason).toBe("auto");
    expect(lastEntry().accountId).toBe("personal");

    // Now the backend goes dark. `chooseAccountForAgent` rides it out on the remembered account.
    invoke.mockReset();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "accounts_record_spawn") return Promise.resolve(null);
      return Promise.reject(new Error("backend down"));
    });
    invalidateAccountState();
    await chooseAccountForAgent("agent-hiccup");

    const e = lastEntry();
    expect(e.reason).toBe("remembered");
    expect(e.accountId).toBe("personal"); // the work still went somewhere sensible
    // THE POINT. Zeros here would state, in this file's own vocabulary, that every account was
    // exhausted (candidateIds: []), that NOBODY was signed in (signedInCount: 0) and that the
    // account was idle (tokens5h: 0) — three measurements nobody took, written as fact into the
    // record someone will later use to reconstruct what happened.
    expect(e.candidateIds).toBeNull();
    expect(e.signedInCount).toBeNull();
    expect(e.eligibleCount).toBeNull();
    expect(e.tokens5h).toBeNull();
    expect(e.fraction).toBeNull();
  });

  it("distinguishes an empty pool (measured) from an unevaluated one (not measured)", async () => {
    // The paired half of the test above: here the pool WAS evaluated and genuinely came back empty,
    // so `[]` and `0` are real findings and must survive. If both cases wrote null the log would
    // lose the ability to say "everything was spent".
    mockBackend({
      usage: [
        { id: "personal", tokens5h: OVER_ACT_LINE, tokens7d: 1, exhaustedUntil: null },
        { id: "second", tokens5h: OVER_ACT_LINE, tokens7d: 1, exhaustedUntil: null },
      ],
      ceilings: [
        { id: "personal", samples: [CEILING, CEILING, CEILING], ceiling: CEILING },
        { id: "second", samples: [CEILING, CEILING, CEILING], ceiling: CEILING },
      ],
    });
    await chooseAccountForAgent("agent-really-empty");

    const e = lastEntry();
    expect(e.candidateIds).toEqual([]); // measured, and empty
    expect(e.eligibleCount).toBe(0);
    expect(e.signedInCount).toBe(2); // still a real reading
  });

  it("does not record a FIRST-ever resolution against a dead backend as a measured zero", async () => {
    // The `remembered` branch cannot catch this: nothing has been resolved for this key yet, so
    // there is nothing to carry it, and it falls through to the ordinary path with the EMPTY
    // snapshot. `eligibleAccounts([])` cheerfully returns [] there — a MEASURED claim produced by a
    // read that never happened, byte-identical to a genuinely empty registry.
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "accounts_record_spawn") return Promise.resolve(null);
      return Promise.reject(new Error("backend down"));
    });

    await chooseAccountForAgent("agent-first-ever");

    const e = lastEntry();
    expect(e.reason).toBe("none");
    expect(e.accountId).toBeNull();
    // Unknown, not zero. A zero here would read forever after as "you have no accounts and nobody
    // is signed in" on the strength of one IPC hiccup.
    expect(e.signedInCount).toBeNull();
    expect(e.candidateIds).toBeNull();
    expect(e.eligibleCount).toBeNull();
  });

  it("records 'none' when there is no account to choose at all", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "accounts_list") return Promise.resolve([]); // nothing registered
      if (cmd === "accounts_usage") return Promise.resolve([]);
      if (cmd === "accounts_identities") return Promise.resolve([]);
      if (cmd === "accounts_ceilings") return Promise.resolve([]);
      if (cmd === "accounts_record_spawn") return Promise.resolve(null);
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });

    const { chosen } = await chooseAccountForAgent("agent-no-accounts");
    expect(chosen).toBeNull();

    const e = lastEntry();
    expect(e.reason).toBe("none");
    expect(e.accountId).toBeNull();
    // "no accounts configured" IS a measurement — the pool was read and was empty.
    expect(e.candidateIds).toEqual([]);
    expect(e.signedInCount).toBe(0);
  });
});

describe("recording is never allowed to cost a spawn", () => {
  beforeEach(() => {
    invoke.mockReset();
    invalidateAccountState();
    resetStickyAccounts();
    resetSelectionLog();
    clearAllPins();
  });

  it("resolves the right account even when the ledger command does not exist", async () => {
    // The REAL production path on any build whose Rust side predates `accounts_record_spawn`.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      invoke.mockImplementation((cmd: string) => {
        if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
        if (cmd === "accounts_usage")
          return Promise.resolve([
            { id: "personal", tokens5h: 50, tokens7d: 50, exhaustedUntil: null },
            { id: "second", tokens5h: 1, tokens7d: 1, exhaustedUntil: null },
          ]);
        if (cmd === "accounts_identities") return Promise.resolve(BOTH_SIGNED_IN);
        if (cmd === "accounts_ceilings") return Promise.resolve([]);
        // The command is absent, so Tauri rejects.
        if (cmd === "accounts_record_spawn")
          return Promise.reject(new Error("command accounts_record_spawn not found"));
        return Promise.reject(new Error(`unexpected ${cmd}`));
      });

      const { chosen } = await chooseAccountForAgent("agent-no-backend");
      // The spawn is unaffected — losing a log line must never cost an agent.
      expect(chosen?.id).toBe("second");
      // …and it did not become an unhandled rejection, which the fire-and-forget call site relies on.
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
      // A silent failure here would make the observability feature itself unobservable when broken.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/could not record which account/i);
    } finally {
      process.off("unhandledRejection", unhandled);
      warn.mockRestore();
    }
  });

  it("says it once, not once per spawn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      invoke.mockImplementation((cmd: string) => {
        if (cmd === "accounts_list") return Promise.resolve(ACCOUNTS);
        if (cmd === "accounts_usage") return Promise.resolve([]);
        if (cmd === "accounts_identities") return Promise.resolve(BOTH_SIGNED_IN);
        if (cmd === "accounts_ceilings") return Promise.resolve([]);
        return Promise.reject(new Error("nope"));
      });
      for (let i = 0; i < 5; i++) {
        invalidateAccountState();
        await chooseAccountForAgent(`agent-storm-${i}`);
      }
      await new Promise((r) => setImmediate(r));
      // A warn per rejection would flood the console during a fleet storm — which is why this was
      // silent to begin with. Once is discoverable; hundreds is noise that gets filtered out.
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the ledger does not drown in sticky-key churn", () => {
  beforeEach(() => {
    invoke.mockReset();
    invalidateAccountState();
    resetStickyAccounts();
    resetSelectionLog();
    clearAllPins();
  });

  it("logs a sticky key once, then stays quiet while its answer is unchanged", async () => {
    mockBackend({
      usage: [
        { id: "personal", tokens5h: 5, tokens7d: 5, exhaustedUntil: null },
        { id: "second", tokens5h: 10, tokens7d: 10, exhaustedUntil: null },
      ],
    });

    // The concierge resolves once per TURN. Unfiltered, that would evict every real spawn decision
    // from a capped file.
    await chooseAccountForAgent(CONCIERGE_ACCOUNT_KEY);
    invalidateAccountState();
    await chooseAccountForAgent(CONCIERGE_ACCOUNT_KEY);
    invalidateAccountState();
    await chooseAccountForAgent(CONCIERGE_ACCOUNT_KEY);

    expect(recorded()).toHaveLength(1);
    expect(recorded()[0]!.accountId).toBe("personal");
  });

  it("but DOES log the moment a sticky key moves — a sticky key moving is the rotation", async () => {
    mockBackend({
      usage: [
        { id: "personal", tokens5h: 5, tokens7d: 5, exhaustedUntil: null },
        { id: "second", tokens5h: 10, tokens7d: 10, exhaustedUntil: null },
      ],
    });
    await chooseAccountForAgent(CONCIERGE_ACCOUNT_KEY);
    expect(recorded()).toHaveLength(1);

    // Now the account it settled on hits a REAL rate limit. A sticky key moves only on observed
    // exhaustion, never on the ceiling estimate — see the asymmetry documented in `autoPick`.
    const future = Date.now() + 60 * 60 * 1000;
    mockBackend({
      usage: [
        { id: "personal", tokens5h: 5, tokens7d: 5, exhaustedUntil: future },
        { id: "second", tokens5h: 10, tokens7d: 10, exhaustedUntil: null },
      ],
    });
    invalidateAccountState();
    await chooseAccountForAgent(CONCIERGE_ACCOUNT_KEY);

    const all = recorded();
    expect(all).toHaveLength(2);
    expect(all[1]!.accountId).toBe("second"); // it moved, and the move is on the record
  });
});
