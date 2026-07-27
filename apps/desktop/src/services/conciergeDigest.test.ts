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
