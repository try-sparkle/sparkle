// @vitest-environment jsdom
//
// IMPROVE SPARKLE IS PINNED TO ONE BUILD COLUMN, NOT BOTH.
//
// The founder runs a build column on the LEFT and the RIGHT of the concierge and saw Improve
// Sparkle in both. His decision, verbatim: "just show improve sparkle on the right build column,
// not the left one." Bead sparkle-x0pvw.
//
// THE DUPLICATE WAS NEVER USABLE, which is why this is a bug and not a preference. The row's
// selected paint keys on `paneCoversMe = pairSide === SPARKLE_PANE_SIDE && activeSpecial !== null`
// (AgentSidebar), and `SPARKLE_PANE_SIDE` is the constant `"right"`. In the LEFT column that is
// permanently false, so the row painted `background: "transparent"` over the shell's `deepForest`
// with idle radius and no fillets — the black row he reported — while a click on it patched the
// cable LEFT and mounted the pane RIGHT. `Workspace`'s own comment on the left pair already said it
// "carries no Sparkle pane": the PANE was excluded from that pair and the ROW was not.
//
// WHAT THIS PINS IS THE PROP `Workspace` PASSES, not the row's own rendering. `showSparkleRow`
// already existed and already worked (the satellite window passes false) — the defect was entirely
// that the left column never asked. Asserting through a stubbed sidebar is what makes that the
// subject: a test rendering the real sidebar would still pass if `Workspace` dropped the prop and
// the row happened to be filtered away for some other reason.
//
// BOTH SIDES ARE ASSERTED IN EVERY TEST, deliberately. "The left column has no Sparkle row" is
// equally satisfied by a Workspace that renders it in NEITHER column — which would break the mount
// the founder explicitly wants kept ("I do want it to be able to mount"). The right column's row is
// the half that makes the left column's absence mean something.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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
vi.mock("./AgentPane", () => ({
  AgentPane: ({ agent }: { agent: { id: string } }) => <div data-testid={`pane-${agent.id}`} />,
}));
// THE STUB RECORDS THE PROP, and records it as the string "true"/"false"/"unset" rather than a
// boolean attribute. `showSparkleRow` DEFAULTS TO TRUE in the real component, so "the attribute is
// absent" and "the prop was false" are opposite facts that a boolean attribute would flatten into
// the same missing-attribute reading.
vi.mock("./AgentSidebar", () => ({
  AgentSidebar: ({
    slotSide = "right",
    showSparkleRow,
  }: {
    slotSide?: string;
    showSparkleRow?: boolean;
  }) => (
    <div
      data-testid={`sidebar-${slotSide}`}
      data-show-={showSparkleRow === undefined ? "unset" : String(showSparkleRow)}
    />
  ),
}));
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

import { Workspace } from "./Workspace";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuthStore } from "../stores/authStore";
import { useConnectionStore } from "../stores/connectionStore";
import { markProjectVisited, resetVisitedProjects } from "../services/sessionProjects";
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
  return {
    id, name, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId, agents,
  };
}

/** TWO PAIRS, TWO PROJECTS: p1 on the right (the primary pair), p2 on the left — the founder's
 *  actual layout, and the only configuration in which the duplicate can appear at all. */
beforeEach(() => {
  useProjectStore.setState({
    projects: [
      mkProject("p1", "Alpha", [mkAgent("a1")], "a1"),
      mkProject("p2", "Beta", [mkAgent("a2")], "a2"),
    ],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: ["a1", "a2"], status: {} } as never);
  useUiStore.setState({
    activeSpecial: null,
    workModeBySide: { left: "build", right: "build" },
    pinnedProjectId: null, openProjectIds: null,
    pairAssignment: { p2: "left" }, leftProjectId: "p2",
  } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false } as never);
  useConnectionStore.setState({ isOnline: true } as never);
  resetVisitedProjects();
  markProjectVisited("p1");
  markProjectVisited("p2");
  resetCable();
});
afterEach(() => {
  cleanup();
  resetCable();
});

const sparkleRowFlag = (side: "left" | "right") =>
  screen.getByTestId(`sidebar-${side}`).getAttribute("data-show-");

describe("Improve Sparkle appears in the RIGHT build column only", () => {
  it("suppresses the row on the left and keeps it on the right", () => {
    render(<Workspace />);
    // THE FIX. Against the pre-fix Workspace this reads "unset" — the prop defaults to true, which
    // is the duplicate row.
    expect(sparkleRowFlag("left")).toBe("false");
    // THE OTHER HALF, and the reason this is one test rather than two: hiding the row everywhere
    // would satisfy the line above while breaking the mount the founder asked to keep. The right
    // column must still be asking for it — by default, which is what leaves the main window's
    // single-pair layout byte-identical.
    expect(sparkleRowFlag("right")).not.toBe("false");
  });

  it("still renders BOTH build columns — the row is hidden, the column is not", () => {
    // The guard against "fixing" the duplicate by dropping the left sidebar altogether. The founder
    // talked himself out of removing Improve Sparkle from the build columns mid-sentence; removing
    // the column that would have held it is the same mistake one level up.
    render(<Workspace />);
    expect(screen.getByTestId("sidebar-left")).toBeTruthy();
    expect(screen.getByTestId("sidebar-right")).toBeTruthy();
  });

  it("leaves the SINGLE-pair layout untouched — no left column, row still on the right", () => {
    // The left pair renders only when a project is assigned to it. An install that has never used
    // the second pair must be byte-identical to before this change, so the suppression must ride on
    // the left pair's own render rather than on any global.
    useUiStore.setState({ pairAssignment: {}, leftProjectId: null } as never);
    render(<Workspace />);
    expect(screen.queryByTestId("sidebar-left")).toBe(null);
    expect(sparkleRowFlag("right")).not.toBe("false");
  });
});
