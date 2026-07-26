// Terminating a CLOUD agent's server-side session (Service B, W5).
//
// Why this is its own module: a cloud session outlives its pane by design — the terminal's unmount
// only `detach()`es (a laptop close or a tab remount must not kill a running sandbox). That makes
// the user's deliberate CLOSE gesture the only thing left that means "stop it", and there are three
// of those (the sidebar ×, Discard, and the post-ship "Close Build Agent" row). Each one used to
// tear down local state only, so a cloud sandbox kept metering per minute until the runner's
// idle-pause, and the startup re-attach re-materialized the tab on the next project open. Routing
// all of them through this one helper is what makes "closed" mean closed (roborev 46881).
//
// Best-effort by contract: the local teardown must never be blocked by the network. A failure (or a
// hang — the DELETE is deadline-bounded in agentTransport) is logged and swallowed; the server's
// idle-pause bounds the cost, and re-attach surfaces a still-live session honestly.

import type { AgentTab } from "../../types";
import { deleteCloudSession } from "../agentTransport";

/** End the server session for `agentId` (the cloud session id). Never rejects. */
export async function terminateCloudAgent(agentId: string): Promise<void> {
  try {
    await deleteCloudSession(agentId);
  } catch (e) {
    console.warn("[cloudAgents] terminate failed; session may still be running", {
      sessionId: agentId,
      error: String(e),
    });
  }
}

/** Terminate iff this agent is a cloud one; a no-op (and no network call) for a local agent. */
export async function terminateIfCloud(
  agent: Pick<AgentTab, "id" | "runtime"> | null | undefined,
): Promise<void> {
  if (agent?.runtime !== "cloud") return;
  await terminateCloudAgent(agent.id);
}
