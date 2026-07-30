// @vitest-environment jsdom
//
// ONE PULL TAB on the Build column's pane-side boundary, carrying BOTH gestures: a dot zone that
// RESIZES (reflows the layout) and a chevron zone that OVERLAYS (floats the column over the
// terminal, leaving the layout alone).
//
// This file used to target three separate controls — a full-height 6px `col-resize` strip, a grey
// grip floating at mid-height as its only signage, and a `»` chevron button below that grip. All
// three are gone: the founder called the mid-height pair redundant now that the hover affordance
// lives at the TOP of a boundary, and the strip had no visible existence without the grip. The
// component that replaces them is `ColumnPullTab`, which the concierge seam has used since it
// shipped and whose own header has described this exact handoff as pending.
//
// The CAPABILITIES are unchanged and are what these assert — resize by drag, resize by arrows,
// clamp, persist, overlay out and back. Only the controls carrying them moved.
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

// Per SIDE now: two mounted sidebars must not race on one value. The default fixture is the
// right pair.
const WIDTH_KEY = "sparkle-sidebar-width:right";
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

// The tab is hover-revealed, so anything that operates it crosses the rail first — exactly as a
// pointer does. `dots` is the resize zone, `chevron` the overlay zone.
const rail = () => screen.getByTestId("sidebar-pull-tab");
const resizeTab = () => screen.getByTestId("sidebar-pull-tab-dots");
const overlayTab = () => screen.getByTestId("sidebar-pull-tab-chevron");
const column = () => screen.getByTestId("agent-sidebar-column");

beforeEach(() => {
  localStorage.clear();
  useRuntimeStore.setState({ branchStatus: {}, status: {} });
  // pairAssignment is reset too: the mirror cases below assign this project to the LEFT pair, and
  // the pair's side decides which edge the tab sits on AND which way its arrows grow. Without this
  // the clamp cases inherit a left pair and drive the width the wrong way — passing or failing on
  // test ORDER, which is exactly the class of leak `resetCable` was added elsewhere for.
  useUiStore.setState({ workModeBySide: { left: "build", right: "build" }, pairAssignment: {}, leftProjectId: null } as never);
});
afterEach(cleanup);

describe("AgentSidebar — the two pull tabs", () => {
  it("renders BOTH zones as distinct, named controls on ONE tab", () => {
    render(<AgentSidebar project={mkProject()} />);
    // Not two mystery grey marks: each zone says what it does, by name and by tooltip.
    expect(resizeTab().getAttribute("aria-label")).toMatch(/resize/i);
    expect(resizeTab().getAttribute("title")).toMatch(/resize/i);
    expect(overlayTab().getAttribute("aria-label")).toMatch(/pull.*out|overlay/i);
    expect(overlayTab().getAttribute("title")).toMatch(/overlay/i);
    // Two zones, one tab — distinct controls, not one element wearing two hats.
    expect(resizeTab()).not.toBe(overlayTab());
  });

  it("is HIDDEN at rest and revealed by hovering the boundary", () => {
    // The whole point of the replacement: the shell's most prominent seam carries no permanent
    // grey furniture. The controls this replaced were painted at rest, which is what the founder
    // called janky.
    render(<AgentSidebar project={mkProject()} />);
    const tab = screen.getByTestId("sidebar-pull-tab-tab");
    expect(tab.style.opacity).toBe("0");
    fireEvent.mouseEnter(rail());
    expect(tab.style.opacity).toBe("1");
    fireEvent.mouseLeave(rail());
    expect(tab.style.opacity).toBe("0");
  });

  it("never lets a hidden tab swallow a click aimed at a row", () => {
    // The zone straddles the seam and overhangs ~15px INTO this column, right over the agent rows.
    // An always-live rectangle there eats presses on a row's edge — so the zone is never
    // pointer-active, and the tab takes events only while it is actually visible under the cursor.
    render(<AgentSidebar project={mkProject()} />);
    const zone = screen.getByTestId("sidebar-pull-tab-zone");
    const tab = screen.getByTestId("sidebar-pull-tab-tab");
    expect(zone.style.pointerEvents).toBe("none");
    expect(tab.style.pointerEvents).toBe("none");
    fireEvent.mouseEnter(rail());
    expect(zone.style.pointerEvents).toBe("none");
    expect(tab.style.pointerEvents).toBe("auto");
  });

  it("mirrors the arrow with the pair, so it points at the pane it will cover", () => {
    // ASSERTED AGAINST THE ACTUAL GLYPH, not against "the two renders differ". Inequality passes
    // just as happily against an INVERTED mirror — arrow pointing away from the pane in BOTH pairs,
    // which is the precise defect this exists to prevent (roborev 55337). Feather's chevrons are
    // polylines, so the points attribute is the direction.
    const points = () =>
      overlayTab().querySelector("polyline")?.getAttribute("points") ?? "";

    // Right pair: the terminal is to the row's RIGHT, so the arrow points right.
    render(<AgentSidebar project={mkProject()} />);
    expect(points()).toBe("9 18 15 12 9 6");
    cleanup();

    // Left pair: the terminal is to the row's LEFT, so it points left.
    useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
    render(<AgentSidebar project={mkProject()} />);
    expect(points()).toBe("15 18 9 12 15 6");
  });

  it("anchors the OVERLAY on the pair's own side, not always the left", () => {
    // The mirror has to reach the geometry the arrow triggers. `left: 0` was right only for the
    // right pair; a left pair lays its columns out row-reverse, so the build column sits at the
    // RIGHT of the wrapper and `left: 0` threw the floating panel across the terminal — hundreds of
    // pixels from the spacer holding its slot, with its dock tab going along.
    useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
    render(<AgentSidebar project={mkProject()} />);
    fireEvent.click(overlayTab());
    expect(column().style.right).toBe("0px");
    expect(column().style.left).toBe("");
  });

});

describe("AgentSidebar — keyboard resize", () => {
  // The steps are `ColumnPullTab`'s (8, and 32 with Shift), not the deleted strip's 16/64. Home/End
  // went with the strip: the component does not implement them, and inventing them here would pin
  // a capability the control does not have.
  it("nudges the width with the arrow keys", () => {
    render(<AgentSidebar project={mkProject()} />);
    fireEvent.keyDown(resizeTab(), { key: "ArrowRight" });
    expect(column().style.width).toBe("228px");
    fireEvent.keyDown(resizeTab(), { key: "ArrowLeft" });
    expect(column().style.width).toBe("220px");
  });

  // PERSISTED ON A TRAILING TIMER, not per commit. `ColumnPullTab.commit` fires on every mousemove
  // of a drag, so a write per commit meant a synchronous disk-backed `setItem` per pointer event —
  // the defect the concierge seam had already been fixed for. The debounce has to FLUSH, or it is a
  // way to lose a width rather than a way to write it less often.
  it("persists the width once the change settles", async () => {
    const { unmount } = render(<AgentSidebar project={mkProject()} />);
    fireEvent.keyDown(resizeTab(), { key: "ArrowRight" });
    await new Promise((r) => setTimeout(r, 260));
    expect(localStorage.getItem(WIDTH_KEY)).toBe("228");
    unmount();
  });

  it("does NOT lose the width when the tree tears down inside the debounce window", () => {
    const { unmount } = render(<AgentSidebar project={mkProject()} />);
    fireEvent.keyDown(resizeTab(), { key: "ArrowRight" });
    unmount();
    expect(localStorage.getItem(WIDTH_KEY)).toBe("228");
  });

  // THE INVARIANT THE DIRTY GATE EXISTS FOR, which had NO assertion: every width test resized
  // first, so all of them exercised only the dirty path and deleting both `if (!widthDirty.current)
  // return;` lines left the suite green (roborev 55391). The key is per-side now, so two instances
  // cannot race at all — but an instance that never resized must still not write, because that is
  // what makes a flush safe to register on every mount.
  it("an instance that never resized writes NOTHING, on unmount or on shutdown", () => {
    localStorage.setItem(WIDTH_KEY, "300");
    const { unmount } = render(<AgentSidebar project={mkProject()} />);
    // Hover and focus the seam, but never commit a width — the reveal is not a resize.
    fireEvent.mouseEnter(rail());
    window.dispatchEvent(new Event("pagehide"));
    expect(localStorage.getItem(WIDTH_KEY)).toBe("300");
    unmount();
    expect(localStorage.getItem(WIDTH_KEY)).toBe("300");
  });

  it("a keypress that moves NOTHING does not make the instance dirty", () => {
    // `ColumnPullTab.commit` fires `onWidth(applied)` unconditionally, so a press pinned at a bound
    // used to mark the instance dirty while the width never moved — enough for its flush to speak
    // for a column the user never touched.
    localStorage.setItem(WIDTH_KEY, "160");
    const { unmount } = render(<AgentSidebar project={mkProject()} />);
    expect(column().style.width).toBe("160px");
    fireEvent.keyDown(resizeTab(), { key: "ArrowLeft" }); // already at MIN_WIDTH
    localStorage.setItem(WIDTH_KEY, "999");
    unmount();
    expect(localStorage.getItem(WIDTH_KEY)).toBe("999");
  });

  it("jumps by a larger step with Shift held", () => {
    render(<AgentSidebar project={mkProject()} />);
    fireEvent.keyDown(resizeTab(), { key: "ArrowRight", shiftKey: true });
    expect(column().style.width).toBe("252px");
  });

  it("MIRRORS the arrow direction with the pair", () => {
    // In a LEFT pair the column sits to the RIGHT of its boundary, so ← must GROW it. An unmirrored
    // handler would shrink the column the user is trying to widen — the same defect class as the
    // unmirrored row box, arriving through the keyboard.
    useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
    render(<AgentSidebar project={mkProject()} />);
    fireEvent.keyDown(resizeTab(), { key: "ArrowLeft" });
    expect(column().style.width).toBe("228px");
    fireEvent.keyDown(resizeTab(), { key: "ArrowRight" });
    expect(column().style.width).toBe("220px");
  });

  it("clamps to the same 160-480 range the drag clamps to", () => {
    render(<AgentSidebar project={mkProject()} />);
    for (let i = 0; i < 40; i++) fireEvent.keyDown(resizeTab(), { key: "ArrowRight", shiftKey: true });
    expect(column().style.width).toBe("480px");
    // Already at the ceiling — another push must not exceed it.
    fireEvent.keyDown(resizeTab(), { key: "ArrowRight" });
    expect(column().style.width).toBe("480px");
    for (let i = 0; i < 40; i++) fireEvent.keyDown(resizeTab(), { key: "ArrowLeft", shiftKey: true });
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

  // THE EMPTY LEFT COLUMN, which the per-side key did not actually cover.
  //
  // The side came from the PROJECT's assignment, and the left stage renders `project={null}` whenever
  // its tab is closed — with no early return, so the pull tab still renders. `sideOf(assignment, "")`
  // answers "right", so that empty column seeded from the RIGHT column's width and, once dragged,
  // wrote over it: the cross-column clobber the per-side key was introduced to remove, one case
  // further out (roborev 55490). Every other width row here renders a project-bearing sidebar, so
  // nothing reached it.
  //
  // Asserted on BOTH halves — the seed it reads and the value it writes — because either alone leaves
  // the other direction of the clobber open.
  it("an EMPTY left column neither seeds from nor writes the right column's key", async () => {
    localStorage.setItem(WIDTH_KEY, "300");
    render(<AgentSidebar project={null} slotSide="left" />);
    // Did not seed from the right column's 300: it is at the default.
    expect(column().style.width).toBe("220px");

    fireEvent.keyDown(resizeTab(), { key: "ArrowLeft" }); // ← GROWS a left-pair column
    await new Promise((r) => setTimeout(r, 260));
    expect(localStorage.getItem(WIDTH_KEY)).toBe("300");
    expect(localStorage.getItem("sparkle-sidebar-width:left")).toBe("228");
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
    // The resize half stands down while floating — the panel's width comes from the viewport, so a
    // drag would move a boundary the user cannot see. The dot zone becomes a "dock me" button
    // instead of disappearing, which is the founder's round trip.
    expect(resizeTab().getAttribute("role")).toBe("button");
    expect(resizeTab().getAttribute("aria-label")).toMatch(/dock/i);

    fireEvent.click(overlayTab());
    expect(column().style.position).toBe("relative");
    expect(screen.queryByTestId("agent-sidebar-slot")).toBeNull();
    // Docked again, the dots are a separator that reports the width they move.
    expect(resizeTab().getAttribute("role")).toBe("separator");
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
    // Workspace renders `plan-column` inside a pair's TERMINAL stage — it fills that column's
    // terminal slot rather than covering both columns. Neither the ②+③ wrapper nor the stage is a
    // stacking context, so these two numbers compete directly and the order is the whole contract.
    //
    // THE FLOATED COLUMN WINS. It used to be the board, back when the board covered the Build
    // column and carried the only PlanBuildToggle; losing that toggle behind a floated sidebar was
    // the bug the old ordering prevented. The board no longer takes the sidebar's header away, so
    // floating the Build column over the terminal — an explicit user gesture — must show that
    // column, whether the terminal slot currently holds a terminal or a board.
    //
    // Both numbers are read from the ONE module both sides import. A hand-copied literal here would
    // keep passing after someone changed the board's layer and would let the bug back in silently.
    expect(PLAN_COLUMN_Z).toBeLessThan(SIDEBAR_OVERLAY_Z);
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
