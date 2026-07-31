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
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    expect(column().dataset.width).toBe("228");
    fireEvent.keyDown(resizeTab(), { key: "ArrowLeft" });
    expect(column().dataset.width).toBe("220");
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
    expect(column().dataset.width).toBe("160");
    fireEvent.keyDown(resizeTab(), { key: "ArrowLeft" }); // already at MIN_WIDTH
    localStorage.setItem(WIDTH_KEY, "999");
    unmount();
    expect(localStorage.getItem(WIDTH_KEY)).toBe("999");
  });

  it("jumps by a larger step with Shift held", () => {
    render(<AgentSidebar project={mkProject()} />);
    fireEvent.keyDown(resizeTab(), { key: "ArrowRight", shiftKey: true });
    expect(column().dataset.width).toBe("252");
  });

  it("MIRRORS the arrow direction with the pair", () => {
    // In a LEFT pair the column sits to the RIGHT of its boundary, so ← must GROW it. An unmirrored
    // handler would shrink the column the user is trying to widen — the same defect class as the
    // unmirrored row box, arriving through the keyboard.
    useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
    render(<AgentSidebar project={mkProject()} />);
    fireEvent.keyDown(resizeTab(), { key: "ArrowLeft" });
    expect(column().dataset.width).toBe("228");
    fireEvent.keyDown(resizeTab(), { key: "ArrowRight" });
    expect(column().dataset.width).toBe("220");
  });

  // THE CEILING IS WINDOW-RELATIVE NOW, so a row asserting an absolute one has to say which window it
  // is on. jsdom defaults to 1024px, where the real ceiling is 424 — and that is CORRECT, not a test
  // artifact: 424 + concierge 280 + terminal 320 exactly fills 1024. The old fixed 480 never fit there
  // at all, which is the lockout roborev 55847 named. 2000px is a real external display.
  const withWindow = (px: number, run: () => void) => {
    const real = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: px, configurable: true });
    try {
      run();
    } finally {
      Object.defineProperty(window, "innerWidth", { value: real, configurable: true });
    }
  };

  it("clamps to the same 160-1200 range the drag clamps to, on a window that can afford it", () => {
    withWindow(2000, () => {
      render(<AgentSidebar project={mkProject()} />);
      // 160 → 1200 is 1040px, and a Shift step is 40px, so 40 presses no longer reach the ceiling.
      for (let i = 0; i < 60; i++) fireEvent.keyDown(resizeTab(), { key: "ArrowRight", shiftKey: true });
      expect(column().dataset.width).toBe("1200");
      // Already at the ceiling — another push must not exceed it.
      fireEvent.keyDown(resizeTab(), { key: "ArrowRight" });
      expect(column().dataset.width).toBe("1200");
      for (let i = 0; i < 60; i++) fireEvent.keyDown(resizeTab(), { key: "ArrowLeft", shiftKey: true });
      expect(column().dataset.width).toBe("160");
      fireEvent.keyDown(resizeTab(), { key: "ArrowLeft" });
      expect(column().dataset.width).toBe("160");
    });
  });

  // THE OTHER HALF OF THE SAME RULE, and the one that keeps the raised ceiling from re-opening the
  // lockout it was supposed to prevent: this column's pull tab is absolutely positioned at its
  // pair-side edge, so a width the window cannot show puts the handle past the viewport with
  // `overflow: hidden` and no way back except editing localStorage (roborev 55847).
  // THE THIRD SEAM'S COPY OF THE STORED-vs-PAINTED ROW (roborev 55993). The shell mounts
  // `ColumnPullTab` three times; the concierge's and the left pair's each got this row, and this one
  // is the same defect on the same component. The divergence is NOT reachable by seeding localStorage
  // — the mount-time seed validates against `MAX_WIDTH` and rejects an over-wide stored value — so it
  // has to be built the way a user reaches it: set a width on a big window, then shrink the window.
  it("keeps the stored width but resizes from the PAINTED one after the window shrinks", () => {
    const real = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 2000, configurable: true });
    try {
      render(<AgentSidebar project={mkProject()} />);
      for (let i = 0; i < 60; i++) fireEvent.keyDown(resizeTab(), { key: "ArrowRight", shiftKey: true });
      expect(column().dataset.width).toBe("1200");

      act(() => {
        Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
        window.dispatchEvent(new Event("resize"));
      });

      // THE PREFERENCE SURVIVES. `data-width` and `RENDERED_WIDTH` still carry the raw 1200, so
      // re-docking to a display that can afford it gives the user their width back.
      expect(column().dataset.width).toBe("1200");

      // …and the seam now resizes from what is PAINTED. At 1000 the ceiling is
      // `1000 - (280 concierge + 320 terminal) = 400`, so one 8px step inward lands on 392.
      fireEvent.keyDown(resizeTab(), { key: "ArrowLeft" });
      // Against the raw 1200, `clampWidth(1192, 160, 400)` pins to 400: the seam is dead for 800px of
      // travel and the stored 1200 is destroyed by the first keypress.
      expect(column().dataset.width).toBe("392");
    } finally {
      Object.defineProperty(window, "innerWidth", { value: real, configurable: true });
    }
  });

  it("lowers that ceiling on a narrow window instead of putting its own handle off-screen", () => {
    withWindow(900, () => {
      render(<AgentSidebar project={mkProject()} />);
      for (let i = 0; i < 60; i++) fireEvent.keyDown(resizeTab(), { key: "ArrowRight", shiftKey: true });
      const w = Number(column().dataset.width);
      // Concierge at its 280 minimum plus a 320 terminal must still fit beside it.
      expect(w).toBeLessThanOrEqual(900 - 600);
      expect(w).toBeGreaterThanOrEqual(160);
    });
  });

  // THE WALL THE FOUNDER HIT, named as its own row: "I'm still blocked as to max width that I can make
  // the builder columns." The ceiling was a bare `MAX_WIDTH = 480` constant, NOT a failed negotiation
  // with the neighbour — the terminal beside this column is `flex: 1` against effectively no
  // min-content, so it already yields space freely. Nothing was refusing to give; the clamp stopped
  // asking. 480 also predates the five-column cockpit, where this is one of TWO builder columns.
  //
  // Asserted as "gets PAST the old wall" rather than "equals the new constant", so the row keeps
  // meaning something if the ceiling is tuned again — and it fails against today's code, where 500 is
  // unreachable by construction.
  // THE CLAMP ITSELF, asserted — because the previous pass moved every width read onto `dataset.width`
  // (the raw state) and left the actual fix, the docked column's CSS clamp, asserted NOWHERE. Reverting
  // `width: RENDERED_WIDTH` to `width` kept the whole suite green, which is the vacuous shape that let
  // the earlier High ship in the first place (roborev 55883).
  it("bounds the PAINTED width against its own container, with a floor and a ceiling", () => {
    render(<AgentSidebar project={mkProject()} />);
    const w = column().style.width;
    // The ceiling: never wider than the container minus a terminal worth keeping.
    expect(w).toContain("calc(100% -");
    // The FLOOR, which the first version dropped — without it the expression goes negative on a narrow
    // container and the column paints at 0px.
    expect(w).toContain("max(");
    expect(w).toContain("160px");
    // And it is a container-relative expression, not the frozen pixel value from state.
    expect(w).not.toBe(`${column().dataset.width}px`);
  });

  it("widens PAST the old 480 wall, which is what the founder could not do", () => {
    // On a window with room for it — which is the founder's case, and the case the fixed 480 blocked
    // regardless of how much room there was. Narrow windows are the row above.
    withWindow(2000, () => {
      render(<AgentSidebar project={mkProject()} />);
      for (let i = 0; i < 12; i++) fireEvent.keyDown(resizeTab(), { key: "ArrowRight", shiftKey: true });
      expect(Number(column().dataset.width)).toBeGreaterThan(480);
    });
  });

  it("restores a persisted width, and ignores a persisted value outside the clamp", () => {
    localStorage.setItem(WIDTH_KEY, "300");
    const { unmount } = render(<AgentSidebar project={mkProject()} />);
    expect(column().dataset.width).toBe("300");
    unmount();

    localStorage.setItem(WIDTH_KEY, "9000");
    render(<AgentSidebar project={mkProject()} />);
    expect(column().dataset.width).toBe("220");
  });

  it("leaves keys it does not own alone", () => {
    render(<AgentSidebar project={mkProject()} />);
    fireEvent.keyDown(resizeTab(), { key: "a" });
    expect(column().dataset.width).toBe("220");
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
    expect(column().dataset.width).toBe("220");

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
    // The docked width, still CSS-clamped against the container the same way the column is (jsdom
    // serializes `min()` with its own spacing, so match the parts rather than the exact string).
    expect(slot.style.width).toContain("300px");
    expect(slot.style.width).toContain("calc(100% -");
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

// ── THE BUILD COLUMN ANNOUNCES ITS WIDTH TO THE ROW ───────────────────────────────────────────
//
// The concierge's paired ceiling reserves both build columns AT THE WIDTHS THEY ACTUALLY HAVE, and
// `Workspace` learns those widths from this event. Emitting it only on COMMIT left the two diverging
// whenever a sidebar mounted later than the shell at a different window width — the row would then
// permit a concierge that squeezes a builder the user had deliberately widened, while the drag
// reported itself unclamped (roborev 56086/56088).
describe("the build column tells the row how wide it is", () => {
  function heard(run: () => void) {
    const seen: { side?: string; width?: number }[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("sparkle:build-width", on);
    try {
      run();
    } finally {
      window.removeEventListener("sparkle:build-width", on);
    }
    return seen;
  }

  it("announces ON MOUNT, before any drag has happened", () => {
    // The case that was missing entirely: a column the user has never touched still occupies width,
    // so the row has to know about it.
    //
    // AT A WINDOW THAT CAN ACTUALLY HOLD 800. jsdom defaults to 1024, where the build column's
    // ceiling is 424 and a stored 800 is correctly REJECTED — so this would have been measuring the
    // restore clamp rather than the announcement.
    const realWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 2560, configurable: true });
    try {
      localStorage.setItem(WIDTH_KEY, "800");
      const seen = heard(() => render(<AgentSidebar project={mkProject()} />));
      expect(seen).toContainEqual({ side: "right", width: 800 });
    } finally {
      Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
    }
  });

  it("announces the width it RESTORED, not a default", () => {
    localStorage.setItem(WIDTH_KEY, "420");
    const seen = heard(() => render(<AgentSidebar project={mkProject()} />));
    expect(seen.at(-1)).toEqual({ side: "right", width: 420 });
  });

  it("announces again when the width changes", () => {
    render(<AgentSidebar project={mkProject()} />);
    const seen = heard(() => {
      fireEvent.pointerDown(screen.getByTestId("sidebar-pull-tab-dots"), {
        pointerId: 1,
        button: 0,
        clientX: 500,
        buttons: 1,
      });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 560, buttons: 1 });
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 560 });
    });
    expect(seen.at(-1)?.width).toBe(280); // 220 + 60
  });
});
