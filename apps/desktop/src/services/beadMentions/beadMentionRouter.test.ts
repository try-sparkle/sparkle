// Tests for the bead-comment @mention router.
//
// WHAT THESE ASSERT, AND WHY IT IS NOT THE OBVIOUS THING. A test that checks an `@name` was PARSED
// out of a comment is vacuous: it passes against a router whose doorbell never fires, which is
// precisely the bug being fixed (a comment posted, nobody woken). So every test here drives
// `runMentionTick` — the real entry point — and asserts on what reached the SEAMS: what was queued
// into an agent's inbox, and what was posted back onto the bead. The parse is incidental.
//
// The paired negative matters as much as the positive: "a comment mentioning nobody produces NO
// doorbell" is what stops a router that doorbells everyone from passing.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyRouterState,
  runMentionTick,
  selectBeadsToRead,
  LEDGER_MAX_AGE_MS,
  MAX_DOORBELLS_PER_TICK,
  UNDELIVERED_DEADLINE_MS,
  type BeadCommentCount,
  type DoorbellState,
  type RouterComment,
  type RouterDeps,
  type RouterState,
} from "./beadMentionRouter";
import { ROUTER_MARKER } from "./mentionMessages";

const ALICE = { id: "agent-alice", name: "Backstop Agent" };
const BOB = { id: "agent-bob", name: "Improve Sparkle" };

interface Harness {
  deps: RouterDeps;
  enqueued: Array<{ agentId: string; text: string; from: string }>;
  posted: Array<{ beadId: string; text: string }>;
  comments: Map<string, RouterComment[]>;
  states: Map<string, DoorbellState>;
  clock: { now: number };
  errors: Array<{ where: string; err: unknown }>;
}

function harness(opts: {
  candidates?: Array<{ id: string; name: string }>;
  comments?: Record<string, RouterComment[]>;
  enqueueFails?: boolean;
  /** Start refusing enqueues after this many successes — lets a RETRY pass deliver nothing new. */
  enqueueFailAfter?: number;
} = {}): Harness {
  const enqueued: Harness["enqueued"] = [];
  const posted: Harness["posted"] = [];
  const errors: Harness["errors"] = [];
  const comments = new Map(Object.entries(opts.comments ?? {}));
  const states = new Map<string, DoorbellState>();
  const clock = { now: 1_000_000 };
  let seq = 0;

  const deps: RouterDeps = {
    listCandidates: () => opts.candidates ?? [ALICE, BOB],
    fetchComments: async (beadId) => comments.get(beadId) ?? [],
    enqueueDoorbell: async (agentId, text, from) => {
      if (opts.enqueueFails) throw new Error("inbox full");
      if (opts.enqueueFailAfter !== undefined && enqueued.length >= opts.enqueueFailAfter) {
        throw new Error("inbox full");
      }
      enqueued.push({ agentId, text, from });
      seq += 1;
      const id = `msg-${seq}`;
      // A freshly queued message is PENDING — queued is not delivered. Tests move it on explicitly.
      states.set(id, "pending");
      return id;
    },
    postComment: async (beadId, text) => {
      posted.push({ beadId, text });
    },
    readDoorbellStates: async () => states,
    now: () => clock.now,
    onError: (where, err) => errors.push({ where, err }),
  };
  return { deps, enqueued, posted, comments, states, clock, errors };
}

/** Seed the bead so the tick under test sees a RISE rather than a first sighting. */
function seeded(beadId: string, count: number): RouterState {
  return { ...emptyRouterState(), baselines: { [beadId]: count } };
}

const beads = (id: string, commentCount: number): BeadCommentCount[] => [{ id, commentCount }];

describe("runMentionTick — the doorbell", () => {
  it("delivers a doorbell to the mentioned agent, naming the bead", async () => {
    const h = harness({
      comments: {
        "sparkle-1": [
          { id: "c1", author: "Improve Sparkle", text: "@Backstop Agent stand down, plan superseded" },
        ],
      },
    });

    const { report } = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);

    // THE SIDE EFFECT: something was queued, for ALICE specifically.
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]!.agentId).toBe(ALICE.id);
    // It points AT the bead — that is what makes it actionable without carrying the body.
    expect(h.enqueued[0]!.text).toContain("sparkle-1");
    expect(report.doorbelled).toEqual([
      { agentId: ALICE.id, beadId: "sparkle-1", commentId: "c1", messageId: "msg-1" },
    ]);
  });

  it("does NOT carry the comment body into the inbox", async () => {
    const secret = "the full text of the coordination message";
    const h = harness({
      comments: { "sparkle-1": [{ id: "c1", author: "x", text: `@Backstop Agent ${secret}` }] },
    });
    await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);
    expect(h.enqueued[0]!.text).not.toContain(secret);
  });

  it("a comment mentioning NOBODY produces no doorbell at all", async () => {
    const h = harness({
      comments: {
        "sparkle-1": [{ id: "c1", author: "x", text: "just a normal comment, no handles here" }],
      },
    });

    const { report } = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);

    expect(h.enqueued).toHaveLength(0);
    expect(h.posted).toHaveLength(0);
    expect(report.doorbelled).toHaveLength(0);
  });

  it("resolves an agent by id as well as by name", async () => {
    const h = harness({
      comments: { "sparkle-1": [{ id: "c1", author: "x", text: `@${BOB.id} take a look` }] },
    });
    await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);
    expect(h.enqueued.map((e) => e.agentId)).toEqual([BOB.id]);
  });
});

describe("runMentionTick — a mention that reaches nobody is visible to whoever wrote it", () => {
  it("reports an UNKNOWN handle back onto the same bead, and queues nothing", async () => {
    const h = harness({
      comments: { "sparkle-1": [{ id: "c1", author: "x", text: "@nobody-at-all please help" }] },
    });

    const { report } = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);

    expect(h.enqueued).toHaveLength(0);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.beadId).toBe("sparkle-1");
    expect(h.posted[0]!.text).toContain("NOT DELIVERED");
    expect(h.posted[0]!.text).toContain("nobody-at-all");
    expect(report.unresolved).toEqual([
      { beadId: "sparkle-1", commentId: "c1", token: "nobody-at-all", reason: "unknown" },
    ]);
  });

  it("reports an AMBIGUOUS handle and names the colliding ids, and queues nothing", async () => {
    const twin = { id: "agent-twin", name: "Backstop Agent" };
    const h = harness({
      candidates: [ALICE, twin],
      comments: { "sparkle-1": [{ id: "c1", author: "x", text: "@Backstop Agent ping" }] },
    });

    const { report } = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);

    expect(h.enqueued).toHaveLength(0);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.text).toContain(ALICE.id);
    expect(h.posted[0]!.text).toContain(twin.id);
    expect(report.unresolved[0]).toMatchObject({ reason: "ambiguous" });
  });

  it("posts ONE comment however many handles in it failed", async () => {
    const h = harness({
      comments: {
        "sparkle-1": [{ id: "c1", author: "x", text: "@ghost-one @ghost-two @ghost-three" }],
      },
    });
    await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.text).toContain("ghost-one");
    expect(h.posted[0]!.text).toContain("ghost-three");
  });

  it("an enqueue that REFUSES is not recorded as a doorbell, and is not blamed on the handle", async () => {
    const h = harness({
      enqueueFails: true,
      comments: { "sparkle-1": [{ id: "c1", author: "x", text: "@Backstop Agent hi" }] },
    });

    const { report } = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);

    expect(report.doorbelled).toHaveLength(0);
    // The writer still learns it went nowhere — silence would be the bug this feature removes.
    expect(h.posted[0]!.text).toContain("NOT DELIVERED");
    // AND IT SAYS THE RIGHT THING. Reporting this as an unresolvable handle told the writer the
    // agent does not exist and to "re-comment naming an agent id" — false twice over, with a remedy
    // that hits the identical refusal. A remedy is an instruction someone will follow.
    expect(report.unresolved[0]).toMatchObject({ reason: "enqueue-failed", resolvedId: ALICE.id });
    expect(h.posted[0]!.text).toContain(ALICE.id);
    expect(h.posted[0]!.text).not.toContain("matches no agent");
    expect(h.posted[0]!.text).not.toContain("Re-comment naming an agent id");
  });
});

describe("runMentionTick — queued is not delivered (the 2026-08-14 shape)", () => {
  it("says UNDELIVERED on the bead when a doorbell is still pending past the deadline", async () => {
    const h = harness({
      comments: { "sparkle-1": [{ id: "c1", author: "x", text: "@Backstop Agent urgent" }] },
    });

    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);
    expect(h.posted).toHaveLength(0); // not yet overdue

    h.clock.now += UNDELIVERED_DEADLINE_MS + 1;
    const second = await runMentionTick(first.state, beads("sparkle-1", 1), h.deps);

    expect(second.report.undelivered).toEqual([
      { agentId: ALICE.id, beadId: "sparkle-1", messageId: "msg-1" },
    ]);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.text).toContain("UNDELIVERED");
  });

  it("reports UNDELIVERED exactly once, not on every later tick", async () => {
    const h = harness({
      comments: { "sparkle-1": [{ id: "c1", author: "x", text: "@Backstop Agent urgent" }] },
    });
    let s = (await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps)).state;
    h.clock.now += UNDELIVERED_DEADLINE_MS + 1;
    s = (await runMentionTick(s, beads("sparkle-1", 1), h.deps)).state;
    s = (await runMentionTick(s, beads("sparkle-1", 1), h.deps)).state;
    await runMentionTick(s, beads("sparkle-1", 1), h.deps);
    expect(h.posted.filter((p) => p.text.includes("UNDELIVERED"))).toHaveLength(1);
  });

  it("stays SILENT once the queue says the message was actually delivered", async () => {
    const h = harness({
      comments: { "sparkle-1": [{ id: "c1", author: "x", text: "@Backstop Agent urgent" }] },
    });
    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);

    h.states.set("msg-1", "delivered");
    h.clock.now += UNDELIVERED_DEADLINE_MS + 1;
    const second = await runMentionTick(first.state, beads("sparkle-1", 1), h.deps);

    expect(second.report.undelivered).toHaveLength(0);
    expect(h.posted).toHaveLength(0);
  });

  it("a MISSING message is reported too — the queue having no record is not success", async () => {
    // The fail-OPEN this closes. `missing` means the queue cannot account for the notice at all
    // (expired, compacted, the agent's queue torn down). Skipping it left the sender believing a
    // mention landed that nothing can vouch for — in the one direction this feature claims to be
    // closed. Distinct from the UNREADABLE case below: that path THROWS, this one returns a
    // perfectly valid map that simply lacks the id, so the throwing test cannot see it.
    const h = harness({
      comments: { "sparkle-1": [{ id: "c1", author: "x", text: "@Backstop Agent urgent" }] },
    });
    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);

    h.states.delete("msg-1"); // the queue no longer knows about it
    h.clock.now += UNDELIVERED_DEADLINE_MS + 1;
    const second = await runMentionTick(first.state, beads("sparkle-1", 1), h.deps);

    expect(second.report.undelivered).toHaveLength(1);
    expect(h.posted[0]!.text).toContain("missing");
    expect(h.posted[0]!.text).toContain("will NOT arrive");
  });

  it("a DELIVERED doorbell that later ages out of the queue is NOT reported undelivered", async () => {
    // THE FALSE-REPORT BUG. Once `missing` became reportable, every successfully delivered mention
    // re-read as `missing` the moment the queue aged its record out — and the router would post
    // "it will NOT arrive" onto the bead for a message the agent had read hours earlier, into a
    // shared, founder-visible, non-revertible store. The never-delivered `missing` test cannot see
    // this: it deletes the id from a doorbell that was never delivered in the first place.
    const h = harness({
      comments: { "sparkle-1": [{ id: "c1", author: "x", text: "@Backstop Agent hi" }] },
    });
    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);

    // Delivered and acknowledged...
    h.states.set("msg-1", "acknowledged");
    const second = await runMentionTick(first.state, beads("sparkle-1", 1), h.deps);
    expect(second.state.ledger[0]!.resolved).toBe(true);

    // ...then the queue drops the record entirely, which reads back as `missing`.
    h.states.delete("msg-1");
    h.clock.now += UNDELIVERED_DEADLINE_MS * 10;
    const third = await runMentionTick(second.state, beads("sparkle-1", 1), h.deps);

    expect(third.report.undelivered).toHaveLength(0);
    expect(h.posted).toHaveLength(0);
  });

  it("STILL reports an aged entry the queue affirmatively lists as pending", async () => {
    // Only `missing` is ambiguous past the ledger window. A `pending` verdict is not ambiguous at
    // any age — `entries_of` filters expired records out, so the queue still listing it is an
    // affirmative statement that the agent never got it. Skipping on age before reading the verdict
    // silenced that too, and the entry is retired straight after, so nothing could ever report it.
    const h = harness({
      comments: { "sparkle-1": [{ id: "c1", author: "x", text: "@Backstop Agent hi" }] },
    });
    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);

    h.clock.now += LEDGER_MAX_AGE_MS + 60_000; // still `pending` in the queue
    const second = await runMentionTick(first.state, beads("sparkle-1", 1), h.deps);

    expect(second.report.undelivered).toHaveLength(1);
    expect(h.posted[0]!.text).toContain("pending");
  });

  it("says NOTHING about an entry that aged past the ledger window while no tick ran", async () => {
    // THE GAP THE `resolved` LATCH DOES NOT COVER. Retirement is a filter that runs AFTER the
    // reporting loop, and the loop's deadline check skips YOUNG entries, not old ones — so an entry
    // crossing both the ledger window and the queue's TTL between two ticks got one final false
    // report. That gap is ordinary: ticks run only for the SELECTED project and the ledger persists
    // across restarts, so quitting the app or switching projects freezes it. Here the doorbell is
    // delivered seconds after being queued but NO tick observes it, so `resolved` is never latched
    // — exactly the residual case.
    const h = harness({
      comments: { "sparkle-1": [{ id: "c1", author: "x", text: "@Backstop Agent hi" }] },
    });
    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);
    expect(first.state.ledger[0]!.resolved).toBeUndefined();

    // The app is away for a day; the queue has long since dropped the record.
    h.states.delete("msg-1");
    h.clock.now += LEDGER_MAX_AGE_MS + 60_000;
    const second = await runMentionTick(first.state, beads("sparkle-1", 1), h.deps);

    expect(second.report.undelivered).toHaveLength(0);
    expect(h.posted).toHaveLength(0);
    // …and it is retired, so it cannot come back on a later tick either.
    expect(second.state.ledger).toHaveLength(0);
  });

  it("an UNREADABLE queue never resolves to delivered — it stays pending and retries", async () => {
    const h = harness({
      comments: { "sparkle-1": [{ id: "c1", author: "x", text: "@Backstop Agent urgent" }] },
    });
    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);

    const boom = vi.fn(async () => {
      throw new Error("queue unreadable");
    });
    const failing: RouterDeps = { ...h.deps, readDoorbellStates: boom };
    h.clock.now += UNDELIVERED_DEADLINE_MS + 1;
    const second = await runMentionTick(first.state, beads("sparkle-1", 1), failing);

    expect(boom).toHaveBeenCalled();
    expect(second.report.undelivered).toHaveLength(0);
    // Still outstanding, still unreported — so a later readable tick can still say UNDELIVERED.
    expect(second.state.ledger).toHaveLength(1);
    expect(second.state.ledger[0]!.reportedUndelivered).toBeUndefined();
  });
});

describe("runMentionTick — a mention storm is not a wake storm", () => {
  it("doorbells an agent ONCE for a given comment, even across repeated ticks", async () => {
    const h = harness({
      comments: {
        "sparkle-1": [{ id: "c1", author: "x", text: "@Backstop Agent @Backstop Agent again" }],
      },
    });
    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);
    // Same bead re-read (count rises again, comment list unchanged).
    h.comments.set("sparkle-1", [
      { id: "c1", author: "x", text: "@Backstop Agent @Backstop Agent again" },
      { id: "c2", author: "x", text: "unrelated" },
    ]);
    await runMentionTick(first.state, beads("sparkle-1", 2), h.deps);

    expect(h.enqueued.filter((e) => e.agentId === ALICE.id)).toHaveLength(1);
  });

  it("doorbells ONCE when one comment names the same agent by BOTH name and id", async () => {
    // THE CASE THE LEDGER DEDUPE ACTUALLY GUARDS, and it is not the one you would guess. Across two
    // ticks the `processed` set already suppresses a re-route, so a repeated-tick test passes even
    // with the ledger check deleted — an earlier guard short-circuits the path (the trap AGENTS.md
    // records). Within ONE comment, though, `@Backstop Agent` and `@agent-alice` are two DISTINCT
    // tokens that resolve to the SAME agent — token de-duplication cannot see that, so the ledger is
    // the only thing standing between a natural way of writing a mention and a double wake.
    const h = harness({
      comments: {
        "sparkle-1": [
          { id: "c1", author: "x", text: "@Backstop Agent (@agent-alice) please stand down" },
        ],
      },
    });

    const { report } = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);

    expect(h.enqueued).toHaveLength(1);
    expect(report.doorbelled).toHaveLength(1);
  });

  it("defers a comment whose tokens exhaust the budget MID-WAY, losing none of them", async () => {
    // The likely shape, not the corner one: the budget is shared across up to 8 beads, so landing
    // exactly on a comment boundary is the UNLIKELY outcome. Dropping the remaining tokens here
    // would lose those mentions permanently and silently — this module's own failure mode,
    // reintroduced by its own rate limit.
    const many = Array.from({ length: MAX_DOORBELLS_PER_TICK + 3 }, (_, i) => ({
      id: `agent-${i}`,
      name: `Agent${i}`,
    }));
    const h = harness({
      candidates: many,
      comments: {
        "sparkle-1": [{ id: "c1", author: "x", text: many.map((m) => `@${m.name}`).join(" ") }],
      },
    });

    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);
    expect(h.enqueued).toHaveLength(MAX_DOORBELLS_PER_TICK);
    // The comment is NOT latched, and the bead's baseline has NOT advanced.
    expect(first.state.processed).not.toContain("c1");
    expect(first.state.baselines["sparkle-1"]).toBe(0);

    const second = await runMentionTick(first.state, beads("sparkle-1", 1), h.deps);
    // The remaining three are delivered, and nothing already sent is sent twice.
    expect(h.enqueued).toHaveLength(MAX_DOORBELLS_PER_TICK + 3);
    expect(new Set(h.enqueued.map((e) => e.agentId)).size).toBe(MAX_DOORBELLS_PER_TICK + 3);
    expect(second.report.doorbelled).toHaveLength(3);
  });

  it("does not post a refusal twice for a comment that was deferred mid-way", async () => {
    // THE FIXTURE HAS TO REACH THE DEFERRAL PATH, and the obvious one does not: the budget check
    // sits AFTER the unknown/ambiguous/self-mention `continue`s, so unresolvable handles never
    // consume budget and never trigger exhaustion. A comment of exactly MAX resolvable agents plus
    // some ghosts therefore finishes normally, and the assertion holds whether or not the exhausted
    // path double-posts. It needs MORE than MAX resolvable agents, with the ghost seen EARLY so the
    // refusal list is non-empty at the moment exhaustion fires.
    const many = Array.from({ length: MAX_DOORBELLS_PER_TICK + 3 }, (_, i) => ({
      id: `agent-${i}`,
      name: `Agent${i}`,
    }));
    const h = harness({
      candidates: many,
      comments: {
        "sparkle-1": [
          {
            id: "c1",
            author: "x",
            text: `@ghost ${many.map((m) => `@${m.name}`).join(" ")}`,
          },
        ],
      },
    });

    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);
    // Exhaustion really fired: the comment is un-processed and the bead is unadvanced.
    expect(first.report.deferred).toBe(1);
    expect(first.state.processed).not.toContain("c1");
    expect(first.state.baselines["sparkle-1"]).toBe(0);
    // And nothing was posted on the deferred tick — the refusal is unreachable past the return.
    expect(h.posted).toHaveLength(0);

    const second = await runMentionTick(first.state, beads("sparkle-1", 1), h.deps);
    expect(second.report.deferred).toBe(0);
    // Exactly one refusal, on the completing tick.
    expect(h.posted.filter((p) => p.text.includes("ghost"))).toHaveLength(1);
  });

  it("does not claim a mixed report reached nobody when a reserved handle WAS delivered", async () => {
    // The common shape: a reserved handle beside a typo'd one. An all-or-nothing heading falls back
    // to "reached nobody" over a list whose first line says the notice went through.
    const h = harness({
      candidates: [{ id: "agent-imposter", name: "Sparkle" }],
      comments: {
        "sparkle-1": [{ id: "c1", author: "x", text: "@Sparkle stand down and @Bakstop confirm" }],
      },
    });
    const withSpecial: RouterDeps = {
      ...h.deps,
      specialHandleNames: ["Sparkle"],
      resolveSpecialHandle: (t) =>
        t.trim().toLowerCase() === "sparkle"
          ? { id: "sparkle:concierge", name: "Sparkle" }
          : null,
    };

    await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), withSpecial);

    expect(h.enqueued.map((e) => e.agentId)).toEqual(["sparkle:concierge"]);
    expect(h.posted[0]!.text).not.toContain("reached nobody");
    expect(h.posted[0]!.text).toContain("PARTIALLY DELIVERED");
    expect(h.posted[0]!.text).toContain("Bakstop");
  });

  it("caps doorbells per tick and defers the rest rather than fanning out", async () => {
    const many = Array.from({ length: MAX_DOORBELLS_PER_TICK + 5 }, (_, i) => ({
      id: `agent-${i}`,
      name: `Agent${i}`,
    }));
    const text = many.map((m) => `@${m.name}`).join(" ");
    const h = harness({
      candidates: many,
      comments: { "sparkle-1": [{ id: "c1", author: "x", text }] },
    });

    const { report } = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);

    expect(h.enqueued).toHaveLength(MAX_DOORBELLS_PER_TICK);
    // ONE COMMENT deferred — not five tokens dropped. The whole comment is retried next tick, which
    // is the point: the ceiling bounds a tick's fan-out, it does not discard mentions.
    expect(report.deferred).toBe(1);
  });

  it("never wakes an agent about its OWN comment", async () => {
    const h = harness({
      comments: {
        "sparkle-1": [{ id: "c1", author: ALICE.name, text: "@Backstop Agent note to self" }],
      },
    });
    await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);
    expect(h.enqueued).toHaveLength(0);
  });

  it("NEVER re-scans a comment it wrote itself — the refusal loop guard", async () => {
    const h = harness({
      comments: {
        // Our own refusal, which necessarily names an unresolvable handle. Scanning it would produce
        // another refusal, which would be scanned again, forever, on a shared store.
        "sparkle-1": [
          { id: "c1", author: "sparkle", text: `${ROUTER_MARKER} NOT DELIVERED — "ghost" matches no agent` },
        ],
      },
    });

    const { report } = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);

    expect(h.posted).toHaveLength(0);
    expect(h.enqueued).toHaveLength(0);
    expect(report.unresolved).toHaveLength(0);
  });
});

describe("a SEEDED bead's history is never routed — only the tail", () => {
  it("routes ONLY the new comment when a long-lived bead gains one", async () => {
    // THE BUG: seeding records a COUNT, not WHICH comments were there. So "seeded => nothing routed"
    // held for the seed tick and was falsified one comment later — the first count rise re-read the
    // bead's ENTIRE history and routed every comment in it. On a first launch, or after any
    // localStorage loss (documented as safe), one new comment on an old bead became a doorbell for
    // every historic @mention on it, written to a shared, non-revertible store.
    const h = harness({
      comments: {
        "sparkle-1": [
          { id: "old1", author: "x", text: "@Backstop Agent ancient message" },
          { id: "old2", author: "x", text: "@Improve Sparkle also ancient" },
          { id: "old3", author: "x", text: "@ghost-from-the-past" },
          { id: "new1", author: "x", text: "@Backstop Agent the actual new one" },
        ],
      },
    });

    // Baseline 3 = we have already accounted for the three historic comments.
    const { report } = await runMentionTick(seeded("sparkle-1", 3), beads("sparkle-1", 4), h.deps);

    expect(report.doorbelled).toHaveLength(1);
    expect(report.doorbelled[0]!.commentId).toBe("new1");
    // And no refusal for the historic unresolvable handle either.
    expect(h.posted).toHaveLength(0);
  });

  it("records the skipped history as seen, so a baseline reset cannot resurrect it", async () => {
    const h = harness({
      comments: {
        "sparkle-1": [
          { id: "old1", author: "x", text: "@Backstop Agent ancient" },
          { id: "new1", author: "x", text: "plain" },
        ],
      },
    });
    const { state } = await runMentionTick(seeded("sparkle-1", 1), beads("sparkle-1", 2), h.deps);
    expect(state.processed).toContain("old1");
  });
});

describe("the per-tick ceiling DEFERS; it must not drop", () => {
  it("retries a suppressed comment on the next tick instead of losing it", async () => {
    // Marking a comment processed BEFORE routing it — and advancing the bead's baseline past it —
    // turned a suppressed doorbell into a mention that reached nobody, silently, with nothing posted
    // back onto the bead. That is the exact failure class this module exists to remove.
    const many = Array.from({ length: MAX_DOORBELLS_PER_TICK }, (_, i) => ({
      id: `agent-${i}`,
      name: `Agent${i}`,
    }));
    const h = harness({
      candidates: [...many, ALICE],
      comments: {
        "sparkle-1": [
          { id: "c1", author: "x", text: many.map((m) => `@${m.name}`).join(" ") },
          { id: "c2", author: "x", text: "@Backstop Agent you matter too" },
        ],
      },
    });

    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 2), h.deps);
    expect(first.report.deferred).toBeGreaterThan(0);
    expect(h.enqueued.map((e) => e.agentId)).not.toContain(ALICE.id);
    // The bead's baseline must NOT have advanced past the deferred comment.
    expect(first.state.baselines["sparkle-1"]).toBe(0);

    const second = await runMentionTick(first.state, beads("sparkle-1", 2), h.deps);
    expect(h.enqueued.map((e) => e.agentId)).toContain(ALICE.id);
    expect(second.report.doorbelled.some((d) => d.commentId === "c2")).toBe(true);
  });
});

describe("the count and the comment array are different numbers", () => {
  it("keeps routing when the detail read returns FEWER comments than the list count", async () => {
    // bd's comment parser is deliberately TOLERANT — a comment missing its `text` is dropped rather
    // than failing the read — so `comments.length` can sit permanently below `comment_count`. Using
    // the list count as an array index left the slice offset forever past the end: `slice(offset)`
    // returns [] for every future comment while the baseline keeps advancing. Silent, permanent
    // non-delivery on that bead, and it never self-corrects.
    const h = harness({
      comments: {
        "sparkle-1": [
          { id: "c1", author: "x", text: "old one" },
          { id: "c2", author: "x", text: "old two" },
        ],
      },
    });

    // The board says 3 comments; the detail read only ever yields 2 (one was dropped by bd).
    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 3), h.deps);
    expect(first.state.accounted?.["sparkle-1"]).toBe(2);
    expect(first.state.baselines["sparkle-1"]).toBe(3);

    // A genuinely new comment arrives.
    h.comments.set("sparkle-1", [
      { id: "c1", author: "x", text: "old one" },
      { id: "c2", author: "x", text: "old two" },
      { id: "c3", author: "x", text: "@Backstop Agent take over" },
    ]);
    const second = await runMentionTick(first.state, beads("sparkle-1", 4), h.deps);

    expect(second.report.doorbelled).toHaveLength(1);
    expect(second.report.doorbelled[0]!.commentId).toBe("c3");
  });
});

describe("reserved handles resolve ahead of the roster", () => {
  it("a roster agent sharing a reserved name cannot shadow it", async () => {
    // `resolveAgentMention` answers `ambiguous` on ANY name collision, so concatenating the reserved
    // handles onto the roster made the app's own address unaddressable exactly when a similarly
    // named agent was running — and posted an ambiguity refusal for it onto the bead.
    const h = harness({
      candidates: [{ id: "agent-imposter", name: "Improve Sparkle" }],
      comments: {
        "sparkle-1": [{ id: "c1", author: "x", text: "@Improve Sparkle stand down" }],
      },
    });
    const withSpecial: RouterDeps = {
      ...h.deps,
      specialHandleNames: ["Improve Sparkle", "improve"],
      resolveSpecialHandle: (t) =>
        t.trim().toLowerCase() === "improve sparkle" || t.trim().toLowerCase() === "improve"
          ? { id: "__sparkle_self__", name: "Improve Sparkle" }
          : null,
    };

    const { report } = await runMentionTick(
      seeded("sparkle-1", 0),
      beads("sparkle-1", 1),
      withSpecial,
    );

    // The doorbell goes to the reserved target — precedence is correct, the way OUT must not be
    // shadowable — but the collision is REPORTED rather than silent.
    expect(h.enqueued.map((e) => e.agentId)).toEqual(["__sparkle_self__"]);
    expect(report.unresolved).toMatchObject([{ reason: "shadowed", resolvedId: "agent-imposter" }]);
    expect(h.posted[0]!.text).toContain("agent-imposter");
    // And the heading must NOT claim the mention reached nobody — it plainly did.
    expect(h.posted[0]!.text).not.toContain("reached nobody");
    expect(h.posted[0]!.text).toContain("DELIVERED, with a caveat");
  });

  it("does NOT claim partial delivery when a shadowed handle's enqueue fails", async () => {
    // The shadow note used to be recorded BEFORE the enqueue, so a refused inbox produced both a
    // line saying the notice "went there" and one saying it could not be queued — and the heading,
    // inferred from the shadow's presence, called that PARTIALLY DELIVERED. Nothing was delivered.
    const h = harness({
      enqueueFails: true,
      candidates: [{ id: "agent-imposter", name: "Sparkle" }],
      comments: { "sparkle-1": [{ id: "c1", author: "x", text: "@Sparkle stand down" }] },
    });
    const withSpecial: RouterDeps = {
      ...h.deps,
      specialHandleNames: ["Sparkle"],
      resolveSpecialHandle: (t) =>
        t.trim().toLowerCase() === "sparkle" ? { id: "sparkle:concierge", name: "Sparkle" } : null,
    };

    const { report } = await runMentionTick(
      seeded("sparkle-1", 0),
      beads("sparkle-1", 1),
      withSpecial,
    );

    expect(report.doorbelled).toHaveLength(0);
    expect(h.posted[0]!.text).toContain("NOT DELIVERED");
    expect(h.posted[0]!.text).not.toContain("PARTIALLY DELIVERED");
    // And no self-contradicting "it went there" line beside the failure.
    expect(report.unresolved.map((u) => u.reason)).toEqual(["enqueue-failed"]);
  });

  it("says PARTIALLY DELIVERED for the ordinary mix of good and bad handles", async () => {
    // The common shape, and the one the shadow-count heading got wrong in the other direction: no
    // reserved handle involved at all, several agents doorbelled, one typo — previously headed
    // "reached nobody" while the doorbells went out.
    const h = harness({
      comments: {
        "sparkle-1": [
          { id: "c1", author: "x", text: "@Backstop Agent @Improve Sparkle and @Bakstop typo" },
        ],
      },
    });
    const { report } = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);

    expect(report.doorbelled).toHaveLength(2);
    expect(h.posted[0]!.text).toContain("PARTIALLY DELIVERED");
    expect(h.posted[0]!.text).not.toContain("reached nobody");
  });

  it("keeps the shadow note and the delivery count across a deferral RETRY", async () => {
    // Both signals describe the whole comment, but the retry pass re-walks it and takes the
    // `already` skip for every token doorbelled the first time round. With that skip ahead of them,
    // the retry — which is the ONLY pass that posts, since the exhausted pass returns early — would
    // count zero deliveries and head a partially delivered comment "reached nobody", and the shadow
    // note would never be written at all.
    const filler = Array.from({ length: MAX_DOORBELLS_PER_TICK }, (_, i) => ({
      id: `agent-${i}`,
      name: `Agent${i}`,
    }));
    const h = harness({
      candidates: [...filler, { id: "agent-imposter", name: "Sparkle" }],
      comments: {
        "sparkle-1": [
          {
            id: "c1",
            author: "x",
            text: `@Sparkle ${filler.map((m) => `@${m.name}`).join(" ")} @ghost`,
          },
        ],
      },
    });
    const withSpecial: RouterDeps = {
      ...h.deps,
      specialHandleNames: ["Sparkle"],
      resolveSpecialHandle: (t) =>
        t.trim().toLowerCase() === "sparkle" ? { id: "sparkle:concierge", name: "Sparkle" } : null,
    };

    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), withSpecial);
    expect(first.report.deferred).toBe(1);
    expect(h.posted).toHaveLength(0);

    await runMentionTick(first.state, beads("sparkle-1", 1), withSpecial);

    expect(h.posted).toHaveLength(1);
    // The shadow note survived the retry...
    expect(h.posted[0]!.text).toContain("agent-imposter");
    // ...and the heading reflects that agents WERE woken on the earlier pass.
    expect(h.posted[0]!.text).not.toContain("reached nobody");
    expect(h.posted[0]!.text).toContain("PARTIALLY DELIVERED");
  });

  it("counts EARLIER passes' deliveries, so a retry that queues nothing still reads as partial", async () => {
    // PINS `delivered += 1` IN THE `already` BRANCH, which the sibling test above cannot: there the
    // retry queues a doorbell of its own, so `delivered` is non-zero either way and the heading is
    // PARTIALLY DELIVERED with the line deleted. Here the retry's one remaining token is REFUSED by
    // the inbox, so every delivery in that pass comes from `already` — with the fix the heading is
    // PARTIALLY DELIVERED, without it the comment is falsely headed "reached nobody" despite twenty
    // agents having been woken on the first pass.
    const many = Array.from({ length: MAX_DOORBELLS_PER_TICK + 1 }, (_, i) => ({
      id: `agent-${i}`,
      name: `Agent${i}`,
    }));
    const h = harness({
      candidates: many,
      enqueueFailAfter: MAX_DOORBELLS_PER_TICK,
      comments: {
        "sparkle-1": [
          { id: "c1", author: "x", text: `${many.map((m) => `@${m.name}`).join(" ")} @ghost` },
        ],
      },
    });

    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), h.deps);
    expect(first.report.deferred).toBe(1);
    expect(h.enqueued).toHaveLength(MAX_DOORBELLS_PER_TICK);

    const second = await runMentionTick(first.state, beads("sparkle-1", 1), h.deps);

    // The retry queued NOTHING new — the last agent's inbox refused it.
    expect(second.report.doorbelled).toHaveLength(0);
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]!.text).toContain("PARTIALLY DELIVERED");
    expect(h.posted[0]!.text).not.toContain("reached nobody");
  });

  it("says nothing extra when no roster agent shares the reserved name", async () => {
    const h = harness({
      candidates: [ALICE],
      comments: { "sparkle-1": [{ id: "c1", author: "x", text: "@improve look" }] },
    });
    const withSpecial: RouterDeps = {
      ...h.deps,
      specialHandleNames: ["improve"],
      resolveSpecialHandle: (t) =>
        t.trim().toLowerCase() === "improve"
          ? { id: "__sparkle_self__", name: "Improve Sparkle" }
          : null,
    };
    const { report } = await runMentionTick(
      seeded("sparkle-1", 0),
      beads("sparkle-1", 1),
      withSpecial,
    );
    expect(report.unresolved).toHaveLength(0);
    expect(h.posted).toHaveLength(0);
  });
});

describe("a reserved handle is WOKEN, not merely doorbelled", () => {
  const wakeHarness = () => {
    const h = harness({
      candidates: [ALICE],
      comments: { "sparkle-1": [{ id: "c1", author: "Someone", text: "@improve stand down" }] },
    });
    const calls: Array<{ agentId: string; beadId: string; from: string }> = [];
    const status = { acked: false, overdue: false };
    const deps: RouterDeps = {
      ...h.deps,
      specialHandleNames: ["improve"],
      resolveSpecialHandle: (t) =>
        t.trim().toLowerCase() === "improve"
          ? { id: "__sparkle_self__", name: "Improve Sparkle" }
          : null,
      sendViaMentionChannel: async (agentId, beadId, from) => {
        calls.push({ agentId, beadId, from });
        return {
          round: 1,
          doorbelled: true,
          spawned: true,
          wakeSparkle: false,
          capped: false,
          messageId: "m-1",
        };
      },
      // WIRE-ACCURATE, and that matters: `status_of` reports `awaitingAckRound: 0` the moment an
      // ACK lands, so a fixture that pairs `acked: true` with a non-zero round describes a payload
      // Rust cannot produce — and the resolve path was written against exactly that fiction.
      readMentionStatus: async () => ({
        round: 1,
        awaitingAckRound: status.acked ? 0 : 1,
        ...status,
      }),
    };
    return { h, deps, calls, status };
  };

  it("routes it through the mention channel instead of a bare enqueue", async () => {
    // THE WAKE. A bare enqueue leaves a target with no live session waiting on its own cadence;
    // the channel spawns a responder (@improve) or schedules a concierge turn (@sparkle).
    const { h, deps, calls } = wakeHarness();

    const { report } = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), deps);

    // THE ARGUMENT THE ADAPTER ACTUALLY NEEDS: the resolved AGENT ID, not the token typed. Both
    // are `string`, so swapping them typechecks fine — and it made every reserved mention inert
    // while the router suite (which stubs the sender) and the adapter suite (which called it by
    // hand with an id) both stayed green. This is the assertion that ties the two halves together.
    expect(calls).toEqual([
      { agentId: "__sparkle_self__", beadId: "sparkle-1", from: "Someone" },
    ]);
    // …and NOT through the inbox path, or the message would go twice.
    expect(h.enqueued).toHaveLength(0);
    expect(report.doorbelled).toHaveLength(1);
  });

  it("judges it by the BEAD's ack, never by the inbox — the bystander trap", async () => {
    // On 2026-08-14 a second `claude` in the same worktree drained and ACKED four messages, and
    // `inbox_status` reported them acknowledged for messages the real agent never saw. An inbox ack
    // is satisfiable by any process sharing the worktree; a bead ACK comment attributed to the
    // agent is not. So this entry must never consult `readDoorbellStates`.
    const { h, deps, status } = wakeHarness();
    const peek = vi.fn(async () => new Map<string, DoorbellState>());
    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), {
      ...deps,
      readDoorbellStates: peek,
    });

    status.acked = true;
    const second = await runMentionTick(first.state, beads("sparkle-1", 1), {
      ...deps,
      readDoorbellStates: peek,
    });

    expect(peek).not.toHaveBeenCalled();
    expect(second.state.ledger[0]!.resolved).toBe(true);
    expect(h.posted).toHaveLength(0);
  });

  it("reports UNACKED when the channel says overdue — a wake is not a read", async () => {
    const { h, deps, status } = wakeHarness();
    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), deps);

    status.overdue = true;
    // Its OWN deadline must elapse first — a notice posted at age ~0ms would be a false failure
    // report for a recipient that had not had a moment to answer.
    h.clock.now += UNDELIVERED_DEADLINE_MS + 1;
    const second = await runMentionTick(first.state, beads("sparkle-1", 1), deps);

    expect(second.report.undelivered).toHaveLength(1);
    expect(h.posted[0]!.text).toContain("unacked");
    // The wake demonstrably fired, so claiming non-delivery would be its own false statement.
    expect(h.posted[0]!.text).toContain("NOT confirmed");
  });

  it("one round's ACK does NOT resolve an earlier outstanding entry on the same bead", async () => {
    // `mention_status` is per-thread and ROUND-SCOPED — it describes the latest awaited round only.
    // A bead can hold several outstanding channel entries (`@improve @sparkle` in one comment is two
    // sends), and letting them all read that one verdict would let a later round's ACK silently
    // resolve a mention nobody acknowledged: the fail-open this module forbids.
    const h = harness({
      comments: {
        "sparkle-1": [{ id: "c1", author: "x", text: "@improve and @sparkle both" }],
      },
    });
    const status = { acked: false, overdue: false };
    let seq = 0;
    const deps: RouterDeps = {
      ...h.deps,
      specialHandleNames: ["improve", "sparkle"],
      resolveSpecialHandle: (t) => {
        const k = t.trim().toLowerCase();
        if (k === "improve") return { id: "__sparkle_self__", name: "Improve Sparkle" };
        if (k === "sparkle") return { id: "sparkle:concierge", name: "Sparkle" };
        return null;
      },
      sendViaMentionChannel: async () => {
        seq += 1;
        return {
          round: seq,
          doorbelled: true,
          spawned: true,
          wakeSparkle: false,
          capped: false,
          messageId: `m-${seq}`,
        };
      },
      // The thread is on round 2 — the latest. When acked, Rust zeroes `awaitingAckRound`.
      readMentionStatus: async () => ({
        round: 2,
        awaitingAckRound: status.acked ? 0 : 2,
        ...status,
      }),
    };

    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), deps);
    expect(first.state.ledger).toHaveLength(2);

    status.acked = true; // round 2 was acked
    const second = await runMentionTick(first.state, beads("sparkle-1", 1), deps);
    const third = await runMentionTick(second.state, beads("sparkle-1", 1), deps);

    // ONLY the entry that verdict describes. Picking the "newest outstanding" instead merely
    // DEFERRED the fail-open: once m-2 resolved, the next tick recomputed "newest" over what
    // remained, read the same latest-round verdict, and resolved m-1 too — so this test is run for
    // a THIRD tick, which is exactly where the heuristic went wrong.
    const resolved = third.state.ledger.filter((e) => e.resolved);
    expect(resolved.map((e) => e.messageId)).toEqual(["m-2"]);
  });

  it("reports a SUPERSEDED entry on its own terms rather than masking it behind a later one", async () => {
    const h = harness({
      comments: {
        "sparkle-1": [{ id: "c1", author: "x", text: "@improve and @sparkle both" }],
      },
    });
    let seq = 0;
    const deps: RouterDeps = {
      ...h.deps,
      specialHandleNames: ["improve", "sparkle"],
      resolveSpecialHandle: (t) => {
        const k = t.trim().toLowerCase();
        if (k === "improve") return { id: "__sparkle_self__", name: "Improve Sparkle" };
        if (k === "sparkle") return { id: "sparkle:concierge", name: "Sparkle" };
        return null;
      },
      sendViaMentionChannel: async () => {
        seq += 1;
        return {
          round: seq,
          doorbelled: true,
          spawned: true,
          wakeSparkle: false,
          capped: false,
          messageId: `m-${seq}`,
        };
      },
      readMentionStatus: async () => ({
        round: 2,
        awaitingAckRound: 2,
        acked: false,
        overdue: true,
      }),
    };

    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), deps);
    // NOTHING on the tick the sends happened: two reserved handles in one comment are two sends in
    // the SAME tick, so the first is superseded instantly — reporting on supersession alone posted
    // a false "unacked" notice at age ~0ms on the busiest path this feature has.
    expect(first.report.undelivered).toHaveLength(0);

    h.clock.now += UNDELIVERED_DEADLINE_MS + 1;
    const second = await runMentionTick(first.state, beads("sparkle-1", 1), deps);
    const third = await runMentionTick(second.state, beads("sparkle-1", 1), deps);

    // BOTH are reported, each naming its OWN agent. `mention_status` only ever tracks the latest
    // round, so round 1's ACK will never be observed — staying silent about it would mask an
    // unacked mention indefinitely behind an unrelated later one on the same bead. The earlier cut
    // reported the newest entry's name and age while latching BOTH as reported, so the author was
    // told about one agent and never learned the other's mention had reached nobody either.
    expect(second.report.undelivered).toHaveLength(2);
    // …and latched, so a later tick does not repeat either of them.
    expect(third.report.undelivered).toHaveLength(0);
    const texts = h.posted.map((p) => p.text).join("\n");
    expect(texts).toContain("Improve Sparkle");
    expect(texts).toContain("Sparkle");

    // AND THE SUPERSEDED ONE MUST NOT CLAIM IT WENT UNREAD. A thread tracks one round's ACK — the
    // latest — so round 1's ack stops being reported the moment round 2 lands, even though the
    // recipient may well have posted it (`thread_has_ack` is per-round; only `status_of` is not).
    // Asserting non-delivery there is a false statement about an agent that answered.
    const superseded = h.posted.find((p) => p.text.includes("Improve Sparkle"))!.text;
    expect(superseded).toContain("UNCONFIRMED");
    expect(superseded).toContain("UNKNOWN");
    // …and names the cause that IS established here: a readable state showing a later round.
    expect(superseded).toContain("moved on to a later exchange");
    expect(superseded).not.toContain("Treat this as unread");
    expect(superseded).not.toContain("reach that agent another way");
  });

  it("reports UNKNOWN rather than silence when the thread state has been lost", async () => {
    // `mention.rs::read_state` is `unwrap_or_default()`, so a missing or unparseable state file
    // yields `{round: 0, acked: false, overdue: false}`. The ledger lives in localStorage and the
    // thread state on disk under app data — two stores with independent lifetimes — so divergence
    // is ordinary. Matching on `st.round` alone left every entry unjudged forever: never resolved,
    // never reported, re-reading the thread (and shelling `bd`) every tick until it aged out.
    const h = harness({
      comments: { "sparkle-1": [{ id: "c1", author: "x", text: "@improve look" }] },
    });
    const deps: RouterDeps = {
      ...h.deps,
      specialHandleNames: ["improve"],
      resolveSpecialHandle: (t) =>
        t.trim().toLowerCase() === "improve"
          ? { id: "__sparkle_self__", name: "Improve Sparkle" }
          : null,
      sendViaMentionChannel: async () => ({
        round: 1,
        doorbelled: true,
        spawned: true,
        wakeSparkle: false,
        capped: false,
        messageId: "m-1",
      }),
      readMentionStatus: async () => ({
        round: 0, // the defaulted state
        awaitingAckRound: 0,
        acked: false,
        overdue: false,
      }),
    };

    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), deps);
    expect(first.report.undelivered).toHaveLength(0); // not before its deadline

    // A TRANSIENT defaulted read must NOT be terminal. `write_state` is a non-atomic `fs::write`,
    // so any status read racing a send on the same bead sees a truncated file and defaults —
    // posting then would permanently latch a healthy, still-awaiting thread out of the sweep, so
    // the ACK that does arrive could never resolve it. A defaulted read carries strictly no more
    // information than a read that THREW, and that one is deliberately retried.
    h.clock.now += UNDELIVERED_DEADLINE_MS + 1;
    const second = await runMentionTick(first.state, beads("sparkle-1", 1), deps);
    expect(second.report.undelivered).toHaveLength(0);
    expect(h.posted).toHaveLength(0);

    // …and the ACK that arrives while the state is readable again still resolves it.
    const recovered = await runMentionTick(second.state, beads("sparkle-1", 1), {
      ...deps,
      readMentionStatus: async () => ({
        round: 1,
        awaitingAckRound: 0,
        acked: true,
        overdue: false,
      }),
    });
    expect(recovered.state.ledger[0]!.resolved).toBe(true);
    expect(h.posted).toHaveLength(0);
  });

  it("says so once the thread state stays unreadable well past the deadline", async () => {
    // The other half: silence about a permanently lost state is the hole this branch closes.
    const h = harness({
      comments: { "sparkle-1": [{ id: "c1", author: "x", text: "@improve look" }] },
    });
    const deps: RouterDeps = {
      ...h.deps,
      specialHandleNames: ["improve"],
      resolveSpecialHandle: (t) =>
        t.trim().toLowerCase() === "improve"
          ? { id: "__sparkle_self__", name: "Improve Sparkle" }
          : null,
      sendViaMentionChannel: async () => ({
        round: 1,
        doorbelled: true,
        spawned: true,
        wakeSparkle: false,
        capped: false,
        messageId: "m-1",
      }),
      readMentionStatus: async () => ({
        round: 0,
        awaitingAckRound: 0,
        acked: false,
        overdue: false,
      }),
    };

    // Tick 1 sends. Tick 2 is the FIRST defaulted read and starts the grace clock; only after the
    // grace elapses from THAT moment is it reported.
    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), deps);
    h.clock.now += UNDELIVERED_DEADLINE_MS + 1;
    const second = await runMentionTick(first.state, beads("sparkle-1", 1), deps);
    expect(second.report.undelivered).toHaveLength(0);

    h.clock.now += UNDELIVERED_DEADLINE_MS * 10;
    const third = await runMentionTick(second.state, beads("sparkle-1", 1), deps);

    expect(third.report.undelivered).toHaveLength(1);
    const text = h.posted[0]!.text;
    expect(text).toContain("UNCONFIRMED");
    // AND IT MUST NOT CLAIM A LATER EXCHANGE HAPPENED. On a bead carrying exactly one mention,
    // asserting supersession sends the author looking for a second mention that does not exist.
    expect(text).toContain("could no longer be read");
    expect(text).not.toContain("moved on to a later exchange");
  });

  it("a round-less entry is never resolved by ANOTHER round's ack", async () => {
    // `RouterState` is persisted, so channel entries written before `round` existed are exactly the
    // population this build reads back. Treating them as "the latest" let some unrelated round's
    // ACK resolve them — the fail-open the module forbids.
    const h = harness({ comments: { "sparkle-1": [] } });
    const legacy: RouterState = {
      ...seeded("sparkle-1", 1),
      ledger: [
        {
          messageId: "old-1",
          commentId: "c0",
          beadId: "sparkle-1",
          agentId: "__sparkle_self__",
          agentName: "Improve Sparkle",
          queuedAt: 0,
          viaMentionChannel: true,
        },
      ],
    };
    const deps: RouterDeps = {
      ...h.deps,
      readMentionStatus: async () => ({
        round: 7,
        awaitingAckRound: 0,
        acked: true, // someone else's round was acked
        overdue: false,
      }),
    };

    const { state } = await runMentionTick(legacy, beads("sparkle-1", 1), deps);

    expect(state.ledger[0]?.resolved).toBeUndefined();
    const text = h.posted[0]!.text;
    expect(text).toContain("UNCONFIRMED");
    // AND THE CAUSE MUST BE THE TRUE ONE. This state read perfectly well (round 7), so telling the
    // author it "could no longer be read" sends them to inspect healthy app data, and denying a
    // later exchange contradicts the seven rounds this fixture seeds.
    expect(text).toContain("no longer line up");
    expect(text).not.toContain("could no longer be read");
    expect(text).not.toContain("Nothing here says a later exchange occurred");
  });

  it("a TRANSIENT defaulted read is retried even on an OLD entry", async () => {
    // The grace has to measure "still unreadable", not "this entry is old". Measured from
    // `queuedAt`, an entry already past it got ZERO retry — and that is reachable: a mention
    // queued, the app quit a minute later, reopened half an hour on. Its first status read after
    // relaunch, racing a concurrent send and seeing the truncated file `write_state` leaves behind,
    // would latch a healthy, still-awaiting thread out of the sweep for good.
    const h = harness({ comments: { "sparkle-1": [] } });
    const old: RouterState = {
      ...seeded("sparkle-1", 1),
      ledger: [
        {
          messageId: "m-1",
          commentId: "c0",
          beadId: "sparkle-1",
          agentId: "__sparkle_self__",
          agentName: "Improve Sparkle",
          // Queued long ago — far past any queue-time grace.
          queuedAt: h.clock.now - UNDELIVERED_DEADLINE_MS * 100,
          viaMentionChannel: true,
          round: 1,
        },
      ],
    };
    const defaulted: RouterDeps = {
      ...h.deps,
      readMentionStatus: async () => ({
        round: 0,
        awaitingAckRound: 0,
        acked: false,
        overdue: false,
      }),
    };

    const first = await runMentionTick(old, beads("sparkle-1", 1), defaulted);
    expect(first.report.undelivered).toHaveLength(0);
    expect(h.posted).toHaveLength(0);
    expect(first.state.ledger[0]!.firstDefaultedAt).toBe(h.clock.now);

    // The ACK arriving seconds later still resolves it — it was never latched out of the sweep.
    const recovered = await runMentionTick(first.state, beads("sparkle-1", 1), {
      ...h.deps,
      readMentionStatus: async () => ({
        round: 1,
        awaitingAckRound: 0,
        acked: true,
        overdue: false,
      }),
    });
    expect(recovered.state.ledger[0]!.resolved).toBe(true);
    expect(h.posted).toHaveLength(0);
  });

  it("resolves an ACKED mention even though Rust zeroes awaitingAckRound", async () => {
    // THE SHAPE THE WIRE ACTUALLY SENDS. `status_of` sets `awaiting_ack_round: if acked { 0 }`, and
    // no real entry has round 0 — so matching a verdict on `awaitingAckRound` made the resolve path
    // UNREACHABLE in production: an acked mention never resolved, re-read the thread every tick for
    // the full ledger window, and was then falsely reported UNDELIVERED the moment any later
    // mention advanced the round. The earlier fixture paired `acked: true` with a non-zero round —
    // a payload Rust cannot produce — so the suite could not see it.
    const h = harness({
      comments: { "sparkle-1": [{ id: "c1", author: "x", text: "@improve look" }] },
    });
    const deps: RouterDeps = {
      ...h.deps,
      specialHandleNames: ["improve"],
      resolveSpecialHandle: (t) =>
        t.trim().toLowerCase() === "improve"
          ? { id: "__sparkle_self__", name: "Improve Sparkle" }
          : null,
      sendViaMentionChannel: async () => ({
        round: 1,
        doorbelled: true,
        spawned: true,
        wakeSparkle: false,
        capped: false,
        messageId: "m-1",
      }),
      readMentionStatus: async () => ({
        round: 1,
        awaitingAckRound: 0, // zeroed BECAUSE it is acked — this is the real payload
        acked: true,
        overdue: false,
      }),
    };

    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), deps);
    expect(first.state.ledger[0]!.resolved).toBe(true);

    // And it stays resolved — never falsely reported once a later mention advances the round.
    h.clock.now += UNDELIVERED_DEADLINE_MS * 5;
    const second = await runMentionTick(first.state, beads("sparkle-1", 1), {
      ...deps,
      readMentionStatus: async () => ({
        round: 9,
        awaitingAckRound: 9,
        acked: false,
        overdue: true,
      }),
    });
    expect(second.report.undelivered).toHaveLength(0);
    expect(h.posted).toHaveLength(0);
  });

  it("an UNREADABLE thread never resolves to acked", async () => {
    const { h, deps } = wakeHarness();
    const first = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), deps);
    const boom: RouterDeps = {
      ...deps,
      readMentionStatus: async () => {
        throw new Error("bd unreadable");
      },
    };
    const second = await runMentionTick(first.state, beads("sparkle-1", 1), boom);
    expect(second.state.ledger[0]!.resolved).toBeUndefined();
    expect(h.posted).toHaveLength(0);
  });

  it("says so on the bead when the channel's anti-loop cap halts the exchange", async () => {
    // Capped means NOTHING was posted, doorbelled or woken. A silently halted exchange is
    // indistinguishable from a delivered one, which is the failure this whole feature removes.
    const { h, deps } = wakeHarness();
    const capped: RouterDeps = {
      ...deps,
      sendViaMentionChannel: async () => ({
        round: 0,
        doorbelled: false,
        spawned: false,
        wakeSparkle: false,
        capped: true,
        messageId: null,
      }),
    };

    const { report } = await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), capped);

    expect(report.doorbelled).toHaveLength(0);
    expect(h.posted[0]!.text).toContain("anti-loop round cap");
    expect(report.unresolved[0]).toMatchObject({ reason: "capped" });
  });

  it("still uses the plain inbox for an ordinary build agent", async () => {
    const h = harness({
      comments: { "sparkle-1": [{ id: "c1", author: "x", text: "@Backstop Agent hi" }] },
    });
    const calls: string[] = [];
    const deps: RouterDeps = {
      ...h.deps,
      sendViaMentionChannel: async (handle) => {
        calls.push(handle);
        return { round: 1, doorbelled: true, spawned: false, wakeSparkle: false, capped: false, messageId: "x" };
      },
    };
    await runMentionTick(seeded("sparkle-1", 0), beads("sparkle-1", 1), deps);
    expect(calls).toEqual([]);
    expect(h.enqueued.map((e) => e.agentId)).toEqual([ALICE.id]);
  });
});

describe("selectBeadsToRead — a first sighting never wakes anyone", () => {
  it("SEEDS a bead it has never seen and reads nothing", () => {
    const r = selectBeadsToRead(emptyRouterState(), [{ id: "sparkle-1", commentCount: 12 }]);
    expect(r.seeded).toEqual(["sparkle-1"]);
    expect(r.toRead).toEqual([]);
    expect(r.baselines["sparkle-1"]).toBe(12);
  });

  it("reads only beads whose count actually ROSE", () => {
    const state = { ...emptyRouterState(), baselines: { a: 3, b: 5 } };
    const r = selectBeadsToRead(state, [
      { id: "a", commentCount: 4 },
      { id: "b", commentCount: 5 },
    ]);
    expect(r.toRead).toEqual(["a"]);
  });

  it("re-baselines downward when a comment is deleted, so the NEXT real one is not suppressed", () => {
    const state = { ...emptyRouterState(), baselines: { a: 5 } };
    const r = selectBeadsToRead(state, [{ id: "a", commentCount: 3 }]);
    expect(r.toRead).toEqual([]);
    expect(r.baselines.a).toBe(3);
  });

  it("a whole backlog of existing comments produces no doorbells on the first ever tick", async () => {
    const h = harness({
      comments: {
        "sparkle-1": [
          { id: "c1", author: "x", text: "@Backstop Agent old message one" },
          { id: "c2", author: "x", text: "@Improve Sparkle old message two" },
        ],
      },
    });
    // No baseline at all — the state a fresh app start has.
    await runMentionTick(emptyRouterState(), beads("sparkle-1", 2), h.deps);
    expect(h.enqueued).toHaveLength(0);
  });
});

describe("runMentionTick — failures do not stop the tick", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness({
      comments: { "sparkle-2": [{ id: "c9", author: "x", text: "@Backstop Agent hello" }] },
    });
  });

  it("a bead whose comments cannot be read is retried rather than skipped forever", async () => {
    const failing: RouterDeps = {
      ...h.deps,
      fetchComments: async (id) => {
        if (id === "sparkle-1") throw new Error("bd timeout");
        return h.comments.get(id) ?? [];
      },
    };
    const state: RouterState = {
      ...emptyRouterState(),
      baselines: { "sparkle-1": 0, "sparkle-2": 0 },
    };
    const { state: next, report } = await runMentionTick(
      state,
      [
        { id: "sparkle-1", commentCount: 1 },
        { id: "sparkle-2", commentCount: 1 },
      ],
      failing,
    );

    // The healthy bead still routed.
    expect(report.doorbelled).toHaveLength(1);
    // The broken one kept its old baseline, so the next tick tries again.
    expect(next.baselines["sparkle-1"]).toBe(0);
  });

  it("a comment with no stable id is never routed (it could not be de-duplicated)", async () => {
    h.comments.set("sparkle-2", [{ id: "", author: "x", text: "@Backstop Agent hello" }]);
    await runMentionTick(seeded("sparkle-2", 0), beads("sparkle-2", 1), h.deps);
    expect(h.enqueued).toHaveLength(0);
  });
});
