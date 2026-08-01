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

/** The compose box's target decision AND, when it refuses, the honest reason for the disabled
 *  toggle. ONE function so the two can't drift: every refusal branch below has to write its own
 *  copy on the way out, which is exactly what a second `return null` in a separate resolver would
 *  have silently skipped — leaving the toggle saying "select an agent" about an agent the user can
 *  see is selected (roborev 49295/52649). `refusal` is undefined when there is nothing to explain:
 *  no project, or no selection at all, where the default copy is already right. */
export interface PromptTargetDecision {
  target: PromptTarget | null;
  refusal?: string;
}

/** A surface that OWNS the far end of the cable without being a project tab — today only the
 *  Improve-Sparkle pane. Its agent is app-owned and DELIBERATELY never a member of `project.agents`
 *  (services/knownAgents), so it can never resolve through the roster lookup below; it is passed in
 *  already-resolved because this module reads no stores. */
export interface SpecialPromptTarget {
  projectId: string;
  agentId: string;
  name: string;
}

export function decidePromptTarget(
  project: Project | null,
  activeAgentId: string | null,
  special?: SpecialPromptTarget | null,
): PromptTargetDecision {
  // A SPECIAL SURFACE OWNS THE FAR END (bead sparkle-0rf5). The Improve-Sparkle pane's agent is not a
  // roster row, so it neither can nor should be resolved against `project.agents` — feeding the pair's
  // build agent here (or nothing) is what let a mounted concierge send miss the agent entirely. It is
  // a promptable local PTY (findKnownAgent's `sparkle` arm), so it is a target with no refusal. Wins
  // over the roster path because when it is set the roster is not what the user is looking at.
  if (special) {
    return {
      target: { projectId: special.projectId, agentId: special.agentId, name: special.name },
    };
  }
  if (!project || !activeAgentId) return { target: null };
  const agent: AgentTab | undefined = project.agents.find((a) => a.id === activeAgentId);
  if (!agent) return { target: null };
  // Cloud agents have no local PTY (AgentPane.prepare returns early for runtime "cloud"), and the
  // dispatch layer writes through submitPrompt/writePty — a "target" here would accept the user's
  // prompt and then strand it as pty-gone. Until dispatch routes through getTransport, the compose
  // box stays Sparkle-only for a cloud tab; the terminal (which IS transport-backed) still works.
  if (agent.runtime === "cloud") {
    return { target: null, refusal: "Cloud agents take prompts in the terminal for now" };
  }
  return {
    target: { projectId: project.id, agentId: agent.id, name: agentDisplayName(agent) },
  };
}

/**
 * The selected tab's selected agent, or null when there is no project, no selection, the selection
 * names an agent that no longer exists, or the agent can't take a prompt (see decidePromptTarget).
 */
export function resolvePromptTarget(
  project: Project | null,
  activeAgentId: string | null,
): PromptTarget | null {
  return decidePromptTarget(project, activeAgentId).target;
}

