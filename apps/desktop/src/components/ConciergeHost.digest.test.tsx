// @vitest-environment jsdom
//
// The digest line: where it sits in the thread, and what clicking it does.
//
// Two bugs, both reported as "the need-you notices show below the chat":
//   1. The stream was built `[...chat, ...digests, ...nudges]`, so every notice was pinned under
//      the WHOLE conversation regardless of when it arrived — it read as a footer, not a message.
//   2. Clicking one opened the lead agent's tab but left column two showing every band, so the
//      "17 Need you" you just clicked was still buried among fifty rows.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ openProjectTab: vi.fn() }));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("../services/openProjectTab", () => ({ openProjectTab: h.openProjectTab }));

import { ConciergeHost } from "./ConciergeHost";
import { useUiStore } from "../stores/uiStore";
import type { ConciergeFeed } from "../useConciergeFeed";
import type { StatusBand } from "../engine/buildSections";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";

// PRECONDITION, stated rather than inherited: this suite's subject is the concierge CONVERSATION,
// and the column locks that half — thread and composer both — whenever the AI gate is shut
// (Concierge/conciergeAiLock). A fresh test's default is the anonymous trial (`me: null`), which is
// locked. The locked state has its own suite: Concierge/ConciergeColumn.locked.test.
beforeEach(enableAiEnhancementsForTests);

/** A feed with `n` agents of one band in one project — >= 2 is what collapses them into a digest. */
function feedOf(n: number, band: StatusBand = "needs_you", projectName = "sparkle-desktop") {
  const agents = Array.from({ length: n }, (_, i) => ({
    id: `ag${i}`,
    name: `Agent ${i}`,
    projectId: "p1",
    projectName,
    kind: "build" as const,
    status: band === "needs_you" ? "waiting" : "working",
    statusColor: "#e0533f",
    statusLabel: "Needs you",
    band,
    inScope: true,
    muted: false,
    // A build agent that can claim a row of its own in column two. `surfacedAgents` filters on
    // this, which is what keeps the count a digest line STATES equal to the rows the click leaves
    // standing — workers surface nested under their orchestrator and can never be sidebar rows.
    //
    // Load-bearing in a fixture that `as unknown as ConciergeFeed`s its way past the compiler: an
    // omitted `topLevel` is falsy, so leaving it out does not fail to compile, it silently drops
    // every agent and the digest simply never renders. Production values only ever come from
    // buildConciergeFeed, which stamps it.
    topLevel: true,
    // Nothing above it in the tree, so no ancestor row can be speaking for it.
    representedElsewhere: false,
  }));
  const counts = { needs_you: 0, running: 0, done: 0, [band]: n };
  return {
    projects: [
      { id: "p1", name: projectName, inScope: true, counts, scopedCounts: counts, agents },
    ],
    counts,
    scopedCounts: counts,
    pinnedProjectId: null,
  } as unknown as ConciergeFeed;
}

const digest = () => screen.getByTestId("concierge-digest");

beforeEach(() => {
  useUiStore.getState().showAllStatusBands();
  h.openProjectTab.mockReset();
});
afterEach(() => cleanup());

describe("the digest line renders in the thread", () => {
  it("collapses several same-band agents into one line", () => {
    render(<ConciergeHost feed={feedOf(17)} />);
    // The verb agrees with the count — "17 Need you", not "17 Needs you".
    expect(digest().textContent).toContain("17 Need you");
    expect(digest().textContent).toContain("sparkle-desktop");
  });

  it("carries its band, so the line and the rows it stands for read as one urgency", () => {
    render(<ConciergeHost feed={feedOf(3, "needs_you")} />);
    expect(digest().getAttribute("data-band")).toBe("needs_you");
  });

  it("sits INSIDE the scrolling thread, not pinned beneath it", () => {
    // A notice rendered outside the scroller is a footer; inside it, it is part of the stream.
    render(<ConciergeHost feed={feedOf(4)} />);
    const scroller = document.querySelector('[data-testid="concierge-thread"]');
    expect(scroller).toBeTruthy();
    expect(scroller!.contains(digest())).toBe(true);
  });
});

describe("clicking the digest narrows the Build column", () => {
  it("isolates that band in the sidebar filter", () => {
    render(<ConciergeHost feed={feedOf(17, "needs_you")} />);
    expect(useUiStore.getState().statusFilter).toEqual({
      needs_you: true,
      running: true,
      done: true,
    });

    fireEvent.click(digest());

    // The point of the click: you asked to see those seventeen, so show those seventeen. This is
    // the SAME statusFilter the sidebar's own chips render, so the effect is visible up there and
    // clears with the ordinary "Show all" rather than being an invisible mode.
    expect(useUiStore.getState().statusFilter).toEqual({
      needs_you: true,
      running: false,
      done: false,
    });
  });

  it("reads the band off the LINE rather than hardcoding needs_you", () => {
    // Only `needs_you` reaches the thread today — surfacedAgents gates on it, so a "running" digest
    // cannot currently exist and asserting one would be testing a fiction. What IS checkable is
    // that the click and the rendered line agree: both come from the same `band` field, so if the
    // surfacing gate ever widens, the filter follows without another edit.
    render(<ConciergeHost feed={feedOf(5, "needs_you")} />);
    const band = digest().getAttribute("data-band") as "needs_you" | "running" | "done";
    fireEvent.click(digest());
    const filter = useUiStore.getState().statusFilter;
    expect(filter[band]).toBe(true);
    expect(Object.values(filter).filter(Boolean)).toHaveLength(1);
  });

  it("does not surface a non-needs_you band into the thread at all", () => {
    // The surfacing gate, pinned: a column that narrated every running agent would be a duplicate
    // of column two rather than a concierge.
    render(<ConciergeHost feed={feedOf(5, "running")} />);
    expect(screen.queryByTestId("concierge-digest")).toBeNull();
  });

  it("STILL opens the lead agent's project tab — filtering replaces nothing", () => {
    render(<ConciergeHost feed={feedOf(6)} />);
    fireEvent.click(digest());
    expect(h.openProjectTab).toHaveBeenCalledWith("p1", "ag0");
  });
});
