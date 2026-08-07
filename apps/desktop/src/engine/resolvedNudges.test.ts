// The resolved-nudge ledger — the memory that lets a finished BLOCKED card stay in the thread.
//
// EVERY CASE HERE COMES IN A PAIR, and the second of each pair is the one that matters. This feature
// makes cards go quiet, and Sparkle's standing rule is that nothing which needs the founder may be
// hidden — so the risk it introduces is not a lingering red, it is a LIVE blocker rendered as
// finished. A suite that only asserted "it resolves" would go green on a ledger that resolved
// everything.
import { describe, expect, it } from "vitest";
import {
  MAX_RESOLVED_CARDS,
  emptyResolvedLedger,
  forgetEpisode,
  forgetResolved,
  noteCardsShown,
  noteResolutions,
  resolvedNudges,
  type NudgeSubject,
} from "./resolvedNudges";
import { createArrivalOrder, forgetArrival, orderByArrival } from "./conciergeStreamOrder";

const agent = (id: string, over: Partial<NudgeSubject> = {}): NudgeSubject => ({
  id,
  name: `Agent ${id}`,
  projectName: "drodio-website",
  band: "needs_you",
  ...over,
});

/** The fleet as the caller supplies it: a lookup plus the id set. */
const fleet = (...subjects: NudgeSubject[]) => ({
  ids: new Set(subjects.map((s) => s.id)),
  lookup: (id: string) => subjects.find((s) => s.id === id),
});

describe("resolvedNudges — a card that resolves becomes history", () => {
  it("records the block's duration from when the card went up, not from when it cleared", () => {
    const led = emptyResolvedLedger();
    const f = fleet(agent("a"));
    noteCardsShown(led, [agent("a")], 1_000);
    // Ticks while it is still red must not restamp the raise, or every duration reads ~0.
    noteCardsShown(led, [agent("a")], 20_000);
    noteResolutions(led, new Set(), f.ids, f.lookup, 41_000);

    // `[0]!`, not destructuring: `noUncheckedIndexedAccess` types the element as possibly-undefined,
    // and the length is asserted by the property reads that follow.
    const card = resolvedNudges(led)[0]!;
    expect(card.raisedAt).toBe(1_000);
    expect(card.resolvedAt).toBe(41_000);
    expect(card.resolvedAt - card.raisedAt).toBe(40_000);
  });

  it("keeps naming its agent and project, so the card is still readable as history", () => {
    const led = emptyResolvedLedger();
    const f = fleet(agent("a", { name: "Social Publisher Hardening" }));
    noteCardsShown(led, [agent("a", { name: "Social Publisher Hardening" })], 0);
    noteResolutions(led, new Set(), f.ids, f.lookup, 5_000);
    expect(resolvedNudges(led)[0]).toMatchObject({
      id: "a",
      agentName: "Social Publisher Hardening",
      projectName: "drodio-website",
    });
  });

  it("NEVER resolves an agent that is still red — the digest case", () => {
    // THE TRAP THIS LEDGER EXISTS TO AVOID. Two agents sharing a band collapse into a single digest
    // LINE, so their individual cards are withdrawn while both are still blocked. A ledger that
    // inferred resolution from "no longer has a card" would grey a live blocker here.
    const led = emptyResolvedLedger();
    const f = fleet(agent("a"), agent("b"));
    noteCardsShown(led, [agent("a")], 0);
    // `a` has no card this tick (it digested), but it IS still in the red set.
    noteResolutions(led, new Set(["a", "b"]), f.ids, f.lookup, 60_000);
    expect(resolvedNudges(led)).toHaveLength(0);
    expect(led.openedAt.get("a")).toBe(0); // episode still open, raise time intact

    // …and when it genuinely clears, the duration still spans the WHOLE block, digest included.
    noteResolutions(led, new Set(["b"]), f.ids, f.lookup, 90_000);
    expect(resolvedNudges(led)[0]).toMatchObject({ raisedAt: 0, resolvedAt: 90_000 });
  });

  it("drops the record when the agent leaves the fleet, rather than leaving a dead-end pill", () => {
    const led = emptyResolvedLedger();
    const f = fleet(agent("a"));
    noteCardsShown(led, [agent("a")], 0);
    noteResolutions(led, new Set(), f.ids, f.lookup, 1_000);
    expect(resolvedNudges(led)).toHaveLength(1);

    // The agent is closed/removed. Its card would render an AgentPill resolving to nothing.
    noteResolutions(led, new Set(), new Set(), () => undefined, 2_000);
    expect(resolvedNudges(led)).toHaveLength(0);
  });

  it("clamps a backwards clock to a zero-length block rather than a negative one", () => {
    const led = emptyResolvedLedger();
    const f = fleet(agent("a"));
    noteCardsShown(led, [agent("a")], 10_000);
    noteResolutions(led, new Set(), f.ids, f.lookup, 4_000); // NTP step between observations
    expect(resolvedNudges(led)[0]!.resolvedAt).toBe(10_000);
  });
});

describe("resolvedNudges — a re-raised block is loud again, not quietly grey", () => {
  it("drops the resolved record when the same agent goes red again", () => {
    // The regression this guards: a grey "RESOLVED" twin left sitting in the thread while the same
    // agent is blocked RIGHT NOW states the opposite fact about one agent in two places.
    const led = emptyResolvedLedger();
    const f = fleet(agent("a"));
    noteCardsShown(led, [agent("a")], 0);
    noteResolutions(led, new Set(), f.ids, f.lookup, 1_000);
    expect(resolvedNudges(led)).toHaveLength(1);

    noteCardsShown(led, [agent("a")], 60_000);
    expect(resolvedNudges(led)).toHaveLength(0);
    // …and the NEW episode is timed from the new raise, not the old one.
    noteResolutions(led, new Set(), f.ids, f.lookup, 61_000);
    expect(resolvedNudges(led)[0]).toMatchObject({ raisedAt: 60_000, resolvedAt: 61_000 });
  });

  it("[x] on a resolved card removes it, and does not resurrect on the next tick", () => {
    const led = emptyResolvedLedger();
    const f = fleet(agent("a"));
    noteCardsShown(led, [agent("a")], 0);
    noteResolutions(led, new Set(), f.ids, f.lookup, 1_000);

    forgetResolved(led, "a");
    expect(resolvedNudges(led)).toHaveLength(0);
    // The episode is already closed, so a later quiet tick has nothing to re-close: the card must
    // not come back. (A ledger that kept `openedAt` around would re-add it here.)
    noteResolutions(led, new Set(), f.ids, f.lookup, 2_000);
    expect(resolvedNudges(led)).toHaveLength(0);
  });
});

describe("forgetEpisode — a card withdrawn for a reason that is not 'the block is over'", () => {
  it("leaves NO receipt when the OPEN episode is forgotten, which forgetResolved cannot do", () => {
    // THE ACKNOWLEDGED-BUT-STILL-BLOCKED SHAPE, and the reason the stronger form exists.
    // `engine/alertDismissal` de-escalates the PUBLISHED status without resolving anything, so the
    // agent drops out of `stillRed` while it is still stopped dead waiting for the reader. Closing
    // the episode is what stops that from minting a grey "RESOLVED after 1s:" receipt for a live
    // blocker.
    const led = emptyResolvedLedger();
    const f = fleet(agent("a"));
    noteCardsShown(led, [agent("a")], 0);

    forgetEpisode(led, "a");
    noteResolutions(led, new Set(), f.ids, f.lookup, 1_000);
    expect(resolvedNudges(led)).toHaveLength(0);

    // THE OTHER DIRECTION, on the same tick sequence — without this the case would pass against a
    // ledger that had simply stopped resolving anything. `forgetResolved` is the weaker form the
    // resolved card's own [x] uses, and against an OPEN episode it is a no-op, so the receipt lands.
    const weak = emptyResolvedLedger();
    noteCardsShown(weak, [agent("a")], 0);
    forgetResolved(weak, "a");
    noteResolutions(weak, new Set(), f.ids, f.lookup, 1_000);
    expect(resolvedNudges(weak).map((r) => r.id)).toEqual(["a"]);
  });

  it("does not suppress the NEXT episode — a re-blocked agent is loud, then resolves normally", () => {
    // Forgetting is about THIS episode. An agent acknowledged at 9:00 and genuinely blocked again at
    // 9:40 must still get its card and, when that one clears, its receipt.
    const led = emptyResolvedLedger();
    const f = fleet(agent("a"));
    noteCardsShown(led, [agent("a")], 0);
    forgetEpisode(led, "a");

    noteCardsShown(led, [agent("a")], 60_000);
    noteResolutions(led, new Set(), f.ids, f.lookup, 61_000);
    expect(resolvedNudges(led)[0]).toMatchObject({ id: "a", raisedAt: 60_000, resolvedAt: 61_000 });
  });
});

describe("the thread keeps a screenful of history, not an unbounded stack", () => {
  it("caps the grey cards and discards the OLDEST, never the newest", () => {
    // The card wall the digest exists to prevent, re-entered through the one path that skips it: a
    // dozen agents each blocking once is a dozen permanent grey cards above the compose box.
    const led = emptyResolvedLedger();
    const many = Array.from({ length: MAX_RESOLVED_CARDS + 4 }, (_, i) => agent(`a${i}`));
    const f = fleet(...many);
    // Each blocks and clears in turn, so `a0` is the oldest episode and the last one is the newest.
    many.forEach((a, i) => {
      noteCardsShown(led, [a], i * 1_000);
      noteResolutions(led, new Set(many.slice(i + 1).map((m) => m.id)), f.ids, f.lookup, i * 1_000 + 500);
    });

    const kept = resolvedNudges(led).map((r) => r.id);
    expect(kept).toHaveLength(MAX_RESOLVED_CARDS);
    // The four oldest are gone and the newest is still here — an eviction that dropped the newest
    // would also satisfy the length check above.
    expect(kept).not.toContain("a0");
    expect(kept).toContain(`a${many.length - 1}`);
  });

  it("still discards the oldest when the whole fleet resolves on ONE tick", () => {
    // THE CASE THE TEST ABOVE CANNOT SEE, and the one that actually happens: `noteResolutions`
    // stamps every episode it closes on a tick with the SAME `now`, so a fleet coming unblocked
    // together carries one identical `resolvedAt`. A comparator that reads only that field returns 0
    // for every pair; `sort` is stable, so insertion order survives — oldest OPENED first — and
    // slicing the tail then deleted the NEWEST blocks and kept the oldest, the exact inversion of
    // what this cap promises. Distinct raise times, one shared resolve time, is the whole fixture.
    const led = emptyResolvedLedger();
    const many = Array.from({ length: MAX_RESOLVED_CARDS + 4 }, (_, i) => agent(`a${i}`));
    const f = fleet(...many);
    many.forEach((a, i) => noteCardsShown(led, [a], i * 1_000));
    noteResolutions(led, new Set(), f.ids, f.lookup, 100_000);

    const kept = resolvedNudges(led).map((r) => r.id);
    expect(kept).toHaveLength(MAX_RESOLVED_CARDS);
    // The four earliest-RAISED are the four discarded; the four most recent are all still here.
    expect(kept).not.toContain("a0");
    expect(kept).not.toContain("a3");
    expect(kept).toContain("a4");
    expect(kept).toContain(`a${many.length - 1}`);
  });
});

describe("forgetArrival — a re-raised card lands where the reader is looking", () => {
  it("moves a resolved-then-live card to the bottom, instead of leaving it above the fold", () => {
    // A resolved card never LEAVES the stream, so the grace window can never re-slot it. Without
    // `forgetArrival` the card goes red again at the slot it has held since the original block —
    // for a long conversation, far above the fold, where the thread's auto-follow means the reader
    // never sees it. That is the failure `conciergeStreamOrder`'s header calls the worse one.
    const order = createArrivalOrder();
    const card = { id: "a" };
    // Named rather than indexed out of an array: `noUncheckedIndexedAccess` types `chat[0]` as
    // possibly-undefined, and the assertion that would silence it is exactly the kind a test should
    // not carry.
    const m1 = { id: "m1" };
    const m2 = { id: "m2" };
    const m3 = { id: "m3" };

    // The block is raised early in the conversation, then resolves and stays put.
    expect(orderByArrival(order, [m1, card], 0).map((m) => m.id)).toEqual(["m1", "a"]);
    orderByArrival(order, [m1, card, m2, m3], 1_000);

    // WITHOUT the call: the re-raised card is still second, buried under the newer conversation.
    expect(orderByArrival(order, [m1, card, m2, m3], 2_000).map((m) => m.id)).toEqual([
      "m1",
      "a",
      "m2",
      "m3",
    ]);

    // WITH it: the same card is a new event and lands last, where the reader is looking.
    forgetArrival(order, "a");
    expect(orderByArrival(order, [m1, card, m2, m3], 3_000).map((m) => m.id)).toEqual([
      "m1",
      "m2",
      "m3",
      "a",
    ]);
  });

  it("is a no-op for an id the ledger has never seen", () => {
    const order = createArrivalOrder();
    forgetArrival(order, "never-here");
    expect(orderByArrival(order, [{ id: "x" }], 0).map((m) => m.id)).toEqual(["x"]);
  });
});
