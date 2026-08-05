// @vitest-environment jsdom
//
// `revealOutcomeFor` is a PREDICTION, and a prediction that drifts from the thing it predicts is
// worse than none: an over-reported `"already-showing"` puts "nothing moved" on screen beside a
// screen that moved, and an under-reported one puts the founder's original invisible click back.
//
// So each condition gets its own row. Every test below starts from a state that IS already showing
// and breaks exactly ONE of the writes the reveal path performs — which is what makes each row
// falsifiable: delete that condition from `revealOutcomeFor` and precisely one of these fails.
import { beforeEach, describe, expect, it } from "vitest";

import { revealOutcomeFor } from "./agentReveal";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";

/** The founder's shape: two projects, the pill's agent in the one on the OTHER pair. */
function seedAlreadyShowing(over: { ui?: object; ps?: object } = {}) {
  useRuntimeStore.setState({ openAgentIds: ["ag2"] } as never);
  useUiStore.setState({
    openProjectIds: null,
    pairAssignment: { p2: "left" },
    leftProjectId: "p2",
    activeSpecial: null,
    workModeBySide: { left: "build", right: "build" },
    ...over.ui,
  } as never);
  useProjectStore.setState({
    projects: [
      { id: "p1", name: "sparkle", agents: [{ id: "ag1", name: "Build 7" }] },
      { id: "p2", name: "other", agents: [{ id: "ag2", name: "Build 8" }], selectedAgentId: "ag2" },
    ],
    selectedProjectId: "p1",
    ...over.ps,
  } as never);
}

beforeEach(() => seedAlreadyShowing());

describe("revealOutcomeFor", () => {
  it("reports already-showing when every write the reveal would make is satisfied", () => {
    expect(revealOutcomeFor("p2", "ag2")).toBe("already-showing");
  });

  it("reports gone for an agent that is not in that project", () => {
    expect(revealOutcomeFor("p2", "nope")).toBe("gone");
  });

  it("reports gone for a project that does not exist", () => {
    expect(revealOutcomeFor("nope", "ag2")).toBe("gone");
  });

  it("reports revealed when the project's TAB is closed — markProjectOpen would write", () => {
    seedAlreadyShowing({ ui: { openProjectIds: ["p1"] } });
    expect(revealOutcomeFor("p2", "ag2")).toBe("revealed");
  });

  it("reports revealed when the project is not selected ON ITS SIDE", () => {
    // p2 is LEFT-assigned, so the left slot is the one that has to name it. `selectedProjectId`
    // being "p1" is irrelevant here and must not be read as the answer — that confusion is the bug
    // `selectProjectOnItsSide` exists for (roborev 55149/55158).
    seedAlreadyShowing({ ui: { leftProjectId: "p1" } });
    expect(revealOutcomeFor("p2", "ag2")).toBe("revealed");
  });

  it("reads the RIGHT pair's selection for an unassigned project", () => {
    // Absent from the map means right (engine/pairs.sideOf), where `selectedProjectId` IS the slot.
    seedAlreadyShowing({ ui: { pairAssignment: {}, leftProjectId: null } });
    expect(revealOutcomeFor("p2", "ag2")).toBe("revealed"); // selectedProjectId is still p1
    seedAlreadyShowing({
      ui: { pairAssignment: {}, leftProjectId: null },
      ps: { selectedProjectId: "p2" },
    });
    expect(revealOutcomeFor("p2", "ag2")).toBe("already-showing");
  });

  it("reports revealed when a DIFFERENT agent is the project's selected one", () => {
    seedAlreadyShowing({
      ps: {
        projects: [
          { id: "p1", name: "sparkle", agents: [{ id: "ag1", name: "Build 7" }] },
          {
            id: "p2",
            name: "other",
            agents: [
              { id: "ag2", name: "Build 8" },
              { id: "ag3", name: "Build 9" },
            ],
            selectedAgentId: "ag3",
          },
        ],
      },
    });
    expect(revealOutcomeFor("p2", "ag2")).toBe("revealed");
  });

  it("reports revealed when the agent's pane is not mounted — runtime.open would write", () => {
    useRuntimeStore.setState({ openAgentIds: [] } as never);
    expect(revealOutcomeFor("p2", "ag2")).toBe("revealed");
  });

  it("reports revealed while an app-global overlay is up — setActiveSpecial would write", () => {
    seedAlreadyShowing({ ui: { activeSpecial: "sparkle" } });
    expect(revealOutcomeFor("p2", "ag2")).toBe("revealed");
  });

  it("reports revealed while that column is on the Plan board — setWorkMode would write", () => {
    // PER SIDE. The RIGHT column being on plan says nothing about a left-assigned project, and
    // reading a single window-global mode here is the exact shape of bug the per-side split fixed.
    seedAlreadyShowing({ ui: { workModeBySide: { left: "plan", right: "build" } } });
    expect(revealOutcomeFor("p2", "ag2")).toBe("revealed");

    seedAlreadyShowing({ ui: { workModeBySide: { left: "build", right: "plan" } } });
    expect(revealOutcomeFor("p2", "ag2")).toBe("already-showing");
  });

  it("writes NOTHING — it is a prediction, and calling it must not change the answer", () => {
    const before = JSON.stringify({
      ui: useUiStore.getState().workModeBySide,
      open: useRuntimeStore.getState().openAgentIds,
      sel: useProjectStore.getState().selectedProjectId,
    });
    revealOutcomeFor("p2", "ag2");
    revealOutcomeFor("p1", "ag1");
    const after = JSON.stringify({
      ui: useUiStore.getState().workModeBySide,
      open: useRuntimeStore.getState().openAgentIds,
      sel: useProjectStore.getState().selectedProjectId,
    });
    expect(after).toBe(before);
  });
});
