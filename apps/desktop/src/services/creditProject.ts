// Resolving "which project is this metered AI call for?" — the attribution the Credits history
// renders (design: the ledger's `meta.project`, see apps/orchestration/src/lib/creditHistory.ts).
//
// Every metered call travels with an optional project NAME, not an id and not a path:
//   • a name is what the history has to display, and resolving an id at read time would mean the
//     server keeping a copy of the user's project list;
//   • a PATH is not sent on purpose — `/Users/<someone>/clients/acme-lawsuit` leaks far more than
//     "acme-lawsuit", and the ledger is server-side data we don't need to hold.
//
// Absence is a first-class answer. A call with no discoverable project sends nothing, the ledger row
// carries no `meta.project`, and the history says so plainly. Never substitute a fallback ("Unknown",
// the selected project, the first project) — an attribution the user can't trust is worse than a
// blank, because it makes every OTHER row's attribution suspect too.
import { useProjectStore } from "../stores/projectStore";

/** Display name of `projectId`, or undefined when it is unknown/absent. */
export function projectName(projectId: string | null | undefined): string | undefined {
  if (!projectId) return undefined;
  const name = useProjectStore.getState().projects.find((p) => p.id === projectId)?.name?.trim();
  return name || undefined;
}

/** Display name of the project that owns `agentId`, or undefined when it can't be resolved.
 *  Used by the per-agent metered calls (naming, the attention judge/summarizer, suggestions), which
 *  know their agent but are handed no project. */
export function projectNameForAgent(agentId: string | null | undefined): string | undefined {
  if (!agentId) return undefined;
  const owner = useProjectStore
    .getState()
    .projects.find((p) => p.agents.some((a) => a.id === agentId));
  return owner?.name?.trim() || undefined;
}

/** Normalize a project root path for comparison: trimmed, with trailing separators dropped.
 *
 *  Raw `===` on the path was a SILENT miss — "no project" is a legitimate outcome here, so a caller
 *  that passed `/tmp/p1/` where the store holds `/tmp/p1` simply lost its attribution with nothing
 *  to notice. Lexical only, and CASE-SENSITIVE: the renderer has no synchronous realpath, so a
 *  symlinked path, a worktree, or a case-differing spelling of the same path on macOS/Windows still
 *  won't match. Every one of those degrades to "no project", never to a WRONG project, which is the
 *  property this module actually defends. (roborev 48157/48164) */
function normalizeRootPath(path: string): string {
  const trimmed = path.trim();
  // Drop trailing separators — unless that would empty the string, i.e. the path IS the root ("/"),
  // which must stay distinguishable from "no path at all". A Windows drive root normalizes to "C:",
  // which is fine: both sides of the comparison go through here, so they agree.
  const stripped = trimmed.replace(/[/\\]+$/, "");
  return stripped || trimmed;
}

/** Display name of the project rooted at `rootPath`, or undefined when no open project matches.
 *  For the services that are handed a project PATH rather than an id (task planning, epic
 *  decomposition) — they can attribute their spend without every caller threading a name. */
export function projectNameForPath(rootPath: string | null | undefined): string | undefined {
  if (!rootPath) return undefined;
  const wanted = normalizeRootPath(rootPath);
  const name = useProjectStore
    .getState()
    .projects.find((p) => p.rootPath && normalizeRootPath(p.rootPath) === wanted)
    ?.name?.trim();
  return name || undefined;
}

/** Display name of the project the user currently has open, or undefined when none is selected.
 *  For genuinely session-scoped spend (dictation into the composer) rather than agent-scoped. */
export function selectedProjectName(): string | undefined {
  const { projects, selectedProjectId } = useProjectStore.getState();
  if (!selectedProjectId) return undefined;
  return projects.find((p) => p.id === selectedProjectId)?.name?.trim() || undefined;
}
