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
    kill: (id) => killPty(id, "window-close"),
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
 *
 * CONCURRENT ACROSS AGENTS, and that is now load-bearing (roborev 62743). `pty_kill` holds each
 * PTY open until its `SessionEnd` hook line lands, bounded at 750ms — and a TIMEOUT is not the rare
 * shape: any agent whose Claude Code child has already exited still HAS a hook log, so the Rust side
 * waits out the full deadline for a line that will never come. Awaited one-at-a-time that is
 * `N × 750ms` of a visibly hung window with the close prompt already dismissed — 15s for 20 agents.
 * Run together, THIS PROJECT's sweep costs about one deadline.
 *
 * Scoped precisely, because the obvious over-claim is wrong (roborev 62786): that is one deadline
 * per PROJECT, not one per quit. `killAllOpenAgents` below still awaits this function per project
 * in sequence, and one window hosts every project as a tab — so a user with 5 projects holding open
 * agents still waits ~3.75s. Lifting that too would mean overturning its deliberate "so a slow PTY
 * kill can't race a later runtime write" sequencing, which is a separate decision from this one.
 *
 * The kills are independent by construction: distinct agent ids, distinct PTYs, and `deps.close`
 * is a synchronous single-id store write, so interleaving two of them cannot tear a shared value.
 * `isLive` is sampled up front, which is the same snapshot the sequential version took — no kill
 * here can make a DIFFERENT agent's pane stop being live.
 */
export async function stopOpenProjectAgents(
  project: Project,
  openIds: ReadonlySet<string>,
  deps: KillDeps = realDeps(),
  isLive: (agentId: string) => boolean = defaultIsLive,
): Promise<void> {
  const targets = project.agents.filter(
    // Never-mounted agents have nothing running: leave them in the open set so they resume
    // next launch untouched (roborev 46319).
    (a) => openIds.has(a.id) && isLive(a.id),
  );
  await Promise.all(
    targets.map(async (a) => {
      await deps.kill(a.id).catch(() => {});
      deps.close(a.id);
    }),
  );
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

/**
 * THE ONE GATE THAT KEEPS A CLOSE FROM NUKING THE WHOLE FLEET (sparkle-9ch9i).
 *
 * `killAllOpenAgents` stops EVERY project's running agents — one window hosts every project as a
 * tab, so on a genuine app QUIT that is correct: the process is exiting, its PTYs die with it, and
 * stopping them first is what keeps the next launch from resurrecting all of them (see
 * `projectsWithOpenAgents`). But that justification holds ONLY when the app is actually going away.
 *
 * When the plan HIDES the window instead of destroying it — the main window while other windows
 * remain, or headless-survival on "keep" — the process keeps running, every project's agents keep
 * running normally, and there is no imminent relaunch to pre-empt. Firing the fleet-wide kill there
 * stops 80+ agents across every project in one second while the app is still up and the window the
 * user closed merely slid out of view: the reported catastrophe (uncommitted work lost, the whole
 * fleet gone, unbidden). A hidden window is not a quit, so it must not stop agents it does not own.
 *
 * So: stop the fleet ONLY when `killAgents` is set AND we are NOT hiding. Callers pass the plan they
 * are about to enact, so the decision and the teardown cannot drift apart.
 */
export async function stopAgentsForClose(
  plan: ClosePlan,
  projects: readonly Project[],
  openAgentIds: readonly string[],
  deps: KillDeps = realDeps(),
  isLive: (agentId: string) => boolean = defaultIsLive,
): Promise<void> {
  // `plan.hide` is the guard: a window that only hides leaves the app — and thus every project's
  // agents — alive, so there is nothing this close is entitled to tear down.
  if (!plan.killAgents || plan.hide) return;
  await killAllOpenAgents(projects, openAgentIds, deps, isLive);
}
