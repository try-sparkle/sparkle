// @vitest-environment jsdom
//
// THE COCKPIT — the shell's layout contract and the cable's two unbind gestures, asserted on the
// real DOM the app renders.
//
// The user sits centred on the concierge like an F1 driver:
//
//     TERM │ BUILD │ CONCIERGE │ BUILD │ TERM
//
// Four things these pin, each of which the shell got wrong or lacked before:
//
//   1. `data-pairs` / `data-wired` live on the shell ROOT — one value, so every visual consequence
//      can follow from CSS instead of scattered component state (MAPPING.md's explicit instruction).
//   2. The project tabs belong to the PAIR. Build and terminal are one project; the strip sits above
//      the pair and NEVER above the concierge. It used to be a full-width bar spanning everything.
//   3. Escape and a click off a build agent row are the SAME single state change — unbind.
//   4. Wiring docks the overlay: a floating concierge sits on top of the very row it claims to be
//      wired to, so those two states cannot both be true.
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

vi.mock("./AgentPane", () => ({
  AgentPane: ({ agent }: { agent: { id: string } }) => <div data-testid={`pane-${agent.id}`} />,
}));
// The sidebar stub publishes the SAME accessibility structure the real one does — a
// `[data-agent-tree]` container of `role="treeitem"` rows. That structure is what the click-away
// gesture recognises a build agent row by (engine/cable's BUILD_ROW_SELECTOR), so a stub without it
// would make the "clicking a row does not unbind" case vacuously pass.
vi.mock("./AgentSidebar", () => ({
  AgentSidebar: () => (
    <div data-testid="sidebar">
      <div role="tree" aria-label="Build agents" data-agent-tree>
        <div role="treeitem" aria-selected data-testid="fake-row">
          <span data-testid="fake-row-label">Stripe checkout retry</span>
        </div>
      </div>
    </div>
  ),
  NewBuildAgentButton: () => null,
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

import { Pair, Workspace } from "./Workspace";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuthStore } from "../stores/authStore";
import { useConnectionStore } from "../stores/connectionStore";
import { markProjectVisited, resetVisitedProjects } from "../services/sessionProjects";
import { resetCable, useCableStore } from "../stores/cableStore";
import { openProjectTab } from "../services/openProjectTab";
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
afterEach(() => {
  cleanup();
  resetCable();
});

const shell = () => screen.getByTestId("workspace-shell");
const patch = (side: "left" | "right") => act(() => useCableStore.getState().patch(side));

// ── 1. THE STATE LIVES ON THE ROOT ────────────────────────────────────────────────────────────
describe("the shell root carries the whole cockpit state", () => {
  it("publishes data-pairs and data-wired, unplugged at rest", () => {
    render(<Workspace />);
    expect(shell().getAttribute("data-pairs")).toBe("1");
    expect(shell().getAttribute("data-wired")).toBe("off");
    expect(shell().getAttribute("data-over")).toBe("off");
  });

  it("projects the patched side onto data-wired", () => {
    render(<Workspace />);
    patch("right");
    expect(shell().getAttribute("data-wired")).toBe("right");

    // ONE LIVE CIRCUIT — patching the other side MOVES the cable, never lights both. Seeded with a
    // real LEFT pair, because `data-wired` is a projection now, not a mirror: it names a side only
    // when there is an agent on the far end of the cable. This used to patch left with no left pair
    // in the fixture at all and assert "left" anyway — i.e. it pinned the lit-cable-with-nothing-
    // there state as the contract, which is the bug the projection exists to make unrepresentable.
    act(() => {
      useUiStore.setState({ pairAssignment: { p2: "left" }, leftProjectId: "p2" } as never);
      useProjectStore.setState({
        projects: [
          mkProject("p1", "Alpha", [mkAgent("a1")], "a1"),
          mkProject("p2", "Beta", [mkAgent("b1")], "b1"),
        ],
      } as never);
    });
    patch("left");
    expect(shell().getAttribute("data-wired")).toBe("left");
  });

  // THE STATE AN ACQUISITION GUARD CANNOT PREVENT, because nothing is being acquired: patch a side,
  // then empty it. `selectAndWire` refuses to patch when it seats no agent, and that closes one
  // route; switching the wired pair to an agent-less project or closing its last agent closes
  // nothing. Left unprojected, the shell floods that pair and recedes the other while the compose
  // box falls back to Sparkle — a lit cable whose prompt goes somewhere else (roborev 55249).
  it("reports OFF when the wired side has no agent on the far end", () => {
    render(<Workspace />);
    patch("right");
    expect(shell().getAttribute("data-wired")).toBe("right");
    act(() => {
      useProjectStore.setState({
        projects: [mkProject("p1", "Alpha", [mkAgent("a1")], null as never)],
      } as never);
    });
    expect(shell().getAttribute("data-wired")).toBe("off");
    // The STORE still holds the patch — this is a read-side projection, so nothing had to remember
    // to unbind and re-selecting an agent lights it again with no second gesture.
    expect(useCableStore.getState().wired).toBe("right");
  });

  // The whole point of the attribute: nothing else needs to change for the app to look wired, so a
  // future consumer (the concierge's flood, the receding pair) reads this one element.
  it("keeps data-wired on ONE element — the shell root, not scattered per column", () => {
    render(<Workspace />);
    patch("right");
    expect(document.querySelectorAll("[data-wired]")).toHaveLength(1);
  });
});

// ── 2. THE PAIR OWNS ITS TABS ─────────────────────────────────────────────────────────────────
describe("the pair", () => {
  it("puts the project tabs inside the pair, never above the concierge", () => {
    render(<Workspace />);
    const pair = screen.getByTestId("pair-right");
    expect(pair.contains(screen.getByTestId("project-tabs-strip"))).toBe(true);
    // The concierge is a SIBLING of the pair, so a strip inside the pair cannot span it.
    expect(pair.contains(screen.getByTestId("concierge"))).toBe(false);
  });

  it("holds build and terminal as one unsplit unit, build first", () => {
    render(<Workspace />);
    const cols = screen.getByTestId("pair-cols-right");
    expect(cols.contains(screen.getByTestId("sidebar"))).toBe(true);
    expect(cols.contains(screen.getByTestId("terminal-stage"))).toBe(true);
    // [build, terminal] in DOM order on BOTH sides — the mirror reverses the flow, not the markup,
    // so reading order and tab order are identical left and right. index.css's
    // `.paircols > :first-child` selector depends on exactly this.
    expect(cols.firstElementChild).toBe(screen.getByTestId("sidebar"));
  });

  it("mirrors: build stays adjacent to the concierge on both sides", () => {
    const { getByTestId } = render(
      <>
        <Pair side="left" tabs={<i />}>
          <div data-testid="l-build" />
          <div data-testid="l-term" />
        </Pair>
        <Pair side="right" tabs={<i />}>
          <div data-testid="r-build" />
          <div data-testid="r-term" />
        </Pair>
      </>,
    );
    // Left pair reads TERM │ BUILD │ concierge — the terminal is outboard, so the flow reverses.
    expect(getByTestId("pair-cols-left").style.flexDirection).toBe("row-reverse");
    expect(getByTestId("pair-cols-right").style.flexDirection).toBe("row");
    // …and the DOM order is untouched by the mirror.
    expect(getByTestId("pair-cols-left").firstElementChild).toBe(getByTestId("l-build"));
  });

  it("publishes data-side so the seam and the tab mirror are pure CSS", () => {
    render(<Workspace />);
    expect(screen.getByTestId("pair-right").getAttribute("data-side")).toBe("right");
    expect(screen.getByTestId("project-tabs-strip").getAttribute("data-side")).toBe("right");
  });
});

// ── 3. THE UNBIND GESTURES ────────────────────────────────────────────────────────────────────
describe("unbinding", () => {
  it("ESCAPE returns the concierge to floating middle", () => {
    render(<Workspace />);
    patch("right");
    expect(shell().getAttribute("data-wired")).toBe("right");
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(shell().getAttribute("data-wired")).toBe("off");
  });

  it("clicking anywhere that is NOT a build agent row does the same", () => {
    render(<Workspace />);
    patch("left");
    act(() => {
      fireEvent.pointerDown(screen.getByTestId("terminal-stage"));
    });
    expect(shell().getAttribute("data-wired")).toBe("off");
  });

  it("clicking a build agent row does NOT unbind — that is how you patch", () => {
    render(<Workspace />);
    patch("right");
    act(() => {
      fireEvent.pointerDown(screen.getByTestId("fake-row-label"));
    });
    expect(shell().getAttribute("data-wired")).toBe("right");
  });

  // Escape is a busy key (modals, the palette, a rename input). Unwired, this listener must decide
  // nothing, so it cannot become a second handler competing for every press.
  it("is inert while nothing is patched", () => {
    render(<Workspace />);
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.pointerDown(screen.getByTestId("terminal-stage"));
    });
    expect(shell().getAttribute("data-wired")).toBe("off");
  });

  it("survives a handler that stops propagation — the gesture listens in capture", () => {
    // FIRES ON THE SHELL ROOT, NOT THE TERMINAL. This used to press `terminal-stage` and expect an
    // unbind, which encoded the very defect roborev 54697 found: the terminal of the pair you are
    // PATCHED INTO is part of the live circuit, and pressing it must not drop the cable. The
    // capture-phase claim is orthogonal to which surface is used, so it is made on a surface that
    // genuinely sits outside the circuit.
    render(<Workspace />);
    patch("right");
    const root = shell();
    const swallow = (e: Event) => e.stopPropagation();
    root.addEventListener("pointerdown", swallow);
    act(() => {
      fireEvent.pointerDown(root);
    });
    root.removeEventListener("pointerdown", swallow);
    expect(shell().getAttribute("data-wired")).toBe("off");
  });

  // ── THE CIRCUIT IS NOT JUST THE ROW (roborev 54697) ─────────────────────────────────────────
  // The predicate was "unbind unless the press hit a build agent row", which made the wired state
  // unreachable: the primary flow is patch-then-TYPE, and the first click of that flow — into the
  // compose box — dropped the cable. These pin the three surfaces that are part of the circuit.
  it("pressing inside Sparkle does NOT unbind — patch, then type, is the primary flow", () => {
    render(<Workspace />);
    patch("right");
    const concierge = document.querySelector("[data-concierge-root]");
    expect(concierge).not.toBeNull();
    act(() => {
      fireEvent.pointerDown(concierge!);
    });
    expect(shell().getAttribute("data-wired")).toBe("right");
  });

  it("pressing the WIRED pair's own terminal does NOT unbind", () => {
    render(<Workspace />);
    patch("right");
    act(() => {
      fireEvent.pointerDown(screen.getByTestId("terminal-stage"));
    });
    expect(shell().getAttribute("data-wired")).toBe("right");
  });

  it("Escape does not unbind while a dismissible surface owns the press", () => {
    // Fifteen components treat Escape as "close me". With a cable patched, one Escape aimed at a
    // modal produced TWO state changes and the unasked-for one was invisible until reflow.
    render(<Workspace />);
    patch("right");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(shell().getAttribute("data-wired")).toBe("right");
    dialog.remove();
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(shell().getAttribute("data-wired")).toBe("off");
  });
});

// ── 4. WIRING DOCKS THE OVERLAY ───────────────────────────────────────────────────────────────
describe("wiring and the overlay cannot both be true", () => {
  it("patching a cable ends a floating concierge", () => {
    render(<Workspace />);
    act(() => useCableStore.getState().overlayTo("assist"));
    expect(shell().getAttribute("data-over")).toBe("assist");
    patch("right");
    expect(shell().getAttribute("data-over")).toBe("off");
    expect(shell().getAttribute("data-wired")).toBe("right");
  });

  it("floating the concierge over a wired row unbinds it", () => {
    render(<Workspace />);
    patch("left");
    act(() => useCableStore.getState().overlayTo("assist"));
    expect(shell().getAttribute("data-wired")).toBe("off");
    expect(shell().getAttribute("data-over")).toBe("assist");
  });
});

// ── 5. THE SECOND PAIR ────────────────────────────────────────────────────────────────────────
//
// The left half of `TERM │ BUILD │ CONCIERGE │ BUILD │ TERM`. The interesting assertions here are
// not "does a second column appear" — they are about OWNERSHIP: a project's panes must be mounted
// in exactly one stage. Zero means dead terminals under a live tab; two means two xterms on one
// PTY, which is what `pty_spawn`'s `sessions.insert` orphans a child process over.
describe("the second pair", () => {
  /** Two projects, both visited so both sets of panes are eligible to mount. */
  const twoProjects = () => {
    useProjectStore.setState({
      projects: [
        mkProject("p1", "Alpha", [mkAgent("a1")], "a1"),
        mkProject("p2", "Beta", [mkAgent("a2")], "a2"),
      ],
      selectedProjectId: "p1",
    } as never);
    useRuntimeStore.setState({ openAgentIds: ["a1", "a2"], status: {} } as never);
    markProjectVisited("p1");
    markProjectVisited("p2");
  };
  const sendLeft = (id: string) =>
    act(() => useUiStore.getState().assignProjectToPair(id, "left"));

  it("renders ONE pair until something is assigned to the left", () => {
    // The upgrade path: an install that has never used the left pair must get byte-identical
    // layout to the shell it had, which is what the sparse "absent means right" map buys.
    twoProjects();
    render(<Workspace />);
    expect(shell().getAttribute("data-pairs")).toBe("1");
    expect(screen.queryByTestId("pair-left")).toBeNull();
  });

  it("renders the left pair as soon as a project is sent there", () => {
    twoProjects();
    render(<Workspace />);
    sendLeft("p2");
    expect(shell().getAttribute("data-pairs")).toBe("2");
    expect(screen.getByTestId("pair-left")).toBeTruthy();
  });

  // THE INVARIANT. Not "the left pane exists" — that would pass with the pane rendered in both
  // stages, which is the failure mode that costs a user their terminal.
  it("mounts each project's panes in EXACTLY ONE stage", () => {
    twoProjects();
    render(<Workspace />);
    sendLeft("p2");

    // Exactly one of each — never two.
    expect(screen.getAllByTestId("pane-a1")).toHaveLength(1);
    expect(screen.getAllByTestId("pane-a2")).toHaveLength(1);
    // …and each in ITS OWN pair's stage.
    const left = screen.getByTestId("terminal-stage-left");
    const right = screen.getByTestId("terminal-stage");
    expect(left.contains(screen.getByTestId("pane-a2"))).toBe(true);
    expect(left.contains(screen.getByTestId("pane-a1"))).toBe(false);
    expect(right.contains(screen.getByTestId("pane-a1"))).toBe(true);
    expect(right.contains(screen.getByTestId("pane-a2"))).toBe(false);
  });

  it("gives each pair its own tab strip, listing only that pair's projects", () => {
    twoProjects();
    render(<Workspace />);
    sendLeft("p2");
    const leftPair = screen.getByTestId("pair-left");
    const rightPair = screen.getByTestId("pair-right");
    // A tab naming a project the OTHER pair holds would let a click select a project whose panes
    // are mounted in the other stage — agent rows with no terminal beside them.
    expect(leftPair.textContent).toContain("Beta");
    expect(leftPair.textContent).not.toContain("Alpha");
    expect(rightPair.textContent).toContain("Alpha");
    expect(rightPair.textContent).not.toContain("Beta");
  });

  it("collapses back to one pair when the last left project is sent back", () => {
    // Derived from the assignment map, so "an empty left pair" is unrepresentable rather than a
    // state someone has to remember to clean up.
    twoProjects();
    render(<Workspace />);
    sendLeft("p2");
    expect(shell().getAttribute("data-pairs")).toBe("2");
    act(() => useUiStore.getState().assignProjectToPair("p2", "right"));
    expect(shell().getAttribute("data-pairs")).toBe("1");
    expect(screen.queryByTestId("pair-left")).toBeNull();
    // The panes came back rather than vanishing with the pair.
    expect(screen.getAllByTestId("pane-a2")).toHaveLength(1);
  });

  it("does not let the left pair move the app-wide current project", () => {
    // `selectedProjectId` means "the current project" to the concierge feed, notifications, capture
    // and satellite ownership. The left pair having its own slot is what keeps those ten call sites
    // meaning what they meant.
    twoProjects();
    render(<Workspace />);
    sendLeft("p2");
    expect(useProjectStore.getState().selectedProjectId).toBe("p1");
  });

  it("drops a stale assignment when its project is gone", () => {
    // Otherwise the entry keeps the pair open forever with no tab in it and no way to close it.
    twoProjects();
    render(<Workspace />);
    sendLeft("p2");
    expect(shell().getAttribute("data-pairs")).toBe("2");
    act(() => {
      useProjectStore.setState({
        projects: [mkProject("p1", "Alpha", [mkAgent("a1")], "a1")],
        selectedProjectId: "p1",
      } as never);
    });
    expect(shell().getAttribute("data-pairs")).toBe("1");
    expect(useUiStore.getState().pairAssignment).toEqual({});
  });

  // THE RELAUNCH SHAPE — the bug the tests above could not see, because `twoProjects()` marks both
  // projects visited by hand and so pre-satisfies the mount gate. `pairAssignment`/`leftProjectId`
  // are PERSISTED; the visited set is module-level and is NOT. So a cold launch restores a left pair
  // whose strip and sidebar are full while its stage is blank, and no click can repair it because
  // the gate is per PROJECT. (roborev 55149)
  it("mounts the left pair's panes on a cold launch, with nothing visited", () => {
    useProjectStore.setState({
      projects: [
        mkProject("p1", "Alpha", [mkAgent("a1")], "a1"),
        mkProject("p2", "Beta", [mkAgent("a2")], "a2"),
      ],
      selectedProjectId: "p1",
    } as never);
    useRuntimeStore.setState({ openAgentIds: ["a1", "a2"], status: {} } as never);
    // Exactly what a relaunch looks like: assignment restored from the blob, visited set empty.
    resetVisitedProjects();
    useUiStore.setState({ pairAssignment: { p2: "left" }, leftProjectId: "p2" } as never);

    render(<Workspace />);

    expect(screen.getByTestId("pair-left")).toBeTruthy();
    const left = screen.getByTestId("terminal-stage-left");
    expect(left.contains(screen.getByTestId("pane-a2"))).toBe(true);
  });

  // Every cross-app "show me this project" path funnels through `openProjectTab` — notifications,
  // the palette, history, the concierge and its tools. Before this it always wrote the RIGHT pair's
  // selection, so revealing a left-pair agent either did nothing or yanked the right pair away.
  it("routes a reveal of a left-assigned project INTO the left pair", () => {
    twoProjects();
    render(<Workspace />);
    sendLeft("p2");
    act(() => useProjectStore.getState().selectProject("p1"));
    act(() => openProjectTab("p2"));
    expect(useUiStore.getState().leftProjectId).toBe("p2");
    // …and it did NOT drag the right pair off its own project.
    expect(useProjectStore.getState().selectedProjectId).toBe("p1");
  });

  // Assigning alone left the destination pair's selection where it was, so sending a SECOND project
  // across mounted its panes invisibly and the control read as "does nothing but grow a tab".
  it("moves the selection with the project", () => {
    useProjectStore.setState({
      projects: [
        mkProject("p1", "Alpha", [mkAgent("a1")], "a1"),
        mkProject("p2", "Beta", [mkAgent("a2")], "a2"),
        mkProject("p3", "Gamma", [mkAgent("a3")], "a3"),
      ],
      selectedProjectId: "p1",
    } as never);
    useRuntimeStore.setState({ openAgentIds: ["a1", "a2", "a3"], status: {} } as never);
    markProjectVisited("p1");
    markProjectVisited("p2");
    markProjectVisited("p3");
    render(<Workspace />);
    sendLeft("p2");
    act(() => openProjectTab("p2"));
    expect(useUiStore.getState().leftProjectId).toBe("p2");
    // Now send a second one across; the left pair must follow it rather than stay on Beta.
    sendLeft("p3");
    act(() => openProjectTab("p3"));
    expect(useUiStore.getState().leftProjectId).toBe("p3");
    expect(screen.getByTestId("terminal-stage-left").contains(screen.getByTestId("pane-a3"))).toBe(true);
  });
});
