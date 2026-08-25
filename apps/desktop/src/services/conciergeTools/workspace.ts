// The PROJECT + WINDOW tool domain for the concierge — "manage my workspace" as a set of callable
// operations, so the human never has to reach for a tab, a pin, or a window control themselves.
//
// This module is a FAÇADE, not an implementation. Every operation wraps a path that already exists
// and is already tested (services/openProjectTab, services/projectTabs, projectStore, uiStore,
// helperPrefs, services/helper, services/history, Concierge/paletteJump). Nothing here re-derives a
// rule those modules own; where a policy is needed — "which agents count as running" — it is READ
// from the module that owns it (services/windowClose) rather than copied.
//
// FOUR CONTRACTS, and each is enforced rather than merely documented:
//
// 1. TYPED RESULTS, NEVER THROWN STRINGS. Every function returns `WorkspaceResult<T>`: an `ok`
//    value or a refusal carrying a machine-readable `reason` plus a sentence the concierge can say
//    out loud. This mirrors services/conciergeDispatch's `ConciergeDispatchPath` — a refusal there
//    is a value with a path, never an exception — and exists for the same reason: a tool caller has
//    to be able to branch on WHY, and an exception across a bridge arrives as an opaque string.
//    Async operations catch their backend rejection and return `backend-failed`; they never reject.
//
// 2. AN EXHAUSTIVE RISK MAP. `WorkspaceOp` is derived from the `WORKSPACE_OPS` list, and
//    `WORKSPACE_OP_RISK` is a `Record<WorkspaceOp, RiskClass>` — so adding an operation to the list
//    without classifying it is a TYPECHECK FAILURE, not a runtime surprise. Every result carries
//    the risk of the operation it actually performed, which is why `closeProjectTab` can report
//    itself as either `close_project_tab` (routine) or `stop_project_agents` (disruptive).
//
// 3. NO NATIVE MODAL IS EVER OPENED FROM HERE. Nothing in this module calls `pick_folder`,
//    `pick_files`, a confirm dialog, or anything else that waits on a human hand. An AI caller
//    cannot answer a native file picker, and the concierge bridge round-trip has a 600s ceiling —
//    so a picker opened from a tool call is a guaranteed hang followed by a timeout, with a modal
//    left on the user's screen. Operations that would otherwise need a picker (adding a project,
//    relocating one) take an EXPLICIT absolute path and validate it here. The test asserts this
//    module never imports services/dialog.
//
// 4. NOTHING RUNNING DIES QUIETLY. Closing a tab does not stop agents — services/projectTabs is
//    explicit that a closed project's PTYs keep running, and that is the safe default — but the
//    caller is TOLD which agents it just left running, so the concierge can say so. Asking for
//    `{ stopAgents: true }` reuses services/windowClose's `stopOpenProjectAgents`, the same sweep
//    the window-close prompt performs, rather than a second stop policy. The "is this agent
//    running?" question is likewise answered by calling windowClose's exported
//    `projectsWithOpenAgents` — see `runningAgentsOf` for why it is called per agent.
//
//    What is NOT reused is windowClose's `planWindowClose`, and that is deliberate rather than an
//    oversight. Its three outputs are WINDOW facts with no tab analogue: `hide` (keep the process
//    alive when the last window closes), `clearRegistry` (the window-id mapping), and `killAgents`,
//    which is literally `mode === "kill"` — the caller's own choice handed back. Routing this
//    module's boolean through it would add a call, not a shared decision, and would read as if tab
//    close and window close shared a policy they do not. The parts of windowClose that DO carry
//    policy — which agents count as live, and how they are stopped — are the parts reused above.
//
// DELIBERATELY ABSENT: the updater's install path, `reset_config` and `write_config_text`. They
// belong to other domains and are too dangerous to expose in this pass.
import { selectProjectOnItsSide } from "../openProjectTab";
import { useProjectStore } from "../../stores/projectStore";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { useUiStore } from "../../stores/uiStore";
import { useHelperPrefs } from "../../helper/helperPrefs";
import { isProjectOpen, openProjectsOf } from "../../engine/openProjects";
import { isSameProject, pathKey } from "../../engine/projectIdentity";
import { forgetRepoKey, repoKeyFor, resolveRepoKeyFor } from "../repoKey";
import { openProjectTab as openProjectTabService } from "../openProjectTab";
import { closeProjectTab as closeProjectTabService } from "../projectTabs";
import { projectsWithOpenAgents, stopOpenProjectAgents } from "../windowClose";
import { setHelperBounds as setHelperBoundsNative, showMainWindow as showMainWindowNative } from "../helper";
import { quitApp as quitAppNative } from "../attention";
import { ensureProjectRepo, moveProjectFolder } from "../worktree";
import { searchHistory as searchHistoryBackend, type HistoryHit } from "../history";
import { defaultJumpDeps, jumpToHit } from "../../components/Concierge/paletteJump";
import { WIDE_HISTORY_SCOPE, type HistorySearchScope } from "@sparkle/core";
import type { Project } from "../../types";

// ---------------------------------------------------------------------------------------------
// Operations + risk
// ---------------------------------------------------------------------------------------------

/** Every operation this domain offers. The source of the `WorkspaceOp` union — add here and the
 *  risk map below stops compiling until the new operation is classified. */
export const WORKSPACE_OPS = [
  "list_projects",
  "select_project",
  "open_project_tab",
  "close_project_tab",
  "stop_project_agents",
  "set_project_pinned",
  "reorder_project_tab",
  "add_project_from_folder",
  "remove_project",
  "relocate_project",
  "show_main_window",
  "set_helper_enabled",
  "set_helper_bounds",
  "search_history",
  "jump_to_history_hit",
  "quit_app",
] as const;

export type WorkspaceOp = (typeof WORKSPACE_OPS)[number];

/**
 * How much a caller should think before invoking an operation.
 *
 *  • `read-only`    — observes; changes nothing.
 *  • `routine`      — changes APP STATE, and the user can undo it with one click. Tab and pin
 *                     operations live here: closing a tab hides it, it does not delete anything.
 *  • `disruptive`   — nothing is destroyed, but no click undoes it either. Two shapes: it stops
 *                     work in flight (the agent records survive; the running process and its
 *                     unsaved terminal state do not), or it reaches OUTSIDE the app's own state —
 *                     writing to the user's disk, or giving a model-supplied path standing in the
 *                     app. Both are recoverable in principle and neither is one click away.
 *  • `irreversible` — destroys or relocates something the app cannot put back: a project record, a
 *                     folder on the user's disk, or the whole process.
 *
 * The line that matters is `routine` → `disruptive`, because services/conciergeTools/policy.ts
 * derives `allow` from `routine` and `ask` from everything above it. An op sitting one class too
 * low is not a labelling nit; it is the human silently dropped out of the loop.
 */
export type RiskClass = "read-only" | "routine" | "disruptive" | "irreversible";

/**
 * The classification. EXHAUSTIVE by construction: `Record<WorkspaceOp, RiskClass>` means an
 * operation added to `WORKSPACE_OPS` without a line here fails `tsc`.
 *
 * Three entries are worth their reasoning:
 *  • `quit_app` is `irreversible` rather than `disruptive`. It kills EVERY running agent in every
 *    project at once, and there is no in-app state after it to recover from — the process is gone.
 *  • `relocate_project` is `irreversible` because `move_project` moves the USER'S FOLDER on disk.
 *    It is not an app-state edit; it renames a directory the user owns and repairs worktree links
 *    to match.
 *  • `add_project_from_folder` is `disruptive`, not `routine` (roborev 54174). It reads like a
 *    bookkeeping write — "record this folder" — but `ensure_project_repo` is not read-only: it runs
 *    `git init`, writes repo-local `user.name`/`user.email`, creates an empty commit, appends to
 *    `.gitignore` and may install hooks, in whatever absolute path the MODEL supplied. The human
 *    "+" flow's safety check was the folder picker, and contract 3 removes the picker (correctly)
 *    without replacing it, so the risk word is what is left carrying the warning. policy.ts holds
 *    a cross-domain override to the same effect; this is the domain saying it in its own voice, so
 *    the `risk` stamped on the RESULT the concierge reads is honest too — the override never
 *    reaches that.
 *
 * ONE ENTRY IS NOT THE WHOLE STORY. `search_history` is `read-only` here and stays that way,
 * because the OPERATION observes and changes nothing — but how much it observes depends on its
 * `scope` argument, and `scope: "all"` reaches the founder's private concierge transcripts. A
 * `Record<WorkspaceOp, RiskClass>` is keyed by op NAME and structurally cannot express "this call
 * is riskier than that one", so that half lives in policy.ts's `perCallRiskFor`, which escalates a
 * `scope: "all"` call to `privacy-sensitive` and therefore to an approval card. See
 * {@link HistorySearchScope}. Do NOT "fix" this row to `privacy-sensitive`: that would make every
 * search ask first, including the narrow default the concierge runs constantly.
 */
export const WORKSPACE_OP_RISK: Record<WorkspaceOp, RiskClass> = {
  list_projects: "read-only",
  search_history: "read-only",
  select_project: "routine",
  open_project_tab: "routine",
  close_project_tab: "routine",
  set_project_pinned: "routine",
  reorder_project_tab: "routine",
  jump_to_history_hit: "routine",
  show_main_window: "routine",
  set_helper_enabled: "routine",
  set_helper_bounds: "routine",
  add_project_from_folder: "disruptive",
  stop_project_agents: "disruptive",
  remove_project: "irreversible",
  relocate_project: "irreversible",
  quit_app: "irreversible",
};

// ---------------------------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------------------------

/** Why an operation refused. Machine-readable so a caller can branch; the accompanying `message`
 *  is what the concierge says to the human. */
export type WorkspaceRefusalReason =
  | "unknown-project"
  | "unknown-agent"
  | "no-tab" // the project exists but has no tab — nothing to close / select
  | "no-op" // the request would change nothing (a drop on itself)
  | "invalid-path" // blank, relative, or unexpanded (`~`) — never a picker prompt
  | "already-added" // that folder is already a project
  | "invalid-bounds"
  | "blank-query"
  | "agents-running" // the operation would strand or corrupt work in flight
  | "confirmation-required" // destructive, and the caller did not say `confirm: true`
  | "agent-closed" // a history hit whose source agent is gone
  | "project-gone" // a history hit with no project
  | "backend-failed"; // the Rust side rejected — the message carries its text

export interface WorkspaceOk<T> {
  ok: true;
  /** The operation actually performed (not necessarily the function's name — see closeProjectTab). */
  op: WorkspaceOp;
  risk: RiskClass;
  value: T;
}

export interface WorkspaceRefusal {
  ok: false;
  op: WorkspaceOp;
  risk: RiskClass;
  reason: WorkspaceRefusalReason;
  /** A sentence fit to say to the user. Never an exception, never a bare error string. */
  message: string;
}

export type WorkspaceResult<T> = WorkspaceOk<T> | WorkspaceRefusal;

function ok<T>(op: WorkspaceOp, value: T): WorkspaceOk<T> {
  return { ok: true, op, risk: WORKSPACE_OP_RISK[op], value };
}

function refuse(op: WorkspaceOp, reason: WorkspaceRefusalReason, message: string): WorkspaceRefusal {
  return { ok: false, op, risk: WORKSPACE_OP_RISK[op], reason, message };
}

/** Backend rejections arrive as `Error`, as a bare string (Tauri's own rejection shape), or as
 *  anything else a command chose to throw. Flatten to something quotable. */
function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

// ---------------------------------------------------------------------------------------------
// Injectable native edges
// ---------------------------------------------------------------------------------------------

/** The native/backend calls this domain makes. Injected so the tests can assert them without a
 *  Tauri host — the same seam services/windowClose (`KillDeps`) and Concierge/paletteJump
 *  (`JumpDeps`) use. NOTHING here opens a dialog; see contract 3 above. */
export interface WorkspaceDeps {
  showMainWindow(): void;
  setHelperBounds(x: number, y: number, width: number, height: number): void;
  quitApp(): void;
  stopProjectAgents(project: Project, openAgentIds: ReadonlySet<string>): Promise<void>;
  ensureProjectRepo(path: string): Promise<void>;
  moveProjectFolder(oldPath: string, newPath: string): Promise<void>;
  searchHistory(query: string, limit?: number): Promise<HistoryHit[]>;
}

export function defaultWorkspaceDeps(): WorkspaceDeps {
  return {
    showMainWindow: showMainWindowNative,
    setHelperBounds: setHelperBoundsNative,
    quitApp: quitAppNative,
    stopProjectAgents: (project, openAgentIds) => stopOpenProjectAgents(project, openAgentIds),
    ensureProjectRepo,
    moveProjectFolder,
    searchHistory: (query, limit) => searchHistoryBackend(query, limit),
  };
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

export interface RunningAgent {
  id: string;
  name: string;
}

function projectById(projectId: string): Project | undefined {
  return useProjectStore.getState().projects.find((p) => p.id === projectId);
}

/**
 * The agents of `project` that are RUNNING right now.
 *
 * Deliberately derived by calling services/windowClose's exported `projectsWithOpenAgents` once per
 * agent (against a one-agent copy of the project) rather than by re-implementing its predicate.
 * That predicate is subtle and has been corrected twice — an agent can be in `openAgentIds` from a
 * previous launch with no pane and no process (roborev 46319), and a `failed` pane never started
 * one at all (roborev 47018) — so a second copy here would drift and start claiming agents are
 * running when they are not. windowClose exports the PROJECT-level answer only; asking it per agent
 * is how we get the list without owning the rule. The agent count per project is small.
 */
function runningAgentsOf(project: Project): RunningAgent[] {
  const openAgentIds = useRuntimeStore.getState().openAgentIds;
  return project.agents
    .filter((a) => projectsWithOpenAgents([{ ...project, agents: [a] }], openAgentIds).length > 0)
    .map((a) => ({ id: a.id, name: a.name }));
}

/** Every running agent across every project — what a quit is about to kill. */
function allRunningAgents(): RunningAgent[] {
  return useProjectStore.getState().projects.flatMap(runningAgentsOf);
}

function nameList(agents: readonly RunningAgent[]): string {
  return agents.map((a) => `${a.name} (${a.id})`).join(", ");
}

/** An absolute POSIX/Windows path, already expanded. We validate rather than prompt: a picker is
 *  unavailable to an AI caller (contract 3), so a bad path has to come back as a refusal that says
 *  what a good one looks like. `~` is rejected explicitly — the shell expands it, `invoke` does
 *  not, and passing it through would create a literal `~` directory. */
function pathProblem(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return "A folder path is required — pass an absolute path, e.g. /Users/you/code/app.";
  if (trimmed.startsWith("~")) {
    return `"${trimmed}" starts with ~, which nothing here expands. Pass the fully-expanded absolute path.`;
  }
  if (!/^(\/|[A-Za-z]:[\\/])/.test(trimmed)) {
    return `"${trimmed}" is not an absolute path. Pass an absolute path, e.g. /Users/you/code/app.`;
  }
  return null;
}

/**
 * The path as this module records it: trimmed, with trailing separators dropped so `/code/app` and
 * `/code/app/` are the same project rather than two.
 *
 * WITHOUT A LOOKBEHIND, deliberately (roborev 54174). A lookbehind assertion — "strip trailing
 * separators only when something precedes them" — says this more briefly and cannot ship:
 * vite.config.ts targets `safari14` (WKWebView on macOS 11 is the declared floor) and esbuild does
 * not downlevel regex features, so the literal reaches that WebView intact and fails to PARSE,
 * taking out this module and everything that imports it rather than just this one path. A test
 * asserts the source stays free of them.
 *
 * The `|| trimmed.slice(0, 1)` is what the assertion was there for: a bare root (`/`, `C:\`) is all
 * separator, and stripping it to the empty string would turn a root path into no path at all.
 */
function normalizePath(path: string): string {
  const trimmed = path.trim();
  return trimmed.replace(/[/\\]+$/, "") || trimmed.slice(0, 1);
}

/** Last path segment — a friendly default project name. Local (not services/dialog's `basename`)
 *  so this module never imports the file-picker module at all; see contract 3. */
function folderName(path: string): string {
  const parts = path.trim().replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || path.trim();
}

// ---------------------------------------------------------------------------------------------
// PROJECT LEVEL
// ---------------------------------------------------------------------------------------------

export interface ProjectSummary {
  id: string;
  name: string;
  rootPath: string;
  /** Does it have a tab in the strip right now? */
  open: boolean;
  /** Is it the concierge's pinned focus? */
  pinned: boolean;
  selected: boolean;
  agentCount: number;
  /** Of those, how many have a live process (see runningAgentsOf). */
  runningAgentCount: number;
}

/** Every project the app knows about, in tab order, with its open/pinned/selected state. */
export function listProjects(): WorkspaceResult<ProjectSummary[]> {
  const { projects, selectedProjectId } = useProjectStore.getState();
  const ui = useUiStore.getState();
  return ok(
    "list_projects",
    projects.map((p) => ({
      id: p.id,
      name: p.name,
      rootPath: p.rootPath,
      open: isProjectOpen(p.id, ui.openProjectIds),
      pinned: ui.pinnedProjectId === p.id,
      selected: selectedProjectId === p.id,
      agentCount: p.agents.length,
      runningAgentCount: runningAgentsOf(p).length,
    })),
  );
}

/**
 * Switch to a project that ALREADY has a tab (projectStore.selectProject, which also bumps its
 * recency so the "most recently used" tab reading stays honest).
 *
 * A project with no tab is refused rather than silently reopened: "switch to X" and "put X back on
 * screen" are different intents, and `openProjectTab` is the second one. The refusal says so.
 */
export function selectProject(projectId: string): WorkspaceResult<{ projectId: string }> {
  const project = projectById(projectId);
  if (!project) return refuse("select_project", "unknown-project", `No project with id ${projectId}.`);
  if (!isProjectOpen(projectId, useUiStore.getState().openProjectIds)) {
    return refuse(
      "select_project",
      "no-tab",
      `"${project.name}" has no open tab. Use open_project_tab to put it back on screen first.`,
    );
  }
  // Side-aware (engine/pairs). A bare `selectProject` for a LEFT-assigned project is reverted by
  // the Workspace's reconcile effect one commit later, so this returned `ok(...)` — and the agent
  // told the user it had switched — for a switch that visibly never happened (roborev 55158).
  selectProjectOnItsSide(projectId);
  return ok("select_project", { projectId });
}

/**
 * Open (or reopen) a project's tab and select it — services/openProjectTab, the same landing every
 * other "show me this project" surface uses. With `agentId`, also mount and reveal that agent.
 */
export function openProjectTab(
  projectId: string,
  agentId?: string | null,
): WorkspaceResult<{ projectId: string; agentId: string | null }> {
  const project = projectById(projectId);
  if (!project) {
    return refuse("open_project_tab", "unknown-project", `No project with id ${projectId}.`);
  }
  if (agentId && !project.agents.some((a) => a.id === agentId)) {
    // openProjectTab would push a phantom id into the open set; refuse before it does.
    return refuse(
      "open_project_tab",
      "unknown-agent",
      `"${project.name}" has no agent ${agentId}.`,
    );
  }
  openProjectTabService(projectId, agentId ?? null);
  return ok("open_project_tab", { projectId, agentId: agentId ?? null });
}

export interface CloseTabOutcome {
  projectId: string;
  /** The agents that were running when the tab closed — left alive unless `stopped`. */
  runningAgents: RunningAgent[];
  /** True only when the caller asked for `{ stopAgents: true }` and the sweep ran. */
  stopped: boolean;
}

export interface CloseTabOptions {
  /**
   * Also stop this project's running agents (kill the PTY, drop them from the runtime's open set) —
   * services/windowClose.stopOpenProjectAgents, the same sweep the window-close prompt runs. Off by
   * default, because closing a tab is a VIEW operation: services/projectTabs is explicit that a
   * closed project's PTYs keep running and that is what makes [×] safe.
   */
  stopAgents?: boolean;
}

/**
 * Close a project's tab, and SAY what was running.
 *
 * The tab close itself is services/projectTabs.closeProjectTab — it moves the selection to a
 * sensible neighbour and drops the concierge pin if it named this project. It does not delete the
 * project and does not touch disk.
 *
 * What this adds is contract 4: the result always carries `runningAgents`, so a concierge that
 * closes a tab can tell the user "three agents are still working in there" instead of leaving them
 * to discover it. When `stopAgents` is asked for, those same agents are stopped through
 * windowClose's sweep and the result reports itself as the `stop_project_agents` operation, whose
 * risk class is `disruptive` — so the caller sees the higher class it actually invoked.
 */
export async function closeProjectTab(
  projectId: string,
  opts: CloseTabOptions = {},
  deps: WorkspaceDeps = defaultWorkspaceDeps(),
): Promise<WorkspaceResult<CloseTabOutcome>> {
  const op: WorkspaceOp = opts.stopAgents ? "stop_project_agents" : "close_project_tab";
  const project = projectById(projectId);
  if (!project) return refuse(op, "unknown-project", `No project with id ${projectId}.`);

  const ui = useUiStore.getState();
  const displayed = openProjectsOf(useProjectStore.getState().projects, ui.openProjectIds);
  if (!displayed.some((p) => p.id === projectId)) {
    return refuse(op, "no-tab", `"${project.name}" has no open tab to close.`);
  }

  // Snapshot BEFORE the sweep — stopping drops ids from `openAgentIds`, so asking afterwards would
  // report an empty list for the very call that stopped them.
  const runningAgents = runningAgentsOf(project);

  if (opts.stopAgents) {
    const openAgentIds = new Set(useRuntimeStore.getState().openAgentIds);
    try {
      await deps.stopProjectAgents(project, openAgentIds);
    } catch (e) {
      // The tab is deliberately left OPEN: a half-stopped project whose tab vanished is the worst
      // of both, and the user needs the tab to see what state its agents are in.
      return refuse(op, "backend-failed", `Could not stop the agents: ${describe(e)}`);
    }
  }

  closeProjectTabService(projectId);
  return ok(op, { projectId, runningAgents, stopped: !!opts.stopAgents });
}

/**
 * Pin (or unpin) a project as the concierge's focus — uiStore's one-pin-at-a-time scope.
 *
 * `pinned` omitted toggles (uiStore.togglePinnedProject, what the tab's pin button does). Passing
 * an explicit boolean is IDEMPOTENT, which is what an AI caller wants: a retried "pin this" must
 * not silently unpin. Unpinning a project that isn't the pinned one leaves the real pin alone.
 */
export function setProjectPinned(
  projectId: string,
  pinned?: boolean,
): WorkspaceResult<{ projectId: string; pinned: boolean }> {
  const project = projectById(projectId);
  if (!project) {
    return refuse("set_project_pinned", "unknown-project", `No project with id ${projectId}.`);
  }
  const ui = useUiStore.getState();
  if (pinned === undefined) ui.togglePinnedProject(projectId);
  else if (pinned) ui.setPinnedProject(projectId);
  else if (ui.pinnedProjectId === projectId) ui.setPinnedProject(null);
  return ok("set_project_pinned", {
    projectId,
    pinned: useUiStore.getState().pinnedProjectId === projectId,
  });
}

/**
 * Move a project's tab, inserting it BEFORE `beforeProjectId` (`null` = to the end) —
 * projectStore.reorderProject, the same anchor semantics the tab strip's drag uses.
 *
 * An unknown anchor is REFUSED rather than passed through. The store appends on a missing anchor
 * (the right recovery for a tab closed mid-drag), but for a tool call a typo'd anchor silently
 * meaning "put it last" is a wrong move the caller can't see.
 */
export function reorderProjectTab(
  projectId: string,
  beforeProjectId: string | null,
): WorkspaceResult<{ order: string[] }> {
  if (!projectById(projectId)) {
    return refuse("reorder_project_tab", "unknown-project", `No project with id ${projectId}.`);
  }
  if (beforeProjectId !== null && !projectById(beforeProjectId)) {
    return refuse(
      "reorder_project_tab",
      "unknown-project",
      `No project with id ${beforeProjectId} to insert before.`,
    );
  }
  if (beforeProjectId === projectId) {
    return refuse("reorder_project_tab", "no-op", "That project is already in that position.");
  }
  useProjectStore.getState().reorderProject(projectId, beforeProjectId);
  return ok("reorder_project_tab", {
    order: useProjectStore.getState().projects.map((p) => p.id),
  });
}

/**
 * Add an EXISTING local folder as a project: git-init it if needed (`ensure_project_repo`, which is
 * what makes in-place Think/Chief/Shell work land somewhere recoverable), record it, and PUT A TAB
 * UP FOR IT — the record and the tab are two different writes, and see below for why both.
 *
 * `disruptive`, not `routine`, because `ensure_project_repo` writes to the user's disk at a path
 * the model chose; the risk map's entry carries the full reasoning.
 *
 * TAKES AN EXPLICIT PATH — and must. The human "+" flow opens a native folder picker
 * (services/dialog.pickProjectFolder); a tool call must never do that, because an AI caller cannot
 * answer an NSOpenPanel and the concierge bridge round-trip would sit at the modal until its 600s
 * ceiling, leaving a dialog on the user's screen with nobody to dismiss it. So the path is a
 * parameter, validated here, and a bad one comes back as an `invalid-path` refusal that says what a
 * good one looks like.
 *
 * The folder must not already be a project — a duplicate record would give one directory two
 * independent agent sets and two worktree pools.
 */
export async function addProjectFromFolder(
  path: string,
  name?: string,
  deps: WorkspaceDeps = defaultWorkspaceDeps(),
): Promise<WorkspaceResult<{ projectId: string; name: string; rootPath: string }>> {
  const problem = pathProblem(path);
  if (problem) return refuse("add_project_from_folder", "invalid-path", problem);
  const rootPath = normalizePath(path);

  // ALREADY A PROJECT? — and "already" means the same REPOSITORY, not the same string.
  //
  // This compared `p.rootPath === rootPath` exactly, which was strictly weaker than the human
  // picker's own dedupe (`services/openTarget.resolveOpenTarget` case-folds and NFC-normalizes)
  // — so the concierge could mint a duplicate record for a folder the "+" flow would have reused,
  // purely over casing or Unicode form. Two dedupe implementations for one question is how they
  // came to disagree; there is one now, and it is the engine's.
  //
  // It is also REPO-aware, which is the founder's bug: `~/Projects/sparkle` and
  // `~/Projects/sparkle-desktop` are one repository reached through a linked worktree, and an
  // exact-path compare was never going to see it (engine/projectIdentity).
  const projects = useProjectStore.getState().projects;
  const candidate = { id: "", name: folderName(rootPath), rootPath, repoKey: await repoKeyFor(rootPath) };
  const existing = projects.find((p) => isSameProject(p, candidate));
  if (existing) {
    // STILL A REFUSAL HERE, and deliberately not the focus-and-tell the tab bar does. This tool's
    // contract is "ADD a folder as a project", and the folder already is one — there is nothing to
    // add, and the model needs to be told so it can pick a different next action. The refusal names
    // the project so the model can call `open_project_tab` on it, which IS the focusing path.
    // WHICH SENTENCE — decided by the SAME normalizer the match was made with. An exact string
    // compare here called a case-only or NFD/NFC difference "a linked git worktree", which is
    // false: it is one directory spelled two ways, and a refusal message is an instruction the
    // model will act on (AGENTS.md).
    const why =
      pathKey(existing.rootPath) === pathKey(rootPath)
        ? `${rootPath} is already the project "${existing.name}" (${existing.id}).`
        : `${rootPath} is the same repository as the project "${existing.name}" (${existing.id}, ` +
          `at ${existing.rootPath}) — a linked git worktree, not a separate project. ` +
          `Use open_project_tab with ${existing.id} to show it.`;
    return refuse("add_project_from_folder", "already-added", why);
  }

  try {
    await deps.ensureProjectRepo(rootPath);
    // …which GIT-INITS an empty folder, so the answer cached above ("not a repo") is now stale and
    // would be what this whole session sees. Drop it, and resolve again below against the folder
    // as it now is — otherwise a concierge-added project never acquires a repo key and a later
    // worktree of it dedupes against nothing.
    forgetRepoKey(rootPath);
  } catch (e) {
    // Nothing is added on failure: a project row pointing at a folder we could not prepare is a
    // tab that breaks on its first agent spawn.
    return refuse(
      "add_project_from_folder",
      "backend-failed",
      `Could not prepare ${rootPath} as a project: ${describe(e)}`,
    );
  }

  const finalName = name?.trim() || folderName(rootPath);
  const projectId = useProjectStore.getState().addProject(finalName, rootPath);
  // Record the repository this folder belongs to, so the next add/open dedupes against it without
  // waiting for the startup sweep — and read it AFTER `ensureProjectRepo`, which is what may have
  // made it a repository in the first place.
  await resolveRepoKeyFor(projectId);
  // …and OPEN it. `addProject` only sets `selectedProjectId`; it does not touch the open set, so on
  // its own it leaves the new project SELECTED WITH NO TAB for anyone whose `openProjectIds` is a
  // real array — i.e. anyone who has ever closed a tab (roborev 54174). The state would even be
  // self-inconsistent with this module: `selectProject` on the project we just added would refuse
  // it as `no-tab`. This is the same pairing the human "+" flow makes
  // (components/ProjectTabsBar: `openProjectTab(addProject(name, path))`), through the same
  // service, so a concierge-added project lands exactly where a picked one does.
  openProjectTabService(projectId);
  return ok("add_project_from_folder", { projectId, name: finalName, rootPath });
}

/**
 * The second of TWO gates, and the weaker one. Be precise about which is which (roborev 54174):
 *
 *  • THE HUMAN GATE is the policy layer. services/conciergeTools/policy.ts derives `ask` for every
 *    risk class above `routine`, so `remove_project`, `relocate_project` and `quit_app` cannot be
 *    dispatched at all until a person rules on them. That is the gate with a human in it.
 *  • THIS one is a DELIBERATENESS CHECK ON THE MODEL. `confirm` is a parameter the AI caller
 *    supplies, so on its own it stops only an accident: a mis-parsed instruction, or a tool call
 *    assembled from a half-understood sentence, cannot delete or move anything by default. A model
 *    that MEANT to remove the project simply re-issues with `confirm: true` one turn later, and the
 *    refusal message is written to be quoted at the human in between.
 *
 * So the flag is worth having and is not a substitute for the first gate. What must never happen is
 * the two collapsing into one: if a confirm-gated op were ever reclassified down to `routine`, the
 * policy layer would auto-allow it and the model's own boolean would be the ONLY thing standing
 * between a sentence and a destroyed project. `CONFIRM_GATED_OPS` exists so a test can assert that
 * every op named here is still classified above the auto-allow line.
 */
export interface ConfirmOption {
  /** Must be `true` — see `ConfirmOption`'s note on what this gate is and is not. */
  confirm: boolean;
}

/** The ops that refuse without `confirm: true`. Kept as data so the risk of each stays assertable;
 *  see `ConfirmOption`. Add a function that takes a `ConfirmOption` and it belongs here. */
export const CONFIRM_GATED_OPS = [
  "remove_project",
  "relocate_project",
  "quit_app",
] as const satisfies readonly WorkspaceOp[];

/**
 * DESTRUCTIVE — remove a project from Sparkle (projectStore.removeProject). Tombstones the project
 * and its agents so the removal survives a cross-window merge, and clears the concierge pin if it
 * named this project. It leaves the user's FOLDER alone, but the agent records, their prompt
 * history and their worktree bookkeeping go with it, and nothing in the app puts them back.
 *
 * Requires `confirm: true`, and refuses while agents are running — removing a project out from
 * under a live PTY orphans the process and its worktree.
 */
export function removeProject(
  projectId: string,
  opts: ConfirmOption,
): WorkspaceResult<{ projectId: string; name: string }> {
  const project = projectById(projectId);
  if (!project) return refuse("remove_project", "unknown-project", `No project with id ${projectId}.`);
  if (!opts.confirm) {
    return refuse(
      "remove_project",
      "confirmation-required",
      `Removing "${project.name}" deletes its ${project.agents.length} agent record(s) and cannot be undone. Re-issue with confirm: true.`,
    );
  }
  const running = runningAgentsOf(project);
  if (running.length) {
    return refuse(
      "remove_project",
      "agents-running",
      `"${project.name}" still has ${running.length} running agent(s): ${nameList(running)}. Stop them first.`,
    );
  }
  useProjectStore.getState().removeProject(projectId);
  return ok("remove_project", { projectId, name: project.name });
}

/**
 * DESTRUCTIVE — move the project's FOLDER ON THE USER'S DISK to `newPath` (`move_project`, which
 * also repairs the worktree links) and repoint the project record at it.
 *
 * This is not an app-state edit. It renames a directory the user owns; anything outside Sparkle
 * pointing at the old location (an editor window, a shell, a bookmark) breaks. Hence
 * `irreversible`, `confirm: true`, and an explicit destination path — never a picker (see
 * `addProjectFromFolder` for why).
 *
 * Refuses while agents are running: their PTYs hold the OLD working directory, which is exactly the
 * warning services/worktree.moveProjectFolder carries.
 */
export async function relocateProject(
  projectId: string,
  newPath: string,
  opts: ConfirmOption,
  deps: WorkspaceDeps = defaultWorkspaceDeps(),
): Promise<WorkspaceResult<{ projectId: string; oldPath: string; newPath: string }>> {
  const project = projectById(projectId);
  if (!project) {
    return refuse("relocate_project", "unknown-project", `No project with id ${projectId}.`);
  }
  const problem = pathProblem(newPath);
  if (problem) return refuse("relocate_project", "invalid-path", problem);
  const dest = normalizePath(newPath);
  if (dest === project.rootPath) {
    return refuse("relocate_project", "no-op", `"${project.name}" is already at ${dest}.`);
  }
  if (!opts.confirm) {
    return refuse(
      "relocate_project",
      "confirmation-required",
      `This MOVES the folder ${project.rootPath} to ${dest} on disk. Re-issue with confirm: true.`,
    );
  }
  const running = runningAgentsOf(project);
  if (running.length) {
    return refuse(
      "relocate_project",
      "agents-running",
      `"${project.name}" has ${running.length} running agent(s) holding the old directory: ${nameList(running)}. Stop them first.`,
    );
  }
  try {
    await deps.moveProjectFolder(project.rootPath, dest);
  } catch (e) {
    // The record is left pointing at the old path — the folder never moved, so repointing would
    // aim the project at a directory that does not exist.
    return refuse("relocate_project", "backend-failed", `Could not move the folder: ${describe(e)}`);
  }
  useProjectStore.getState().relocateProject(projectId, project.name, dest);
  return ok("relocate_project", { projectId, oldPath: project.rootPath, newPath: dest });
}

// ---------------------------------------------------------------------------------------------
// WINDOW / APP LEVEL
// ---------------------------------------------------------------------------------------------

/** Reveal and focus the main window. Closing it only HIDES it, so this is the way back in. */
export function showMainWindow(deps: WorkspaceDeps = defaultWorkspaceDeps()): WorkspaceResult<null> {
  deps.showMainWindow();
  return ok("show_main_window", null);
}

/**
 * Show or hide the floating helper island.
 *
 * Writes the PREFERENCE only (helper/helperPrefs), which is the single authority on the value: the
 * island's own webview re-hydrates on the cross-webview `storage` event and runs its own
 * show/hide + native-menu-label effects. Calling `show_helper`/`hide_helper` from here as well
 * would drive the window behind the store's back and fight HelperApp's visibility effect (which
 * also weighs frontmost, the capture takeover, and placement).
 */
export function setHelperEnabled(enabled: boolean): WorkspaceResult<{ enabled: boolean }> {
  useHelperPrefs.getState().setEnabled(enabled);
  return ok("set_helper_enabled", { enabled });
}

export interface HelperBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Move + resize the island in one call (two round-trips would render an intermediate frame at the
 *  wrong geometry). Non-finite or non-positive sizes are refused rather than forwarded — the
 *  backend would happily collapse the island to nothing, with no affordance to get it back. */
export function setHelperBounds(
  bounds: HelperBounds,
  deps: WorkspaceDeps = defaultWorkspaceDeps(),
): WorkspaceResult<HelperBounds> {
  const { x, y, width, height } = bounds;
  const finite = [x, y, width, height].every((n) => Number.isFinite(n));
  if (!finite || width <= 0 || height <= 0) {
    return refuse(
      "set_helper_bounds",
      "invalid-bounds",
      "Helper bounds need finite x/y and a positive width and height.",
    );
  }
  deps.setHelperBounds(x, y, width, height);
  return ok("set_helper_bounds", bounds);
}

export interface QuitOutcome {
  /** Everything that is about to be killed, across every project. */
  runningAgents: RunningAgent[];
}

/**
 * IRREVERSIBLE — quit Sparkle. This is the real quit (closing the main window only hides it), and
 * it takes EVERY running agent in EVERY project with it; their processes die with the app.
 *
 * Requires `confirm: true`, and the refusal names exactly what would be killed, so the concierge
 * can put that in front of the human before asking again.
 */
export async function quitApp(
  opts: ConfirmOption,
  deps: WorkspaceDeps = defaultWorkspaceDeps(),
): Promise<WorkspaceResult<QuitOutcome>> {
  const runningAgents = allRunningAgents();
  if (!opts.confirm) {
    const what = runningAgents.length
      ? `This kills ${runningAgents.length} running agent(s): ${nameList(runningAgents)}.`
      : "No agents are running.";
    return refuse(
      "quit_app",
      "confirmation-required",
      `Quitting Sparkle closes the app entirely. ${what} Re-issue with confirm: true.`,
    );
  }
  deps.quitApp();
  return ok("quit_app", { runningAgents });
}

/**
 * HOW MUCH of the durable history one search may see.
 *
 *  • `"default"` — build and brainstorm history, AND the delegation ledger. `concierge`-sourced rows
 *    are filtered OUT of the result. This is what the concierge has always been able to see, and it
 *    stays the default when the model omits the argument.
 *  • `"all"` — everything, `concierge` rows included.
 *
 * `dispatch` ROWS ARE VISIBLE AT DEFAULT SCOPE, AND THAT IS A DECISION RATHER THAN AN OMISSION.
 * When the delegation ledger was added (services/dispatchLedger.ts) it would have been easy to
 * extend the filter below to two sources, on the reflex that a narrower default is always the safer
 * one. It is not, here, and the reasoning below is written out so nobody "tidies" it that way later.
 *
 * The gate exists for ONE reason, stated in the next paragraph: the founder's PRIVATE conversations
 * with his minder must not be silently vacuumed back up by the model. A dispatch row is the exact
 * opposite kind of object — a record of work the concierge ITSELF started, on the founder's
 * instruction, which he then asks it about later. Hiding those by default would re-create, in this
 * one tool, the precise failure the ledger was built to fix: on 2026-08-22 the concierge answered a
 * question about preview-card work as if it had never heard of it, eight minutes after spawning an
 * agent to do exactly that. A second route to that answer is a feature, not a leak.
 *
 * The dedicated `recall_dispatches` op is still the PRIMARY path — it joins each row to live state,
 * which a raw hit cannot. This is the incidental one, and every hit carries its own `source` so a
 * caller can always tell a ledger row from a conversation.
 *
 * WHY THIS ARGUMENT EXISTS. The founder's private conversations with the concierge are TO BE
 * recorded into the same `history.db` that `search_history` queries. His decision was that those
 * rows must be recorded and findable BY HIM, but that the concierge model must not be able to
 * silently vacuum them back up — a model that can read every past turn of every private
 * conversation is a different thing from one that can search build logs.
 *
 * THE RECORDING HALF HAS SINCE LANDED — `services/conciergeHistoryCapture.ts`. This gate was built
 * first on purpose, so the rows were never readable without one. Two constraints it had to satisfy
 * for this gate to hold, both of which it does; they are stated here because neither is discoverable
 * from the enum alone, and either one silently regressing re-opens the door:
 *
 *   1. every concierge row carries `source: "concierge"`. The filter below is on that field and
 *      nothing else; a row written under `build` is indistinguishable from a build log.
 *      SATISFIED: `conciergeHistoryCapture.conversationEntry` sets it literally, and the same
 *      literal is what `prune_in_with_max`'s SQL matches — one string, three consumers.
 *   2. concierge rows do NOT carry a live agent's `agentId`. `conciergeTools/terminal.ts`'s history
 *      tier is `read-only` (auto-allowed) and selects by `agentId`; it ALSO drops
 *      `source: "concierge"`, but do not spend that defence — stamping the column's
 *      `mountedAgentId` onto a concierge turn would put private text one filter away in a tool that
 *      never asks. SATISFIED: the capture writes `agentId: null` (and `projectId: null`), because
 *      the concierge is cross-project by construction rather than as a privacy measure.
 *
 * Retention has landed too: `src-tauri/src/history.rs`'s `prune_in_with_max` excludes
 * `source = 'concierge'` from both age statements and bounds those rows by count instead.
 *
 * WHY THE GATE IS HERE RATHER THAN IN THE ALLOWLIST. The obvious alternative — leave the tool alone
 * and withhold it from `--allowedTools` — does not work. `src-tauri/src/concierge.rs` records,
 * measured against Claude Code 2.1.220, that `--allowedTools` does NOT gate MCP tools at all; the
 * only real gate on this surface is the `controlListener` policy. So the distinction has to be a
 * property of the CALL that the policy layer can see, which is what `scope` is. `policy.ts`'s
 * `perCallRiskFor` reads it and escalates a `scope: "all"` call to an approval card.
 *
 * The filter is applied to what the backend RETURNED, on the hits' own `source` field, rather than
 * pushed into the query — history.rs owns the search and this module is a façade over it (contract
 * 1 in the header), and a second WHERE clause written here would be a second definition of "which
 * rows exist". One consequence worth knowing: `limit` is applied by the backend BEFORE this filter,
 * so a default-scope search can come back with fewer than `limit` hits. That is the honest
 * behaviour — over-fetching to refill the page would mean reading MORE concierge rows in order to
 * show fewer, which is the opposite of the point.
 */
// Re-exported, not redeclared: one vocabulary, defined in @sparkle/core/historyScope. It is
// IMPORTED (above) and then re-exported, rather than the one-line `export type { X } from "…"`:
// that form is a pure pass-through and never binds the name locally, so the three uses below —
// `DEFAULT_HISTORY_SEARCH_SCOPE`, `HistorySearchOptions`, and `searchHistory`'s own signature —
// could not see it.
export type { HistorySearchScope };

/** What applies when the model omits `scope`. The narrow one, deliberately: an omitted argument
 *  must never be the one that widens what a model can see. */
export const DEFAULT_HISTORY_SEARCH_SCOPE: HistorySearchScope = "default";

export interface HistorySearchOptions {
  scope?: HistorySearchScope;
}

/** Command-palette style full-text search across prompt/response history. A blank query is refused
 *  here rather than round-tripped for a guaranteed empty result.
 *
 *  NOT the ⌘K palette's own path: the palette calls services/history's `searchHistory` directly via
 *  stores/historyStore and is unaffected by `scope` — the human searching their own machine sees
 *  every source, always. This function is the MODEL's door onto the same index. */
export async function searchHistory(
  query: string,
  limit?: number,
  opts: HistorySearchOptions = {},
  deps: WorkspaceDeps = defaultWorkspaceDeps(),
): Promise<WorkspaceResult<HistoryHit[]>> {
  if (!query.trim()) {
    return refuse("search_history", "blank-query", "Give me something to search for.");
  }
  const scope = opts.scope ?? DEFAULT_HISTORY_SEARCH_SCOPE;
  try {
    const hits = await deps.searchHistory(query, limit);
    return ok(
      "search_history",
      scope === WIDE_HISTORY_SCOPE ? hits : hits.filter((h) => h.source !== "concierge"),
    );
  } catch (e) {
    return refuse("search_history", "backend-failed", `History search failed: ${describe(e)}`);
  }
}

/**
 * Jump to a history hit's source agent — the palette's own routing
 * (Concierge/paletteJump.jumpToHit with its real deps), so a tool-driven jump lands exactly where a
 * click on that row would, scroll-to-turn correlation included.
 *
 * The two outcomes that did NOT navigate (`agent-closed`, `project-gone`) become refusals with the
 * same names, so the caller can say why instead of claiming it moved.
 */
export function jumpToHistoryHit(
  hit: HistoryHit,
): WorkspaceResult<{ outcome: "jumped-here" | "focused-elsewhere" | "opened-window" }> {
  const outcome = jumpToHit(hit, defaultJumpDeps());
  if (outcome.kind === "agent-closed") {
    return refuse("jump_to_history_hit", "agent-closed", "That agent is gone — nothing to jump to.");
  }
  if (outcome.kind === "project-gone") {
    return refuse("jump_to_history_hit", "project-gone", "That result isn't tied to a project any more.");
  }
  return ok("jump_to_history_hit", { outcome: outcome.kind });
}
