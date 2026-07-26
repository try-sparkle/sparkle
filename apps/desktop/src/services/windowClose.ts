// STOP a project's running agents — kill the PTY and unmount the pane — for the "stop the agents
// as well" branch of the close prompt. The agent RECORDS survive: the button says stop, not
// delete, and the projects and their agent tabs are all still there on the next launch.
import { killPty } from "../pty";
import { paneState } from "./paneReadiness";
import { useRuntimeStore } from "../stores/runtimeStore";
import type { Project } from "../types";

interface KillDeps {
  kill(id: string): Promise<void>;
  close(id: string): void;
}

function realDeps(): KillDeps {
  return {
    kill: (id) => killPty(id),
    close: (id) => useRuntimeStore.getState().close(id),
  };
}

/**
 * Stop the agents of `project` that are currently OPEN: kill the PTY, then drop the id from the
 * runtime's open set so nothing resumes it on the next launch.
 *
 * Two things this deliberately does NOT do, both regressions caught in review (roborev 46291-M2):
 *  - it does not touch agents outside `openIds`. A closed agent has no PTY to kill, and the
 *    cross-project sweep below would otherwise reach into background projects and destroy tabs the
 *    user never opened in this session.
 *  - it does not `removeAgent`. That call tombstones the row, closes its workers and clears account
 *    pins, and leaves the agent's worktree orphaned (worktree cleanup is the caller's job and was
 *    never done here) — for a button whose copy is "stop them when you close this window".
 */
export async function stopOpenProjectAgents(
  project: Project,
  openIds: ReadonlySet<string>,
  deps: KillDeps = realDeps(),
  isLive: (agentId: string) => boolean = defaultIsLive,
): Promise<void> {
  for (const a of project.agents) {
    if (!openIds.has(a.id)) continue;
    // Never-mounted agents have nothing running: leave them in the open set so they resume
    // next launch untouched (roborev 46319).
    if (!isLive(a.id)) continue;
    await deps.kill(a.id).catch(() => {});
    deps.close(a.id);
  }
}

/**
 * The projects "Kill agents & close" has to act on: every project with at least one agent in the
 * runtime's OPEN set.
 *
 * SINGLE-WINDOW SHELL (CM-U7): a window used to host exactly one project, so killing the selected
 * tab's agents was the whole job. Now one window hosts every project as a tab, and `openAgentIds`
 * is global — so killing only the selected tab left every other project's agents in the store as
 * live. The app quits (their PTYs die with the process) and the NEXT launch resumes them all, which
 * is the opposite of what the user asked for, at real token cost.
 *
 * Pure and exported so the invariant is testable without a window.
 */
export function projectsWithOpenAgents(
  projects: readonly Project[],
  openAgentIds: readonly string[],
  isLive: (agentId: string) => boolean = defaultIsLive,
): Project[] {
  const open = new Set(openAgentIds);
  return projects.filter((p) => p.agents.some((a) => open.has(a.id) && isLive(a.id)));
}

/** "Running" means a pane actually exists — since lazy mounting (CM-U7 hardening), an agent can
 *  be `open` from a prior launch in a never-visited project with no pane and no process. The copy
 *  must not claim those are running, and the sweep must not touch them: they were never started,
 *  so `stop` has nothing to stop and dropping them from `openAgentIds` would silently prevent
 *  their resume next launch (roborev 46319). */
function defaultIsLive(agentId: string): boolean {
  const st = paneState(agentId);
  // `failed` has no process either (the spawn never came up) — warning "agents are still
  // running" about it would be the same small lie (roborev 47018).
  return st === "starting" || st === "ready";
}

/**
 * The names the close prompt should say the stop applies to: every project with a running agent,
 * the FRONT one first when it has any (that's the tab the user is looking at). Empty when nothing
 * is running — the prompt then says "the running agents" rather than naming a project whose agents
 * are all stopped.
 */
export function closeScopeProjectNames(
  projects: readonly Project[],
  openAgentIds: readonly string[],
  frontProjectId: string | null | undefined,
  isLive: (agentId: string) => boolean = defaultIsLive,
): string[] {
  const running = projectsWithOpenAgents(projects, openAgentIds, isLive);
  const front = running.find((p) => p.id === frontProjectId);
  const rest = running.filter((p) => p.id !== frontProjectId);
  return (front ? [front, ...rest] : rest).map((p) => p.name);
}

/** Stop EVERY project's open agents (see projectsWithOpenAgents). Sequential, so a slow PTY kill
 *  can't race a later runtime write. */
export async function killAllOpenAgents(
  projects: readonly Project[],
  openAgentIds: readonly string[],
  deps: KillDeps = realDeps(),
  isLive: (agentId: string) => boolean = defaultIsLive,
): Promise<void> {
  const open = new Set(openAgentIds);
  for (const p of projectsWithOpenAgents(projects, openAgentIds, isLive)) {
    await stopOpenProjectAgents(p, open, deps, isLive);
  }
}

export type CloseMode = "keep" | "kill";

export interface ClosePlan {
  /** Kill this project's agents/PTYs first. */
  killAgents: boolean;
  /** Hide the window (keep the process + agents alive) instead of destroying it. */
  hide: boolean;
  /** Remove this window's registry mapping (only when the window is actually destroyed — a
   *  hidden window must stay findable so a later open can reveal it). */
  clearRegistry: boolean;
}

/**
 * Pure decision for the close-button flow. Two reasons to hide instead of destroy:
 *  - "keep agents running" on the LAST window — keeps the live-window count > 0 so the app
 *    doesn't auto-exit (headless survival).
 *  - the MAIN window while other windows remain — the main window hosts the app-owned Sparkle
 *    singleton and the fixed "main" label, so it must outlive the close button as long as the
 *    app runs; it's only ever destroyed when it is the last window and the user picks "kill"
 *    (which quits the app anyway).
 * Everything else destroys. We only clear the registry when actually destroying (a hidden
 * window must stay findable so a later open can reveal it).
 */
export function planWindowClose(mode: CloseMode, isLast: boolean, isMain: boolean): ClosePlan {
  const hide = (mode === "keep" && isLast) || (isMain && !isLast);
  return { killAgents: mode === "kill", hide, clearRegistry: !hide };
}
