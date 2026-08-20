import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_AGE_MS,
  MAX_PER_AGENT,
  abandonAllScreenHeldSends,
  agentIdsWithScreenHolds,
  clearScreenHeldSends,
  queueScreenHeldSend,
  reinstateScreenHeldSends,
  resetScreenHeldSends,
  screenHeldSendCount,
  screenHoldGeneration,
  sweepExpiredScreenHolds,
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

  // ══ INSERTS BY `at`, NOT APPEND-ONLY (roborev 64268's Medium) ═══════════════════════════════
  // `flushScreenHeldSends` re-queues still-due entries through this same function AFTER an
  // `await submitPrompt` — and a genuinely NEW message can be queued during that same window by a
  // separate `mountedSend` call. A plain append would put the new arrival ahead of the
  // older re-queued ones (they land after the await, the new one during it), delivering a
  // follow-up before the message it follows. Queuing out of `at` order here is exactly that
  // interleaving, collapsed to a unit test that needs no await at all.
  it("inserts by `at`, so a call arriving out of timestamp order does not jump the queue", () => {
    queueScreenHeldSend({ agentId: "a1", text: "older", userPrompt: true, humanAuthored: true, at: 1 });
    // "newer" is queued SECOND (simulating it arriving mid-flush, after "older" was re-queued in
    // program order) but its `at` is smaller only in the re-queue's replay — here we invert the
    // call order relative to `at` directly: the call for the higher `at` happens first.
    queueScreenHeldSend({ agentId: "a1", text: "newest", userPrompt: true, humanAuthored: true, at: 3 });
    queueScreenHeldSend({ agentId: "a1", text: "middle", userPrompt: true, humanAuthored: true, at: 2 });
    expect(takeScreenHeldSends("a1", 10).due.map((e) => e.text)).toEqual([
      "older",
      "middle",
      "newest",
    ]);
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

    // roborev 64238's High: a live-only view drops an agent whose entries have all expired but
    // never been SWEPT — exactly the unmount/switch-away case this feature exists to survive.
    it("includes an agent whose entries have all expired, when includeExpired is set", () => {
      queueScreenHeldSend({ agentId: "a1", text: "stale", userPrompt: true, humanAuthored: true, at: 0 });
      expect(agentIdsWithScreenHolds(MAX_AGE_MS + 1, { includeExpired: true })).toEqual(["a1"]);
      expect(agentIdsWithScreenHolds(MAX_AGE_MS + 1)).toEqual([]);
    });
  });

  describe("sweepExpiredScreenHolds", () => {
    it("removes only the expired entries, leaving live ones queued", () => {
      queueScreenHeldSend({ agentId: "a1", text: "stale", userPrompt: true, humanAuthored: true, at: 0 });
      queueScreenHeldSend({
        agentId: "a1",
        text: "fresh",
        userPrompt: true,
        humanAuthored: true,
        at: MAX_AGE_MS,
      });
      const swept = sweepExpiredScreenHolds("a1", MAX_AGE_MS + 1);
      expect(swept.map((e) => e.text)).toEqual(["stale"]);
      // The live one is still there for a later take.
      expect(takeScreenHeldSends("a1", MAX_AGE_MS + 1).due.map((e) => e.text)).toEqual(["fresh"]);
    });

    it("clears the agent entirely once every entry has expired", () => {
      queueScreenHeldSend({ agentId: "a1", text: "stale", userPrompt: true, humanAuthored: true, at: 0 });
      sweepExpiredScreenHolds("a1", MAX_AGE_MS + 1);
      expect(screenHeldSendCount("a1", MAX_AGE_MS + 1)).toBe(0);
      expect(agentIdsWithScreenHolds(MAX_AGE_MS + 1, { includeExpired: true })).toEqual([]);
    });

    it("is a no-op — and returns nothing — when nothing has expired", () => {
      queueScreenHeldSend({ agentId: "a1", text: "fresh", userPrompt: true, humanAuthored: true, at: 1 });
      expect(sweepExpiredScreenHolds("a1", 2)).toEqual([]);
      expect(screenHeldSendCount("a1", 2)).toBe(1);
    });

    it("sweeping an unknown agent is empty, not a throw", () => {
      expect(sweepExpiredScreenHolds("nobody", 1)).toEqual([]);
    });
  });

  // ══ reinstateScreenHeldSends (roborev 64289's Medium) ═══════════════════════════════════════
  describe("reinstateScreenHeldSends", () => {
    it("merges the reinstated entries with whatever queued in and keeps them ordered", () => {
      // `reinstateScreenHeldSends` evaluates staleness against the REAL clock, so timestamps here
      // are relative to a mocked `Date.now()` for consistency (see the staleness test below).
      vi.spyOn(Date, "now").mockReturnValue(10);
      try {
        // Simulates a mid-flush arrival landing in the emptied queue BEFORE the re-queue runs.
        queueScreenHeldSend({ agentId: "a1", text: "arrived-during-await", userPrompt: true, humanAuthored: true, at: 5 });
        reinstateScreenHeldSends("a1", [
          { agentId: "a1", text: "older", userPrompt: true, humanAuthored: true, at: 1 },
          { agentId: "a1", text: "middle", userPrompt: true, humanAuthored: true, at: 3 },
        ]);
        expect(takeScreenHeldSends("a1", 10).due.map((e) => e.text)).toEqual([
          "older",
          "middle",
          "arrived-during-await",
        ]);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("prefers the OLDER entries when reinstating would exceed the cap, evicting the newest", () => {
      // `reinstateScreenHeldSends` evaluates staleness against the REAL clock (finding 3 below),
      // so every timestamp in this test is relative to a mocked `Date.now()` for consistency.
      vi.spyOn(Date, "now").mockReturnValue(1000);
      try {
        // Fill the queue to the cap with mid-flush arrivals, all newer than the reinstated entry.
        for (let i = 0; i < MAX_PER_AGENT; i++) {
          queueScreenHeldSend({
            agentId: "a1",
            text: `mid-flush-${i}`,
            userPrompt: true,
            humanAuthored: true,
            at: 900 + i,
          });
        }
        const evicted: string[][] = [];
        reinstateScreenHeldSends(
          "a1",
          [{ agentId: "a1", text: "older-promised", userPrompt: true, humanAuthored: true, at: 1 }],
          (e) => evicted.push(e.map((x) => x.text)),
        );
        // The reinstated (older) entry survives; the NEWEST mid-flush arrival is what gets bumped.
        const kept = takeScreenHeldSends("a1", 1000).due.map((e) => e.text);
        expect(kept).toContain("older-promised");
        expect(kept).not.toContain(`mid-flush-${MAX_PER_AGENT - 1}`);
        expect(kept).toHaveLength(MAX_PER_AGENT);
        expect(evicted).toEqual([[`mid-flush-${MAX_PER_AGENT - 1}`]]);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("evaluates staleness against the REAL clock, not a reinstated entry's own past `at`", () => {
      // A genuinely aged mid-flush arrival sitting in the queue when reinstate runs.
      queueScreenHeldSend({ agentId: "a1", text: "stale-mid-flush", userPrompt: true, humanAuthored: true, at: 0 });
      const pruned: string[][] = [];
      vi.spyOn(Date, "now").mockReturnValue(MAX_AGE_MS + 100);
      try {
        // The reinstated entry's own `at` is deliberately IN THE PAST relative to `Date.now()` —
        // using it as "now" (the bug this test pins) would make the stale entry above read as
        // younger than "now" and therefore un-prunable. It is itself still fresh AS OF the mocked
        // clock (100ms old), which is what "reinstate, don't drop it" requires.
        reinstateScreenHeldSends(
          "a1",
          [{ agentId: "a1", text: "reinstated", userPrompt: true, humanAuthored: true, at: MAX_AGE_MS }],
          undefined,
          (d) => pruned.push(d.map((e) => e.text)),
        );
      } finally {
        vi.restoreAllMocks();
      }
      expect(pruned).toEqual([["stale-mid-flush"]]);
      expect(takeScreenHeldSends("a1", MAX_AGE_MS + 100).due.map((e) => e.text)).toEqual([
        "reinstated",
      ]);
    });

    it("is a no-op on an empty entries list", () => {
      reinstateScreenHeldSends("a1", []);
      expect(screenHeldSendCount("a1", 0)).toBe(0);
    });
  });

  // ══ Abandonment during an in-flight flush (roborev 64289's Medium) ══════════════════════════
  describe("screenHoldGeneration / abandonAllScreenHeldSends", () => {
    it("starts at 0 for an agent nothing has touched", () => {
      expect(screenHoldGeneration("nobody")).toBe(0);
    });

    it("bumps on abandonAllScreenHeldSends and returns everything that was held", () => {
      queueScreenHeldSend({ agentId: "a1", text: "one", userPrompt: true, humanAuthored: true, at: 1 });
      queueScreenHeldSend({ agentId: "a1", text: "two", userPrompt: true, humanAuthored: true, at: 2 });
      const before = screenHoldGeneration("a1");
      const held = abandonAllScreenHeldSends("a1");
      expect(held.map((e) => e.text)).toEqual(["one", "two"]);
      expect(screenHoldGeneration("a1")).toBe(before + 1);
      expect(screenHeldSendCount("a1", 10)).toBe(0);
    });

    it("bumps on clearScreenHeldSends too", () => {
      queueScreenHeldSend({ agentId: "a1", text: "x", userPrompt: true, humanAuthored: true, at: 1 });
      const before = screenHoldGeneration("a1");
      clearScreenHeldSends("a1");
      expect(screenHoldGeneration("a1")).toBe(before + 1);
    });

    it("does NOT bump on an ordinary take (a normal flush's delivery attempt)", () => {
      queueScreenHeldSend({ agentId: "a1", text: "x", userPrompt: true, humanAuthored: true, at: 1 });
      const before = screenHoldGeneration("a1");
      takeScreenHeldSends("a1", 10);
      expect(screenHoldGeneration("a1")).toBe(before);
    });

    it("abandoning an agent with nothing held still bumps the generation", () => {
      const before = screenHoldGeneration("a1");
      expect(abandonAllScreenHeldSends("a1")).toEqual([]);
      expect(screenHoldGeneration("a1")).toBe(before + 1);
    });
  });
});
