// Resolve a LOCAL project to its ORCHESTRATION-side project row (Service B, W5b).
//
// Why this exists: `POST /sessions/start` and `GET /sessions?project_id=` are keyed on a server
// `sparkle_projects.id` that the server owns and validates ownership of (`getOwnedProject` → 404).
// The desktop's project ids are minted locally (`crypto.randomUUID()` in projectStore) and have
// never been sent anywhere, so passing one straight through would 404 every start. This module is
// the one place that bridges the two, and it caches the answer on the local project record
// (`Project.cloudProjectId`) so it costs one round-trip per project, once.
//
// Resolution order, cheapest and most-certain first:
//   1. A cached `cloudProjectId` — trust it.
//   2. An existing server row with the SAME NAME. This is what makes a second Mac (or a reinstall)
//      re-bind to the row that already holds the user's sessions instead of forking a duplicate.
//      Name matching is a heuristic — it's the only shared key the two sides have in v1 — so it is
//      case-insensitive on the trimmed name and, on a tie, takes the FIRST match in server order
//      (deterministic; the server returns rows in insertion order).
//   3. Create one.
//
// Pure orchestration over injected IO, so the whole matrix is unit-testable.

import type { CloudApi } from "./api";

export interface ProjectLinkDeps {
  api: Pick<CloudApi, "listProjects" | "createProject">;
  /** Persist the resolved id onto the local project (projectStore.setCloudProjectId). */
  remember: (localProjectId: string, cloudProjectId: string) => void;
  /**
   * Ids of every project in THIS store. Used by the name-match fallback to tell "claimed by a
   * SIBLING project on this machine" (never adopt — that's the same-name collision, roborev 46302)
   * from "claimed by a previous install / another Mac" (safe to adopt — the claimer can't be a
   * different project here, and refusing would strand the user's running sessions, roborev 46383).
   */
  localProjectIds?: ReadonlySet<string>;
  /**
   * Server project ids ALREADY bound to some other local project (their cached `cloudProjectId`).
   * Adopting a foreign-claimed row doesn't re-claim it server-side — `remember` only writes the id
   * onto the local project — so without this, two same-named local projects on a fresh install both
   * pass the sibling check against the unchanged row and end up sharing it (roborev 46881). The
   * store already knows the answer; this is how the second lookup sees the first one's adoption.
   *
   * A THUNK, deliberately: the projects that matter are the ones bound by the time we decide, and
   * `reattachProjectOnOpen` fires per project without awaiting, so two lookups overlap. A set
   * snapshotted at call time is computed before either `listProjects()` resolves and both would
   * still see "nothing adopted" (roborev 46918) — this is read AFTER the await instead.
   */
  boundCloudProjectIds?: () => ReadonlySet<string>;
}

export interface LocalProjectRef {
  id: string;
  name: string;
  /** Previously resolved server id, when we have one. */
  cloudProjectId?: string | null;
}

/** Normalized key for the name-match fallback. */
function key(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Return the orchestration project id for `local`, creating the server row if needed. Throws
 * whatever the API throws (the caller classifies it with classifyStartError) — a failure here means
 * we genuinely cannot address the project server-side, and starting anyway would 404.
 */
export async function ensureCloudProjectId(
  local: LocalProjectRef,
  deps: ProjectLinkDeps,
): Promise<string> {
  const found = await findCloudProjectId(local, deps);
  if (found) return found;

  // chiefProjectId = the local project id, the stable binding key findCloudProjectId prefers.
  const created = await deps.api.createProject(local.name, local.id);
  deps.remember(local.id, created.id);
  return created.id;
}

/**
 * Steps 1–2 only: the cached id, or an existing same-named server row — NEVER a create. This is
 * what the startup re-attach uses: opening a project must not mint server rows for projects that
 * have never run a cloud agent (that would be a write on every launch, for nothing). Returns null
 * when there's no row to attach to. Throws only if the lookup itself fails.
 */
export async function findCloudProjectId(
  local: LocalProjectRef,
  deps: Pick<ProjectLinkDeps, "api" | "remember" | "localProjectIds" | "boundCloudProjectIds">,
): Promise<string | null> {
  if (local.cloudProjectId) return local.cloudProjectId;

  const rows = await deps.api.listProjects();

  // Strongest match first: a row whose chiefProjectId IS this local project (we created it).
  const claimed = rows.find((p) => p.chiefProjectId === local.id);
  if (claimed) {
    deps.remember(local.id, claimed.id);
    return claimed.id;
  }

  const wanted = key(local.name);
  // A blank local name can't be matched meaningfully — don't bind to some other unnamed row.
  if (!wanted) return null;

  // Name-match fallback (second Mac / reinstall / pre-chiefProjectId rows) — but NEVER adopt a
  // row claimed by a SIBLING project in this store: local names are folder-derived, so two
  // distinct projects called "frontend" would otherwise share one server row and each other's
  // cloud sessions (roborev 46302). A row claimed by an id we DON'T have locally was claimed by a
  // previous install/another Mac — refusing it would strand the user's running sessions
  // (roborev 46383), so it is safe to re-bind (create() re-claims via remember/cache).
  // CONTRACT (roborev 47220): the bound-set read below and the `deps.remember(...)` that follows a
  // successful match run in the SAME synchronous continuation — that is what closes the
  // double-adoption window between two overlapping lookups. Do not insert an await between them,
  // and keep `remember` (projectStore.setCloudProjectId) synchronous.
  // Without the sibling set we can't distinguish the two cases — stay conservative (claimed rows
  // are off-limits) rather than risk cross-project session bleed.
  // A row another local project has ALREADY adopted is off-limits too, whoever claimed it
  // server-side: adoption doesn't rewrite chiefProjectId, so on a fresh install the second of two
  // same-named projects would otherwise sail past the sibling check and land on the same row
  // (roborev 46881).
  const siblings = deps.localProjectIds;
  // Read the bound set HERE — after the list await — so a lookup that started earlier but resolved
  // later still sees an adoption made in the meantime.
  const bound = deps.boundCloudProjectIds?.();
  const existing = rows.find(
    (p) =>
      key(p.name) === wanted &&
      !bound?.has(p.id) &&
      (p.chiefProjectId == null ||
        p.chiefProjectId === local.id ||
        (siblings != null && !siblings.has(p.chiefProjectId))),
  );
  if (!existing) return null;
  deps.remember(local.id, existing.id);
  return existing.id;
}
