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
    // No recipient by default, so the per-partner cases below stay about the per-partner path. The
    // fleet report has its own block at the bottom of this file, which supplies one.
    reportRecipient: () => undefined,
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

// ── THE BATCHED FLEET REPORT ────────────────────────────────────────────────────────────────────
// The wiring half of `pusherFleet` / `pusherFleetReport`. What only exists here: that the report
// shares the per-partner `inbox_status` call, that a quota-walled partner is not challenged while
// still being OBSERVED, and that the report's budget survives a dropped send.
describe("the fleet report", () => {
  const WEEKLY = "You've hit your weekly limit · resets Aug 4 at 11pm (America/Bogota)";

  const walledSnap = (id: string) => ({
    agentId: id,
    projectId: "p",
    label: `Agent ${id}`,
    quota: { message: WEEKLY, resetAt: T0 + 4 * 60 * MIN, resetParsed: true },
  });

  const escalatedSnap = (id: string) => ({
    agentId: id,
    projectId: "p",
    label: `Agent ${id}`,
    escalation: { reason: "auto-continue gave up" },
  });

  it("delivers ONE batched report to the recipient, naming every class", async () => {
    const { deps, sent } = fakeDeps({
      snapshots: () => [walledSnap("q1"), walledSnap("q2"), escalatedSnap("e1")],
      reportRecipient: () => "concierge",
    });
    await sweepTimes(deps, 2);
    const reports = sent.filter((s) => s.agentId === "concierge");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.text).toContain("2 agents are quota-blocked");
    expect(reports[0]!.text).toContain(WEEKLY);
    expect(reports[0]!.text).toContain("1 goal is escalated");
  });

  it("reads the recipient's inbox in the SAME batched call as the partners'", async () => {
    const calls: string[][] = [];
    const { deps } = fakeDeps({
      snapshots: () => [escalatedSnap("e1")],
      reportRecipient: () => "concierge",
      inboxUsage: async (ids) => {
        calls.push(ids);
        return new Map(ids.map((id) => [id, 0]));
      },
    });
    await sweepTimes(deps, 1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["e1", "concierge"]);
  });

  it("never challenges a quota-walled partner — the message would be unreadable", async () => {
    const { deps, sent, recorded } = fakeDeps({
      // An expired goal AND a quota wall: the highest-value trigger aimed at the one partner that
      // provably cannot hear it.
      snapshots: () => [{ ...expired(), ...walledSnap("a") }],
      reportRecipient: () => undefined,
    });
    await sweepTimes(deps, 3);
    expect(sent.filter((s) => s.agentId === "a")).toEqual([]);
    expect(recorded.some((r) => r.reason === "quota-blocked")).toBe(true);
  });

  it("still records the sighting for a walled partner, so the rule is not restarted on release", async () => {
    const walledThenFree = vi
      .fn()
      .mockReturnValueOnce([{ ...expired(), ...walledSnap("a") }])
      .mockReturnValueOnce([{ ...expired(), ...walledSnap("a") }])
      .mockReturnValue([expired()]);
    const { deps, sent } = fakeDeps({ snapshots: walledThenFree, reportRecipient: () => undefined });
    await sweepTimes(deps, 3);
    // Sweep 3 is the first unwalled one. Its challenge lands immediately because sweep 2 recorded
    // the sighting; had the suppression dropped it, this would need a fourth sweep.
    expect(sent.map((s) => s.agentId)).toEqual(["a"]);
  });

  it("sends no report at all when there is no recipient", async () => {
    const { deps, sent } = fakeDeps({
      snapshots: () => [walledSnap("q1")],
      reportRecipient: () => undefined,
    });
    await sweepTimes(deps, 3);
    expect(sent).toEqual([]);
  });

  it("does not burn the first observation when there is no recipient yet", async () => {
    // Two sweeps with nobody to tell, then a recipient appears. The report must arrive on the FIRST
    // sweep that has one — the two-observation rule is about the fleet, not about the mailbox.
    let recipient: string | undefined = undefined;
    const { deps, sent } = fakeDeps({
      snapshots: () => [walledSnap("q1")],
      reportRecipient: () => recipient,
    });
    let st = emptyPusherState();
    st = await sweepPushers(deps, st);
    st = await sweepPushers(deps, st);
    recipient = "concierge";
    await sweepPushers(deps, st);
    expect(sent.map((s) => s.agentId)).toEqual(["concierge"]);
  });

  it("a dropped report costs no budget, so the next sweep retries it", async () => {
    const { deps, sent } = fakeDeps({
      snapshots: () => [escalatedSnap("e1")],
      reportRecipient: () => "concierge",
      send: async (agentId, text) => {
        sent.push({ agentId, text });
        return false; // transport refused
      },
    });
    await sweepTimes(deps, 3);
    // Two attempts (sweeps 2 and 3), neither of which spent a slot or set a cooldown.
    expect(sent).toHaveLength(2);
  });

  it("labels the report in the hit-rate log so it is not counted as a partner challenge", async () => {
    const { deps, recorded } = fakeDeps({
      // A walled agent, so the log line can be checked to carry a number that exists ONLY because
      // the banner was quoted verbatim — the citation path end-to-end, not just the label.
      snapshots: () => [walledSnap("q1")],
      reportRecipient: () => "concierge",
    });
    await sweepTimes(deps, 2);
    const fleet = recorded.filter((r) => r.scope === "fleet" && r.outcome === "sent");
    expect(fleet).toHaveLength(1);
    expect(fleet[0]!.agentId).toBe("concierge");
    expect(fleet[0]!.cited).toContain("11");
  });
});

// ── SCOPING AND OVERLAP (roborev 56908) ─────────────────────────────────────────────────────────
// Three ways the report could reach the wrong person, or reach the right person twice.
describe("the report is scoped and does not double up", () => {
  const WEEKLY2 = "You've hit your weekly limit · resets Aug 4 at 11pm (America/Bogota)";
  const escIn = (id: string, projectId: string) => ({
    agentId: id,
    projectId,
    label: `Agent ${id}`,
    escalation: { reason: "auto-continue gave up" },
  });

  it("sends ONE report per project, each to its own recipient", async () => {
    const { deps, sent } = fakeDeps({
      snapshots: () => [escIn("a", "p1"), escIn("b", "p2")],
      reportRecipient: (projectId) => (projectId === "p1" ? "boss1" : "boss2"),
    });
    await sweepTimes(deps, 2);
    expect(sent.map((s) => s.agentId).sort()).toEqual(["boss1", "boss2"]);
  });

  it("never names one project's agents to another project's recipient", async () => {
    const { deps, sent } = fakeDeps({
      snapshots: () => [escIn("alpha", "p1"), escIn("beta", "p2")],
      reportRecipient: (projectId) => (projectId === "p1" ? "boss1" : "boss2"),
    });
    await sweepTimes(deps, 2);
    const toBoss1 = sent.find((s) => s.agentId === "boss1")!;
    expect(toBoss1.text).toContain("Agent alpha");
    expect(toBoss1.text).not.toContain("Agent beta");
  });

  // One project's long-standing wall must not suppress another project's brand-new one.
  it("keeps a separate cooldown per project", async () => {
    let snaps = [escIn("a", "p1")];
    const { deps, sent } = fakeDeps({
      snapshots: () => snaps,
      reportRecipient: (projectId) => `boss-${projectId}`,
    });
    let st = emptyPusherState();
    st = await sweepPushers(deps, st);
    st = await sweepPushers(deps, st); // p1 reported
    snaps = [escIn("a", "p1"), escIn("b", "p2")];
    st = await sweepPushers(deps, st);
    await sweepPushers(deps, st); // p2 becomes eligible
    expect(sent.map((s) => s.agentId)).toEqual(["boss-p1", "boss-p2"]);
  });

  // FleetMemory.budget is separate from PartnerMemory.budget, so an agent that is both would get
  // MESSAGES_PER_HOUR of each — the containment silently doubled for exactly one agent. The fix is
  // a SHARED budget, not muting the partner channel: the report covers only the three fleet
  // conditions, so muting would leave goal-expired/unpushed/unanswered unreachable for that agent.
  it("still challenges an agent that is also the report recipient", async () => {
    const { deps, sent } = fakeDeps({
      snapshots: () => [{ ...expired(), agentId: "boss", projectId: "p" }, escIn("a", "p")],
      reportRecipient: () => "boss",
    });
    await sweepTimes(deps, 2);
    const texts = sent.filter((s) => s.agentId === "boss").map((s) => s.text);
    // Its own expired goal AND the fleet report — neither channel is muted by the other.
    expect(texts.some((t) => t.includes("Your goal expired"))).toBe(true);
    expect(texts.some((t) => t.includes("escalated"))).toBe(true);
  });

  // TWO DIRECTIONS, TWO TESTS. A `<= MESSAGES_PER_HOUR` assertion looks like it covers this and does
  // not: both triggers here LATCH, so each channel sends once and stops well short of the cap — the
  // "not shared" mutation passes it untouched. These assert the mechanism instead.
  it("a partner's spent budget is visible to the fleet report", async () => {
    const { deps, recorded } = fakeDeps({
      snapshots: () => [{ ...expired(), agentId: "boss", projectId: "p" }, escIn("a", "p")],
      reportRecipient: () => "boss",
    });
    const st = await sweepPushers(deps, emptyPusherState()); // first sighting
    // The recipient has already spent its whole hour on the per-partner channel.
    st.partners.set("boss", {
      ...st.partners.get("boss")!,
      budget: { sentAt: Array.from({ length: MESSAGES_PER_HOUR }, (_, i) => T0 - i - 1) },
    });
    await sweepPushers(deps, st);
    const fleet = recorded.filter((r) => r.scope === "fleet");
    expect(fleet.some((r) => r.reason === "budget-exhausted")).toBe(true);
  });

  it("a delivered report is visible to the partner channel", async () => {
    const { deps, recorded } = fakeDeps({
      snapshots: () => [{ ...expired(), agentId: "boss", projectId: "p" }, escIn("a", "p")],
      reportRecipient: () => "boss",
    });
    let st = await sweepPushers(deps, emptyPusherState());
    // The report channel has already spent the whole hour.
    st = { ...st, fleet: new Map(st.fleet) };
    st.fleet.set("p", {
      ...(st.fleet.get("p") ?? { lastConditions: [], budget: { sentAt: [] }, lastReported: {} }),
      budget: { sentAt: Array.from({ length: MESSAGES_PER_HOUR }, (_, i) => T0 - i - 1) },
    });
    await sweepPushers(deps, st);
    // ...so the PARTNER channel refuses too — asserted through the refusal rather than through a
    // stored ledger, because which ledger holds it is exactly what changed (roborev 57040).
    expect(
      recorded.some(
        (r) => r.agentId === "boss" && r.scope !== "fleet" && r.reason === "budget-exhausted",
      ),
    ).toBe(true);
  });

  // THE SHARED BOUND IS KEYED BY AGENT, NOT BY THE AGENT'S OWN PROJECT (roborev 57043).
  // `reportRecipient(projectId)` may name an agent living in a different project, and may name the
  // same agent for several — so a merge that looks up only `s.projectId` lets that agent take
  // MESSAGES_PER_HOUR challenges PLUS MESSAGES_PER_HOUR reports. Both directions are asserted,
  // because the merge is built independently on each side.
  const crossProject = () =>
    fakeDeps({
      // `boss` lives in p1 but is the recipient for p2.
      snapshots: () => [{ ...expired(), agentId: "boss", projectId: "p1" }, escIn("a", "p2")],
      reportRecipient: (projectId) => (projectId === "p2" ? "boss" : undefined),
    });

  it("a cross-project recipient's own challenges count against its reports", async () => {
    const { deps, recorded } = crossProject();
    const st = await sweepPushers(deps, emptyPusherState());
    st.partners.set("boss", {
      ...(st.partners.get("boss") ?? { lastTriggers: [], budget: { sentAt: [] }, lastChallengedAt: {} }),
      budget: { sentAt: Array.from({ length: MESSAGES_PER_HOUR }, (_, i) => T0 - i - 1) },
    });
    await sweepPushers(deps, st);
    expect(
      recorded.some((r) => r.scope === "fleet" && r.reason === "budget-exhausted"),
    ).toBe(true);
  });

  it("a cross-project recipient's reports count against its own challenges", async () => {
    const { deps, recorded } = crossProject();
    let st = await sweepPushers(deps, emptyPusherState());
    st = { ...st, fleet: new Map(st.fleet) };
    st.fleet.set("p2", {
      lastConditions: st.fleet.get("p2")?.lastConditions ?? [],
      lastReported: {},
      budget: { sentAt: Array.from({ length: MESSAGES_PER_HOUR }, (_, i) => T0 - i - 1) },
    });
    await sweepPushers(deps, st);
    expect(
      recorded.some(
        (r) => r.agentId === "boss" && r.scope !== "fleet" && r.reason === "budget-exhausted",
      ),
    ).toBe(true);
  });

  // ...and the same agent may be the recipient for SEVERAL projects, in which case one project's
  // reports must count against another's. Without that, N projects buy N x MESSAGES_PER_HOUR
  // interruptions for one reader.
  it("one recipient serving two projects shares a single hourly bound", async () => {
    const { deps, sent, recorded } = fakeDeps({
      snapshots: () => [escIn("a", "p1"), escIn("b", "p2")],
      reportRecipient: () => "boss", // not a partner at all — just the reader for both projects
    });
    let st = await sweepPushers(deps, emptyPusherState());
    st = { ...st, fleet: new Map(st.fleet) };
    // p1's report channel has spent the hour.
    st.fleet.set("p1", {
      lastConditions: st.fleet.get("p1")?.lastConditions ?? [],
      lastReported: {},
      budget: { sentAt: Array.from({ length: MESSAGES_PER_HOUR }, (_, i) => T0 - i - 1) },
    });
    await sweepPushers(deps, st);
    // p2 must see p1's spend: nothing reaches boss, and both projects report the same reason.
    expect(sent).toEqual([]);
    expect(
      recorded.filter((r) => r.scope === "fleet" && r.reason === "budget-exhausted"),
    ).toHaveLength(2);
  });

  // THE LEDGER SURVIVING IS WORTH NOTHING IF THE LOOKUP DOES NOT (roborev 57047). `FleetMemory` is
  // never pruned, but the recipient map that finds it was built from THIS sweep's projects — so one
  // sweep where a project contributed zero owned snapshots made its spend invisible. Every other
  // test here keeps all projects present on every sweep, which is exactly why none of them saw it.
  it("holds the bound when the reporting project drops out of the roster for a sweep", async () => {
    let p2Present = true;
    const { deps, recorded } = fakeDeps({
      snapshots: () =>
        p2Present
          ? [{ ...expired(), agentId: "boss", projectId: "p1" }, escIn("a", "p2")]
          : [{ ...expired(), agentId: "boss", projectId: "p1" }],
      reportRecipient: (projectId) => (projectId === "p2" ? "boss" : undefined),
    });
    let st = await sweepPushers(deps, emptyPusherState());
    st = { ...st, fleet: new Map(st.fleet) };
    // p2's report channel has spent its whole hour.
    st.fleet.set("p2", {
      lastConditions: st.fleet.get("p2")?.lastConditions ?? [],
      lastReported: {},
      budget: { sentAt: Array.from({ length: MESSAGES_PER_HOUR }, (_, i) => T0 - i - 1) },
    });

    p2Present = false; // a partial read, or the ownsProject election flipping
    await sweepPushers(deps, st);

    // boss's own challenge must still be refused: the spend is on p2's ledger, which is not pruned,
    // and the aggregate has to keep looking there even though p2 sent no snapshots this sweep.
    expect(
      recorded.some(
        (r) => r.agentId === "boss" && r.scope !== "fleet" && r.reason === "budget-exhausted",
      ),
    ).toBe(true);
  });

  // The report channel's bound must survive roster churn. `partners` is pruned every sweep for any
  // agent absent from `owned`, so parking the report's only send record there let one partial
  // snapshots() read reset the containment and allow 8 interruptions in an hour instead of 4.
  it("keeps the report channel's spend when the recipient briefly leaves the roster", async () => {
    let present = true;
    const { deps, sent } = fakeDeps({
      snapshots: () =>
        present
          ? [{ agentId: "boss", projectId: "p", label: "Boss" }, escIn("a", "p")]
          : [escIn("a", "p")],
      reportRecipient: () => "boss",
    });
    let st = emptyPusherState();
    st = await sweepPushers(deps, st);
    st = await sweepPushers(deps, st); // one report delivered
    expect(sent.filter((s) => s.agentId === "boss")).toHaveLength(1);

    present = false; // a partial read drops boss from the roster for one sweep
    st = await sweepPushers(deps, st);
    present = true;

    // The condition has not grown, so nothing new is owed — and the earlier spend must still be on
    // the books rather than reset by the absence.
    st = await sweepPushers(deps, st);
    expect(st.fleet.get("p")!.budget.sentAt).toHaveLength(1);
  });

  // ONE LEDGER, NOT TWO. Recording a delivered report on BOTH the fleet and partner budgets looks
  // symmetric, but the merged view is a plain concatenation — so every later sweep counts that one
  // send twice and the report channel exhausts after 2 messages an hour instead of 4 (roborev
  // 57039). Silent under-reporting, on the channel that exists because under-reporting cost hours.
  //
  // The recipient here has NO per-partner triggers of its own, so every message counted is a report;
  // membership grows each sweep, which is what re-opens the cooldown so reports keep coming.
  it("does not count a delivered report twice against its own budget", async () => {
    let n = 0;
    const { deps, sent } = fakeDeps({
      snapshots: () => [
        { agentId: "boss", projectId: "p", label: "Boss" },
        ...Array.from({ length: ++n }, (_, i) => escIn(`e${i}`, "p")),
      ],
      reportRecipient: () => "boss",
    });
    let st = emptyPusherState();
    for (let i = 0; i < MESSAGES_PER_HOUR + 4; i++) st = await sweepPushers(deps, st);
    // The full hourly allowance, not half of it.
    expect(sent.filter((s) => s.agentId === "boss")).toHaveLength(MESSAGES_PER_HOUR);
  });

  // `reportRecipient(projectId)` is not required to name an agent inside that project.
  it("checks the wall for a recipient that lives in a DIFFERENT project", async () => {
    const { deps, sent, recorded } = fakeDeps({
      snapshots: () => [
        {
          agentId: "boss",
          projectId: "p1",
          label: "Boss",
          quota: { message: WEEKLY2, resetAt: T0 + 4 * 60 * MIN, resetParsed: true },
        },
        escIn("a", "p2"),
      ],
      // p2's recipient lives in p1 — the per-project slice would never have seen its wall.
      reportRecipient: (projectId) => (projectId === "p2" ? "boss" : undefined),
    });
    await sweepTimes(deps, 3);
    expect(sent).toEqual([]);
    expect(recorded.some((r) => r.reason === "recipient-quota-blocked")).toBe(true);
  });

  it("does not post a report to a quota-walled recipient either", async () => {
    const { deps, sent, recorded } = fakeDeps({
      snapshots: () => [
        {
          agentId: "boss",
          projectId: "p",
          label: "Boss",
          quota: { message: WEEKLY2, resetAt: T0 + 4 * 60 * MIN, resetParsed: true },
        },
        escIn("a", "p"),
      ],
      reportRecipient: () => "boss",
    });
    await sweepTimes(deps, 3);
    expect(sent).toEqual([]);
    expect(recorded.some((r) => r.reason === "recipient-quota-blocked")).toBe(true);
  });
});

// A wall lasts hours to days — many sweeps. A NON-latching trigger can clear and return inside one,
// and its stale cooldown stamp would then `repeat-suppress` a genuinely new episode the moment the
// wall lifts. `decidePusherAction` expires cooldowns unconditionally for exactly this reason; the
// walled short-circuit skips that call, so it has to do it itself (roborev 56908).
describe("a wall does not strand cooldown stamps", () => {
  const WEEKLY3 = "You've hit your weekly limit · resets Aug 4 at 11pm (America/Bogota)";

  it("expires the stamp of a trigger that stopped firing while the partner was walled", async () => {
    const { deps } = fakeDeps({
      // Walled, and holding only an expired goal — `unpushed-commits` is NOT firing this sweep.
      snapshots: () => [
        {
          ...expired(),
          label: "Walled One",
          quota: { message: WEEKLY3, resetAt: T0 + 4 * 60 * MIN, resetParsed: true },
        },
      ],
    });
    const state = emptyPusherState();
    state.partners.set("a", {
      lastTriggers: [],
      budget: { sentAt: [] },
      lastChallengedAt: { "unpushed-commits": T0 - 60_000, "goal-expired": T0 - 60_000 },
    });

    const next = await sweepPushers(deps, state);

    // `goal-expired` is still firing, so its stamp survives; `unpushed-commits` is not, so its
    // stamp must be dropped rather than left to suppress the next real episode.
    expect(next.partners.get("a")!.lastChallengedAt).toEqual({ "goal-expired": T0 - 60_000 });
  });
});
