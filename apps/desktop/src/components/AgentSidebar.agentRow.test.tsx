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

// Both collapsed and hover render the same TITLE; the one-sentence DESCRIPTION (and the
// Location/Status/Progress detail lines) appear ONLY in the hover overlay. Tests use the
// overlay-only path/description as the "is the slide-out open?" marker.
const TITLE = "Agent Name";
const DESCRIPTION = "Refines the agent sidebar hover card";

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
    autoNameVariants: { title: TITLE, description: DESCRIPTION },
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

    // Hover the collapsed row → the slide-out overlay mounts and reveals the Location line (an
    // overlay-only element). (mouseOver is how React's onMouseEnter is triggered in jsdom.)
    fireEvent.mouseOver(screen.getByText(TITLE));
    expect(screen.getByText("/tmp/demo/.worktrees/a1")).toBeTruthy();

    // Double-click the overlay's title to rename → the overlay is suppressed and the in-flow row
    // owns the ONE input. The title text disappears (input stands in for it). After hover the title
    // exists twice (hidden in-flow + overlay); the overlay copy is the last one.
    const titles = screen.getAllByText(TITLE);
    fireEvent.doubleClick(titles[titles.length - 1]!);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByText(TITLE)).toBeNull();

    // Toggling hover mid-rename must NOT spawn or swap a second input.
    const row = screen.getByRole("textbox").closest("div")!;
    fireEvent.mouseOut(row);
    fireEvent.mouseOver(row);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("Escape cancels the rename without committing (no second input, edit dropped)", () => {
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    fireEvent.doubleClick(screen.getByText(TITLE));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "scratch-typing" } });
    fireEvent.keyDown(input, { key: "Escape" });
    // Edit dropped → back to the name, no lingering input.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(TITLE)).toBeTruthy();
  });
});

describe("AgentRow — Status line behind/ahead pill", () => {
  // The pill now lives on the hover card's "Status" line (not in the collapsed row), so each test
  // opens the slide-out first. mouseOver triggers React's onMouseEnter in jsdom.
  const openOverlay = () => fireEvent.mouseOver(screen.getByText(TITLE));

  it("renders the behind pill as a clickable catch-up button", () => {
    seedBranch("a1", bs({ behind: 4 }));
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openOverlay();
    const pill = screen.getByRole("button", { name: /behind main/i });
    expect(pill.textContent).toMatch(/catch up/i);
  });

  it("renders the ahead pill as a clickable land (merge) button", () => {
    seedBranch("a1", bs({ ahead: 2 }));
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openOverlay();
    const pill = screen.getByRole("button", { name: /ahead/i });
    expect(pill.textContent).toMatch(/merge/i);
    expect(pill.textContent).not.toMatch(/catch up/i);
  });

  it("clicking the green pill invokes the land flow (not a rebase)", () => {
    seedBranch("a1", bs({ ahead: 2 }));
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openOverlay();
    fireEvent.click(screen.getByRole("button", { name: /ahead/i }));
    expect(landAgentBranch).toHaveBeenCalledTimes(1);
    expect(refreshAgentBranch).not.toHaveBeenCalled();
  });

  it("clicking the red pill invokes the rebase flow (not a land)", () => {
    seedBranch("a1", bs({ behind: 3 }));
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openOverlay();
    fireEvent.click(screen.getByRole("button", { name: /behind main/i }));
    expect(refreshAgentBranch).toHaveBeenCalledTimes(1);
    expect(landAgentBranch).not.toHaveBeenCalled();
  });
});

describe("AgentRow — clickable path", () => {
  it("clicking the expanded path reveals the worktree folder in Finder", () => {
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    // Path only shows in the hover-expanded overlay.
    fireEvent.mouseOver(screen.getByText(TITLE));
    fireEvent.click(screen.getByText("/tmp/demo/.worktrees/a1"));
    expect(revealItemInDir).toHaveBeenCalledWith("/tmp/demo/.worktrees/a1");
  });
});

describe("AgentRow — hover card title + description and detail lines", () => {
  it("reveals the one-sentence description on hover; collapsed shows only the title", () => {
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    // Collapsed: the title is shown, the description is NOT.
    expect(screen.getByText(TITLE)).toBeTruthy();
    expect(document.body.textContent).not.toContain(DESCRIPTION);
    // Hover → the overlay reveals "Title:  description".
    fireEvent.mouseOver(screen.getByText(TITLE));
    expect(document.body.textContent).toContain(DESCRIPTION);
  });

  it("omits the description span entirely when the description is empty", () => {
    render(<AgentSidebar project={mkProject([mkAgent({ autoNameVariants: { title: TITLE, description: "" } })])} />);
    fireEvent.mouseOver(screen.getByText(TITLE));
    expect(screen.getByText("/tmp/demo/.worktrees/a1")).toBeTruthy(); // overlay is open…
    // …but with no description there is no leading "colon-space-space" run anywhere in the card.
    expect(document.body.textContent).not.toContain(":  ");
  });

  it("Status line reads 'Up to date' when the branch is neither ahead nor behind", () => {
    seedBranch("a1", bs({ ahead: 0, behind: 0 }));
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    fireEvent.mouseOver(screen.getByText(TITLE));
    expect(document.body.textContent).toContain("Up to date with main");
  });

  it("Progress line shows percent-only (no worker count) for a leaf agent", () => {
    seedBranch("a1", bs({ behind: 1 })); // behind copy avoids the word 'worker' in the Status line
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    fireEvent.mouseOver(screen.getByText(TITLE));
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/% complete\./);
    expect(body).not.toContain("% complete overall"); // leaf → no "overall"
  });

  it("Progress line counts workers and says 'overall' for an orchestrator", () => {
    const build = mkAgent({
      id: "b1",
      name: "Orchestrator",
      kind: "build",
      autoNameVariants: { title: "Orchestrator", description: "" },
    });
    const worker = mkAgent({
      id: "w1",
      name: "Worker",
      kind: "worker",
      parentId: "b1",
      autoNameVariants: { title: "Worker", description: "" },
      worktreePath: "/tmp/demo/.worktrees/w1",
    });
    useRuntimeStore.setState({ branchStatus: { b1: bs({ behind: 1 }), w1: bs({ behind: 1 }) }, status: {} });
    render(<AgentSidebar project={mkProject([build, worker])} />);
    fireEvent.mouseOver(screen.getByText("Orchestrator"));
    expect(document.body.textContent).toMatch(/1 worker\. \d+% complete overall\./);
  });
});
