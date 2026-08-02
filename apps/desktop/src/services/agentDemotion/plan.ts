// The PURE half of cloud→local demotion (plan W3; spec
// docs/superpowers/specs/2026-08-01-cloud-runtime-switching-design.md). No IO, no store, no Tauri.
// The mirror of agentPromotion/plan.ts, with the roles swapped, and it answers the same two
// questions —
//
//   1. May this agent be demoted at all, and if not, WHY (in words the user can act on)?
//   2. If it may, what must the user READ before they are allowed to confirm?
//
// (2) is where the two directions genuinely differ, and it is why this is not a copy of promotion's
// warnings with the nouns swapped. Promotion's hazard is what does NOT travel off this Mac.
// Demotion's hazard is that THE SANDBOX IS DESTROYED: everything in it that is not a git object is
// gone the moment the cut lands, and there is no "leave it there" option because there is no
// "there" afterwards (spec Decision 1). So the dirty policy is not a choice the dialog offers — it
// is a fact the dialog STATES, and the warning that states it is mandatory rather than conditional
// on the sandbox currently being dirty: the desktop cannot see the sandbox's working tree, so
// "there is nothing uncommitted" is not a claim it is entitled to make.

/** The agent fields demotion planning reads. A full `AgentTab` satisfies this structurally. */
export interface DemotionAgent {
  id: string;
  /**
   * Tested for `=== "cloud"` POSITIVELY — the inverse of promotion's rule and for the same reason.
   * This repo's convention is that an absent/unknown runtime is NOT a claim of remoteness
   * (`registry` normalizes with `a.runtime ?? "local"`), so demotion requires a positive claim
   * before it will start pushing a sandbox's branch around. An unknown runtime refuses.
   */
  runtime?: string;
  kind: string;
  /** Where the agent's worktree already is, when it has one (a previously promoted agent). `null`
   *  for a born-in-the-cloud agent — the landing cuts one. Not a refusal either way. */
  worktreePath?: string | null;
  branch?: string | null;
  goal?: { text?: string } | null;
  name: string;
}

export interface DemotionPlanInput {
  agent: DemotionAgent;
  /** The desktop project the tab belongs to. `null` when it cannot be resolved. */
  project: { id: string; rootPath: string | null } | null;
  /**
   * Whether a conversation is expected to travel. The dialog's third mandatory warning — that the
   * conversation is DOWNLOADED through Sparkle onto this machine — is a custody statement, so it is
   * shown whenever a transcript is expected and suppressed only when the caller positively knows
   * there is none. Defaults to `true`: an unknown must not silently drop a custody disclosure.
   */
  expectTranscript?: boolean;
}

export type DemotionRefusal =
  /** Not a cloud agent (already local, or no positive claim of remoteness). */
  | "not_cloud"
  /** A shell agent — no conversation and no branch, so there is nothing to bring down. */
  | "shell_agent"
  | "no_project"
  | "no_root"
  | "no_branch";

export type DemotionPlan =
  | { ok: false; refusal: DemotionRefusal; message: string }
  | {
      ok: true;
      branch: string;
      /** Warnings the confirm dialog MUST render before the user can proceed. */
      warnings: string[];
    };

/**
 * The WIP commit the SANDBOX makes before it pushes. Shown verbatim in the dialog — the sandbox's
 * dirty state is committed, never left behind, and the user is told exactly what will appear in
 * their history.
 *
 * MUST equal the runner's `WIP_COMMIT_MESSAGE_CLOUD` (plan W1.2). The two live in different
 * packages with no shared module, so this is the coupling: if the runner's message changes, this
 * string is what the user was promised and it is now a lie.
 */
export const CLOUD_WIP_COMMIT_MESSAGE = "Sparkle: WIP before local demotion";

/**
 * Decide refusal-vs-proceed, and on proceed produce the warnings the dialog must render.
 *
 * Refusal ORDER reads outside-in, the same way promotion's does: what kind of agent is this
 * (not_cloud → shell_agent) → is there a workspace to land into (no_project → no_root) → is there
 * something to land (no_branch). Each check is only meaningful once the previous one passed, so the
 * message always names the thing the user has to fix FIRST rather than a downstream symptom.
 *
 * There is no cloud-gate check here, deliberately, and it is not an oversight: a user whose credits
 * ran out is exactly the user who needs to bring their work down, and a gate that hides the exit is
 * a trap (plan W4).
 */
export function planDemotion(input: DemotionPlanInput): DemotionPlan {
  const { agent, project } = input;

  if (agent.runtime !== "cloud") {
    return {
      ok: false,
      refusal: "not_cloud",
      message: "This agent is already running on this Mac.",
    };
  }
  if (agent.kind === "shell") {
    return {
      ok: false,
      refusal: "shell_agent",
      message:
        "Shell agents can't be brought down — they have no conversation and no branch, so there's nothing to move.",
    };
  }
  if (!project) {
    return {
      ok: false,
      refusal: "no_project",
      message: "This agent isn't attached to a project on this Mac, so there's nowhere to land its branch.",
    };
  }
  if (!project.rootPath) {
    return {
      ok: false,
      refusal: "no_root",
      message: "This project has no folder on this Mac, so there's nowhere to land the agent's branch.",
    };
  }
  const branch = agent.branch?.trim() || "";
  if (!branch) {
    return {
      ok: false,
      refusal: "no_branch",
      message:
        "This agent has no branch recorded yet, so there's nothing to fetch. Give it a moment to start work and try again.",
    };
  }

  // All three of these are UNCONDITIONAL. Each describes something the user cannot see and cannot
  // undo, and each was chosen because a user who assumes the opposite loses something:
  //   1. their sandbox's uncommitted work appears in their git history (and on origin) — surprising
  //      if unstated, and the alternative (silently discarding it) is worse;
  //   2. anything in the sandbox outside git — a scratch file, an installed tool, a running server —
  //      is destroyed, with no "leave it there" option because there is no "there" afterwards;
  //   3. the conversation is DOWNLOADED, i.e. it transits Sparkle's server onto this machine. The
  //      exposure runs the opposite way to promotion's and is smaller, but it is still a custody
  //      statement and belongs in front of the confirm button (spec Decision 4).
  const warnings: string[] = [
    `Anything uncommitted in the cloud sandbox is committed for you as "${CLOUD_WIP_COMMIT_MESSAGE}" and pushed to origin/${branch}. ` +
      `That's how the work gets here — it isn't left behind, and \`git reset --soft HEAD~1\` puts it back to uncommitted once it lands.`,
    "The cloud sandbox is then DESTROYED. Nothing outside git survives it — untracked scratch files, installed tools, running servers, and anything ignored by .gitignore are gone for good.",
  ];
  if (input.expectTranscript !== false) {
    warnings.push(
      "The agent's conversation is downloaded through Sparkle onto this Mac so the local agent can resume it. " +
        "If it can't be transferred, the move still happens and the local agent starts from a written handoff instead.",
    );
  }

  return { ok: true, branch, warnings };
}

/**
 * The prompt sent to the LOCAL agent after cutover when the transcript did NOT travel.
 *
 * The mirror of promotion's `handoffNudge`, minus its resumed branch — a demotion whose transcript
 * arrived resumes the real conversation (`claude --resume <session>`) and needs no prompt at all, so
 * this function exists ONLY for the amnesiac case and does not take a `hadTranscript` flag to get
 * wrong. It must read as continuity, and it must be straight about the memory it does not have:
 * an agent told "the history above is yours" when there is none will confabulate one.
 */
export function demotionBriefing(a: { name: string; branch: string; goal?: string }): string {
  const goal = a.goal?.trim();
  const goalLine = goal ? `\n\nYour goal, unchanged: ${goal}` : "";
  return [
    `You've just been moved out of a cloud sandbox onto the user's Mac, and your conversation did NOT come with you — this session has no memory of what you and the user discussed. Be straight with them about that; don't reconstruct a history you don't have.`,
    `What you do know: you are ${a.name}, working on branch ${a.branch}, which is checked out here at the exact commit the sandbox pushed. Everything you committed there is here. Nothing outside git came across — scratch files, installed tools and anything ignored by .gitignore stayed in the sandbox, which no longer exists.`,
    `Re-orient before you change anything: read \`git log --oneline -20\`, the diff against the base branch, and this branch's progress doc under PRD/. Then continue the work.${goalLine}`,
  ].join("\n\n");
}
