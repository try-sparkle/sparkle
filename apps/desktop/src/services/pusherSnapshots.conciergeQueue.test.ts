// THE ADAPTER FOR THE APP-GLOBAL `ConciergeQueue` INPUT — two three-valued reads, joined.
//
// Its own file rather than a block in `pusherSnapshots.test.ts` because the subject is different:
// that suite is about per-agent `FleetSnapshot` mapping, and this is one app-wide value assembled
// from two stores that each have their OWN "we have not looked yet" state. The joins are where the
// mistakes live, and there are exactly two of them:
//
//   • NO HOST MOUNTED. `conciergeQueueStore.depth === undefined`. There is no queue to report and
//     nothing may be synthesised — a `waiting: 0` here is the fail-OPEN answer at the front door of
//     a detector built to end a silence.
//   • THE RESEARCH STORE HAS NOT HYDRATED. `liveTasks(allTasksNow()).length` is 0 both before the
//     first `listResearch()` lands and when there genuinely are no tasks. Reporting the first as
//     "zero concierge agents" is a FALSE ALARM about the exact condition being detected — messages
//     queued with nobody working them — raised by a store that had simply not been read yet.
import { beforeEach, describe, expect, it } from "vitest";

// THE REAL EVALUATOR, imported on purpose. Asserting the produced object's fields proves the shape;
// feeding it to the function that consumes it proves the shape is the RIGHT one. The bug this suite
// missed lived exactly in the gap between those two claims.
import { queueUnfanned } from "@sparkle/core";
import { buildConciergeQueue } from "./pusherSnapshots";
import { publishConciergeQueue, useConciergeQueueStore } from "../stores/conciergeQueueStore";
import { _resetResearchStoreForTests, useResearchStore } from "./research/store";
import type { ResearchTask } from "./research/types";

const HOST = {};

/** One research task in whatever state the case needs. Only the fields `isLive` reads matter. */
function task(id: string, status: ResearchTask["status"]): ResearchTask {
  return {
    id,
    question: `q-${id}`,
    projectId: "p1",
    status,
    createdAt: 1,
    startedAt: 1,
    finishedAt: null,
    findings: null,
    error: null,
    readAt: null,
  } as unknown as ResearchTask;
}

/** Put the research store in the state a landed `listResearch()` leaves it in. */
function hydrateWith(tasks: ResearchTask[]): void {
  useResearchStore.getState().replaceAll(tasks);
}

beforeEach(() => {
  useConciergeQueueStore.getState()._resetForTests();
  _resetResearchStoreForTests();
});

describe("no concierge is mounted", () => {
  it("reports NOTHING rather than an empty queue", () => {
    hydrateWith([]);
    // `undefined`, not `{ waiting: 0 }`. This is the reading in a torn-off satellite window, in the
    // main window with no project open, and in the seconds before the host's first effect — and in
    // every one of them the honest answer is that nobody looked.
    expect(buildConciergeQueue()).toBeUndefined();
  });
});

/** An enqueue instant far enough back that the condition's staleness floor is satisfied. */
const OLD = 1_700_000_000_000;

describe("a mounted concierge with a queue", () => {
  it("carries the depth and the live concierge-agent count together", () => {
    publishConciergeQueue(HOST, { waiting: 6, running: true, oldestAt: OLD });
    hydrateWith([task("t1", "running"), task("t2", "done")]);
    // `liveAgents` counts QUEUED + RUNNING, through the store's own `liveTasks` selector — the same
    // one the "Concierge Agents" row's `+[n]` is derived from, so the report and the row can never
    // tell different stories. The `done` task is history and is not live.
    expect(buildConciergeQueue()).toEqual({ queued: 6, liveAgents: 1, oldestAt: OLD });
  });

  // ══ THE SHAPE IS THE CONSUMER'S, AND THAT IS THE WHOLE POINT (2026-08-13) ══════════════════════
  // This asserted `{waiting, running, liveAgents}` — a shape declared locally in `pusherSnapshots`
  // while the condition that reads it was landing in `@sparkle/core` as `{queued, liveAgents,
  // oldestAt}`. Both suites were green and the seam was broken: the reading reached
  // `decideFleetReport` under a key it does not read, so `queue-unfanned` never fired once.
  // Asserting the CONSUMER's field names is what makes the two halves fail together.
  it("produces the exact shape `queueUnfanned` reads — field names included", () => {
    publishConciergeQueue(HOST, { waiting: 6, running: true, oldestAt: OLD });
    hydrateWith([]);
    const q = buildConciergeQueue()!;
    // THE CONDITION'S WHOLE SUBJECT: six messages stacked up and nothing fanned out.
    expect(q.queued).toBe(6);
    expect(q.liveAgents).toBe(0);
    expect(q.oldestAt).toBe(OLD);
    // And the retired names are GONE, not merely unused — a shape carrying both would let the two
    // sides drift apart again while every assertion above still passed.
    expect(q).not.toHaveProperty("waiting");
    expect(q).not.toHaveProperty("running");
    // Fed to the real evaluator it must actually produce the condition. This is the assertion the
    // old suite structurally could not make, because its shape was one the evaluator cannot read.
    expect(queueUnfanned(q, OLD + 5 * 60_000)).toEqual({
      queued: 6,
      liveAgents: 0,
      waitedMs: 5 * 60_000,
    });
  });

  // `queued` IS the waiting count, never waiting-plus-the-running-turn. Off by one here and the
  // condition fires on a healthy single send, which is the noise the whole staleness floor and
  // bucket machinery exist to avoid.
  it("counts only the messages WAITING, never the turn in flight", () => {
    publishConciergeQueue(HOST, { waiting: 0, running: true, oldestAt: null });
    hydrateWith([]);
    expect(buildConciergeQueue()!.queued).toBe(0);
    expect(queueUnfanned(buildConciergeQueue(), OLD)).toBeUndefined();
  });

  it("WITHHOLDS the whole reading while the research store is unhydrated", () => {
    publishConciergeQueue(HOST, { waiting: 6, running: true, oldestAt: OLD });
    // No `replaceAll` — `hydrated` is false, which is what a window looks like before its first
    // `listResearch()` lands. `byId` is empty, so a naive count says "zero agents": exactly the
    // false alarm this three-valued read exists to prevent. It used to answer with `liveAgents`
    // omitted, which relied on the consumer treating an absent count as non-finite; withholding
    // the reading says WE DID NOT LOOK in the vocabulary the consumer already has.
    expect(buildConciergeQueue()).toBeUndefined();
  });

  it("still hydrates — and so still answers — when the first listing FAILED", () => {
    // `refreshResearch` sets `hydrated` even on a failed first load, deliberately (see its header):
    // otherwise the distinction latches at "we have not looked" forever. What this window knows is
    // genuinely zero tasks, and it knows it, so the count is reportable.
    publishConciergeQueue(HOST, { waiting: 2, running: true, oldestAt: OLD });
    useResearchStore.setState({ hydrated: true });
    expect(buildConciergeQueue()).toEqual({ queued: 2, liveAgents: 0, oldestAt: OLD });
  });

  // The store publishes `null` when nothing is waiting, and a producer that lost the clock would
  // publish it too. Either way the age cannot be established, so the condition must decline —
  // carried here rather than left to the core suite because THIS is the seam that produces it.
  it("passes a missing enqueue time through as null, and the condition then declines", () => {
    publishConciergeQueue(HOST, { waiting: 4, running: true, oldestAt: null });
    hydrateWith([]);
    expect(buildConciergeQueue()!.oldestAt).toBeNull();
    expect(queueUnfanned(buildConciergeQueue(), OLD)).toBeUndefined();
  });
});
