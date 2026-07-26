// The shell's two small "what does this id actually point at" rules (CM-U7), pulled out of
// Workspace so they're testable without rendering the whole app.
//
// Both exist because persisted ids outlive the things they name: a pin survives the project it
// pinned, and a selectedAgentId survives the agent it selected. Resolving them defensively at the
// read site is what keeps a stale id from silently zeroing the concierge or aiming the compose box
// at nothing.
import { agentDisplayName } from "./agentDisplayName";
import type { AgentTab, Project } from "../types";

/**
 * The pin, or null when it names a project that isn't there. The pin scopes the concierge's
 * surfaced P0/P1 and no tab renders for a missing project — so a dangling pin would zero the
 * vitals with no affordance to clear it.
 */
export function resolvePinnedProjectId(
  projects: readonly Project[],
  pinnedProjectId: string | null,
): string | null {
  return projects.some((p) => p.id === pinnedProjectId) ? pinnedProjectId : null;
}

/** The agent the concierge compose box can prompt directly. */
export interface PromptTarget {
  projectId: string;
  agentId: string;
  /** The name the user sees on the row (engine/agentDisplayName). */
  name: string;
}

/**
 * The selected tab's selected agent, or null when there is no project, no selection, or the
 * selection names an agent that no longer exists.
 */
export function resolvePromptTarget(
  project: Project | null,
  activeAgentId: string | null,
): PromptTarget | null {
  if (!project || !activeAgentId) return null;
  const agent: AgentTab | undefined = project.agents.find((a) => a.id === activeAgentId);
  if (!agent) return null;
  return { projectId: project.id, agentId: agent.id, name: agentDisplayName(agent) };
}
