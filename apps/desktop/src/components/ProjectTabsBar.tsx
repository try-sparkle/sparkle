// The live project tab bar — the top chrome of the single-window concierge shell
// (bead sparkle-qd80 / CM-U7, PRD §3). This is the integration layer around the presentational
// ProjectTabs: it supplies the projects, the selection, the pin, the per-project status-band counts
// from the concierge feed, and the top-right cluster — and it REPLACES TopBar, which is no longer
// mounted (its Recent list is redundant when every project is a tab, and its replace-vs-new-window
// question has no meaning in a single window).
//
// What moved here from TopBar, so nothing is lost with it:
//   - "Open (or create) a project" → the tab bar's "+" (same NewProjectDialog + folder picker +
//     resolveOpenTarget flow), except the opened project simply becomes the selected TAB.
//   - Project settings (rename / move) → double-click a tab (the ProjectModal the ⚙ used to open).
//   - The open-PR menu, the trial counter + Unlock, and the signed-in avatar (now inside
//     ConciergeTopRight together with the kebab that owns settings/version/changelog/support).
//
// Only OPEN projects get a tab. "Exists in the project store" is a weaker fact than "is open right
// now" — the bar used to render the former, so it only ever grew and a repo you tried once had a tab
// forever. The open set and its rules live in engine/openProjects; the writes live in
// services/projectTabs. Closing (the tab's ×) hides the tab and NOTHING else: the project, its
// agents and its live PTYs all survive, and the "+" dialog lists what you closed for one-click
// reopen.
import { useMemo, useState } from "react";
import type { Project } from "../types";
import { ProjectTabs, type ProjectTabCounts } from "./ProjectTabs";
import { ConciergeTopRight } from "./Concierge/KebabMenu";
import { TrialIndicator } from "./TrialChrome";
import { OpenPrMenu, agentLinkForBranch, type PrAgentLink } from "./OpenPrMenu";
import { NewProjectDialog } from "./NewProjectDialog";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { useAuthStore } from "../stores/authStore";
import { useTrialStore } from "../stores/trialStore";
import { deriveAuthView } from "../services/entitlement";
import { performTrialUnlock } from "../services/trialUnlock";
import { pickProjectFolder, basename } from "../services/dialog";
import { resolveOpenTarget } from "../services/openTarget";
import { openProjectTab } from "../services/openProjectTab";
import { closeProjectTab, closedProjects } from "../services/projectTabs";
import { openProjectsOf } from "../engine/openProjects";
import type { ConciergeFeed } from "../services/conciergeFeed";

/** Per-project status-band totals, keyed by project id — the tab glow + count badge (ProjectTabs). */
export function countsFromFeed(feed: ConciergeFeed): Record<string, ProjectTabCounts> {
  const out: Record<string, ProjectTabCounts> = {};
  for (const p of feed.projects) out[p.id] = { ...p.counts };
  return out;
}

export function ProjectTabsBar({
  feed,
  onOpenProjectSettings,
}: {
  feed: ConciergeFeed;
  /** Double-clicking a tab opens that project's settings (rename / move) — the Workspace owns the
   *  modal, exactly as it did when the TopBar's project button opened it. */
  onOpenProjectSettings: (p: Project) => void;
}) {
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const addProject = useProjectStore((s) => s.addProject);
  const pinnedProjectId = useUiStore((s) => s.pinnedProjectId);
  const togglePinnedProject = useUiStore((s) => s.togglePinnedProject);
  const openProjectIds = useUiStore((s) => s.openProjectIds);

  const [newProjectOpen, setNewProjectOpen] = useState(false);

  // Only OPEN projects get a tab. `openProjectIds === null` (nobody has opened or closed anything
  // yet — every install upgrading into this) means "all of them", so the bar is unchanged until the
  // user actually closes something. See engine/openProjects.
  const openProjects = useMemo(
    () => openProjectsOf(projects, openProjectIds),
    [projects, openProjectIds],
  );
  // The projects with no tab — offered for one-click reopen inside the "+" dialog, so closing is
  // never a one-way door that costs a trip through the folder picker to undo.
  const reopenable = useMemo(
    () => closedProjects(projects, openProjectIds),
    [projects, openProjectIds],
  );

  // Trial counter + Unlock, kept visible in the new chrome (parity #14). Same derivation and the
  // same shared paywall handler the TopBar used, so a signed-in user still converts in one click.
  const authLoading = useAuthStore((s) => s.loading);
  const tokenPresent = useAuthStore((s) => s.tokenPresent);
  const me = useAuthStore((s) => s.me);
  const paywallDismissed = useAuthStore((s) => s.paywallDismissed);
  const trialStarted = useTrialStore((s) => s.started);
  const trialLoading = useTrialStore((s) => s.loading);
  const inTrial =
    deriveAuthView({
      loading: authLoading,
      hasToken: tokenPresent,
      me,
      trialStarted,
      trialLoading,
      paywallDismissed,
    }) === "trial";
  const [trialFailedUrl, setTrialFailedUrl] = useState<string | null>(null);

  const project = projects.find((p) => p.id === selectedProjectId) ?? null;

  // Open-PR menu (repo-scoped, agent-independent — a PR outlives the agent that opened it). Its
  // "open agent" lands through the one tab-select path, so a PR from another project switches tabs.
  const resolveAgentForPr = (branch: string): PrAgentLink | null =>
    agentLinkForBranch(branch, projects, selectedProjectId);

  // Pop the native folder picker, map the folder to an existing project (reuse) or a brand-new one
  // (created only on commit, so a cancelled picker adds nothing), then select its tab.
  const pickAndOpen = async (title: string) => {
    const picked = await pickProjectFolder(title);
    if (!picked) return;
    const target = resolveOpenTarget(picked, projects, basename);
    const id = target.kind === "existing" ? target.id : addProject(target.name, target.path);
    openProjectTab(id);
  };

  return (
    <>
      <ProjectTabs
        projects={openProjects.map((p) => ({ id: p.id, name: p.name }))}
        selectedProjectId={selectedProjectId}
        pinnedProjectId={pinnedProjectId}
        countsByProject={countsFromFeed(feed)}
        // Re-clicking the tab you are ALREADY on is not a navigation, so it does nothing — in
        // particular it must not dismiss the Improve Sparkle pane out from under the user. The
        // check lives here, not in openProjectTab: this is the only caller where equal ids mean
        // "nothing to do" (a freshly added project is already selected, and every cross-context
        // caller means "take me there" regardless of what is current).
        onSelect={(id) => {
          if (id !== selectedProjectId) openProjectTab(id);
        }}
        onTogglePin={togglePinnedProject}
        onOpenSettings={(id) => {
          const p = projects.find((x) => x.id === id);
          if (p) onOpenProjectSettings(p);
        }}
        onClose={closeProjectTab}
        onAddProject={() => setNewProjectOpen(true)}
        topRight={
          <>
            {project && (
              <OpenPrMenu
                rootPath={project.rootPath ?? null}
                resolveAgent={resolveAgentForPr}
                onOpenAgent={(link) => openProjectTab(link.projectId, link.agentId)}
              />
            )}
            {inTrial && (
              <TrialIndicator
                onUnlock={() => void performTrialUnlock(tokenPresent, setTrialFailedUrl)}
                signInFailedUrl={trialFailedUrl}
              />
            )}
            <ConciergeTopRight />
          </>
        }
      />

      {newProjectOpen && (
        <NewProjectDialog
          onClose={() => setNewProjectOpen(false)}
          onOpenFromFolder={() => void pickAndOpen("Open or create a project folder")}
          // Reopen list: a project you closed is right here, one click away — you don't have to
          // remember where its folder lives to get its tab back.
          reopenable={reopenable.map((p) => ({ id: p.id, name: p.name, rootPath: p.rootPath }))}
          onReopen={(id) => {
            setNewProjectOpen(false);
            openProjectTab(id);
          }}
          // Clone & Open: create + select the cloned project's tab (no window question to ask).
          onCloned={(name, path) => openProjectTab(addProject(name, path))}
        />
      )}
    </>
  );
}
