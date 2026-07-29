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
//   - The open-PR menu and the trial counter + Unlock.
//
// THE AVATAR AND KEBAB ARE NOT HERE ANY MORE. `ConciergeTopRight` moved into the concierge's own
// header when that header consolidated to one row (rev4.html's `.ahd`; the founder's ask). This bar
// belongs to a PAIR — build + terminal are one project — while the avatar is about the human and
// the kebab about the app, so neither is a per-project control.
//
// It was mounted in BOTH places for one commit, which shipped two "Sparkle menu" buttons and two
// auth controls driving the same settings seam (roborev 54712). Nothing caught it: every whole-
// shell suite stubs `ConciergeTopRight`, and each component's own tests render only itself, so the
// duplicate existed exactly where no test was looking. `ProjectTabsBar.duplicateChrome.test.tsx`
// now mounts this bar and the concierge column together, unstubbed, and counts.
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
import { TrialIndicator } from "./TrialChrome";
import { OpenPrMenu, agentLinkForPr, type PrAgentLink } from "./OpenPrMenu";
import type { PrRow } from "../services/openPrs";
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
import { isProjectOpen, openProjectsOf } from "../engine/openProjects";
import { projectsOnSide, resolveSideSelection, sideOf } from "../engine/pairs";
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
import type { PairSide } from "../engine/cable";
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
  side = "right",
}: {
  feed: ConciergeFeed;
  /** Double-clicking a tab opens that project's settings (rename / move) — the Workspace owns the
   *  modal, exactly as it did when the TopBar's project button opened it. */
  onOpenProjectSettings: (p: Project) => void;
  /**
   * WHICH PAIR THIS STRIP BELONGS TO.
   *
   * The tabs are the PAIR's, not the window's — build and terminal are one project, so the strip
   * sits above the pair and never above the concierge (MAPPING.md, `.tabs` / `.ptab`: *"Moves:
   * above the pairs only, never above the concierge."*). The two sides mirror, so the active tab
   * hugs the centre on both: the strip is published as `data-side` and `index.css` reverses the
   * left one, exactly as `rev4.html` does with `.pair[data-side="left"] .pairtabs`.
   *
   * Defaults to `right` so every existing caller and test keeps the layout it had.
   */
  side?: PairSide;
}) {
  const projects = useProjectStore((s) => s.projects);
  const globalSelectedProjectId = useProjectStore((s) => s.selectedProjectId);
  // WHICH PROJECTS THIS STRIP SHOWS, and which of them is selected. A pair's strip lists ONLY that
  // pair's projects: the tabs are the pair's, so a tab here must name something this pair can
  // actually show. Listing all of them on both sides would let a click select a project whose panes
  // are mounted in the OTHER stage — a sidebar full of agent rows with no terminal beside them.
  const pairAssignment = useUiStore((s) => s.pairAssignment);
  const leftProjectId = useUiStore((s) => s.leftProjectId);
  const setLeftProject = useUiStore((s) => s.setLeftProject);
  const assignProjectToPair = useUiStore((s) => s.assignProjectToPair);
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
    () => projectsOnSide(openProjectsOf(projects, openProjectIds), pairAssignment, side),
    [projects, openProjectIds, pairAssignment, side],
  );
  // This strip's selection, validated against what this side actually holds — so a project that
  // moved to the other pair stops reading as selected here rather than leaving both strips lit.
  const selectedProjectId = resolveSideSelection(
    side === "left" ? leftProjectId : globalSelectedProjectId,
    openProjects,
  );
  // Selecting on the LEFT writes only the left slot. `selectedProjectId` in the project store keeps
  // meaning "the current project" for the concierge feed, notifications, capture and satellite
  // ownership — ten call sites that are about the app, not about a pair — so the left pair must not
  // move it. That is also why `openProjectTab` (which sets it) is the RIGHT path only.
  const selectOnThisSide = (id: string) => {
    if (side === "left") setLeftProject(id);
    else if (id !== globalSelectedProjectId) openProjectTab(id);
  };
  /**
   * Open a project from THIS strip.
   *
   * Every "+" flow — the folder picker, the reopen list, Clone & Open — used to commit straight
   * through `openProjectTab`, which lands a project on the RIGHT, so taken from the left strip the
   * action visibly did nothing where it was performed (roborev 55149).
   *
   * `isNew` IS THE WHOLE SAFETY OF THIS FUNCTION, and the first version did not have it. Assigning
   * unconditionally meant reopening a LEFT-assigned project from the right strip — which is easy to
   * do, because the reopen list is not side-filtered and lists every closed project on both strips —
   * yanked it into the right pair and discarded its stored side. Moving a project between pairs
   * remounts its panes, and a Terminal unmount KILLS its PTY: so "undo a close" silently destroyed
   * running terminals and a persisted layout choice, in the one affordance whose entire promise is
   * that closing a tab keeps panes and PTYs alive (engine/openProjects). (roborev 55158)
   *
   * So: a project that is genuinely NEW has no side yet and adopts this strip's. One that already
   * exists keeps the side it has, and `openProjectTab` routes it there.
   */
  const openFromThisStrip = (id: string, isNew: boolean) => {
    // CLEAR HERE, not in `pickAndOpen`. All three strip-opening paths funnel through this — the
    // folder picker, the reopen list and Clone & Open — and putting the clear one level up left the
    // stale banner alive on the other two: refuse once, hit "+" again, reopen something from the
    // list, and the banner still named a different project in the other pair. (roborev 55211)
    setTearOffError(null);
    if (isNew) assignProjectToPair(id, side);
    openProjectTab(id);
  };
  // The projects with no tab — offered for one-click reopen inside the "+" dialog, so closing is
  // never a one-way door that costs a trip through the folder picker to undo.
  // FILTERED TO THIS STRIP. The list is what the "+" dialog offers to reopen, and
  // `openFromThisStrip` routes an EXISTING project to the side it already lives on — so an
  // unfiltered list advertises choices this strip cannot honour: reopening a right-side project
  // from the LEFT strip opens the tab in the other pair, which is the "the action visibly does
  // nothing where it was performed" defect all over again (roborev 55192). Filtering is the half of
  // that fix the routing change did not cover.
  const reopenable = useMemo(
    // `projectsOnSide`, not a hand-rolled filter: it is the same partition the tab strip itself
    // uses and is already pinned by engine/pairs.test.ts, so the two cannot drift apart.
    () => projectsOnSide(closedProjects(projects, openProjectIds), pairAssignment, side),
    [projects, openProjectIds, pairAssignment, side],
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
  const resolveAgentForPr = (pr: PrRow): PrAgentLink | null =>
    agentLinkForPr(pr, projects, selectedProjectId);

  // Pop the native folder picker, map the folder to an existing project (reuse) or a brand-new one
  // (created only on commit, so a cancelled picker adds nothing), then select its tab.
  const pickAndOpen = async (title: string) => {
    // A refusal must not outlive the situation it described: pick a different folder, that project
    // opens correctly, and the banner still reads "Beta is open in the right pair" above it. The
    // clear for the OPENING paths lives in `openFromThisStrip`; this one covers the case where the
    // picker is cancelled or refuses again, so a previous refusal does not linger either.
    // (roborev 55207)
    setTearOffError(null);
    const picked = await pickProjectFolder(title);
    if (!picked) return;
    const target = resolveOpenTarget(picked, projects, basename);
    // AN EXISTING PROJECT THAT LIVES IN THE OTHER PAIR HAS TO SAY SO.
    //
    // Unlike the reopen list, the picker cannot be filtered — the user chose a folder, and it maps
    // to a project that already has a side. Committing silently would route the tab to the other
    // pair, so the strip the user acted on visibly does nothing: the exact defect the reopen filter
    // exists to prevent. Moving it here instead is not an option either — that remounts its panes
    // and kills its PTYs (engine/pairs). So: say it, and leave the project where it is.
    // (roborev 55196)
    // REFUSE ONLY WHEN IT IS ACTUALLY OPEN OVER THERE.
    //
    // `sideOf` answers "which pair owns it", not "does it have a tab" — and it answers "right" for
    // any project with no entry at all, which is every pre-existing one. Refusing on that alone told
    // the user "X is already open in the other pair" about a project that was not open ANYWHERE, and
    // broke a path that used to work: picking a closed project's folder from the left strip
    // previously reopened its tab (in the right pair — visible, just not on this strip). A refusal
    // string is an instruction the user will follow, so it has to describe a state that exists and
    // name a way out (AGENTS.md). Closed → reopen it on its own side, as before. (roborev 55200)
    if (
      target.kind === "existing" &&
      sideOf(pairAssignment, target.id) !== side &&
      isProjectOpen(target.id, openProjectIds)
    ) {
      const name = projects.find((p) => p.id === target.id)?.name ?? "That project";
      setTearOffError(
        `${name} is open in the ${side === "left" ? "right" : "left"} pair — switch to that strip to see it.`,
      );
      return;
    }
    const id = target.kind === "existing" ? target.id : addProject(target.name, target.path);
    // `existing` keeps whatever side it is already on — see openFromThisStrip.
    openFromThisStrip(id, target.kind !== "existing");
    // SAY WHERE IT WENT. Reopening a closed project on its own side is right — moving it would kill
    // its PTYs — but doing it SILENTLY from this strip is the very defect the reopen list is
    // side-filtered to prevent: the tab appears in the other pair and the strip the user acted on
    // shows nothing. The banner is `role="status"` and click-to-dismiss, so it carries an
    // informational line fine. (roborev 55207)
    if (target.kind === "existing" && sideOf(pairAssignment, target.id) !== side) {
      const name = projects.find((p) => p.id === target.id)?.name ?? "That project";
      setTearOffError(`${name} reopened in the ${side === "left" ? "right" : "left"} pair.`);
    }
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
    <div className="ptabstrip" data-side={side} data-testid="project-tabs-strip">
      <ProjectTabs
        projects={openProjects.map((p) => ({ id: p.id, name: p.name }))}
        // The left strip paints right-to-left (index.css `.ptabstrip[data-side="left"]`), so the
        // drag resolver has to be told: it compares screen x against tabs given in ARRAY order, and
        // those two disagree exactly when the flow is reversed.
        reversed={side === "left"}
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
          // The banner clears on the GESTURE, not on the navigation. The "reopened in the other
          // pair" line is an EVENT written into a STATE banner with no timeout and no dismissal but
          // a click, so it needs a next-deliberate-act expiry — and a re-click of the current tab is
          // still that act, while the guard below deliberately treats it as no navigation. Clearing
          // inside `selectOnThisSide` would therefore miss it, which also made the single-tab case
          // untestable. (roborev 55211)
          setTearOffError(null);
          if (tornOut.has(id)) void focusSatellite(id);
          if (id !== selectedProjectId) selectOnThisSide(id);
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
                projectId={project.id}
                resolveAgent={resolveAgentForPr}
                // A PR's agent may live in EITHER pair's project, so this one must NOT force the
                // project into this strip — it routes by the existing assignment.
                onOpenAgent={(link) => openProjectTab(link.projectId, link.agentId)}
              />
            )}
            {inTrial && (
              <TrialIndicator
                onUnlock={() => void performTrialUnlock(tokenPresent, setTrialFailedUrl)}
                signInFailedUrl={trialFailedUrl}
              />
            )}
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
            // REOPEN IS NOT A MOVE. This project already exists and already has a side; taking it
            // over would kill its PTYs (see openFromThisStrip).
            openFromThisStrip(id, false);
          }}
          // Clone & Open: create + select the cloned project's tab (no window question to ask).
          onCloned={(name, path) => openFromThisStrip(addProject(name, path), true)}
        />
      )}
    </div>
  );
}
