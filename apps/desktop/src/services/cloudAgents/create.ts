// Orchestrates creating a CLOUD agent (Service B, W5): POST /sessions/start, then materialize the
// AgentTab with id = the server session id and runtime "cloud" — downstream UX is then identical to
// a local agent (spec §"Desktop: a transport seam"). The store/runtime actions and the API client
// are injected so the whole flow is unit-testable (happy path + every start-failure → guidance).
//
// Note on the goal + repo_url: a cloud build agent needs both up front (the server clones the repo
// and seeds Claude Code with the goal). The caller resolves them (goal = the seed prompt, repo_url =
// the project's git origin) before calling this — kept out of here so this stays pure orchestration.

import type { AddAgentOpts } from "../../stores/projectStore";
import type { CloudApi, StartSessionInput } from "./api";
import { classifyStartError, startedUntrackedGuidance, type StartGuidance } from "./startError";

export interface CreateCloudAgentDeps {
  api: Pick<CloudApi, "startSession">;
  /** projectStore.addAgent — returns the created tab id, or null when the project is unknown. */
  addAgent: (projectId: string, opts: AddAgentOpts) => string | null;
  /** projectStore.selectAgent. */
  selectAgent: (projectId: string, agentId: string) => void;
  /** runtimeStore.open (mount the tab's terminal). */
  open: (agentId: string) => void;
}

export type CreateCloudAgentResult =
  | { ok: true; id: string }
  /** `orphanedSessionId`: set when the start SUCCEEDED server-side but no tab materialized here —
   *  the session is running and billing; callers must not treat this as retry-safe. */
  | { ok: false; guidance: StartGuidance; orphanedSessionId?: string };

/**
 * Start a cloud agent and create its tab. On success the tab id is the server session id (so every
 * downstream consumer — runtimeStore, terminal, relay, phone — keys on one id) and runtime is
 * "cloud" (so W4's CloudTransport attaches). On failure the server's error is classified into
 * actionable guidance (deep-link target / sign-in) and NO tab is created.
 */
export async function createCloudAgent(
  input: StartSessionInput,
  deps: CreateCloudAgentDeps,
): Promise<CreateCloudAgentResult> {
  let sessionId: string;
  try {
    ({ sessionId } = await deps.api.startSession(input));
  } catch (err) {
    // classifyStartError/parseStartError read {status, code, message} off any object, INCLUDING a
    // CloudApiError (an Error subclass), so the raw error can be forwarded as-is — no manual spread,
    // and no risk of dropping the status that the offline gate depends on.
    return { ok: false, guidance: classifyStartError(err) };
  }

  const id = deps.addAgent(input.projectId, {
    id: sessionId,
    kind: "build",
    runtime: "cloud",
    // Only pin an explicit user-supplied name; otherwise leave it for auto-naming (addAgent pins
    // iff `name` is set, matching local build agents created without a name).
    ...(input.name ? { name: input.name } : {}),
  });
  // The store refused the insert — the project is gone from this window (closed/removed while the
  // start call was in flight). The SESSION IS RUNNING server-side; say so instead of pretending the
  // create failed, and don't select/open a tab that was never created. The startup re-attach
  // (reattach.ts) will materialize it next time the project is open.
  if (!id) {
    // Keep the session id in the visible record — the session is RUNNING and billing; a retry
    // would start a second one (roborev 46278).
    console.warn("[cloudAgents] session started but no tab materialized", {
      sessionId,
      projectId: input.projectId,
    });
    return { ok: false, orphanedSessionId: sessionId, guidance: startedUntrackedGuidance() };
  }
  deps.selectAgent(input.projectId, id);
  deps.open(id);
  return { ok: true, id };
}
