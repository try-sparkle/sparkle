// @vitest-environment jsdom
//
// MOVING A PROJECT BETWEEN PAIRS MUST NOT UNMOUNT ITS PANES.
//
// This is the whole cost `engine/pairs` used to document and accept: "re-assigning a project
// unmounts its panes on one side and mounts them on the other, and a Terminal unmount KILLS its PTY
// — so its agents respawn (`claude --resume`) and lose scrollback." Closing a pair moves every
// project on it, so a dozen open projects cost a dozen respawns and a dozen lost scrollbacks per
// toggle. The founder's requirement is the opposite: "all the project tabs would just move over to
// the right one. And they wouldn't lose anything."
//
// The panes are portalled now (`PaneHost` in Workspace.tsx): they are mounted once, in one fixed
// place in the React tree, and a side change moves the DOM node rather than rebuilding the
// component. These tests are what make that claim checkable.
//
// ── WHY THE ASSERTIONS LOOK LIKE THIS ──────────────────────────────────────────────────────────
// "The pane is present on the new side afterwards" is the vacuous version of this test: it was
// ALREADY TRUE of the lossy implementation, which unmounted the pane and mounted a fresh one right
// where the assertion looks. Presence cannot distinguish a move from a respawn. So the stub below
// carries the two things that CAN:
//
//   • an effect whose cleanup is the stand-in for `Terminal`'s PTY teardown. It must never run.
//   • an instance token minted once per mount. It must be the same object after the move.
//
// Both fail loudly against the pre-portal shell (see PRD/sparkle/pane-mounting.md), which is what
// makes them worth having.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

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

/** The PTY ledger. `spawns` counts mounts; `kills` counts effect cleanups — the exact thing
 *  `Terminal`'s unmount does to a real PTY. `instances` records the identity token a pane minted on
 *  the mount it is currently living in. */
const pty = vi.hoisted(() => ({
  spawns: new Map<string, number>(),
  kills: new Map<string, number>(),
  instances: new Map<string, object>(),
}));

vi.mock("./AgentPane", async () => {
  const { useEffect, useState, createElement } = await import("react");
  const Pane = ({ agent, visible }: { agent: { id: string }; visible: boolean }) => {
    // One token per MOUNT. A remount mints a new object; a move keeps this one.
    const [token] = useState(() => ({}));
    useEffect(() => {
      pty.spawns.set(agent.id, (pty.spawns.get(agent.id) ?? 0) + 1);
      pty.instances.set(agent.id, token);
      // THE PTY KILL. Cleanup runs on unmount and on nothing else, which is precisely why it is the
      // right probe: React has no other way to tell a move from a remount from the outside.
      return () => {
        pty.kills.set(agent.id, (pty.kills.get(agent.id) ?? 0) + 1);
      };
    }, [agent.id, token]);
    return createElement("div", {
      "data-testid": `pane-${agent.id}`,
      "data-visible": String(visible),
    });
  };
  return { AgentPane: Pane };
});
vi.mock("./AgentSidebar", () => ({
  AgentSidebar: () => <div data-testid="sidebar" />,
  NewBuildAgentButton: () => null,
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
function mkProject(id: string, agents: AgentTab[]): Project {
  return {
    id, name: id.toUpperCase(), rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: agents[0]!.id, agents,
  };
}

/** Three projects, two agents each — enough that "a pair closed and everything moved" is a real
 *  migration rather than a single element changing parents. */
const PROJECTS = ["p1", "p2", "p3"];
const AGENTS = PROJECTS.flatMap((p) => [`${p}-a`, `${p}-b`]);

beforeEach(() => {
  pty.spawns.clear();
  pty.kills.clear();
  pty.instances.clear();
  localStorage.clear();
  useProjectStore.setState({
    projects: PROJECTS.map((p) => mkProject(p, [mkAgent(`${p}-a`), mkAgent(`${p}-b`)])),
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: AGENTS, status: {} } as never);
  useUiStore.setState({
    activeSpecial: null, workMode: "build", pinnedProjectId: null, openProjectIds: null,
    pairAssignment: {}, leftProjectId: null,
  } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false } as never);
  useConnectionStore.setState({ isOnline: true } as never);
  resetVisitedProjects();
  // Every project counts as visited, so all six panes are mounted before the first move. The pane
  // list is lazy by design (`live` skips never-visited projects) and a project that had no panes
  // could not lose any — which would make every assertion below pass for the wrong reason.
  for (const p of PROJECTS) markProjectVisited(p);
  resetCable();
});
afterEach(() => {
  cleanup();
  resetCable();
  localStorage.clear();
});

/** Render and WAIT for the lazy pane chunk. `AgentPane` is `React.lazy`; a synchronous render leaves
 *  the stage on `PaneFallback` with nothing mounted. */
async function mount() {
  render(<Workspace />);
  await screen.findAllByTestId(/^pane-/);
}

const assign = (projectId: string, side: "left" | "right") =>
  act(() => {
    useUiStore.getState().assignProjectToPair(projectId, side);
    if (side === "left") useUiStore.getState().setLeftProject(projectId);
  });

const paneEl = (agentId: string) => screen.getByTestId(`pane-${agentId}`);
/** Which stage a pane is currently DISPLAYED in — walks up to the nearest stage, so it is immune to
 *  the portal host sitting in between. */
const stageOf = (agentId: string) =>
  paneEl(agentId).closest<HTMLElement>("[data-testid^='terminal-stage']")?.dataset.testid;

describe("a project changing pairs keeps its panes alive", () => {
  it("mounts every open agent exactly once to begin with", async () => {
    await mount();
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(AGENTS.length);
    for (const id of AGENTS) expect(pty.spawns.get(id)).toBe(1);
  });

  it("does NOT kill a PTY when its project moves to the left pair", async () => {
    await mount();
    const before = AGENTS.map((id) => pty.instances.get(id));

    assign("p1", "left");

    // THE SIDE EFFECT, stated as an absence: not one teardown ran. Against the pre-portal shell this
    // is 2 (p1's two panes), which is the respawn-and-lose-scrollback the founder asked us to end.
    expect([...pty.kills.values()]).toEqual([]);
    // …and no pane was re-created either. A remount would mint a new token AND bump `spawns`.
    expect(AGENTS.map((id) => pty.instances.get(id))).toEqual(before);
    for (const id of AGENTS) expect(pty.spawns.get(id)).toBe(1);
  });

  it("still puts the moved panes under the LEFT stage", async () => {
    // Survival is worthless if the pane ends up displayed in the wrong column, so the move has to be
    // asserted as well as the non-destruction.
    await mount();
    expect(stageOf("p1-a")).toBe("terminal-stage");

    assign("p1", "left");

    expect(stageOf("p1-a")).toBe("terminal-stage-left");
    expect(stageOf("p1-b")).toBe("terminal-stage-left");
    // The projects that did NOT move are untouched.
    expect(stageOf("p2-a")).toBe("terminal-stage");
    expect(stageOf("p3-a")).toBe("terminal-stage");
  });

  it("moves the very same DOM node rather than building a new one", async () => {
    // The strongest form of "nothing was lost": xterm's canvas, its scrollback and its WebGL context
    // all live in this subtree, and they survive a move exactly when the node does.
    await mount();
    const node = paneEl("p1-a");

    assign("p1", "left");

    expect(paneEl("p1-a")).toBe(node);
    expect(node.closest("[data-testid='terminal-stage-left']")).not.toBeNull();
  });

  it("survives a round trip — left, then back to the right", async () => {
    await mount();
    const tokens = AGENTS.map((id) => pty.instances.get(id));

    assign("p1", "left");
    assign("p1", "right");

    expect([...pty.kills.values()]).toEqual([]);
    expect(AGENTS.map((id) => pty.instances.get(id))).toEqual(tokens);
    expect(stageOf("p1-a")).toBe("terminal-stage");
  });
});

describe("CLOSING A PAIR is lossless for every project on it", () => {
  it("moves all of them back with no teardown at all", async () => {
    // The expensive case, and the one the founder described. Two projects on the left, then the pair
    // is closed by sending both back: four panes migrate. Pre-portal that is four PTY kills, four
    // `claude --resume` spawns and four lost scrollbacks in one gesture.
    await mount();
    assign("p1", "left");
    assign("p2", "left");
    expect(screen.getByTestId("workspace-shell").getAttribute("data-pairs")).toBe("2");
    // Nothing has been lost getting INTO the two-pair state either.
    expect([...pty.kills.values()]).toEqual([]);
    const tokens = AGENTS.map((id) => pty.instances.get(id));

    assign("p1", "right");
    assign("p2", "right");

    // The left pair is gone…
    expect(screen.getByTestId("workspace-shell").getAttribute("data-pairs")).toBe("1");
    expect(screen.queryByTestId("terminal-stage-left")).toBeNull();
    // …and every pane came with it, same instance, no teardown.
    expect([...pty.kills.values()]).toEqual([]);
    expect(AGENTS.map((id) => pty.instances.get(id))).toEqual(tokens);
    for (const id of AGENTS) {
      expect(pty.spawns.get(id)).toBe(1);
      expect(stageOf(id)).toBe("terminal-stage");
    }
  });
});

describe("the double-mount invariant engine/pairs exists for", () => {
  it("never renders one agent id into two stages", async () => {
    // Two xterms on one PTY orphans a child process (`pty_spawn`'s `sessions.insert`) — the failure
    // the partition was built to prevent, and the one a portal could plausibly have reintroduced.
    // Checked in every pair configuration this suite can reach.
    await mount();
    const seenInEveryConfiguration = () => {
      for (const id of AGENTS) {
        expect(screen.getAllByTestId(`pane-${id}`)).toHaveLength(1);
      }
    };
    seenInEveryConfiguration();
    assign("p1", "left");
    seenInEveryConfiguration();
    assign("p2", "left");
    seenInEveryConfiguration();
    assign("p1", "right");
    seenInEveryConfiguration();
  });

  it("keeps each pair's visible pane its OWN — never two visible in one stage", async () => {
    // The other half of the ownership rule: each stage shows exactly the agent ITS pair selected.
    // A single mount site makes double-mounting impossible but says nothing about visibility, and a
    // stage painting two panes at once is the same bug one layer up.
    await mount();
    assign("p1", "left");

    for (const stage of ["terminal-stage", "terminal-stage-left"]) {
      const el = screen.getByTestId(stage);
      const visible = [...el.querySelectorAll("[data-visible='true']")];
      expect(visible.length).toBeLessThanOrEqual(1);
    }
    // p1 is the left pair's project and p1-a is its selection, so the left stage shows that pane and
    // the right stage does not show any of p1's.
    expect(paneEl("p1-a").dataset.visible).toBe("true");
    expect(paneEl("p1-b").dataset.visible).toBe("false");
  });
});

describe("a pane is never left with nowhere to render", () => {
  it("keeps a pane mounted while its destination stage does not exist yet", async () => {
    // `pairCount` is derived from the assignment map, so the left stage and the left assignment
    // arrive in the same commit — but the stage's node reaches the portals one commit later, via
    // state. That gap must cost nothing: the pane stays where it was, mounted, and moves next
    // commit. A `null` target that DETACHED instead would blank a live terminal for a frame.
    await mount();
    assign("p1", "left");
    expect(pty.spawns.get("p1-a")).toBe(1);
    expect(pty.kills.get("p1-a")).toBeUndefined();
    expect(screen.getByTestId("pane-p1-a").isConnected).toBe(true);
  });

  it("tears the pane down when the AGENT closes — the one case that should", async () => {
    // The inverse assertion, and the reason none of the above is satisfied by a `PaneHost` that
    // simply never unmounts anything. Closing an agent must still kill its PTY; if this stopped
    // working, every test in this file would still be green while the app leaked a process per tab.
    await mount();
    expect(pty.kills.get("p1-a")).toBeUndefined();

    act(() => {
      useRuntimeStore.setState({
        openAgentIds: AGENTS.filter((id) => id !== "p1-a"),
      } as never);
    });

    expect(pty.kills.get("p1-a")).toBe(1);
    expect(screen.queryByTestId("pane-p1-a")).toBeNull();
    // …and only that one. Its sibling on the same project is untouched.
    expect(pty.kills.get("p1-b")).toBeUndefined();
  });
});
