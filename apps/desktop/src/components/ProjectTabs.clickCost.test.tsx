// @vitest-environment jsdom
//
// WHAT ONE CLICK ON A PROJECT TAB COSTS, COUNTED — and whether it lands at all.
//
// The founder's report (bead sparkle-73imb): *"when I click on a project tab, it just blinks a lot of
// times and oftentimes does not become the active tab."* Two symptoms, and they need two different
// measurements, so this file makes both numeric rather than impressionistic:
//
//   • BLINKING is commits. A click that produces one commit cannot flash; one that produces six can.
//     Counted with a `Profiler` wrapped around the REAL `ProjectTabs` (injected by mocking the module
//     and spreading the original), so a commit driven by the strip's OWN internal state — the
//     hover-expand object, the measured-metrics object — is counted too. A wrapper component alone
//     would miss exactly those, which are the ones under suspicion.
//   • A DROPPED CLICK is the selection not surviving. Counted by subscribing to the store and
//     recording every value `selectedProjectId` takes, so a click that commits the right id and is
//     then overwritten by a later render reads as `["p2", "p1"]` rather than as a passing assertion.
//
// The whole `Workspace` is mounted, not the strip alone, BECAUSE the suspected overwrite lives
// outside the strip: `Workspace.tsx`'s reconcile effect writes `selectProject(rightProjectId)`
// whenever the resolved right-side project disagrees with the store, and `resolveSideSelection`
// resolves an id it does not recognise to `sideProjects[0]`. A strip-only harness cannot see that
// effect at all and would report a clean click for a click the app drops.
//
// SIXTY PANES, because the report is from a loaded cockpit and the jank log that motivated it
// (`rendered: Workspace x98, AgentPane x68`) is from one. A bound measured at one pane would not
// speak to the conditions the founder is actually in.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, act, fireEvent, render, screen } from "@testing-library/react";

// ── SHELL MOCKS ────────────────────────────────────────────────────────────────────────────────
// Kept in sync with `Workspace.switchCost.test.tsx` — same shell, different interaction. Spread the
// original rather than stubbing wholesale: a flat stub silently drops exports added later, which is
// how the cost suites have failed to COLLECT for reasons unrelated to what they measure.
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
// The repo-key sweep reaches Tauri and writes to the store asynchronously. Stubbed so a background
// write cannot land in the middle of a counted click and be mistaken for the click's own cost.
vi.mock("../services/repoKey", () => ({
  backfillRepoKeys: async () => {},
  repoKeyFor: async () => null,
  resolveRepoKeyFor: async () => null,
}));
// `openProjectTab` is deliberately NOT mocked: it is the commit path under measurement.

// ── COUNTERS ───────────────────────────────────────────────────────────────────────────────────
const counts = vi.hoisted(() => ({
  /** Commits in which the REAL `ProjectTabs` subtree rendered. The blink metric. */
  strip: 0,
  /** `AgentPane` renders — a tab click must not repaint the cockpit. */
  pane: 0,
}));

vi.mock("./ProjectTabs", async (orig) => {
  const real = await orig<typeof import("./ProjectTabs")>();
  const { Profiler, createElement } = await import("react");
  const Counted = (props: Record<string, unknown>) =>
    createElement(
      Profiler,
      {
        id: "strip",
        onRender: () => {
          counts.strip += 1;
        },
      },
      createElement(real.ProjectTabs as never, props as never),
    );
  return { ...real, ProjectTabs: Counted };
});

vi.mock("./AgentPane", async () => {
  const { memo, createElement } = await import("react");
  const { arePanePropsEqual } = await import("./panePropsEqual");
  const Inner = ({ agent, visible }: { agent: { id: string }; visible: boolean }) => {
    counts.pane += 1;
    return createElement("div", {
      "data-testid": `pane-${agent.id}`,
      "data-visible": visible ? "1" : "0",
    });
  };
  return { AgentPane: memo(Inner, arePanePropsEqual as never) };
});
vi.mock("./AgentSidebar", () => ({ AgentSidebar: () => <div data-testid="sidebar" /> }));
vi.mock("./ConciergeHost", () => ({ ConciergeHost: () => <div data-testid="concierge" /> }));
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
vi.mock("./TrialChrome", () => ({ TrialIndicator: () => null }));

import { Workspace } from "./Workspace";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuthStore } from "../stores/authStore";
import { useConnectionStore } from "../stores/connectionStore";
import { resetVisitedProjects } from "../services/sessionProjects";
import { resetCable } from "../stores/cableStore";
import { mkAgent } from "./Workspace.costHarness";
import type { Project } from "../types";

/** Agents per project. Three projects × 20 = the 60-pane cockpit the jank log came from, but with
 *  DISTINCT ids per project — sharing one id set across projects makes React collide the pane keys
 *  and the counts stop meaning anything. */
const PER_PROJECT = 20;
const PROJECT_IDS = ["p1", "p2", "p3"] as const;
const agentIdsFor = (pid: string) =>
  Array.from({ length: PER_PROJECT }, (_, i) => `${pid}-a${i}`);
/** Every pane the cockpit holds, across all three projects. */
const allAgentIds = PROJECT_IDS.flatMap(agentIdsFor);

function mkProject(id: string, name: string): Project {
  const agents = agentIdsFor(id).map(mkAgent);
  return {
    id,
    name,
    rootPath: `/tmp/${id}`,
    defaultBranch: null,
    createdAt: new Date(0).toISOString(),
    selectedAgentId: agents[0]?.id ?? null,
    agents,
  };
}

/** Every value `selectedProjectId` takes, in order, since the last reset. */
let selections: (string | null)[] = [];
let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  counts.strip = 0;
  counts.pane = 0;
  selections = [];
  localStorage.clear();
  // THREE projects, all on the right pair — the shape the report comes from. `p1` starts selected.
  useProjectStore.setState({
    projects: [mkProject("p1", "Alpha"), mkProject("p2", "Beta"), mkProject("p3", "Gamma")],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: allAgentIds, status: {} } as never);
  useUiStore.setState({
    activeSpecial: null,
    workModeBySide: { left: "build", right: "build" },
    pinnedProjectId: null,
    openProjectIds: null,
    pairAssignment: {},
    leftProjectId: null,
  } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false } as never);
  useConnectionStore.setState({ isOnline: true } as never);
  resetVisitedProjects();
  resetCable();
  unsubscribe = useProjectStore.subscribe((s, prev) => {
    if (s.selectedProjectId !== prev.selectedProjectId) selections.push(s.selectedProjectId);
  });
});
afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  cleanup();
  resetCable();
  localStorage.clear();
});

async function mount() {
  render(<Workspace />);
  await screen.findAllByTestId(/^pane-/);
}

function clickTab(id: string) {
  fireEvent.click(screen.getByTestId(`tab-${id}`));
}

/**
 * A click the way a POINTER makes one, not the way `fireEvent.click` does.
 *
 * This distinction is the whole reason the first measurement here read clean. `fireEvent.click`
 * dispatches exactly one event; a real click on this strip dispatches a pointer enter, a focus, a
 * pointerdown and then the click — and the strip has handlers on all of them (`onMouseEnter` →
 * `beginExpand`, `onFocus` → `beginExpand(immediate)` → `settleNow` → `setExpanded`, plus the
 * pointer-capture drag gesture). Measuring only the last one measures a path no user takes.
 */
function realClickTab(id: string) {
  const el = screen.getByTestId(`tab-${id}`);
  fireEvent.mouseEnter(el);
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 10, clientY: 5 });
  fireEvent.focus(el);
  fireEvent.pointerUp(el, { pointerId: 1, button: 0, clientX: 10, clientY: 5 });
  fireEvent.click(el);
}

describe("clicking a project tab", () => {
  it("mounts three tabs with p1 active — the precondition, pinned so it cannot masquerade as a result", async () => {
    await mount();
    expect(screen.getByTestId("tab-p1")).toBeTruthy();
    expect(screen.getByTestId("tab-p2")).toBeTruthy();
    expect(screen.getByTestId("tab-p3")).toBeTruthy();
    expect(screen.getByTestId("tab-p1").getAttribute("aria-selected")).toBe("true");
  });

  it("MEASUREMENT: prices a tab click in each configuration, and every one must LAND", async () => {
    // One test over three configurations rather than three tests, because a measurement is not a
    // test: printing a number proves nothing and a case that only prints can never go red. Each
    // configuration therefore carries the same falsifiable pair — the click selected the tab, and
    // nothing took the selection back.
    //
    // The last configuration is the five-column cockpit the founder's report comes from.
    // `resolveSideSelection` is per-side there, and `Workspace`'s reconcile effect can write a
    // side's fallback back to the store, so it is the layout where a click has something to be
    // overwritten BY.
    const configs = [
      { label: "synthetic click, one pair", pointer: false, twoPairs: false },
      { label: "POINTER click, one pair", pointer: true, twoPairs: false },
      { label: "POINTER click, BOTH pairs", pointer: true, twoPairs: true },
    ];

    for (const c of configs) {
      if (c.twoPairs) {
        useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
      }
      useProjectStore.setState({ selectedProjectId: "p1" } as never);
      selections = [];
      counts.strip = 0;
      counts.pane = 0;

      await mount();
      const strip = counts.strip;
      const pane = counts.pane;

      if (c.pointer) realClickTab("p2");
      else clickTab("p2");

      console.log(
        `[measure] ${c.label}: strip commits=${counts.strip - strip} ` +
          `paneRenders=${counts.pane - pane} selections=${JSON.stringify(selections)}`,
      );
      expect(screen.getByTestId("tab-p2").getAttribute("aria-selected")).toBe("true");
      expect(selections).toEqual(["p2"]);
      cleanup();
    }
  });

  it("commits the selection EXACTLY ONCE — no later render may overwrite it", async () => {
    await mount();

    clickTab("p2");

    // The dropped-click assertion. `["p2"]` is a click that landed. `["p2", "p1"]` is the founder's
    // report: the click committed and something downstream took it back.
    expect(selections).toEqual(["p2"]);
  });

  it("keeps the clicked tab active across an unrelated agent-status update", async () => {
    // The report is from a cockpit whose statuses flap constantly. A selection that only survives a
    // quiet moment is not a selection the founder can use, and a test that clicks and asserts
    // immediately would pass against the broken code.
    await mount();
    clickTab("p2");

    act(() => {
      useRuntimeStore.setState({
        openAgentIds: allAgentIds,
        status: { "p1-a3": { state: "running" } },
      } as never);
    });

    expect(useProjectStore.getState().selectedProjectId).toBe("p2");
    expect(screen.getByTestId("tab-p2").getAttribute("aria-selected")).toBe("true");
    expect(selections).toEqual(["p2"]);
  });

  it("does not repaint the whole cockpit — a tab click must not re-render every pane", async () => {
    await mount();
    const pane = counts.pane;
    expect(pane).toBeGreaterThanOrEqual(PER_PROJECT);

    clickTab("p2");

    // THE MEASUREMENT, pinned exactly — the sibling of `Workspace.switchCost.test.tsx`'s "exactly
    // two panes". It was `toBeLessThan(60)`, which let 59 of the 60 panes repaint and still pass:
    // a bound that only a LITERALLY total repaint could break is not guarding the invariant its own
    // comment states (roborev 62821).
    //
    // 21 = 20 + 1, and both halves are structural rather than incidental. A project's panes exist
    // only once that project is opened, so clicking p2 MOUNTS its twenty for the first time; and
    // exactly one pane of the project being left was visible (`visible` is
    // `agent.id === visibleAgentId[side]`, one per side), so exactly one turns invisible. Every
    // other pane in the cockpit is untouched. The number to fear is 60 — the "AgentPane x68" shape
    // from the jank log the founder quoted, which is the memo being defeated outright.
    console.log(`[measure] paneRenders per tab click = ${counts.pane - pane} (of ${allAgentIds.length} panes)`);
    expect(counts.pane - pane).toBe(PER_PROJECT + 1);
  });
});
