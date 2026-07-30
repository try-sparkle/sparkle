// @vitest-environment jsdom
//
// The fleet-awareness surface: the Level 0–2 ladder, and the policy asymmetry that is supposed to
// make Level 3 rare.
import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { FLEET_OPS, FLEET_RISK, fleetDigest, inboxBroadcast, inboxStatus, readAgentTranscript } from "./fleet";
import { defaultDecisionFor } from "./policy";

beforeEach(() => invoke.mockReset());

describe("risk classification", () => {
  it("classifies every op exactly once", () => {
    expect(Object.keys(FLEET_RISK).sort()).toEqual([...FLEET_OPS].sort());
  });

  it("keeps all three reads read-only", () => {
    expect(FLEET_RISK.fleet_digest).toBe("read-only");
    expect(FLEET_RISK.read_agent_stream).toBe("read-only");
    expect(FLEET_RISK.read_agent_transcript).toBe("read-only");
    expect(FLEET_RISK.inbox_status).toBe("read-only");
  });
});

describe("the asymmetry that makes Level 3 rare", () => {
  /**
   * This is the enforcement mechanism for the whole design goal "direct terminal messages become
   * rare enough to be notable". It is not achieved by asking the concierge nicely in a prompt; it
   * is achieved by making the non-interrupting channel frictionless and the interrupting one gated.
   *
   * If these two ever resolve to the SAME decision, the incentive is gone: an assistant that must
   * request approval to leave a message will reach for the terminal instead, which is exactly
   * backwards.
   */
  it("auto-allows a queued message but asks before an interrupting terminal write", () => {
    expect(defaultDecisionFor("inbox_send")).toBe("allow");
    expect(defaultDecisionFor("inbox_broadcast")).toBe("allow");
    expect(defaultDecisionFor("send_to_agent_terminal")).toBe("ask");
  });

  it("keeps the free reads free, so checking is never costlier than messaging", () => {
    // If the digest asked for approval, the concierge would message agents to find out who is
    // alive — the 240-turns-an-hour failure this whole feature exists to prevent.
    expect(defaultDecisionFor("fleet_digest")).toBe("allow");
    expect(defaultDecisionFor("read_agent_stream")).toBe("allow");
    expect(defaultDecisionFor("read_agent_transcript")).toBe("allow");
  });
});

describe("fleetDigest", () => {
  it("attaches verdicts and an escalate shortlist to the raw facts", async () => {
    const now = 1_800_000_000_000;
    invoke.mockResolvedValue({
      generatedAtMs: now,
      windowMs: 900_000,
      conflicts: [],
      agents: [
        {
          agentId: "moving",
          worktree: "/wt/moving",
          worktreeExists: true,
          hookMtimeMs: now - 1_000,
          hooks: { lastEvent: "PostToolUse", lastEventMs: now - 1_000, sessionId: null, transcriptPath: null, lastTurnEndMs: null, turnsRecent: 1, toolsRecent: 5, compactionsRecent: 0, recentTools: [], linesScanned: 9, tailTruncated: false },
          git: { ahead: 0, dirtyFiles: 0, lastCommitMs: null, branch: "b", changedFiles: [] },
          newestWriteMs: now - 1_000,
          walkTruncated: false,
          task: null,
          resultStatus: null,
        },
        {
          agentId: "stalled",
          worktree: "/wt/stalled",
          worktreeExists: true,
          hookMtimeMs: now - 45 * 60_000,
          hooks: { lastEvent: "Stop", lastEventMs: now - 45 * 60_000, sessionId: null, transcriptPath: null, lastTurnEndMs: now - 45 * 60_000, turnsRecent: 0, toolsRecent: 0, compactionsRecent: 0, recentTools: [], linesScanned: 20, tailTruncated: false },
          git: { ahead: 0, dirtyFiles: 3, lastCommitMs: null, branch: "b", changedFiles: [] },
          newestWriteMs: now - 45 * 60_000,
          walkTruncated: false,
          task: null,
          resultStatus: null,
        },
      ],
    });

    const r = await fleetDigest([
      { agentId: "moving", projectId: "p" },
      { agentId: "stalled", projectId: "p" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.verdicts.map((v) => v.progress)).toEqual(["advancing", "silent"]);
    expect(r.data.escalate).toEqual(["stalled"]);
    expect(r.risk).toBe("read-only");
  });

  it("refuses an empty agent list with a message that says what to pass", async () => {
    const r = await fleetDigest([]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("agentId");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports a malformed backend response as a refusal rather than throwing", async () => {
    // Exercises the same catch → refuse path as a rejected invoke, without handing the mock a
    // rejected promise: vitest reports a mock-produced rejection as an unhandled error even when
    // the code under test catches it, which would fail this test for a reason unrelated to the
    // behaviour being asserted. A response missing `agents` makes `verdictsFor` throw inside the
    // same try block, which is the property that matters — a bad backend reply never escapes.
    invoke.mockResolvedValue({ generatedAtMs: 1, windowMs: 1 });
    const r = await fleetDigest([{ agentId: "a", projectId: "p" }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("digest-failed");
    expect(r.message).not.toBe("");
  });
});

describe("readAgentTranscript", () => {
  it("refuses a blank path and explains where the real one comes from", async () => {
    const r = await readAgentTranscript("  ");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("transcriptPath");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("inboxBroadcast", () => {
  it("counts partial failure per recipient instead of failing the whole send", async () => {
    // One full inbox must not silently prevent the other deliveries.
    invoke.mockResolvedValue([
      { agentId: "a", messageId: "m1", error: null },
      { agentId: "b", messageId: null, error: "inbox: b already has 50 undelivered messages" },
      { agentId: "c", messageId: "m2", error: null },
    ]);
    const r = await inboxBroadcast(["a", "b", "c"], "main has moved", "act");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.queued).toBe(2);
    expect(r.data.failed).toBe(1);
  });

  it("refuses an empty recipient list", async () => {
    const r = await inboxBroadcast([], "x");
    expect(r.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("inboxStatus", () => {
  it("surfaces how many recipients have not acknowledged", async () => {
    invoke.mockResolvedValue([
      { agentId: "a", pending: 0, delivered: 1, acknowledged: 1, awaitingAck: 0, pendingIds: [] },
      { agentId: "b", pending: 0, delivered: 1, acknowledged: 0, awaitingAck: 1, pendingIds: [] },
      { agentId: "c", pending: 2, delivered: 0, acknowledged: 0, awaitingAck: 0, pendingIds: ["m1", "m2"] },
    ]);
    const r = await inboxStatus(["a", "b", "c"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.awaitingAck).toBe(1);
  });
});
