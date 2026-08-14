import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_AGE_MS,
  MAX_PER_AGENT,
  agentIdsWithScreenHolds,
  clearScreenHeldSends,
  queueScreenHeldSend,
  resetScreenHeldSends,
  screenHeldSendCount,
  takeScreenHeldSends,
} from "./screenHoldQueue";

beforeEach(() => resetScreenHeldSends());

describe("screenHoldQueue", () => {
  // THE CORRECTION THIS FILE EXISTS TO PIN: a screen hold must NOT share pendingSends' 2-minute
  // TTL. A founder waiting on a `vim` session or a long tool call routinely outlasts 2 minutes;
  // handing his message back mid-edit would be worse than the refusal this feature replaces.
  it("outlives pendingSends' 2-minute PTY-startup TTL", () => {
    expect(MAX_AGE_MS).toBeGreaterThan(2 * 60 * 1000);
    expect(MAX_AGE_MS).toBe(15 * 60 * 1000);
  });

  it("holds a send and hands it back oldest-first", () => {
    expect(
      queueScreenHeldSend({ agentId: "a1", text: "first", userPrompt: true, humanAuthored: true, at: 1 }),
    ).toBe(true);
    expect(
      queueScreenHeldSend({ agentId: "a1", text: "second", userPrompt: true, humanAuthored: true, at: 2 }),
    ).toBe(true);
    expect(screenHeldSendCount("a1", 10)).toBe(2);
    expect(takeScreenHeldSends("a1", 10).due.map((e) => e.text)).toEqual(["first", "second"]);
    expect(screenHeldSendCount("a1", 10)).toBe(0);
  });

  it("keeps each agent's queue separate", () => {
    queueScreenHeldSend({ agentId: "a1", text: "mine", userPrompt: true, humanAuthored: true, at: 1 });
    queueScreenHeldSend({ agentId: "a2", text: "yours", userPrompt: true, humanAuthored: true, at: 1 });
    expect(takeScreenHeldSends("a1", 2).due.map((e) => e.text)).toEqual(["mine"]);
    expect(takeScreenHeldSends("a2", 2).due.map((e) => e.text)).toEqual(["yours"]);
  });

  it("refuses past the per-agent cap instead of growing without bound", () => {
    for (let i = 0; i < MAX_PER_AGENT; i++) {
      expect(
        queueScreenHeldSend({ agentId: "a1", text: `p${i}`, userPrompt: true, humanAuthored: true, at: 1 }),
      ).toBe(true);
    }
    expect(
      queueScreenHeldSend({ agentId: "a1", text: "overflow", userPrompt: true, humanAuthored: true, at: 1 }),
    ).toBe(false);
    expect(screenHeldSendCount("a1", 1)).toBe(MAX_PER_AGENT);
  });

  it("separates entries that aged out so the caller can REPORT the drop", () => {
    queueScreenHeldSend({ agentId: "a1", text: "stale", userPrompt: true, humanAuthored: true, at: 0 });
    queueScreenHeldSend({
      agentId: "a1",
      text: "fresh",
      userPrompt: true,
      humanAuthored: true,
      at: MAX_AGE_MS,
    });
    const { due, expired } = takeScreenHeldSends("a1", MAX_AGE_MS + 1);
    expect(due.map((e) => e.text)).toEqual(["fresh"]);
    expect(expired.map((e) => e.text)).toEqual(["stale"]);
  });

  it("reports what the queue-time prune dropped, oldest first and exactly once", () => {
    queueScreenHeldSend({ agentId: "a1", text: "stale-1", userPrompt: true, humanAuthored: true, at: 0 });
    queueScreenHeldSend({ agentId: "a1", text: "stale-2", userPrompt: true, humanAuthored: true, at: 1 });
    const dropped: string[][] = [];
    queueScreenHeldSend(
      { agentId: "a1", text: "fresh", userPrompt: true, humanAuthored: true, at: MAX_AGE_MS + 2 },
      (d) => dropped.push(d.map((e) => e.text)),
    );
    expect(dropped).toEqual([["stale-1", "stale-2"]]);
  });

  it("does not call onPruned when nothing aged out", () => {
    queueScreenHeldSend({ agentId: "a1", text: "young", userPrompt: true, humanAuthored: true, at: 1 });
    const onPruned = vi.fn();
    queueScreenHeldSend(
      { agentId: "a1", text: "also young", userPrompt: true, humanAuthored: true, at: 2 },
      onPruned,
    );
    expect(onPruned).not.toHaveBeenCalled();
  });

  it("clearScreenHeldSends discards without delivering", () => {
    queueScreenHeldSend({ agentId: "a1", text: "gone", userPrompt: true, humanAuthored: true, at: 1 });
    clearScreenHeldSends("a1");
    expect(takeScreenHeldSends("a1", 2)).toEqual({ due: [], expired: [] });
  });

  it("taking from an unknown agent is empty, not a throw", () => {
    expect(takeScreenHeldSends("nobody", 1)).toEqual({ due: [], expired: [] });
  });

  // hooks/useScreenHoldDrain polls every agent with something held, not just the mounted one —
  // this is the enumeration it drives that poll from.
  describe("agentIdsWithScreenHolds", () => {
    it("names every agent with a LIVE hold, and nothing else", () => {
      queueScreenHeldSend({ agentId: "a1", text: "x", userPrompt: true, humanAuthored: true, at: 5 });
      queueScreenHeldSend({ agentId: "a2", text: "y", userPrompt: true, humanAuthored: true, at: 5 });
      expect(agentIdsWithScreenHolds(10).sort()).toEqual(["a1", "a2"]);
    });

    it("excludes an agent whose only holds have aged out", () => {
      queueScreenHeldSend({ agentId: "a1", text: "stale", userPrompt: true, humanAuthored: true, at: 0 });
      expect(agentIdsWithScreenHolds(MAX_AGE_MS + 1)).toEqual([]);
    });

    it("is empty when nothing is held", () => {
      expect(agentIdsWithScreenHolds()).toEqual([]);
    });
  });
});
