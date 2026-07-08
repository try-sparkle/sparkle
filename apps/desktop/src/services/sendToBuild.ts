// "Send to Build" handoff (bead sparkle-hiju.8): hand a beads epic + its PRD off to a Build agent
// (the orchestrator). Reuses the project's existing build agent if it has one, else creates a fresh
// one; opens it (mounts the pane / drives the PTY launch); and seeds it with a first prompt that
// points at the epic + PRD and tells it to execute the epic's children following the beads protocol.
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { beadsProtocol } from "./buildAgent";

export interface SendToBuildArgs {
  projectId: string;
  epicId: string;
  /** Repo-relative PRD path, or null for a PRD-less epic (e.g. one created directly in bd, or a
   *  backlog epic Started before a PRD exists) — the seed then points the orchestrator at the epic
   *  bead itself instead of blocking on a PRD that isn't there. */
  prdPath: string | null;
  /** What kind of bead we're handing off. "epic" (the default) tells the orchestrator to fan the
   *  epic's child tasks out across workers; "task" tells it to build THIS ONE bead on a single
   *  isolated worker branch without fanning out. `epicId` still names the target bead in both. */
  mode?: "epic" | "task";
}

/** Build the orchestrator's seed prompt. For an epic: point at the spec (the PRD when there is one,
 *  else the epic bead's own description) and tell it to fan the epic's children out across workers.
 *  For a single task: tell it to build THAT one bead on one isolated worker branch — no fan-out.
 *  Both keep the beads protocol addendum so the work graph stays in sync. */
function buildSeedPrompt(args: SendToBuildArgs): string {
  if (args.mode === "task") {
    const spec = args.prdPath
      ? `read the PRD at ${args.prdPath} for surrounding context, then`
      : "then";
    return [
      `Build bead ${args.epicId} (a single task).`,
      "",
      `Run \`bd show ${args.epicId}\` to read it, ${spec} implement it on ONE isolated worker`,
      "branch, verify it, and integrate that branch. Do not fan out into children — this is a single",
      "unit of work, not an epic.",
      "",
      "Follow the beads protocol below to keep the work graph in sync as you go:",
      "",
      beadsProtocol({ epicId: args.epicId }),
    ].join("\n");
  }
  const spec = args.prdPath
    ? `First, read the PRD at ${args.prdPath} to understand the goal, constraints, and acceptance`
    : `First, run \`bd show ${args.epicId}\` and read the epic's description for the goal and`;
  return [
    `Build epic ${args.epicId}.`,
    "",
    spec,
    "criteria. Then execute the epic's child tasks: decompose them across isolated worker agents,",
    "integrating each worker's branch into your build branch sequentially.",
    "",
    "Follow the beads protocol below to keep the work graph in sync as you go:",
    "",
    beadsProtocol({ epicId: args.epicId }),
  ].join("\n");
}

/** Hand the epic off to the project's Build agent. Returns the build agent id. */
export function sendToBuild(args: SendToBuildArgs): string {
  const store = useProjectStore.getState();
  const project = store.projects.find((p) => p.id === args.projectId);
  if (!project) throw new Error(`unknown project ${args.projectId}`);

  // Reuse the project's existing build agent (the orchestrator you talk to) if it has one;
  // otherwise create a fresh one. Mirrors AgentSidebar's Build button (addAgent kind "build").
  const existing = project.agents.find((a) => a.kind === "build");
  const agentId = existing ? existing.id : store.addAgent(args.projectId, { kind: "build" });

  // Bind the epic to the orchestrator right away (spec §8): the sidebar epic pill reads
  // AgentTab.epicId, so it shows immediately — before any worker binds to a bead.
  store.setAgentEpicId(args.projectId, agentId, args.epicId);

  // Open it: mounts the pane and drives the PTY launch (same as clicking the tab).
  useRuntimeStore.getState().open(agentId);

  // Seed the orchestrator's first message with the epic + PRD + beads protocol.
  useProjectStore.getState().appendPrompt(args.projectId, agentId, buildSeedPrompt(args));

  return agentId;
}
