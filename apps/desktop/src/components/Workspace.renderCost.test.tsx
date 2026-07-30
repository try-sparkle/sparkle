// @vitest-environment jsdom
//
// WHAT A DRAG COSTS, COUNTED — not eyeballed.
//
// The founder's ask for the column seam was not "it works", it was "I wanna make sure it's really
// smooth and able to quickly resize… make sure it's not, like, laggy and slow." `Workspace.resize`
// already pins that the width MOVES; a width that moves while sixty terminal panes re-render behind
// it is still the reported bug. So smoothness gets its own file, and it is a MEASUREMENT: mount a
// realistic pane count, drive a real multi-step drag, and bound the renders it provokes.
//
// The v0.63.0 logs are the reason the bound is a number rather than a vibe:
//
//     jank stall {"ms":4769,"rendered":"AgentPane x62, Workspace x3"}
//
// Sixty-two pane renders inside one 4.7-second stall. That is the shape this file exists to keep out
// of the drag path.
//
// WHAT THIS FILE CANNOT SEE, AND WHERE THAT LIVES INSTEAD. The bounds here are REACT work: renders
// and reconciliation. The other half of what a drag costs is the terminal fan-out — every open pane
// stays laid out at full size (paneVisibility.ts) and owns a ResizeObserver, so one layout change
// used to make all sixty run a forced layout plus an xterm reflow over an 8000-line scrollback
// (bead sparkle-atp1: 55 panes → ~27s of main-thread block per fan-out). That cost is structurally
// invisible from here for two independent reasons: `AgentPane` is stubbed below, so no xterm ever
// mounts under this shell; and jsdom has no layout engine, so the drag moves a number in a store and
// never changes an element's box — no ResizeObserver would fire even if a real pane were mounted.
// It is measured, at the same 60 panes and the same 30-step drag shape, in
// `Terminal.resizeFanout.test.tsx`, which mounts sixty real Terminals and fires the observers
// directly. Do not try to fold that measurement in here; it would have to fake the very signal it
// claims to observe.
//
// HOW THE PANE COUNT IS HONEST. The stub below is wrapped in `memo(..., arePanePropsEqual)` — the
// REAL comparator, imported from its own leaf module. So a counted render means Workspace handed the
// pane props the real predicate calls different, which is exactly what makes the real pane re-render.
// A bare stub (what every other Workspace suite mocks in) would count nothing and pass forever.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => Promise.resolve(() => {}),
    setTitle: () => Promise.resolve(),
  }),
  getAllWindows: () => Promise.resolve([{}]),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../windowContext", async () => {
  const { useProjectStore } = await import("../stores/projectStore");
  return {
    useCurrentProjectId: () => useProjectStore((s) => s.selectedProjectId),
    useIsMainWindow: () => false,
    useCurrentWindowLabel: () => "main",
  };
});
vi.mock("../services/orchestrationListener", () => ({
  startOrchestrationListener: () => Promise.resolve(() => {}),
}));
vi.mock("../services/controlListener", () => ({
  startControlListener: () => Promise.resolve(() => {}),
}));
vi.mock("../services/crossWindowSync", () => ({ subscribeToCrossWindowSync: () => () => {} }));
vi.mock("../services/cloudAgents/startup", () => ({
  reattachProjectOnOpen: async () => [] as string[],
}));
// Spread the original: this module gained `SPARKLE_AGENT_ID` on main, and a wholesale stub silently
// drops exports added later, so the shell fails to COLLECT for a reason unrelated to the test.
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
  sparkleAgentIdFor: () => "sparkle",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));

// ── THE COUNTERS ───────────────────────────────────────────────────────────────────────────────
// Module-level so the mock factories (hoisted above the imports) can reach them. `vi.hoisted` is
// what makes that legal — a plain `const` here is still in the temporal dead zone when the factory
// body is evaluated.
// `compare` is the one that can see the WRAPPER. `pane` counts the memoized LEAF, which bails out —
// so it reported "ZERO pane renders" while the fibers ABOVE that leaf (PaneHost, Suspense,
// ErrorBoundary, createPortal — one set per open pane) re-rendered at pointer rate (roborev 55316).
// The comparator runs only when reconciliation actually REACHES the pane subtree, so counting its
// calls measures the tree the drag walks rather than the leaf it stops at.
const counts = vi.hoisted(() => ({ pane: 0, sidebar: 0, concierge: 0, tabs: 0, compare: 0 }));

vi.mock("./AgentPane", async () => {
  const { memo, createElement } = await import("react");
  // The REAL comparator. Imported from the leaf module, NOT from "./AgentPane" — importActual on the
  // module being mocked would load the very xterm/Tauri graph this stub exists to avoid.
  const { arePanePropsEqual } = await import("./panePropsEqual");
  const Inner = ({ agent }: { agent: { id: string } }) => {
    counts.pane += 1;
    return createElement("div", { "data-testid": `pane-${agent.id}` });
  };
  const countingCompare = (prev: unknown, next: unknown) => {
    counts.compare += 1;
    return (arePanePropsEqual as (a: unknown, b: unknown) => boolean)(prev, next);
  };
  return { AgentPane: memo(Inner, countingCompare as never) };
});
vi.mock("./AgentSidebar", () => ({
  AgentSidebar: () => {
    counts.sidebar += 1;
    return <div data-testid="sidebar" />;
  },
  NewBuildAgentButton: () => null,
}));
vi.mock("./ConciergeHost", () => ({
  ConciergeHost: ({ width }: { width?: number }) => {
    counts.concierge += 1;
    return <div data-testid="concierge" data-width={String(width)} style={{ width }} />;
  },
}));
vi.mock("./ProjectTabsBar", () => ({
  ProjectTabsBar: ({ side }: { side: string }) => {
    counts.tabs += 1;
    return <div data-testid={`tabs-${side}`} />;
  },
}));
vi.mock("./OfflineBanner", () => ({ OfflineBanner: () => null }));
vi.mock("./ZeroCreditBanner", () => ({ ZeroCreditBanner: () => null }));
vi.mock("./SparkleAgentPane", () => ({ SparkleAgentPane: () => null }));
vi.mock("./ProjectModal", () => ({ ProjectModal: () => null }));
vi.mock("./ClosePrompt", () => ({ ClosePrompt: () => null }));
vi.mock("./BoardView", () => ({ BoardView: () => null }));
vi.mock("./Concierge/KebabMenu", () => ({ ConciergeTopRight: () => null }));
vi.mock("./OpenPrMenu", () => ({ OpenPrMenu: () => null, agentLinkForBranch: () => null }));
vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));
vi.mock("./StatusStrip", () => ({ StatusStrip: () => null }));
vi.mock("./NewCloudAgentDialog", () => ({ NewCloudAgentDialog: () => null }));

import { Workspace } from "./Workspace";
import { useUiStore } from "../stores/uiStore";
import { PANES, resetCockpit, seedCockpit } from "./Workspace.costHarness";

beforeEach(() => {
  counts.pane = 0;
  counts.sidebar = 0;
  counts.concierge = 0;
  counts.tabs = 0;
  seedCockpit();
});
afterEach(() => {
  cleanup();
  resetCockpit();
});

const dots = () => screen.getByTestId("concierge-pull-tab-dots");
const conciergeWidth = () => Number(screen.getByTestId("concierge").dataset.width);

/** A REAL drag: press, then `steps` separate pointer moves, then release. One `mousemove` would
 *  under-report by construction — the cost being measured is per-pointer-event work, and a pointer
 *  emits dozens of events per second. */
function dragSteps(from: number, steps: number, pxPerStep = 2) {
  fireEvent.mouseDown(dots(), { button: 0, clientX: from, buttons: 1 });
  for (let i = 1; i <= steps; i++) {
    fireEvent.mouseMove(window, { clientX: from + i * pxPerStep, buttons: 1 });
  }
  fireEvent.mouseUp(window, { clientX: from + steps * pxPerStep });
}

const DRAG_STEPS = 30;

/** Render the shell and WAIT for the lazy pane chunk to resolve. `AgentPane` is `React.lazy`, so a
 *  synchronous `render()` leaves the stage showing `PaneFallback` and every pane counter at zero —
 *  which would make every bound below trivially satisfied by an empty stage. */
async function mount() {
  render(<Workspace />);
  await screen.findAllByTestId(/^pane-/);
}

describe("dragging the concierge seam does not re-render the terminal panes", () => {
  it(`mounts ${PANES} panes before the drag starts`, async () => {
    // The bound below is worthless if nothing is mounted — a suite that silently mounted zero panes
    // would report "0 renders during the drag" and pass forever. Pin the precondition explicitly so
    // it can never masquerade as the result.
    await mount();
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(PANES);
  });

  it("costs ZERO pane renders across a 30-step drag", async () => {
    await mount();
    const mounted = counts.pane;
    expect(mounted).toBeGreaterThanOrEqual(PANES);

    dragSteps(500, DRAG_STEPS);

    // THE MEASUREMENT. Not "fewer than before" — none at all. A column boundary moving cannot change
    // anything a terminal pane renders, so any number above zero is work the drag has no business
    // doing, and at 60 panes × 30 pointer events it is the 1,800-render shape the jank log caught.
    expect(counts.pane - mounted).toBe(0);
    // …and the drag really happened. Without this the assertion above is satisfied by a drag that
    // did nothing, which is the precondition, not the side effect.
    expect(conciergeWidth()).toBe(360 + DRAG_STEPS * 2);
  });

  // THE BOUND THE ONE ABOVE COULD NOT SEE, and the reason "ZERO pane renders" was a half-truth.
  //
  // `counts.pane` sits inside the leaf that `arePanePropsEqual` bails out of, so it was reporting zero
  // while reconciliation still walked the whole list on every pointer event: one PaneHost + Suspense +
  // ErrorBoundary + createPortal per open pane, 60 panes × 30 events (roborev 55316). The comparator
  // is called only when React actually reaches the pane subtree, so it counts the walk rather than the
  // stop. Memoizing `AgentPaneList` (and hoisting its three object-literal props out of the render)
  // is what takes this to zero; against the pre-change code it is 1,800.
  it("does not RECONCILE the pane tree either — the cost the leaf counter hid", async () => {
    await mount();
    const settled = counts.compare;

    dragSteps(500, DRAG_STEPS);

    expect(counts.compare - settled).toBe(0);
    // The drag really happened, so the zero above is a bail-out and not a no-op.
    expect(conciergeWidth()).toBe(360 + DRAG_STEPS * 2);
  });

  it("costs ZERO pane renders with the LEFT pair open too", async () => {
    // Two stages, two `AgentPaneList`s, and a `pairCount` the shell re-derives on every render. The
    // five-column cockpit is where the report came from, so the bound has to hold there as well.
    //
    // AT A WINDOW THAT CAN SEAT FIVE COLUMNS. jsdom defaults to 1024, and the concierge's window-aware
    // ceiling correctly pins it to 280 there — `320 + 6 + 280 + 6 + 360` does not fit in 1024 — so the
    // drag below would be measuring that clamp instead of the render cost it exists to measure
    // (roborev 55910). The single-pair rows above are unaffected: without a left pair the reserve is
    // small enough that 1024 leaves the full 560.
    const realWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true });
    try {
      useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
      await mount();
      expect(screen.getByTestId("workspace-shell").getAttribute("data-pairs")).toBe("2");
      const mounted = counts.pane;
      expect(mounted).toBeGreaterThanOrEqual(PANES);

      dragSteps(500, DRAG_STEPS);

      expect(counts.pane - mounted).toBe(0);
      expect(conciergeWidth()).toBe(360 + DRAG_STEPS * 2);
    } finally {
      Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
    }
  });

  it("does not re-render the agent sidebar or the tab strips either", async () => {
    // The panes are the biggest single cost but not the only one: the sidebar lists every agent and
    // the tab strips re-derive their per-side partitions. Neither depends on where the concierge
    // boundary sits, so neither may run at pointer rate.
    await mount();
    const sidebar = counts.sidebar;
    const tabs = counts.tabs;

    dragSteps(500, DRAG_STEPS);

    expect(counts.sidebar - sidebar).toBe(0);
    expect(counts.tabs - tabs).toBe(0);
  });

  it("STILL re-renders the concierge column, which is the one thing that must move", async () => {
    // The inverse assertion, and the reason the three above are not satisfied by a dead control:
    // the column whose width changed has to re-render, once per committed width. If this ever goes
    // to zero the drag has stopped working and the bounds above would still be green.
    await mount();
    const before = counts.concierge;

    dragSteps(500, DRAG_STEPS);

    expect(counts.concierge - before).toBeGreaterThanOrEqual(DRAG_STEPS);
  });
});
