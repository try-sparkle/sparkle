// THE PROPERTY: the sweep spends nothing on nothing, and forgets nothing it saw.
//
// Every DECISION rule is already tested as arithmetic in @sparkle/core. What only exists here is
// the wiring, and its failure modes are all of one shape — a resource spent on a message that never
// arrived, or a sighting dropped so the two-observation rule never completes. Both are silent: the
// first looks like a quiet Pusher, the second looks like a healthy fleet.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  sweepPushers,
  emptyPusherState,
  startPusherRunner,
  stopPusherRunner,
  isPusherRunnerRunning,
  _resetPusherRunnerForTests,
  INBOX_CAPACITY,
  type PusherRunnerDeps,
  type PusherLogEntry,
  type PusherState,
} from "./pusherRunner";
import { resolvePusherPolicy, MESSAGES_PER_HOUR, type PartnerSnapshot } from "@sparkle/core";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

/** A partner with an expired, unmet goal — the design's highest-value trigger. */
const expired = (over: Partial<PartnerSnapshot> = {}) => ({
  agentId: "a",
  projectId: "p",
  goalSetAt: T0 - 5 * 60 * MIN,
  goalTtlMs: 4 * 60 * MIN,
  ...over,
});

function fakeDeps(over: Partial<PusherRunnerDeps> = {}) {
  const sent: Array<{ agentId: string; text: string }> = [];
  const recorded: PusherLogEntry[] = [];
  const deps: PusherRunnerDeps = {
    now: () => T0,
    policy: () => resolvePusherPolicy({}),
    ownsProject: () => true,
    snapshots: () => [expired()],
    inboxUsage: async (ids) => new Map(ids.map((id) => [id, 0])),
    send: async (agentId, text) => {
      sent.push({ agentId, text });
      return true;
    },
    record: (e) => recorded.push(e),
    ...over,
  };
  return { deps, sent, recorded };
}

/** Run n sweeps against the same deps, threading state. */
async function sweepTimes(deps: PusherRunnerDeps, n: number): Promise<PusherState> {
  let st = emptyPusherState();
  for (let i = 0; i < n; i++) st = await sweepPushers(deps, st);
  return st;
}

describe("the two-observation rule survives the wiring", () => {
  it("sends nothing on the first sweep", async () => {
    const { deps, sent } = fakeDeps();
    await sweepTimes(deps, 1);
    expect(sent).toEqual([]);
  });

  it("sends on the second, with the cited text", async () => {
    const { deps, sent } = fakeDeps();
    await sweepTimes(deps, 2);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Your goal expired");
    expect(sent[0]!.agentId).toBe("a");
  });
});

describe("nothing is spent on a message that never arrived", () => {
  // The whole reason `memoryOnDelivered` is separate from `memory`.
  it("does not spend budget when the transport fails", async () => {
    const { deps, recorded } = fakeDeps({ send: async () => false });
    // Sweep well past the point where the budget would be exhausted if failures counted.
    let st = emptyPusherState();
    for (let i = 0; i < MESSAGES_PER_HOUR + 3; i++) st = await sweepPushers(deps, st);
    const partner = st.partners.get("a")!;
    expect(partner.budget.sentAt).toEqual([]);
    // And every one of those attempts is on the record as a transport failure, not as silence.
    expect(recorded.filter((r) => r.reason === "transport-failed").length).toBeGreaterThan(1);
  });

  // ...but the SIGHTING is still recorded, or the rule never completes and the Pusher goes mute.
  //
  // The trigger set has to CHANGE on the failing cycle for this to have teeth. An earlier version
  // ran two identical sweeps, where the pre-send memory already held the right triggers — so storing
  // the stale copy passed, and the mutation survived. Here a second condition (unpushed work) comes
  // of age on the very sweep whose send fails, so the stale copy is missing it.
  it("records the FRESH sighting when the transport fails, not the pre-send copy", async () => {
    let now = T0;
    const { deps } = fakeDeps({
      now: () => now,
      send: async () => false,
      // Expired goal throughout, plus unlanded work whose clock starts on sweep 1 and matures by 2.
      snapshots: () => [expired({ hasUnlandedWork: true, unpushedCommits: 4 })],
    });

    let st = await sweepPushers(deps, emptyPusherState());
    expect(st.partners.get("a")!.lastTriggers.map((t) => t.id)).toEqual(["goal-expired"]);

    now = T0 + 30 * MIN; // unpushed-commits reaches its threshold on this sweep
    st = await sweepPushers(deps, st);

    // goal-expired was persisted and attempted; the send failed. The stored memory must still hold
    // BOTH conditions seen this cycle, or unpushed-commits can never become "seen twice".
    expect(st.partners.get("a")!.lastTriggers.map((t) => t.id).sort()).toEqual([
      "goal-expired",
      "unpushed-commits",
    ]);
    expect(st.partners.get("a")!.budget.sentAt).toEqual([]); // and still nothing spent
  });

  it("does not spend budget when a send throws", async () => {
    const { deps } = fakeDeps({
      send: async () => {
        throw new Error("pty gone");
      },
    });
    const st = await sweepTimes(deps, 3);
    expect(st.partners.get("a")!.budget.sentAt).toEqual([]);
  });
});

describe("the inbox read", () => {
  it("is batched — one call for the whole fleet", async () => {
    const inboxUsage = vi.fn(async (ids: string[]) => new Map(ids.map((i) => [i, 0])));
    const { deps } = fakeDeps({
      snapshots: () => [expired({ agentId: "a" }), expired({ agentId: "b" }), expired({ agentId: "c" })],
      inboxUsage,
    });
    await sweepTimes(deps, 1);
    expect(inboxUsage).toHaveBeenCalledTimes(1);
    expect(inboxUsage.mock.calls[0]![0]).toEqual(["a", "b", "c"]);
  });

  // A failed read is not an empty mailbox. Unknown occupancy must yield, because inbox.rs REFUSES
  // when full rather than evicting — guessing "empty" can starve the concierge's route to the
  // same builder.
  it("yields when the usage read fails", async () => {
    const { deps, sent, recorded } = fakeDeps({
      inboxUsage: async () => {
        throw new Error("ipc down");
      },
    });
    await sweepTimes(deps, 2);
    expect(sent).toEqual([]);
    expect(recorded.some((r) => r.reason === "inbox-yielding")).toBe(true);
  });

  it("yields for a partner missing from an otherwise successful read", async () => {
    const { deps, sent } = fakeDeps({ inboxUsage: async () => new Map() });
    await sweepTimes(deps, 2);
    expect(sent).toEqual([]);
  });

  it("yields on a genuinely full mailbox", async () => {
    const { deps, sent } = fakeDeps({
      inboxUsage: async (ids) => new Map(ids.map((i) => [i, INBOX_CAPACITY])),
    });
    await sweepTimes(deps, 2);
    expect(sent).toEqual([]);
  });
});

describe("scope", () => {
  it("does no work at all when disabled — not even the roster walk", async () => {
    const snapshots = vi.fn(() => [expired()]);
    const { deps } = fakeDeps({ policy: () => resolvePusherPolicy({ enabled: false }), snapshots });
    await sweepTimes(deps, 2);
    expect(snapshots).not.toHaveBeenCalled();
  });

  // Per project, exactly as the goal sweep does it — `useIsMainWindow` is a constant `true` and is
  // not a guard.
  it("skips a project this window does not own", async () => {
    const { deps, sent } = fakeDeps({ ownsProject: () => false });
    await sweepTimes(deps, 2);
    expect(sent).toEqual([]);
  });

  it("forgets a partner that left the roster", async () => {
    let roster = [expired({ agentId: "a" }), expired({ agentId: "b" })];
    const { deps } = fakeDeps({ snapshots: () => roster });
    let st = await sweepPushers(deps, emptyPusherState());
    expect([...st.partners.keys()].sort()).toEqual(["a", "b"]);
    roster = [expired({ agentId: "a" })];
    st = await sweepPushers(deps, st);
    expect([...st.partners.keys()]).toEqual(["a"]);
  });
});

describe("the log records every decision, not just the sends", () => {
  it("records a refusal with its reason", async () => {
    const { deps, recorded } = fakeDeps();
    await sweepTimes(deps, 1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      agentId: "a",
      outcome: "refused",
      reason: "no-persisted-trigger",
    });
  });

  it("records a send with the numbers it cited", async () => {
    const { deps, recorded } = fakeDeps();
    await sweepTimes(deps, 2);
    const sentEntry = recorded.find((r) => r.outcome === "sent")!;
    expect(sentEntry.triggerId).toBe("goal-expired");
    expect(sentEntry.cited?.length).toBeGreaterThan(0);
  });
});

describe("state is returned, never mutated", () => {
  it("leaves a seeded previous state intact", async () => {
    const { deps } = fakeDeps();
    const first = await sweepPushers(deps, emptyPusherState());
    const seenBefore = first.partners.get("a")!.lastTriggers.length;
    await sweepPushers(deps, first);
    expect(first.partners.get("a")!.lastTriggers.length).toBe(seenBefore);
  });
});

describe("the loop", () => {
  // `sweeping` and `state` are module-level, and the overlap test below deliberately leaves a sweep
  // in flight — so without this reset it stays `true` and every later test silently observes zero
  // ticks. Stopping the timer is not enough; the re-entry guard has to be cleared too.
  beforeEach(() => {
    stopPusherRunner();
    _resetPusherRunnerForTests();
  });
  afterEach(() => {
    stopPusherRunner();
    vi.useRealTimers();
  });

  it("does NOT tick immediately — a first sighting cannot be acted on anyway", async () => {
    vi.useFakeTimers();
    const snapshots = vi.fn(() => [expired()]);
    const { deps } = fakeDeps({ snapshots });
    startPusherRunner(deps, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(snapshots).toHaveBeenCalledTimes(1);
  });

  it("does not overlap a slow sweep with the next interval", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const snapshots = vi.fn(() => [expired()]);
    const { deps } = fakeDeps({
      snapshots,
      inboxUsage: () => new Promise((resolve) => { release = () => resolve(new Map([["a", 0]])); }),
    });
    startPusherRunner(deps, 60_000);
    await vi.advanceTimersByTimeAsync(60_000 * 4);
    expect(snapshots).toHaveBeenCalledTimes(1);
    release?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(snapshots).toHaveBeenCalledTimes(2);
  });

  it("survives a throwing sweep and keeps ticking", async () => {
    vi.useFakeTimers();
    const snapshots = vi.fn(() => {
      throw new Error("store gone");
    });
    const { deps } = fakeDeps({ snapshots });
    startPusherRunner(deps, 60_000);
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(snapshots).toHaveBeenCalledTimes(3);
  });

  it("teardown stops the loop and leaks no interval", async () => {
    vi.useFakeTimers();
    const snapshots = vi.fn(() => [expired()]);
    const { deps } = fakeDeps({ snapshots });
    const stop = startPusherRunner(deps, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    const after = snapshots.mock.calls.length;
    expect(isPusherRunnerRunning()).toBe(true);
    stop();
    expect(isPusherRunnerRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000 * 5);
    expect(snapshots).toHaveBeenCalledTimes(after);
  });

  it("restarting replaces the previous loop rather than stacking one", async () => {
    vi.useFakeTimers();
    const snapshots = vi.fn(() => [expired()]);
    const { deps } = fakeDeps({ snapshots });
    startPusherRunner(deps, 60_000);
    startPusherRunner(deps, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(snapshots).toHaveBeenCalledTimes(1);
  });
});
