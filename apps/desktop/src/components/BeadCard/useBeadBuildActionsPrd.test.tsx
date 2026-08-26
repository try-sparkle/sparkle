// @vitest-environment jsdom
//
// Build It hands the orchestrator the epic's PRD BY PATH, and that path is now resolved
// structured-first. Driven through the hook's real `buildIt` / `buildAllPrd`, against the one
// shape that can distinguish the new rule: an epic whose recorded `prd` metadata and whose prose
// `PRD file:` line name DIFFERENT paths.
import { renderHook, act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendToBuild = vi.fn();
vi.mock("../../services/sendToBuild", async (orig) => ({
  ...(await orig<typeof import("../../services/sendToBuild")>()),
  sendToBuild: (...a: unknown[]) => sendToBuild(...a),
  sendToBuildBlockedReason: () => null,
}));

vi.mock("../../services/beads", async (orig) => ({
  ...(await orig<typeof import("../../services/beads")>()),
  claimBead: vi.fn().mockResolvedValue(undefined),
  unclaimBead: vi.fn().mockResolvedValue(undefined),
}));

const invoke = vi.fn();
vi.mock("../../services/ipc", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { useBeadBuildActions } from "./useBeadBuildActions";
import { resetEpicPrdIndexCache } from "../../services/epicPrd";
import { useProjectStore } from "../../stores/projectStore";
import { useBeadsStore } from "../../stores/beadsStore";
import type { Bead, Board } from "../../services/beads";

const PROSE_PATH = "PRD/stale-prose-path.md";
const METADATA_PATH = "PRD/recorded-in-metadata.md";

const emptyBoard = (): Board => ({
  backlog: [],
  blocked: [],
  inProgress: [],
  done: [],
  delivered: [],
  archived: [],
});

function bead(over: Partial<Bead> & { id: string }): Bead {
  return {
    title: "t",
    description: "",
    status: "open",
    labels: [],
    parent: null,
    commentCount: 0,
    ...over,
  };
}

/** Two epics whose PROSE lines name DIFFERENT PRDs — so grouping on the prose alone can never see
 *  them as siblings, and grouping on the recorded metadata (below) must. */
const epicA = bead({ id: "e1", type: "epic", description: `A.\n\nPRD file: ${PROSE_PATH}` });
const epicB = bead({ id: "e2", type: "epic", description: "B.\n\nPRD file: PRD/another-old.md" });

beforeEach(() => {
  sendToBuild.mockReset();
  invoke.mockReset();
  resetEpicPrdIndexCache();
  useBeadsStore.setState({
    byProject: { p1: { beads: [], board: emptyBoard(), loadedAt: 0 } },
  });
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "Demo",
        rootPath: "/tmp/demo",
        defaultBranch: "main",
        createdAt: "2026-01-01",
        agents: [],
        selectedAgentId: null,
      },
    ],
    selectedProjectId: "p1",
  });
});

afterEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useBeadsStore.setState({ byProject: {} });
});

/** `list_epic_prd` answers with `rows`; nothing else is called on this path. */
function ipcAnswers(rows: { id: string; prd: string }[]): void {
  invoke.mockImplementation(async (cmd: string) => (cmd === "list_epic_prd" ? rows : undefined));
}

function hook(b: Bead, all: Bead[] = [epicA, epicB]) {
  return renderHook(() => useBeadBuildActions({ bead: b, projectId: "p1", allBeads: all }));
}

describe("useBeadBuildActions — the PRD it hands over", () => {
  it("passes the METADATA path even though the description names a different one", async () => {
    ipcAnswers([{ id: "e1", prd: METADATA_PATH }]);
    const h = hook(epicA);

    await waitFor(() => expect(h.result.current.prdPath).toBe(METADATA_PATH));
    await act(async () => {
      await h.result.current.buildIt?.();
    });

    expect(sendToBuild).toHaveBeenCalledWith(
      expect.objectContaining({ epicId: "e1", prdPath: METADATA_PATH }),
    );
  });

  it("PAIRED NEGATIVE — with no metadata it passes the PARSED prose path", async () => {
    ipcAnswers([]);
    const h = hook(epicA);

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    await act(async () => {
      await h.result.current.buildIt?.();
    });

    expect(sendToBuild).toHaveBeenCalledWith(
      expect.objectContaining({ epicId: "e1", prdPath: PROSE_PATH }),
    );
  });

  it("groups PRD SIBLINGS on the resolved path, so two epics recorded against one PRD batch", async () => {
    // Their prose lines name different PRDs; only the structured field says they share one. Without
    // the grouping reading the same rule, `buildAllPrd` is null here — the card silently loses the
    // batch button on exactly the epics that gained the new field.
    ipcAnswers([
      { id: "e1", prd: METADATA_PATH },
      { id: "e2", prd: METADATA_PATH },
    ]);
    const h = hook(epicA);

    await waitFor(() => expect(h.result.current.buildAllPrd).not.toBeNull());
    await act(async () => {
      await h.result.current.buildAllPrd?.();
    });

    expect(sendToBuild).toHaveBeenCalledTimes(2);
    expect(sendToBuild).toHaveBeenCalledWith(
      expect.objectContaining({ epicId: "e1", prdPath: METADATA_PATH }),
    );
    expect(sendToBuild).toHaveBeenCalledWith(
      expect.objectContaining({ epicId: "e2", prdPath: METADATA_PATH }),
    );
  });

  it("PAIRED NEGATIVE — with no metadata the two prose paths are NOT siblings", async () => {
    ipcAnswers([]);
    const h = hook(epicA);

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(h.result.current.buildAllPrd).toBeNull();
  });
});
