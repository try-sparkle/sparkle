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
import { tearOffTopLeft } from "./tabDrag";
import { clampToScreen, hitTestPoint, monitorToRect, screenFor, type Rect } from "../helper/helperGeometry";
import {
  SATELLITE_SIZE,
  focusSatellite,
  tearOffErrorMessage,
  tearOffProject,
} from "../services/satelliteWindows";
import { useTornOutProjects } from "../hooks/useTornOutProjects";
import { C } from "../theme/colors";

/**
 * Where to put a satellite torn out at `screenPoint`.
 *
 * Centre it on the cursor so it appears where the user let go, then decide which DISPLAY that lands
 * on and keep it fully inside — the whole point of the feature is a second monitor, so the drop
 * point is routinely on a display whose origin is not (0,0) and may be negative.
 *
 * `hitTestPoint(..., fresh: true, ...)` is required here and not a style choice: a freshly proposed
 * position carries none of the on-screen guarantees a persisted one does, so the display has to be
 * chosen from the window's CENTRE. Asking about the top-left of a 1000×720 window dropped near the
 * left edge of the right-hand monitor would resolve to the LEFT monitor and clamp it back there.
 *
 * Exported for test: the monitor list is the one thing that cannot be produced in jsdom.
 */
export function satellitePosition(
  screenPoint: { x: number; y: number },
  screens: Rect[],
): { x: number; y: number } {
  const size = { width: SATELLITE_SIZE.width, height: SATELLITE_SIZE.height };
  const want = tearOffTopLeft(screenPoint, size);
  const screen = screenFor(hitTestPoint(want, true, size), screens);
  return clampToScreen(want, size, screen);
}

/** Read the monitor layout in LOGICAL pixels, or `[]` when there is no Tauri (dev preview, tests).
 *  An empty list makes `screenFor` return a zero rect and `clampToScreen` pin at the origin, which
 *  is a worse position but never a crash — and Rust falls back to its own centring when we pass a
 *  degenerate one. */
async function readScreens(): Promise<Rect[]> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return [];
  try {
    const { availableMonitors } = await import("@tauri-apps/api/window");
    return (await availableMonitors()).map(monitorToRect);
  } catch (e) {
    console.debug("tear-off: monitor query failed; placing without screen clamp", e);
    return [];
  }
}

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
  const reorderProject = useProjectStore((s) => s.reorderProject);
  const tornOut = useTornOutProjects();
  // Pool exhaustion (all four `project-N` labels taken) is the one tear-off failure a user can
  // actually act on, so it gets a sentence rather than a console line.
  const [tearOffError, setTearOffError] = useState<string | null>(null);
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

  // Pull a tab clear of the strip → that project gets its own OS window showing columns ② + ③
  // (src-tauri/src/project_window.rs). Already torn out? Then the gesture means "show me that
  // window", not "make a second one" — two webviews mounting the same agent is the one thing the
  // ownership map exists to prevent (services/satelliteWindows).
  const handleTearOff = async (projectId: string, screenPoint: { x: number; y: number }) => {
    if (tornOut.has(projectId)) {
      await focusSatellite(projectId);
      return;
    }
    setTearOffError(null);
    const pos = satellitePosition(screenPoint, await readScreens());
    try {
      await tearOffProject(projectId, pos);
    } catch (e) {
      // tearOffProject already rolled its claim back, so the project is main's again and its panes
      // remount — the user loses a respawn, not the project.
      console.error("tear-off failed", projectId, e);
      setTearOffError(tearOffErrorMessage(e));
    }
  };

  return (
    <>
      <ProjectTabs
        projects={openProjects.map((p) => ({ id: p.id, name: p.name }))}
        selectedProjectId={selectedProjectId}
        pinnedProjectId={pinnedProjectId}
        countsByProject={countsFromFeed(feed)}
        tornOutProjectIds={tornOut}
        onReorder={reorderProject}
        onTearOff={(id, at) => void handleTearOff(id, at)}
        // Re-clicking the tab you are ALREADY on is not a navigation, so it does nothing — in
        // particular it must not dismiss the Improve Sparkle pane out from under the user. The
        // check lives here, not in openProjectTab: this is the only caller where equal ids mean
        // "nothing to do" (a freshly added project is already selected, and every cross-context
        // caller means "take me there" regardless of what is current).
        //
        // A TORN-OUT project's tab does BOTH: it raises that window AND selects the tab. Raising
        // alone was the obvious reading ("show me that project") and it was wrong — main's
        // placeholder, with "Bring it back here" on it, is reachable only while that project is
        // SELECTED. Skipping the selection meant that once you navigated away, the only way to
        // re-dock was the satellite's own red button, which is no help at all in the case the
        // placeholder exists for: a satellite stranded on a monitor that is no longer plugged in.
        // Doing both costs nothing — the window comes forward, and the recovery stays reachable
        // behind it.
        onSelect={(id) => {
          if (tornOut.has(id)) void focusSatellite(id);
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

      {tearOffError && (
        <div
          role="status"
          data-testid="tear-off-error"
          onClick={() => setTearOffError(null)}
          style={{
            padding: "6px 12px",
            fontSize: 12,
            color: C.cream,
            background: C.deepForest,
            borderBottom: `1px solid ${C.muted}`,
            cursor: "pointer",
          }}
          title="Dismiss"
        >
          {tearOffError}
        </div>
      )}

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
