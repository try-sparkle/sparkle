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
