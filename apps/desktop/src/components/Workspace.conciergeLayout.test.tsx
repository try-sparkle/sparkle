// @vitest-environment jsdom
//
// THE CONCIERGE LAYOUT PICKER, asserted on the real shell (epic sparkle-5ua3br).
//
// Settings → Appearance → Layout offers three buttons, and each must rearrange the row EXACTLY as
// the founder described it:
//
//   right  — TERM │ BUILD │ EPICS │ CONCIERGE
//   center — TERM │ BUILD │ EPICS │ CONCIERGE │ EPICS │ BUILD │ TERM
//   left   — CONCIERGE │ EPICS │ BUILD │ TERM
//
// jsdom has no layout engine, so "visual order" is computed the way the browser computes it: the row
// is a flex container, so its children paint in (CSS `order`, DOM index) order, and inside a pair the
// columns paint in DOM order under `row`, reversed under `row-reverse`. The suite reads those two
// properties off the rendered DOM — the same two the shell uses to lay the row out — and mounts every
// candidate pair at once, so an assertion that a pair is ABSENT is never made against a tree that
// could not have contained it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

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
// PARTIAL, not a replacement: the real module also exports the reserved-id constants
// (SPARKLE_AGENT_ID / SPARKLE_PROJECT_ID / isSparkleAgentId), which other modules in this render
// tree now import transitively. A whole-module mock silently drops them, and the failure surfaces as
// an unrelated import error in whichever file happens to need one — so spread the original and
// override only the three launch decisions this suite is steering.
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
  sparkleAgentIdFor: () => "sparkle",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));

// The pane stub publishes the same TERMINAL structure the real one does — the app-owned
// `data-terminal-surface` host wrapping xterm's hidden `.xterm-helper-textarea`, which is the node
// that actually holds the caret in a focused terminal. That structure is what `voice/dictationFocus`
// recognises a live PTY by, and it is how the window key listener decides an Escape belongs to the
// process rather than to the cable. A stub without it would make the terminal-Escape cases below
// vacuously pass — the same trap the sidebar stub note describes. Written as the literal attribute,
// not the imported constant, for the same reason the sidebar stub hardcodes `data-agent-tree`: the
// stub is asserting the contract, not inheriting it.
vi.mock("./AgentPane", () => ({
  AgentPane: ({ agent }: { agent: { id: string } }) => (
    <div data-testid={`pane-${agent.id}`}>
      <div data-terminal-surface="">
        <textarea className="xterm-helper-textarea" data-testid={`term-sink-${agent.id}`} />
      </div>
    </div>
  ),
}));
// The sidebar stub publishes the SAME accessibility structure the real one does — a
// `[data-agent-tree]` container of `role="treeitem"` rows. That structure is what the click-away
// gesture recognises a build agent row by (engine/cable's BUILD_ROW_SELECTOR), so a stub without it
// would make the "clicking a row does not unbind" case vacuously pass.
// THE STUB PUBLISHES `slotSide`, and that is load-bearing rather than tidy. The real component only
// consults the prop when `project` is null, which is exactly the state the left stage renders in when
// its tab is closed — and the prop's default is "right", so deleting `slotSide="left"` from the JSX is
// SILENT: the component-level row keeps passing (it hands the prop in by hand) while the empty left
// column goes back to seeding from and clobbering the right column's width (roborev 55539). A stub
// that dropped the prop could not tell the two apart.
vi.mock("./AgentSidebar", () => ({
  AgentSidebar: ({ slotSide = "right" }: { slotSide?: string }) => (
    <div data-testid="sidebar" data-slot-side={slotSide}>
      <div role="tree" aria-label="Build agents" data-agent-tree>
        <div role="treeitem" aria-selected data-testid="fake-row">
          <span data-testid="fake-row-label">Stripe checkout retry</span>
        </div>
      </div>
    </div>
  ),
}));
vi.mock("./ConciergeHost", () => ({ ConciergeHost: () => <div data-testid="concierge" /> }));
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
import { ConciergeLayoutToggle } from "./ConciergeLayoutToggle";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuthStore } from "../stores/authStore";
import { useConnectionStore } from "../stores/connectionStore";
import { resetVisitedProjects } from "../services/sessionProjects";
import { resetCable } from "../stores/cableStore";
import type { ConciergeLayout } from "../engine/pairs";
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

beforeEach(() => {
  useProjectStore.setState({
    projects: [mkProject("p1", "Alpha", [mkAgent("a1")], "a1"), mkProject("p2", "Beta", [mkAgent("b1")], "b1")],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: ["a1", "b1"], status: {} } as never);
  useUiStore.setState({
    activeSpecial: null, workModeBySide: { left: "build", right: "build" }, pinnedProjectId: null,
    openProjectIds: null, pairAssignment: {}, leftProjectId: null, conciergeLayout: "left",
  } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false } as never);
  useConnectionStore.setState({ isOnline: true } as never);
  resetVisitedProjects();
  resetCable();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  resetCable();
});

const shell = () => screen.getByTestId("workspace-shell");
const choose = (layout: ConciergeLayout) => act(() => useUiStore.getState().setConciergeLayout(layout));

/** The row's columns in PAINT order: each pair expanded into its own columns (epics, build,
 *  terminal — reversed under `row-reverse`), the concierge as one entry. */
function paintedRow(): string[] {
  const box = screen.getByTestId("concierge-box");
  const row = box.closest("[data-concierge-root]")!.parentElement!;
  const kids = Array.from(row.children)
    .filter((el) => el.tagName !== "STYLE")
    .map((el, i) => ({ el: el as HTMLElement, i, order: Number((el as HTMLElement).style.order || 0) }))
    .sort((a, b) => a.order - b.order || a.i - b.i);
  const out: string[] = [];
  for (const { el } of kids) {
    if (el.hasAttribute("data-concierge-root")) {
      out.push("CONCIERGE");
      continue;
    }
    const side = el.getAttribute("data-testid")!.replace("pair-", "");
    const cols = screen.getByTestId(`pair-cols-${side}`) as HTMLElement;
    const names = Array.from(cols.children)
      .map((c): string | null => {
        const t = c.getAttribute("data-testid") ?? "";
        if (t.startsWith("terminal-stage")) return "TERM";
        if (t === "sidebar") return "BUILD";
        if (c.querySelector("[data-testid^=epics-column]") || t.startsWith("epics")) return "EPICS";
        return null;
      })
      .filter((n): n is string => n !== null);
    out.push(...(cols.style.flexDirection === "row-reverse" ? names.reverse() : names));
  }
  return out;
}

describe("each layout lays the row out exactly as described", () => {
  it("LEFT — CONCIERGE │ EPICS │ BUILD │ TERM", () => {
    render(<Workspace />);
    choose("left");
    expect(shell().getAttribute("data-concierge-layout")).toBe("left");
    expect(paintedRow()).toEqual(["CONCIERGE", "EPICS", "BUILD", "TERM"]);
  });

  it("RIGHT — TERM │ BUILD │ EPICS │ CONCIERGE (the mirror of LEFT)", () => {
    render(<Workspace />);
    choose("right");
    expect(shell().getAttribute("data-concierge-layout")).toBe("right");
    expect(paintedRow()).toEqual(["TERM", "BUILD", "EPICS", "CONCIERGE"]);
    // Drawn as the left side, so index.css's mirroring rules (tab strip, seams) apply to it…
    expect(screen.getByTestId("pair-right").getAttribute("data-side")).toBe("left");
    // …while it stays the RIGHT pair in data: same test id, no left pair mounted.
    expect(screen.queryByTestId("pair-left")).toBeNull();
  });

  it("CENTER — TERM │ BUILD │ EPICS │ CONCIERGE │ EPICS │ BUILD │ TERM", () => {
    render(<Workspace />);
    choose("center");
    expect(shell().getAttribute("data-concierge-layout")).toBe("center");
    expect(shell().getAttribute("data-pairs")).toBe("2");
    expect(paintedRow()).toEqual(["TERM", "BUILD", "EPICS", "CONCIERGE", "EPICS", "BUILD", "TERM"]);
  });
});

describe("the concierge's seams follow its neighbours", () => {
  it("has a pull tab only on an edge with a pair beside it", () => {
    render(<Workspace />);
    const tabs = () => ({
      left: screen.queryByTestId("left-pair-pull-tab") !== null,
      right: screen.queryByTestId("concierge-pull-tab") !== null,
    });
    choose("left");
    expect(tabs()).toEqual({ left: false, right: true });
    choose("right");
    expect(tabs()).toEqual({ left: true, right: false });
    choose("center");
    expect(tabs()).toEqual({ left: true, right: true });
  });
});

describe("CENTER with nothing on the left shows an empty side that offers a project", () => {
  it("renders the left pair empty, with a picker that moves a project across", () => {
    render(<Workspace />);
    choose("center");
    expect(screen.getByTestId("pair-left")).toBeTruthy();
    expect(screen.getByTestId("left-pair-picker")).toBeTruthy();
    fireEvent.click(screen.getByTestId("left-pair-pick-p2"));
    expect(useUiStore.getState().pairAssignment).toEqual({ p2: "left" });
    expect(screen.queryByTestId("left-pair-picker")).toBeNull();
    // Choosing a one-pair layout again sends it back, and the left pair goes away.
    choose("left");
    expect(useUiStore.getState().pairAssignment).toEqual({});
    expect(screen.queryByTestId("pair-left")).toBeNull();
  });
});

describe("switching layouts never remounts a terminal", () => {
  // A Terminal unmount KILLS ITS PTY, so a layout change that re-parented the right pair would cost
  // every agent its session. RIGHT moves the pair with CSS `order`, not in JSX — pinned here by node
  // identity across every transition.
  it("keeps the same pane and stage nodes through right → center → left → right", () => {
    render(<Workspace />);
    const pane = screen.getByTestId("pane-a1");
    const stage = screen.getByTestId("terminal-stage");
    for (const layout of ["right", "center", "left", "right"] as const) {
      choose(layout);
      expect(screen.getByTestId("pane-a1")).toBe(pane);
      expect(screen.getByTestId("terminal-stage")).toBe(stage);
    }
  });
});

describe("the Appearance → Layout buttons", () => {
  it("offers right, center, left in that order and marks the current one", () => {
    render(<ConciergeLayoutToggle />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("data-testid"))).toEqual([
      "concierge-layout-right",
      "concierge-layout-center",
      "concierge-layout-left",
    ]);
    expect(screen.getByTestId("concierge-layout-left").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("concierge-layout-right").getAttribute("aria-pressed")).toBe("false");
  });

  it("each button moves the actual shell into its layout", () => {
    render(
      <>
        <ConciergeLayoutToggle />
        <Workspace />
      </>,
    );
    fireEvent.click(screen.getByTestId("concierge-layout-right"));
    expect(paintedRow()).toEqual(["TERM", "BUILD", "EPICS", "CONCIERGE"]);
    expect(screen.getByTestId("concierge-layout-right").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("concierge-layout-center"));
    expect(paintedRow()).toEqual(["TERM", "BUILD", "EPICS", "CONCIERGE", "EPICS", "BUILD", "TERM"]);
    fireEvent.click(screen.getByTestId("concierge-layout-left"));
    expect(paintedRow()).toEqual(["CONCIERGE", "EPICS", "BUILD", "TERM"]);
  });
});
