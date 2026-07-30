import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_AGE_MS,
  MAX_PER_AGENT,
  clearPendingSends,
  pendingSendCount,
  queuePendingSend,
  resetPendingSends,
  takePendingSends,
} from "./pendingSends";

beforeEach(() => resetPendingSends());

describe("pendingSends", () => {
  it("holds a send and hands it back oldest-first", () => {
    expect(queuePendingSend({ agentId: "a1", text: "first", userPrompt: true, humanAuthored: true, at: 1 })).toBe(true);
    expect(queuePendingSend({ agentId: "a1", text: "second", userPrompt: true, humanAuthored: true, at: 2 })).toBe(true);
    expect(pendingSendCount("a1", 10)).toBe(2);
    expect(takePendingSends("a1", 10).due.map((e) => e.text)).toEqual(["first", "second"]);
    // Taking drains the queue.
    expect(pendingSendCount("a1", 10)).toBe(0);
  });

  it("keeps each agent's queue separate", () => {
    queuePendingSend({ agentId: "a1", text: "mine", userPrompt: true, humanAuthored: true, at: 1 });
    queuePendingSend({ agentId: "a2", text: "yours", userPrompt: false, humanAuthored: false, at: 1 });
    expect(takePendingSends("a1", 2).due.map((e) => e.text)).toEqual(["mine"]);
    expect(takePendingSends("a2", 2).due.map((e) => e.text)).toEqual(["yours"]);
  });

  it("preserves the userPrompt flag across the wait", () => {
    queuePendingSend({ agentId: "a1", text: "approve", userPrompt: false, humanAuthored: false, at: 1 });
    expect(takePendingSends("a1", 2).due[0]!.userPrompt).toBe(false);
  });

  it("refuses past the per-agent cap instead of growing without bound", () => {
    for (let i = 0; i < MAX_PER_AGENT; i++) {
      expect(queuePendingSend({ agentId: "a1", text: `p${i}`, userPrompt: true, humanAuthored: true, at: 1 })).toBe(true);
    }
    expect(queuePendingSend({ agentId: "a1", text: "overflow", userPrompt: true, humanAuthored: true, at: 1 })).toBe(false);
    expect(pendingSendCount("a1", 1)).toBe(MAX_PER_AGENT);
  });

  it("separates entries that aged out so the caller can REPORT the drop", () => {
    queuePendingSend({ agentId: "a1", text: "stale", userPrompt: true, humanAuthored: true, at: 0 });
    queuePendingSend({ agentId: "a1", text: "fresh", userPrompt: true, humanAuthored: true, at: MAX_AGE_MS });
    const { due, expired } = takePendingSends("a1", MAX_AGE_MS + 1);
    expect(due.map((e) => e.text)).toEqual(["fresh"]);
    // Reported, not silently swallowed: the concierge promised to send it.
    expect(expired.map((e) => e.text)).toEqual(["stale"]);
  });

  it("expired holds do NOT count toward the cap (they'd be dropped on the next drain anyway)", () => {
    for (let i = 0; i < MAX_PER_AGENT; i++) {
      queuePendingSend({ agentId: "a1", text: `old${i}`, userPrompt: true, humanAuthored: true, at: 0 });
    }
    // Same instant as the sweep boundary + 1 → all five are stale.
    expect(queuePendingSend({ agentId: "a1", text: "new", userPrompt: true, humanAuthored: true, at: MAX_AGE_MS + 1 })).toBe(true);
    expect(pendingSendCount("a1", MAX_AGE_MS + 1)).toBe(1);
    expect(takePendingSends("a1", MAX_AGE_MS + 1).due.map((e) => e.text)).toEqual(["new"]);
  });

  it("reports what the queue-time prune dropped, oldest first and exactly once", () => {
    // The prune inside queuePendingSend used to swallow aged entries with no outcome at all — a
    // prompt the concierge had promised, vanishing (roborev 53015). It also has to be reported for
    // callers that pair state with each queued send: one silent drop and every later outcome is a
    // slot out of step, permanently.
    queuePendingSend({ agentId: "a1", text: "stale-1", userPrompt: true, humanAuthored: true, at: 0 });
    queuePendingSend({ agentId: "a1", text: "stale-2", userPrompt: true, humanAuthored: true, at: 1 });
    const dropped: string[][] = [];
    queuePendingSend(
      { agentId: "a1", text: "fresh", userPrompt: true, humanAuthored: true, at: MAX_AGE_MS + 2 },
      (d) => dropped.push(d.map((e) => e.text)),
    );
    expect(dropped).toEqual([["stale-1", "stale-2"]]);
    // …and the next queue call has nothing left to report.
    const again: string[][] = [];
    queuePendingSend(
      { agentId: "a1", text: "fresher", userPrompt: true, humanAuthored: true, at: MAX_AGE_MS + 3 },
      (d) => again.push(d.map((e) => e.text)),
    );
    expect(again).toEqual([]);
  });

  it("does not call onPruned when nothing aged out", () => {
    queuePendingSend({ agentId: "a1", text: "young", userPrompt: true, humanAuthored: true, at: 1 });
    const onPruned = vi.fn();
    queuePendingSend({ agentId: "a1", text: "also young", userPrompt: true, humanAuthored: true, at: 2 }, onPruned);
    expect(onPruned).not.toHaveBeenCalled();
  });

  it("clearPendingSends discards without delivering", () => {
    queuePendingSend({ agentId: "a1", text: "gone", userPrompt: true, humanAuthored: true, at: 1 });
    clearPendingSends("a1");
    expect(takePendingSends("a1", 2)).toEqual({ due: [], expired: [] });
  });

  it("taking from an unknown agent is empty, not a throw", () => {
    expect(takePendingSends("nobody", 1)).toEqual({ due: [], expired: [] });
  });
});
