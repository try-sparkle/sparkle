// @vitest-environment jsdom
//
// DOES THE EPIC GOAL ACTUALLY REACH THE SCREEN?
//
// The whole epic-goal feature (bead `sparkle-wab4lm`) hangs off ONE line in `EpicsColumn` — the
// `<EpicGoalRowForEpic …/>` mount inside `EpicRow`, plus its import. Everything else is covered:
// `EpicGoalRow.test.tsx` drives the presentational component with injected props,
// `EpicGoalRow.container.test.tsx` renders the connected wrapper directly, and
// `epicLadder.composed.test.ts` is engine-level. NONE of them renders `EpicsColumn`.
//
// So the mount site itself was asserted by nothing, and that is not a theoretical gap: those two
// lines sat in a merge conflict when the Epics-cockpit work restructured this file (roborev 65899).
// Had the hand resolution dropped them — the exact failure a hand-resolved conflict produces — the
// entire feature would have vanished from the app with the whole suite still green, and a
// mutation-check on the wrapper cannot see it, because the wrapper would still be perfectly correct
// and simply never rendered.
//
// This file is the guard for that one inch. Delete the mount line and it goes red.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

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
 *  ⚠️ The connected wrapper resolves its project by REFERENCE IDENTITY against
 *  `beadsStore.byProject[id].beads`, so the array handed to the column has to be the very one in
 *  the store — a copy resolves to no project and the row renders nothing, which would make this
 *  test pass for the wrong reason if it asserted absence. */
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

describe("the epic goal is mounted on the epic's row", () => {
  it("renders the goal row INSIDE the epic's row button, keyed to that epic", () => {
    const beads = [bead("ep-1")];
    seed(beads);
    render(<EpicsColumn project={PROJECT} side="right" />);

    // ⚠️ CONTAINMENT, not just existence (roborev 65967). A global `screen` query is satisfied
    // wherever in the column the mount lives, so asserting only the testid and the count left the
    // most plausible bad merge resolution unguarded: hoisting `<EpicGoalRowForEpic/>` out of
    // `EpicRow`'s <button> into a per-epic sibling keeps the id and the count correct while
    // breaking the design contract. `EpicGoalRow.tsx`'s own header explains why that matters — the
    // row is built from inline <span>s with stopPropagation PRECISELY because it lives inside the
    // epic row's button; outside it, the goal paints on its own line and the click-swallow contract
    // is moot. This suite exists to survive a hand-resolved conflict in this file, so the
    // resolution that MISPLACES the mount is squarely in scope.
    const epicRow = screen.getByTestId("epic-row");
    const goalRow = screen.getByTestId("epic-goal-row");
    expect(epicRow.contains(goalRow)).toBe(true);
    expect(goalRow.getAttribute("data-epic-id")).toBe("ep-1");
  });

  it("shows the goal TEXT the store holds, not just an empty affordance", () => {
    // The end-to-end claim the feature exists for: a goal written anywhere reaches the column.
    const beads = [bead("ep-1")];
    seed(beads);
    useProjectStore.getState().setEpicGoal("p1", "ep-1", GOAL, "human");
    render(<EpicsColumn project={PROJECT} side="right" />);

    expect(screen.getByTestId("epic-goal").textContent).toBe(GOAL);
  });

  it("mounts ONE goal row per epic, each keyed to its own", () => {
    // The paired direction: a mount hoisted out of `EpicRow` would render one row for the column
    // rather than one per epic, and the single-epic test above could not tell the difference.
    const beads = [bead("ep-1"), bead("ep-2")];
    seed(beads);
    render(<EpicsColumn project={PROJECT} side="right" />);

    // Each goal row must sit inside ITS OWN epic's button — the per-epic-sibling hoist produces the
    // right ids and the right count and would pass an id-only assertion.
    const pairs = screen
      .queryAllByTestId("epic-row")
      .map((r) => [
        r.getAttribute("data-epic-id"),
        within(r).queryByTestId("epic-goal-row")?.getAttribute("data-epic-id") ?? null,
      ])
      .sort();
    expect(pairs).toEqual([
      ["ep-1", "ep-1"],
      ["ep-2", "ep-2"],
    ]);
  });
});
