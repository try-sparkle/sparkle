import { beforeEach, describe, expect, it } from "vitest";
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
    expect(queuePendingSend({ agentId: "a1", text: "first", userPrompt: true, at: 1 })).toBe(true);
    expect(queuePendingSend({ agentId: "a1", text: "second", userPrompt: true, at: 2 })).toBe(true);
    expect(pendingSendCount("a1", 10)).toBe(2);
    expect(takePendingSends("a1", 10).due.map((e) => e.text)).toEqual(["first", "second"]);
    // Taking drains the queue.
    expect(pendingSendCount("a1", 10)).toBe(0);
  });

  it("keeps each agent's queue separate", () => {
    queuePendingSend({ agentId: "a1", text: "mine", userPrompt: true, at: 1 });
    queuePendingSend({ agentId: "a2", text: "yours", userPrompt: false, at: 1 });
    expect(takePendingSends("a1", 2).due.map((e) => e.text)).toEqual(["mine"]);
    expect(takePendingSends("a2", 2).due.map((e) => e.text)).toEqual(["yours"]);
  });

  it("preserves the userPrompt flag across the wait", () => {
    queuePendingSend({ agentId: "a1", text: "approve", userPrompt: false, at: 1 });
    expect(takePendingSends("a1", 2).due[0]!.userPrompt).toBe(false);
  });

  it("refuses past the per-agent cap instead of growing without bound", () => {
    for (let i = 0; i < MAX_PER_AGENT; i++) {
      expect(queuePendingSend({ agentId: "a1", text: `p${i}`, userPrompt: true, at: 1 })).toBe(true);
    }
    expect(queuePendingSend({ agentId: "a1", text: "overflow", userPrompt: true, at: 1 })).toBe(false);
    expect(pendingSendCount("a1", 1)).toBe(MAX_PER_AGENT);
  });

  it("separates entries that aged out so the caller can REPORT the drop", () => {
    queuePendingSend({ agentId: "a1", text: "stale", userPrompt: true, at: 0 });
    queuePendingSend({ agentId: "a1", text: "fresh", userPrompt: true, at: MAX_AGE_MS });
    const { due, expired } = takePendingSends("a1", MAX_AGE_MS + 1);
    expect(due.map((e) => e.text)).toEqual(["fresh"]);
    // Reported, not silently swallowed: the concierge promised to send it.
    expect(expired.map((e) => e.text)).toEqual(["stale"]);
  });

  it("expired holds do NOT count toward the cap (they'd be dropped on the next drain anyway)", () => {
    for (let i = 0; i < MAX_PER_AGENT; i++) {
      queuePendingSend({ agentId: "a1", text: `old${i}`, userPrompt: true, at: 0 });
    }
    // Same instant as the sweep boundary + 1 → all five are stale.
    expect(queuePendingSend({ agentId: "a1", text: "new", userPrompt: true, at: MAX_AGE_MS + 1 })).toBe(true);
    expect(pendingSendCount("a1", MAX_AGE_MS + 1)).toBe(1);
    expect(takePendingSends("a1", MAX_AGE_MS + 1).due.map((e) => e.text)).toEqual(["new"]);
  });

  it("clearPendingSends discards without delivering", () => {
    queuePendingSend({ agentId: "a1", text: "gone", userPrompt: true, at: 1 });
    clearPendingSends("a1");
    expect(takePendingSends("a1", 2)).toEqual({ due: [], expired: [] });
  });

  it("taking from an unknown agent is empty, not a throw", () => {
    expect(takePendingSends("nobody", 1)).toEqual({ due: [], expired: [] });
  });
});
