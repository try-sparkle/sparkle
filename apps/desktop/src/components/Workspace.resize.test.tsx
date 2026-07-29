// @vitest-environment jsdom
//
// PROBE: does a drag on the concierge seam actually MOVE the column?
//
// `ColumnPullTab.test.tsx` proves the tab calls `onWidth` with the right number. Every one of those
// assertions runs against a `vi.fn()`, so none of them can see whether the committed width ever
// reaches the column. "The divider registers the drag but nothing moves" is exactly the symptom a
// mocked-callback suite cannot catch, so this asserts the delivered value instead.
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
vi.mock("../services/cloudAgents/startup", () => ({ reattachProjectOnOpen: async () => [] as string[] }));
// PARTIAL mock, spreading the original — the same shape `Workspace.cockpit.test.tsx` uses, and for
// a reason worth keeping: a full-replacement mock breaks the moment the module gains an export some
// unrelated transitive import needs. That is not hypothetical, it is why this line changed —
// `SPARKLE_AGENT_ID` arrived on main and `conciergeTools/terminal.ts` reads it at module scope, so
// the replacement mock made this whole file fail to LOAD (0 tests collected) while the suite still
// reported "no tests failed".
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
  sparkleAgentIdFor: () => "sparkle",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));
vi.mock("./AgentPane", () => ({ AgentPane: ({ agent }: { agent: { id: string } }) => <div data-testid={`pane-${agent.id}`} /> }));
vi.mock("./AgentSidebar", () => ({
  AgentSidebar: () => <div data-testid="sidebar" />,
  NewBuildAgentButton: () => null,
}));
// THE POINT OF THIS FILE. The cockpit suite stubs ConciergeHost as `() => <div/>`, which DROPS the
// width prop — so nothing downstream of `setConciergeWidth` is observable there. This stub applies
// the width the same way the real column does (`style.width`), so the assertion below reads the
// number that actually arrived.
vi.mock("./ConciergeHost", () => ({
  ConciergeHost: ({ width }: { width?: number }) => (
    <div data-testid="concierge" data-width={String(width)} style={{ width }} />
  ),
}));
vi.mock("./OfflineBanner", () => ({ OfflineBanner: () => null }));
vi.mock("./ZeroCreditBanner", () => ({ ZeroCreditBanner: () => null }));
vi.mock("./SparkleAgentPane", () => ({ SparkleAgentPane: () => null }));
vi.mock("./ProjectModal", () => ({ ProjectModal: () => null }));
vi.mock("./ClosePrompt", () => ({ ClosePrompt: () => null }));
vi.mock("./BoardView", () => ({ BoardView: () => <div data-testid="board" /> }));
vi.mock("./Concierge/KebabMenu", () => ({ ConciergeTopRight: () => null }));
vi.mock("./OpenPrMenu", () => ({ OpenPrMenu: () => null, agentLinkForBranch: () => null }));
vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));
vi.mock("./StatusStrip", () => ({ StatusStrip: () => null }));
vi.mock("./NewCloudAgentDialog", () => ({ NewCloudAgentDialog: () => null }));

import { Workspace } from "./Workspace";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuthStore } from "../stores/authStore";
import { useConnectionStore } from "../stores/connectionStore";
import { resetVisitedProjects } from "../services/sessionProjects";
import { resetCable } from "../stores/cableStore";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}
function mkProject(id: string, name: string, agents: AgentTab[], selectedAgentId: string): Project {
  return { id, name, rootPath: `/tmp/${id}`, defaultBranch: null, createdAt: new Date(0).toISOString(), selectedAgentId, agents };
}

beforeEach(() => {
  localStorage.clear();
  useProjectStore.setState({
    projects: [mkProject("p1", "Alpha", [mkAgent("a1")], "a1")],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: ["a1"], status: {} } as never);
  useUiStore.setState({
    activeSpecial: null, workMode: "build", pinnedProjectId: null, openProjectIds: null,
    pairAssignment: {}, leftProjectId: null,
  } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false } as never);
  useConnectionStore.setState({ isOnline: true } as never);
  resetVisitedProjects();
  resetCable();
});
afterEach(() => { cleanup(); resetCable(); });

const conciergeWidth = () => screen.getByTestId("concierge").getAttribute("data-width");

/**
 * Begin the drag THE WAY A USER MUST, not the way jsdom permits.
 *
 * The tab is `pointerEvents: shown ? "auto" : "none"`, and `shown` only becomes true once the
 * pointer crosses the RAIL — the enter handler lives there, not on the tab. jsdom ignores
 * `pointer-events` for synthetic dispatch, so a bare `mouseDown` on the dots succeeds against a
 * control that is invisible and pointer-inert in a real browser.
 *
 * That matters here specifically: this component has ALREADY shipped a "dead reveal" once, where
 * the tab never became `shown` and the drag could not be started at all (roborev 54850). Skipping
 * the hover would let that exact regression return with this suite green — the same "nothing
 * happens" class of symptom the file was written to catch (roborev 55340).
 */
function grabSeam(clientX: number) {
  fireEvent.mouseEnter(screen.getByTestId("concierge-pull-tab"));
  // Assert the reveal actually happened, rather than assuming the hover took.
  expect(screen.getByTestId("concierge-pull-tab").getAttribute("data-shown")).toBe("true");
  expect(screen.getByTestId("concierge-pull-tab-tab").style.pointerEvents).toBe("auto");
  fireEvent.mouseDown(screen.getByTestId("concierge-pull-tab-dots"), { button: 0, clientX });
}

/** Drag from `clientX` to `clientX + dx` and release. */
function dragSeamBy(dx: number, from = 500) {
  grabSeam(from);
  fireEvent.mouseMove(window, { clientX: from + dx, buttons: 1 });
  fireEvent.mouseUp(window);
}

/**
 * ══ NOTHING BELOW HARDCODES A WIDTH, A BOUND, OR THE STORAGE KEY ═══════════════════════════════
 *
 * `Workspace.tsx` keeps those four values module-private, and they are NOT exported for this file's
 * benefit: that file is owned by a concurrent agent reworking the cockpit layout, and a third party
 * editing it — even additively — is the convergence collision AGENTS.md calls the most expensive
 * recurring failure in this repo.
 *
 * Copying the literals instead would have been worse than either option. This file exists to catch
 * width-DELIVERY bugs, so a changed default must not surface here as unexplained numeric failures
 * reading like "the drag broke" (roborev 55342). So every expectation is OBSERVED:
 *
 *   • the default    — read off the column at mount;
 *   • the storage key — discovered as the key the drag actually writes;
 *   • the max clamp   — proven by IDEMPOTENCE (a bigger drag lands on the same width), which needs
 *                       no number at all;
 *   • out-of-clamp    — seeded as a value orders of magnitude past any plausible bound.
 *
 * The tests therefore survive a re-tune of any of the four, and still fail if the width stops
 * arriving — which is the only thing they are here to watch.
 */
const mountAndReadDefault = () => {
  render(<Workspace />);
  return conciergeWidth();
};

/** Every key currently in storage. Enumerated through the Web Storage API rather than
 *  `Object.keys`, which does not enumerate this environment's localStorage. */
function storageKeys(): string[] {
  return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(
    (k): k is string => k !== null,
  );
}

/** The key the drag wrote, found by diffing localStorage rather than by knowing its name. */
function keyWrittenBy(action: () => void): string {
  const before = new Set(storageKeys());
  action();
  const added = storageKeys().filter((k) => !before.has(k));
  expect(added).toHaveLength(1);
  return added[0] as string;
}

describe("dragging the concierge seam moves the column", () => {
  it("delivers the dragged width to the column, not just to the handler", () => {
    const start = Number(mountAndReadDefault());
    expect(start).toBeGreaterThan(0);

    dragSeamBy(40);

    // Derived from what the column actually mounted at — a re-tuned default stays green here, while
    // a width that fails to arrive still fails.
    expect(conciergeWidth()).toBe(String(start + 40));
  });

  /**
   * Drag past a bound twice and return the two widths, having first proven the column MOVED.
   *
   * The movement check is the load-bearing part. Comparing phase 2 to phase 1 alone has a
   * degenerate pass mode: if the width stops reaching the column at all, BOTH phases render at the
   * mount default, the two agree, and the test is green — while showing exactly the "the drag
   * registers but nothing moves" symptom this file exists to catch. It survived only because
   * sibling tests happened to catch that mutation; on its own it asserted nothing (roborev 55390).
   *
   * Storage is also cleared between the phases. Phase 1 persists the CLAMPED value, so without the
   * clear phase 2 mounts already at the bound and its "bigger" drag never travels from the default.
   */
  function twoDragsPastBound(first: number, second: number) {
    const start = Number(mountAndReadDefault());
    dragSeamBy(first);
    const bound = conciergeWidth();
    expect(Number(bound)).not.toBe(start); // it actually moved
    cleanup();
    localStorage.clear();

    const restart = Number(mountAndReadDefault());
    expect(restart).toBe(start); // phase 2 really does begin at the default
    dragSeamBy(second);
    return { start, bound, again: conciergeWidth() };
  }

  it("clamps at the maximum on the DELIVERY path, not just in the handler", () => {
    // `ColumnPullTab.test.tsx` clamps against a mocked `onWidth`; this drives a past-the-end drag
    // through the real Workspace, so a clamp bypassed anywhere between handler and column is caught.
    //
    // Asserted by IDEMPOTENCE rather than against the bound's value: whatever the max is, dragging
    // further must not move the column past it. That is the property, and it needs no literal.
    const { start, bound, again } = twoDragsPastBound(4000, 9000);
    expect(Number(bound)).toBeGreaterThan(start);
    expect(again).toBe(bound);
  });

  it("persists the dragged width AND reads it back on the next launch", () => {
    const start = Number(mountAndReadDefault());
    const key = keyWrittenBy(() => dragSeamBy(60));
    const dragged = String(start + 60);
    expect(localStorage.getItem(key)).toBe(dragged);

    // THE ROUND TRIP, not just the write. Asserting only the localStorage value leaves the
    // `useState` initializer that reads it back completely uncovered — a wrong key or an inverted
    // clamp comparison would keep this green while the column snapped back to the default on every
    // launch, which is the same "the drag registers but nothing sticks" symptom this file exists to
    // catch (roborev 55342).
    cleanup();
    render(<Workspace />);
    expect(conciergeWidth()).toBe(dragged);
  });

  it("clamps at the minimum on the DELIVERY path too", () => {
    // BOTH ends, not just the max. A min bypass between handler and column is a different edit from
    // a max bypass, and asserting only the upper bound leaves the lower one unguarded.
    const { start, bound, again } = twoDragsPastBound(-4000, -9000);
    expect(Number(bound)).toBeLessThan(start);
    expect(again).toBe(bound);
    // And it must be a real floor, not a collapse to nothing.
    expect(Number(bound)).toBeGreaterThan(0);
  });

  // BOTH HALVES of the read-back validation, seeded ABOVE and BELOW.
  //
  // The initializer is `saved >= MIN && saved <= MAX ? saved : DEFAULT`, and an out-of-clamp seed
  // only ever exercises the side it is on. Seeding high alone let the LOWER bound be weakened to
  // `saved >= 1` with every test still green — while a stale "50" from an older clamp is restored
  // and wedges the column to a 50px sliver, which is precisely the guarantee the source comment
  // claims (roborev 55387). Empty storage cannot catch it either: `Number(null) === 0` falls to the
  // default through the same branch.
  it.each([
    ["above the maximum", "1000000"],
    ["below the minimum", "1"],
  ])("ignores a persisted width %s rather than restoring it", (_label, seeded) => {
    const start = mountAndReadDefault();
    const key = keyWrittenBy(() => dragSeamBy(40));
    cleanup();
    localStorage.setItem(key, seeded);

    render(<Workspace />);
    expect(conciergeWidth()).toBe(start);
  });
});
