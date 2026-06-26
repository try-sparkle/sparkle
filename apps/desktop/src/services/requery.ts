// requery — when connectivity returns, nudge every open agent so it reports where it stands.
// PTY (build/worker) agents get the prompt typed into their terminal; Think agents get it
// via the imperative bridge. Driven by connectionMonitor on the offline→online edge. ()
import type { AgentTabStatus } from "@sparkle/ui";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { submitPrompt } from "../pty";
import { sendToThink } from "./thinkBridge";
import { log } from "../logger";

/** What we send each agent on reconnect. One shared constant so the wording lives in one place. */
export const REQUERY_PROMPT =
  "I'm back online. Can you give me a brief status update on where things stand?";

// PTY statuses where the agent is sitting at its prompt and it's safe to type a new message.
// Excluded on purpose:
//   • working — mid-task; injecting would interleave with its live output
//   • waiting / approval — it has drawn an on-screen prompt expecting a specific answer; a
//     generic status line would be mis-read as that answer (and approval may be a dangerous
//     y/n we must never auto-confirm)
//   • errored / stopped — the process isn't live, so there's nothing to answer
const SAFE_TO_REQUERY: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>([
  "idle",
  "blocked",
  "done",
]);

/** True only on a genuine offline→online transition (so re-query fires once, not on boot). */
export function shouldRequery(prev: boolean, next: boolean): boolean {
  return prev === false && next === true;
}

/** Send the status-update prompt to every open agent, routed by kind and gated by PTY status. */
export async function requeryOpenAgents(): Promise<void> {
  const { projects } = useProjectStore.getState();
  const { openAgentIds, status } = useRuntimeStore.getState();
  const open = new Set(openAgentIds);

  for (const project of projects) {
    for (const agent of project.agents) {
      if (!open.has(agent.id)) continue;
      // Isolate each agent: a single dead PTY (a "done"/exited process whose write rejects)
      // must not abort the loop and strand every later agent's re-query.
      try {
        if (agent.kind === "think") {
          sendToThink(agent.id, REQUERY_PROMPT);
        } else {
          const st = status[agent.id];
          if (st && SAFE_TO_REQUERY.has(st)) {
            await submitPrompt(agent.id, REQUERY_PROMPT);
          }
        }
      } catch (e) {
        log.error("connectivity", `re-query failed for agent ${agent.id}`, e);
      }
    }
  }
}
