// @vitest-environment jsdom
//
// DOES Cmd +/- ACTUALLY SIZE THE COLUMN THE USER IS IN? — the WIRING, not the unit.
//
// `engine/columnZoom.test.ts` proves the classifier maps a DOM node to a column.
// `services/columnFocusTracker.test.ts` proves the tracker records the right one.
// `stores/uiStore.test.ts` proves the store keeps five independent levels.
//
// All three pass while the feature is completely broken, because the thing the founder actually
// operates is the CHAIN none of them cross:
//
//     press in a column → tracker → Workspace keydown → store → that column's level
//
// That is the same gap `Workspace.resize.test.tsx` was written to close for dragging, and the same
// failure shape as the original bug: Cmd +/- "worked" (it moved a number) while doing nothing the
// user could see in four of the five columns.
//
// So these assert the SIDE EFFECT — which column's level in `zoomByColumn` moved — and never that a
// handler fired. The REFUSAL cases matter just as much: the founder was explicit that a zoom landing
// in the wrong column is worse than one that does not fire.
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
// The `sparkleAgent` mock below SPREADS THE ORIGINAL rather than replacing it — the same shape
// `Workspace.cockpit.test.tsx` uses, and for a reason worth keeping: a full-replacement mock breaks
// the moment the module gains an export some unrelated transitive import needs. That is not
// hypothetical, it is why this line changed — `SPARKLE_AGENT_ID` arrived on main and
// `conciergeTools/terminal.ts` reads it at module scope, so a replacement mock made this whole file
// fail to LOAD (0 tests collected) while the suite still reported "no tests failed".
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
  sparkleAgentIdFor: () => "sparkle",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));
vi.mock("./AgentPane", () => ({
  AgentPane: ({ agent }: { agent: { id: string } }) => <div data-testid={`pane-${agent.id}`} />,
}));
// THE STUB CARRIES THE REAL MARKER, keyed by the side it was handed — otherwise every build-column
// case here would be vacuous (a press would resolve to no column and the "do nothing" branch would
// make it pass for the wrong reason). That the REAL column emits this attribute is asserted in
// `AgentSidebar.pullTabs.test.tsx`; what this file pins is the routing that reads it.
vi.mock("./AgentSidebar", () => ({
  AgentSidebar: ({ slotSide }: { slotSide?: "left" | "right" }) => (
    <div data-testid={`sidebar-${slotSide ?? "right"}`} data-zoom-column={`build-${slotSide ?? "right"}`} />
  ),
  NewBuildAgentButton: () => null,
}));
// THE STUB PUBLISHES THE WIDTH IT WAS HANDED, and that is the whole point of it. A stub that
// ignored `width` — like the cockpit suite's, which renders a bare div — would make every
// assertion below vacuous: the drag could write into a prop nobody reads and the test would still
// be green, which is the exact defect class this file exists to catch.
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
vi.mock("./BoardView", () => ({ BoardView: () => null }));
vi.mock("./Concierge/KebabMenu", () => ({ ConciergeTopRight: () => null }));
vi.mock("./OpenPrMenu", () => ({ OpenPrMenu: () => null, agentLinkForBranch: () => null }));
vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));
vi.mock("./StatusStrip", () => ({ StatusStrip: () => null }));
vi.mock("./NewCloudAgentDialog", () => ({ NewCloudAgentDialog: () => null }));

import { Workspace } from "./Workspace";
// ONLY THE VARIABLE NAME. The geometry helpers were imported here to run the app's rendered numbers
// through `cockpitGeometry`, which turned out to prove nothing: the model's concierge centre reduces
// to `windowWidth / 2` algebraically for every input, so restating it at the app level was a
// pass-by-construction check (roborev 56086). The arithmetic lives in `engine/columnResize.test.ts`;
// what this file pins is the DOM structure that model assumes — see `assertRowStructure`.
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
function mkProject(id: string, name: string, agents: AgentTab[]): Project {
  return {
    id, name, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: agents[0]!.id, agents,
  };
}

beforeEach(() => {
  localStorage.clear();
  useProjectStore.setState({
    projects: [mkProject("p1", "Alpha", [mkAgent("a1")])],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: ["a1"], status: {} } as never);
  useUiStore.setState({
    activeSpecial: null, workModeBySide: { left: "build", right: "build" }, pinnedProjectId: null, openProjectIds: null,
    pairAssignment: {}, leftProjectId: null,
  } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false } as never);
  useConnectionStore.setState({ isOnline: true } as never);
  resetVisitedProjects();
  resetCable();
});
afterEach(() => {
  cleanup();
  resetCable();
  localStorage.clear();
});


/** Press in a region the way a POINTER does. `pointerdown` is the signal the tracker leads on,
 *  because in this webview a click on a button blurs to `<body>` without focusing anything — so a
 *  focus-only implementation resolves three of the five columns to "nowhere". */
function pressIn(el: Element) {
  fireEvent.pointerDown(el, { bubbles: true });
}

const levels = () => useUiStore.getState().zoomByColumn;
const cmd = (key: string) => fireEvent.keyDown(window, { key, metaKey: true });

/** Open the left pair, so all five regions exist. */
function twoPairs() {
  useProjectStore.setState({
    projects: [
      mkProject("p1", "Alpha", [mkAgent("a1")]),
      mkProject("p2", "Beta", [mkAgent("a2")]),
    ],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: ["a1", "a2"], status: {} } as never);
  useUiStore.setState({ pairAssignment: { p2: "left" }, openProjectIds: ["p1", "p2"] } as never);
}

describe("Cmd +/- sizes the column that has focus", () => {
  beforeEach(() => {
    twoPairs();
    useUiStore.getState().resetAllZoom();
  });

  it("renders all FIVE zoomable regions in the two-pair cockpit", () => {
    // The precondition for everything below, asserted once so a case that silently lost a region
    // cannot pass by resolving to null and taking the do-nothing branch.
    render(<Workspace />);
    const marked = Array.from(document.querySelectorAll("[data-zoom-column]")).map((el) =>
      el.getAttribute("data-zoom-column"),
    );
    expect(new Set(marked)).toEqual(
      new Set(["terminal-left", "build-left", "concierge", "build-right", "terminal-right"]),
    );
  });

  it("zooms the LEFT build column and leaves the right one alone", () => {
    // The founder's sentence, as a test: "If I'm in a build agent column, I can change the size of
    // that one column. Build column, I change the other build column."
    render(<Workspace />);
    pressIn(screen.getByTestId("sidebar-left"));
    cmd("=");
    expect(levels()["build-left"]).toBeGreaterThan(1);
    expect(levels()["build-right"]).toBe(1);
    expect(levels()["concierge"]).toBe(1);
    expect(levels()["terminal-left"]).toBe(1);
    expect(levels()["terminal-right"]).toBe(1);
  });

  it("zooms the RIGHT build column independently of the left", () => {
    render(<Workspace />);
    pressIn(screen.getByTestId("sidebar-left"));
    cmd("=");
    pressIn(screen.getByTestId("sidebar-right"));
    cmd("-");
    expect(levels()["build-left"]).toBeGreaterThan(1);
    expect(levels()["build-right"]).toBeLessThan(1);
  });

  it("zooms the CONCIERGE when the press was inside it", () => {
    // The concierge is the column the old global zoom could never address: it had no reader at all,
    // so pressing Cmd+= here silently resized every terminal instead.
    render(<Workspace />);
    pressIn(screen.getByTestId("concierge"));
    cmd("=");
    expect(levels()["concierge"]).toBeGreaterThan(1);
    expect(levels()["terminal-right"]).toBe(1);
  });

  it("zooms each TERMINAL stage independently", () => {
    render(<Workspace />);
    pressIn(screen.getByTestId("terminal-stage-left"));
    cmd("=");
    expect(levels()["terminal-left"]).toBeGreaterThan(1);
    expect(levels()["terminal-right"]).toBe(1);

    pressIn(screen.getByTestId("terminal-stage"));
    cmd("=");
    expect(levels()["terminal-right"]).toBeGreaterThan(1);
  });

  it("Cmd+0 resets ONLY the focused column", () => {
    render(<Workspace />);
    pressIn(screen.getByTestId("sidebar-left"));
    cmd("=");
    pressIn(screen.getByTestId("sidebar-right"));
    cmd("=");
    const rightBefore = levels()["build-right"];

    pressIn(screen.getByTestId("sidebar-left"));
    cmd("0");
    expect(levels()["build-left"]).toBe(1);
    // A Cmd+0 that reset everything would be a different feature, and would quietly discard the
    // sizes the user set on the other four columns.
    expect(levels()["build-right"]).toBe(rightBefore);
  });

  // ── THE REFUSALS ────────────────────────────────────────────────────────────────────────────
  it("does NOTHING when no column has been touched yet", () => {
    // A fresh launch: nothing pressed, focus on `<body>`. Requirement 4 — "if focus is ambiguous or
    // in no column, do nothing rather than guessing".
    render(<Workspace />);
    cmd("=");
    cmd("-");
    cmd("0");
    for (const key of Object.keys(levels())) expect(levels()[key as keyof typeof levels]).toBe(1);
  });

  it("does NOTHING after a press outside every column", () => {
    render(<Workspace />);
    pressIn(screen.getByTestId("sidebar-left"));
    cmd("=");
    const after = levels()["build-left"];

    // A deliberate press elsewhere — the shell root, which is no column.
    pressIn(screen.getByTestId("workspace-shell"));
    cmd("=");
    expect(levels()["build-left"]).toBe(after);
  });

  it("does not swallow the key when it refuses, so the shortcut is inapplicable and not broken", () => {
    render(<Workspace />);
    const e = new KeyboardEvent("keydown", { key: "=", metaKey: true, cancelable: true, bubbles: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it("DOES swallow the key when it acts, so the webview's own zoom cannot double-fire", () => {
    render(<Workspace />);
    pressIn(screen.getByTestId("concierge"));
    const e = new KeyboardEvent("keydown", { key: "=", metaKey: true, cancelable: true, bubbles: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it("ignores a bare +/- with no Cmd held", () => {
    render(<Workspace />);
    pressIn(screen.getByTestId("concierge"));
    fireEvent.keyDown(window, { key: "=" });
    expect(levels()["concierge"]).toBe(1);
  });
});

// THE COLUMN-FLOOR RULE IS NOT ASSERTED HERE ANY MORE, and the reason is worth recording rather
// than leaving as an absence.
//
// This file briefly carried a describe pinning `minWidth: 50px` on three column roots and
// `overflow-x: auto` on the row. Those asserted MY width design — no ceilings at all, with the row
// scrolling when the columns outgrew it. While that work was in review, the same feature landed on
// main independently (PR #1063, "one 50px floor for every column") with a DIFFERENT design: the
// floor is the same 50px, but each column's ceiling is derived from the window so that every other
// column keeps its own 50px, and nothing ever leaves the screen.
//
// Main's version is the one that ships, so its rules are pinned by ITS tests
// (`engine/columnResize.test.ts`, `Workspace.resize.test.tsx`). Re-asserting a superseded design
// here would have been a second, contradicting declaration of the row's layout — exactly the
// "one constant, two files" drift `engine/columnResize` exists to prevent.
