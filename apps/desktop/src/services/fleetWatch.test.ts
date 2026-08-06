import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The default deps reach for the real PTY write and the real Tauri bridge. Neither exists under
// node, and the loop tests inject their own deps anyway — these mocks only keep module load clean.
const submitPrompt = vi.fn();
vi.mock("../pty", () => ({ submitPrompt: (...a: unknown[]) => submitPrompt(...a) }));
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
// A deliberately-rejecting agent logs an error; keep it out of the test output.
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { AgentTabStatus } from "@sparkle/ui";
import type { AgentKind, AgentTab, Project } from "../types";
import type { FleetAgentFacts, FleetVerdict, GitFacts, HookFacts } from "../engine/fleetVerdict";
import type { JudgedDigest, InboxStatusRow } from "./conciergeTools/fleet";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import {
  FLEET_POLL_INTERVAL_MS,
  TURN_BOUNDARY_SETTLE_MS,
  decideIdleDelivery,
  defaultFleetWatchDeps,
  draftIdleDelivery,
  isFleetWatchRunning,
  latestFleetTick,
  onFleetTick,
  pollFleetOnce,
  startFleetWatch,
  stopFleetWatch,
  type ClaimedMessage,
  type FleetWatchDeps,
} from "./fleetWatch";

const NOW = 1_700_000_000_000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** An IDLE agent by default: its most recent hook event IS its `Stop`, five minutes ago — it reached
 *  a boundary and has started nothing since. Overrides are merged field-wise into `hooks`/`git` so a
 *  test can name only the one fact it is varying. */
function facts(
  agentId: string,
  over: Partial<Omit<FleetAgentFacts, "hooks" | "git">> & {
    hooks?: Partial<HookFacts>;
    git?: Partial<GitFacts>;
  } = {},
): FleetAgentFacts {
  const { hooks, git, ...rest } = over;
  return {
    agentId,
    worktree: `/wt/${agentId}`,
    worktreeExists: true,
    hookMtimeMs: NOW - 5 * 60_000,
    newestWriteMs: null,
    walkTruncated: false,
    task: null,
    resultStatus: null,
    ...rest,
    hooks: {
      lastEvent: "Stop",
      lastEventMs: NOW - 5 * 60_000,
      sessionId: "s1",
      transcriptPath: null,
      lastTurnEndMs: NOW - 5 * 60_000,
      turnsRecent: 1,
      toolsRecent: 4,
      compactionsRecent: 0,
      recentTools: ["Edit"],
      linesScanned: 20,
      tailTruncated: false,
      ...hooks,
    },
    git: { ahead: 0, dirtyFiles: 0, lastCommitMs: null, branch: "b", changedFiles: [], ...git },
  };
}

function verdict(agentId: string, progress: FleetVerdict["progress"] = "silent"): FleetVerdict {
  return {
    agentId,
    progress,
    evidenceAgeMs: 5 * 60_000,
    evidenceSource: "hook-event",
    contradictions: [],
    shouldEscalate: progress === "silent",
    // Complete reads: this fixture's evidence is a hook event, which is never bounded. A verdict built
    // off a truncated walk or tail would set this, and `shouldEscalate` would then be true even at
    // `quiet` — see fleetVerdict's "downgrade the verdict, never the alarm" cases.
    evidenceIncomplete: false,
    reason: `${progress}: last hook event 5 minutes ago`,
  };
}

function digestOf(rows: FleetAgentFacts[], verdicts: FleetVerdict[]): JudgedDigest {
  return {
    generatedAtMs: NOW,
    windowMs: 15 * 60_000,
    agents: rows,
    conflicts: [],
    verdicts,
    escalate: verdicts.filter((v) => v.shouldEscalate).map((v) => v.agentId),
  };
}

function msg(id: string, text: string, severity: ClaimedMessage["severity"] = "fyi"): ClaimedMessage {
  return { id, ts: NOW - 1_000, from: "concierge", text, severity };
}

/** One `inbox_status` row. Only `pending` matters to this module. */
/**
 * `pendingIds` is DERIVED from `pending` so the fixture can never disagree with itself. It used to be
 * hardcoded `[]` alongside `pending: 1`, a shape the real `status_of` cannot produce — and the code
 * now discriminates on those ids, so a self-contradictory fixture would silently exercise a state
 * that does not exist. Pass explicit ids when a test needs to name them.
 */
function row(agentId: string, pending: number, pendingIds?: string[]): InboxStatusRow {
  return {
    agentId,
    pending,
    delivered: 0,
    acknowledged: 0,
    awaitingAck: 0,
    pendingIds: pendingIds ?? Array.from({ length: pending }, (_, i) => `${agentId}-m${i + 1}`),
  };
}

interface Spies {
  digest: ReturnType<typeof vi.fn>;
  inboxStatus: ReturnType<typeof vi.fn>;
  claimForIdle: ReturnType<typeof vi.fn>;
  deliver: ReturnType<typeof vi.fn>;
  liveAgents: ReturnType<typeof vi.fn>;
  observedStatus: ReturnType<typeof vi.fn>;
  publishMovement: ReturnType<typeof vi.fn>;
}

/** Deps whose every outward call is a spy, so a test asserts on SIDE EFFECTS (a claim, a write) and
 *  never merely on the inputs it handed in. */
function fakeDeps(opts: {
  agents?: string[];
  digest?: JudgedDigest;
  pending?: Record<string, number>;
  claimed?: Record<string, ClaimedMessage[]>;
  statuses?: Record<string, AgentTabStatus>;
} = {}): { deps: FleetWatchDeps; spies: Spies } {
  const ids = opts.agents ?? ["a1"];
  const spies: Spies = {
    liveAgents: vi.fn(() => ids.map((id) => ({ agentId: id, projectId: "p1" }))),
    digest: vi.fn(async () =>
      opts.digest ?? digestOf(ids.map((id) => facts(id)), ids.map((id) => verdict(id))),
    ),
    // Built through `row()` so `pendingIds` is derived from `pending` and the fixture cannot contradict
    // itself. It used to hardcode `pendingIds: []` next to `pending: 1`, which the real `status_of`
    // cannot produce — and since the code now discriminates on those ids, that shape made every claim
    // outcome resolve as if the mail had vanished.
    inboxStatus: vi.fn(
      async (agentIds: string[]): Promise<InboxStatusRow[]> =>
        agentIds.map((agentId) => row(agentId, opts.pending?.[agentId] ?? 0)),
    ),
    claimForIdle: vi.fn(async (agentId: string) => opts.claimed?.[agentId] ?? []),
    deliver: vi.fn(async () => {}),
    publishMovement: vi.fn(() => {}),
    // Defaults to a MOUNTED, resting pane for every agent, because that is the only state in which
    // delivery is even possible — an agent with no status entry has no PTY. A test that wants the
    // pane-less case passes `statuses: {}`.
    observedStatus: vi.fn(
      (agentId: string): AgentTabStatus | undefined =>
        opts.statuses === undefined ? "idle" : opts.statuses[agentId],
    ),
  };
  const deps: FleetWatchDeps = {
    now: () => NOW,
    liveAgents: spies.liveAgents as unknown as FleetWatchDeps["liveAgents"],
    digest: spies.digest as unknown as FleetWatchDeps["digest"],
    observedStatus: spies.observedStatus as unknown as FleetWatchDeps["observedStatus"],
    inboxStatus: spies.inboxStatus as unknown as FleetWatchDeps["inboxStatus"],
    claimForIdle: spies.claimForIdle as unknown as FleetWatchDeps["claimForIdle"],
    deliver: spies.deliver as unknown as FleetWatchDeps["deliver"],
    publishMovement: spies.publishMovement as unknown as FleetWatchDeps["publishMovement"],
  };
  return { deps, spies };
}

beforeEach(() => {
  vi.clearAllMocks();
  stopFleetWatch();
});

afterEach(() => {
  stopFleetWatch();
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The deliverability gate
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("decideIdleDelivery", () => {
  // `observedStatus: "idle"` is part of the BASELINE, not an extra: a live status entry is the only
  // proof this window has that a pane is mounted, and an unmounted pane means a dead PTY.
  const base = { verdict: verdict("a1"), observedStatus: "idle" as AgentTabStatus, nowMs: NOW };

  it("delivers to an agent whose last hook event IS its Stop", () => {
    expect(decideIdleDelivery({ ...base, facts: facts("a1") })).toEqual({ deliver: true });
  });

  it("refuses an agent this window has no live status for — no pane means no PTY to write to", () => {
    // `LocalTransport.detach()` IS `kill()` ("a local PTY has no life beyond its pane") and
    // Terminal.tsx detaches on unmount, so a missing status entry is the same event that killed the
    // process. The hook artifacts OUTLIVE it, so every artifact gate below passes for an agent that
    // exited hours ago — delivering would claim the message and destroy it.
    expect(
      decideIdleDelivery({ ...base, facts: facts("a1"), observedStatus: undefined }),
    ).toEqual({ deliver: false, reason: "no-live-pty" });
  });

  it("refuses an agent with no worktree — unknown is not idle", () => {
    expect(
      decideIdleDelivery({ ...base, facts: facts("a1", { worktreeExists: false }) }),
    ).toEqual({ deliver: false, reason: "no-worktree" });
  });

  it("refuses an `unobserved` verdict — nothing to look at is not the same as idle", () => {
    expect(
      decideIdleDelivery({ ...base, verdict: verdict("a1", "unobserved"), facts: facts("a1") }),
    ).toEqual({ deliver: false, reason: "unobserved" });
  });

  it("refuses when something happened AFTER the last Stop — that turn reaches its own boundary", () => {
    const d = decideIdleDelivery({
      ...base,
      facts: facts("a1", {
        hooks: { lastEvent: "PreToolUse", lastEventMs: NOW - 60_000, lastTurnEndMs: NOW - 600_000 },
      }),
    });
    expect(d).toEqual({ deliver: false, reason: "mid-turn" });
  });

  it("refuses an agent that has never reached a boundary at all", () => {
    expect(
      decideIdleDelivery({
        ...base,
        facts: facts("a1", {
          hooks: { lastEvent: "PostToolUse", lastEventMs: NOW - 600_000, lastTurnEndMs: null },
        }),
      }),
    ).toEqual({ deliver: false, reason: "never-reached-a-boundary" });
  });

  it("refuses a boundary too fresh to rule out the hook's own in-flight drain", () => {
    const at = NOW - (TURN_BOUNDARY_SETTLE_MS - 1_000);
    expect(
      decideIdleDelivery({
        ...base,
        facts: facts("a1", {
          hooks: { lastEvent: "Stop", lastEventMs: at, lastTurnEndMs: at },
        }),
      }),
    ).toEqual({ deliver: false, reason: "boundary-not-settled" });
    // ...and one tick past the settle it goes through, so the refusal is a delay, not a block.
    const older = NOW - (TURN_BOUNDARY_SETTLE_MS + 1_000);
    expect(
      decideIdleDelivery({
        ...base,
        facts: facts("a1", {
          hooks: { lastEvent: "Stop", lastEventMs: older, lastTurnEndMs: older },
        }),
      }),
    ).toEqual({ deliver: true });
  });

  it("refuses a row this window can see is holding a live question", () => {
    for (const st of ["waiting", "approval"] as AgentTabStatus[]) {
      expect(decideIdleDelivery({ ...base, facts: facts("a1"), observedStatus: st })).toEqual({
        deliver: false,
        reason: "observed-prompting",
      });
    }
  });

  it("refuses a row this window can see is not resting, and allows the resting bands", () => {
    for (const st of ["working", "done", "stopped", "errored", "new"] as AgentTabStatus[]) {
      expect(decideIdleDelivery({ ...base, facts: facts("a1"), observedStatus: st })).toEqual({
        deliver: false,
        reason: "observed-not-resting",
      });
    }
    for (const st of ["idle", "unmerged", "blocked"] as AgentTabStatus[]) {
      expect(decideIdleDelivery({ ...base, facts: facts("a1"), observedStatus: st })).toEqual({
        deliver: true,
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// One tick
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("pollFleetOnce", () => {
  it("delivers an idle agent's pending messages with exactly one claim and one write", async () => {
    const { deps, spies } = fakeDeps({
      pending: { a1: 2 },
      claimed: { a1: [msg("m1", "main has moved, rebase"), msg("m2", "own only src/x.ts", "act")] },
    });

    const tick = await pollFleetOnce(deps);

    expect(spies.claimForIdle).toHaveBeenCalledTimes(1);
    expect(spies.claimForIdle).toHaveBeenCalledWith("a1");
    expect(spies.deliver).toHaveBeenCalledTimes(1);
    const [id, text] = spies.deliver.mock.calls[0] as [string, string];
    expect(id).toBe("a1");
    // The SIDE EFFECT: both messages, their severities, and the reason it arrived this way.
    expect(text).toContain("main has moved, rebase");
    expect(text).toContain("(ACT) own only src/x.ts");
    expect(text).toContain("because you are idle");
    expect(tick.delivered).toEqual([{ agentId: "a1", messageIds: ["m1", "m2"] }]);
    expect(tick.skipped).toEqual({});
  });

  it("writes NOTHING to an idle agent with no pending messages, and never even claims", async () => {
    // The gate that stops this feature becoming an interruption machine: every idle agent on the
    // fleet is a delivery CANDIDATE, and an empty inbox must cost it nothing at all.
    const { deps, spies } = fakeDeps({ pending: { a1: 0 } });

    const tick = await pollFleetOnce(deps);

    expect(spies.claimForIdle).not.toHaveBeenCalled();
    expect(spies.deliver).not.toHaveBeenCalled();
    expect(tick.skipped).toEqual({ a1: "no-pending-messages" });
  });

  it("leaves an ADVANCING agent entirely alone even with messages queued — that is the hook's job", async () => {
    const advancing = digestOf(
      [
        facts("a1", {
          hooks: {
            lastEvent: "PostToolUse",
            lastEventMs: NOW - 3_000,
            lastTurnEndMs: NOW - 400_000,
          },
        }),
      ],
      [verdict("a1", "advancing")],
    );
    const { deps, spies } = fakeDeps({ digest: advancing, pending: { a1: 5 } });

    const tick = await pollFleetOnce(deps);

    // Not merely un-delivered: it is never even asked about, so a busy fleet costs zero inbox reads.
    expect(spies.inboxStatus).not.toHaveBeenCalled();
    expect(spies.claimForIdle).not.toHaveBeenCalled();
    expect(spies.deliver).not.toHaveBeenCalled();
    expect(tick.skipped).toEqual({ a1: "mid-turn" });
  });

  it("does not deliver a message the Stop hook already claimed", async () => {
    // `inbox_claim_for_idle` returns only what it WON. The hook won this one between our status
    // read and the claim, so there is nothing to type — a second copy would be the double-send the
    // O_EXCL claim exists to prevent. The re-read shows it is no longer pending, which is how we
    // know somebody else consumed it.
    const { deps, spies } = fakeDeps({ pending: { a1: 1 }, claimed: { a1: [] } });
    spies.inboxStatus
      .mockImplementationOnce(async () => [row("a1", 1)])
      .mockImplementationOnce(async () => [row("a1", 0)]);

    const tick = await pollFleetOnce(deps);

    expect(spies.claimForIdle).toHaveBeenCalledTimes(1);
    expect(spies.deliver).not.toHaveBeenCalled();
    expect(tick.delivered).toEqual([]);
    // Its own reason, not "no pending messages": a reader must be able to tell "somebody else has
    // it" from "there was no mail".
    expect(tick.skipped).toEqual({ a1: "already-claimed-or-expired" });
  });

  it("reports an empty claim that left the message PENDING as blocked, not as the hook winning", async () => {
    // THE MISREPORT THIS PREVENTS. `inbox.rs::claim` returns a bare bool and swallows every I/O
    // error, so an unwritable claims dir is indistinguishable from losing the O_EXCL race — and it
    // was the only reachable claim failure while being reported as "the hook has it, nothing lost".
    // That repeats every tick and tells the reader to stand down about mail that is stuck forever.
    // The discriminator is the re-read: still pending ⇒ nothing has it.
    const { deps, spies } = fakeDeps({ pending: { a1: 1 }, claimed: { a1: [] } });
    spies.inboxStatus
      .mockImplementationOnce(async () => [row("a1", 1)])
      .mockImplementationOnce(async () => [row("a1", 1)]); // still pending — nobody took it

    const tick = await pollFleetOnce(deps);

    expect(tick.skipped).toEqual({ a1: "claim-blocked" });
    expect(spies.deliver).not.toHaveBeenCalled();
    expect(tick.failed).toEqual([]); // nothing was consumed, so this is NOT a loss
  });

  it("falls back to the benign reason when the re-read itself fails — no alarm without evidence", async () => {
    const { deps, spies } = fakeDeps({ pending: { a1: 1 }, claimed: { a1: [] } });
    spies.inboxStatus
      .mockImplementationOnce(async () => [row("a1", 1)])
      .mockRejectedValueOnce(new Error("inbox unreadable"));

    const tick = await pollFleetOnce(deps);

    expect(tick.skipped).toEqual({ a1: "already-claimed-or-expired" });
  });

  it("claims each message id once across two ticks, so nothing is delivered twice", async () => {
    // The real backstop is in Rust, but the loop must not defeat it by re-offering a claimed id:
    // the second tick's claim wins nothing, so exactly one write happens for m1 in total.
    const claimed: Record<string, ClaimedMessage[]> = { a1: [msg("m1", "rebase")] };
    const { deps, spies } = fakeDeps({ pending: { a1: 1 }, claimed });

    await pollFleetOnce(deps);
    claimed.a1 = []; // the id is now claimed on disk
    await pollFleetOnce(deps);

    expect(spies.deliver).toHaveBeenCalledTimes(1);
    expect(spies.claimForIdle).toHaveBeenCalledTimes(2);
  });

  it("never claims for an agent with no live pane — the message must stay pending, not be destroyed", async () => {
    // THE LOSS THIS PREVENTS. An unmounted pane has already killed the PTY, but the hook artifacts
    // outlive the process, so every artifact gate passes. Claiming would consume the message
    // (`inbox_claim_for_idle` creates the O_EXCL claim that IS the `delivered` count), the write
    // would reject with PtyGoneError, and there is no un-claim command. Left pending, the agent
    // drains it through its own Stop hook the next time a pane resumes the session.
    const { deps, spies } = fakeDeps({
      pending: { a1: 3 },
      claimed: { a1: [msg("m1", "main has moved, rebase before verifying")] },
      statuses: {}, // no live status entry for a1 — pane closed
    });

    const tick = await pollFleetOnce(deps);

    expect(spies.claimForIdle).not.toHaveBeenCalled();
    expect(spies.deliver).not.toHaveBeenCalled();
    expect(tick.skipped).toEqual({ a1: "no-live-pty" });
  });

  it("does not claim when the pane unmounts between the inbox read and the claim", async () => {
    // The gate runs before two awaits; this is the re-read immediately before the claim. Calls 1..N
    // are the gate, so make the LAST reading the pane-less one.
    const { deps, spies } = fakeDeps({ pending: { a1: 1 }, claimed: { a1: [msg("m1", "x")] } });
    spies.observedStatus
      .mockReturnValueOnce("idle") // the gate sees a mounted pane
      .mockReturnValueOnce(undefined); // ...and it is gone by the time we would claim

    const tick = await pollFleetOnce(deps);

    expect(spies.claimForIdle).not.toHaveBeenCalled();
    expect(tick.skipped).toEqual({ a1: "no-live-pty" });
  });

  it.each([
    ["approval", "observed-prompting"],
    ["waiting", "observed-prompting"],
    ["working", "observed-not-resting"],
  ] as const)(
    "does not claim when the pane goes %s between the inbox read and the claim",
    async (becomes, reason) => {
      // The re-read must run the WHOLE status gate, not only its liveness arm. A pane that is still
      // MOUNTED but has moved to a live prompt (or back to work) would otherwise pass — a status
      // entry exists — and the write would answer a question nobody read, unrecoverably, because
      // the claim is already consumed. The window is real: for the second and later candidates it
      // spans the previous candidate's claim AND its PTY write.
      const { deps, spies } = fakeDeps({ pending: { a1: 1 }, claimed: { a1: [msg("m1", "x")] } });
      spies.observedStatus.mockReturnValueOnce("idle").mockReturnValueOnce(becomes);

      const tick = await pollFleetOnce(deps);

      expect(spies.claimForIdle).not.toHaveBeenCalled();
      expect(spies.deliver).not.toHaveBeenCalled();
      expect(tick.skipped).toEqual({ a1: reason });
    },
  );

  it("reports a FAILED CLAIM as a skip, never as consumed mail", async () => {
    // `claimForIdle` is a Tauri invoke and can reject on its own (unwritable claims dir, IPC error).
    // Nothing was consumed, so the message is still pending — putting this in `failed` would tell a
    // reader to re-send by hand a message that is still queued, producing the duplicate send the
    // O_EXCL claim exists to prevent.
    const { deps, spies } = fakeDeps({ pending: { a1: 1 }, claimed: { a1: [msg("m1", "x")] } });
    spies.claimForIdle.mockRejectedValueOnce(new Error("inbox mkdir: permission denied"));

    const tick = await pollFleetOnce(deps);

    expect(spies.deliver).not.toHaveBeenCalled();
    expect(tick.skipped).toEqual({ a1: "claim-failed" });
    expect(tick.failed).toEqual([]);
    expect(tick.delivered).toEqual([]);
  });

  it("does NOT promise the mail is still queued when a rejection consumed it", async () => {
    // `inbox_claim_for_idle` writes its O_EXCL claims DURING the filter that selects messages, so a
    // panic mid-collect or a transport failure on the response leg rejects AFTER the mail is gone. The
    // claims then exist with nothing holding the messages: status_of counts them delivered forever,
    // `pending` is 0 so no tick reconsiders them, and the Stop hook filters on is_claimed and skips
    // them too. Reporting that as plain `claim-failed` — whose documented guarantee is "still pending,
    // will be retried" — tells the reader to stand down about permanently lost mail.
    const { deps, spies } = fakeDeps({ pending: { a1: 1 }, claimed: { a1: [msg("m1", "x")] } });
    spies.inboxStatus
      .mockImplementationOnce(async () => [row("a1", 1, ["m1"])])
      .mockImplementationOnce(async () => [row("a1", 0, [])]); // m1 gone — the claim landed
    spies.claimForIdle.mockRejectedValueOnce(new Error("ipc: channel closed"));

    const tick = await pollFleetOnce(deps);

    expect(tick.skipped).toEqual({ a1: "claim-failed-possibly-consumed" });
    expect(spies.deliver).not.toHaveBeenCalled();
    expect(tick.delivered).toEqual([]);
  });

  it("treats a PARTIALLY consumed claim as consumed, not as nothing-lost", async () => {
    // The mixed shape, and the one a `some` test gets wrong. inbox_claim_for_idle consumes LAZILY --
    // it writes each O_EXCL claim as the filter's iterator advances -- so a panic mid-collect leaves a
    // PREFIX claimed and the rest pending. Here m1 was taken and m2 survived; `some` would see m2 and
    // report "nothing was consumed" while m1 is gone forever.
    const { deps, spies } = fakeDeps({ pending: { a1: 2 }, claimed: { a1: [msg("m1", "x")] } });
    spies.inboxStatus
      .mockImplementationOnce(async () => [row("a1", 2, ["m1", "m2"])])
      .mockImplementationOnce(async () => [row("a1", 1, ["m2"])]); // m1 claimed, m2 not
    spies.claimForIdle.mockRejectedValueOnce(new Error("panic mid-collect"));

    const tick = await pollFleetOnce(deps);

    expect(tick.skipped).toEqual({ a1: "claim-failed-possibly-consumed" });
  });

  it("keeps the reassuring reason only when the re-read PROVES the mail survived", async () => {
    // The control for the case above: same rejection, but m1 is still pending, so "still queued, it
    // will retry" is a claim we can actually make. Without this, the test above could pass because the
    // code always reports the alarming reason.
    const { deps, spies } = fakeDeps({ pending: { a1: 1 }, claimed: { a1: [msg("m1", "x")] } });
    spies.inboxStatus
      .mockImplementationOnce(async () => [row("a1", 1, ["m1"])])
      .mockImplementationOnce(async () => [row("a1", 1, ["m1"])]);
    spies.claimForIdle.mockRejectedValueOnce(new Error("ipc: channel closed"));

    const tick = await pollFleetOnce(deps);

    expect(tick.skipped).toEqual({ a1: "claim-failed" });
  });

  it("does not raise a permanent-stuck alarm just because unrelated mail arrived mid-tick", async () => {
    // The hook won m1 (benign), and an inbox_send or a broadcast queued m-fresh between the claim's
    // internal snapshot and our re-read. An agent-wide `pending > 0` test reads that as "still
    // pending" and flips this to `claim-blocked` — the arm logged at error, asserting "nothing has it
    // and nothing will" about mail that is being delivered right now, repeating every tick for as long
    // as new mail keeps arriving. Comparing the ids we actually tried for costs nothing and is exact.
    const { deps, spies } = fakeDeps({ pending: { a1: 1 }, claimed: { a1: [] } });
    spies.inboxStatus
      .mockImplementationOnce(async () => [row("a1", 1, ["m1"])])
      .mockImplementationOnce(async () => [row("a1", 1, ["m-fresh"])]);

    const tick = await pollFleetOnce(deps);

    expect(tick.skipped).toEqual({ a1: "already-claimed-or-expired" });
    expect(tick.failed).toEqual([]);
  });

  it("records a claimed-then-failed write in `failed`, with the ids that were consumed", async () => {
    // Neither skipped nor delivered: an agent whose mail was consumed and which received nothing
    // must not vanish from the tick, or a surface reading it shows an agent never considered.
    const { deps, spies } = fakeDeps({
      agents: ["a1", "a2"],
      pending: { a1: 1, a2: 1 },
      claimed: { a1: [msg("m1", "first")], a2: [msg("m2", "second")] },
    });
    spies.deliver.mockImplementationOnce(async () => {
      throw new Error("no such pty: a1");
    });

    const tick = await pollFleetOnce(deps);

    // One agent's failed write does not strand the next agent's message.
    expect(spies.deliver).toHaveBeenCalledTimes(2);
    expect(tick.delivered).toEqual([{ agentId: "a2", messageIds: ["m2"] }]);
    expect(tick.failed).toEqual([
      { agentId: "a1", messageIds: ["m1"], error: "no such pty: a1" },
    ]);
    expect(tick.skipped).not.toHaveProperty("a1");
  });

  it("asks about no agents at all when the roster is empty", async () => {
    const { deps, spies } = fakeDeps({ agents: [] });
    const tick = await pollFleetOnce(deps);
    expect(spies.digest).not.toHaveBeenCalled();
    expect(tick.verdicts).toEqual([]);
  });

  it("rejects when Level 0 itself is unreadable, so the caller can retry", async () => {
    const { deps, spies } = fakeDeps();
    spies.digest.mockRejectedValueOnce(new Error("digest-failed: no app data dir"));
    await expect(pollFleetOnce(deps)).rejects.toThrow("digest-failed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The loop
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("startFleetWatch", () => {
  it("polls immediately and then repeatedly on the cadence", async () => {
    vi.useFakeTimers();
    const { deps, spies } = fakeDeps();

    startFleetWatch(deps, FLEET_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(spies.digest).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(FLEET_POLL_INTERVAL_MS * 3);
    expect(spies.digest).toHaveBeenCalledTimes(4);
  });

  it("survives a throwing poll and keeps delivering afterwards", async () => {
    vi.useFakeTimers();
    const { deps, spies } = fakeDeps({
      pending: { a1: 1 },
      claimed: { a1: [msg("m1", "rebase before verifying")] },
    });
    spies.digest.mockRejectedValueOnce(new Error("worktree vanished mid-walk"));

    startFleetWatch(deps, FLEET_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(spies.deliver).not.toHaveBeenCalled();

    // The loop is still alive: the NEXT tick both runs and delivers.
    await vi.advanceTimersByTimeAsync(FLEET_POLL_INTERVAL_MS);
    expect(spies.digest).toHaveBeenCalledTimes(2);
    expect(spies.deliver).toHaveBeenCalledTimes(1);
  });

  it("does not overlap a slow tick with the next interval", async () => {
    vi.useFakeTimers();
    const { deps, spies } = fakeDeps();
    let release: (() => void) | undefined;
    spies.digest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve(digestOf([facts("a1")], [verdict("a1")]));
        }),
    );

    startFleetWatch(deps, FLEET_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(FLEET_POLL_INTERVAL_MS * 3);
    // Three intervals elapsed while the first digest was still in flight, and none of them started
    // a second one.
    expect(spies.digest).toHaveBeenCalledTimes(1);
    release?.();
    await vi.advanceTimersByTimeAsync(FLEET_POLL_INTERVAL_MS);
    expect(spies.digest).toHaveBeenCalledTimes(2);
  });

  it("teardown stops the loop and leaks no interval", async () => {
    vi.useFakeTimers();
    const { deps, spies } = fakeDeps();

    const stop = startFleetWatch(deps, FLEET_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(FLEET_POLL_INTERVAL_MS);
    const afterOne = spies.digest.mock.calls.length;
    expect(afterOne).toBeGreaterThan(0);
    expect(isFleetWatchRunning()).toBe(true);

    stop();
    expect(isFleetWatchRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(FLEET_POLL_INTERVAL_MS * 5);
    expect(spies.digest).toHaveBeenCalledTimes(afterOne);
  });

  it("never notifies a listener after teardown, even for a tick already in flight", async () => {
    vi.useFakeTimers();
    const { deps, spies } = fakeDeps();
    let release: ((d: JudgedDigest) => void) | undefined;
    spies.digest.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const seen = vi.fn();
    const off = onFleetTick(seen);

    startFleetWatch(deps, FLEET_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);
    stopFleetWatch();
    release?.(digestOf([facts("a1")], [verdict("a1")]));
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).not.toHaveBeenCalled();
    off();
  });

  it("publishes each tick to subscribers and to the latest snapshot", async () => {
    vi.useFakeTimers();
    const { deps } = fakeDeps({ pending: { a1: 1 }, claimed: { a1: [msg("m1", "hi")] } });
    const seen = vi.fn();
    const off = onFleetTick(seen);

    startFleetWatch(deps, FLEET_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toHaveBeenCalledTimes(1);
    expect(latestFleetTick()?.delivered).toEqual([{ agentId: "a1", messageIds: ["m1"] }]);
    off();
  });

  it("replaces a running watch rather than stacking a second interval", async () => {
    vi.useFakeTimers();
    const first = fakeDeps();
    const second = fakeDeps();

    startFleetWatch(first.deps, FLEET_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);
    startFleetWatch(second.deps, FLEET_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(FLEET_POLL_INTERVAL_MS * 2);

    expect(first.spies.digest).toHaveBeenCalledTimes(1);
    expect(second.spies.digest.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Copy + the default roster read
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("draftIdleDelivery", () => {
  it("numbers the messages, marks ACT vs FYI, and asks for no ack it cannot name a path for", () => {
    const text = draftIdleDelivery([msg("m1", "context only"), msg("m2", "rebase now", "act")]);
    expect(text).toContain("[1] (FYI) context only");
    expect(text).toContain("[2] (ACT) rebase now");
    expect(text).toContain("2 message(s)");
    // The hook's copy names an acks file; this path cannot resolve that path, so it must not
    // pretend to — a wrong path is worse than no instruction.
    expect(text).not.toMatch(/acks\.jsonl/);
  });
});

describe("defaultFleetWatchDeps().liveAgents", () => {
  function agent(id: string, over: Partial<AgentTab> = {}): AgentTab {
    return {
      id,
      name: id,
      kind: "build" as AgentKind,
      parentId: null,
      runtime: "local",
      worktreePath: `/wt/${id}`,
      branch: null,
      baseBranch: null,
      lastPrompt: "",
      promptHistory: [],
      namePinned: false,
      autoNameBasis: null,
      ...over,
    } as AgentTab;
  }

  it("lists only OPEN local worktree-backed agents with their project id", () => {
    const project: Project = {
      id: "p1",
      name: "P",
      rootPath: "/p",
      defaultBranch: "main",
      createdAt: "now",
      agents: [
        agent("keep"),
        agent("cloudy", { runtime: "cloud" }),
        agent("no-worktree", { worktreePath: null }),
        // The cost gate: a closed agent row from an old session is NOT digested. Four git spawns
        // plus a worktree walk per agent, every ten seconds, on a synchronous main-thread command —
        // sweeping the whole historical roster is what makes that unbounded.
        agent("closed-long-ago"),
      ],
      selectedAgentId: null,
    } as Project;
    useProjectStore.setState({ projects: [project] });
    useRuntimeStore.setState({
      openAgentIds: ["keep", "cloudy", "no-worktree"],
      status: {},
    } as never);

    expect(defaultFleetWatchDeps().liveAgents()).toEqual([{ agentId: "keep", projectId: "p1" }]);
  });
});

// ── ARTIFACT EVIDENCE OF MOVEMENT (bead sparkle-7ba9e) ─────────────────────────────────────────
//
// This loop's own job is idle delivery, but the digest it already fetches also answers "has this
// agent acted", which is the only thing that can retract a red on an agent no pane is watching.
// These cases pin that the second reading is actually PUBLISHED — an unwired publish would restore
// the latched-BLOCKED-pill bug with every other test here still green.
describe("publishing artifact movement", () => {
  it("publishes each agent's last hook event, and NOT its commits", async () => {
    const { deps, spies } = fakeDeps({
      agents: ["a1"],
      digest: digestOf(
        [facts("a1", { hooks: { lastEvent: "PostToolUse", lastEventMs: NOW - 1_000 }, git: { lastCommitMs: NOW - 9_000 } })],
        [verdict("a1")],
      ),
    });
    await pollFleetOnce(deps);
    // The COMMIT is deliberately absent: a branch tip is advanced by any process sharing the
    // worktree — including the human, in the very scenario this feature is written around — so it is
    // not attributable to the agent. See engine/movementRetraction's header.
    expect(spies.publishMovement).toHaveBeenCalledWith({
      a1: { lastEvent: "PostToolUse", lastEventMs: NOW - 1_000, sessionId: "s1" },
    });
  });

  // A tick with nothing to look at must SAY so. Leaving the previous reading standing would let a
  // retraction rest on facts about a fleet that is no longer there.
  it("publishes an empty reading when there are no live agents", async () => {
    const { deps, spies } = fakeDeps({ agents: [] });
    await pollFleetOnce(deps);
    expect(spies.publishMovement).toHaveBeenCalledWith({});
  });

  // Published from the RAW facts, before the delivery reasoning — so evidence never depends on
  // whether this loop decided to write to the agent.
  it("publishes for an agent it declined to deliver to", async () => {
    const { deps, spies } = fakeDeps({
      agents: ["a1"],
      statuses: { a1: "working" }, // observed-not-resting: no delivery
      digest: digestOf(
        [facts("a1", { hooks: { lastEvent: "PreToolUse", lastEventMs: NOW - 2_000 } })],
        [verdict("a1")],
      ),
    });
    const tick = await pollFleetOnce(deps);
    expect(tick.delivered).toEqual([]);
    expect(spies.publishMovement).toHaveBeenCalledWith({
      a1: { lastEvent: "PreToolUse", lastEventMs: NOW - 2_000, sessionId: "s1" },
    });
  });

  // WHOSE work was it? The hook log is keyed by WORKTREE, so it also holds every background one-shot
  // `claude` ever run there — and an event NAME alone cannot tell those apart from the agent's own.
  // Carrying the session across is the only way the consumer can refuse a foreign one, so a
  // projection that dropped it would silently retract live reds. See engine/movementRetraction 4(b).
  it("publishes the session the event belongs to, not just its name", async () => {
    const { deps, spies } = fakeDeps({
      agents: ["a1"],
      digest: digestOf(
        [
          facts("a1", {
            hooks: { lastEvent: "PostToolUse", lastEventMs: NOW - 1_000, sessionId: "bg-oneshot" },
          }),
        ],
        [verdict("a1")],
      ),
    });
    await pollFleetOnce(deps);
    expect(spies.publishMovement).toHaveBeenCalledWith({
      a1: { lastEvent: "PostToolUse", lastEventMs: NOW - 1_000, sessionId: "bg-oneshot" },
    });
  });
});
