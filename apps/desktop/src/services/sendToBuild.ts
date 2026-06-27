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
  prdPath: string;
}

/** Build the orchestrator's seed prompt: the epic id, the PRD path to read, and the marching order
 *  to execute the epic's children under the beads protocol. */
function buildSeedPrompt(args: SendToBuildArgs): string {
  return [
    `Build epic ${args.epicId}.`,
    "",
    `First, read the PRD at ${args.prdPath} to understand the goal, constraints, and acceptance`,
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

  // Open it: mounts the pane and drives the PTY launch (same as clicking the tab).
  useRuntimeStore.getState().open(agentId);

  // Seed the orchestrator's first message with the epic + PRD + beads protocol.
  useProjectStore.getState().appendPrompt(args.projectId, agentId, buildSeedPrompt(args));

  return agentId;
}
