// The PURE half of the concierge preview projections — asserted without rendering anything.
//
// `PreviewCards.test.tsx` drives the real store through `applyPreviewStatus` and asserts what
// reaches the DOM, which is the test that matters. This file covers the rules that are cheaper to
// pin exhaustively as functions: WHICH states get which projection, that the two projections are
// disjoint, and how the stderr tail is clamped.
//
// THE ONE THING IT MUST NOT LET DRIFT: `livePreviewCards` is not merely "the card list" — it is the
// app's definition of "a preview the human can OPEN", and `previewIdleGrace` reads that definition
// to decide which dev servers nothing is watching. So the first row below asserts that adding the
// notice states did NOT widen it, which is the regression this whole split exists to prevent.
import { describe, expect, it } from "vitest";

import {
  clampNoticeDetail,
  isPreviewNoticeState,
  livePreviewCards,
  pendingPreviewNotices,
  renderablePreviewNotices,
  PREVIEW_NOTICE_DETAIL_MAX,
} from "./previewCards";
import type { PreviewEntry, PreviewState } from "../stores/previewStore";

const ALL_STATES: PreviewState[] = [
  "installing",
  "starting",
  "listening",
  "ready",
  "serving",
  "failed",
  "crashed",
  "stopped",
];

function entry(over: Partial<PreviewEntry> & { status: PreviewState }): PreviewEntry {
  return {
    id: "srv-1",
    url: "http://127.0.0.1:5173",
    port: 5173,
    error: null,
    startedAt: 1_000,
    reloadNonce: 0,
    surfacedAt: null,
    ...over,
  };
}

describe("the two projections partition the state machine", () => {
  it("gives EVERY state exactly one of: a card, a notice, or nothing — and only `stopped` gets nothing", () => {
    // ONE MAP HOLDING ALL EIGHT STATES AT ONCE, so this is a partition claim rather than eight
    // independent yes/no answers that could all be satisfied by a function returning nothing.
    const byAgent: Record<string, PreviewEntry> = {};
    for (const status of ALL_STATES) byAgent[`ag-${status}`] = entry({ status });

    const cards = livePreviewCards(byAgent).map((c) => c.agentId).sort();
    const notices = pendingPreviewNotices(byAgent).map((n) => n.agentId).sort();

    expect(cards).toEqual(["ag-ready", "ag-serving"]);
    expect(notices).toEqual([
      "ag-crashed",
      "ag-failed",
      "ag-installing",
      "ag-listening",
      "ag-starting",
    ]);
    // DISJOINT — nothing may be both openable and merely noteworthy.
    expect(cards.filter((id) => notices.includes(id))).toEqual([]);
    // AND TOTAL, bar the one state that is where the surface retires.
    const covered = new Set([...cards, ...notices]);
    expect(ALL_STATES.filter((s) => !covered.has(`ag-${s}`))).toEqual(["stopped"]);
  });

  it("did NOT widen `livePreviewCards`, which `previewIdleGrace` reads as 'openable'", () => {
    // The regression this split exists to prevent: broadening the openable set would silently
    // change which dev servers the idle-grace clock reclaims.
    for (const status of ALL_STATES) {
      const only = { a1: entry({ status }) };
      expect(livePreviewCards(only).length).toBe(status === "ready" || status === "serving" ? 1 : 0);
    }
  });

  it("agrees with `isPreviewNoticeState` for every state, given a url the card can render", () => {
    // THE QUALIFIER IS THE POINT (roborev 65679). `isPreviewNoticeState` is now a statement about
    // the STATE alone — every state but `stopped` — while whether a notice is actually PRODUCED
    // also depends on the entry: a surfacing state yields a card instead, unless the card cannot
    // render its url, in which case it falls back to a notice. `entry()` seeds a loopback http url,
    // so this row asserts the card-wins half; the fallback half has its own describe block below.
    for (const status of ALL_STATES) {
      const produced = pendingPreviewNotices({ a1: entry({ status }) }).length === 1;
      const cardWins = status === "ready" || status === "serving";
      expect(produced).toBe(isPreviewNoticeState(status) && !cardWins);
    }
  });

  it("`stopped` is the ONLY state that is never noteworthy", () => {
    // Pinned separately because it is the one thing `isPreviewNoticeState` still decides on its
    // own, and it is what keeps retirement derived rather than scheduled.
    for (const status of ALL_STATES) {
      expect(isPreviewNoticeState(status)).toBe(status !== "stopped");
    }
  });
});

describe("what a notice carries", () => {
  it("carries the stderr tail verbatim, and marks failures apart from stages", () => {
    const tail = "the dev server exited before it started listening. Last output: EADDRINUSE";
    const [n] = pendingPreviewNotices({ a1: entry({ status: "failed", error: tail }) });
    expect(n).toBeDefined();
    expect(n!.detail).toBe(tail);
    expect(n!.fullDetail).toBe(tail);
    expect(n!.failed).toBe(true);
    expect(n!.status).toBe("failed");

    const [stage] = pendingPreviewNotices({ a1: entry({ status: "installing", error: null }) });
    expect(stage).toBeDefined();
    expect(stage!.detail).toBeNull();
    expect(stage!.failed).toBe(false);
  });

  it("carries NO url — the non-clickability is structural, not styled", () => {
    const [n] = pendingPreviewNotices({
      a1: entry({ status: "failed", url: "http://127.0.0.1:5173", error: "boom" }),
    });
    expect(n).toBeDefined();
    expect(Object.keys(n!)).not.toContain("url");
    expect(JSON.stringify(n!)).not.toContain("127.0.0.1");
  });

  it("orders newest first, with a total order on ties", () => {
    const notices = pendingPreviewNotices({
      old: entry({ status: "failed", startedAt: 10 }),
      newB: entry({ status: "starting", startedAt: 99 }),
      newA: entry({ status: "installing", startedAt: 99 }),
    });
    expect(notices.map((n) => n.agentId)).toEqual(["newA", "newB", "old"]);
  });

  it("resolves the owning agent's name and drops one the roster cannot resolve", () => {
    const byAgent = {
      known: entry({ status: "failed", error: "boom" }),
      ghost: entry({ status: "failed", error: "boom" }),
    };
    const named = renderablePreviewNotices(byAgent, [
      { agents: [{ id: "known", name: "Kraken Auth" }] },
    ]);
    expect(named.map((n) => [n.agentId, n.name])).toEqual([["known", "Kraken Auth"]]);
  });
});

describe("clampNoticeDetail", () => {
  it("returns null for absent or whitespace-only text", () => {
    expect(clampNoticeDetail(null)).toBeNull();
    expect(clampNoticeDetail(undefined)).toBeNull();
    expect(clampNoticeDetail("   \n\t ")).toBeNull();
  });

  it("leaves text at the limit untouched and keeps the TAIL of anything longer", () => {
    const exact = "y".repeat(PREVIEW_NOTICE_DETAIL_MAX);
    expect(clampNoticeDetail(exact)).toBe(exact);

    const over = `HEAD${"y".repeat(PREVIEW_NOTICE_DETAIL_MAX)}TAIL`;
    const clamped = clampNoticeDetail(over)!;
    // THE TAIL, because the last line a dev server printed is the one that says why it died.
    expect(clamped.endsWith("TAIL")).toBe(true);
    expect(clamped.includes("HEAD")).toBe(false);
    expect(clamped.startsWith("…")).toBe(true);
    expect(clamped.length).toBe(PREVIEW_NOTICE_DETAIL_MAX + 1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE PARTITION IS OVER ENTRIES, NOT OVER STATES — roborev 65679
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// The original partition test seeded every entry with `url: "http://127.0.0.1:5173"`, so "total,
// bar `stopped`" was only ever proven for loopback-http entries. `livePreviewCards` also drops a
// `ready`/`serving` entry whose url is null or is not loopback http, and notices used to exclude
// those states unconditionally — so a preview that was RUNNING fell through both projections and
// produced nothing at all, which is precisely the silence this surface exists to end.
describe("a running preview the card cannot render still says something", () => {
  const running = (url: string | null): Record<string, PreviewEntry> => ({
    a1: {
      id: "srv-a1",
      agentId: "a1",
      projectId: "p1",
      url,
      port: 5173,
      status: "serving",
      error: null,
      startedAt: 1_000,
      surfacedAt: 1_000,
      reloadNonce: 0,
    } as PreviewEntry,
  });

  // Each of these is a real shape the wire can deliver: a `serving` payload whose port was never
  // resolved into a url, and a dev server on https (Vite's `server.https`), which the loopback
  // predicate refuses because it parses the scheme rather than string-matching the host.
  for (const [label, url] of [
    ["a null url", null],
    ["an https dev server", "https://localhost:5173"],
  ] as const) {
    it(`falls through to a NOTICE when the card refuses ${label}`, () => {
      const byAgent = running(url);
      expect(livePreviewCards(byAgent)).toHaveLength(0);
      const notices = pendingPreviewNotices(byAgent);
      expect(notices).toHaveLength(1);
      // Not painted as a failure — nothing failed. The address is what cannot be offered.
      expect(notices[0]!.failed).toBe(false);
      expect(notices[0]!.status).toBe("serving");
    });
  }

  it("does NOT double-count a serving preview the card CAN render", () => {
    // The other half of the partition: exactly one surface, never both. Without this the fix above
    // would read as correct while every healthy preview grew a redundant status line under it.
    const byAgent = running("http://127.0.0.1:5173");
    expect(livePreviewCards(byAgent)).toHaveLength(1);
    expect(pendingPreviewNotices(byAgent)).toHaveLength(0);
  });
});
