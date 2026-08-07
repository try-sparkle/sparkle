// The digest rule from bead sparkle-4562.4: one item keeps its card, two or more become a line.
// The point of the feature is that the chat stays reachable, so the tests are written around
// VOLUME — the case that broke it was 27 cards, not 2.
//
// Grouping is keyed by BAND as well as project. Only `needs_you` is surfaced to the column today
// (ConciergeHost.surfacedAgents), so the multi-band rows below are forward-guards: they pin that
// widening what the column surfaces can't silently merge two urgencies into one count.
import { describe, expect, it } from "vitest";
import { buildDigest } from "./conciergeDigest";
import type { ConciergeAgent } from "../useConciergeFeed";

const agent = (over: Partial<ConciergeAgent> & { id: string }): ConciergeAgent =>
  ({
    name: over.id,
    projectId: "p1",
    projectName: "sparkle-desktop",
    kind: "build",
    status: "approval",
    statusColor: "#e0533f",
    statusLabel: "Approve?",
    band: "needs_you",
    inScope: true,
    muted: false,
    topLevel: true,
    // Nothing above it in the tree, so no ancestor row can be speaking for it.
    representedElsewhere: false,
    ...over,
  }) as ConciergeAgent;

describe("buildDigest", () => {
  it("keeps a lone item as a card — at that volume the card IS the digest", () => {
    const d = buildDigest([agent({ id: "a" })]);
    expect(d.cards.map((c) => c.id)).toEqual(["a"]);
    expect(d.groups).toEqual([]);
  });

  it("collapses two or more of the same band in the same project into one line", () => {
    const d = buildDigest([agent({ id: "a" }), agent({ id: "b" }), agent({ id: "c" })]);
    expect(d.cards).toEqual([]);
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0]!.text).toBe("3 Need you in sparkle-desktop");
    expect(d.groups[0]!.count).toBe(3);
  });

  // The label AGREES IN NUMBER — "1 Needs you" but "3 Need you" — because it comes from the shared
  // bandCountLabel rather than a local template. A private copy is what drifts.
  it("inflects the band label with the count", () => {
    const d = buildDigest([
      agent({ id: "a" }),
      agent({ id: "b" }),
      agent({ id: "c", band: "running" }),
      agent({ id: "d", band: "running" }),
    ]);
    expect(d.groups.map((g) => g.text)).toEqual([
      "2 Need you in sparkle-desktop",
      "2 Running in sparkle-desktop",
    ]);
  });

  // The case that motivated the whole change: a wall of cards burying the chat.
  it("turns a 27-item wall into a handful of lines", () => {
    const many = [
      ...Array.from({ length: 8 }, (_, i) => agent({ id: `needs-${i}` })),
      ...Array.from({ length: 19 }, (_, i) => agent({ id: `run-${i}`, band: "running" })),
    ];
    const d = buildDigest(many);
    expect(d.cards).toEqual([]);
    expect(d.groups).toHaveLength(2);
    expect(d.groups.map((g) => g.text)).toEqual([
      "8 Need you in sparkle-desktop",
      "19 Running in sparkle-desktop",
    ]);
  });

  it("keeps projects separate — the line names one project and the click opens it", () => {
    const d = buildDigest([
      agent({ id: "a" }),
      agent({ id: "b" }),
      agent({ id: "c", projectId: "p2", projectName: "drodio-website" }),
      agent({ id: "d", projectId: "p2", projectName: "drodio-website" }),
    ]);
    expect(d.groups.map((g) => g.text)).toEqual([
      "2 Need you in drodio-website",
      "2 Need you in sparkle-desktop",
    ]);
  });

  it("mixes: a singleton keeps its card while a crowd collapses", () => {
    const d = buildDigest([
      agent({ id: "solo", projectId: "p2", projectName: "drodio-website" }),
      agent({ id: "a" }),
      agent({ id: "b" }),
    ]);
    expect(d.cards.map((c) => c.id)).toEqual(["solo"]);
    expect(d.groups.map((g) => g.text)).toEqual(["2 Need you in sparkle-desktop"]);
  });

  // Urgency order comes from STATUS_BANDS, the same ordering the sidebar reads, so a digest line
  // and the column beside it can't disagree about what is most urgent.
  it("needs-you lines come before running lines, whatever the project names", () => {
    const d = buildDigest([
      agent({ id: "a", band: "running" }),
      agent({ id: "b", band: "running" }),
      agent({ id: "c", projectId: "p2", projectName: "zzz" }),
      agent({ id: "d", projectId: "p2", projectName: "zzz" }),
    ]);
    expect(d.groups.map((g) => g.band)).toEqual(["needs_you", "running"]);
  });

  // The click opens the project on the agent the feed ranked first, not an arbitrary member.
  it("leads with the first agent in feed order", () => {
    const d = buildDigest([agent({ id: "first" }), agent({ id: "second" })]);
    expect(d.groups[0]!.leadAgentId).toBe("first");
  });

  it("ids are stable across rebuilds so the row doesn't remount every feed tick", () => {
    const input = [agent({ id: "a" }), agent({ id: "b" })];
    expect(buildDigest(input).groups[0]!.id).toBe(buildDigest(input).groups[0]!.id);
  });

  it("handles an empty feed", () => {
    expect(buildDigest([])).toEqual({ cards: [], groups: [] });
  });

  // EVERY variant names its members, not just `unmerged`. A count you cannot open is the "+11 more"
  // the founder answered with two words; `memberIds` is what lets any line expand where it sits.
  it("names every member it stands for, so the count is openable and not just stated", () => {
    const d = buildDigest([agent({ id: "a" }), agent({ id: "b" }), agent({ id: "c" })]);
    expect(d.groups[0]!.memberIds).toEqual(["a", "b", "c"]);
    expect(d.groups[0]!.memberIds).toHaveLength(d.groups[0]!.count);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ROWLESS VARIANT — agents with no row of their own (workers nothing else speaks for).
//
// They used to bypass this module entirely and render one card each, which put the card wall back
// on any fleet with several blocked workers under an absent or in-motion orchestrator. The grouping
// rule is the same one; what the variant changes is the SENTENCE (a count that must not read as a
// promise about rows) and the ID (both variants can hold the same project::band at once).
// ─────────────────────────────────────────────────────────────────────────────
describe("buildDigest — the rowless variant", () => {
  it("collapses two or more into ONE line, exactly like every other population", () => {
    const d = buildDigest([agent({ id: "w1" }), agent({ id: "w2" }), agent({ id: "w3" })], "rowless");
    expect(d.cards).toEqual([]);
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0]!.count).toBe(3);
  });

  it("says what they ARE, never a row count the click cannot deliver", () => {
    const d = buildDigest([agent({ id: "w1" }), agent({ id: "w2" })], "rowless");
    // The sentence in full, because the whole point is which words it does NOT use: the row
    // variant's "2 Need you in sparkle-desktop" would promise two rows for agents that have none.
    expect(d.groups[0]!.text).toBe("2 workers inside sparkle-desktop need you");
  });

  it("keeps a lone rowless agent as a card — one is not a wall", () => {
    const d = buildDigest([agent({ id: "w1" })], "rowless");
    expect(d.cards.map((c) => c.id)).toEqual(["w1"]);
    expect(d.groups).toEqual([]);
  });

  it("carries its variant, so the click can tell a reveal from a filter", () => {
    const d = buildDigest([agent({ id: "w1" }), agent({ id: "w2" })], "rowless");
    expect(d.groups[0]!.variant).toBe("rowless");
  });

  it("defaults to the row-promising variant when none is asked for", () => {
    const d = buildDigest([agent({ id: "a" }), agent({ id: "b" })]);
    expect(d.groups[0]!.variant).toBe("rows");
  });

  // The two populations coexist in one project — two top-level asks beside two rowless workers —
  // and their lines must not collide as React keys or as the key a click re-derives itself from.
  it("gives the two variants distinct ids for the same project and band", () => {
    const rows = buildDigest([agent({ id: "a" }), agent({ id: "b" })]);
    const rowless = buildDigest([agent({ id: "w1" }), agent({ id: "w2" })], "rowless");
    expect(rowless.groups[0]!.id).not.toBe(rows.groups[0]!.id);
  });

  // Forward-guard, same reason the row variant has one: widening what the column surfaces must not
  // need a second copy of the copy rules.
  it("still names the band when the band is not needs_you", () => {
    const d = buildDigest(
      [agent({ id: "w1", band: "running" }), agent({ id: "w2", band: "running" })],
      "rowless",
    );
    expect(d.groups[0]!.text).toBe("2 workers inside sparkle-desktop are running");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE UNMERGED VARIANT — committed-but-unlanded work, which the column used to omit entirely.
//
// FOUNDER'S RULING, 2026-08-05 (bead sparkle-qogah). Asked whether "Needs merge" belongs in the
// concierge's WANTS YOU column — where it was deliberately excluded, the code's own comment reading
// "surfacing them here is 27 nudge cards", so the column could report "0 Need you" over 27 un-landed
// PRs — he chose: "Yes, but as one honest group — one row reading '27 need merge' that expands in
// place. Nothing hidden, count is true, column stays readable."
//
// The author's reasoning was right and the conclusion was wrong: the fix for too many cards is
// GROUPING, not exclusion. So `unmerged` goes through the same one rule as everything else, and what
// the variant changes is the sentence (its band is `done`, whose vocabulary would read "27 Done"),
// the bucket key (that band also holds `idle`, which he ruled informational), and the promise its
// count makes — this one is about the LINE, which names every member it counts.
// ─────────────────────────────────────────────────────────────────────────────
const unmergedAgent = (id: string, over: Partial<ConciergeAgent> = {}) =>
  agent({ id, status: "unmerged", band: "done", statusLabel: "Needs merge", ...over });

describe("buildDigest — the unmerged variant", () => {
  // THE HEADLINE. The reported fleet: 27 committed-but-unlanded agents, one line, true number.
  it("collapses 27 un-landed agents into ONE line whose count is the true total", () => {
    const many = Array.from({ length: 27 }, (_, i) => unmergedAgent(`pr-${i}`));
    const d = buildDigest(many, "unmerged");
    expect(d.cards).toEqual([]);
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0]!.text).toBe("27 need merge in sparkle-desktop");
    expect(d.groups[0]!.count).toBe(27);
  });

  // NOT CAPPED, NOT ROUNDED, NOT "+11 more". The count and the members are the same fact, so a cap
  // could not be introduced on one side without the other going red.
  it("states the exact total and can show every one of them", () => {
    const many = Array.from({ length: 27 }, (_, i) => unmergedAgent(`pr-${i}`));
    const g = buildDigest(many, "unmerged").groups[0]!;
    expect(g.memberIds).toHaveLength(27);
    expect(g.memberIds).toEqual(many.map((a) => a.id));
    expect(g.count).toBe(g.memberIds.length);
  });

  // The whole of "expands in place": the line carries who it stands for, so opening it needs no
  // second derivation from a feed that has ticked since it was drawn.
  it("names its members in feed order", () => {
    const d = buildDigest(
      [unmergedAgent("first"), unmergedAgent("second"), unmergedAgent("third")],
      "unmerged",
    );
    expect(d.groups[0]!.memberIds).toEqual(["first", "second", "third"]);
    expect(d.groups[0]!.leadAgentId).toBe("first");
  });

  // REVERSED from "a lone un-landed agent keeps its own card". A card is an INTERRUPTION carrying an
  // agent's affordances, and "Approve"/"Open" mean nothing for un-landed work —
  // ConciergeHost.cloudApproval.test.tsx pins that an unmerged agent gets neither. Buckets also key
  // on project, so one un-landed PR in each of twenty projects would emit twenty cards: the wall the
  // `done` band was excluded to prevent, rebuilt one project at a time. The founder asked for "one
  // honest group", and a group of one is still a line that states a true count and expands in place.
  it("gives a lone un-landed agent a LINE, not a card", () => {
    const d = buildDigest([unmergedAgent("solo")], "unmerged");
    expect(d.cards).toEqual([]);
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0]!.count).toBe(1);
    expect(d.groups[0]!.memberIds).toEqual(["solo"]);
  });

  // The exemption is scoped to `unmerged` ONLY — a lone needs-you agent still gets its card, which
  // is the affordance that lets you answer it.
  it("still cards a lone agent on the other variants", () => {
    const d = buildDigest([agent({ id: "solo", status: "waiting", band: "needs_you" })], "rows");
    expect(d.cards.map((c) => c.id)).toEqual(["solo"]);
    expect(d.groups).toEqual([]);
  });

  it("keeps projects separate — the line names the project it is about", () => {
    const d = buildDigest(
      [
        unmergedAgent("a"),
        unmergedAgent("b"),
        unmergedAgent("c", { projectId: "p2", projectName: "drodio-website" }),
        unmergedAgent("d", { projectId: "p2", projectName: "drodio-website" }),
      ],
      "unmerged",
    );
    expect(d.groups.map((g) => g.text)).toEqual([
      "2 need merge in drodio-website",
      "2 need merge in sparkle-desktop",
    ]);
  });

  it("carries its variant, so a consumer can tell this line from a band filter", () => {
    const d = buildDigest([unmergedAgent("a"), unmergedAgent("b")], "unmerged");
    expect(d.groups[0]!.variant).toBe("unmerged");
  });

  // All three populations can be live in one project at once. Two lines sharing an id would collide
  // as React keys and would make a click ambiguous about which population it re-derives from.
  it("gives all three variants distinct ids for the same project", () => {
    const rows = buildDigest([agent({ id: "a" }), agent({ id: "b" })]).groups[0]!.id;
    const rowless = buildDigest([agent({ id: "w1" }), agent({ id: "w2" })], "rowless").groups[0]!.id;
    const unmerged = buildDigest([unmergedAgent("u1"), unmergedAgent("u2")], "unmerged").groups[0]!
      .id;
    expect(new Set([rows, rowless, unmerged]).size).toBe(3);
  });

  // THE OVER-WIDENING GUARD, and it is a ruling not a nicety: "Done — your turn" / idle / finished is
  // INFORMATIONAL and may be capped. `idle` shares the `done` band with `unmerged`, so a band-keyed
  // bucket would have swept it in — the line would have read "4 need merge" over two agents that
  // need nothing. Keyed on the status, it cannot: they bucket apart, and the sentence for a
  // non-unmerged bucket falls back to the shared band vocabulary rather than claiming a merge.
  it("never folds idle agents into a need-merge count, even though they share the done band", () => {
    const d = buildDigest(
      [
        unmergedAgent("u1"),
        unmergedAgent("u2"),
        agent({ id: "i1", status: "idle", band: "done" }),
        agent({ id: "i2", status: "idle", band: "done" }),
      ],
      "unmerged",
    );
    const merge = d.groups.filter((g) => g.text.includes("need merge"));
    expect(merge).toHaveLength(1);
    expect(merge[0]!.count).toBe(2);
    expect(merge[0]!.memberIds).toEqual(["u1", "u2"]);
    // The idle pair is still accounted for — dropped silently would be the same defect in miniature
    // — but it is named for what it is, never as work he owes a merge on.
    expect(d.groups.map((g) => g.text)).toContain("2 Done in sparkle-desktop");
  });

  // The band is `done` and stays `done`: this line is not an alarm, and painting it like one is the
  // "27 nudge cards" the exclusion was trying to avoid. What changed is that it is COUNTED and SHOWN,
  // not that it was promoted into the interruption budget.
  it("keeps the done band — surfaced, not escalated", () => {
    const d = buildDigest([unmergedAgent("a"), unmergedAgent("b")], "unmerged");
    expect(d.groups[0]!.band).toBe("done");
  });
});
