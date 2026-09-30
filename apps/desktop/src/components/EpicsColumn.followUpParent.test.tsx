// @vitest-environment jsdom
//
// A BUG WITH A FOLLOW-UP CHILD IS NOT A PLAN (bead sparkle-8clekz).
//
// bd's parent edge carries two meanings: plan membership ("this task is part of that epic") and
// follow-up ("this was filed off the back of that bug"). `isEpic` used to be `typed epic OR has
// children`, so every ordinary bug that grew a follow-up became a plan card in the Epics column —
// closed ones included. Epic-ness is now the DECLARATION alone (`issue_type = 'epic'`).
//
// All three candidates are MOUNTED AT ONCE (AGENTS.md "mount every candidate"): absence asserted on
// a bead that was never in the store proves nothing, so the typed epic's presence in the same render
// is what shows the column was really asked about all three.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

import { EpicsColumn } from "./EpicsColumn";
import { useBeadsStore } from "../stores/beadsStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";
import { bucketBeads, type Bead } from "../services/beads";
import type { Project } from "../types";

const mk = (id: string, extra: Partial<Bead>): Bead =>
  ({ id, title: id, description: "", status: "open", labels: [], parent: null, commentCount: 0, ...extra }) as Bead;

const PLAN = mk("plan-1", { type: "epic" });
const PLAN_TASK = mk("plan-task", { type: "task", parent: "plan-1" });
const CLOSED_BUG = mk("bug-closed", { type: "bug", status: "closed" });
const CLOSED_BUG_FOLLOW_UP = mk("bug-closed-followup", { type: "bug", parent: "bug-closed" });
const OPEN_BUG = mk("bug-open", { type: "bug" });
const OPEN_BUG_FOLLOW_UP = mk("bug-open-followup", { type: "task", parent: "bug-open" });

const BEADS = [PLAN, PLAN_TASK, CLOSED_BUG, CLOSED_BUG_FOLLOW_UP, OPEN_BUG, OPEN_BUG_FOLLOW_UP];

const PROJECT = { id: "p1", name: "Alpha", rootPath: "/tmp/alpha", agents: [] } as unknown as Project;

const renderedEpicIds = () =>
  screen.queryAllByTestId("epic-row").map((el) => el.getAttribute("data-epic-id"));

beforeEach(() => {
  useBeadsStore.setState({ startPolling: () => {}, stopPolling: () => {} } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useUiStore.setState({ epicFocusBySide: { left: null, right: null } } as never);
  useBeadsStore.setState((prev) => ({
    ...prev,
    byProject: {
      ...(prev as { byProject: Record<string, unknown> }).byProject,
      p1: { beads: BEADS, board: bucketBeads(BEADS), polledAt: 0 },
    },
    error: {},
  }) as never);
  useRuntimeStore.setState({
    status: {},
    openAgentIds: [],
    lastObserved: {},
    branchStatus: {},
    workflowStage: {},
    observedAttention: {},
  } as never);
});
afterEach(cleanup);

describe("EpicsColumn — a follow-up child does not make its parent a plan", () => {
  it("renders the typed epic and neither bug that merely has a follow-up child", () => {
    render(<EpicsColumn project={PROJECT} side="right" />);
    const ids = renderedEpicIds();
    // The positive half: the column really rendered plans from this store.
    expect(ids).toContain("plan-1");
    // The negative half, on beads that ARE in the store and DO have children.
    expect(ids).not.toContain("bug-open");
    expect(ids).not.toContain("bug-closed");
  });
});
