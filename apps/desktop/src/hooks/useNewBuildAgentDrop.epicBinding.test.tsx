// @vitest-environment jsdom
//
// THE EPIC BINDING ON THE DROP PATH — bead sparkle-70cu4y (write side).
//
// "+ New Build Agent" has TWO gestures and they used to disagree. Clicking it from an epic-focused
// sidebar passes `epicFocusBySide[side]` down to `spawnBuildAgentInProject`, which stamps
// `AgentTab.epicId` and parents the auto-bead to the epic. DROPPING FILES on the same button called
// `spawnRef.current()` with no arguments, so the epic the app had in hand was thrown away between
// the gesture and the shared spawn — and nothing anywhere said so.
//
// ── WHY THESE ASSERT THROUGH `boundAgentsFor` AND NOT ON THE SPAWN'S ARGUMENTS ────────────────────
// `epicSweepRunner.boundAgentsFor` is `kind === "build" && epicId === <epic>` — the RAW BINDING,
// read by the sweep's watch gate, its marker self-heal, and `planView.orchestratorNameForEpic`. (The
// LIVENESS readings resolve through `staffingAgentsFor` since bead `sparkle-n2feho.5`; a row that
// discards the epic is invisible to that one too, since it has neither field to resolve.) Asserting
// that `useSpawnBuildAgent` was CALLED with the epic
// proves the argument moved; it does not prove the epic can be seen as staffed, which is the whole
// defect. So these tests mock nothing on the spawn path: the real hook drives the real
// `spawnBuildAgentInProject`, the row is read back out of the real `projectStore`, and the real
// staffing query is asked whether it finds the agent.
//
// The PAIRED case is the other half and is not decoration: a rule that stamped every dropped spawn
// with some epic would satisfy the first test. A drop with nothing focused must leave the row's
// `epicId` genuinely UNSET — an honest absence, not a fabricated binding — and a focus belonging to
// the OTHER pair must not leak into this project's spawn.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type DragEventPayload =
  | { type: "enter" | "over"; position: { x: number; y: number }; paths?: string[] }
  | { type: "drop"; position: { x: number; y: number }; paths: string[] }
  | { type: "leave" };

const captured = vi.hoisted(() => ({
  handler: null as ((event: { payload: unknown }) => void) | null,
  beadCalls: [] as unknown[][],
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (h: (event: { payload: unknown }) => void) => {
      captured.handler = h;
      return Promise.resolve(() => {
        captured.handler = null;
      });
    },
  }),
}));
// The three seams `buildAgentSpawn.epic.test.ts` stubs for the same reason: the PTY launch, the
// attention move, and the `bd` shell-out are not what is under test here.
vi.mock("../services/agentBrief", () => ({
  attachBrief: () => {},
  clearBrief: () => {},
  briefForLaunch: () => undefined,
  hasUndeliveredBrief: () => false,
  resetAgentBriefs: () => {},
}));
vi.mock("../services/landInAgent", () => ({ landInAgent: () => {} }));
vi.mock("../services/tasks", () => ({
  createBeadFull: async (...a: unknown[]) => {
    captured.beadCalls.push(a);
    return "bd-auto-1";
  },
}));

import { useNewBuildAgentDrop } from "./useNewBuildAgentDrop";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { usePendingAttachmentsStore } from "../stores/pendingAttachmentsStore";
import { resetVisitedProjects } from "../services/sessionProjects";
import { boundAgentsFor } from "../services/epicSweepRunner";
import { NEW_BUILD_AGENT_DND_TARGET } from "../services/dndTargets";
import type { Project } from "../types";

const EPIC_ID = "sparkle-epic1";

function Host({ project }: { project: Project | null }) {
  useNewBuildAgentDrop(project);
  return null;
}

const button = document.createElement("button");
button.setAttribute("data-dnd-target", NEW_BUILD_AGENT_DND_TARGET);
let overButton = true;

const fire = (payload: DragEventPayload) => act(() => captured.handler!({ payload }));

/** The project's live roster, as the board and the sweep would read it. */
function roster(projectId: string) {
  return useProjectStore.getState().projects.find((p) => p.id === projectId)!.agents;
}

function newProject(): Project {
  const id = useProjectStore.getState().addProject("Demo", "/tmp/demo");
  return useProjectStore.getState().projects.find((p) => p.id === id)!;
}

beforeEach(() => {
  captured.beadCalls = [];
  overButton = true;
  document.elementFromPoint = vi.fn(() => (overButton ? button : document.body));
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useRuntimeStore.setState({ branchStatus: {}, workflowStage: {}, openAgentIds: [] });
  useSettingsStore.setState({
    maxConcurrentWorkers: 3,
    effectiveMaxConcurrentWorkers: 3,
    machineMaxConcurrentWorkers: 3,
    concurrencyBound: "cpu",
    concurrencyBasis: "CPU-bound: 18 cores × 2 agents per core",
  });
  useUiStore.setState({
    pairAssignment: {},
    epicFocusBySide: { left: null, right: null },
    buildAgentHover: false,
  });
  usePendingAttachmentsStore.setState({ pending: {} });
  resetVisitedProjects();
});
afterEach(() => cleanup());

describe("a file dropped on + New Build Agent while an epic is focused", () => {
  it("STAFFS that epic — boundAgentsFor finds the spawned agent", () => {
    const p = newProject();
    // An unassigned project belongs to the RIGHT pair (engine/pairs.sideOf), which is where the
    // sidebar that rendered this button reads its epic focus from.
    useUiStore.setState({ epicFocusBySide: { left: null, right: EPIC_ID } });
    render(<Host project={p} />);

    fire({ type: "drop", position: { x: 10, y: 10 }, paths: ["/tmp/a.png"] });

    // THE SIDE EFFECT. `[]` here is `unstaffed` to every staffing reader by definition, which is
    // why an assertion on the spawn's arguments would not have caught the defect that shipped.
    const bound = boundAgentsFor(roster(p.id), EPIC_ID);
    expect(bound).toHaveLength(1);
    // …and the files still reach the agent that was staffed, not some other row.
    expect(usePendingAttachmentsStore.getState().drain(bound[0]!.id)).toEqual(["/tmp/a.png"]);
  });

  it("also parents its auto-bead to the epic, so the link outlives the tab", async () => {
    const p = newProject();
    useUiStore.setState({ epicFocusBySide: { left: null, right: EPIC_ID } });
    render(<Host project={p} />);

    fire({ type: "drop", position: { x: 10, y: 10 }, paths: ["/tmp/a.png"] });

    await vi.waitFor(() => expect(captured.beadCalls.length).toBe(1));
    // The 5th positional argument of `createBeadFull` is `parent` (services/tasks).
    expect(captured.beadCalls[0]![4]).toBe(EPIC_ID);
  });

  it("reads the focus of the side that OWNS the project, not the other pair's", () => {
    const p = newProject();
    // The epic is focused on the LEFT pair while this project lives on the RIGHT. A drop here is
    // not a gesture about that epic, and binding to it would attribute the agent to work nobody
    // aimed it at — the false-positive direction, which is the unrecoverable one.
    useUiStore.setState({
      pairAssignment: { [p.id]: "right" },
      epicFocusBySide: { left: EPIC_ID, right: null },
    });
    render(<Host project={p} />);

    fire({ type: "drop", position: { x: 10, y: 10 }, paths: ["/tmp/a.png"] });

    expect(roster(p.id)).toHaveLength(1);
    expect(boundAgentsFor(roster(p.id), EPIC_ID)).toEqual([]);
  });
});

describe("a file dropped with NO epic focused", () => {
  it("leaves the binding genuinely UNSET — an absent epic is not a false one", async () => {
    // THE PAIRED CASE. Without it, a rule that stamped every dropped spawn with something would
    // pass the tests above. `epicId` must be absent, and the auto-bead must stay top-level.
    const p = newProject();
    render(<Host project={p} />);

    fire({ type: "drop", position: { x: 10, y: 10 }, paths: ["/tmp/a.png"] });

    const agents = roster(p.id);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.epicId).toBeUndefined();
    expect(boundAgentsFor(agents, EPIC_ID)).toEqual([]);
    await vi.waitFor(() => expect(captured.beadCalls.length).toBe(1));
    expect(captured.beadCalls[0]![4]).toBe("");
  });
});
