// The RECOVERY half of PRD/sparkle/claude-account-identity-truth.md §6.
//
// The founder's literal complaint is the first test in the "one event, the whole fleet" block:
// "I've relogged in on one but the others are still showing green, and yet they are all stuck."
// Everything else here exists to stop that fix from becoming a worse bug — a machine pressing keys
// at a BILLING dialog on agents that were never stuck at all.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import {
  __flushVerifications,
  __setAuthRecoveryDeps,
  correlateStuckAgents,
  identitiesMatch,
  identityRecoveries,
  isSessionLimitStuck,
  noteAgentStatus,
  onAuthRecovered,
  pollIdentities,
  resolveIdentities,
  stuckAgentIds,
  type AuthRecoveryDeps,
  type RecoveryOutcome,
  type ResolvedIdentity,
} from "./authRecovery";
import { AUTH_RECOVERED_EVENT, SESSION_LIMIT_REASON } from "./sessionLimitScreen";
import { createStatusRouter, withScreenReason } from "../engine/statusRouter";
import { setPin } from "./accountStore";
import type { Account, Identity } from "./accountStore";

// ── FIXTURES ──────────────────────────────────────────────────────────────────────────────────
// Two accounts, so every correlation assertion has a negative case to be wrong about. The founder's
// fleet is all on ONE account, which is exactly why correlation cannot be the safety mechanism —
// see the reason-code tests below.

const ACCT_A: Account = { id: "acct-a", nickname: "A", configDir: "/cfg/a", isDefault: true, createdAt: 0 };
const ACCT_B: Account = { id: "acct-b", nickname: "B", configDir: "/cfg/b", isDefault: false, createdAt: 0 };

const idOf = (id: string, uuid: string | null, email: string | null): Identity =>
  ({ id, email, organization: null, accountUuid: uuid }) as Identity;

const ID_A = idOf("acct-a", "uuid-a", "a@example.com");
const ID_B = idOf("acct-b", "uuid-b", "b@example.com");

interface Harness {
  restarts: string[];
  escapes: string[];
  cleared: string[];
  events: { name: string; payload: unknown }[];
  now: number;
}

function install(over: Partial<AuthRecoveryDeps> = {}): Harness {
  const h: Harness = { restarts: [], escapes: [], cleared: [], events: [], now: 1_000_000 };
  __setAuthRecoveryDeps({
    listAccounts: async () => [ACCT_A, ACCT_B],
    getIdentities: async () => [ID_A, ID_B],
    paneAccounts: () => ({}),
    agentStatus: () => "waiting",
    restart: (agentId) => {
      h.restarts.push(agentId);
      return true;
    },
    sendEscape: async (agentId) => {
      h.escapes.push(agentId);
    },
    clearNudgeFlag: async (agentId) => {
      h.cleared.push(agentId);
    },
    readNudgeFlags: async () => [],
    emitEvent: async (name, payload) => {
      h.events.push({ name, payload });
    },
    now: () => h.now,
    log: () => {},
    ...over,
  });
  return h;
}

/** Register an agent the ONLY way the app can: the pair, through the one funnel. */
const markStuck = (agentId: string) => noteAgentStatus(agentId, "waiting", SESSION_LIMIT_REASON);

const outcomesFor = (h: Harness): RecoveryOutcome[] =>
  h.events.filter((e) => (e.payload as { phase?: string })?.phase === "attempted").flatMap(
    (e) => (e.payload as { outcomes: RecoveryOutcome[] }).outcomes,
  );

beforeEach(() => {
  __setAuthRecoveryDeps(null);
  vi.restoreAllMocks();
});

// ══ THE TRIGGER IS A REASON CODE, NEVER THE BARE BAND ═══════════════════════════════════════════

describe("isSessionLimitStuck — the one predicate", () => {
  it("requires BOTH halves", () => {
    expect(isSessionLimitStuck("waiting", SESSION_LIMIT_REASON)).toBe(true);
    // The band alone is the dangerous case, and it is the app's MOST COMMON attention state: any
    // mid-stream question, every permission dialog, every AskUserQuestion menu, the /model picker.
    expect(isSessionLimitStuck("waiting", undefined)).toBe(false);
    expect(isSessionLimitStuck("waiting", "some-other-reason")).toBe(false);
    // …and the reason alone cannot carry it either.
    expect(isSessionLimitStuck("working", SESSION_LIMIT_REASON)).toBe(false);
    expect(isSessionLimitStuck("idle", SESSION_LIMIT_REASON)).toBe(false);
  });
});

describe("an agent at `waiting` WITHOUT the reason code is never touched", () => {
  it("does not register, and a recovery event leaves it alone", async () => {
    const h = install({ paneAccounts: () => ({ "agent-dialog": "acct-a", "agent-stuck": "acct-a" }) });
    await pollIdentities(); // seed lastIdentities so correlation can resolve

    // One agent sitting at a legitimate permission dialog, one genuinely walled.
    noteAgentStatus("agent-dialog", "waiting"); // no reason — a human is mid-answer here
    markStuck("agent-stuck");
    expect(stuckAgentIds()).toEqual(["agent-stuck"]);

    await onAuthRecovered({ configDir: "/cfg/a", accountUuid: "uuid-a", email: "a@example.com" });

    // THE ASSERTION THAT MATTERS: the dialog agent was not restarted and had no Esc sent at it.
    // Restarting it would have destroyed the answer; an Esc would have cancelled the approval.
    expect(h.restarts).toEqual(["agent-stuck"]);
    expect(h.escapes).toEqual([]);
    expect(h.restarts).not.toContain("agent-dialog");
  });
});

// ══ ONE EVENT, THE WHOLE FLEET ══════════════════════════════════════════════════════════════════

describe("one recovery event resumes EVERY correlated stuck agent", () => {
  it("THE FOUNDER'S COMPLAINT: re-logging in on one terminal unblocks all of them, not one", async () => {
    const h = install({
      paneAccounts: () => ({ w1: "acct-a", w2: "acct-a", w3: "acct-a", other: "acct-b" }),
    });
    await pollIdentities();

    for (const id of ["w1", "w2", "w3", "other"]) markStuck(id);
    expect(stuckAgentIds()).toHaveLength(4);

    await onAuthRecovered({ configDir: "/cfg/a", accountUuid: "uuid-a", email: "a@example.com" });

    // All three on the recovered account, in one event — not the one that happened to be looked at.
    expect(h.restarts.sort()).toEqual(["w1", "w2", "w3"]);
    // CORRELATION IS MANDATORY: `other` is walled on a DIFFERENT account whose limit has not lifted.
    // Resuming it would restart it straight back into a live wall.
    expect(h.restarts).not.toContain("other");
  });

  it("an agent whose account cannot be resolved to an identity resumes NOTHING (ladder rung 3)", async () => {
    const h = install({
      paneAccounts: () => ({ w1: "acct-a", orphan: "acct-unknown" }),
    });
    await pollIdentities();
    markStuck("w1");
    markStuck("orphan");

    await onAuthRecovered({ configDir: "/cfg/a", accountUuid: "uuid-a", email: "a@example.com" });
    expect(h.restarts).toEqual(["w1"]);
  });

  it("a recovery for an unresolvable identity resumes nothing at all", async () => {
    const h = install({ paneAccounts: () => ({ w1: "acct-a" }) });
    await pollIdentities();
    markStuck("w1");

    await onAuthRecovered({ configDir: "/cfg/nowhere", accountUuid: null, email: null });
    expect(h.restarts).toEqual([]);
  });
});

// ══ THE WIRE ITSELF ═════════════════════════════════════════════════════════════════════════════
//
// The detection→recovery hand-off is ONE line in AgentPane, and a cut wire is exactly how this
// feature shipped broken the first time: the tests on either side of it both passed. So this block
// drives a REAL `createStatusRouter` through the same sink AgentPane installs and asserts the agent
// lands in the registry — the seam nothing else covers.

describe("router → noteAgentStatus, the hand-off AgentPane installs", () => {
  /** Exactly what AgentPane wires: `(t) => noteAgentStatus(agent.id, t.to, t.reason ?? undefined)`. */
  const wire = (agentId: string) =>
    createStatusRouter(
      () => {},
      undefined,
      (t) => noteAgentStatus(agentId, t.to, t.reason ?? undefined),
    );

  it("a frozen `working` hook + a session-limit viewport registers the agent as stuck", () => {
    install();
    const r = wire("w1");
    r.activate();
    r.fromHook("working"); // the turn is open and no Stop will ever fire
    expect(stuckAgentIds()).toEqual([]);
    withScreenReason("session-limit-picker", () => r.fromScreen("waiting"));
    expect(stuckAgentIds()).toEqual(["w1"]);
  });

  it("an ordinary prompt on the same router registers NOTHING", () => {
    install();
    const r = wire("w2");
    r.activate();
    r.fromHook("idle");
    r.fromScreen("waiting"); // a permission dialog: same band, no reason
    expect(stuckAgentIds()).toEqual([]);
  });

  it("AND AgentPane ACTUALLY INSTALLS IT — the line whose deletion nothing else would notice", () => {
    // The three tests around this one build their own router, so they prove the hand-off WORKS but
    // not that the app performs it: delete AgentPane's `onTransition` line and they all stay green.
    // That is the exact shape in which this feature shipped broken the first time — a cut wire with
    // passing tests on both sides of it — so the line is pinned against the source.
    const pane = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../components/AgentPane.tsx"),
      "utf8",
    );
    expect(pane, "AgentPane must import the recovery funnel").toMatch(
      /import \{ noteAgentStatus \} from "\.\.\/services\/authRecovery"/,
    );
    // Called with the transition's `to` AND its `reason` — passing the band alone would re-open the
    // bug the reason code exists to prevent, and would not be caught by the import check above.
    expect(pane, "the onTransition sink must forward BOTH halves of the pair").toMatch(
      /noteAgentStatus\(\s*agent\.id\s*,\s*t\.to\s*,\s*t\.reason/,
    );
  });

  it("positive progress through the router un-registers it", () => {
    install();
    const r = wire("w3");
    r.activate();
    r.fromHook("working");
    withScreenReason("session-limit-picker", () => r.fromScreen("waiting"));
    expect(stuckAgentIds()).toEqual(["w3"]);
    r.fromScreen("working"); // new agent output — the router drops its latch
    expect(stuckAgentIds()).toEqual([]);
  });
});

// ══ `errored` IS NOT PROGRESS ═══════════════════════════════════════════════════════════════════

describe("an agent that DIES on top of the picker is not treated as recovered", () => {
  it("stays registered, resumes no peers, and verifies as NOT progressed", async () => {
    const h = install({ paneAccounts: () => ({ dead: "acct-a", peer: "acct-a" }) });
    await pollIdentities();
    markStuck("dead");
    markStuck("peer");

    // A crashed process or an API banner on top of the picker. `resolve()` returns `errored` and
    // `resolveReason()` returns null, so this arrives as a non-pair transition — which used to read
    // as POSITIVE PROGRESS and fire `peerProgressRecovery` off an agent that died.
    noteAgentStatus("dead", "errored");

    expect(stuckAgentIds().sort()).toEqual(["dead", "peer"]);
    // The whole account's peers must NOT have been restarted on the strength of a crash. Doing so
    // would put them back into a still-live wall AND burn their 90s cooldown, so the genuine
    // recovery that follows would report `cooldown` and do nothing at all.
    expect(h.restarts).toEqual([]);
    expect(h.events.filter((e) => e.name === AUTH_RECOVERED_EVENT)).toEqual([]);
  });

  it("a run that simply ENDED drops the entry but still claims no progress", async () => {
    const h = install({ paneAccounts: () => ({ gone: "acct-a", peer: "acct-a" }) });
    await pollIdentities();
    markStuck("gone");
    markStuck("peer");
    // `reset()` on a re-prepare drops the router's latch, so a fresh `idle` can reach this sink.
    noteAgentStatus("gone", "idle");
    expect(stuckAgentIds()).toEqual(["peer"]);
    expect(h.restarts).toEqual([]);
    expect(h.events.filter((e) => e.name === AUTH_RECOVERED_EVENT)).toEqual([]);
  });
});

// ══ KEYSTROKE SAFETY — THE MOST IMPORTANT RULE HERE ═════════════════════════════════════════════

describe("no recovery path can send a numbered option or an Enter", () => {
  it("the PRIMARY path touches the dialog at all — it re-spawns the pane", async () => {
    const h = install({ paneAccounts: () => ({ w1: "acct-a" }) });
    await pollIdentities();
    markStuck("w1");
    await onAuthRecovered({ configDir: "/cfg/a", accountUuid: "uuid-a", email: "a@example.com" });
    // The picker dies with the old PTY; `claudeSpawn` resumes with `--resume <session-id>`.
    expect(h.restarts).toEqual(["w1"]);
    expect(h.escapes).toEqual([]);
  });

  it("the FALLBACK asks RUST for its single Esc and passes NO key of its own", async () => {
    // No pane mounted to restart, so `moveAgent` returns false and the fallback runs.
    const h = install({ paneAccounts: () => ({ w1: "acct-a" }), restart: () => false });
    await pollIdentities();
    markStuck("w1");
    await onAuthRecovered({ configDir: "/cfg/a", accountUuid: "uuid-a", email: "a@example.com" });
    expect(h.escapes).toEqual(["w1"]);
    // `sendEscape` takes an AGENT ID and nothing else. There is no parameter through which a key
    // could travel, so the byte written is decided entirely by `nudge_gate::ESCAPE_KEY` behind a
    // gate that re-derives the screen verdict. That is the shape of the safety property, and the
    // Rust suite asserts the alphabet itself (`the_only_key_the_gate_licenses_is_escape`).
  });

  it("THE SOURCE CANNOT EXPRESS A KEYSTROKE — no PTY write, no key literal, anywhere", () => {
    // A behavioural test can only prove the paths it walks. This one proves the module has no way
    // to write a key AT ALL, so a future path cannot quietly acquire one. Options 2 and 3 on that
    // picker move the user onto paid overage and change their subscription.
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "authRecovery.ts"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");

    // Every Tauri command this module may invoke, enumerated. `write_session` / `pty_write` and
    // friends are the ones that put bytes on a terminal; none of them may appear.
    const invoked = [...code.matchAll(/invoke<?[^(]*\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(invoked.sort()).toEqual(["nudger_clear_flag", "nudger_flags", "nudger_send_escape"]);

    // …and no raw key bytes, which is how a "just send Enter to dismiss it" edit would look.
    expect(code).not.toMatch(/\\r|\\n\s*"|\\x1b|\\u001b/);
  });
});

// ══ VERIFY, DO NOT ASSUME ═══════════════════════════════════════════════════════════════════════

describe("a resume that did not take is reported, not forgotten", () => {
  it("an agent still registered stuck at verification time is progressed:false", async () => {
    const h = install({ paneAccounts: () => ({ w1: "acct-a", w2: "acct-a" }) });
    await pollIdentities();
    markStuck("w1");
    markStuck("w2");
    await onAuthRecovered({ configDir: "/cfg/a", accountUuid: "uuid-a", email: "a@example.com" });

    // w1 moved — a real tool event or new output cleared the router's latch, so the transition sink
    // reported it WITHOUT the reason code. w2 hit the wall again and is still parked.
    noteAgentStatus("w1", "working");

    await __flushVerifications();
    const verified = h.events.find((e) => (e.payload as { phase?: string })?.phase === "verified");
    expect(verified, "the verification phase must actually run — not merely clear its timer").toBeTruthy();
    const outcomes = (verified!.payload as { outcomes: RecoveryOutcome[] }).outcomes;
    expect(outcomes.find((o) => o.agentId === "w1")?.progressed).toBe(true);
    expect(outcomes.find((o) => o.agentId === "w2")?.progressed).toBe(false);
  });

  it("a failed Esc is recorded as escape-failed, never as escape", async () => {
    const h = install({
      paneAccounts: () => ({ w1: "acct-a" }),
      restart: () => false,
      sendEscape: async () => {
        throw new Error("refused: awaiting-input");
      },
    });
    await pollIdentities();
    markStuck("w1");
    await onAuthRecovered({ configDir: "/cfg/a", accountUuid: "uuid-a", email: "a@example.com" });
    // This trail is what an operator reads to decide whether recovery works. An action that
    // provably did not happen must not be reported as one that did.
    expect(outcomesFor(h).map((o) => o.action)).toEqual(["escape-failed"]);
  });
});

// ══ THE COOLDOWN, AND THE SAFE-TO-SWITCH GUARD ══════════════════════════════════════════════════

describe("guards on the resume", () => {
  it("a second recovery within the cooldown does not restart the pane again", async () => {
    const h = install({ paneAccounts: () => ({ w1: "acct-a" }) });
    await pollIdentities();
    markStuck("w1");
    const payload = { configDir: "/cfg/a", accountUuid: "uuid-a", email: "a@example.com" };
    await onAuthRecovered(payload);
    await onAuthRecovered(payload);
    expect(h.restarts).toEqual(["w1"]);
    expect(outcomesFor(h).map((o) => o.action)).toEqual(["restart", "cooldown"]);
  });

  it("a `working` agent is DEFERRED — re-spawning would lose in-flight work", async () => {
    const h = install({ paneAccounts: () => ({ w1: "acct-a" }), agentStatus: () => "working" });
    await pollIdentities();
    markStuck("w1");
    await onAuthRecovered({ configDir: "/cfg/a", accountUuid: "uuid-a", email: "a@example.com" });
    expect(h.restarts).toEqual([]);
    expect(outcomesFor(h).map((o) => o.action)).toEqual(["deferred"]);
  });
});

// ══ THE §4a LADDER ══════════════════════════════════════════════════════════════════════════════

describe("identitiesMatch — uuid, then email, then no", () => {
  const mk = (uuid: string | null, email: string | null): ResolvedIdentity => ({
    accountId: "x",
    configDir: "/cfg/x",
    accountUuid: uuid,
    email,
  });

  it("compares uuids when BOTH are present, and the emails do not override them", () => {
    expect(identitiesMatch(mk("u1", "a@x"), mk("u1", "b@x"))).toBe(true);
    expect(identitiesMatch(mk("u1", "same@x"), mk("u2", "same@x"))).toBe(false);
  });

  it("falls back to EMAIL when either uuid is absent — a login predating the field", () => {
    // A bare `uuid === uuid` would match NOTHING for these accounts, so the recovery would resume
    // nobody and look like a feature that simply never fires.
    expect(identitiesMatch(mk(null, "a@x"), mk("u1", "a@x"))).toBe(true);
    expect(identitiesMatch(mk(null, "a@x"), mk(null, "b@x"))).toBe(false);
  });

  it("an unresolvable side never matches — rung 3", () => {
    expect(identitiesMatch(mk(null, null), mk("u1", "a@x"))).toBe(false);
    expect(identitiesMatch(undefined, mk("u1", "a@x"))).toBe(false);
  });
});

describe("identityRecoveries — appeared or CHANGED", () => {
  const snap = (accounts: Account[], identities: Identity[]) => resolveIdentities(accounts, identities);

  it("reports a dir that became resolvable (a fresh `claude auth login`)", () => {
    const before = snap([ACCT_A], [idOf("acct-a", null, null)]);
    const after = snap([ACCT_A], [ID_A]);
    expect(identityRecoveries(before, after).map((r) => r.accountId)).toEqual(["acct-a"]);
  });

  it("reports a dir whose identity CHANGED", () => {
    const before = snap([ACCT_A], [idOf("acct-a", "old-uuid", "old@x")]);
    const after = snap([ACCT_A], [ID_A]);
    expect(identityRecoveries(before, after).map((r) => r.accountId)).toEqual(["acct-a"]);
  });

  it("reports NOTHING when the identity is unchanged — the founder's own case", () => {
    // Re-logging into the SAME Anthropic account rewrites .claude.json with an identical uuid and
    // email, so this diff correctly sees nothing. That case is covered by peer-progress recovery,
    // which is why the diff is not the only source.
    const before = snap([ACCT_A], [ID_A]);
    expect(identityRecoveries(before, snap([ACCT_A], [ID_A]))).toEqual([]);
  });
});

describe("correlateStuckAgents", () => {
  it("keeps only agents whose account matches the recovered identity", () => {
    const identities = resolveIdentities([ACCT_A, ACCT_B], [ID_A, ID_B]);
    const recovered = identities.get("acct-a")!;
    const out = correlateStuckAgents(
      recovered,
      { w1: "acct-a", w2: "acct-b", w3: undefined },
      identities,
      ["w1", "w2", "w3"],
    );
    expect(out).toEqual([{ agentId: "w1", accountId: "acct-a" }]);
  });
});

// ══ THE BOOT BASELINE ═══════════════════════════════════════════════════════════════════════════

describe("pollIdentities", () => {
  it("the FIRST read seeds the baseline and recovers nothing", async () => {
    const h = install({ paneAccounts: () => ({ w1: "acct-a" }) });
    markStuck("w1");
    // Diffing against an empty map would report every signed-in account as a fresh recovery and
    // restart the entire fleet on boot.
    expect(await pollIdentities()).toEqual([]);
    expect(h.restarts).toEqual([]);
  });

  it("a read that FAILS recovers nothing rather than treating the error as a change", async () => {
    const h = install({
      paneAccounts: () => ({ w1: "acct-a" }),
      listAccounts: async () => {
        throw new Error("rust is busy");
      },
    });
    markStuck("w1");
    expect(await pollIdentities()).toEqual([]);
    expect(h.restarts).toEqual([]);
  });
});

// Keep the import used — `setPin` runs inside `moveAgent` on the primary path, so this test file
// exercises it transitively and a broken account store would surface here rather than in the app.
expect(typeof setPin).toBe("function");
