// THE TURN-START DRAIN — and the property the whole design exists for: A DROPPED TURN DOES NOT
// DROP THE FINDING.
//
// Read `drain.ts`'s header first. The one rule is that peeking never claims: `readAt` is stamped
// only once the turn that carried the finding actually delivered, so a superseded, cancelled or
// errored turn — which `concierge.rs` produces as an ordinary outcome, not an edge case — leaves
// the finding unread and it comes back next turn.
//
// ══ WHY THESE ASSERTIONS ARE ON THE SIDE EFFECT ════════════════════════════════════════════════
//
// The repo's #1 fleet-wide finding is the vacuous test: an assertion already true before the change.
// "a task with readAt: null is unread" would be exactly that — it is `isUnread`'s definition, and it
// holds with this whole file deleted. So every case below asserts the OUTCOME: the finding's text
// reached a prompt / did not reach the second prompt / is still claimable after a turn died.
//
// The dropped-turn case was hand-mutated to confirm it can fail: moving the claim from `settle` into
// `peek` (i.e. claiming at build time, the defect this file prevents) turns it red — the finding is
// stamped by the peek and never comes back. Both the drop case and the exactly-once case go red
// together, which is the point: they are the two halves of one rule.
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_STAGED_TURNS,
  RESEARCH_FAILED_PREAMBLE_HEADER,
  RESEARCH_PREAMBLE_HEADER,
  buildResearchFailurePreamble,
  buildResearchPreamble,
  createResearchDrain,
  withResearchPreamble,
  type ResearchDrainDeps,
} from "./drain";
import { _resetResearchStoreForTests, visibleTasks } from "./store";
import type { ResearchTask } from "./types";
import type { ConciergeEvent, ConciergeEventPayload } from "../../stores/conciergeEventLog";

const FIXTURE: ResearchTask[] = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "researchTasks.sample.json"), "utf8"),
);

/** The fixture's one unread, finished task — the finding a turn is supposed to carry. */
const UNREAD = FIXTURE.find((t) => t.status === "done" && t.readAt === null)!;
/** The fixture's already-claimed one — a finding the founder has been told about. */
const CLAIMED = FIXTURE.find((t) => t.status === "done" && t.readAt !== null)!;
/** The two that stopped WITHOUT an answer. These are the 11 red rows in the founder's sidebar. */
const FAILED = FIXTURE.find((t) => t.status === "failed")!;
const CANCELLED = FIXTURE.find((t) => t.status === "cancelled")!;
/** Everything one turn is accountable for claiming, oldest-first within each section. */
const ALL_OWED = [UNREAD.id, ...[FAILED, CANCELLED].sort((a, b) => a.createdAt - b.createdAt).map((t) => t.id)];

const task = (over: Partial<ResearchTask>): ResearchTask => ({
  ...UNREAD,
  id: `rsh_${Math.random().toString(36).slice(2)}`,
  ...over,
});

/**
 * A manual clock and a MUTABLE task list, so every case is deterministic and instant — the same
 * shape `conciergeProactive.test.ts` uses for its timer harness.
 *
 * `markRead` writes `readAt` back into the list by default, which is what the real backend does via
 * `research_mark_read` plus the next `refreshResearch`. `lagCache` models the window BEFORE that
 * refresh lands: the store still reports the task unread, and only the drain's own claim set stops
 * the very next turn repeating it.
 */
function harness(
  tasks: ResearchTask[],
  opts: { lagCache?: boolean; onMarkRead?: (ids: string[], at: number) => void } = {},
) {
  let now = 1_700_000_000_000;
  const list = [...tasks];
  const marked: { ids: string[]; at: number }[] = [];
  const events: (ConciergeEventPayload & { at: number })[] = [];
  const deps: ResearchDrainDeps = {
    now: () => now,
    tasks: () => list,
    markRead: (ids, at) => {
      marked.push({ ids: [...ids], at });
      opts.onMarkRead?.(ids, at);
      if (opts.lagCache) return;
      for (const id of ids) {
        const i = list.findIndex((t) => t.id === id);
        if (i >= 0) list[i] = { ...list[i]!, readAt: at };
      }
    },
    recordEvent: (payload, at) => {
      events.push({ ...payload, at });
    },
  };
  return {
    deps,
    marked,
    events,
    list,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
    /** What the store would report as unread right now — the DISK's answer, ignoring the drain. */
    readAtOf: (id: string) => list.find((t) => t.id === id)?.readAt ?? null,
  };
}

beforeEach(() => {
  _resetResearchStoreForTests();
});

// ---------------------------------------------------------------------------------------------
// The preamble
// ---------------------------------------------------------------------------------------------

describe("buildResearchPreamble", () => {
  it("carries the finding itself, not a notice that one exists", () => {
    const p = buildResearchPreamble([UNREAD]);
    expect(p).toContain(UNREAD.findings!);
    expect(p).toContain(UNREAD.question);
    expect(p).toContain(RESEARCH_PREAMBLE_HEADER);
  });

  it("adds NOTHING at all when nothing is unread — not an empty header", () => {
    expect(buildResearchPreamble([])).toBe("");
    // And the composition is the identity, so a caller that always calls it cannot leak a blank
    // line into every prompt of every turn.
    const prompt = "All projects are calm right now.\n\nThe user says: hi";
    expect(withResearchPreamble("", prompt)).toBe(prompt);
  });

  it("puts the preamble AHEAD of the founder's message when there is one", () => {
    const prompt = "The user says: what did you find?";
    const composed = withResearchPreamble(buildResearchPreamble([UNREAD]), prompt);
    expect(composed.indexOf(UNREAD.findings!)).toBeLessThan(composed.indexOf(prompt));
  });

  it("does not truncate a long finding", () => {
    const long = "x".repeat(20_000);
    expect(buildResearchPreamble([task({ findings: long })])).toContain(long);
  });
});

describe("buildResearchFailurePreamble", () => {
  it("carries the runner's OWN sentence, not a reconstruction of it", () => {
    const p = buildResearchFailurePreamble([FAILED]);
    expect(p).toContain(FAILED.error!);
    expect(p).toContain(FAILED.question);
    expect(p).toContain(RESEARCH_FAILED_PREAMBLE_HEADER);
  });

  // The 3-minute wall clock is the failure the founder actually hit, five times in one evening. The
  // brain has to be able to READ the cap out of the line, or "re-dispatch it deeper" is advice it
  // cannot act on.
  it("passes a timeout sentence through intact, cap and all", () => {
    const timeout = "The research run hit its 3 minute limit and was stopped.";
    expect(buildResearchFailurePreamble([task({ status: "failed", error: timeout })])).toContain(
      timeout,
    );
  });

  // `cancelled` has no `error` by construction — the founder killed it. Without this arm the line
  // would read "No reason was recorded", which is true of the field and false about the world.
  it("says the founder stopped it, for a cancelled task", () => {
    const p = buildResearchFailurePreamble([CANCELLED]);
    expect(p).toContain("You stopped it.");
    expect(p).not.toContain("No reason was recorded");
  });

  // A failed task whose error never got written still has to say something honest.
  it("admits when no reason was recorded rather than inventing one", () => {
    expect(buildResearchFailurePreamble([task({ status: "failed", error: null })])).toContain(
      "No reason was recorded.",
    );
  });

  it("adds NOTHING when nothing failed — not an empty header", () => {
    expect(buildResearchFailurePreamble([])).toBe("");
  });
});

// ---------------------------------------------------------------------------------------------
// What the drain selects
// ---------------------------------------------------------------------------------------------

describe("peek — what reaches the prompt", () => {
  it("names the unread finding, and carries its findings verbatim", () => {
    const h = harness(FIXTURE);
    const d = createResearchDrain(h.deps);
    const { preamble, taskIds } = d.peek();
    expect(taskIds).toContain(UNREAD.id);
    expect(preamble).toContain(UNREAD.findings!);
  });

  // ── A FAILURE IS NOW CARRIED TOO, AND THAT IS A DELIBERATE CONTRACT CHANGE ───────────────────
  //
  // This suite used to assert the opposite ("says nothing about … failed, cancelled …"), on the
  // reasoning recorded at `isUnread`: "there are none" is not a finding, and the row is the surface
  // the founder chose. Changed on the founder's explicit instruction, and on evidence — the row had
  // stopped being a surface (28 stacked, 11 red), the event log that carried failures does not
  // survive an app reload, and five of six dispatches in one evening died silently on the 3-minute
  // wall clock. What has NOT changed is the discipline: a failure is one terse line in its own
  // section, never mixed in with findings, and it is still claimed only on delivery.
  it("names a failed and a cancelled task, in their OWN section", () => {
    const h = harness(FIXTURE);
    const { preamble, taskIds } = createResearchDrain(h.deps).peek();

    expect(taskIds).toEqual(ALL_OWED);
    expect(preamble).toContain(RESEARCH_FAILED_PREAMBLE_HEADER);
    expect(preamble).toContain(FAILED.question);
    expect(preamble).toContain(CANCELLED.question);
    // The runner's own sentence, not a reconstruction of it.
    expect(preamble).toContain(FAILED.error!);

    // THE SECTIONS MUST NOT BLUR. A failure appearing under the findings header would have the brain
    // answer the founder with "there are none" as though it were a result.
    const findingsAt = preamble.indexOf(RESEARCH_PREAMBLE_HEADER);
    const failuresAt = preamble.indexOf(RESEARCH_FAILED_PREAMBLE_HEADER);
    expect(findingsAt).toBeGreaterThanOrEqual(0);
    expect(failuresAt).toBeGreaterThan(findingsAt);
    expect(preamble.slice(findingsAt, failuresAt)).not.toContain(FAILED.question);
  });

  it("still says nothing about queued, running or already-claimed tasks", () => {
    const h = harness(FIXTURE);
    const { preamble, taskIds } = createResearchDrain(h.deps).peek();
    for (const t of FIXTURE) {
      if (ALL_OWED.includes(t.id)) continue;
      expect(preamble).not.toContain(t.question);
      expect(taskIds).not.toContain(t.id);
    }
    // Named explicitly, because this is the one a careless filter lets through: a finished task
    // WITH findings that has already been told.
    expect(preamble).not.toContain(CLAIMED.findings!);
    expect(preamble).not.toContain(CLAIMED.question);
  });

  // The empty case has to stay EXACTLY "" now that two sections are joined — `withResearchPreamble`
  // keys on that to leave a prompt untouched, so a join returning "\n\n" would put a blank line on
  // every prompt the app sends.
  it("is exactly the empty string when nothing at all is owed", () => {
    const h = harness(FIXTURE.filter((t) => t.status === "queued" || t.status === "running"));
    const { preamble, taskIds } = createResearchDrain(h.deps).peek();
    expect(preamble).toBe("");
    expect(taskIds).toEqual([]);
  });

  it("keeps the store's OLDEST-FIRST order — the story is told forwards", () => {
    const older = task({ createdAt: 1, findings: "older finding", question: "older?" });
    const newer = task({ createdAt: 2, findings: "newer finding", question: "newer?" });
    // Handed newest-first, as `sortedTasks` would give them, to prove the drain re-orders rather
    // than inheriting whatever order it is given.
    const h = harness([newer, older]);
    const { preamble, taskIds } = createResearchDrain(h.deps).peek();
    expect(taskIds).toEqual([older.id, newer.id]);
    expect(preamble.indexOf("older finding")).toBeLessThan(preamble.indexOf("newer finding"));
  });

  it("stamps NOTHING — peeking is not claiming", () => {
    const h = harness(FIXTURE);
    const d = createResearchDrain(h.deps);
    d.peek();
    d.peek();
    d.peek();
    expect(h.marked).toEqual([]);
    expect(h.readAtOf(UNREAD.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Exactly once
// ---------------------------------------------------------------------------------------------

describe("a delivered finding is not told twice", () => {
  it("appears in the first turn's prompt and NOT in the second's", () => {
    const h = harness(FIXTURE);
    const d = createResearchDrain(h.deps);

    const first = d.peek();
    d.stage("11", first.taskIds);
    d.settle("11"); // the turn's `concierge:done` landed

    const second = d.peek();
    expect(first.preamble).toContain(UNREAD.findings!);
    expect(second.preamble).toBe("");
    expect(second.taskIds).toEqual([]);
    // The failures are claimed by the SAME settle, because the same prompt delivered them — which is
    // what lets their rows retire. Surfaced once, then gone.
    expect(h.marked).toEqual([{ ids: ALL_OWED, at: h.at() }]);
    expect(h.readAtOf(UNREAD.id)).toBe(h.at());
    expect(h.readAtOf(FAILED.id)).toBe(h.at());
    expect(h.readAtOf(CANCELLED.id)).toBe(h.at());
  });

  // THE WHOLE POINT OF THE FEATURE, asserted end-to-end on the drain's own terms: after one
  // delivered turn, every terminal task in the fixture is retired and the row has nothing left to
  // show but live work. Before the turn, none of them are.
  it("leaves every terminal task RETIRED once a turn has delivered", () => {
    const h = harness(FIXTURE);
    const d = createResearchDrain(h.deps);

    expect(visibleTasks(h.list).map((t) => t.id)).toEqual(
      expect.arrayContaining([UNREAD.id, FAILED.id, CANCELLED.id]),
    );

    const first = d.peek();
    d.stage("11", first.taskIds);
    d.settle("11");

    const stillShowing = visibleTasks(h.list);
    expect(stillShowing.map((t) => t.id)).not.toContain(UNREAD.id);
    expect(stillShowing.map((t) => t.id)).not.toContain(FAILED.id);
    expect(stillShowing.map((t) => t.id)).not.toContain(CANCELLED.id);
    // What REMAINS is exactly the work still in flight — teardown never touches a running row.
    expect(stillShowing.map((t) => t.status).sort()).toEqual(["queued", "running"]);
  });

  // The failure direction that would be a silent loss: a turn that never delivered must leave the
  // failure notice owed, and its row on screen. `abandon` is the superseded/cancelled path.
  it("keeps a failure owed — and its row visible — when the turn never delivered", () => {
    const h = harness(FIXTURE);
    const d = createResearchDrain(h.deps);

    const first = d.peek();
    d.stage("11", first.taskIds);
    d.abandon("11"); // superseded before it rendered — the founder was told nothing

    expect(h.marked).toEqual([]);
    expect(h.readAtOf(FAILED.id)).toBeNull();
    expect(visibleTasks(h.list).map((t) => t.id)).toContain(FAILED.id);
    // ...and it is offered again on the very next turn.
    expect(d.peek().taskIds).toEqual(ALL_OWED);
  });

  it("holds even while the store's cache still reports it unread", () => {
    // `markResearchRead` writes to disk; the store is a mirror refreshed by a poll. In the window
    // before that poll lands, the task still LOOKS unread — and the next turn is seconds away.
    const h = harness(FIXTURE, { lagCache: true });
    const d = createResearchDrain(h.deps);
    const first = d.peek();
    d.stage("11", first.taskIds);
    d.settle("11");
    expect(h.readAtOf(UNREAD.id)).toBeNull(); // the cache has NOT caught up
    expect(d.peek().preamble).toBe(""); // ...and it is still not repeated
  });

  it("claims each finding once even when two turns carried it", () => {
    // Turn A is superseded, so B repeats the finding — the recoverable direction. When A's late
    // `done` never comes and B settles, the stamp happens once.
    const h = harness(FIXTURE, { lagCache: true });
    const d = createResearchDrain(h.deps);
    const a = d.peek();
    d.stage("11", a.taskIds);
    const b = d.peek();
    expect(b.taskIds).toEqual(ALL_OWED); // A told the founder nothing yet, so B carries it all too
    d.stage("12", b.taskIds);
    d.settle("12");
    d.settle("11");
    expect(h.marked).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// THE ONE THAT MATTERS
// ---------------------------------------------------------------------------------------------

describe("a dropped turn does not drop the finding", () => {
  it("a turn ABANDONED after the preamble was built leaves it unread and re-delivers it", () => {
    const h = harness(FIXTURE);
    const d = createResearchDrain(h.deps);

    const first = d.peek();
    expect(first.preamble).toContain(UNREAD.findings!);
    d.stage("11", first.taskIds);
    // The user sent again: concierge.rs installed turn 12 and KILLED 11's child. 11 emits no
    // `done`; the host abandons it.
    d.abandon("11");

    expect(h.marked).toEqual([]);
    expect(h.readAtOf(UNREAD.id)).toBeNull();
    const second = d.peek();
    expect(second.taskIds).toEqual(ALL_OWED);
    expect(second.preamble).toContain(UNREAD.findings!);
  });

  it("a transport that REJECTS never stages, so nothing is ever claimed", async () => {
    const h = harness(FIXTURE);
    const d = createResearchDrain(h.deps);
    const peeked = d.peek();
    // The real shape: `startConciergeTurn(...).then(stage, onError)`. A rejection means no turn id
    // ever existed — there is nothing to claim against, and the catch must not invent one.
    await Promise.reject(new Error("bridge is gone")).then(
      (id: unknown) => d.stage(String(id), peeked.taskIds),
      () => {
        /* the host's error branch: say so, claim nothing */
      },
    );
    expect(h.marked).toEqual([]);
    expect(h.readAtOf(UNREAD.id)).toBeNull();
    expect(d.peek().preamble).toContain(UNREAD.findings!);
  });

  it("a turn that resolved but was superseded before it spoke is abandoned, not claimed", () => {
    const h = harness(FIXTURE);
    const d = createResearchDrain(h.deps);
    d.stage("11", d.peek().taskIds);
    d.abandon("11"); // `supersededTurn(e.id)` in the host's `concierge:done` handler
    expect(d.stats()).toMatchObject({ claimed: 0, abandoned: 1 });
    expect(d.peek().taskIds).toEqual(ALL_OWED);
  });

  it("an evicted staging is a repeat, never a loss", () => {
    const h = harness(FIXTURE, { lagCache: true });
    const d = createResearchDrain(h.deps);
    d.stage("1", [UNREAD.id]);
    for (let i = 0; i < MAX_STAGED_TURNS; i++) d.stage(`x${i}`, ["other"]);
    d.settle("1"); // evicted — this claims nothing
    expect(h.marked).toEqual([]);
    expect(d.peek().taskIds).toEqual(ALL_OWED);
    expect(d.stats().evicted).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The event log — the half the preamble cannot carry
// ---------------------------------------------------------------------------------------------

describe("research_completed", () => {
  it("records every terminal task once, including the ones no prompt will ever mention", () => {
    const h = harness(FIXTURE);
    const d = createResearchDrain(h.deps);
    d.observe();
    d.observe();
    d.peek(); // observes again — still no duplicates
    const byId = h.events.map((e) => (e as { taskId: string; status: string }));
    expect(byId.map((e) => e.status).sort()).toEqual(["cancelled", "done", "done", "failed"]);
    expect(new Set(byId.map((e) => e.taskId)).size).toBe(4);
    // Queued and running are NOT terminal and must not be announced as endings.
    const live = FIXTURE.filter((t) => t.status === "queued" || t.status === "running");
    for (const t of live) expect(byId.some((e) => e.taskId === t.id)).toBe(false);
  });

  it("carries no question text and no findings", () => {
    const h = harness(FIXTURE);
    createResearchDrain(h.deps).observe();
    const json = JSON.stringify(h.events);
    expect(json).not.toContain(UNREAD.question);
    expect(json).not.toContain(UNREAD.findings!);
  });

  it("announces a task that finished AFTER the first observation", () => {
    const running = task({ status: "running", findings: null, finishedAt: null });
    const h = harness([running]);
    const d = createResearchDrain(h.deps);
    d.observe();
    expect(h.events).toEqual([]);
    h.list[0] = { ...running, status: "failed", error: "claude exited 1", finishedAt: 42 };
    d.observe();
    expect(h.events).toEqual([
      { kind: "research_completed", taskId: running.id, projectId: running.projectId, status: "failed", at: 42 },
    ]);
  });

  it("works with no recorder wired at all", () => {
    const h = harness(FIXTURE);
    const d = createResearchDrain({ ...h.deps, recordEvent: undefined });
    expect(() => d.observe()).not.toThrow();
    expect(d.peek().taskIds).toEqual(ALL_OWED);
  });
});

// A compile-time tie rather than a runtime one: the payload the drain records has to be a member of
// the log's union, so a rename on either side fails here instead of at runtime in production.
const _typeTie: ConciergeEventPayload = {
  kind: "research_completed",
  taskId: "r",
  projectId: null,
  status: "done",
};
void (_typeTie as ConciergeEvent | ConciergeEventPayload);
