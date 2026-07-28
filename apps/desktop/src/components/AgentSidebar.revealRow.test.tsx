// @vitest-environment jsdom
//
// §13, sidebar half: the row named by uiStore.revealAgentId scrolls itself into view (the house
// `scrollIntoView({ block: "nearest" })` pattern, see PinnedPrompt.tsx) and then CLEARS the
// request, so it is one-shot. Only the named row reacts — every other row leaves the column where
// the user put it.
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
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import type { Project, AgentTab } from "../types";

function mkAgent(id: string, name: string): AgentTab {
  return {
    id,
    name,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: `/tmp/demo/.worktrees/${id}`,
    branch: `sparkle/agent-${id}`,
    baseBranch: "main",
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: { title: name, description: "" },
    shellCommand: null,
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

// jsdom has no layout, so it does not implement scrollIntoView at all — install a spy that records
// BOTH the element it was called on and the options. (That absence is exactly why the production
// code calls it optionally.)
let scrolled: { el: Element; opts: unknown }[];

beforeEach(() => {
  useRuntimeStore.setState({ branchStatus: {}, status: {} });
  useUiStore.setState({ workMode: "build", revealAgentId: null });
  scrolled = [];
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: function (this: Element, opts: unknown) {
      scrolled.push({ el: this, opts });
    },
  });
});
afterEach(() => {
  cleanup();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("AgentRow — reveal-on-request", () => {
  it("scrolls the requested row into view and clears the one-shot request", () => {
    useUiStore.setState({ revealAgentId: "a2" });
    render(<AgentSidebar project={mkProject([mkAgent("a1", "First"), mkAgent("a2", "Second")])} />);

    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]!.opts).toEqual({ block: "nearest" });
    // The REQUESTED row is the one that scrolled, not just any row.
    expect(scrolled[0]!.el).toBe(screen.getByText("Second").closest('[data-hint="agent"]'));
    // One-shot: consumed, so a later remount can't yank the column again.
    expect(useUiStore.getState().revealAgentId).toBeNull();
  });

  it("does nothing when no reveal is pending", () => {
    render(<AgentSidebar project={mkProject([mkAgent("a1", "First"), mkAgent("a2", "Second")])} />);
    expect(scrolled).toHaveLength(0);
  });

  it("ignores a request that names an agent this list doesn't have", () => {
    useUiStore.setState({ revealAgentId: "ghost" });
    render(<AgentSidebar project={mkProject([mkAgent("a1", "First")])} />);
    expect(scrolled).toHaveLength(0);
    // Left pending: the row may simply not have mounted yet (a filtered band, a collapsed parent).
    expect(useUiStore.getState().revealAgentId).toBe("ghost");
  });
});
