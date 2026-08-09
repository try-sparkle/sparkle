// The event log itself: the cursor, the ring, and — the part that would otherwise be vacuous — that
// the app's REAL sources actually dispatch into it.
//
// The repo's #1 finding is a test that asserts a precondition. "A subscription was recorded" is
// exactly that shape and proves nothing, so the wiring block at the bottom drives the real
// `logStatusTransition` and the real `requestApproval`/`approveApproval` and asserts an event came
// out the other end. If the emit calls were deleted, those cases fail.
import { describe, it, expect, beforeEach } from "vitest";

import {
  CONCIERGE_EVENT_KINDS,
  CONCIERGE_EVENT_WIRING,
  DEFAULT_DRAIN_LIMIT,
  MAX_RETAINED_EVENTS,
  MAX_SUBSCRIPTIONS,
  WIRED_EVENT_KINDS,
  _resetConciergeEventLogForTests,
  closeSubscription,
  drainEvents,
  eventLogEpoch,
  findSubscription,
  latestEventSeq,
  listSubscriptions,
  oldestRetainedSeq,
  openSubscription,
  pendingForSubscription,
  readSubscription,
  recordConciergeEvent,
  retainedEventCount,
  subscriptionIdOrigin,
} from "./conciergeEventLog";
import { logStatusTransition } from "../engine/statusTransitionLog";
import {
  APPROVAL_REQUEST_TTL_MS,
  approveApproval,
  clearConciergeApprovals,
  denyApproval,
  requestApproval,
  type ConciergeApprovalRequest,
} from "./conciergeApprovals";

const NOW = 1_700_000_000_000;

/** One status event, so cases read as what they are testing rather than as object construction. */
function status(agentId: string, to: string): void {
  recordConciergeEvent({ kind: "agent_status", agentId, from: "working", to, trigger: "quiet-settle" }, NOW);
}

/** A complete approval request. The ledger's own fields are not what these cases are about, so they
 *  are filled once here rather than restated per case. */
function approvalRequest(over: Partial<ConciergeApprovalRequest> = {}): ConciergeApprovalRequest {
  return {
    id: "call-1",
    domain: "workflow",
    op: "merge_pr",
    summary: "Merge a pull request.",
    riskClass: "mutates-main",
    riskNote: "Changes the branch everything else is measured against.",
    args: [],
    rawArgs: {},
    configPath: "concierge.tools.merge_pr",
    fingerprint: "fp-1",
    ...over,
  };
}

beforeEach(() => {
  _resetConciergeEventLogForTests();
  clearConciergeApprovals();
});

// ---------------------------------------------------------------------------------------------
// The cursor
// ---------------------------------------------------------------------------------------------

describe("the cursor is monotonic and dense", () => {
  it("starts at 1 so cursor:0 can mean 'seen nothing' without colliding", () => {
    expect(latestEventSeq()).toBe(0);
    expect(recordConciergeEvent({ kind: "build_failed", agentId: null, detail: "x" }, NOW).seq).toBe(1);
  });

  it("increments by exactly one per event, across kinds", () => {
    status("a", "done");
    recordConciergeEvent({ kind: "agent_exited", agentId: "a", status: "done" }, NOW);
    status("b", "blocked");
    expect(drainEvents({ since: 0 }).events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("keeps rising after eviction — a seq is never reused", () => {
    for (let i = 0; i < MAX_RETAINED_EVENTS + 5; i += 1) status("a", "done");
    // The ring dropped the first five, but the counter did not rewind.
    expect(latestEventSeq()).toBe(MAX_RETAINED_EVENTS + 5);
    expect(oldestRetainedSeq()).toBe(6);
  });
});

// ---------------------------------------------------------------------------------------------
// The epoch — because "monotonic" only holds WITHIN a run (roborev 55405)
// ---------------------------------------------------------------------------------------------

describe("each run of the log names itself", () => {
  it("mints a fresh epoch on restart, so the seq rewinding to 1 is detectable", () => {
    const before = eventLogEpoch();
    status("a", "done");
    expect(latestEventSeq()).toBe(1);

    // A reload: the module state, including the seq counter, starts over.
    _resetConciergeEventLogForTests();

    expect(latestEventSeq()).toBe(0);
    expect(eventLogEpoch()).not.toBe(before);
  });

  it("stamps the epoch onto every subscription id", () => {
    const sub = openSubscription([], NOW);
    expect(sub.id).toBe(`${eventLogEpoch()}-sub-1`);
    expect(subscriptionIdOrigin(sub.id)).toBe("current");
  });

  it("does NOT resolve a previous run's id against this run's identically-numbered one", () => {
    const stale = openSubscription([], NOW).id;
    _resetConciergeEventLogForTests();
    // The new run mints its own `sub-1` — a different string, and recognisably from elsewhere.
    const fresh = openSubscription([], NOW).id;

    expect(fresh).not.toBe(stale);
    expect(subscriptionIdOrigin(stale)).toBe("other-run");
    // The load-bearing assertion: the stale id finds NOTHING, so a read through it cannot advance
    // the fresh subscription's cursor.
    status("a", "done");
    expect(readSubscription(stale)).toBeNull();
    expect(findSubscription(fresh)?.cursor).toBe(0);
  });

  it("classifies the un-prefixed `sub-N` a pre-epoch build handed out as another run's", () => {
    expect(subscriptionIdOrigin("sub-1")).toBe("other-run");
    expect(subscriptionIdOrigin("not-a-subscription")).toBe("not-an-id");
  });
});

// ---------------------------------------------------------------------------------------------
// Nothing double-delivered, nothing silently dropped — both directions
// ---------------------------------------------------------------------------------------------

describe("delivery", () => {
  it("delivers an event once and never again through the same subscription", () => {
    const sub = openSubscription(["agent_status"], NOW);
    status("a", "done");

    const first = readSubscription(sub.id);
    expect(first?.events.map((e) => (e as { agentId: string }).agentId)).toEqual(["a"]);

    // The SAME call again, with nothing new recorded: empty, not a repeat.
    expect(readSubscription(sub.id)?.events).toEqual([]);
  });

  it("delivers only what arrived since the last read", () => {
    const sub = openSubscription(["agent_status"], NOW);
    status("a", "done");
    readSubscription(sub.id);
    status("b", "blocked");

    const second = readSubscription(sub.id);
    expect(second?.events.map((e) => (e as { agentId: string }).agentId)).toEqual(["b"]);
  });

  it("does not deliver events that predate the subscription", () => {
    status("before", "done");
    const sub = openSubscription(["agent_status"], NOW);
    expect(readSubscription(sub.id)?.events).toEqual([]);
  });

  it("reports EXACTLY how many events a lagging reader missed", () => {
    // Read once so the cursor sits at 1, then overflow the ring past it.
    const sub = openSubscription(["agent_status"], NOW);
    status("a", "done");
    expect(readSubscription(sub.id)?.evictedBeforeCursor).toBe(0);

    for (let i = 0; i < MAX_RETAINED_EVENTS + 9; i += 1) status("flap", "working");

    const drain = readSubscription(sub.id);
    // seq 1 was read; seqs 2..10 were evicted before this reader saw them; 11.. survive.
    expect(drain?.evictedBeforeCursor).toBe(9);
    expect(drain?.events.length).toBe(DEFAULT_DRAIN_LIMIT);
  });

  it("reports zero dropped for a reader that kept up", () => {
    const sub = openSubscription(["agent_status"], NOW);
    for (let i = 0; i < 10; i += 1) status("a", "done");
    expect(readSubscription(sub.id)?.evictedBeforeCursor).toBe(0);
  });

  it("resumes exactly where a truncated drain stopped — no skip, no repeat", () => {
    for (let i = 0; i < 5; i += 1) status(`a${i}`, "done");
    const sub = openSubscription([], NOW);
    // Cursor is at head, so rewind by reading statelessly from 0 in two pages instead.
    const page1 = drainEvents({ since: 0, limit: 2 });
    expect(page1.hasMore).toBe(true);
    expect(page1.events.map((e) => e.seq)).toEqual([1, 2]);

    const page2 = drainEvents({ since: page1.cursor, limit: 2 });
    expect(page2.events.map((e) => e.seq)).toEqual([3, 4]);

    const page3 = drainEvents({ since: page2.cursor, limit: 2 });
    expect(page3.events.map((e) => e.seq)).toEqual([5]);
    expect(page3.hasMore).toBe(false);
    expect(sub.cursor).toBe(5);
  });

  it("advances the cursor past events the subscription filtered out", () => {
    const sub = openSubscription(["approval_resolved"], NOW);
    for (let i = 0; i < 50; i += 1) status("noisy", "working");
    const drain = readSubscription(sub.id);
    expect(drain?.events).toEqual([]);
    // The 50 uninteresting events are behind it, so a later read does not re-scan them.
    expect(findSubscription(sub.id)?.cursor).toBe(50);
  });

  it("a stateless read never disturbs a subscription's cursor", () => {
    const sub = openSubscription(["agent_status"], NOW);
    status("a", "done");
    drainEvents({ since: 0 });
    expect(findSubscription(sub.id)?.cursor).toBe(0);
    expect(readSubscription(sub.id)?.events.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Bounded by construction
// ---------------------------------------------------------------------------------------------

describe("the ring is bounded", () => {
  it("never retains more than the ceiling", () => {
    for (let i = 0; i < MAX_RETAINED_EVENTS * 2; i += 1) status("a", "done");
    expect(retainedEventCount()).toBe(MAX_RETAINED_EVENTS);
  });

  it("evicts OLDEST first — the newest events are the ones kept", () => {
    for (let i = 0; i < MAX_RETAINED_EVENTS + 3; i += 1) {
      recordConciergeEvent({ kind: "agent_status", agentId: `a${i}`, from: "x", to: "y", trigger: "t" }, NOW);
    }
    const retained = drainEvents({ since: 0, limit: MAX_RETAINED_EVENTS }).events;
    expect((retained[0] as { agentId: string }).agentId).toBe("a3");
    expect((retained[retained.length - 1] as { agentId: string }).agentId).toBe(
      `a${MAX_RETAINED_EVENTS + 2}`,
    );
  });

  it("caps the subscription ledger too, dropping the oldest", () => {
    const ids = Array.from({ length: MAX_SUBSCRIPTIONS + 2 }, () => openSubscription([], NOW).id);
    expect(listSubscriptions().length).toBe(MAX_SUBSCRIPTIONS);
    expect(findSubscription(ids[0]!)).toBeUndefined();
    expect(findSubscription(ids[ids.length - 1]!)).toBeDefined();
  });

  it("closes a subscription, and says so only once", () => {
    const sub = openSubscription([], NOW);
    expect(closeSubscription(sub.id)).toBe(true);
    expect(closeSubscription(sub.id)).toBe(false);
    expect(readSubscription(sub.id)).toBeNull();
  });

  it("counts what is waiting without delivering it", () => {
    const sub = openSubscription(["agent_status"], NOW);
    status("a", "done");
    status("b", "done");
    expect(pendingForSubscription(findSubscription(sub.id)!)).toBe(2);
    // …and counting did not move the cursor.
    expect(readSubscription(sub.id)?.events.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// THE WIRING — the assertions that would fail if the emits were removed
// ---------------------------------------------------------------------------------------------

describe("the app's real sources dispatch into the log", () => {
  it("a status transition becomes an agent_status event", () => {
    logStatusTransition({
      agentId: "agent-1",
      from: "working",
      to: "blocked",
      trigger: "quiet-blocked",
      monotonicMs: 42,
    });
    const [event] = drainEvents({ since: 0 }).events;
    expect(event).toMatchObject({
      kind: "agent_status",
      agentId: "agent-1",
      from: "working",
      to: "blocked",
      trigger: "quiet-blocked",
    });
  });

  it("the spawn transition becomes agent_spawned, not a status change from nothing", () => {
    logStatusTransition({ agentId: "agent-1", from: null, to: "working", trigger: "spawn", monotonicMs: 0 });
    const kinds = drainEvents({ since: 0 }).events.map((e) => e.kind);
    expect(kinds).toEqual(["agent_spawned"]);
  });

  it("a process exit emits agent_exited ALONGSIDE the status change", () => {
    logStatusTransition({
      agentId: "agent-1",
      from: "working",
      to: "done",
      trigger: "process-exit",
      monotonicMs: 99,
    });
    const events = drainEvents({ since: 0 }).events;
    expect(events.map((e) => e.kind)).toEqual(["agent_status", "agent_exited"]);
    expect(events[1]).toMatchObject({ kind: "agent_exited", agentId: "agent-1", status: "done" });
  });

  it("never carries the screen verdict or anything else the transition log redacts", () => {
    logStatusTransition({
      agentId: "agent-1",
      from: "working",
      // `needs_you` is a StatusBand (engine/buildSections), NOT an AgentTabStatus — the band a
      // status renders under, not a status. `waiting` is the real one this case means.
      to: "waiting",
      trigger: "screen-recheck",
      screen: "awaiting",
      monotonicMs: 7,
    });
    expect(JSON.stringify(drainEvents({ since: 0 }).events)).not.toContain("awaiting");
  });

  it("a NEW approval request becomes approval_requested", () => {
    requestApproval(approvalRequest(), NOW);
    expect(drainEvents({ since: 0 }).events).toMatchObject([
      { kind: "approval_requested", approvalId: "call-1", domain: "workflow", op: "merge_pr" },
    ]);
  });

  it("re-asking the SAME live question emits nothing — one question, one event", () => {
    // Twice by the same id (the ledger returns the existing entry), then again under a FRESH id
    // with the same fingerprint (the ledger returns the card already on screen). Neither is a new
    // question, so neither may wake a reader a second time.
    requestApproval(approvalRequest(), NOW);
    requestApproval(approvalRequest(), NOW + 1);
    requestApproval(approvalRequest({ id: "call-2" }), NOW + 2);
    expect(drainEvents({ since: 0 }).events.length).toBe(1);
  });

  it("the human's answer becomes approval_resolved, carrying WHICH answer", () => {
    requestApproval(approvalRequest({ domain: "board", op: "delete_item" }), NOW);
    approveApproval("call-1", NOW + 10);
    expect(drainEvents({ since: 1 }).events).toMatchObject([
      { kind: "approval_resolved", approvalId: "call-1", op: "delete_item", outcome: "approved" },
    ]);
  });

  it("a denial is reported as a denial", () => {
    requestApproval(approvalRequest({ domain: "board", op: "delete_item" }), NOW);
    denyApproval("call-1", NOW + 10);
    expect(drainEvents({ since: 1, kinds: ["approval_resolved"] }).events).toMatchObject([
      { outcome: "denied" },
    ]);
  });

  // THE QUESTION THAT DIED (roborev 55405). A subscriber that drained `approval_requested` and is
  // waiting for the matching `approval_resolved` used to wait forever: the TTL flipped the entry to
  // `expired` and announced nothing, so the stream read as still-open while the card was gone.
  //
  // These assert on what came OUT OF THE LOG, not on the ledger's status field — the status changing
  // is the precondition, and asserting it would pass against the code before this fix.
  it("an unanswered question becomes approval_resolved with outcome expired once its TTL lapses", () => {
    requestApproval(approvalRequest({ domain: "board", op: "delete_item" }), NOW);
    // Nobody answers. Much later, an unrelated call touches the ledger and the sweep finds it dead.
    requestApproval(
      approvalRequest({ id: "call-later", fingerprint: "fp-later" }),
      NOW + APPROVAL_REQUEST_TTL_MS + 1,
    );

    expect(drainEvents({ since: 0, kinds: ["approval_resolved"] }).events).toMatchObject([
      { kind: "approval_resolved", approvalId: "call-1", domain: "board", op: "delete_item", outcome: "expired" },
    ]);
  });

  it("does not announce the lapse twice, however often the ledger is swept", () => {
    requestApproval(approvalRequest(), NOW);
    const late = NOW + APPROVAL_REQUEST_TTL_MS + 1;
    approveApproval("nobody-home", late);
    approveApproval("nobody-home", late + 1);
    expect(drainEvents({ since: 0, kinds: ["approval_resolved"] }).events.length).toBe(1);
  });

  it("says nothing when an ANSWERED approval's grant lapses — the question did not expire", () => {
    requestApproval(approvalRequest(), NOW);
    approveApproval("call-1", NOW + 1);
    // Long past the grant window, unspent. The human's `approved` was already announced; a second
    // resolution saying `expired` would report the question as unanswered, which is false.
    approveApproval("nobody-home", NOW + APPROVAL_REQUEST_TTL_MS * 10);

    expect(
      drainEvents({ since: 0, kinds: ["approval_resolved"] }).events.map(
        (e) => (e as { outcome: string }).outcome,
      ),
    ).toEqual(["approved"]);
  });

  it("a resolve that changes nothing emits nothing", () => {
    // No such entry, and a second answer to an already-answered one.
    expect(approveApproval("nope", NOW)).toBe(false);
    requestApproval(approvalRequest({ domain: "board", op: "delete_item" }), NOW);
    approveApproval("call-1", NOW + 1);
    denyApproval("call-1", NOW + 2);
    expect(drainEvents({ since: 0, kinds: ["approval_resolved"] }).events.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// The honest account of coverage
// ---------------------------------------------------------------------------------------------

describe("the wiring table is the truth, not decoration", () => {
  it("classifies every kind", () => {
    expect(Object.keys(CONCIERGE_EVENT_WIRING).sort()).toEqual([...CONCIERGE_EVENT_KINDS].sort());
  });

  it("names exactly the six kinds something emits today", () => {
    expect([...WIRED_EVENT_KINDS]).toEqual([
      "agent_status",
      "agent_spawned",
      "agent_exited",
      "approval_requested",
      "approval_resolved",
      // services/research/drain.ts observes the research task list and records one of these the
      // first time a task is seen terminal — the channel by which a FAILED or CANCELLED task
      // reaches the concierge at all, since the turn-start preamble is `done`-only.
      "research_completed",
    ]);
  });

  it("carries a research task's ENDING, and no user content with it", () => {
    // Property 4, at the newest kind: these records are handed to a model and may be quoted back,
    // so the question and the findings must not be in them. The findings travel in the prompt
    // preamble instead (services/research/drain).
    const e = recordConciergeEvent(
      { kind: "research_completed", taskId: "r-1", projectId: "p1", status: "failed" },
      NOW,
    );
    expect(e).toMatchObject({ kind: "research_completed", taskId: "r-1", status: "failed", seq: 1 });
    expect(Object.keys(e).sort()).toEqual(["at", "kind", "projectId", "seq", "status", "taskId"]);
  });

  it("marks pr_checks_concluded and build_failed as named-but-unwired", () => {
    expect(CONCIERGE_EVENT_WIRING.pr_checks_concluded).toBe("named");
    expect(CONCIERGE_EVENT_WIRING.build_failed).toBe("named");
  });
});
