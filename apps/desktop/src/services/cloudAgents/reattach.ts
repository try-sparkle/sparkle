// Startup re-attach for cloud agents (Service B, W5, IO half). On app start, for each project with
// (or that may have) cloud sessions, fetch GET /sessions?project_id= and recreate a tab for every
// LIVE session that no longer has one — because a cloud session keeps running while the laptop is
// closed (spec §"Re-attach"). The pure dedup/liveness decision lives in reconcile.ts; this wires it
// to the API + store. Best-effort: a signed-out / offline / erroring fetch must NEVER break startup,
// so failures resolve to "created nothing" instead of throwing.

import type { AddAgentOpts } from "../../stores/projectStore";
import type { CloudApi } from "./api";
import { reconcileCloudSessions } from "./reconcile";

export interface ReattachDeps {
  api: Pick<CloudApi, "listSessions">;
  /** Ids of all tabs currently in the project (the dedup set). */
  existingTabIds: (projectId: string) => string[];
  /** projectStore.addAgent — returns the created id, or null when the project is unknown. */
  addAgent: (projectId: string, opts: AddAgentOpts) => string | null;
  /** Optional: log a soft failure (defaults to a no-op so startup stays quiet). */
  onError?: (err: unknown) => void;
}

/**
 * Reconcile one project's persisted tabs against the server's live cloud sessions, creating a
 * `runtime: "cloud"` tab for each live session that lacks one. Returns the ids created (possibly
 * empty), or NULL when the listing itself never landed. Never throws.
 *
 * `[]` and `null` mean different things to the caller and must not be collapsed (roborev 49295):
 * `[]` is "the server answered and there was nothing to do" — settled, don't ask again — while
 * `null` is "we never got an answer" (offline, 500, a token still settling), which is what keeps
 * the project eligible for a retry. Returning `[]` for a failed fetch is why an offline cold boot
 * on an already-bound project stayed unreconciled until the next relaunch: the cached
 * cloudProjectId means findCloudProjectId never makes a request, so the listing here is the ONLY
 * call that can fail, and it was reporting failure as success.
 */
export async function reattachCloudSessions(
  projectId: string,
  deps: ReattachDeps,
): Promise<string[] | null> {
  let sessions;
  try {
    sessions = await deps.api.listSessions(projectId);
  } catch (err) {
    deps.onError?.(err);
    return null; // offline / signed out / server error → retryable, and never disrupts startup
  }

  const { toCreate } = reconcileCloudSessions({
    existingTabIds: deps.existingTabIds(projectId),
    sessions,
  });

  const created: string[] = [];
  for (const s of toCreate) {
    const id = deps.addAgent(projectId, {
      id: s.id,
      kind: "build",
      runtime: "cloud",
      ...(s.name ? { name: s.name } : {}),
    });
    // null = the store refused this insert — today only "the project isn't in this window's store"
    // (removed while the list was in flight), which would repeat for every remaining session. We
    // still SKIP rather than break: the null contract lives in projectStore, and if it ever gains a
    // per-agent refusal, breaking here would silently drop the rest of a project's live cloud
    // sessions. Re-scanning an in-memory array is free next to the fetch above (roborev 46383).
    if (!id) continue;
    created.push(id);
  }
  return created;
}
