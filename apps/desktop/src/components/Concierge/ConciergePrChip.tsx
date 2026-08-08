// The concierge header's pull-request chip, and the pure scope mapping behind it.
//
// Extracted verbatim from ConciergeHost, which re-exports `prChipScopes`. Both were already
// self-contained — the component reads its own stores and takes no props — so nothing but the mount
// site tied them to the host.
import { useProjectStore } from "../../stores/projectStore";
import { useUiStore } from "../../stores/uiStore";
import { openProjectsOf } from "../../engine/openProjects";
import { openProjectTab } from "../../services/openProjectTab";
import { OpenPrMenu, agentLinkForPr, type PrScope } from "../OpenPrMenu";

/**
 * WHICH repos the concierge's PR chip lists: ALL of the open ones, in tab order.
 *
 * THIS USED TO BE A PRECEDENCE RULE (`prChipProject`) that picked exactly one project — the global
 * selection, else the left pair's, else the first open one — and it was the wrong shape twice over.
 *
 * The old note recorded its own known limit: "with two pairs holding DIFFERENT projects this still
 * lists only one of them. Listing both means `OpenPrMenu` fetching per repo and keying its merge
 * state by repo+number instead of number (PR numbers collide across repos)." That is exactly what
 * happened — `OpenPrMenu` is repo-keyed throughout now — so the precedence has nothing left to
 * decide, and the limit is gone rather than documented.
 *
 * The second failure was worse than a limit, because picking one project meant sometimes picking
 * NONE. The founder's concierge was scoped to a project with no pull requests while all ten of his
 * lived in another, and a resolution that came back null unmounted the app's ONLY pull-request
 * affordance (bead sparkle-lcx8y). Selecting a project is not a statement about which PRs you want
 * to see; it is a statement about which agents you are looking at.
 *
 * So there is no selection here at all — the answer is every open tab, and the menu groups by name.
 * `leftProjectId` is deliberately no longer read: with every open project listed, which pair
 * selected what stopped being able to hide anything.
 *
 * ONE THING IS CARRIED BEYOND THE TAB ITSELF: `repoKey`, the canonical `.git` common dir. Two tabs
 * can be one REPOSITORY — `sparkle-desktop` is a linked worktree of `sparkle`, and the founder had
 * both open — and without this the menu counted that repo's pull requests twice and listed all 23 of
 * them under both headings. It is passed straight through, never derived here: a linked worktree's
 * `.git` is a FILE, so nothing about the path or the folder's shape can tell you this. See
 * `services/fleetPrs.repoIdentityOf`.
 *
 * Pure and exported so the mapping is tested without mounting the host.
 */
export function prChipScopes(
  openProjects: readonly {
    id: string;
    name: string;
    rootPath?: string | null;
    repoKey?: string | null;
  }[],
): PrScope[] {
  return openProjects.map((p) => ({
    projectId: p.id,
    projectName: p.name,
    rootPath: p.rootPath ?? null,
    repoKey: p.repoKey ?? null,
  }));
}

/**
 * The concierge header's PR chip — the app's ONE pull-request affordance, listing EVERY open
 * project tab.
 *
 * It used to be a wide bordered "3 PRs waiting" pill over in the project tab strip, and the
 * concierge header carried a second, DEAD one (a `prsReady` number that nothing ever passed). This
 * is the single survivor: the same `OpenPrMenu`, mounted `compact` so it reads as an icon and a
 * count beside the ⋮ rather than a labelled pill competing with the tab row.
 *
 * The wiring it needs is repo state — which is why the presentational `Concierge/` directory takes
 * it as a slot rather than growing a store read (see `ConciergeColumnProps.prSlot`). Scope comes
 * from {@link prChipScopes}; `resolveAgent` searches EVERY project, so a PR belonging to another
 * pair's agent still offers "Open agent" and routes there.
 *
 * THERE IS NO EARLY RETURN HERE ANY MORE, and that is the fix (bead sparkle-lcx8y). This component
 * used to be `if (!project) return null` — so a concierge scoped to a project the resolution could
 * not place removed the app's only way to see, let alone merge, a pull request. `OpenPrMenu` owns
 * the one remaining case where nothing renders (no open project tab at all, i.e. the app's
 * "open a project with +" state), and it can no longer be reached by a scope, a count of zero, or a
 * failed probe.
 */
export function ConciergePrChip() {
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const openProjectIds = useUiStore((s) => s.openProjectIds);
  // A fresh array every render, and deliberately not memoized here: `OpenPrMenu` keys its polling
  // on the scope SET's value (`scopeSetKey`), not on this array's identity, precisely so a caller
  // reading two stores does not have to get a memo's dependencies exactly right to avoid
  // re-probing GitHub on every unrelated store write.
  const scopes = prChipScopes(openProjectsOf(projects, openProjectIds));
  return (
    <OpenPrMenu
      compact
      scopes={scopes}
      resolveAgent={(pr) => agentLinkForPr(pr, projects, selectedProjectId)}
      onOpenAgent={(link) => openProjectTab(link.projectId, link.agentId)}
    />
  );
}
