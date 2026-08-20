// @vitest-environment jsdom
//
// DOES A NEWLY FILED EPIC ACTUALLY BECOME VISIBLE?
//
// The founder's ask is one gesture end to end: he describes a feature to the concierge, the
// concierge calls `create_plan`, and A CARD APPEARS in the Epics column's Backlog. Every layer of
// that was already built EXCEPT the last inch — `OPEN_BY_DEFAULT` held only {blocked, planning,
// inProgress}, and every other ladder key was seeded COLLAPSED on mount. So the epic was filed,
// bucketed and polled correctly, and what the founder saw was a count tick from 3 to 4 behind a
// closed chevron. A feature that is 100% correct in the data and invisible on screen is, to the
// person who asked for it, not built.
//
// TWO SEPARATE GUARANTEES ARE PINNED HERE, and they are separate on purpose:
//
//   1. BACKLOG IS OPEN ON MOUNT. This is the steady-state answer — the column he glances at
//      already shows the pile he is tracking.
//   2. A NEW EPIC REVEALS ITS OWN STAGE. This is the live answer, and it is the one that survives
//      him having collapsed Backlog himself, or a create landing somewhere other than Backlog
//      (a plan filed against an epic that already has children rolls up to Planning, not Backlog).
//
// (1) alone would leave the live case broken and (2) alone would leave the glance case broken, so
// neither substitutes for the other.
//
// THE FIRST SNAPSHOT MUST NOT REVEAL, and that case is asserted too — without it "everything is
// new at mount" expands all seven stages and puts a hundred rows in a 280px column, which is the
// exact posture `OPEN_BY_DEFAULT` exists to avoid.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

import { EpicsColumn } from "./EpicsColumn";
import { useBeadsStore } from "../stores/beadsStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { bucketBeads, type Bead } from "../services/beads";
import type { Project } from "../types";

const PROJECT = { id: "p1", name: "Alpha", rootPath: "/tmp/alpha", agents: [] } as unknown as Project;
const OTHER = { id: "p2", name: "Beta", rootPath: "/tmp/beta", agents: [] } as unknown as Project;

function bead(id: string, over: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", labels: [], type: "epic", ...over } as Bead;
}

/** Seed the store with exactly this bead list, as one already-bucketed snapshot. */
function seed(beads: Bead[], projectId = "p1") {
  useBeadsStore.setState((prev) => ({
    ...prev,
    byProject: {
      ...(prev as { byProject: Record<string, unknown> }).byProject,
      [projectId]: { beads, board: bucketBeads(beads), polledAt: 0 },
    },
    error: {},
  }) as never);
}

/** Which stages are OPEN right now, read off the toggles' own `aria-expanded`. */
function openStages(): string[] {
  return screen
    .queryAllByRole("button", { expanded: true })
    .map((b) => b.getAttribute("data-testid") ?? "")
    .filter((t) => t.startsWith("epics-stage-toggle-"))
    .map((t) => t.replace("epics-stage-toggle-", ""));
}

function epicRowIds(): string[] {
  return screen.queryAllByTestId("epic-row").map((r) => r.getAttribute("data-epic-id") ?? "");
}

beforeEach(() => {
  // NEUTRALISE THE POLLER, not the data. The column calls `startPolling` in an effect, and a real
  // one shells out to `bd` and would overwrite the snapshot this file seeds — asynchronously, so
  // the clobber would land mid-test and read as a flake rather than as a wrong assertion.
  useBeadsStore.setState({ startPolling: () => {}, stopPolling: () => {} } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useUiStore.setState({ epicFocusBySide: { left: null, right: null } } as never);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("a newly filed epic is VISIBLE, not just counted", () => {
  it("opens Backlog on mount, so a childless epic filed by the concierge shows as a CARD", () => {
    // A typed epic with no children is exactly what `create_plan` writes, and `openEpicStage`
    // buckets it to `backlog`. Before this, that row existed in the DOM's data and nowhere on the
    // founder's screen.
    seed([bead("ep-new")]);
    render(<EpicsColumn project={PROJECT} side="right" />);
    expect(openStages()).toContain("backlog");
    expect(epicRowIds()).toContain("ep-new");
  });

  it("still leaves the history stages collapsed — opening Backlog is not opening everything", () => {
    seed([bead("ep-done", { status: "closed" })]);
    render(<EpicsColumn project={PROJECT} side="right" />);
    expect(openStages()).not.toContain("archived");
    expect(openStages()).not.toContain("delivered");
    expect(openStages()).not.toContain("done");
  });

  it("does NOT expand a collapsed stage for epics that were already there at mount", () => {
    // Everything is "new" on the first snapshot. Treating that as an arrival would expand all seven
    // stages on every mount.
    seed([bead("ep-old", { status: "closed" })]);
    render(<EpicsColumn project={PROJECT} side="right" />);
    // COUNTED BUT NOT RENDERED — the count proves the bead really is in `done` rather than filtered
    // out somewhere, so "no row" is the chevron doing its job and not a vacuous absence.
    expect(screen.getByTestId("epics-stage-count-done").textContent).toBe("1");
    expect(openStages()).not.toContain("done");
    expect(epicRowIds()).not.toContain("ep-old");
  });

  it("re-opens a stage the founder collapsed when a NEW epic lands in it", () => {
    // The live case. He collapses Backlog to read something else, then asks for an epic — and the
    // card has to come to him, because he is not going to re-open a chevron he does not know
    // anything arrived behind.
    seed([bead("ep-1")]);
    render(<EpicsColumn project={PROJECT} side="right" />);
    fireEvent.click(screen.getByTestId("epics-stage-toggle-backlog"));
    expect(openStages()).not.toContain("backlog");

    act(() => seed([bead("ep-1"), bead("ep-2")]));
    expect(openStages()).toContain("backlog");
    expect(epicRowIds()).toContain("ep-2");
  });

  it("reveals a new epic that lands in a stage which is collapsed BY DEFAULT", () => {
    // `create_plan` against a project whose epic already has children does not land in Backlog, and
    // a reveal keyed to Backlog alone would miss it. Asserting on a stage that is collapsed by
    // default is what makes this test about the ARRIVAL rather than about `OPEN_BY_DEFAULT`.
    seed([bead("ep-1")]);
    render(<EpicsColumn project={PROJECT} side="right" />);
    expect(openStages()).not.toContain("done");

    act(() => seed([bead("ep-1"), bead("ep-shipped", { status: "closed" })]));
    expect(openStages()).toContain("done");
    expect(epicRowIds()).toContain("ep-shipped");
  });

  it("scrolls the new epic's row into view", () => {
    // jsdom does not implement scrollIntoView at all, so this stub is both the spy and the only
    // reason the call is reachable here — and the component must therefore call it defensively.
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    seed([bead("ep-1")]);
    render(<EpicsColumn project={PROJECT} side="right" />);
    scrollIntoView.mockClear();

    act(() => seed([bead("ep-1"), bead("ep-2")]));
    expect(scrollIntoView).toHaveBeenCalled();
  });

  // ── SWITCHING PROJECTS IS NOT A WAVE OF ARRIVALS ────────────────────────────────────────────
  //
  // `EpicsColumn` takes `project` as a PROP and is not remounted when the pair's project changes,
  // so a seen-id set keyed only to the component instance survives the switch — and every epic in
  // the newly selected project reads as unseen. The first one would expand its stage and scroll, on
  // the most ordinary navigation gesture in the app.
  //
  // BOTH PROJECTS ARE SEEDED AND THE SECOND IS ASSERTED WITH ITS OWN ROWS PRESENT, because
  // "nothing opened" against a project whose snapshot never arrived is vacuous — the stage would be
  // empty for a reason that has nothing to do with the seed (bead `sparkle-foqoe`).
  it("re-seeds on a PROJECT SWITCH instead of revealing the new project's whole backlog", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    seed([bead("a-1", { status: "closed" })], "p1");
    seed([bead("b-1", { status: "closed" }), bead("b-2", { status: "closed" })], "p2");
    const { rerender } = render(<EpicsColumn project={PROJECT} side="right" />);
    expect(openStages()).not.toContain("done");
    scrollIntoView.mockClear();

    rerender(<EpicsColumn project={OTHER} side="right" />);
    // The new project's epics really are there — so the absence below is the seed, not an empty
    // snapshot.
    expect(screen.getByTestId("epics-stage-count-done").textContent).toBe("2");
    expect(openStages()).not.toContain("done");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("still reveals an arrival AFTER a project switch — the re-seed must not deafen it", () => {
    // The paired case. Re-seeding that also stopped future reveals would pass the test above while
    // breaking the feature, which is the failure a single-direction assertion cannot see.
    seed([bead("a-1")], "p1");
    seed([bead("b-1", { status: "closed" })], "p2");
    const { rerender } = render(<EpicsColumn project={PROJECT} side="right" />);
    rerender(<EpicsColumn project={OTHER} side="right" />);
    expect(openStages()).not.toContain("done");

    act(() => seed([bead("b-1", { status: "closed" }), bead("b-2", { status: "closed" })], "p2"));
    expect(openStages()).toContain("done");
    expect(epicRowIds()).toContain("b-2");
  });

  it("does not re-expand a stage the founder collapsed when NOTHING new arrived", () => {
    // The other half of the reveal: a poll that returns the same set must leave his reading posture
    // exactly as he set it. Without the seen-set diff, every 5s poll would re-open every stage.
    seed([bead("ep-1")]);
    render(<EpicsColumn project={PROJECT} side="right" />);
    fireEvent.click(screen.getByTestId("epics-stage-toggle-backlog"));
    expect(openStages()).not.toContain("backlog");

    act(() => seed([bead("ep-1", { title: "renamed" })]));
    expect(openStages()).not.toContain("backlog");
  });
});
