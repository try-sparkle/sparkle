// Jump dispatch for the concierge command palette (bead sparkle-2yqm / CM-U5): given a
// history hit, route the user to the AGENT that produced it — as a PURE function over
// injectable deps, returning a typed outcome instead of flashing UI, so the palette (and
// tests) can react to each path.
//
// SINGLE-WINDOW SHELL (CM-U7): the three-way router is now two-way in practice. A hit in the
// selected project selects in place; a hit anywhere else switches to that project's TAB and
// reveals the agent there. `projectHasWindow` therefore defaults to false and the
// "open elsewhere" dep is a tab switch — the shape is kept so the outcomes (and their tests)
// stay stable, and so a caller can still inject its own routing.
import type { HistoryHit } from "../../services/history";
import type { PromptHistoryEntry } from "../../types";
import { useProjectStore } from "../../stores/projectStore";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { useScrollIntentStore } from "../../stores/scrollIntentStore";
import { correlatePromptId } from "../promptCorrelate";
import { openProjectTab } from "../../services/openProjectTab";

/** Retained shape of the injectable router: "new" is the only mode the single-window shell asks
 *  for, and it means "make that project the active tab". */
export type OpenMode = "replace" | "new";

/** What happened when the user activated a hit. `agent-closed` and `project-gone` mean we
 *  did NOT navigate — the palette stays open and tells the user why. */
export type JumpOutcome =
  | { kind: "jumped-here" }
  | { kind: "focused-elsewhere" }
  | { kind: "opened-window" }
  | { kind: "agent-closed" }
  | { kind: "project-gone" };

/** Everything jumpToHit needs from the app. Injected in tests; `defaultJumpDeps()` wires the
 *  real stores/services (the same ones HistorySearch defaults to). */
export interface JumpDeps {
  /** This window's current project id (hits here select in place). */
  currentProjectId: string | null;
  /** Does the hit's source agent still exist (i.e. hasn't been closed)? */
  agentExists: (projectId: string, agentId: string | null) => boolean;
  /** Select + mount an agent that lives in THIS window's project. */
  selectAgentHere: (projectId: string, agentId: string) => void;
  /** Ask the window that owns the hit's project to bring itself forward and focus the agent. */
  focusAgentElsewhere: (projectId: string, agentId: string) => void;
  /** Is some window currently showing this project? */
  projectHasWindow: (projectId: string) => boolean;
  /** The agent's recorded prompts, for correlating a hit to a terminal marker. */
  promptHistoryFor: (projectId: string, agentId: string) => PromptHistoryEntry[];
  /** Queue a "scroll this agent's terminal to a prompt" intent. */
  requestScroll: (agentId: string, promptId: string) => void;
  /** Route a hit's project into view (select its tab), deep-linking to its agent. */
  openInWindow: (projectId: string, mode: OpenMode, agentId?: string) => void;
}

/** Route the user to the hit's source agent, reporting which path was taken. Scroll-to-turn
 *  correlation only applies on the in-window path (the scroll-intent store is per-window and
 *  the marker only exists in a terminal mounted in this session); a correlation miss simply
 *  doesn't scroll. */
export function jumpToHit(h: HistoryHit, deps: JumpDeps): JumpOutcome {
  if (!h.projectId) return { kind: "project-gone" };
  if (!h.agentId || !deps.agentExists(h.projectId, h.agentId)) return { kind: "agent-closed" };

  if (h.projectId === deps.currentProjectId) {
    deps.selectAgentHere(h.projectId, h.agentId);
    const promptId = correlatePromptId(h, deps.promptHistoryFor(h.projectId, h.agentId));
    if (promptId) deps.requestScroll(h.agentId, promptId);
    return { kind: "jumped-here" };
  }
  if (deps.projectHasWindow(h.projectId)) {
    deps.focusAgentElsewhere(h.projectId, h.agentId);
    return { kind: "focused-elsewhere" };
  }
  deps.openInWindow(h.projectId, "new", h.agentId);
  return { kind: "opened-window" };
}

/** The real wiring — the same defaults HistorySearch builds inline. */
export function defaultJumpDeps(): JumpDeps {
  return {
    currentProjectId: useProjectStore.getState().selectedProjectId,
    agentExists: (projectId, agentId) => {
      if (!agentId) return false;
      const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
      return !!project?.agents.some((a) => a.id === agentId);
    },
    selectAgentHere: (projectId, agentId) => {
      useRuntimeStore.getState().open(agentId);
      useProjectStore.getState().selectAgent(projectId, agentId);
    },
    // Both cross-project paths collapse to the same act now: select that project's tab and
    // reveal the agent. projectHasWindow is false so every such hit takes openInWindow below.
    focusAgentElsewhere: (projectId, agentId) => openProjectTab(projectId, agentId),
    projectHasWindow: () => false,
    promptHistoryFor: (projectId, agentId) => {
      const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
      return project?.agents.find((a) => a.id === agentId)?.promptHistory ?? [];
    },
    requestScroll: (agentId, promptId) =>
      useScrollIntentStore.getState().request(agentId, promptId),
    openInWindow: (projectId, _mode, agentId) => openProjectTab(projectId, agentId),
  };
}
