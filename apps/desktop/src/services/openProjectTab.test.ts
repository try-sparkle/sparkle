// @vitest-environment jsdom
//
// "Open a project" in the single-window shell (CM-U7): it selects the TAB — it never opens a
// window. These pin the contract every re-routed call site now depends on.
import { beforeEach, describe, expect, it, vi } from "vitest";

const emitFocusAgent = vi.fn();
const emitSelectProject = vi.fn();
vi.mock("./attention", () => ({
  emitFocusAgent: (p: unknown) => emitFocusAgent(p),
  emitSelectProject: (p: unknown) => emitSelectProject(p),
}));

import { openProjectTab, requestProjectTabFromOtherWindow } from "./openProjectTab";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,  };
}
function mkProject(id: string, agents: AgentTab[] = [], selectedAgentId: string | null = null): Project {
  return {
    id, name: id, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId, agents,
  };
}

beforeEach(() => {
  emitFocusAgent.mockClear();
  emitSelectProject.mockClear();
  useProjectStore.setState({
    projects: [mkProject("p1", [mkAgent("a1")]), mkProject("p2", [mkAgent("a2"), mkAgent("a3")], "a3")],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: [] } as never);
  // Closable tabs: `null` = never seeded, i.e. every project is open (uiStore is a module
  // singleton, so the closed-tab cases below must not leak into the rest of the file).
  useUiStore.setState({ openProjectIds: null } as never);
  useUiStore.getState().setActiveSpecial("board");
  useUiStore.getState().setWorkMode("plan");
});

// Closable tabs: openProjectTab reopens the tab for the surfaces that route through IT. It is not
// the only such seam — `useReplaceCurrentProject` and `selectAndOpen` (services/agentReveal) each
// call markProjectOpen for the paths that reach them instead — so this block pins this one's share
// of the contract, not a claim that everything funnels here.
describe("openProjectTab — reopening a closed tab", () => {
  it("reopens a project whose tab was closed", () => {
    useUiStore.setState({ openProjectIds: ["p1"] } as never); // p2 closed
    openProjectTab("p2");
    expect(useUiStore.getState().openProjectIds).toEqual(["p1", "p2"]);
    expect(useProjectStore.getState().selectedProjectId).toBe("p2");
  });

  it("writes NOTHING to the open set when the project is already open", () => {
    // Load-bearing: this runs on every tab click. Seeding here would freeze the set to whatever
    // projects existed at that instant, so a project arriving later would render no tab.
    openProjectTab("p2");
    expect(useUiStore.getState().openProjectIds).toBeNull();
  });

  it("does not reopen — or select — an unknown project", () => {
    useUiStore.setState({ openProjectIds: ["p1"] } as never);
    openProjectTab("ghost");
    expect(useUiStore.getState().openProjectIds).toEqual(["p1"]);
    expect(useProjectStore.getState().selectedProjectId).toBe("p1");
  });
});

describe("openProjectTab", () => {
  it("selects the project's tab", () => {
    openProjectTab("p2");
    expect(useProjectStore.getState().selectedProjectId).toBe("p2");
  });

  it("with an agent, also mounts + selects it and leaves any Plan/Sparkle overlay", () => {
    openProjectTab("p2", "a2");
    expect(useProjectStore.getState().selectedProjectId).toBe("p2");
    expect(useProjectStore.getState().projects.find((p) => p.id === "p2")?.selectedAgentId).toBe("a2");
    expect(useRuntimeStore.getState().isOpen("a2")).toBe(true);
    // selectAndOpen's reveal contract: no special view, Build mode, so the agent is actually shown.
    expect(useUiStore.getState().activeSpecial).toBeNull();
    expect(useUiStore.getState().workMode).toBe("build");
  });

  it("is a no-op for an unknown project id", () => {
    openProjectTab("ghost");
    expect(useProjectStore.getState().selectedProjectId).toBe("p1");
  });

  it("clears the Improve-Sparkle overlay so the tab click isn't visibly a no-op", () => {
    // activeSpecial is APP-global: leaving "sparkle" up means the Sparkle pane still covers
    // column 3, so switching tabs appears to do nothing (roborev 46248-M-activeSpecial).
    useUiStore.getState().setActiveSpecial("sparkle");
    openProjectTab("p2");
    expect(useUiStore.getState().activeSpecial).toBeNull();
  });

  it("moves workMode with it — Plan can't stay selected over a Build pane", () => {
    // boardActive requires activeSpecial === "board", so clearing the Sparkle pane while the
    // chevron still reads Plan would leave the two states disagreeing (roborev 46291-L).
    useUiStore.getState().setActiveSpecial("sparkle");
    useUiStore.getState().setWorkMode("plan");
    openProjectTab("p2");
    expect(useUiStore.getState().activeSpecial).toBeNull();
    expect(useUiStore.getState().workMode).toBe("build");
  });

  it("KEEPS the Plan board — it is a per-project view, so it re-targets the new project", () => {
    useUiStore.getState().setActiveSpecial("board");
    useUiStore.getState().setWorkMode("plan");
    openProjectTab("p2");
    expect(useUiStore.getState().activeSpecial).toBe("board");
    expect(useUiStore.getState().workMode).toBe("plan");
  });

  it("clears the overlay even for a project that is ALREADY selected", () => {
    // The add/clone paths call in with an id addProject has already selected, and every
    // cross-context caller (tray, notification, palette) means "take me there" whether or not it
    // is current. Inferring "same tab, do nothing" from equal ids here would strand the user on
    // the Sparkle pane in exactly those cases; the tab bar owns that decision instead.
    useUiStore.getState().setActiveSpecial("sparkle");
    useUiStore.getState().setWorkMode("plan");
    openProjectTab("p1"); // p1 is the selected project
    expect(useUiStore.getState().activeSpecial).toBeNull();
    expect(useUiStore.getState().workMode).toBe("build");
  });

  it("reveals an agent in the project you are ALREADY on", () => {
    // The commonest reveal in the app (a nudge or a PR for an agent in the current project), and
    // the case any future "same id → do nothing" shortcut would silently break.
    useUiStore.getState().setActiveSpecial("sparkle");
    openProjectTab("p1", "a1"); // p1 is the selected project
    expect(useUiStore.getState().activeSpecial).toBeNull();
    expect(useUiStore.getState().workMode).toBe("build");
    expect(useRuntimeStore.getState().isOpen("a1")).toBe(true);
    expect(useProjectStore.getState().projects.find((p) => p.id === "p1")?.selectedAgentId).toBe("a1");
  });

  it("bumps the project's recency so tab ordering stays honest", () => {
    const before = useProjectStore.getState().projects.find((p) => p.id === "p2")?.lastOpenedAt;
    openProjectTab("p2");
    const after = useProjectStore.getState().projects.find((p) => p.id === "p2")?.lastOpenedAt;
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });
});

describe("requestProjectTabFromOtherWindow", () => {
  it("reveals the agent when one is named (and it exists)", () => {
    requestProjectTabFromOtherWindow("p2", "a2");
    expect(useProjectStore.getState().selectedProjectId).toBe("p2");
    expect(emitFocusAgent).toHaveBeenCalledWith({ projectId: "p2", agentId: "a2" });
    expect(emitSelectProject).not.toHaveBeenCalled();
  });

  // The heart of roborev 46249-H1/M2: "open this project" must NOT invent an agent to aim at.
  it("with no agent named, asks for the TAB — it never invents a focus target", () => {
    requestProjectTabFromOtherWindow("p2");
    expect(emitSelectProject).toHaveBeenCalledWith({ projectId: "p2" });
    // p2 has a selectedAgentId ("a3") and two agents; neither may be force-opened.
    expect(emitFocusAgent).not.toHaveBeenCalled();
  });

  it("works for an AGENT-LESS project — the tray's Open on a fresh folder used to be a dead click", () => {
    useProjectStore.setState({ projects: [mkProject("empty")], selectedProjectId: null } as never);
    requestProjectTabFromOtherWindow("empty");
    expect(useProjectStore.getState().selectedProjectId).toBe("empty");
    expect(emitSelectProject).toHaveBeenCalledWith({ projectId: "empty" });
  });

  it("degrades to a tab request when the named agent no longer exists", () => {
    requestProjectTabFromOtherWindow("p2", "gone");
    expect(emitFocusAgent).not.toHaveBeenCalled();
    expect(emitSelectProject).toHaveBeenCalledWith({ projectId: "p2" });
  });

  // Closable tabs: this path must NOT touch the open set. uiStore is not cross-window synced
  // (services/crossWindowSync wires projectStore + dictationStore only), so the write could never
  // reach the main window's in-memory state — while it WOULD make a secondary webview persist the
  // whole shared `sparkle-ui` blob from its own snapshot, clobbering main-window UI preferences.
  // The tab still reopens: the main window's select-project handler routes through openProjectTab.
  it("does NOT write the open set — the main window reopens the tab when it handles the event", () => {
    useUiStore.setState({ openProjectIds: ["p1"] } as never); // p2 closed
    requestProjectTabFromOtherWindow("p2");
    expect(useUiStore.getState().openProjectIds).toEqual(["p1"]);
    // The selection IS claimed here — projectStore is synced, so that half does cross over.
    expect(useProjectStore.getState().selectedProjectId).toBe("p2");
    expect(emitSelectProject).toHaveBeenCalledWith({ projectId: "p2" });
  });

  it("is a no-op for an unknown project id", () => {
    requestProjectTabFromOtherWindow("ghost");
    expect(useProjectStore.getState().selectedProjectId).toBe("p1");
    expect(emitFocusAgent).not.toHaveBeenCalled();
    expect(emitSelectProject).not.toHaveBeenCalled();
  });
});
