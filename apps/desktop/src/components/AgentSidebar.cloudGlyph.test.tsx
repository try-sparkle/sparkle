// @vitest-environment jsdom
//
// The cloud glyph on an agent row (Service B, spec §Creation UX: "Cloud rows get a small cloud
// glyph next to the name; no other visual difference"). Two things matter and are pinned here: a
// cloud row shows it, and a LOCAL row — every row a local-only user has — does not.
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
import type { AgentTab, Project, Runtime } from "../types";

function mkAgent(runtime: Runtime, id = "a1"): AgentTab {
  return {
    id,
    name: `Agent ${id}`,
    kind: "build",
    parentId: null,
    runtime,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: null,
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

beforeEach(() => {
  useRuntimeStore.setState({ branchStatus: {}, status: {} });
  useUiStore.setState({ workModeBySide: { left: "build", right: "build" } });
});
afterEach(cleanup);

describe("AgentSidebar — cloud glyph", () => {
  it("marks a runtime:cloud row with the cloud glyph", () => {
    render(<AgentSidebar project={mkProject([mkAgent("cloud")])} />);
    const glyphs = screen.getAllByTestId("cloud-glyph");
    expect(glyphs.length).toBeGreaterThan(0);
    expect(glyphs[0]!.getAttribute("aria-label")).toBe("Cloud agent");
    // The tooltip says what "cloud" costs the user — this glyph is the only place a row says so.
    expect(glyphs[0]!.getAttribute("title")).toMatch(/credits/i);
  });

  it("leaves a local row untouched (zero visual change for a local-only user)", () => {
    render(<AgentSidebar project={mkProject([mkAgent("local")])} />);
    expect(screen.queryByTestId("cloud-glyph")).toBeNull();
  });

  it("shows the glyph after an existing tab's runtime flips to cloud", () => {
    // The cloud create flow updates a tab by REPLACING objects in the store (mapAgent produces a
    // new project AND a new tab). This pins the user-visible outcome — a store update surfaces the
    // glyph. (It cannot isolate the comparator's `prev.a === next.a` clause: the row's memo
    // short-circuits on project identity first, and a changed tab implies a changed project.)
    const { rerender } = render(<AgentSidebar project={mkProject([mkAgent("local")])} />);
    expect(screen.queryByTestId("cloud-glyph")).toBeNull();
    rerender(<AgentSidebar project={mkProject([mkAgent("cloud")])} />);
    expect(screen.getAllByTestId("cloud-glyph").length).toBeGreaterThan(0);
  });

  it("marks only the cloud row when both runtimes are present", () => {
    render(
      <AgentSidebar project={mkProject([mkAgent("local", "a1"), mkAgent("cloud", "a2")])} />,
    );
    // Both the collapsed row and its hover-card copy render the chip for the ONE cloud agent, so
    // assert on the row that owns them rather than a raw count.
    const glyph = screen.getAllByTestId("cloud-glyph")[0]!;
    expect(glyph.closest("div")!.textContent).not.toMatch(/Agent a1/);
    expect(screen.getByText("Agent a2")).toBeTruthy();
  });
});
