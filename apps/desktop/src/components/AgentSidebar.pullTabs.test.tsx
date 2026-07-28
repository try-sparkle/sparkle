// @vitest-environment jsdom
//
// The two right-edge PULL TABS on the Build column (PRD/feat/ui-refresh-2026-07-27-plan.md §10):
// one that RESIZES the column (reflows the layout) and one that OVERLAYS it (floats the column
// over the terminal, leaving the layout alone).
//
// WHAT THIS FILE CAN AND CANNOT PROVE. jsdom has no layout engine: every rect is zero and nothing
// is painted, so "the panel visibly covers the terminal" and "the drag feels right" are NOT
// assertable here and are not asserted. What is pinned here is everything that is a fact about the
// COMPONENT rather than about pixels — both tabs exist as named, operable controls; the overlay
// toggle is reversible and survives a remount; the column really does leave the flow
// (position:fixed pinned to the slot) and really does hand its slot to a spacer; the keyboard
// resize path clamps and persists. The layout half was verified by hand in the running app; see
// PRD/feat/sidebar-pull-tabs.md for what was observed and what was not.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

import { AgentSidebar } from "./AgentSidebar";
import { PLAN_COLUMN_Z, SIDEBAR_OVERLAY_Z } from "./layers";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, Project } from "../types";

const WIDTH_KEY = "sparkle-sidebar-width";
const OVERLAY_KEY = "sparkle-sidebar-overlay";

function mkAgent(id = "a1"): AgentTab {
  return {
    id,
    name: `Agent ${id}`,
    kind: "build",
    parentId: null,
    runtime: "local",
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

function mkProject(): Project {
  return {
    id: "p1",
    name: "Demo",
    rootPath: "/tmp/demo",
    defaultBranch: null,
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    agents: [mkAgent()],
  };
}

const resizeTab = () => screen.getByTestId("sidebar-resize-tab");
const overlayTab = () => screen.getByTestId("sidebar-overlay-tab");
const column = () => screen.getByTestId("agent-sidebar-column");

beforeEach(() => {
  localStorage.clear();
  useRuntimeStore.setState({ branchStatus: {}, status: {} });
  useUiStore.setState({ workMode: "build" });
});
afterEach(cleanup);

describe("AgentSidebar — the two pull tabs", () => {
  it("renders BOTH tabs, each with its own accessible name", () => {
    render(<AgentSidebar project={mkProject()} />);
    // Not two mystery grey strips: each says what it does, by name and by tooltip.
    expect(resizeTab().getAttribute("aria-label")).toMatch(/resize/i);
    expect(resizeTab().getAttribute("title")).toMatch(/resize/i);
    expect(overlayTab().getAttribute("aria-label")).toMatch(/pop.*out/i);
    expect(overlayTab().getAttribute("title")).toMatch(/pop.*out/i);
    // And they are distinct controls, not one element wearing two hats.
    expect(resizeTab()).not.toBe(overlayTab());
  });

  // REGRESSION (found in the browser, not here). The tab cluster is absolutely positioned ABOVE
  // the resize strip and is wider than the grip inside it, so while it accepted pointer events it
  // ate every mousedown over the grip — the one part of the resize tab a user can actually SEE was
  // the only dead spot on the whole edge. jsdom cannot hit-test, so this asserts the mechanism
  // (an inert wrapper, one interactive button) rather than the outcome.
  it("keeps the tab cluster inert so only the overlay button takes pointer events", () => {
    render(<AgentSidebar project={mkProject()} />);
    const cluster = overlayTab().parentElement!;
    expect(cluster.style.pointerEvents).toBe("none");
    expect(overlayTab().style.pointerEvents).toBe("auto");
    // The visible grip is signage for the strip behind it, never a target of its own.
    expect(screen.getByTestId("sidebar-resize-grip").style.pointerEvents).toBe("none");
  });

  it("exposes the resize tab as a real separator control, not a bare div", () => {
    render(<AgentSidebar project={mkProject()} />);
    const tab = resizeTab();
    expect(tab.getAttribute("role")).toBe("separator");
    expect(tab.getAttribute("aria-orientation")).toBe("vertical");
    expect(tab.getAttribute("tabindex")).toBe("0");
    expect(tab.getAttribute("aria-valuemin")).toBe("160");
    expect(tab.getAttribute("aria-valuemax")).toBe("480");
    expect(tab.getAttribute("aria-valuenow")).toBe("220");
  });
});

describe("AgentSidebar — keyboard resize", () => {
  it("nudges the width with the arrow keys and persists each commit", () => {
    render(<AgentSidebar project={mkProject()} />);
    fireEvent.keyDown(resizeTab(), { key: "ArrowRight" });
    expect(column().style.width).toBe("236px");
    expect(localStorage.getItem(WIDTH_KEY)).toBe("236");
    fireEvent.keyDown(resizeTab(), { key: "ArrowLeft" });
    expect(column().style.width).toBe("220px");
    expect(localStorage.getItem(WIDTH_KEY)).toBe("220");
  });

  it("jumps by a larger step with Shift held", () => {
    render(<AgentSidebar project={mkProject()} />);
    fireEvent.keyDown(resizeTab(), { key: "ArrowRight", shiftKey: true });
    expect(column().style.width).toBe("284px");
  });

  it("clamps to the same 160–480 range the drag clamps to", () => {
    render(<AgentSidebar project={mkProject()} />);
    fireEvent.keyDown(resizeTab(), { key: "End" });
    expect(column().style.width).toBe("480px");
    // Already at the ceiling — another push must not exceed it.
    fireEvent.keyDown(resizeTab(), { key: "ArrowRight" });
    expect(column().style.width).toBe("480px");
    fireEvent.keyDown(resizeTab(), { key: "Home" });
    expect(column().style.width).toBe("160px");
    fireEvent.keyDown(resizeTab(), { key: "ArrowLeft" });
    expect(column().style.width).toBe("160px");
  });

  it("restores a persisted width, and ignores a persisted value outside the clamp", () => {
    localStorage.setItem(WIDTH_KEY, "300");
    const { unmount } = render(<AgentSidebar project={mkProject()} />);
    expect(column().style.width).toBe("300px");
    unmount();

    localStorage.setItem(WIDTH_KEY, "9000");
    render(<AgentSidebar project={mkProject()} />);
    expect(column().style.width).toBe("220px");
  });

  it("leaves keys it does not own alone", () => {
    render(<AgentSidebar project={mkProject()} />);
    fireEvent.keyDown(resizeTab(), { key: "a" });
    expect(column().style.width).toBe("220px");
    expect(localStorage.getItem(WIDTH_KEY)).toBeNull();
  });
});

describe("AgentSidebar — overlay mode", () => {
  it("starts docked: in flow, no spacer, nothing floating", () => {
    render(<AgentSidebar project={mkProject()} />);
    expect(overlayTab().getAttribute("aria-pressed")).toBe("false");
    expect(column().style.position).toBe("relative");
    expect(column().dataset.overlay).toBe("false");
    expect(screen.queryByTestId("agent-sidebar-slot")).toBeNull();
  });

  it("lifts the column out of flow and hands its slot to a spacer", () => {
    localStorage.setItem(WIDTH_KEY, "300");
    render(<AgentSidebar project={mkProject()} />);
    fireEvent.click(overlayTab());

    // Absolute against the ②+③ wrapper (already `position: relative`), NOT fixed against a
    // measured rect — see the WHY NOT MEASURE note in the component.
    expect(column().style.position).toBe("absolute");
    expect(column().style.left).toBe("0px");
    expect(column().style.top).toBe("0px");
    expect(column().style.bottom).toBe("0px");
    expect(column().dataset.overlay).toBe("true");
    // The layout does NOT reflow: a spacer of the column's docked width holds the slot open, so
    // the terminal beside it never changes size (and never re-measures its PTY).
    const slot = screen.getByTestId("agent-sidebar-slot");
    expect(slot.style.width).toBe("300px");
    expect(slot.getAttribute("aria-hidden")).toBe("true");
  });

  it("sizes the panel by CSS clamp, not by a stored rect that can go stale", () => {
    // The hover card's shape — grow right, cap, floor — but resolved by the engine against the
    // wrapper's LIVE width. jsdom has no layout, so what is assertable here is the expression
    // itself; that it resolves to 480 in a real 1440px window was measured in the browser.
    localStorage.setItem(WIDTH_KEY, "200");
    render(<AgentSidebar project={mkProject()} />);
    fireEvent.click(overlayTab());
    expect(column().style.width).toBe("max(280px, min(480px, 100%))");
  });

  it("cannot trap the user: the dismiss tab survives, and it is the same tab", () => {
    render(<AgentSidebar project={mkProject()} />);
    fireEvent.click(overlayTab());
    // Still present, still a button, and now says how to get OUT rather than how to get in.
    expect(overlayTab().tagName).toBe("BUTTON");
    expect(overlayTab().getAttribute("aria-pressed")).toBe("true");
    expect(overlayTab().getAttribute("aria-label")).toMatch(/dock/i);
    // The one control that could sit over it — the resize strip — stands down while floating.
    expect(screen.queryByTestId("sidebar-resize-tab")).toBeNull();

    fireEvent.click(overlayTab());
    expect(column().style.position).toBe("relative");
    expect(screen.queryByTestId("agent-sidebar-slot")).toBeNull();
    expect(screen.getByTestId("sidebar-resize-tab")).toBeTruthy();
  });

  it("persists the choice, like the width does, so it survives a relaunch", () => {
    const { unmount } = render(<AgentSidebar project={mkProject()} />);
    fireEvent.click(overlayTab());
    expect(localStorage.getItem(OVERLAY_KEY)).toBe("1");
    unmount();

    // Fresh mount = a relaunch: the column comes back floating.
    render(<AgentSidebar project={mkProject()} />);
    expect(column().style.position).toBe("absolute");
    expect(overlayTab().getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(overlayTab());
    expect(localStorage.getItem(OVERLAY_KEY)).toBe("0");
  });

  it("stays UNDER Workspace's plan-column so Plan mode still covers it", () => {
    // Workspace lays `plan-column` (position:absolute, inset:0, zIndex 5) over columns ②+③ in Plan
    // mode. That wrapper is `position: relative` with `z-index: auto`, so it is NOT a stacking
    // context and would not contain a bigger number here: a floating column above the board would
    // paint straight through it, covering the PlanBuildToggle that is the way back to Build.
    //
    // Both numbers are read from the ONE module both sides import. A hand-copied `5` here would
    // keep passing after someone changed the board's layer and would let the bug back in silently.
    expect(SIDEBAR_OVERLAY_Z).toBeLessThan(PLAN_COLUMN_Z);
    // It must still beat the terminal stage, a `z-index: auto` sibling later in DOM order.
    expect(SIDEBAR_OVERLAY_Z).toBeGreaterThan(0);
    // ...and both must stay inside the window layers.ts documents: above the stage's own overlays
    // (PinnedPrompt / drop overlay 20, pane kebab 19-21) and clear of the 38-45 band, where
    // SettingsDialog's backdrop (40/41) and OpenPrMenu's click-away backdrop (40/41/42) live as
    // root-level `position: fixed` elements. PLAN_COLUMN_Z sat at exactly 40 for one commit and
    // won the tie on DOM order, so a Plan-mode click stopped dismissing the open PR menu.
    for (const z of [SIDEBAR_OVERLAY_Z, PLAN_COLUMN_Z]) {
      expect(z).toBeGreaterThan(21);
      expect(z).toBeLessThan(38);
    }
    // ...and the column must actually render at that shared layer, not a number of its own.
    render(<AgentSidebar project={mkProject()} />);
    fireEvent.click(overlayTab());
    expect(Number(column().style.zIndex)).toBe(SIDEBAR_OVERLAY_Z);
  });
});
