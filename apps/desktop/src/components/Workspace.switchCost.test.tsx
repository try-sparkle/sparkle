// @vitest-environment jsdom
//
// WHAT SWITCHING THE SELECTED AGENT COSTS, COUNTED — the prerequisite for hover-to-preview.
//
// The founder's report: "there seems to be quite a bit of latency in me clicking around on the build
// agents… I wanna be able to hover over a build agent and have that be the one that shows in the
// terminal." A hover-driven preview fires a selection per row the pointer crosses, so before building
// it we have to know what ONE selection costs. The field answer is in `PRD/sparkle/terminal-switch-
// latency.md` (measured from the `[perf] switch` waterfall in the real logs: p50 286ms even with a
// quiet main thread). This file answers the other half — how much of that is REACT, and whether a
// switch touches a terminal's lifecycle at all.
//
// The distinction matters because the two have opposite fixes. If a switch re-renders sixty panes,
// that's a memo bug. If it re-renders two and the time is in xterm's reveal path, no amount of
// memoization helps and hover needs a different mechanism entirely. The bounds below pin which world
// we're in, so a future change that moves us into the other one fails here.
//
// HOW THE COUNTS ARE HONEST — same discipline as `Workspace.renderCost.test.tsx`: the pane stub is
// wrapped in `memo(..., arePanePropsEqual)`, the REAL comparator from its own leaf module. A counted
// render means Workspace handed the pane props the shipping predicate calls different, which is
// exactly what makes the shipping pane re-render. A bare stub would count nothing and pass forever.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, act, render, screen } from "@testing-library/react";

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
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
  sparkleAgentIdFor: () => "sparkle",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));

// ── THE COUNTERS ───────────────────────────────────────────────────────────────────────────────
// `teardowns` is the load-bearing one: it stands in for `Terminal`'s unmount, which KILLS the pane's
// PTY (`pairs.ts`). Presence of a pane afterwards cannot detect a remount — the pane would be present
// either way — so the stub also mints an instance token per mount and registers a cleanup.
const counts = vi.hoisted(() => ({
  pane: 0,
  sidebar: 0,
  tabs: 0,
  mounts: 0,
  teardowns: 0,
  /** agent id → the token minted by its CURRENT mount. A changed token is a remount. */
  tokens: new Map<string, object>(),
}));

vi.mock("./AgentPane", async () => {
  const { memo, createElement, useEffect } = await import("react");
  const { arePanePropsEqual } = await import("./panePropsEqual");
  const Inner = ({ agent, visible }: { agent: { id: string }; visible: boolean }) => {
    counts.pane += 1;
    useEffect(() => {
      counts.mounts += 1;
      counts.tokens.set(agent.id, {});
      return () => {
        counts.teardowns += 1;
      };
      // Mount/unmount only — a `visible` flip must not re-run this, exactly as a real Terminal's PTY
      // is not re-spawned when its pane is revealed.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return createElement("div", {
      "data-testid": `pane-${agent.id}`,
      // The side effect the bounds below are meaningless without: which pane is actually showing.
      "data-visible": visible ? "1" : "0",
    });
  };
  return { AgentPane: memo(Inner, arePanePropsEqual as never) };
});
vi.mock("./AgentSidebar", () => ({
  AgentSidebar: () => {
    counts.sidebar += 1;
    return <div data-testid="sidebar" />;
  },
}));
vi.mock("./ConciergeHost", () => ({
  ConciergeHost: () => <div data-testid="concierge" />,
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
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { PANES, resetCockpit, seedCockpit } from "./Workspace.costHarness";

beforeEach(() => {
  counts.pane = 0;
  counts.sidebar = 0;
  counts.tabs = 0;
  counts.mounts = 0;
  counts.teardowns = 0;
  counts.tokens.clear();
  seedCockpit();
});
afterEach(() => {
  cleanup();
  resetCockpit();
});

async function mount() {
  render(<Workspace />);
  await screen.findAllByTestId(/^pane-/);
}

/** Drive a real selection through the store action the sidebar click calls — not a `setState` that
 *  hand-writes `selectedAgentId`. `selectAgent` carries the redundant-selection bail and the perf
 *  waterfall, so going around it would measure a path no click takes. */
function selectAgent(id: string) {
  act(() => {
    useProjectStore.getState().selectAgent("p1", id);
  });
}

/** Which agent's pane is currently showing, read off the DOM the stage renders. */
function visiblePaneId(): string | null {
  const el = document.querySelector('[data-testid^="pane-"][data-visible="1"]');
  return el ? (el.getAttribute("data-testid") ?? "").replace(/^pane-/, "") : null;
}

describe("switching the selected agent is cheap on the React side", () => {
  it(`mounts ${PANES} panes, exactly one of them visible`, async () => {
    // The precondition, pinned on its own so it can never masquerade as the result: a suite that
    // silently mounted zero panes would report "0 renders per switch" and pass forever.
    await mount();
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(PANES);
    expect(document.querySelectorAll('[data-visible="1"]')).toHaveLength(1);
    expect(visiblePaneId()).toBe("a0");
  });

  it("re-renders only the TWO panes whose visibility flipped, not all 60", async () => {
    await mount();
    const before = counts.pane;
    expect(before).toBeGreaterThanOrEqual(PANES);

    selectAgent("a7");

    // THE MEASUREMENT. Exactly two panes change their `visible` prop — the one losing it and the one
    // gaining it — so exactly two may re-render. 60 would mean the memo is defeated and every
    // switch repaints the whole cockpit; that is the shape the jank log caught on the drag path
    // ("AgentPane x62") and it must not exist on the switch path either.
    expect(counts.pane - before).toBe(2);
    // …and the switch really happened. Without this the bound above is satisfied by a dead action.
    expect(visiblePaneId()).toBe("a7");
  });

  it("costs ZERO pane teardowns — a switch must never kill a PTY", async () => {
    // The expensive failure `pairs.ts` exists to prevent: a Terminal unmount kills its PTY, so the
    // agent respawns (`claude --resume`) and loses its scrollback. Presence of the pane afterwards
    // cannot detect this (it would be present either way), so this asserts the CLEANUP never ran and
    // the mount identity survived.
    await mount();
    const tokenBefore = counts.tokens.get("a0");
    const mountsBefore = counts.mounts;
    expect(tokenBefore).toBeDefined();

    selectAgent("a7");
    selectAgent("a0");
    selectAgent("a31");

    expect(counts.teardowns).toBe(0);
    expect(counts.mounts).toBe(mountsBefore);
    // Same mount instance as before the three switches — not a fresh one that merely looks alike.
    expect(counts.tokens.get("a0")).toBe(tokenBefore);
    expect(visiblePaneId()).toBe("a31");
  });

  it("keeps the SAME DOM node for a pane across a switch", async () => {
    // xterm's canvas and scrollback live in this subtree. A switch that replaced the node would
    // discard both even if React thought it was re-using the component.
    await mount();
    const node = screen.getByTestId("pane-a0");

    selectAgent("a7");

    expect(screen.getByTestId("pane-a0")).toBe(node);
    expect(node.isConnected).toBe(true);
  });

  it("churns the project object exactly ONCE per switch at the shell's memo boundary", async () => {
    // SCOPE, stated precisely, because the obvious stronger reading of this test is one it cannot
    // support. `AgentSidebar` is stubbed here to a bare `<div>` with no rows and no store
    // subscription, so this counter can only ever read 0 or 1: it measures how many times a NEW
    // `project` identity crosses `MemoAgentSidebar`, and nothing about sidebar work. It is worth
    // pinning at 1 (a switch must not write the selection twice), but it says NOTHING about the
    // per-row cost — and "not once per agent row" would be unobservable here by construction.
    //
    // THE PER-ROW COST IS MEASURED IN `AgentSidebar.switchCost.test.tsx`, against the real sidebar,
    // and the answer is 60 of 60 rows per switch. Do not read this bound as covering that.
    await mount();
    const before = counts.sidebar;

    selectAgent("a7");

    expect(counts.sidebar - before).toBe(1);
    expect(visiblePaneId()).toBe("a7");
  });

  it("costs NOTHING when re-selecting the agent already shown", async () => {
    // `selectAgent`'s redundant-selection bail. This is load-bearing for hover specifically: a
    // pointer resting on the selected row re-fires the same id, and without the bail each repeat
    // churns a fresh projects array and re-runs the Terminal reveal (WebGL attach + full repaint).
    // In the field ~18% of selections were already redundant BEFORE hover existed.
    await mount();
    const panes = counts.pane;
    const sidebar = counts.sidebar;

    selectAgent("a0");
    selectAgent("a0");

    expect(counts.pane - panes).toBe(0);
    expect(counts.sidebar - sidebar).toBe(0);
    expect(visiblePaneId()).toBe("a0");
  });

  it("still costs only two pane renders with the LEFT pair open", async () => {
    // Two stages, and `visibleAgentId` is derived per side. The five-column cockpit is where the
    // founder's report came from, so the bound has to hold there too.
    useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
    await mount();
    expect(screen.getByTestId("workspace-shell").getAttribute("data-pairs")).toBe("2");
    const before = counts.pane;
    expect(before).toBeGreaterThanOrEqual(PANES);

    selectAgent("a7");

    expect(counts.pane - before).toBe(2);
    expect(counts.teardowns).toBe(0);
  });
});
