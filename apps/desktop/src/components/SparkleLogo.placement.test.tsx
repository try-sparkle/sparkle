// @vitest-environment jsdom
//
// WHERE the Sparkle.ai logo lives, asserted from both ends.
//
// It used to sit in column two (the builder sidebar) and now tops column one (the persistent
// concierge). A move like this is exactly the kind of change that half-lands: the new copy gets
// added and the old one is never deleted, so the mark renders twice in one shell and nobody
// notices until a screenshot. So this file asserts the ABSENCE in the sidebar as hard as the
// presence in the concierge column, and pins the accessibility contract that made it an anchor in
// the first place — a bare clickable <img> is unreachable by keyboard and announced as an image,
// not a link.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

import { AgentSidebar } from "./AgentSidebar";
import { ConciergeColumn } from "./Concierge";
import type { ConciergeController, ConciergeViewModel } from "./Concierge";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, Project } from "../types";

const AGENT_NAME = "Builder";

function mkProject(): Project {
  const agent: AgentTab = {
    id: "a1",
    name: AGENT_NAME,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: "/tmp/demo/.worktrees/a1",
    branch: "sparkle/agent-a1",
    baseBranch: "main",
    lastPrompt: "",
    promptHistory: [],
    namePinned: true,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
  };
  return {
    id: "p1",
    name: "Demo",
    rootPath: "/tmp/demo",
    defaultBranch: "main",
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    agents: [agent],
  };
}

const model: ConciergeViewModel = {
  scope: {},
  vitals: { needs_you: 0, running: 0, done: 0 },
  spend: { amountText: "$4.12" },
  messages: [],
};

function controller(): ConciergeController {
  return {
    onSend: vi.fn(),
    onMicToggle: vi.fn(),
    onAttach: vi.fn(),
    onNudgeClick: vi.fn(),
    onNudgeAction: vi.fn(),
  };
}

beforeEach(() => {
  useRuntimeStore.setState({ branchStatus: {}, status: {} });
  // Build mode, so the build agent under test is actually listed (Think/Plan would filter it out).
  useUiStore.setState({ workMode: "build" });
});
afterEach(cleanup);

describe("the Sparkle.ai logo lives in column one, the concierge", () => {
  it("renders the mark in the concierge column header", () => {
    render(<ConciergeColumn model={model} controller={controller()} />);
    const logo = screen.getByAltText("Sparkle") as HTMLImageElement;
    expect(logo.getAttribute("src")).toBe("/sparkle-logo.svg");
  });

  it("keeps it a focusable LINK to sparkle.ai, not a bare clickable image", () => {
    render(<ConciergeColumn model={model} controller={controller()} />);
    // getByRole("link") only matches an <a href> — an <img> with an onClick would fail here, which
    // is the whole point of the assertion.
    const link = screen.getByRole("link", { name: "Sparkle" });
    expect(link.getAttribute("href")).toBe("https://sparkle.ai");
    expect(link.contains(screen.getByAltText("Sparkle"))).toBe(true);
  });

  it("renders the brand name exactly ONCE — the mark replaced the styled wordmark text", () => {
    render(<ConciergeColumn model={model} controller={controller()} />);
    // The star field used to draw the literal word "Sparkle" as text. The logo IS that word, so a
    // stray text node here would mean the column prints the brand name twice, stacked.
    expect(screen.queryByText("Sparkle")).toBeNull();
    expect(screen.getAllByAltText("Sparkle")).toHaveLength(1);
  });

  it("does NOT render it in the builder sidebar any more", () => {
    render(<AgentSidebar project={mkProject()} />);
    expect(screen.queryByAltText("Sparkle")).toBeNull();
    expect(screen.queryByRole("link", { name: "Sparkle" })).toBeNull();
    // The header row itself is still there — the row survived the move, only the logo left.
    expect(screen.getByTestId("sidebar-header")).toBeTruthy();
    // …and so did the rest of the sidebar.
    expect(screen.getByText(AGENT_NAME)).toBeTruthy();
  });
});
