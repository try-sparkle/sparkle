// @vitest-environment jsdom
//
// The epic ladder's drop carries the epic's PRD path, and that path is now resolved
// structured-first. Driven through the real DOM gesture into the column's own call into
// `applyEpicDrop`, against the one shape that can distinguish the new rule from the old: an epic
// whose recorded `prd` metadata and whose prose `PRD file:` line name DIFFERENT paths.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("../services/ipc", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

interface ApplyArgs {
  projectId: string;
  rootPath: string;
  epicId: string;
  prdPath: string | null;
  plan: { writes: { kind: string }[]; landsOn: string };
}

const applyEpicDrop = vi.fn<(a: ApplyArgs) => Promise<void>>(async () => {});
vi.mock("../services/applyEpicDrop", () => ({
  applyEpicDrop: (a: ApplyArgs) => applyEpicDrop(a),
}));

import { EpicsColumn } from "./EpicsColumn";
import { resetEpicPrdIndexCache } from "../services/epicPrd";
import { useBeadsStore } from "../stores/beadsStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { bucketBeads, type Bead } from "../services/beads";
import type { Project } from "../types";

const PROSE_PATH = "PRD/stale-prose-path.md";
const METADATA_PATH = "PRD/recorded-in-metadata.md";

const EPIC: Bead = {
  id: "ep-a",
  title: "ep-a",
  description: `Ship it.\n\nPRD file: ${PROSE_PATH}`,
  status: "open",
  labels: [],
  parent: null,
  commentCount: 0,
  type: "epic",
};

const project = { id: "p1", name: "Alpha", rootPath: "/tmp/alpha", agents: [] } as unknown as Project;

function seed(beads: Bead[]) {
  useBeadsStore.setState((prev) => ({
    ...prev,
    byProject: {
      ...(prev as { byProject: Record<string, unknown> }).byProject,
      p1: { beads, board: bucketBeads(beads), loadedAt: 0 },
    },
    error: {},
  }) as never);
}

function rowFor(id: string): HTMLElement {
  const row = screen
    .queryAllByTestId("epic-row")
    .find((r) => r.getAttribute("data-epic-id") === id);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

function dt() {
  return { dropEffect: "uninitialized", effectAllowed: "all", setData: vi.fn(), getData: vi.fn() };
}

function dragTo(id: string, rung: string) {
  const transfer = dt();
  fireEvent.dragStart(rowFor(id), { dataTransfer: transfer });
  const stage = screen.getByTestId(`epics-stage-${rung}`);
  fireEvent.dragOver(stage, { dataTransfer: transfer });
  fireEvent.drop(stage, { dataTransfer: transfer });
}

/** `list_epic_prd` answers with `rows`; nothing else on this path calls the renderer IPC. */
function ipcAnswers(rows: { id: string; prd: string }[]): void {
  invoke.mockImplementation(async (cmd: string) => (cmd === "list_epic_prd" ? rows : undefined));
}

beforeEach(() => {
  applyEpicDrop.mockClear();
  applyEpicDrop.mockResolvedValue(undefined);
  invoke.mockReset();
  resetEpicPrdIndexCache();
  useBeadsStore.setState({ startPolling: () => {}, stopPolling: () => {} } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useUiStore.setState({ epicFocusBySide: { left: null, right: null } } as never);
  useRuntimeStore.setState({
    status: {},
    openAgentIds: [],
    lastObserved: {},
    branchStatus: {},
    workflowStage: {},
    observedAttention: {},
  } as never);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("EpicsColumn — the PRD path a drop carries", () => {
  it("carries the METADATA path even though the description names a different one", async () => {
    ipcAnswers([{ id: "ep-a", prd: METADATA_PATH }]);
    seed([EPIC]);
    render(<EpicsColumn project={project} side="right" />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("list_epic_prd", expect.anything()));
    dragTo("ep-a", "inProgress");

    await waitFor(() => expect(applyEpicDrop).toHaveBeenCalled());
    expect(applyEpicDrop.mock.calls[0]?.[0].prdPath).toBe(METADATA_PATH);
  });

  it("PAIRED NEGATIVE — with no metadata it carries the PARSED prose path", async () => {
    ipcAnswers([]);
    seed([EPIC]);
    render(<EpicsColumn project={project} side="right" />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("list_epic_prd", expect.anything()));
    dragTo("ep-a", "inProgress");

    await waitFor(() => expect(applyEpicDrop).toHaveBeenCalled());
    expect(applyEpicDrop.mock.calls[0]?.[0].prdPath).toBe(PROSE_PATH);
  });
});
