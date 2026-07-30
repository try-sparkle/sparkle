// The events domain: what the concierge can learn about changes it did not observe.
//
// Driven through the REAL event log and, where it matters, the REAL sources — a mock would let this
// surface drift from the thing it reports on. The cases that matter most are the two the ops exist
// to guarantee, and both are asserted in BOTH directions:
//
//   • an event is delivered ONCE (and the second drain is empty), and
//   • a reader that fell behind is told EXACTLY how much it lost (and a reader that kept up is told
//     zero, so the field is not a constant).
import { describe, it, expect, beforeEach } from "vitest";

import {
  EVENTS_OPS,
  EVENTS_RISK,
  type EventsResult,
  listEventSubscriptions,
  readEvents,
  subscribe,
  unsubscribe,
} from "./events";
import {
  MAX_RETAINED_EVENTS,
  MAX_SUBSCRIPTIONS,
  _resetConciergeEventLogForTests,
  eventLogEpoch,
  recordConciergeEvent,
} from "../../stores/conciergeEventLog";
import { logStatusTransition } from "../../engine/statusTransitionLog";
import {
  APPROVAL_REQUEST_TTL_MS,
  approveApproval,
  clearConciergeApprovals,
  requestApproval,
  type ConciergeApprovalRequest,
} from "../../stores/conciergeApprovals";

const NOW = 1_700_000_000_000;

function status(agentId: string, to = "done"): void {
  recordConciergeEvent({ kind: "agent_status", agentId, from: "working", to, trigger: "quiet-settle" }, NOW);
}

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

/** Unwrap a success, failing loudly on a refusal so a broken case reports the refusal rather than
 *  `undefined is not an object` three lines later.
 *
 *  The INPUT is the domain's own result union, not `{ ok: boolean } & Record<string, unknown>`: an
 *  interface has no index signature, so `EventsRefusal` never satisfied that shape and all 32 call
 *  sites failed to typecheck. The OUTPUT stays a free type parameter because each case asserts on
 *  the narrow slice of the view it cares about (`{ events: unknown[] }`, `{ cursor: number }`, …)
 *  rather than restating the whole `EventDrainView`. */
function data<T>(result: EventsResult<unknown>): T {
  if (!result.ok) throw new Error(`expected ok, got refusal: ${result.message}`);
  return result.data as T;
}

beforeEach(() => {
  _resetConciergeEventLogForTests();
  clearConciergeApprovals();
});

// ---------------------------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------------------------

describe("the op surface", () => {
  it("ships the four ops the PRD asks for, and classifies every one", () => {
    expect([...EVENTS_OPS]).toEqual(["subscribe", "read_events", "unsubscribe", "list_subscriptions"]);
    expect(Object.keys(EVENTS_RISK).sort()).toEqual([...EVENTS_OPS].sort());
  });

  it("classifies every op so it defaults to allow — learning what changed needs no permission", () => {
    // Both classes below derive to `allow` in policy.ts's DEFAULT_DECISION_BY_RISK. Asserting the
    // classes here (rather than the resolved decision) keeps this test about THIS module; policy.ts
    // owns the mapping and has its own coverage.
    for (const op of EVENTS_OPS) {
      expect(["read-only", "routine"]).toContain(EVENTS_RISK[op]);
    }
    expect(EVENTS_RISK.read_events).toBe("read-only");
    expect(EVENTS_RISK.list_subscriptions).toBe("read-only");
  });
});

// ---------------------------------------------------------------------------------------------
// Delivery — the two guarantees
// ---------------------------------------------------------------------------------------------

describe("nothing is double-delivered", () => {
  it("hands over an event once through a subscription, then nothing", () => {
    const sub = data<{ subscriptionId: string }>(subscribe(["agent_status"], NOW));
    status("a");

    const first = data<{ events: unknown[] }>(readEvents({ subscriptionId: sub.subscriptionId }));
    expect(first.events).toHaveLength(1);

    const second = data<{ events: unknown[] }>(readEvents({ subscriptionId: sub.subscriptionId }));
    expect(second.events).toHaveLength(0);
  });

  it("a subscription starts at NOW — it is not a request for the backlog", () => {
    status("earlier");
    const sub = data<{ subscriptionId: string; cursor: number }>(subscribe([], NOW));
    expect(sub.cursor).toBe(1);
    expect(data<{ events: unknown[] }>(readEvents({ subscriptionId: sub.subscriptionId })).events).toHaveLength(0);

    // …and the backlog is still reachable, explicitly, through the stateless read.
    expect(data<{ events: unknown[] }>(readEvents({ since: 0 })).events).toHaveLength(1);
  });

  it("resumes from a returned cursor without repeating or skipping", () => {
    for (let i = 0; i < 4; i += 1) status(`a${i}`);
    const page = data<{ events: { seq: number }[]; cursor: number; hasMore: boolean }>(
      readEvents({ since: 0, limit: 2 }),
    );
    expect(page.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(page.hasMore).toBe(true);

    const rest = data<{ events: { seq: number }[]; hasMore: boolean }>(
      readEvents({ since: page.cursor }),
    );
    expect(rest.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(rest.hasMore).toBe(false);
  });

  // THE STATEFUL HALF OF THE PAGINATION CLAIM (roborev 55460), which had no coverage at all — the
  // case above is stateless. It matters because the two modes resume DIFFERENTLY and the wrong one
  // is now a refusal: the `hasMore` docs say a subscription is re-read with the same
  // `subscriptionId` and NOTHING ELSE, so this pins that a bare re-read actually returns the
  // remainder. If `readSubscription` dropped `limit`, or advanced the cursor to the head rather than
  // to the truncated drain's cursor, the second read would come back empty and 3–4 would be
  // unreachable through the subscription — with the description still telling the model to re-read.
  it("a subscription cut short by `limit` returns the remainder on a bare re-read", () => {
    const sub = data<{ subscriptionId: string }>(subscribe([], NOW));
    for (let i = 0; i < 4; i += 1) status(`a${i}`);

    const page = data<{ events: { seq: number }[]; hasMore: boolean }>(
      readEvents({ subscriptionId: sub.subscriptionId, limit: 2 }),
    );
    expect(page.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(page.hasMore).toBe(true);

    // No `since`, no `limit` — exactly what the refusal above leaves as the only legal continuation.
    const rest = data<{ events: { seq: number }[]; hasMore: boolean }>(
      readEvents({ subscriptionId: sub.subscriptionId }),
    );
    expect(rest.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(rest.hasMore).toBe(false);
  });
});

describe("nothing is silently dropped", () => {
  it("reports zero dropped for a reader that kept up", () => {
    const sub = data<{ subscriptionId: string }>(subscribe([], NOW));
    status("a");
    expect(
      data<{ evictedBeforeCursor: number }>(readEvents({ subscriptionId: sub.subscriptionId }))
        .evictedBeforeCursor,
    ).toBe(0);
  });

  it("reports the EXACT count a lagging reader lost to eviction", () => {
    const sub = data<{ subscriptionId: string }>(subscribe([], NOW));
    // Overflow the ring by seven while the subscription sits at cursor 0.
    for (let i = 0; i < MAX_RETAINED_EVENTS + 7; i += 1) status("flap");
    expect(
      data<{ evictedBeforeCursor: number }>(readEvents({ subscriptionId: sub.subscriptionId }))
        .evictedBeforeCursor,
    ).toBe(7);
  });

  // AN UPPER BOUND FOR A FILTERED READER, and the field is named for that (roborev 55410). The
  // evicted events are gone, so their kinds are gone with them — an exact per-kind figure would
  // mean keeping a record of everything ever dropped. What must NOT happen is a subscription on
  // `approval_resolved` reading a count of evicted `agent_status` rows as "I lost 7 approvals", so
  // the name says `evicted` (any kind) rather than `dropped` (yours).
  it("counts evictions of ANY kind, so a filtered reader reads it as a bound and not as its own loss", () => {
    const sub = data<{ subscriptionId: string }>(subscribe(["approval_resolved"], NOW));
    // Nothing but noise falls off the end — zero events of the SUBSCRIBED kind are lost.
    for (let i = 0; i < MAX_RETAINED_EVENTS + 7; i += 1) status("flap");

    const drain = data<{ evictedBeforeCursor: number; events: unknown[] }>(
      readEvents({ subscriptionId: sub.subscriptionId }),
    );

    // Non-zero — something did fall off — even though none of it was this reader's kind…
    expect(drain.evictedBeforeCursor).toBe(7);
    expect(drain.events).toHaveLength(0);
  });

  it("carries the ceiling and the retained count on every drain, so 'how far behind may I fall' is answerable", () => {
    status("a");
    const drain = data<{ retained: number; ceiling: number }>(readEvents({ since: 0 }));
    expect(drain.retained).toBe(1);
    expect(drain.ceiling).toBe(MAX_RETAINED_EVENTS);
  });
});

// ---------------------------------------------------------------------------------------------
// A RELOAD IS NOT SILENCE (roborev 55405)
//
// The recovery path this surface documents is a caller re-presenting a cursor or an id it remembered
// from a previous turn — and an app reload rewinds `seq` to 1 and the subscription numbering with
// it. Every case here asserts a REFUSAL where the old code returned a cheerful, empty, zero-loss
// success, which a model reads as "nothing happened".
// ---------------------------------------------------------------------------------------------

describe("a restarted log is refused, not answered", () => {
  it("hands back the epoch on subscribe and on every drain, so a cursor can be held with its run", () => {
    const sub = data<{ epoch: string }>(subscribe([], NOW));
    expect(sub.epoch).toBe(eventLogEpoch());

    status("a");
    const drain = data<{ epoch: string; latestSeq: number }>(readEvents({ since: 0 }));
    expect(drain.epoch).toBe(eventLogEpoch());
    expect(drain.latestSeq).toBe(1);

    expect(data<{ epoch: string }>(listEventSubscriptions()).epoch).toBe(eventLogEpoch());
  });

  it("refuses a cursor carrying a previous run's epoch instead of reporting an empty drain", () => {
    status("before the reload");
    const stale = data<{ cursor: number; epoch: string }>(readEvents({ since: 0 }));

    _resetConciergeEventLogForTests();
    // The new run is already busy — a remembered LOW cursor would otherwise read these as if they
    // continued the old run, which is the case `since > latestSeq` alone cannot catch.
    for (let i = 0; i < 3; i += 1) status("after the reload");

    const result = readEvents({ since: stale.cursor, epoch: stale.epoch });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("log-restarted");
    // The remedy the message names has to work: a stateless read from zero returns this run's events.
    expect(!result.ok && result.message).toContain("since: 0");
    expect(data<{ events: unknown[] }>(readEvents({ since: 0 })).events).toHaveLength(3);
  });

  // THE REMEDY MUST WORK UNDER THE CONDITION THAT TRIGGERED THE REFUSAL (roborev 55441). The
  // refusal says "read with `since: 0`", and the MCP description tells a model to carry the epoch
  // beside `since` — so the literal next call is `{ since: 0, epoch: <stale> }`. If the guard fired
  // on that, following the remedy verbatim would return the identical refusal forever.
  it("accepts `since: 0` carrying a STALE epoch — the remedy it names is not a loop", () => {
    const stale = data<{ epoch: string }>(readEvents({ since: 0 })).epoch;
    _resetConciergeEventLogForTests();
    for (let i = 0; i < 2; i += 1) status("after the reload");

    const recovered = readEvents({ since: 0, epoch: stale });
    expect(recovered.ok).toBe(true);
    expect(data<{ events: unknown[] }>(recovered).events).toHaveLength(2);
    // …and the guard is still armed for the call that DOES claim continuity.
    expect(readEvents({ since: 1, epoch: stale })).toMatchObject({ reason: "log-restarted" });
  });

  it("refuses a cursor ahead of everything this run recorded, even with no epoch to check", () => {
    status("a");
    const result = readEvents({ since: 400 });
    expect(result).toMatchObject({ ok: false, reason: "log-restarted" });
  });

  it("still answers a cursor that carries THIS run's epoch", () => {
    status("a");
    status("b");
    const page = data<{ cursor: number; epoch: string }>(readEvents({ since: 0, limit: 1 }));
    expect(
      data<{ events: { seq: number }[] }>(readEvents({ since: page.cursor, epoch: page.epoch })).events.map(
        (e) => e.seq,
      ),
    ).toEqual([2]);
  });

  it("refuses a previous run's subscription id rather than resolving it against a new one", () => {
    const stale = data<{ subscriptionId: string }>(subscribe([], NOW)).subscriptionId;

    _resetConciergeEventLogForTests();
    const fresh = data<{ subscriptionId: string }>(subscribe([], NOW)).subscriptionId;
    status("a");

    const result = readEvents({ subscriptionId: stale });
    expect(result).toMatchObject({ ok: false, reason: "log-restarted" });
    // THE SIDE EFFECT THAT MATTERS: the refusal did not advance the unrelated new subscription past
    // the event it has not been shown. That advance is the bug, not the wrong answer.
    expect(data<{ events: unknown[] }>(readEvents({ subscriptionId: fresh })).events).toHaveLength(1);
  });

  it("distinguishes a restarted log from an evicted subscription — different reasons, different remedies", () => {
    const live = data<{ subscriptionId: string }>(subscribe([], NOW)).subscriptionId;
    unsubscribe(live);
    // Evicted/closed while the app kept running: the ring is intact and its history is still there.
    expect(readEvents({ subscriptionId: live })).toMatchObject({ reason: "unknown-subscription" });
    // From a build (or a run) whose whole log is gone.
    expect(readEvents({ subscriptionId: "sub-1" })).toMatchObject({ reason: "log-restarted" });
  });

  // THE REMEDY MUST WORK FROM WHERE THE REFUSAL LEAVES YOU (roborev 55500). A caller refused for a
  // stale subscription id was told "read with `since: 0`" — true, but it kept the id, sent
  // `{ subscriptionId: "<stale>", since: 0 }`, and got the IDENTICAL refusal with no hint that the id
  // was the thing to drop. That is the non-converging loop 55441 fixed for `epoch`, one parameter
  // over. Both halves are asserted: the loop exists (so the message has to name the id), and the
  // corrected remedy actually succeeds.
  it("keeps refusing a stale id even with `since: 0`, and says to drop the id", () => {
    status("this-run");
    const r = readEvents({ subscriptionId: "sub-1", since: 0 });

    // Order matters: the stale-id guard runs BEFORE the `since` guard, so this is `log-restarted`
    // and not `since-with-subscription`. Reversing them would misdiagnose it.
    expect(r).toMatchObject({ ok: false, reason: "log-restarted" });
    expect(!r.ok && r.message).toMatch(/drop the `subscriptionId`/i);

    // …and the remedy the message now gives actually gets the caller its answer.
    expect(data<{ events: unknown[] }>(readEvents({ since: 0 })).events).toHaveLength(1);
  });

  it("refuses to 'close' a previous run's subscription rather than claiming it tidied one up", () => {
    const stale = data<{ subscriptionId: string }>(subscribe([], NOW)).subscriptionId;
    _resetConciergeEventLogForTests();
    expect(unsubscribe(stale)).toMatchObject({ ok: false, reason: "log-restarted" });
  });
});

// ---------------------------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------------------------

describe("kind filtering", () => {
  // REFUSED, not ignored (roborev 55410). Accepting `kinds` next to `subscriptionId` and then
  // discarding it answers a DIFFERENT question than the caller asked: it gets the subscription's
  // kinds, its cursor moves past everything, and it concludes nothing of the kind it asked about
  // happened. Same failure `unknown-subscription` is refused for, so it gets a refusal too.
  it("refuses `kinds` alongside a subscriptionId rather than silently ignoring it", () => {
    const sub = data<{ subscriptionId: string }>(subscribe(["agent_status"], NOW));
    status("a");

    const r = readEvents({ subscriptionId: sub.subscriptionId, kinds: ["approval_resolved"] });

    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("kinds-with-subscription");
    // …and the refusal did not consume the subscription: the event is still there to be read.
    expect(
      data<{ events: unknown[] }>(readEvents({ subscriptionId: sub.subscriptionId })).events,
    ).toHaveLength(1);
  });

  // AN EMPTY LIST IS A REAL REQUEST, NOT A FILTER (roborev 55426). `narrowKinds` documents `[]` as
  // "every kind", and `drainEvents` treats it as no filter — so it cannot cause the
  // answers-a-different-question failure the refusal above exists to prevent. Guarding on presence
  // rather than content refused a legal read, with a message that did not describe what the caller
  // had done. A model filling an optional array field with `[]` is a common shape.
  it("still drains normally when `kinds: []` accompanies a subscriptionId", async () => {
    const sub = data<{ subscriptionId: string }>(subscribe(["agent_status"], NOW));
    status("a");

    const r = readEvents({ subscriptionId: sub.subscriptionId, kinds: [] });

    expect(r.ok).toBe(true);
    expect(data<{ events: unknown[] }>(r).events).toHaveLength(1);
  });

  // THE TWIN OF THE ONE ABOVE (roborev 55444), and the likelier of the two to be sent:
  // `list_subscriptions` hands back each subscription's cursor and the tool description calls that
  // the way to recover one, so `read_events({ subscriptionId, since })` is a natural thing to write.
  // Silently ignoring `since` drained from the subscription's CURRENT cursor and then advanced it,
  // so everything in between became unrecoverable through that subscription — reported as an empty,
  // zero-loss "nothing happened since 40".
  it("refuses `since` alongside a subscriptionId instead of answering from the wrong cursor", async () => {
    const sub = data<{ subscriptionId: string }>(subscribe([], NOW));
    for (let i = 0; i < 3; i += 1) status(`a${i}`);
    // Move the subscription's cursor to the head, so an ignored `since` would answer empty.
    data<{ events: unknown[] }>(readEvents({ subscriptionId: sub.subscriptionId }));

    const r = readEvents({ subscriptionId: sub.subscriptionId, since: 0 });

    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("since-with-subscription");
    // The backlog is still reachable the honest way, which is what the refusal points at.
    expect(data<{ events: unknown[] }>(readEvents({ since: 0 })).events).toHaveLength(3);
  });

  // EXISTENCE BEATS THE ARGUMENT RULE (roborev 55460), and this is the scenario the `since` refusal
  // was written for in the first place: a fresh turn that recovered `{ subscriptionId, cursor }` from
  // last turn's context, whose subscription has since been EVICTED. Checking the argument
  // combination first told it "a subscription carries its own cursor" — a rule about a subscription
  // it does not have — instead of "that id is gone, read with `since`", which is the one fact that
  // gets it unstuck. Real eviction rather than `unsubscribe`, because eviction is the case a caller
  // cannot see coming.
  it("reports an EVICTED id as unknown, not as a rule about `since`", () => {
    const first = data<{ subscriptionId: string }>(subscribe([], NOW));
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i += 1) subscribe([], NOW);

    const r = readEvents({ subscriptionId: first.subscriptionId, since: 0 });

    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("unknown-subscription");
    // And the message points at the recovery that WORKS for a subscription that is gone.
    expect(!r.ok && r.message).toMatch(/since/);
  });

  it("delivers only the kinds subscribed to", () => {
    const sub = data<{ subscriptionId: string }>(subscribe(["approval_resolved"], NOW));
    status("noise");
    recordConciergeEvent(
      { kind: "approval_resolved", approvalId: "x", domain: "board", op: "delete_item", outcome: "approved" },
      NOW,
    );
    status("more noise");

    const drain = data<{ events: { kind: string }[] }>(readEvents({ subscriptionId: sub.subscriptionId }));
    expect(drain.events.map((e) => e.kind)).toEqual(["approval_resolved"]);
  });

  it("an empty kind list means EVERY kind, not none", () => {
    const sub = data<{ subscriptionId: string }>(subscribe([], NOW));
    status("a");
    recordConciergeEvent({ kind: "agent_exited", agentId: "a", status: "done" }, NOW);
    expect(
      data<{ events: unknown[] }>(readEvents({ subscriptionId: sub.subscriptionId })).events,
    ).toHaveLength(2);
  });

  it("REFUSES an unrecognised kind rather than quietly dropping it", () => {
    const result = subscribe(["aproval_resolved"], NOW);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "unknown-event-kind" });
    // The message names the typo AND the real vocabulary, so the retry is obvious.
    expect((result as { message: string }).message).toContain("aproval_resolved");
    expect((result as { message: string }).message).toContain("approval_resolved");
  });

  it("refuses an unrecognised kind on the stateless read too", () => {
    expect(readEvents({ since: 0, kinds: ["nope"] })).toMatchObject({
      ok: false,
      reason: "unknown-event-kind",
    });
  });

  it("says up front which subscribed kinds nothing in this build emits", () => {
    const named = data<{ unwiredKinds: string[] }>(
      subscribe(["build_failed", "agent_status"], NOW),
    );
    expect(named.unwiredKinds).toEqual(["build_failed"]);

    const wired = data<{ unwiredKinds: string[] }>(subscribe(["agent_status"], NOW));
    expect(wired.unwiredKinds).toEqual([]);
  });

  it("names the unwired kinds for a subscribe-to-everything too", () => {
    expect(data<{ unwiredKinds: string[] }>(subscribe([], NOW)).unwiredKinds).toEqual([
      "pr_checks_concluded",
      "build_failed",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Lifecycle of a subscription
// ---------------------------------------------------------------------------------------------

describe("subscribe / unsubscribe", () => {
  it("unsubscribes once, and refuses the second attempt", () => {
    const sub = data<{ subscriptionId: string }>(subscribe([], NOW));
    expect(unsubscribe(sub.subscriptionId)).toMatchObject({ ok: true });
    expect(unsubscribe(sub.subscriptionId)).toMatchObject({
      ok: false,
      reason: "unknown-subscription",
    });
  });

  it("an unsubscribed id stops delivering — and says so rather than reading as silence", () => {
    const sub = data<{ subscriptionId: string }>(subscribe([], NOW));
    unsubscribe(sub.subscriptionId);
    status("a");
    const result = readEvents({ subscriptionId: sub.subscriptionId });
    expect(result).toMatchObject({ ok: false, reason: "unknown-subscription" });
    // NOT an empty success — that would read to a model as "the app is quiet".
    expect(result.ok).toBe(false);
  });

  it("lists live subscriptions with what each has waiting, WITHOUT delivering it", () => {
    const a = data<{ subscriptionId: string }>(subscribe(["agent_status"], NOW));
    subscribe(["approval_requested"], NOW);
    status("x");
    status("y");

    const listed = data<{ subscriptions: { subscriptionId: string; pending: number }[]; latestSeq: number }>(
      listEventSubscriptions(),
    );
    expect(listed.subscriptions.map((s) => s.pending)).toEqual([2, 0]);
    expect(listed.latestSeq).toBe(2);
    // Listing delivered nothing, so the drain still has both.
    expect(
      data<{ events: unknown[] }>(readEvents({ subscriptionId: a.subscriptionId })).events,
    ).toHaveLength(2);
  });

  it("caps the ledger so a looping model cannot grow it without limit", () => {
    for (let i = 0; i < MAX_SUBSCRIPTIONS + 3; i += 1) subscribe([], NOW);
    expect(data<{ subscriptions: unknown[] }>(listEventSubscriptions()).subscriptions).toHaveLength(
      MAX_SUBSCRIPTIONS,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// End to end: a real change the concierge never observed
// ---------------------------------------------------------------------------------------------

describe("the concierge learns about changes it did not watch", () => {
  it("sees an agent go blocked without having polled for it", () => {
    const sub = data<{ subscriptionId: string }>(subscribe(["agent_status"], NOW));
    logStatusTransition({
      agentId: "agent-7",
      from: "working",
      to: "blocked",
      trigger: "quiet-blocked",
      monotonicMs: 12,
    });
    expect(
      data<{ events: unknown[] }>(readEvents({ subscriptionId: sub.subscriptionId })).events,
    ).toMatchObject([{ kind: "agent_status", agentId: "agent-7", to: "blocked" }]);
  });

  it("sees an approval REQUESTED AND ANSWERED between two turns — the thing polling cannot report", () => {
    const sub = data<{ subscriptionId: string }>(subscribe([], NOW));
    // Both halves happen while no concierge turn is running.
    requestApproval(approvalRequest(), NOW);
    approveApproval("call-1", NOW + 10);

    const drain = data<{ events: { kind: string }[] }>(readEvents({ subscriptionId: sub.subscriptionId }));
    expect(drain.events.map((e) => e.kind)).toEqual(["approval_requested", "approval_resolved"]);
    expect(drain.events[1]).toMatchObject({ outcome: "approved" });
  });

  // THE SCENARIO THE EXPIRY ANNOUNCEMENT EXISTS FOR, with NOTHING ELSE HAPPENING (roborev 55441).
  // The concierge asks, nobody clicks, and no further approval traffic arrives — so no writer ever
  // sweeps the ledger. Only the CLOCK moves between the two drains below. An announcement that fires
  // solely off other approval activity leaves this reader waiting forever, which is the whole bug.
  it("sees a question DIE UNANSWERED when only the clock has moved", () => {
    const sub = data<{ subscriptionId: string }>(
      subscribe(["approval_requested", "approval_resolved"], NOW),
    );
    requestApproval(approvalRequest(), NOW);
    expect(
      data<{ events: { kind: string }[] }>(
        readEvents({ subscriptionId: sub.subscriptionId }, NOW),
      ).events.map((e) => e.kind),
    ).toEqual(["approval_requested"]);

    // No second ask, no click, no claim. Just time.
    const late = NOW + APPROVAL_REQUEST_TTL_MS + 1;
    const drain = data<{ events: { kind: string; approvalId: string; outcome?: string; at: number }[] }>(
      readEvents({ subscriptionId: sub.subscriptionId }, late),
    );
    expect(drain.events).toMatchObject([
      { kind: "approval_resolved", approvalId: "call-1", outcome: "expired" },
    ]);
    // Stamped when the question actually died, not when the drain noticed.
    expect(drain.events[0]!.at).toBe(NOW + APPROVAL_REQUEST_TTL_MS);
  });

  // WHAT A FRESH SUBSCRIPTION CANNOT DO, and why the promise is scoped rather than the cursor moved
  // (roborev 55526). The reorder — guarded by the test below — only helps when `subscribe` is the
  // FIRST thing to sweep the
  // ledger, and the documented recovery path is not that: `list_subscriptions` settles too (it must,
  // or `pending` would not count the lapse), and so do `requestApproval` and a human's click — five
  // call sites in all. Once ANY of them materialises the lapse, a subscription opened afterwards
  // starts above it, because a subscription starts at NOW. That is the module's contract, not a bug in
  // it, and rewinding the cursor below "the earliest unread lapse" would break that contract for one
  // event kind and add ledger bookkeeping to do it.
  //
  // So the fix is the SENTENCE, not the seq: the stateless read answers this correctly and always
  // did, and the tool description now says so instead of promising that a fresh subscription reports
  // the past. Both halves are asserted here, because only the pair states the contract — an assertion
  // that the subscription is empty would read as a bug being enshrined, without the second half
  // showing where the answer actually lives. Its counterpart is "hands the lapse to a subscription
  // opened AFTER the question died", immediately below.
  it("cannot report a question that died before it existed — the stateless read is where that lives", () => {
    requestApproval(approvalRequest(), NOW);
    const late = NOW + APPROVAL_REQUEST_TTL_MS + 1;

    // The documented recovery sequence, verbatim: look for a cursor, find none, subscribe.
    // This call settles the clock, so the lapse is recorded HERE, before any subscription exists.
    listEventSubscriptions(late);
    const sub = data<{ subscriptionId: string }>(
      subscribe(["approval_requested", "approval_resolved"], late),
    );

    // Nothing — and that is correct for a cursor that starts at now, not a silent loss.
    expect(
      data<{ events: unknown[] }>(readEvents({ subscriptionId: sub.subscriptionId }, late)).events,
    ).toHaveLength(0);

    // …and the answer IS reachable, the way the description now tells the model to reach it.
    const stateless = data<{ events: { kind: string; outcome?: string }[] }>(
      readEvents({ since: 0 }, late),
    );
    expect(stateless.events).toMatchObject([
      { kind: "approval_requested" },
      { kind: "approval_resolved", outcome: "expired" },
    ]);
  });

  // THE NARROWER CLAIM (roborev 55459, corrected by 55526): when `subscribe` is the first thing to
  // sweep the ledger, the lapse it materialises is delivered rather than swallowed. `subscribe` used
  // to settle BEFORE `openSubscription` took `latestEventSeq()` as the cursor, so the expiry landed at
  // or below the cursor and the first drain came back empty even in this, the simplest case.
  //
  // Read it together with "cannot report a question that died before it existed", immediately above,
  // which is the one that says what this does NOT prove: the ordering here removes ONE way to lose the
  // lapse, not the general case. If anything else swept first, the lapse is below this cursor and the
  // stateless read is the only thing that can answer. Neither test is the contract on its own.
  it("hands the lapse to a subscription opened AFTER the question died", () => {
    requestApproval(approvalRequest(), NOW);
    const late = NOW + APPROVAL_REQUEST_TTL_MS + 1;

    // Nobody drained in between: this subscription is the first reader to exist since the TTL ran out.
    const sub = data<{ subscriptionId: string }>(
      subscribe(["approval_requested", "approval_resolved"], late),
    );
    const drain = data<{ events: { kind: string; outcome?: string; at: number }[] }>(
      readEvents({ subscriptionId: sub.subscriptionId }, late),
    );

    expect(drain.events).toMatchObject([{ kind: "approval_resolved", outcome: "expired" }]);
    // Still stamped at the death, so it reads as history rather than as news.
    expect(drain.events[0]!.at).toBe(NOW + APPROVAL_REQUEST_TTL_MS);
  });

  it("counts the lapse in `pending` too, so a turn that checks first does not skip the drain", () => {
    const sub = data<{ subscriptionId: string }>(subscribe(["approval_resolved"], NOW));
    requestApproval(approvalRequest(), NOW);

    const late = NOW + APPROVAL_REQUEST_TTL_MS + 1;
    const listed = data<{ subscriptions: { pending: number }[] }>(listEventSubscriptions(late));
    expect(listed.subscriptions.map((s) => s.pending)).toEqual([1]);
    expect(
      data<{ events: unknown[] }>(readEvents({ subscriptionId: sub.subscriptionId }, late)).events,
    ).toHaveLength(1);
  });

  it("still announces a lapse that a WRITE happens to sweep up first", () => {
    const sub = data<{ subscriptionId: string }>(
      subscribe(["approval_requested", "approval_resolved"], NOW),
    );
    requestApproval(approvalRequest(), NOW);
    const late = NOW + APPROVAL_REQUEST_TTL_MS + 1;
    requestApproval(approvalRequest({ id: "call-2", fingerprint: "fp-2" }), late);

    const drain = data<{ events: { kind: string; approvalId: string; outcome?: string }[] }>(
      readEvents({ subscriptionId: sub.subscriptionId }, late),
    );
    // Exactly once, and not a second time from the drain's own sweep.
    expect(drain.events).toMatchObject([
      { kind: "approval_requested", approvalId: "call-1" },
      { kind: "approval_resolved", approvalId: "call-1", outcome: "expired" },
      { kind: "approval_requested", approvalId: "call-2" },
    ]);
  });

  it("sees a spawn and an exit as their own kinds", () => {
    const sub = data<{ subscriptionId: string }>(subscribe(["agent_spawned", "agent_exited"], NOW));
    logStatusTransition({ agentId: "a", from: null, to: "working", trigger: "spawn", monotonicMs: 0 });
    logStatusTransition({ agentId: "a", from: "working", to: "done", trigger: "process-exit", monotonicMs: 5 });

    expect(
      data<{ events: { kind: string }[] }>(readEvents({ subscriptionId: sub.subscriptionId })).events.map(
        (e) => e.kind,
      ),
    ).toEqual(["agent_spawned", "agent_exited"]);
  });
});
