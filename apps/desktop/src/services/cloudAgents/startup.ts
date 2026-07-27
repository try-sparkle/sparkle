// Startup re-attach wiring for cloud agents (Service B, W5): the store/API glue between the app's
// "a project just opened" moment and the already-tested pure/IO halves (reconcile.ts → reattach.ts).
//
// Why this exists at all: a cloud session keeps running while the laptop is closed. On reopen the
// desktop must recreate a tab for every LIVE session that no longer has one, so the user finds
// their agent where they left it instead of an empty sidebar and an invisible meter.
//
// Contract: best-effort and silent. Signed out, offline, feature off, no server project — every one
// of those resolves to "created nothing". Startup must never be blocked or broken by this.

import { useProjectStore } from "../../stores/projectStore";
import { useAuthStore } from "../../stores/authStore";
import { log } from "../../logger";
import { cloudApi } from "./api";
import { projectBindingSets } from "./projectBinding";
import { findCloudProjectId } from "./projectLink";
import { reattachCloudSessions } from "./reattach";

/**
 * Reconcile one local project's tabs against its live cloud sessions. Returns the ids of the tabs
 * created (empty when the server was consulted and there was nothing to do), or null when the
 * attempt never reached a useful answer — auth/entitlement not (yet) ready, or the lookup failed
 * (offline, 500). Callers use null to keep the project eligible for a retry: on a cold launch the
 * auth store resolves asynchronously, so the first attempt can fire before tokenPresent settles.
 * Never throws.
 */
export async function reattachProjectOnOpen(localProjectId: string): Promise<string[] | null> {
  const ps = useProjectStore.getState();
  const project = ps.projects.find((p) => p.id === localProjectId);
  if (!project) return null;

  // The capability gate, read the same way every other cloud surface reads it: absent ⇒ off. A
  // local-only user never issues a single request from this path.
  const auth = useAuthStore.getState();
  if (auth.me?.cloudAgentsEnabled !== true || !auth.tokenPresent) return null;

  try {
    // Look up WITHOUT creating: opening a project must not mint a server project row for one that
    // has never run a cloud agent.
    const cloudProjectId = await findCloudProjectId(project, {
      api: cloudApi,
      remember: (localId, cloudId) => useProjectStore.getState().setCloudProjectId(localId, cloudId),
      ...projectBindingSets(project.id),
    });
    if (!cloudProjectId) return [];

    return await reattachCloudSessions(cloudProjectId, {
      api: cloudApi,
      // Dedup against the LOCAL project's tabs (that's where a session's tab lives), while the
      // listing is keyed by the SERVER project id — the same local/server split createCloudAgent
      // resolves through its injected store deps.
      existingTabIds: () =>
        useProjectStore.getState().projects.find((p) => p.id === localProjectId)?.agents.map((a) => a.id) ??
        [],
      addAgent: (_serverProjectId, opts) => useProjectStore.getState().addAgent(localProjectId, opts),
      onError: (err) => log.debug("cloud-agents", "re-attach skipped", err),
    });
  } catch (err) {
    // findCloudProjectId is the only throwing call above; a failure here is offline/signed-out/500.
    log.debug("cloud-agents", "re-attach lookup failed", err);
    return null;
  }
}
