// @vitest-environment jsdom
//
// AgentRow ↔ ModelPill wiring (sparkle-i6rw): the pill lives on the hover card's expanded strip,
// only for claude-terminal kinds (build/worker), and a pick must BOTH persist via
// projectStore.setAgentModel AND live-deliver via applyModelToRunningAgent — without selecting
// the card. Mirrors the AgentSidebar.agentRow.test.tsx harness (heavy leaves mocked).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
// The live-delivery service is the assertion target — the PTY layer must not be touched here.
vi.mock("../services/agentModel", () => ({
  applyModelToRunningAgent: vi.fn(() => Promise.resolve()),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { applyModelToRunningAgent } from "../services/agentModel";
import type { Project, AgentTab } from "../types";

const TITLE = "Agent Name";

function mkAgent(over: Partial<AgentTab> = {}): AgentTab {
  return {
    id: "a1",
    name: TITLE,
    kind: "worker",
    parentId: null,
    runtime: "local",
    worktreePath: "/tmp/demo/.worktrees/a1",
    branch: "sparkle/agent-a1",
    baseBranch: "main",
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: { title: TITLE, description: "" },
    shellCommand: null,
    pinnedIndex: null,
    ...over,
  };
}

function mkProject(agents: AgentTab[]): Project {
  return {
    id: "p1",
    name: "Demo",
    rootPath: "/tmp/demo",
    defaultBranch: null,
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    agents,
  };
}

/** Seed the REAL project store with the project so setAgentModel's effect is observable. */
function seedProject(project: Project) {
  useProjectStore.setState({ projects: [project], selectedProjectId: project.id });
}

const agentModel = () =>
  useProjectStore.getState().projects[0]!.agents.find((a) => a.id === "a1")!.model;

beforeEach(() => {
  useRuntimeStore.setState({ branchStatus: {}, status: {} });
  useUiStore.setState({ workMode: "build" });
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("AgentRow — ModelPill wiring", () => {
  it("a pick persists via setAgentModel AND live-delivers via applyModelToRunningAgent", () => {
    const project = mkProject([mkAgent()]);
    seedProject(project);
    render(<AgentSidebar project={project} />);
    fireEvent.click(screen.getByText(TITLE)); // open the hover card
    fireEvent.click(screen.getByTestId("model-pill").querySelector("button")!);
    fireEvent.click(screen.getByText("Opus 4.8"));
    expect(agentModel()).toBe("claude-opus-4-8");
    expect(applyModelToRunningAgent).toHaveBeenCalledWith("a1", "claude-opus-4-8");
  });

  it("picking Default persists undefined (store-normalized) and still calls the live path (no-op there)", () => {
    const project = mkProject([mkAgent({ model: "claude-opus-4-8" })]);
    seedProject(project);
    render(<AgentSidebar project={project} />);
    fireEvent.click(screen.getByText(TITLE));
    fireEvent.click(screen.getByTestId("model-pill").querySelector("button")!);
    fireEvent.click(screen.getByText("Default (Claude Code setting)"));
    expect(agentModel()).toBeUndefined();
    expect(applyModelToRunningAgent).toHaveBeenCalledWith("a1", "default");
  });

  it("interacting with the pill keeps the card open and doesn't hijack selection", () => {
    const project = mkProject([mkAgent()]);
    seedProject(project);
    render(<AgentSidebar project={project} />);
    fireEvent.click(screen.getByText(TITLE)); // opening the card selects a1
    fireEvent.click(screen.getByTestId("model-pill").querySelector("button")!);
    fireEvent.click(screen.getByText("Sonnet 5"));
    // The card is still open (the pill's clicks stopPropagation, so they never close it) and the
    // selection is still the agent whose card we opened — the pill didn't change it.
    expect(screen.getByTestId("agent-hover-card")).toBeTruthy();
    expect(useProjectStore.getState().projects[0]!.selectedAgentId).toBe("a1");
  });

  it("the pill renders only for claude-terminal kinds — a shell row's card has none", () => {
    const worker = mkAgent();
    const shell = mkAgent({
      id: "s1",
      name: "Shell Row",
      kind: "shell",
      autoNameVariants: { title: "Shell Row", description: "" },
      worktreePath: "/tmp/demo/.worktrees/s1",
      shellCommand: "npm run dev",
    });
    const project = mkProject([worker, shell]);
    seedProject(project);
    render(<AgentSidebar project={project} />);
    fireEvent.click(screen.getByText("Shell Row"));
    expect(screen.getByTestId("agent-hover-card")).toBeTruthy(); // card open…
    expect(screen.queryByTestId("model-pill")).toBeNull(); // …but no pill for a shell tab
    // (Once hovered, the name renders twice — hidden in-flow row + overlay — hence getAllByText.)
    fireEvent.mouseOut(screen.getAllByText("Shell Row")[0]!);
    fireEvent.click(screen.getByText(TITLE));
    expect(screen.getByTestId("model-pill")).toBeTruthy(); // the worker card has one
  });
});
