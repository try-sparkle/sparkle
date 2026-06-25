// Kill all of a project's agents (PTYs) and drop them from the stores. Used by the
// "Kill agents & close project" branch of the close prompt. The project record itself is
// left intact so it remains in Recent.
import { killPty } from "../pty";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import type { Project } from "../types";

interface KillDeps {
  kill(id: string): Promise<void>;
  close(id: string): void;
  removeAgent(projectId: string, agentId: string): void;
}

function realDeps(): KillDeps {
  return {
    kill: (id) => killPty(id),
    close: (id) => useRuntimeStore.getState().close(id),
    removeAgent: (pid, aid) => useProjectStore.getState().removeAgent(pid, aid),
  };
}

export async function killProjectAgents(
  project: Project,
  deps: KillDeps = realDeps(),
): Promise<void> {
  for (const a of project.agents) {
    await deps.kill(a.id).catch(() => {});
    deps.close(a.id);
    deps.removeAgent(project.id, a.id);
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
