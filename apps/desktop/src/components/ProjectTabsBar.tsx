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
import { useEffect, useMemo, useState } from "react";
import { FiX } from "react-icons/fi";
import type { Project } from "../types";
import { ProjectTabs, type ProjectTabCounts } from "./ProjectTabs";
import { TrialIndicator } from "./TrialChrome";
import { NewProjectDialog } from "./NewProjectDialog";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { useAuthStore } from "../stores/authStore";
import { useTrialStore } from "../stores/trialStore";
import { deriveAuthView } from "../services/entitlement";
import { performTrialUnlock } from "../services/trialUnlock";
import { pickProjectFolder, basename } from "../services/dialog";
import { resolveOpenTarget } from "../services/openTarget";
import { focusExistingProject, openProjectTab } from "../services/openProjectTab";
import { closeProjectTab, closedProjects } from "../services/projectTabs";
import { backfillRepoKeys, repoKeyFor, resolveRepoKeyFor } from "../services/repoKey";
import {
  alreadyOpenMessage,
  findDuplicateOpen,
  openAlreadyOpen,
} from "../engine/projectIdentity";
import { openProjectsOf } from "../engine/openProjects";
import { useProjectStaleness, useStalenessTargets } from "../hooks/useProjectStaleness";
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

/**
 * The id a not-yet-created project is compared under.
 *
 * `findDuplicateOpen` skips the record whose id matches the candidate's, so a folder with no record
 * yet needs an id that CANNOT collide with a real project id (those are uuids). Using `""` or the
 * eventual path would be fine today and is a trap tomorrow — the moment anything else adopts the
 * same convention, a real project starts excluding itself from the comparison and the dedupe
 * silently stops firing for it.
 */
export const NEW_PROJECT_CANDIDATE = "sparkle:new-project-candidate";

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
  /**
   * The "already open" notice — the visible half of an idempotent open, kept SEPARATE from
   * `tearOffError` because it carries an action and that one is plain text.
   *
   * `onOpenAnyway: null` renders the sentence with no button, for the case where a second open is
   * not representable at all (one record, one tab).
   */
  const [notice, setNotice] = useState<{ text: string; onOpenAnyway: (() => void) | null } | null>(
    null,
  );
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
  // How far each open project's OWN checkout lags the branch it tracks. Only STALE projects come
  // back, so the badge can never render a reassuring "0 behind" over a tree that could not be
  // measured (bead sparkle-cuv2h).
  const stalenessByProject = useProjectStaleness(useStalenessTargets(openProjects));
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
    // And the already-open notice, for the same reason and in the same place: this is the one seam
    // all three strip-opening paths commit through, so a notice raised by a PREVIOUS attempt cannot
    // survive a later successful open. Putting it only in `pickAndOpen` was what left the reopen
    // path showing a stale message (roborev 55211, now re-learned against the notice).
    setNotice(null);
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

  // Fill in `repoKey` for projects recorded before the field existed — without this the fix does
  // nothing for a store that ALREADY holds two records for one repository, which is every store
  // that has the bug. Re-runs when the project list changes and is a no-op once every project has
  // an answer (services/repoKey). Right strip only: both strips mount this component, and the sweep
  // is app-wide, so running it on each would double every git subprocess for no added coverage.
  useEffect(() => {
    if (side === "right") void backfillRepoKeys();
  }, [side, projects]);

  /** The stored record a candidate id names, if it is a real project (rather than a picked folder
   *  with no record yet). */
  const findSelf = (id: string) => projects.find((p) => p.id === id) ?? null;

  /**
   * IS THIS PROJECT ALREADY ON SCREEN? — the idempotent-open gate, in front of every path that
   * would otherwise put a second tab up for one project.
   *
   * Returns true when it HANDLED the open: it has focused the incumbent and posted a notice, and
   * the caller must not proceed. False means "nothing already open matches — carry on".
   *
   * `candidate` may be a project that exists or a synthetic stand-in for a freshly picked folder
   * that has no record yet (see `findDuplicateOpen`) — the second is the case that matters, because
   * that is where a second RECORD gets created.
   *
   * IT NEVER FORBIDS. The founder chose focus-and-tell over a hard refusal deliberately: Sparkle's
   * whole agent model is git worktrees, and opening two worktrees of one repository side by side is
   * a legitimate thing to want. `overrideRef` is that escape hatch — the notice carries an "Open
   * anyway" action, and taking it re-runs the same open with the gate suppressed for exactly one
   * attempt. So the guarantee is "never SILENTLY duplicates", not "cannot duplicate".
   */
  const dedupeOpen = (
    candidate: { id: string; name: string; rootPath: string; repoKey?: string | null },
    openAnyway: () => void,
  ): boolean => {
    // TWO DIFFERENT "ALREADY OPEN"S, and only the second is a duplicate.
    //
    //   • THIS EXACT RECORD already has a tab — re-picking the folder of a project you can already
    //     see. `findDuplicateOpen` deliberately answers null here (it excludes the candidate by id,
    //     because a record is not a duplicate of itself), so it has to be handled on its own.
    //     Focusing and saying so is still the right behaviour: the founder's standing requirement is
    //     that a second open is never a silent no-op he would read as a failed click.
    //   • a DIFFERENT record naming the same project — the worktree case, below.
    const self = findSelf(candidate.id);
    if (self && openAlreadyOpen(self.id, openProjectIds)) {
      focusExistingProject(self.id);
      setNotice({
        text: alreadyOpenMessage(
          { existing: self, side: sideOf(pairAssignment, self.id), viaWorktree: false },
          self.name,
        ),
        // No override offered. "Open anyway" would mean opening a SECOND tab for one record, which
        // is not representable — a project has at most one tab (engine/openProjects). The escape
        // hatch exists for two distinct records sharing a repository, which is the case below.
        onOpenAnyway: null,
      });
      return true;
    }
    const dup = findDuplicateOpen(candidate, projects, openProjectIds, pairAssignment);
    if (!dup) return false;
    // FOCUS FIRST, then say so. The founder's ask was "it tells me it's already open and brings it
    // into focus" — a message alone reads as a refusal, and a silent focus reads as a mis-click.
    focusExistingProject(dup.existing.id);
    setNotice({
      text: alreadyOpenMessage(dup, candidate.name),
      // `openAnyway` is the COMMIT half of whichever path called us, never the gated entry point —
      // so taking the override simply does not run this check again. There is no suppression flag
      // to set and, more to the point, none to leak: an earlier version parked the candidate id in
      // a ref and cleared it on the next `dedupeOpen`, which meant the override was spent on
      // whatever the user opened NEXT rather than on the open it authorized.
      onOpenAnyway: () => {
        setNotice(null);
        openAnyway();
      },
    });
    return true;
  };

  // Pop the native folder picker, map the folder to an existing project (reuse) or a brand-new one
  // (created only on commit, so a cancelled picker adds nothing), then select its tab.
  const pickAndOpen = async (title: string) => {
    // A refusal must not outlive the situation it described: pick a different folder, that project
    // opens correctly, and the banner still reads "Beta is open in the right pair" above it. The
    // clear for the OPENING paths lives in `openFromThisStrip`; this one covers the case where the
    // picker is cancelled or refuses again, so a previous refusal does not linger either.
    // (roborev 55207)
    setTearOffError(null);
    // Same expiry rule for the already-open notice: a new picker gesture is the next deliberate
    // act, so a notice about the LAST folder must not sit above the result of this one.
    setNotice(null);
    const picked = await pickProjectFolder(title);
    if (!picked) return;
    const target = resolveOpenTarget(picked, projects, basename);
    // THE IDEMPOTENT-OPEN GATE, and it REPLACES the old cross-pair refusal that stood here.
    //
    // That refusal ("X is open in the other pair — switch to that strip to see it") was right about
    // the situation and wrong about the remedy: it made the user go and find the tab themselves,
    // and it only ever recognised a project the picker had already matched BY PATH. Both of those
    // are the bug the founder hit — his `~/Projects/sparkle` and `~/Projects/sparkle-desktop` are
    // one repository reached through a linked worktree, so the path match never fired and he got a
    // second tab. `dedupeOpen` compares on REPOSITORY (engine/projectIdentity) and focuses the
    // incumbent itself, which is what "bring it into focus" means.
    //
    // THE KEY IS RESOLVED BEFORE THE COMPARISON, not after. A folder with no project record has no
    // stored `repoKey`, and asking git afterwards would be asking about a project we had already
    // decided to create — the duplicate would exist by then. This is the one place the await has to
    // happen before the branch. The picker is already async, so it costs nothing the user can feel.
    const pickedKey = await repoKeyFor(target.kind === "existing" ? picked : target.path);
    const self = target.kind === "existing" ? findSelf(target.id) : null;
    const candidate =
      target.kind === "existing"
        ? {
            id: target.id,
            name: self?.name ?? "That project",
            rootPath: self?.rootPath ?? picked,
            // `pickedKey` WINS OVER THE STORED ONE WHEN THERE ISN'T ONE. `existing` means the
            // picked folder IS this record's folder, so the key we just resolved describes it —
            // and until the backfill sweep reaches that record its own field is empty, which would
            // drop identity back to path and put a second tab up for the same repository. That is
            // the reported bug, in the window before the sweep lands.
            repoKey: self?.repoKey ?? pickedKey,
          }
        : { id: NEW_PROJECT_CANDIDATE, name: target.name, rootPath: target.path, repoKey: pickedKey };
    if (dedupeOpen(candidate, () => void pickAndOpenCommitted(target))) return;
    await pickAndOpenCommitted(target);
  };

  /**
   * The COMMIT half of `pickAndOpen`, split out so "Open anyway" can re-run exactly this and
   * nothing else — re-running the whole of `pickAndOpen` would pop the native folder picker a
   * second time and ask the user to choose the same folder again.
   */
  const pickAndOpenCommitted = async (target: ReturnType<typeof resolveOpenTarget>) => {
    const id = target.kind === "existing" ? target.id : addProject(target.name, target.path);
    // `existing` keeps whatever side it is already on — see openFromThisStrip.
    openFromThisStrip(id, target.kind !== "existing");
    // Record which repository the new project belongs to, so the NEXT open can dedupe on repo
    // identity rather than waiting for the startup sweep to reach it.
    if (target.kind !== "existing") void resolveRepoKeyFor(id);
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
    setNotice(null);
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
        // `rootPath` travels with the tab because the stale badge's panel diagnoses and remedies a
        // DIRECTORY — the badge could always say "1,935 behind", but nothing downstream of it knew
        // which checkout that was about (bead sparkle-7h01z).
        projects={openProjects.map((p) => ({ id: p.id, name: p.name, rootPath: p.rootPath }))}
        // The left strip paints right-to-left (index.css `.ptabstrip[data-side="left"]`), so the
        // drag resolver has to be told: it compares screen x against tabs given in ARRAY order, and
        // those two disagree exactly when the flow is reversed.
        reversed={side === "left"}
        selectedProjectId={selectedProjectId}
        pinnedProjectId={pinnedProjectId}
        countsByProject={countsFromFeed(feed)}
        stalenessByProject={stalenessByProject}
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
          setNotice(null);
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
            {/* THE OPEN-PR MENU USED TO BE HERE, as a wide bordered "3 PRs waiting" pill left of
                the + button. It moved to the concierge header, beside the ⋮, as a compact icon +
                count (`ConciergePrChip` in ConciergeHost). It MOVED rather than being duplicated:
                two PR affordances would disagree the moment one polled and the other hadn't, and
                this strip is per-side while pull requests are an app-wide concern. */}
            {inTrial && (
              <TrialIndicator
                onUnlock={() => void performTrialUnlock(tokenPresent, setTrialFailedUrl)}
                signInFailedUrl={trialFailedUrl}
              />
            )}
          </>
        }
      />

      {notice && (
        <div
          role="status"
          data-testid="already-open-notice"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "6px 12px",
            fontSize: 12,
            color: C.cream,
            background: C.deepForest,
            borderBottom: `1px solid ${C.muted}`,
          }}
        >
          <span style={{ flex: 1 }}>{notice.text}</span>
          {notice.onOpenAnyway && (
            // THE OVERRIDE. Two worktrees of one repository side by side is a real workflow (that
            // is how this repo's own agents work), so the gate informs rather than forbids.
            <button
              type="button"
              data-testid="already-open-anyway"
              onClick={notice.onOpenAnyway}
              style={{
                background: "transparent",
                color: C.cream,
                border: `1px solid ${C.muted}`,
                borderRadius: 4,
                padding: "2px 8px",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Open anyway
            </button>
          )}
          {/* `FiX`, not a "×" character: affordances are react-icons here, and the glyph ratchet
              (components/glyphIcons.test.ts) counts a bare multiplication sign as an icon site. */}
          <button
            type="button"
            data-testid="already-open-dismiss"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => setNotice(null)}
            style={{
              background: "transparent",
              color: C.cream,
              border: "none",
              display: "flex",
              alignItems: "center",
              lineHeight: 1,
              padding: 0,
              cursor: "pointer",
            }}
          >
            <FiX size={13} aria-hidden />
          </button>
        </div>
      )}

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
            // GATED TOO. The reopen list is side-filtered and only offers CLOSED projects, so it
            // cannot re-open something that already has a tab — but it can absolutely reopen a
            // project whose REPOSITORY is already on screen under another record, which is the
            // founder's case with the roles reversed (close `sparkle-desktop`, reopen it while
            // `sparkle` is up). Covering only the picker is how this bug comes back.
            const p = findSelf(id);
            if (p && dedupeOpen(p, () => openFromThisStrip(id, false))) return;
            // REOPEN IS NOT A MOVE. This project already exists and already has a side; taking it
            // over would kill its PTYs (see openFromThisStrip).
            openFromThisStrip(id, false);
          }}
          // Clone & Open: create + select the cloned project's tab (no window question to ask).
          // NOT GATED, and deliberately: a clone writes a brand-new directory that nothing else can
          // already be open on. Its repo key is still recorded, so the NEXT open dedupes against it.
          onCloned={(name, path) => {
            const id = addProject(name, path);
            openFromThisStrip(id, true);
            void resolveRepoKeyFor(id);
          }}
        />
      )}
    </div>
  );
}
