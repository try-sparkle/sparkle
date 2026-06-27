// @vitest-environment jsdom
//
// AgentRow behavioral tests for the hover slide-out rework: the rename <input> must stay a SINGLE
// instance across hover changes (so a hover-driven unmount can't commit a half-typed name), and the
// behind/ahead pill must be a clickable rebase button ONLY when behind (the green ahead pill is
// purely informational). Heavy leaf components + the Tauri opener are mocked so the sidebar renders.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
// Stub the branch git actions (keep the store's status/workflow helpers real) so we can assert the
// pills are wired to the right action: red → rebase (refreshAgentBranch), green → land.
vi.mock("../services/branchStatus", async (orig) => ({
  ...(await orig<typeof import("../services/branchStatus")>()),
  landAgentBranch: vi.fn(async () => ({ ok: false as const, reason: "busy" as const })),
  refreshAgentBranch: vi.fn(async () => ({ ok: false as const, reason: "busy" as const })),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
// HistorySearch renders its own search <input>; mock it out so the only textbox on screen is the
// rename field under test.
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

import { AgentSidebar } from "./AgentSidebar";
import { useRuntimeStore } from "../stores/runtimeStore";
import { landAgentBranch, refreshAgentBranch } from "../services/branchStatus";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Project, AgentTab } from "../types";
import type { BranchStatus } from "../services/branchStatus";

// Collapsed rows render the MEDIUM variant (jsdom has no ResizeObserver, so the width-fit measure
// never runs and FittedAgentName falls back to `medium`); the hover overlay renders the full LONG
// name. Tests target whichever is on screen for the state under test.
const LONG = "A Very Long Agent Name That Needs The Slide-Out";
const MEDIUM = "Agent Name";

function mkAgent(over: Partial<AgentTab> = {}): AgentTab {
  return {
    id: "a1",
    name: LONG,
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
    autoNameVariants: { short: "Agent", medium: "Agent Name", long: LONG },
    shellCommand: null,
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

function seedBranch(id: string, bs: BranchStatus) {
  useRuntimeStore.setState({ branchStatus: { [id]: bs }, status: {} });
}
const bs = (over: Partial<BranchStatus> = {}): BranchStatus => ({
  ahead: 0,
  behind: 0,
  dirty: false,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  ...over,
});

beforeEach(() => {
  useRuntimeStore.setState({ branchStatus: {}, status: {} });
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("AgentRow — rename input is a single instance across hover", () => {
  it("keeps exactly one input while editing, regardless of hover changes", () => {
    render(<AgentSidebar project={mkProject([mkAgent()])} />);

    // Hover the collapsed row → the slide-out overlay mounts and reveals the full LONG name.
    // (mouseOver is how React's onMouseEnter is triggered in jsdom.)
    fireEvent.mouseOver(screen.getByText(MEDIUM));
    expect(screen.getByText(LONG)).toBeTruthy();

    // Double-click the overlay's full name to rename → the overlay is suppressed and the in-flow
    // row owns the ONE input. The full name disappears (input stands in for it).
    fireEvent.doubleClick(screen.getByText(LONG));
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByText(LONG)).toBeNull();

    // Toggling hover mid-rename must NOT spawn or swap a second input.
    const row = screen.getByRole("textbox").closest("div")!;
    fireEvent.mouseOut(row);
    fireEvent.mouseOver(row);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("Escape cancels the rename without committing (no second input, edit dropped)", () => {
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    fireEvent.doubleClick(screen.getByText(MEDIUM));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "scratch-typing" } });
    fireEvent.keyDown(input, { key: "Escape" });
    // Edit dropped → back to the name, no lingering input.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(MEDIUM)).toBeTruthy();
  });
});

describe("AgentRow — behind/ahead pill", () => {
  it("renders the behind pill as a clickable rebase (catch-up) button", () => {
    seedBranch("a1", bs({ behind: 4 }));
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    const pill = screen.getByRole("button", { name: "-4" });
    expect(pill.title).toMatch(/rebase/);
  });

  it("renders the ahead pill as a clickable land (merge-into-main) button", () => {
    seedBranch("a1", bs({ ahead: 2 }));
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    // The green "+2" is now interactive — clicking it lands (merges) the branch, not a rebase.
    const pill = screen.getByRole("button", { name: "+2" });
    expect(pill.title).toMatch(/merge/);
    expect(pill.title).not.toMatch(/rebase/);
  });

  it("clicking the green pill invokes the land flow (not a rebase)", () => {
    seedBranch("a1", bs({ ahead: 2 }));
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    fireEvent.click(screen.getByRole("button", { name: "+2" }));
    expect(landAgentBranch).toHaveBeenCalledTimes(1);
    expect(refreshAgentBranch).not.toHaveBeenCalled();
  });

  it("clicking the red pill invokes the rebase flow (not a land)", () => {
    seedBranch("a1", bs({ behind: 3 }));
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    fireEvent.click(screen.getByRole("button", { name: "-3" }));
    expect(refreshAgentBranch).toHaveBeenCalledTimes(1);
    expect(landAgentBranch).not.toHaveBeenCalled();
  });
});

describe("AgentRow — clickable path", () => {
  it("clicking the expanded path reveals the worktree folder in Finder", () => {
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    // Path only shows in the hover-expanded overlay.
    fireEvent.mouseOver(screen.getByText(MEDIUM));
    fireEvent.click(screen.getByText("/tmp/demo/.worktrees/a1"));
    expect(revealItemInDir).toHaveBeenCalledWith("/tmp/demo/.worktrees/a1");
  });
});
