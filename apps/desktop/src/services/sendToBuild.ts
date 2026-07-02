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
}

/** Build the orchestrator's seed prompt: the epic id, where the spec lives (the PRD when there is
 *  one, else the epic bead's own description), and the marching order to execute the epic's
 *  children under the beads protocol. */
function buildSeedPrompt(args: SendToBuildArgs): string {
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
