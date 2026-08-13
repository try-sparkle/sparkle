// @vitest-environment jsdom
//
// CSS CONTAINMENT ON AGENT ROWS — the renderer half of the 2026-08-12 ~2-minute freeze.
//
// The agent column is unvirtualized, so a fleet of ~65 agents renders ~65 live rows. A `sample` of
// the WebContent process caught its main thread 30+ frames deep in nested
// RenderBlock::simplifiedLayout → RenderFlexibleBox::layoutBlock → layoutOutOfFlowBox, bottoming
// out in computePreferredLogicalWidths: every frame re-laid out the whole tree. `content-visibility:
// auto` lets the engine skip layout and paint for the rows that are off screen.
//
// What these tests guard is the GATE, not the speed. A speed assertion would be untestable in jsdom
// (which implements neither containment nor layout) and would not catch the actual regression risk,
// which is VISUAL: content-visibility implies paint containment, and paint containment clips
// descendants to the border box. The fillets — the concave arcs that shape the active row's end
// into an opening onto the terminal — deliberately paint OUTSIDE that box (`top: -ACTIVE_FILLET` /
// `bottom: -ACTIVE_FILLET` in rowAnatomy). Containing a filleted row squares that opening back off.
//
// So the invariant is exactly: A ROW RENDERS FILLETS XOR IT IS CONTAINED. Both directions matter —
// dropping the gate clips the active row's arcs, and dropping the containment brings the freeze
// back — so each is asserted against the real rendered DOM rather than against a helper.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

import { AgentSidebar } from "./AgentSidebar";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { resetCable } from "../stores/cableStore";
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
    autoNameVariants: { title: name, description: `desc ${id}` },
    shellCommand: null,
  };
}

function mkProject(agents: AgentTab[], selectedAgentId: string | null): Project {
  return {
    id: "p1",
    name: "Demo",
    rootPath: "/tmp/demo",
    defaultBranch: null,
    createdAt: new Date(0).toISOString(),
    selectedAgentId,
    agents,
  };
}

/** Does this row carry the inline containment? Read from the style ATTRIBUTE rather than from
 *  `el.style.contentVisibility`: jsdom's CSSStyleDeclaration drops properties it does not
 *  implement, and content-visibility is one of them (see docs/jsdom-test-caveats.md). The attribute
 *  is the string React actually wrote, so it survives that gap. */
function isContained(row: Element): boolean {
  const style = row.getAttribute("style") ?? "";
  return /content-visibility:\s*auto/.test(style);
}

/** A row renders fillets iff rowAnatomy mounted its arc elements inside it. */
function hasFillets(row: Element): boolean {
  return row.querySelector('[data-testid$="-top"][data-testid^="row-"]') !== null;
}

beforeEach(() => {
  useRuntimeStore.setState({ branchStatus: {}, status: {} });
  useUiStore.setState({ workModeBySide: { left: "build", right: "build" } });
  resetCable();
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  resetCable();
});

describe("AgentRow — CSS containment gate", () => {
  it("contains ordinary rows so an off-screen fleet does no layout", () => {
    render(
      <AgentSidebar
        project={mkProject([mkAgent("a1", "One"), mkAgent("a2", "Two"), mkAgent("a3", "Three")], null)}
      />,
    );

    const rows = screen.getAllByRole("treeitem");
    expect(rows.length).toBeGreaterThan(0);

    // With nothing selected no row has fillets, so EVERY row must be contained. Against the
    // pre-fix code this is 0 of N — which is the freeze.
    for (const row of rows) {
      expect(hasFillets(row)).toBe(false);
      expect(isContained(row)).toBe(true);
    }
  });

  it("reserves each skipped row's height so the scrollbar does not jump", () => {
    render(<AgentSidebar project={mkProject([mkAgent("a1", "One")], null)} />);

    // `contain-intrinsic-size` is what makes a skipped row keep its size. Without it a
    // content-visibility row collapses to zero height while off screen and the column's scroll
    // position lurches as rows enter and leave the viewport — a worse bug than the one being fixed.
    const style = screen.getAllByRole("treeitem")[0]!.getAttribute("style") ?? "";
    expect(style).toMatch(/contain-intrinsic-size:\s*auto/);
  });

  it("does NOT contain a filleted row — paint containment would clip its arcs", () => {
    render(
      <AgentSidebar project={mkProject([mkAgent("a1", "One"), mkAgent("a2", "Two")], "a1")} />,
    );

    const rows = screen.getAllByRole("treeitem");
    const filleted = rows.filter(hasFillets);

    // Guard the guard: if selection stops producing fillets this test would pass vacuously while
    // asserting nothing about clipping, so require that the case under test actually occurred.
    expect(filleted.length).toBeGreaterThan(0);

    for (const row of filleted) {
      expect(isContained(row)).toBe(false);
    }
    // …and the rest of the column is still contained, so exempting the active row did not quietly
    // disable the fix for everyone else.
    for (const row of rows.filter((r) => !hasFillets(r))) {
      expect(isContained(row)).toBe(true);
    }
  });

  it("keeps the invariant exact: a row is contained XOR it renders fillets", () => {
    render(
      <AgentSidebar
        project={mkProject([mkAgent("a1", "One"), mkAgent("a2", "Two"), mkAgent("a3", "Three")], "a2")}
      />,
    );

    for (const row of screen.getAllByRole("treeitem")) {
      expect(isContained(row)).toBe(!hasFillets(row));
    }
  });

  it("re-contains a row once it stops being the selected one", () => {
    const { rerender } = render(
      <AgentSidebar project={mkProject([mkAgent("a1", "One"), mkAgent("a2", "Two")], "a1")} />,
    );
    const firstPass = screen.getAllByRole("treeitem").filter(hasFillets);
    expect(firstPass.length).toBeGreaterThan(0);

    // Move the selection. The row that WAS exempt must go back to being contained — otherwise the
    // exemption accumulates and, over a session of clicking through the fleet, every row the user
    // has ever selected is permanently uncontained and the freeze returns gradually.
    rerender(
      <AgentSidebar project={mkProject([mkAgent("a1", "One"), mkAgent("a2", "Two")], "a2")} />,
    );

    for (const row of screen.getAllByRole("treeitem")) {
      expect(isContained(row)).toBe(!hasFillets(row));
    }
  });

  it("still contains rows while a hover card is open (the card is portalled out)", () => {
    render(<AgentSidebar project={mkProject([mkAgent("a1", "One"), mkAgent("a2", "Two")], null)} />);

    // The hover card is createPortal'd to document.body, so it is not a DOM descendant of the row
    // and this row's paint containment cannot clip it. If that ever changes, the card will start
    // being clipped to a ~32px row and this test is where the reasoning is recorded.
    fireEvent.contextMenu(screen.getByText("One"));

    for (const row of screen.getAllByRole("treeitem")) {
      expect(isContained(row)).toBe(!hasFillets(row));
    }
  });
});
