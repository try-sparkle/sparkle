// @vitest-environment jsdom
//
// THE PRODUCTION SEAM — `EpicGoalRowForEpic`, the connected wrapper the Epics column actually
// mounts. `EpicGoalRow.test.tsx` drives the presentational component with its own injected props,
// which leaves the lines that SUPPLY those props covered by nothing: delete the whole `onGenerate`
// block and that suite stays green while the button — the only shipped way back from a failed
// generation — silently stops rendering, because it is gated on `onGenerate !== undefined`
// (roborev 65867). This file exists to make that deletion red.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const requestEpicGoalMock = vi.fn();
vi.mock("../services/epicGoalGen", async (orig) => ({
  ...(await orig<typeof import("../services/epicGoalGen")>()),
  requestEpicGoal: (...a: unknown[]) => requestEpicGoalMock(...a),
}));

const { EpicGoalRowForEpic } = await import("./EpicGoalRow");
const { useProjectStore } = await import("../stores/projectStore");
const { useBeadsStore } = await import("../stores/beadsStore");
type Bead = import("../services/beads").Bead;

const PROJECT = "p1";
const ROOT = "/repo";
const EPIC = "e1";

const EPIC_BEAD: Bead = {
  id: EPIC,
  title: "Show repo names",
  description: "",
  status: "open",
  labels: [],
  type: "epic",
};
const BEADS: Bead[] = [EPIC_BEAD];

function seed() {
  useProjectStore.setState({
    projects: [
      {
        id: PROJECT,
        name: "repo",
        rootPath: ROOT,
        defaultBranch: null,
        createdAt: new Date(0).toISOString(),
        selectedAgentId: null,
        agents: [],
      },
    ],
  } as never);
  // The wrapper resolves its project by REFERENCE IDENTITY against the poll snapshot, so the array
  // handed to the component has to be the very one in the store — not a copy of it.
  useBeadsStore.setState({
    byProject: { [PROJECT]: { beads: BEADS, board: {}, loadedAt: 0 } },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  requestEpicGoalMock.mockResolvedValue("generated");
});
afterEach(cleanup);

const goalOf = () =>
  useProjectStore.getState().projects.find((p) => p.id === PROJECT)?.epicGoals?.[EPIC];

describe("EpicGoalRowForEpic — the wiring, not the rendering", () => {
  it("offers Generate on a FAILED record and calls the generator with force and the real rootPath", async () => {
    useProjectStore.getState().noteEpicGoalFailure(PROJECT, EPIC, "the model call timed out");
    render(<EpicGoalRowForEpic epicId={EPIC} beads={BEADS} />);

    fireEvent.click(screen.getByTestId("epic-goal-generate"));

    await waitFor(() => expect(requestEpicGoalMock).toHaveBeenCalledTimes(1));
    expect(requestEpicGoalMock.mock.calls[0]?.[1]).toEqual({
      projectId: PROJECT,
      projectPath: ROOT,
      epicId: EPIC,
      // `force` is the whole point: without it the call is refused by the latch on precisely the
      // epics someone bothers to press this on.
      force: true,
    });
  });

  it("does NOT offer Generate on an epic that has never been tried", async () => {
    // The paired direction. Without it, a component that rendered the button unconditionally would
    // satisfy the test above.
    render(<EpicGoalRowForEpic epicId={EPIC} beads={BEADS} />);
    expect(screen.queryByTestId("epic-goal-generate")).toBeNull();
  });

  it.each([
    ["ai-off", /switched off/i],
    ["in-flight", /already being written/i],
    ["latched", /written by hand/i],
  ])("SAYS SOMETHING when outcome %s writes nothing itself", async (outcome, copy) => {
    // The silent-no-op case. All three of these write nothing to the store, so a fire-and-forget
    // click left the stale reason on the card and did nothing observable, forever, however many
    // times it was pressed.
    useProjectStore.getState().noteEpicGoalFailure(PROJECT, EPIC, "the model call timed out");
    requestEpicGoalMock.mockResolvedValue(outcome);
    render(<EpicGoalRowForEpic epicId={EPIC} beads={BEADS} />);

    fireEvent.click(screen.getByTestId("epic-goal-generate"));
    await waitFor(() => expect(goalOf()?.generationFailureReason).toMatch(copy));
  });

  it("a SUCCESS is left alone — the generator already wrote the goal", async () => {
    // Writing a generic reason over a real result is the mirror failure of saying nothing.
    useProjectStore.getState().noteEpicGoalFailure(PROJECT, EPIC, "the model call timed out");
    requestEpicGoalMock.mockImplementation(async () => {
      useProjectStore
        .getState()
        .setEpicGoal(PROJECT, EPIC, "Every project row shows its repository name.", "auto");
      return "generated";
    });
    render(<EpicGoalRowForEpic epicId={EPIC} beads={BEADS} />);

    fireEvent.click(screen.getByTestId("epic-goal-generate"));
    await waitFor(() => expect(goalOf()?.text).toMatch(/repository name/));
    expect(goalOf()?.generationFailureReason).toBeUndefined();
  });

  it("a THROW is caught and reported, never left as an unhandled rejection", async () => {
    useProjectStore.getState().noteEpicGoalFailure(PROJECT, EPIC, "the model call timed out");
    requestEpicGoalMock.mockRejectedValue(new Error("bridge died"));
    render(<EpicGoalRowForEpic epicId={EPIC} beads={BEADS} />);

    fireEvent.click(screen.getByTestId("epic-goal-generate"));
    await waitFor(() => expect(goalOf()?.generationFailureReason).toMatch(/crashed/i));
  });

  it("an edit through the wrapper writes source 'human' to the REAL store", async () => {
    // The other half of the seam: `onSetGoal` is supplied here too, and the `"human"` it passes is
    // what stamps the permanent latch.
    render(<EpicGoalRowForEpic epicId={EPIC} beads={BEADS} />);
    fireEvent.click(screen.getByTestId("epic-goal-empty"));
    const box = screen.getByTestId("epic-goal-input");
    fireEvent.change(box, { target: { value: "Every project row shows its repository name." } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(goalOf()?.text).toMatch(/repository name/));
    expect(goalOf()?.source).toBe("human");
    expect(useProjectStore.getState().mayGenerateEpicGoal(PROJECT, EPIC)).toBe(false);
  });
});
