// @vitest-environment jsdom
//
// The PROJECT + WINDOW concierge tool domain. These pin the four properties the domain exists to
// guarantee, in the order they matter:
//
//   1. every function returns a TYPED result — a refusal is a value, never a thrown string;
//   2. the risk map is EXHAUSTIVE over the operation list (a typecheck failure AND a runtime test,
//      because a `Record` only catches the mistake at the boundary of this module);
//   3. no function reaches a native modal/dialog — an AI caller cannot answer a file picker and the
//      bridge round-trip would hang until its 600s ceiling;
//   4. closing a tab reports the agents it leaves running (or stops), from the SAME liveness policy
//      the window-close prompt uses, rather than a second copy of it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  CONFIRM_GATED_OPS,
  WORKSPACE_OPS,
  WORKSPACE_OP_RISK,
  addProjectFromFolder,
  closeProjectTab,
  defaultWorkspaceDeps,
  jumpToHistoryHit,
  listProjects,
  openProjectTab,
  quitApp,
  relocateProject,
  removeProject,
  reorderProjectTab,
  searchHistory,
  selectProject,
  setHelperBounds,
  setHelperEnabled,
  setProjectPinned,
  showMainWindow,
  type WorkspaceDeps,
  type WorkspaceResult,
} from "./workspace";
import { useProjectStore } from "../../stores/projectStore";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { useUiStore } from "../../stores/uiStore";
import { useHelperPrefs } from "../../helper/helperPrefs";
import { resetPaneReadiness, setPaneReady } from "../paneReadiness";
import type { AgentTab, Project } from "../../types";
import type { HistoryHit } from "../history";

function mkAgent(id: string): AgentTab {
  return {
    id,
    name: id,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
  } as AgentTab;
}

function mkProject(id: string, agents: AgentTab[] = []): Project {
  return {
    id,
    name: `Project ${id}`,
    rootPath: `/tmp/${id}`,
    defaultBranch: null,
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    agents,
  };
}

let deps: WorkspaceDeps;
const showMain = vi.fn();
const setBounds = vi.fn();
const quit = vi.fn();
const stopAgents = vi.fn(async () => {});
const ensureRepo = vi.fn(async () => {});
const moveFolder = vi.fn(async () => {});
const search = vi.fn(async () => [] as HistoryHit[]);

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
  for (const m of [showMain, setBounds, quit, stopAgents, ensureRepo, moveFolder, search]) m.mockClear();
  deps = {
    showMainWindow: showMain,
    setHelperBounds: setBounds,
    quitApp: quit,
    stopProjectAgents: stopAgents,
    ensureProjectRepo: ensureRepo,
    moveProjectFolder: moveFolder,
    searchHistory: search,
  };
  resetPaneReadiness();
  useProjectStore.setState({
    projects: [mkProject("p1", [mkAgent("a1"), mkAgent("a2")]), mkProject("p2")],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: [] } as never);
  useUiStore.setState({ openProjectIds: null, pinnedProjectId: null } as never);
  useHelperPrefs.setState({ enabled: true } as never);
});

describe("the risk map", () => {
  it("classifies every operation — exhaustively", () => {
    for (const op of WORKSPACE_OPS) {
      expect(WORKSPACE_OP_RISK[op], `${op} is unclassified`).toBeTruthy();
    }
    expect(Object.keys(WORKSPACE_OP_RISK).sort()).toEqual([...WORKSPACE_OPS].sort());
  });

  it("keeps the destructive operations out of the routine classes", () => {
    expect(WORKSPACE_OP_RISK.remove_project).toBe("irreversible");
    expect(WORKSPACE_OP_RISK.relocate_project).toBe("irreversible");
    expect(WORKSPACE_OP_RISK.quit_app).toBe("irreversible");
    expect(WORKSPACE_OP_RISK.stop_project_agents).toBe("disruptive");
    expect(WORKSPACE_OP_RISK.list_projects).toBe("read-only");
    expect(WORKSPACE_OP_RISK.search_history).toBe("read-only");
  });

  // roborev 54174-M1. `routine` is defined as "the user can undo it with one click", and adding a
  // folder is not that: ensure_project_repo runs `git init`, writes repo-local user.name/email,
  // makes an empty commit and appends to .gitignore — on disk, at a path the MODEL chose. The word
  // has to carry that, because it is `routine` here that derives to `allow` in the policy layer.
  it("does not call add_project_from_folder routine — it git-inits a model-supplied path", () => {
    expect(WORKSPACE_OP_RISK.add_project_from_folder).toBe("disruptive");
  });

  // roborev 54174-M3. `confirm` is the model's own boolean, so it is NOT the human gate; the human
  // gate is the policy layer, which asks on `disruptive`/`irreversible` and auto-allows `routine`
  // and `read-only`. Reclassifying a confirm-gated op downward would therefore delete the human
  // from the loop and leave only the model vouching for itself. Pin that it cannot happen quietly.
  it("never guards an op that the policy layer would auto-allow", () => {
    for (const op of CONFIRM_GATED_OPS) {
      expect(["disruptive", "irreversible"], `${op} is confirm-gated but auto-allowed`).toContain(
        WORKSPACE_OP_RISK[op],
      );
    }
  });

  it("stamps the performed operation's risk onto every result", () => {
    const ok = listProjects();
    expect(ok.risk).toBe(WORKSPACE_OP_RISK.list_projects);
    const refusal = selectProject("nope");
    expect(refusal.ok).toBe(false);
    expect(refusal.risk).toBe(WORKSPACE_OP_RISK.select_project);
  });
});

describe("no native modal is reachable", () => {
  // A source assertion rather than a behavioural one, deliberately: the hazard is a FUTURE
  // operation reaching for `pickProjectFolder` because it feels convenient, and no runtime test can
  // see a call that hasn't been written yet. `import.meta.url` is an http URL under vitest's
  // transform, so resolve from the vitest root (apps/desktop) instead.
  it("never imports the folder/file picker module", () => {
    const src = readFileSync(resolve(process.cwd(), "src/services/conciergeTools/workspace.ts"), "utf8");
    expect(src).not.toMatch(/from\s+"\.\.\/dialog"/);
    expect(src).not.toMatch(/@tauri-apps\/plugin-dialog/);
  });

  it("adds a project from an explicit path without invoking a picker", async () => {
    const res = await addProjectFromFolder("/tmp/fresh", undefined, defaultWorkspaceDeps());
    expect(res.ok).toBe(true);
    const commands = invoke.mock.calls.map((c) => c[0]);
    expect(commands).toContain("ensure_project_repo");
    expect(commands).not.toContain("pick_folder");
    expect(commands).not.toContain("pick_files");
  });
});

describe("the shipped WebView baseline", () => {
  // roborev 54174-M2. The build targets `safari14` (vite.config.ts — WKWebView on macOS 11 is the
  // declared floor) and esbuild does not downlevel regex features: a lookbehind assertion ships
  // verbatim and is a PARSE error there, which takes out this module and everything importing it
  // rather than just the one path it appears on. A source assertion because no runtime test under
  // Node can see it — the V8 running this suite supports lookbehind perfectly well.
  it("uses no regex lookbehind — the shipped target cannot parse one", () => {
    const src = readFileSync(resolve(process.cwd(), "src/services/conciergeTools/workspace.ts"), "utf8");
    expect(src).not.toMatch(/\(\?<[=!]/);
  });
});

describe("listProjects", () => {
  it("reports open/pinned/selected state per project", () => {
    useUiStore.setState({ openProjectIds: ["p1"], pinnedProjectId: "p1" } as never);
    const res = listProjects();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.map((p) => [p.id, p.open, p.pinned, p.selected])).toEqual([
      ["p1", true, true, true],
      ["p2", false, false, false],
    ]);
  });

  it("counts the agents that are actually running", () => {
    useRuntimeStore.setState({ openAgentIds: ["a1", "a2"] } as never);
    setPaneReady("a1", true); // a2 is open-from-last-launch with no pane → not running
    const res = listProjects();
    if (!res.ok) throw new Error("expected ok");
    expect(res.value[0]!.agentCount).toBe(2);
    expect(res.value[0]!.runningAgentCount).toBe(1);
  });
});

describe("selectProject", () => {
  it("switches the selection and bumps recency", () => {
    const res = selectProject("p2");
    expect(res.ok).toBe(true);
    expect(useProjectStore.getState().selectedProjectId).toBe("p2");
    expect(useProjectStore.getState().projects.find((p) => p.id === "p2")!.lastOpenedAt).toBeTruthy();
  });

  it("refuses an unknown project with a typed reason instead of throwing", () => {
    const res = selectProject("ghost");
    expect(res).toMatchObject({ ok: false, op: "select_project", reason: "unknown-project" });
  });

  it("refuses a project whose tab is closed, pointing at openProjectTab", () => {
    useUiStore.setState({ openProjectIds: ["p1"] } as never);
    const res = selectProject("p2");
    expect(res).toMatchObject({ ok: false, reason: "no-tab" });
    expect(useProjectStore.getState().selectedProjectId).toBe("p1");
  });
});

describe("openProjectTab", () => {
  it("reopens a closed tab and selects it", () => {
    useUiStore.setState({ openProjectIds: ["p1"] } as never);
    const res = openProjectTab("p2");
    expect(res.ok).toBe(true);
    expect(useUiStore.getState().openProjectIds).toEqual(["p1", "p2"]);
    expect(useProjectStore.getState().selectedProjectId).toBe("p2");
  });

  it("refuses an unknown project", () => {
    expect(openProjectTab("ghost")).toMatchObject({ ok: false, reason: "unknown-project" });
  });

  it("refuses an agent that isn't in that project", () => {
    expect(openProjectTab("p1", "nope")).toMatchObject({ ok: false, reason: "unknown-agent" });
    expect(useProjectStore.getState().selectedProjectId).toBe("p1"); // untouched
  });
});

describe("closeProjectTab", () => {
  it("closes the tab and moves the selection to a neighbour", async () => {
    useUiStore.setState({ openProjectIds: ["p1", "p2"] } as never);
    const res = await closeProjectTab("p1", undefined, deps);
    expect(res.ok).toBe(true);
    expect(useUiStore.getState().openProjectIds).toEqual(["p2"]);
    expect(useProjectStore.getState().selectedProjectId).toBe("p2");
  });

  it("refuses when the project has no tab to close", async () => {
    useUiStore.setState({ openProjectIds: ["p1"] } as never);
    expect(await closeProjectTab("p2", undefined, deps)).toMatchObject({
      ok: false,
      reason: "no-tab",
    });
  });

  it("REPORTS the running agents it leaves alive, and does not stop them", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1", "a2"] } as never);
    setPaneReady("a1", true);
    setPaneReady("a2", false); // starting counts as running too
    const res = await closeProjectTab("p1", undefined, deps);
    if (!res.ok) throw new Error("expected ok");
    expect(res.op).toBe("close_project_tab");
    expect(res.value.stopped).toBe(false);
    expect(res.value.runningAgents.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
    expect(stopAgents).not.toHaveBeenCalled();
  });

  it("does not count an agent that is open but has no pane as running", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1", "a2"] } as never);
    setPaneReady("a1", true);
    const res = await closeProjectTab("p1", undefined, deps);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.runningAgents.map((a) => a.id)).toEqual(["a1"]);
  });

  it("stops them — and says so — only when the caller asks for it", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"] } as never);
    setPaneReady("a1", true);
    const res = await closeProjectTab("p1", { stopAgents: true }, deps);
    if (!res.ok) throw new Error("expected ok");
    expect(res.op).toBe("stop_project_agents");
    expect(res.risk).toBe("disruptive");
    expect(res.value.stopped).toBe(true);
    expect(res.value.runningAgents.map((a) => a.id)).toEqual(["a1"]);
    expect(stopAgents).toHaveBeenCalledTimes(1);
  });

  it("clears the concierge pin when the pinned project's tab goes away", async () => {
    useUiStore.setState({ openProjectIds: ["p1", "p2"], pinnedProjectId: "p1" } as never);
    await closeProjectTab("p1", undefined, deps);
    expect(useUiStore.getState().pinnedProjectId).toBeNull();
  });
});

describe("setProjectPinned", () => {
  it("toggles when no explicit value is given", () => {
    expect(setProjectPinned("p1").ok).toBe(true);
    expect(useUiStore.getState().pinnedProjectId).toBe("p1");
    setProjectPinned("p1");
    expect(useUiStore.getState().pinnedProjectId).toBeNull();
  });

  it("is idempotent when the value is explicit", () => {
    setProjectPinned("p1", true);
    setProjectPinned("p1", true);
    expect(useUiStore.getState().pinnedProjectId).toBe("p1");
    setProjectPinned("p1", false);
    expect(useUiStore.getState().pinnedProjectId).toBeNull();
  });

  it("unpinning a project that isn't pinned leaves another project's pin alone", () => {
    setProjectPinned("p1", true);
    expect(setProjectPinned("p2", false).ok).toBe(true);
    expect(useUiStore.getState().pinnedProjectId).toBe("p1");
  });

  it("refuses an unknown project", () => {
    expect(setProjectPinned("ghost", true)).toMatchObject({ ok: false, reason: "unknown-project" });
  });
});

describe("reorderProjectTab", () => {
  it("moves a project before another", () => {
    const res = reorderProjectTab("p2", "p1");
    expect(res.ok).toBe(true);
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(["p2", "p1"]);
  });

  it("a null anchor moves it to the end", () => {
    expect(reorderProjectTab("p1", null).ok).toBe(true);
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(["p2", "p1"]);
  });

  it("refuses an unknown anchor rather than silently appending", () => {
    expect(reorderProjectTab("p1", "ghost")).toMatchObject({ ok: false, reason: "unknown-project" });
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("refuses a no-op drop on itself", () => {
    expect(reorderProjectTab("p1", "p1")).toMatchObject({ ok: false, reason: "no-op" });
  });
});

describe("addProjectFromFolder", () => {
  it("adds and selects the project, defaulting the name to the folder", async () => {
    const res = await addProjectFromFolder("/Users/me/code/widget", undefined, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(ensureRepo).toHaveBeenCalledWith("/Users/me/code/widget");
    const added = useProjectStore.getState().projects.find((p) => p.id === res.value.projectId);
    expect(added?.name).toBe("widget");
    expect(added?.rootPath).toBe("/Users/me/code/widget");
    expect(useProjectStore.getState().selectedProjectId).toBe(res.value.projectId);
  });

  // roborev 54174-H. `projectStore.addProject` only sets `selectedProjectId`; it does NOT mark the
  // project open. The rest of the suite seeds `openProjectIds: null` — the legacy "everything is
  // open" case — which hides that completely. With a REAL open set (anyone who has ever closed a
  // tab), an add that skips the open path leaves the new project selected with no tab in the strip,
  // and this very module's `selectProject` would then refuse it as `no-tab`. The human "+" flow
  // does `openProjectTab(addProject(...))` for exactly this reason.
  it("gives the new project a TAB, not just the selection, when the open set is real", async () => {
    useUiStore.setState({ openProjectIds: ["p1"] } as never);
    const res = await addProjectFromFolder("/Users/me/code/widget", undefined, deps);
    if (!res.ok) throw new Error("expected ok");
    expect(useUiStore.getState().openProjectIds).toEqual(["p1", res.value.projectId]);
    expect(useProjectStore.getState().selectedProjectId).toBe(res.value.projectId);
    // …and the module agrees with itself: selecting what it just added is not a `no-tab` refusal.
    expect(selectProject(res.value.projectId).ok).toBe(true);
  });

  it("leaves the other tabs open when it adds one", async () => {
    useUiStore.setState({ openProjectIds: ["p1", "p2"] } as never);
    const res = await addProjectFromFolder("/Users/me/code/widget", undefined, deps);
    if (!res.ok) throw new Error("expected ok");
    expect(useUiStore.getState().openProjectIds).toEqual(["p1", "p2", res.value.projectId]);
  });

  it("strips a trailing separator from the recorded path", async () => {
    const res = await addProjectFromFolder("/Users/me/code/widget//", undefined, deps);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.rootPath).toBe("/Users/me/code/widget");
    expect(res.value.name).toBe("widget");
    expect(ensureRepo).toHaveBeenCalledWith("/Users/me/code/widget");
  });

  it("does not strip a bare root away to an empty path", async () => {
    const res = await addProjectFromFolder("/", undefined, deps);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.rootPath).toBe("/");
    expect(ensureRepo).toHaveBeenCalledWith("/");
  });

  it("refuses a blank path", async () => {
    expect(await addProjectFromFolder("   ", undefined, deps)).toMatchObject({
      ok: false,
      reason: "invalid-path",
    });
  });

  it("refuses a relative path", async () => {
    expect(await addProjectFromFolder("code/widget", undefined, deps)).toMatchObject({
      ok: false,
      reason: "invalid-path",
    });
  });

  it("refuses an unexpanded ~ rather than creating a literal '~' folder", async () => {
    expect(await addProjectFromFolder("~/code/widget", undefined, deps)).toMatchObject({
      ok: false,
      reason: "invalid-path",
    });
    expect(ensureRepo).not.toHaveBeenCalled();
  });

  it("refuses a folder that is already a project, naming the existing one", async () => {
    const res = await addProjectFromFolder("/tmp/p1", undefined, deps);
    expect(res).toMatchObject({ ok: false, reason: "already-added" });
    expect(res.ok === false && res.message).toContain("p1");
  });

  it("returns a typed refusal — not a rejection — when the backend fails", async () => {
    ensureRepo.mockRejectedValueOnce(new Error("not a directory"));
    const before = useProjectStore.getState().projects.length;
    const res = await addProjectFromFolder("/tmp/missing", undefined, deps);
    expect(res).toMatchObject({ ok: false, reason: "backend-failed" });
    expect(res.ok === false && res.message).toContain("not a directory");
    expect(useProjectStore.getState().projects.length).toBe(before); // nothing half-added
  });
});

describe("removeProject", () => {
  it("refuses without an explicit confirmation", () => {
    const res = removeProject("p1", { confirm: false });
    expect(res).toMatchObject({ ok: false, reason: "confirmation-required" });
    expect(useProjectStore.getState().projects).toHaveLength(2);
  });

  it("removes the project once confirmed", () => {
    const res = removeProject("p1", { confirm: true });
    expect(res.ok).toBe(true);
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(["p2"]);
  });

  it("refuses while the project still has running agents", () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"] } as never);
    setPaneReady("a1", true);
    const res = removeProject("p1", { confirm: true });
    expect(res).toMatchObject({ ok: false, reason: "agents-running" });
    expect(res.ok === false && res.message).toContain("a1");
    expect(useProjectStore.getState().projects).toHaveLength(2);
  });

  it("refuses an unknown project", () => {
    expect(removeProject("ghost", { confirm: true })).toMatchObject({
      ok: false,
      reason: "unknown-project",
    });
  });
});

describe("relocateProject", () => {
  it("refuses without confirmation — it moves the user's folder on disk", async () => {
    const res = await relocateProject("p1", "/tmp/moved", { confirm: false }, deps);
    expect(res).toMatchObject({ ok: false, reason: "confirmation-required" });
    expect(moveFolder).not.toHaveBeenCalled();
  });

  it("moves the folder and repoints the project", async () => {
    const res = await relocateProject("p1", "/tmp/moved", { confirm: true }, deps);
    expect(res.ok).toBe(true);
    expect(moveFolder).toHaveBeenCalledWith("/tmp/p1", "/tmp/moved");
    expect(useProjectStore.getState().projects[0]!.rootPath).toBe("/tmp/moved");
  });

  it("refuses while agents are running — their PTYs hold the old working directory", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"] } as never);
    setPaneReady("a1", true);
    const res = await relocateProject("p1", "/tmp/moved", { confirm: true }, deps);
    expect(res).toMatchObject({ ok: false, reason: "agents-running" });
    expect(moveFolder).not.toHaveBeenCalled();
  });

  it("does not repoint the project when the move fails", async () => {
    moveFolder.mockRejectedValueOnce(new Error("destination exists"));
    const res = await relocateProject("p1", "/tmp/moved", { confirm: true }, deps);
    expect(res).toMatchObject({ ok: false, reason: "backend-failed" });
    expect(useProjectStore.getState().projects[0]!.rootPath).toBe("/tmp/p1");
  });

  it("refuses a relative destination", async () => {
    expect(await relocateProject("p1", "elsewhere", { confirm: true }, deps)).toMatchObject({
      ok: false,
      reason: "invalid-path",
    });
  });

  it("normalizes the destination's trailing separator before moving anything", async () => {
    const res = await relocateProject("p1", "/tmp/moved/", { confirm: true }, deps);
    expect(res.ok).toBe(true);
    expect(moveFolder).toHaveBeenCalledWith("/tmp/p1", "/tmp/moved");
    expect(useProjectStore.getState().projects[0]!.rootPath).toBe("/tmp/moved");
  });

  it("sees a trailing-separator spelling of the CURRENT path as the no-op it is", async () => {
    expect(await relocateProject("p1", "/tmp/p1/", { confirm: true }, deps)).toMatchObject({
      ok: false,
      reason: "no-op",
    });
    expect(moveFolder).not.toHaveBeenCalled();
  });
});

// roborev 54174-M3. The `confirm` flag is supplied by the AI CALLER, so it is a deliberateness
// check on the model, not a human's consent — the human gate is the policy layer's `ask` tier. What
// this pins is that the list of confirm-gated ops stays honest: the `Record` over the union means an
// op added to CONFIRM_GATED_OPS without a real gate fails to compile, and the assertion below fails
// if the gate is ever removed from one that is listed.
describe("the confirmation gate", () => {
  it("really refuses every op it claims to guard", async () => {
    const withoutConfirm: Record<
      (typeof CONFIRM_GATED_OPS)[number],
      () => Promise<WorkspaceResult<unknown>>
    > = {
      remove_project: async () => removeProject("p1", { confirm: false }),
      relocate_project: () => relocateProject("p1", "/tmp/moved", { confirm: false }, deps),
      quit_app: () => quitApp({ confirm: false }, deps),
    };
    for (const op of CONFIRM_GATED_OPS) {
      expect(await withoutConfirm[op](), op).toMatchObject({
        ok: false,
        op,
        reason: "confirmation-required",
      });
    }
  });
});

describe("window + app level", () => {
  it("shows the main window", () => {
    expect(showMainWindow(deps).ok).toBe(true);
    expect(showMain).toHaveBeenCalledTimes(1);
  });

  it("writes the helper preference (the island's own webview reacts to it)", () => {
    expect(setHelperEnabled(false).ok).toBe(true);
    expect(useHelperPrefs.getState().enabled).toBe(false);
    setHelperEnabled(true);
    expect(useHelperPrefs.getState().enabled).toBe(true);
  });

  it("sets helper bounds", () => {
    expect(setHelperBounds({ x: 10, y: 20, width: 300, height: 120 }, deps).ok).toBe(true);
    expect(setBounds).toHaveBeenCalledWith(10, 20, 300, 120);
  });

  it("refuses non-finite or non-positive bounds instead of blanking the island", () => {
    expect(setHelperBounds({ x: 0, y: 0, width: 0, height: 10 }, deps)).toMatchObject({
      ok: false,
      reason: "invalid-bounds",
    });
    expect(setHelperBounds({ x: Number.NaN, y: 0, width: 10, height: 10 }, deps)).toMatchObject({
      ok: false,
      reason: "invalid-bounds",
    });
    expect(setBounds).not.toHaveBeenCalled();
  });

  it("refuses quit without confirmation, and reports what it would kill", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"] } as never);
    setPaneReady("a1", true);
    const res = await quitApp({ confirm: false }, deps);
    expect(res).toMatchObject({ ok: false, reason: "confirmation-required" });
    expect(res.ok === false && res.message).toContain("a1");
    expect(quit).not.toHaveBeenCalled();
  });

  it("quits once confirmed, returning the agents it is about to kill", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"] } as never);
    setPaneReady("a1", true);
    const res = await quitApp({ confirm: true }, deps);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.runningAgents.map((a) => a.id)).toEqual(["a1"]);
    expect(quit).toHaveBeenCalledTimes(1);
  });
});

describe("history", () => {
  it("refuses a blank query rather than round-tripping for nothing", async () => {
    expect(await searchHistory("   ", undefined, deps)).toMatchObject({
      ok: false,
      reason: "blank-query",
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("returns hits", async () => {
    search.mockResolvedValueOnce([{ id: "h1" } as HistoryHit]);
    const res = await searchHistory("widget", 5, deps);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value).toHaveLength(1);
    expect(search).toHaveBeenCalledWith("widget", 5);
  });

  it("turns a backend failure into a typed refusal", async () => {
    search.mockRejectedValueOnce(new Error("db locked"));
    expect(await searchHistory("widget", undefined, deps)).toMatchObject({
      ok: false,
      reason: "backend-failed",
    });
  });

  it("jumps to a hit in another project by switching to its tab", () => {
    useUiStore.setState({ openProjectIds: ["p1"] } as never);
    useProjectStore.setState({
      projects: [mkProject("p1"), mkProject("p2", [mkAgent("b1")])],
      selectedProjectId: "p1",
    } as never);
    const res = jumpToHistoryHit({ id: "h", projectId: "p2", agentId: "b1" } as HistoryHit);
    expect(res.ok).toBe(true);
    expect(useProjectStore.getState().selectedProjectId).toBe("p2");
    expect(useUiStore.getState().openProjectIds).toEqual(["p1", "p2"]);
  });

  it("refuses a hit whose agent is gone", () => {
    const res = jumpToHistoryHit({ id: "h", projectId: "p1", agentId: "gone" } as HistoryHit);
    expect(res).toMatchObject({ ok: false, reason: "agent-closed" });
  });

  it("refuses a hit with no project", () => {
    expect(jumpToHistoryHit({ id: "h", projectId: null, agentId: null } as HistoryHit)).toMatchObject(
      { ok: false, reason: "project-gone" },
    );
  });
});
