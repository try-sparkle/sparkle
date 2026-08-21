// @vitest-environment jsdom
//
// WHERE THE EPIC GOAL IS ALLOWED TO REACH THE SCREEN — and the epic ROW is not it.
//
// ══ THIS FILE WAS INVERTED, NOT WEAKENED (bead `sparkle-huw924.3`) ═════════════════════════════
// It landed (PR #2251, bead `sparkle-wab4lm`) asserting that `<EpicGoalRowForEpic …/>` IS mounted
// inside `EpicRow`, because that one line was the whole epic-goal feature and nothing rendered
// `EpicsColumn` to prove it survived a merge. That reasoning was right and is kept below — what
// changed is the ANSWER, not the question.
//
// The founder hit the mount as a BUG in the 2026-08-20 self-interview: the row is one `<button>`
// and the goal painted inside it as a `role="button"` span calling `stopPropagation()`, so an epic
// WITH a goal opened the GOAL and one WITHOUT opened the CARD — the same gesture giving two results
// purely from what data the epic carried. He ruled the goal off the row three times (02:33 "let's
// not have the goals showing on the build rows"; 04:29 "we're not gonna show the goal in the row…
// we should, however, be showing the goal in the epic when it's opened up"; 14:13 "we're not gonna
// show 'set a goal' on here") and answered "No goal should show in the row at all" when asked
// directly. So the mount is gone, and a guard demanding it back would pin the defect.
//
// ══ WHAT IT GUARDS NOW ════════════════════════════════════════════════════════════════════════
// The same one inch, from the other side: NO goal-bearing element is mounted in the epics column,
// and — this is the half that gives it force — that is true even for an epic whose store REALLY
// HOLDS a goal. Re-add the mount and this file goes red, which is exactly what should happen until
// the goal is re-mounted where it belongs.
//
// ══ THE ABSENCE TRAP THIS FILE'S ORIGINAL AUTHOR WARNED ABOUT, NOW LOAD-BEARING ════════════════
// Their `seed()` docstring flagged it: the connected wrapper resolves its project by REFERENCE
// IDENTITY against `beadsStore.byProject[id].beads`, so a COPY resolves to no project and the row
// renders nothing — which would make an absence assertion pass for the wrong reason. Now that the
// assertions ARE absence assertions, that is no longer a footnote, so every case here pairs the
// absence with a POSITIVE CONTROL: the epic row itself must be on screen, and the store must
// actually hold the goal. Absence beside a column that rendered nothing proves nothing at all
// (AGENTS.md, the "N targets" rule).
//
// ══ WHERE THE GOAL IS GOING ═══════════════════════════════════════════════════════════════════
// Onto the opened epic CARD, as an editable field (item 12 of `sparkle-huw924`, bead
// `sparkle-huw924.4`). `EpicGoalRowForEpic` is intact and unmounted for exactly that reason, and
// its container suite is kept green so the re-mount is safe. When that lands, the right move is to
// ADD the card-side mount guard here — the original argument, re-aimed — not to delete this file.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

import { EpicsColumn } from "./EpicsColumn";
import { useBeadsStore } from "../stores/beadsStore";
import { useProjectStore } from "../stores/projectStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { bucketBeads, type Bead } from "../services/beads";
import type { Project } from "../types";

const GOAL = "every epic on the board shows a goal a human can read";

const PROJECT = {
  id: "p1",
  name: "Alpha",
  rootPath: "/tmp/alpha",
  agents: [],
} as unknown as Project;

function bead(id: string, over: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", labels: [], type: "epic", ...over } as Bead;
}

/** Seed the bead snapshot AND a matching project.
 *
 *  THE ARRAY HANDED TO THE COLUMN MUST BE THE VERY ONE IN THE STORE. The connected wrapper resolves
 *  its project by REFERENCE IDENTITY against `beadsStore.byProject[id].beads`; a copy resolves to no
 *  project and renders nothing. Carried over verbatim from this file's original author, and it
 *  matters MORE now than it did then — see the header. */
function seed(beads: Bead[], project: Project = PROJECT) {
  useBeadsStore.setState((prev) => ({
    ...prev,
    byProject: {
      ...(prev as { byProject: Record<string, unknown> }).byProject,
      [project.id]: { beads, board: bucketBeads(beads), polledAt: 0 },
    },
    error: {},
  }) as never);
  useProjectStore.setState({ projects: [project] } as never);
}

/** Every testid the goal has ever painted under, so a rename cannot quietly re-admit it. */
const GOAL_TESTIDS = ["epic-goal-row", "epic-goal", "epic-goal-empty", "epic-goal-input"] as const;

beforeEach(() => {
  // Neutralise the poller, not the data — a real one shells out to `bd` and would clobber the
  // seeded snapshot asynchronously, which reads as a flake rather than a wrong assertion.
  useBeadsStore.setState({ startPolling: () => {}, stopPolling: () => {} } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useUiStore.setState({ epicFocusBySide: { left: null, right: null } } as never);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("the epic goal is NOT mounted on the epic's row", () => {
  it("renders no goal for an epic that HAS one — the case that used to swallow the click", () => {
    const beads = [bead("ep-1")];
    seed(beads);
    useProjectStore.getState().setEpicGoal("p1", "ep-1", GOAL, "human");
    render(<EpicsColumn project={PROJECT} side="right" />);

    // POSITIVE CONTROLS FIRST. Without both of these the absence below is worthless: it would hold
    // just as well for a column that rendered nothing, or for an epic that never had a goal.
    expect(screen.getByTestId("epic-row").getAttribute("data-epic-id")).toBe("ep-1");
    expect(useProjectStore.getState().projects[0]!.epicGoals?.["ep-1"]?.text).toBe(GOAL);

    for (const id of GOAL_TESTIDS) expect(screen.queryByTestId(id)).toBeNull();
    // ...and not merely unlabelled: the words themselves are off the row.
    expect(screen.getByTestId("epic-row").textContent).not.toContain(GOAL);
  });

  it("offers no 'Set a goal' affordance for an epic that has none", () => {
    // The founder, 14:13: "we're not gonna show 'set a goal' on here." The empty-state placeholder
    // was the other half of the same defect — a smaller click target, the identical swallow.
    const beads = [bead("ep-1")];
    seed(beads);
    render(<EpicsColumn project={PROJECT} side="right" />);

    expect(screen.getByTestId("epic-row").getAttribute("data-epic-id")).toBe("ep-1"); // control
    expect(useProjectStore.getState().projects[0]!.epicGoals?.["ep-1"]).toBeUndefined();

    for (const id of GOAL_TESTIDS) expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.getByTestId("epic-row").textContent).not.toContain("Set a goal");
  });

  it("holds for EVERY epic in the column, not just the first", () => {
    // The paired direction, kept from the original: a mount hoisted out of `EpicRow` would render
    // one row for the whole column rather than one per epic, and a single-epic case could not tell
    // the difference. Both epics are mounted at once and one of them carries a goal, so neither
    // "no epics rendered" nor "no goals exist" can explain the absence.
    const beads = [bead("ep-1"), bead("ep-2")];
    seed(beads);
    useProjectStore.getState().setEpicGoal("p1", "ep-2", GOAL, "human");
    render(<EpicsColumn project={PROJECT} side="right" />);

    const rowIds = screen
      .queryAllByTestId("epic-row")
      .map((r) => r.getAttribute("data-epic-id"))
      .sort();
    expect(rowIds).toEqual(["ep-1", "ep-2"]); // control: both really are on screen
    expect(useProjectStore.getState().projects[0]!.epicGoals?.["ep-2"]?.text).toBe(GOAL);

    for (const id of GOAL_TESTIDS) expect(screen.queryAllByTestId(id)).toEqual([]);
  });
});
