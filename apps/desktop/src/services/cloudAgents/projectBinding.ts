// The store half of the project-binding rules that projectLink.ts decides on (it stays pure so the
// whole matrix is unit-testable). Both callers — the creation dialog and the startup re-attach —
// need the SAME two sets, and getting either one wrong re-opens a shared-server-row bug, so they
// are derived in exactly one place.

import { useProjectStore } from "../../stores/projectStore";

/**
 * `localProjectIds`: every project in this window's store — lets the name-match fallback tell a
 * sibling's claimed row (never adopt) from a previous install's (safe to adopt).
 * `boundCloudProjectIds`: server rows already adopted by a DIFFERENT local project — adoption
 * doesn't re-claim the row server-side, so this is what stops the second of two same-named projects
 * from landing on the row the first one just took (roborev 46881).
 */
export function projectBindingSets(localProjectId: string): {
  localProjectIds: ReadonlySet<string>;
  boundCloudProjectIds: () => ReadonlySet<string>;
} {
  return {
    localProjectIds: new Set(useProjectStore.getState().projects.map((p) => p.id)),
    // Lazy on purpose — see the field's doc in projectLink.ts: two project opens overlap, and a set
    // captured now would predate the other one's adoption.
    boundCloudProjectIds: () =>
      new Set(
        useProjectStore
          .getState()
          .projects.filter((p) => p.id !== localProjectId)
          .map((p) => p.cloudProjectId)
          .filter((id): id is string => !!id),
      ),
  };
}
