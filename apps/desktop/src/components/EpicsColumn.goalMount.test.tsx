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
  it("renders the goal row for the epic actually on screen", () => {
    const beads = [bead("ep-1")];
    seed(beads);
    render(<EpicsColumn project={PROJECT} side="right" />);

    // The row exists AND is keyed to this epic — a mount that rendered a goal row for the wrong
    // epic would be just as broken as no mount at all.
    const row = screen.getByTestId("epic-goal-row");
    expect(row.getAttribute("data-epic-id")).toBe("ep-1");
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

    const ids = screen
      .queryAllByTestId("epic-goal-row")
      .map((r) => r.getAttribute("data-epic-id"))
      .sort();
    expect(ids).toEqual(["ep-1", "ep-2"]);
  });
});
