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
vi.mock("../services/sparkleAgent", () => ({
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
import { resetVisitedProjects } from "../services/sessionProjects";
import { resetCable, useCableStore } from "../stores/cableStore";
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
    patch("left");
    // ONE LIVE CIRCUIT — patching the other side MOVES the cable, never lights both.
    expect(shell().getAttribute("data-wired")).toBe("left");
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
