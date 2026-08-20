// The shell's two small "what does this id actually point at" rules (CM-U7), pulled out of
// Workspace so they're testable without rendering the whole app.
//
// Both exist because persisted ids outlive the things they name: a pin survives the project it
// pinned, and a selectedAgentId survives the agent it selected. Resolving them defensively at the
// read site is what keeps a stale id from silently zeroing the concierge or aiming the compose box
// at nothing.
import { agentDisplayName } from "./agentDisplayName";
import type { CableState } from "./cable";
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
  // NO CLOUD REFUSAL HERE ANY MORE, and its removal is the point rather than a simplification.
  // This used to return `{ target: null, refusal: "Cloud agents take prompts in the terminal for
  // now" }`, which was true only because `dispatchConciergeAnswer` wrote exclusively through
  // `submitPrompt`/`writePty` — so a cloud target would have accepted the user's prompt and then
  // stranded it. The dispatcher now routes a cloud PROMPT through `getTransport({id, runtime})` to
  // the sandbox's stdin (services/conciergeDispatch's cloud note), so the copy that told the user to
  // use the terminal instead would now be advice to work around a feature that works. What a cloud
  // agent still cannot take from here is an ANSWER to a prompt on its own screen; that refusal lives
  // at the dispatcher, where the screen is actually read, and not in this resolver, which cannot see
  // one (AGENTS.md: user-facing copy is code — a refusal string outlives the limit it described).
  return {
    target: { projectId: project.id, agentId: agent.id, name: agentDisplayName(agent) },
  };
}

// ══ WHERE A MOUNTED SEND GOES — READ FROM THE CABLE, NOT FROM WHAT IS ON SCREEN ═════════════════
//
// THE DEFECT THIS EXISTS TO MAKE UNREPRESENTABLE (bead sparkle-9gsjqm, reported repeatedly). The
// concierge's ROUTING mount used to be `wired !== "off" ? promptTarget?.agentId : null` — i.e. the
// cable ANDed with `decidePromptTarget`'s answer — and three of the four predicates behind that
// expression are about what the shell is DRAWING, not about what the founder mounted:
//
//   • `useEffectiveWired` is a DRAWING projection ("USE THIS FOR VISUAL TREATMENT ONLY", its own
//     header) whose sparkle arm reads `activeSpecial === "sparkle"` — a surface predicate;
//   • `isPromptableTarget` requires a resolvable LIVENESS, which is transient and routine;
//   • `decidePromptTarget`'s `special` arm is non-null only while the Improve-Sparkle pane is the
//     visible surface, and it WINS over the roster path.
//
// Two states fell out, and the founder hit both. Mount Improve Sparkle, then navigate the right
// column anywhere else: the special target evaporates, the routing mount goes null — while the cable
// stays patched forever, because `pinnedFarEndIsGone` deliberately exempts the app-owned agent — so
// every subsequent message became a concierge turn with no refusal and no notice. Mount a BUILD
// agent, then open the Improve-Sparkle pane: the special target WINS, and his words re-aim at
// `__sparkle_self__` because a different pane became visible.
//
// So the routing mount is resolved from the CABLE'S OWN PIN and nothing else. The pin is written by
// exactly the gesture that mounts (`cableStore.patch`) and cleared by exactly the gestures that
// unmount (`unbindCable`, `setOverlay`), so there is no surface predicate and no liveness read
// between the founder's click and where his words go. A pane becoming visible is not a mounting
// gesture, and this function cannot be told that it is.
export interface MountedAgentFacts {
  /** What the column calls this agent — the same name the "Chatting with ● <Agent>" chip renders. */
  name: string;
  /** `""` for the app-owned Sparkle agent, which owns no project row (Workspace's `sparkleTarget`,
   *  and `conciergeDispatch`'s "PTY id === agent id"). */
  projectId: string;
}

/**
 * WHERE A MOUNTED SEND GOES. Three arms, and the third is the point of the type.
 *
 * `unresolvable` is not a synonym for `none`, and collapsing the two is the bug: a pinned cable
 * whose agent this window cannot name is still a MOUNT — the founder made the gesture, the shell is
 * drawing the connection — so a send under it must be refused where he can see it, never quietly
 * re-decided as a concierge turn. Flattening it to `null` is precisely what turned his words into a
 * `via: "default"` route with nothing on screen to say so.
 */
export type MountResolution =
  /** The cable is unpatched, or patched with no pin at all (the dev visual fixtures). */
  | { kind: "none" }
  /** Patched, pinned, and this window can name the far end. */
  | { kind: "mounted"; target: PromptTarget }
  /** Patched and pinned at an agent this window cannot name right now. */
  | { kind: "unresolvable"; agentId: string };

/**
 * @param cable The RAW cable store value — never the `useEffectiveWired` projection, which is a
 *              drawing rule and says "off" for states the cable is very much patched in.
 * @param lookup This window's facts for a pinned id, or `undefined` when it has none. The app-owned
 *               Sparkle agent is deliberately never a roster row (services/knownAgents), so the
 *               caller resolves it through its own namespace rather than through `project.agents`.
 */
export function resolveMountedTarget(
  cable: Pick<CableState, "wired" | "agentId">,
  lookup: (agentId: string) => MountedAgentFacts | undefined,
): MountResolution {
  // BOTH halves, even though `patchCable`/`unbindCable` write them together: a caller can hand us a
  // hand-built pair, and "wired but unpinned" is a real state the dev fixtures produce.
  if (cable.wired === "off" || cable.agentId === null) return { kind: "none" };
  const facts = lookup(cable.agentId);
  if (!facts) return { kind: "unresolvable", agentId: cable.agentId };
  return {
    kind: "mounted",
    target: { projectId: facts.projectId, agentId: cable.agentId, name: facts.name },
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

