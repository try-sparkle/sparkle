import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, getAllWindows } from "@tauri-apps/api/window";
import { C, FONT_WEIGHT, ON_BRAND_FILL, ON_GOLD_FILL } from "../theme/colors";
import type { AgentTab, Project } from "../types";
import { useProjectStore } from "../stores/projectStore";
import { ConciergeHost } from "./ConciergeHost";
import { ColumnPullTab, publishColumnWidthVar } from "./ColumnPullTab";
import { CommandPalette, PaletteTrigger, useCommandPalette } from "./Concierge";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useConnectionStore } from "../stores/connectionStore";
import { useCloudAgentsEnabled } from "../hooks/useCloudAgents";
import { useSettingsStore } from "../stores/settingsStore";
import { useNewAgent } from "../hooks/useNewAgent";
import { reattachProjectOnOpen } from "../services/cloudAgents/startup";
import { NewAgentRuntimeToggle } from "./NewAgentRuntimeToggle";
import { useNewBuildAgentDrop } from "../hooks/useNewBuildAgentDrop";
import { AgentSidebar, NewBuildAgentButton } from "./AgentSidebar";
import { PLAN_COLUMN_Z } from "./layers";
import { PlanBuildToggle } from "./PlanBuildToggle";
import { ProjectTabsBar } from "./ProjectTabsBar";
import { OfflineBanner } from "./OfflineBanner";
import { ZeroCreditBanner } from "./ZeroCreditBanner";
import { ProviderUnavailableBanner } from "./ProviderUnavailableBanner";
import { AiServiceBanner } from "./AiServiceBanner";
import { ClosePrompt } from "./ClosePrompt";
import { StatusStrip } from "./StatusStrip";
import {
  shouldWarmSparkleAtLaunch,
  sparkleAgentIdFor,
  sparkleOpenSetWhitelist,
  SPARKLE_AGENT_NAME,
} from "../services/sparkleAgent";
import {
  useCurrentProjectId,
  useIsMainWindow,
  useCurrentWindowLabel,
} from "../windowContext";
import { isCalmBand, useConciergeFeed } from "../useConciergeFeed";
import { useCableStore } from "../stores/cableStore";
import { useEffectiveWired } from "../hooks/useEffectiveWired";
import { useWindowWidth } from "../hooks/useWindowWidth";
import {
  COLUMN_HARD_MAX,
  COLUMN_MIN_WIDTH,
  CONCIERGE_PAIRED_HARD_MAX,
  CONCIERGE_WIDTH_VAR,
  conciergePairedMax,
  windowAwareMax,
} from "../engine/columnResize";
import {
  clearsSelectionOnKey,
  releaseStillArmed,
  unbindsOnKey,
  unbindsOnPointerDown,
  dismissibleSurfaceOpen,
  type PairSide,
} from "../engine/cable";
import { terminalBlocksSelectionRelease } from "../engine/terminalEscape";
// ONE classifier for "is the caret in a terminal", and it is not ours: `voice/dictationFocus` owns
// that question for the whole app (dictation pauses on the same fact). This file adds only the
// orthogonal one — who put the caret there — via `services/terminalFocusIntent`.
import { focusOwnerNow } from "../voice/dictationFocus";
import { installTerminalFocusIntentTracker } from "../services/terminalFocusIntent";
import { clearTerminalEscapeToll } from "../services/terminalEscapeRelease";
import { matchesChord } from "../keyboardHints/keybindings";
import { useKeybindingsStore } from "../stores/keybindingsStore";
import {
  pairCountFor,
  resolveSideProject,
  sideOf,
  type PairAssignment,
} from "../engine/pairs";
import { planBoardUp } from "../engine/planBoard";
import { decidePromptTarget, resolvePinnedProjectId } from "../engine/shellResolve";
import {
  markProjectVisited,
  onVisitedProjectsChange,
  visitedProjectsVersion,
  wasProjectVisited,
} from "../services/sessionProjects";
import { subscribeToCrossWindowSync } from "../services/crossWindowSync";
import { useTornOutProjects } from "../hooks/useTornOutProjects";
import { focusSatellite, reclaimProject, reconcileSatellites } from "../services/satelliteWindows";
import { startPresenceTracking } from "../stores/presenceStore";
import { startOrchestrationListener } from "../services/orchestrationListener";
import { startControlListener } from "../services/controlListener";
import { closeScopeProjectNames, killAllOpenAgents, planWindowClose } from "../services/windowClose";
import { clearWindowProject } from "../services/windowRegistry";
import { clearWindowRoster } from "../services/attention";
import { safeUnlisten } from "../services/safeUnlisten";
import { TERMINAL_STAGE_DND_TARGET } from "../services/dndTargets";
import { useImprovementScheduler } from "../useImprovementScheduler";
import { ErrorBoundary, AgentPaneErrorCard } from "./ErrorBoundary";
import { perfRender } from "../perfTrace";
import { FONT_MONO, FONT_UI } from "../theme/scale";

// Code-split the heavy, not-always-visible surfaces so a cold start doesn't ship them in the
// initial chunk (bead sparkle-alrm.5, #9). AgentPane pulls the terminal (xterm + webgl), Onboarding
// and the Markdown renderer (via ThinkPanel → react-markdown/remark-gfm); none of it is needed
// until an agent pane actually opens. BoardView, the Sparkle pane and the settings modal are
// likewise on-demand. The always-visible shell (tabs, sidebar, banners, close prompt) stays eager
// above. These are named exports, so map each to `default` for lazy().
// (Declared below all imports so no non-import statement precedes an `import`.)
const AgentPane = lazy(() => import("./AgentPane").then((m) => ({ default: m.AgentPane })));
const SparkleAgentPane = lazy(() =>
  import("./SparkleAgentPane").then((m) => ({ default: m.SparkleAgentPane })),
);
const BoardView = lazy(() => import("./BoardView").then((m) => ({ default: m.BoardView })));
const ProjectModal = lazy(() => import("./ProjectModal").then((m) => ({ default: m.ProjectModal })));
const NewCloudAgentDialog = lazy(() =>
  import("./NewCloudAgentDialog").then((m) => ({ default: m.NewCloudAgentDialog })),
);

/** The macOS titlebar / Window menu / dock tooltip text. A constant, not the project name — the
 *  project tab bar is what says which project you're on. Matches tauri.conf.json's window title so
 *  the runtime set_title can never disagree with the title the window is BORN with (a mismatch
 *  shows up as a visible flicker from one name to another during boot). */
export const WINDOW_TITLE = "Sparkle";

/** Fills the pane slot with the app background while a lazy surface's chunk loads, so on-demand
 * loading never flashes a blank/white frame under the (eager) shell. */
function PaneFallback() {
  return <div style={{ position: "absolute", inset: 0, background: C.forest }} />;
}

/**
 * HOW MANY PAIRS FLANK THE CONCIERGE — `data-pairs` on the shell root.
 *
 * DERIVED, not a constant: `pairCountFor(projects, pairAssignment)` in the render below. It used to
 * be a hardcoded `1` with a comment explaining why the second pair was real work rather than a
 * render, and that comment named the constraint correctly (MAPPING.md, Gaps §3): pane mounting is
 * keyed per project/agent, **a Terminal unmount kills its PTY**, and every agent must be owned by
 * exactly one pair — mounting the same agent id in two stages puts two xterms on one PTY, the
 * failure the tear-off ownership map exists to prevent.
 *
 * That constraint is now MET rather than avoided. `engine/pairs` assigns each project to exactly
 * one side and `livePanes` partitions the mounted panes through it, so each stage renders only its
 * own — a project's panes can be in one stage or the other, never both, by construction. Moving a
 * project between sides does remount its panes and cost a respawn, which is precisely what tearing
 * one out to its own window already does; see the module header for why that trade is the right
 * way round.
 *
 * The count is derived rather than stored so it cannot disagree with the assignment map. Every such
 * disagreement — a left pair with nothing in it, or a left-assigned project with no pair to render
 * it — is a project whose panes have nowhere to mount.
 */

/**
 * ONE PANE, MOUNTED ONCE, DISPLAYED WHEREVER ITS PAIR IS — the mechanism that makes moving a
 * project between pairs free.
 *
 * THE PROBLEM. Each stage used to render its OWN slice of the pane list, so re-assigning a project
 * moved its panes from one JSX parent to the other. React has no way to see that as a move: the
 * `<AgentPane>` under the left stage and the one under the right are different positions in the
 * tree, so the old one unmounts and a new one mounts. A `Terminal` unmount KILLS its PTY, so every
 * project that changed sides paid a `claude --resume` respawn and lost its scrollback. Closing a
 * pair moves EVERY project on it, so a dozen open projects cost a dozen respawns per toggle. The
 * founder's requirement was the opposite: "all the project tabs would just move over to the right
 * one. And they wouldn't lose anything."
 *
 * THE FIX. The loss comes from UNMOUNTING, not from moving. So the pane is mounted exactly once, in
 * one stable place in the React tree (see `AgentPaneList`'s call site), and PORTALLED into whichever
 * stage should display it. Changing sides changes the portal's DESTINATION; the component, its
 * effects, its xterm and its PTY are never touched.
 *
 * WHY A HAND-MANAGED HOST DIV RATHER THAN `createPortal(children, stage)`. Because handing
 * `createPortal` a different container is itself an unmount: React's reconciler compares
 * `stateNode.containerInfo`, and a portal fiber whose container changed is deleted and re-created —
 * the exact remount this exists to avoid. So the portal's container is a div THIS component owns and
 * never swaps, and it is the div that is re-parented, with `appendChild`. React sees one container
 * for the lifetime of the pane; the DOM sees a subtree move, which preserves every node in it.
 *
 * `display: contents` so the host generates no box of its own. The pane inside is
 * `position: absolute; inset: 0` and must resolve against the STAGE, exactly as it did when it was a
 * direct child — a real wrapper box would become the containing block and would also sit in the
 * stage's hit-test as a full-bleed rectangle over every pane below it.
 *
 * A NULL TARGET IS A REAL, SAFE STATE. The left stage does not exist until `pairCount` is 2, so for
 * the one commit between "this project is now left" and "the left stage has mounted and reported its
 * node" the host is simply left where it already was. It is never detached, never unmounted, and it
 * moves on the next commit. That is a frame of staleness, not a respawn.
 *
 * WHAT A DOM MOVE COSTS xterm, since it is the obvious worry: nothing that is not already handled.
 * The canvas and the whole xterm subtree move intact. If the stages differ in width the pane's box
 * changes size, which is what `Terminal`'s ResizeObserver already exists to fit; if they don't, there
 * is nothing to re-fit. A WebGL context lost across the move lands in `Terminal`'s `detachWebgl`,
 * which disposes the addon, releases the GPU context, hands its concurrency permit back, falls back
 * to the DOM renderer and repaints. That is reached from our own `webglcontextlost` listener in the
 * SAME event dispatch — not from `WebglAddon.onContextLoss`, which xterm fires a full 3 seconds
 * later (see terminalWebgl.ts) and which is only kept as a backstop.
 *
 * And to close the obvious suspicion, since re-parenting a canvas forces a context re-creation in
 * some engines: this host does NOT multiply context allocations. The container is never swapped, so
 * React never deletes and re-creates the portal fiber, and `appendChild` moves the live subtree
 * rather than rebuilding it. Confirmed against the field log — 103 `Terminal.attachWebgl` spans
 * across 81 agents, i.e. ~1.3 per agent, which is the hide/show switching rate and not a
 * per-reparent storm.
 */
function PaneHost({ target, children }: { target: HTMLElement | null; children: React.ReactNode }) {
  // Created ONCE, per pane, and never replaced — the stable container the note above requires.
  // `useState` with an initializer rather than `useRef`, so it is allocated exactly once even under
  // StrictMode's double-invoked render.
  const [host] = useState(() => {
    const el = document.createElement("div");
    el.style.display = "contents";
    el.dataset.paneHost = "";
    return el;
  });
  // useLayoutEffect, not useEffect: the pane must be under its stage before the browser paints, or a
  // side change flashes the pane in its old column for a frame.
  useLayoutEffect(() => {
    // `appendChild` MOVES the node when it already has a parent — one call is both the insert and
    // the removal-from-the-old-stage. Deliberately no cleanup that detaches on target change: a
    // detach-then-attach would take the subtree out of the document between commits for no gain.
    if (target) target.appendChild(host);
  }, [target, host]);
  // The only real teardown. Runs when the PANE unmounts (its agent closed, its project torn out),
  // which is the one case where the DOM should actually lose the node.
  useEffect(() => () => host.remove(), [host]);
  return createPortal(children, host);
}

/**
 * EVERY mounted agent pane, in ONE list, each portalled into the stage its pair owns.
 *
 * THE INVARIANT `engine/pairs` EXISTS FOR IS STRONGER HERE, NOT WEAKER: a project's panes are
 * mounted in exactly one place. There used to be two stages that could each construct a pane, and
 * the guarantee came from partitioning `live` so that neither list ever held the same agent twice —
 * correct, but a property of the partition rather than of the shape. Now there is a SINGLE mount
 * site keyed by agent id, so "the same agent id mounted in two stages" — two xterms on one PTY, one
 * of the child processes orphaned by `pty_spawn`'s `sessions.insert` — is not something the code can
 * express. `sideOf` decides where a pane is DISPLAYED, not whether it is constructed.
 *
 * `visibleAgentId[side]` is null when that stage is showing something else entirely (the Plan board,
 * the Improve Sparkle pane) — the panes stay MOUNTED and merely invisible, because a Terminal
 * unmount kills its PTY.
 */
function AgentPaneList({
  panes,
  pairAssignment,
  stages,
  visibleAgentId,
  calm,
}: {
  panes: ReadonlyArray<{ project: Project; agent: AgentTab }>;
  pairAssignment: PairAssignment;
  /** The DOM node each side's stage renders into. `null` while that pair is not on screen. */
  stages: Readonly<Record<PairSide, HTMLElement | null>>;
  visibleAgentId: Readonly<Record<PairSide, string | null>>;
  calm: Readonly<Record<PairSide, boolean>>;
}) {
  return (
    <>
      {panes.map(({ project: p, agent }) => {
        const side = sideOf(pairAssignment, p.id);
        // Agent ids are globally unique, so this comparison is exactly "is this the pane to show" —
        // a background tab's agent never matches.
        const visible = agent.id === visibleAgentId[side];
        return (
          // The Suspense boundary is INSIDE the portal, which is a change forced by the portal and
          // worth naming. It used to be one boundary around the whole list, on the reasoning that
          // the panes share a chunk so they should share a fallback. That reasoning still holds —
          // they do all resolve together — but the list no longer renders where the fallback needs
          // to appear: it lives outside both stages now, and `PaneFallback` is `position: absolute;
          // inset: 0`, so a boundary out there would paint its backdrop against the VIEWPORT and
          // cover the whole window. Inside the host it lands in the stage, exactly where the pane it
          // is standing in for will land.
          <PaneHost key={agent.id} target={stages[side]}>
            <Suspense fallback={<PaneFallback />}>
              {/* Per-pane boundary: one crashing pane degrades to an inline card (respecting its
                  visibility) instead of unmounting the workspace and its sibling agents. */}
              <ErrorBoundary
                scope="agent-pane"
                fallback={({ error, reset }) => (
                  <AgentPaneErrorCard error={error} reset={reset} visible={visible} />
                )}
              >
                <AgentPane
                  project={p}
                  agent={agent}
                  visible={visible}
                  // Calm is a property of the pane you are LOOKING at, so only the visible one ever
                  // carries it — a background pane re-theming would clear its WebGL atlas for a
                  // screen nobody is watching.
                  calm={visible && calm[side]}
                />
              </ErrorBoundary>
            </Suspense>
          </PaneHost>
        );
      })}
    </>
  );
}

/**
 * THE SHELL RE-RENDERS AT POINTER RATE DURING A COLUMN DRAG. These two must not follow it.
 *
 * Every pointer event of a seam drag commits a new width, which re-renders `Workspace` and — before
 * this — everything it renders directly. The panes were already safe (`arePanePropsEqual`), but the
 * sidebar re-rendered its whole agent list and each tab strip re-derived its per-side partition,
 * once per pointer event. Measured in `Workspace.renderCost.test.tsx` at 30 renders each across a
 * 30-step drag, against 0 for the panes.
 *
 * Neither component takes a prop that a column boundary can change — the sidebar takes one project
 * object, the strips take a side, the memoized concierge feed and a `useState` setter — so the
 * default shallow comparison is exactly right, and both keep their own store subscriptions (memo
 * gates PARENT-driven renders only, never a component's own updates or context).
 *
 * Wrapped HERE rather than at their definitions because those files are owned by other work in
 * flight; this is a property of how the shell calls them either way.
 */
const MemoAgentSidebar = memo(AgentSidebar);
const MemoProjectTabsBar = memo(ProjectTabsBar);
/** The pane list, memoized like its two siblings above — it was the one direct child of the shell left
 *  re-rendering on every `Workspace` render, which on a seam drag is every pointer event. Its props are
 *  `useMemo`'d at the call site; without that this wrapper would bail out never (roborev 55316). */
const MemoAgentPaneList = memo(AgentPaneList);
/**
 * A PAIR — a build column and its terminal, which are ONE project and are never split.
 *
 * The pair owns the project tabs (`.pairtabs`): build and terminal are the same project, so the
 * tabs belong to the pair and never sit above the concierge. That is the structural difference
 * between this shell and the one it replaces, where a single full-width strip spanned everything.
 *
 * THE MIRROR. Children are always given in the order `[build, terminal]`; the LEFT pair reverses
 * its column flow so the terminal ends up outboard and build stays adjacent to the concierge:
 *
 *     left pair  →  TERM │ BUILD │ concierge
 *     right pair →  concierge │ BUILD │ TERM
 *
 * Reversing the FLOW rather than the children keeps the DOM order — and therefore the tab order and
 * the reading order — identical on both sides.
 *
 * NO VERTICAL DIVIDING LINE INSIDE A PAIR. The founder was explicit: build and terminal are one
 * thing. The only seam is at the concierge boundary, which is why `.build` carries a border on
 * exactly one side (its inboard one) and the terminal carries none. See `index.css`.
 */
export function Pair({
  side,
  tabs,
  children,
  wired = false,
}: {
  side: PairSide;
  /** Does this pair hold the live circuit? Marks it as part of the circuit for the unbind gesture. */
  wired?: boolean;
  /** The pair's project tab strip. Above the pair only — never above the concierge. */
  tabs: React.ReactNode;
  /** `[build, terminal]`, in that order, on both sides — plus, optionally, this pair's Plan board
   *  as a THIRD child. The board is `position: absolute` so it is not a flex item at all: it lays
   *  over both columns without displacing either. See `PlanBoardSlot`. */
  children: React.ReactNode;
}) {
  return (
    <div
      className="pair"
      data-pair
      data-side={side}
      data-wired-pair={String(wired)}
      data-testid={`pair-${side}`}
      // ── EVERY PAIR IS ELASTIC NOW, AND THAT IS THE WHOLE CENTRING MECHANISM ──────────────────
      //
      // THIS REVERSES A DELIBERATE ASYMMETRY. The left pair used to be PINNED to its own stored
      // width while the right pair alone was `flex: 1`, so the right pair absorbed every change in
      // the row. The comment that stood here defended it: with both pairs elastic, "the column grew
      // about its centre and its left edge slid left every time the user dragged its right edge",
      // and pinning the left pair was what stopped one edge dragging the other.
      //
      // The founder was shown that exact sentence and chose symmetric anyway, because the premise
      // changed: the concierge is the row's ANCHOR now, not a column between two neighbours. A
      // column that stays dead centre is worth an edge that moves when you pull its opposite — and
      // the old model's own costs were worse, since nothing could grow the concierge leftward at all
      // and a 3-display span put 2.5 displays into the right pair.
      //
      // `flex: 1 1 0` and NOT `flex: 1 1 auto`: the halves must divide the free space EQUALLY
      // regardless of what is inside them. With an `auto` basis each half's content would seed its
      // share, so a wider build column on one side would make that half wider too and slide the
      // concierge off centre — the exact defect, re-introduced through the back door.
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        flex: "1 1 0",
        position: "relative",
      }}
    >
      <div className="pairtabs" data-side={side} data-testid={`pair-tabs-${side}`}>
        {tabs}
      </div>
      {/* Position:relative so Plan mode can lay ONE wide card column over both columns —
          covering, never unmounting: a Terminal unmount kills its PTY, so a mode flip must not
          tear the panes down (and display:none would zero their measured size). */}
      <div
        className="paircols"
        data-testid={`pair-cols-${side}`}
        style={{
          flex: 1,
          display: "flex",
          minWidth: 0,
          minHeight: 0,
          position: "relative",
          flexDirection: side === "left" ? "row-reverse" : "row",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** The concierge column's persisted width, and the range a drag/arrow-key commit is clamped to.
 *  360 is what the column shipped at as a hardcoded prop; the bounds are wider than the agent
 *  column's because this column holds prose (the thread) rather than a list of short rows. */
/** Exported so a test asserts the key this component actually writes instead of re-spelling it, or
 *  worse, discovering it by taking a census of localStorage — see `Workspace.resize.test.tsx`. */
export const CONCIERGE_WIDTH_KEY = "sparkle-concierge-width";
/** THE TWO-PAIR WIDTH, STORED SEPARATELY — and it has to be, because the two modes now want very
 *  different numbers from the same column.
 *
 *  In the single-pair shell the concierge is a 280–560px reading column pinned to the row's left. In
 *  the five-column cockpit it is the ANCHOR, and the founder's target layouts put it at ~1100 and
 *  ~1920 on a three-display span. One shared value means opening a left pair inherits a width chosen
 *  for the other layout, and — far worse — dragging it there writes that back over the single-pair
 *  preference, so closing the pair leaves a concierge three times too wide with no way to know why.
 *
 *  SEEDED from the single-pair value on first use, so an existing install's width is where the
 *  cockpit starts rather than snapping to a default. */
export const CONCIERGE_WIDTH_KEY_PAIRED = "sparkle-concierge-width:2";
/** The shared 50px floor every column now answers to — see `COLUMN_MIN_WIDTH` in engine/columnResize.
 *  Was 280, which on a ~890px window put this column's ceiling AT its floor (`min 280, max 280` in the
 *  log) and left the seam dead through three consecutive drags. */
const CONCIERGE_MIN_WIDTH = COLUMN_MIN_WIDTH;
/** The single-pair ceiling. Now the shared sanity cap rather than a bare 560: the founder's rule is
 *  that only the 50px floors narrow a column, and `windowAwareMax` below still keeps the seam inside
 *  the window. */
const CONCIERGE_MAX_WIDTH = COLUMN_HARD_MAX;
// Re-exported from engine/columnResize, which owns the sibling column widths and is importable
// from a node-environment test without pulling this module's store/Tauri graph in (roborev 56223).
export { CONCIERGE_DEFAULT_WIDTH } from "../engine/columnResize";
import { CONCIERGE_DEFAULT_WIDTH } from "../engine/columnResize";

/** Which key a given pair count reads and writes. */
function conciergeWidthKeyFor(pairCount: number): string {
  return pairCount === 2 ? CONCIERGE_WIDTH_KEY_PAIRED : CONCIERGE_WIDTH_KEY;
}

/** THE LEFT PAIR NO LONGER HAS A WIDTH OF ITS OWN, and deleting it is the change.
 *
 *  It used to be pinned (`sparkle-left-pair-width`, 320–1400, default 640) so that "one boundary owns
 *  one column": the seam to the concierge's LEFT moved the LEFT PAIR, the seam to its right moved the
 *  concierge, and neither could disturb the other. That made the two edges independent — and it is
 *  precisely what the founder rejected, for two consequences it could not avoid:
 *
 *    • NO GESTURE GREW THE CONCIERGE LEFTWARD. The left seam owned the pair, so dragging it slid the
 *      concierge sideways as a rigid block. "It drags the whole app."
 *    • THE RIGHT PAIR WAS THE ONLY ELASTIC COLUMN, so it absorbed every change in the row. On a
 *      5760px span, `640 + 360` left it ~4,700px — "the right side display is spanning like one and
 *      a half displays."
 *
 *  Both halves are `flex: 1 1 0` now, so they are equal by construction and the concierge is pinned
 *  dead centre with no arithmetic anywhere (engine/columnResize's `cockpitGeometry`). A pair has no
 *  width to store, so the key, its bounds, its state, its debounce and its flush are all gone. What
 *  the user actually adjusts inside a half is the BUILD column, which has always had its own per-side
 *  storage and keeps it. */

/** How much of the row the sole pair must be left in a SINGLE-pair shell.
 *
 *  SPELLED AS A LITERAL, not derived from `BUILD_COLUMN_MIN_WIDTH`, and that is the fix rather than
 *  the shortcut. It used to read `BUILD_COLUMN_MIN_WIDTH + 200`, so when every column was put on one
 *  50px floor this reserve silently moved 360 → 250 — changing the single-pair ceiling by 110px in a
 *  change whose whole premise was that the single-pair row is the layout the founder says already
 *  works and must not move. A constant that tracks another constant it was never conceptually tied to
 *  is how "untouched" becomes untrue without anyone editing the line.
 *
 *  360 = a build column at 160 + 200 of terminal. Those two numbers are this row's own history, not
 *  the five-column floors: 160 was the build column's minimum when this reserve was chosen, and the
 *  pairing is what the narrowest window `tauri.conf.json` permits (900px) can actually honour. A
 *  200px terminal is cramped; it is not a lockout, and the build column's own CSS floor keeps it from
 *  being eaten below that. */
export const PRIMARY_PAIR_ROW_RESERVE = 360;
/** The single-pair concierge reserve: its one seam rail plus the pair beside it. */
function conciergeSingleRowReserve(): number {
  return 6 + PRIMARY_PAIR_ROW_RESERVE;
}

/**
 * THE app shell (Concierge Mode, bead sparkle-qd80 / CM-U7) — one window, three depth layers,
 * projects as TABS:
 *
 *   ┌ project tabs ────────────────────────────── kebab + avatar ┐
 *   │ ① Sparkle concierge │ ② builder agents │ ③ terminal        │
 *   └────────────────────────────────────────────────────────────┘
 *
 * The concierge column is persistent and spans every project (it does NOT participate in the tabs).
 * Column 2's header is the Plan/Build toggle; in Plan mode columns 2+3 collapse into one wide
 * Plan-card column. There is no composer above the terminal — the concierge box is the only one.
 *
 * PANE MOUNTING: every open agent of every project SELECTED AT LEAST ONCE this session is mounted,
 * and only the selected project's selected agent is visible. Both halves are load-bearing:
 *   • sticky — a Terminal unmount KILLS its PTY and disposes the xterm (Terminal.tsx cleanup) with
 *     no scrollback replay, so unmounting the panes of the tab you just left would kill that
 *     project's agents. The visited set only ever grows, which is that guarantee. One window means
 *     no risk of two xterms on one PTY, which is what the old per-window scoping guarded against.
 *   • lazy — mounting every project's panes at BOOT spawned a PTY + `claude --resume` for every
 *     open agent across every project before the user touched those tabs, plus each pane's
 *     background effects. The invariant only requires KEEPING panes after a visit, not pre-mounting.
 */
export function Workspace() {
  // Workspace subscribes to the whole `projects` array, so it re-renders on EVERY projectStore write
  // (status flips, activity, prompt appends…) and re-renders the live pane list under it. This counter
  // exposes that render rate — the top-level driver of pane re-render thrash (perfTrace).
  perfRender("Workspace", "main");

  // The concierge column's width, persisted. It lives HERE rather than inside ConciergeHost because
  // the resize tab is a sibling of the column, not a child: the boundary belongs to the layout that
  // owns both sides of it. Same storage shape as the agent column's width, and the same
  // read-through validation — a persisted value outside the clamp is ignored rather than restored,
  // so a stale entry from an older clamp cannot wedge the column off-screen.
  // ONE VALUE PER PAIR COUNT, both read at mount. See CONCIERGE_WIDTH_KEY_PAIRED for why they cannot
  // share: the single-pair shell wants a 280–560 reading column, the cockpit wants an anchor that may
  // be 1920 wide, and one shared number means each mode overwrites the other's preference the first
  // time it is dragged.
  //
  // BOTH KEYS ARE READ HERE rather than lazily when the count changes, because `pairCount` is derived
  // from the project store further down and a state initialiser that depended on it would have to run
  // again — re-initialising state on a prop change is the pattern that silently drops whatever the
  // user did in between.
  const [conciergeWidths, setConciergeWidthsRaw] = useState<Record<1 | 2, number>>(() => {
    const rawSingle = Number(localStorage.getItem(CONCIERGE_WIDTH_KEY));
    const single =
      rawSingle >= CONCIERGE_MIN_WIDTH && rawSingle <= CONCIERGE_MAX_WIDTH
        ? rawSingle
        : CONCIERGE_DEFAULT_WIDTH;
    // VALIDATED AGAINST THE HARD CEILING, not the window-aware one: the live clamp happens at render
    // (`renderedConciergeWidth`), so a width chosen on a three-display span is KEPT while docked to a
    // laptop and restored on the way back — the same preference-survival rule the build columns have.
    const rawPaired = Number(localStorage.getItem(CONCIERGE_WIDTH_KEY_PAIRED));
    const paired =
      rawPaired >= CONCIERGE_MIN_WIDTH && rawPaired <= CONCIERGE_PAIRED_HARD_MAX ? rawPaired : single;
    return { 1: single, 2: paired };
  });
  // NOT PERSISTED PER PIXEL, and not re-created per render. Both halves are on the drag's hot path.
  //
  // `localStorage.setItem` is SYNCHRONOUS and disk-backed, and this used to run on every pointer
  // event of a resize — hundreds of blocking writes per drag, on the main thread, interleaved with
  // the full Workspace re-render each width change already costs. The agent column's own strip has
  // always persisted on settle instead ("Persist once the drag settles rather than on every
  // intermediate pixel"); this is the same rule, applied to the boundary that lacked it. The
  // trailing write below lands ~200ms after the last change, so a drag writes once and the keyboard
  // path (which has no mouseup to hang a commit off) is covered by the same timer.
  //
  // `useCallback` is the second half: this function is `onWidth` on the pull tab, and the tab's
  // drag installs its window listeners in an effect keyed on that identity. Unmemoized, every
  // Workspace render — and the shell re-renders on EVERY projectStore write — tore the live drag's
  // mousemove listener down and re-added it mid-gesture.
  // DIRTY ONLY ONCE THIS INSTANCE HAS ACTUALLY MOVED A WIDTH — the guard `AgentSidebar` already
  // carries, and for the identical reason (roborev 55869). `Workspace` mounts in the SATELLITE window
  // too (it branches internally on `useIsMainWindow`), so its hooks run there and it registers the same
  // pagehide/beforeunload/visibilitychange trio. Without this, that untouched instance flushes its own
  // DEFAULT over the width the user set in the main window, and whichever webview fires last wins.
  // ONE REF PER WIDTH, not one for both. A shared flag means moving EITHER marks BOTH dirty, so the
  // teardown writes a key this instance never touched — and that destroys the very preference the CSS
  // clamp exists to preserve: a 900px left-pair width set on a big display is seeded down to the local
  // ceiling at mount, and then dragging only the CONCIERGE persists that reduced value over the 900
  // (roborev 55883). The satellite-window clobber is fixed either way; this cross-contamination is not.
  // DIRTY ONLY ONCE THIS INSTANCE HAS ACTUALLY MOVED A WIDTH — and PER KEY, not one flag for both.
  //
  // `Workspace` mounts in the SATELLITE window too (it branches internally on `useIsMainWindow`), so
  // its hooks run there and it registers the same pagehide/beforeunload/visibilitychange trio. Without
  // this guard that untouched instance flushes its own DEFAULT over the width the user set in the main
  // window, and whichever webview fires last wins (roborev 55869).
  //
  // A SET, keyed by pair count, because the two modes now store separately: dragging the concierge in
  // the cockpit must not mark the single-pair width dirty and write a 1920 over a 360 the next time
  // anything tears the tree down. A shared flag is exactly how one boundary comes to destroy a
  // preference it never touched (roborev 55883).
  const conciergeDirty = useRef<Set<1 | 2>>(new Set());
  const windowWidth = useWindowWidth();

  // THE BUILD COLUMNS' WIDTHS ARE NO LONGER MIRRORED HERE, and that removal is the point rather than
  // a tidy-up. This shell used to keep a copy of both, fed by `BUILD_WIDTH_EVENT`, for one reason:
  // the concierge's ceiling reserved `2 × max(left, right)` so a widened builder could never be
  // squeezed. That reserve is gone — it made widening ONE column silently un-widen another, which is
  // exactly what the founder asked to remove, and on a narrow window it drove the concierge's ceiling
  // onto its own floor and killed the seam outright. The reserve is now the shared 50px floors
  // (`conciergePairedReserve`), a constant, so there is nothing here to keep in step.
  //
  // `AgentSidebar` still EMITS the event; a consumer that needs live build widths can subscribe
  // without this shell paying a state update — and a re-render on the drag's hot path — for a value
  // nothing reads.

  // TWO PAIRS OR ONE — derived from the assignment map, never stored, so a count that disagrees with
  // what the map says is unrepresentable. Read HERE, above the width plumbing, because which key the
  // concierge reads and writes is a function of it.
  const projects = useProjectStore((s) => s.projects);
  const pairAssignment = useUiStore((s) => s.pairAssignment);
  const pairCount = pairCountFor(projects, pairAssignment);

  const conciergeWidth = conciergeWidths[pairCount];
  // `useCallback` is not decoration: this is `onWidth` on the pull tab, and the tab reads its config
  // through a ref precisely so a new identity cannot disturb a live drag — but a stable identity still
  // keeps the shell's own re-renders from churning anything downstream.
  const setConciergeWidth = useCallback((next: number) => {
    conciergeDirty.current.add(pairCount);
    setConciergeWidthsRaw((prev) => (prev[pairCount] === next ? prev : { ...prev, [pairCount]: next }));
  }, [pairCount]);

  // NOT PERSISTED PER PIXEL. `localStorage.setItem` is SYNCHRONOUS and disk-backed; the trailing write
  // lands ~200ms after the last change, so a drag writes once and the keyboard path — which has no
  // release to hang a commit off — is covered by the same timer.
  //
  // (Bead sparkle-fxzx claims a per-mousemove localStorage write on this seam. That was already false
  // when it was filed — this debounce and the flush trio below predate it — and it is doubly false
  // now that a drag commits once on release. Verified, then closed with that reason rather than
  // "fixed".)
  const conciergeWidthsRef = useRef(conciergeWidths);
  conciergeWidthsRef.current = conciergeWidths;
  useEffect(() => {
    if (!conciergeDirty.current.has(pairCount)) return;
    const id = setTimeout(() => {
      try {
        localStorage.setItem(conciergeWidthKeyFor(pairCount), String(conciergeWidths[pairCount]));
      } catch {
        // A width we cannot persist is a cosmetic loss; it must not take anything else with it.
      }
    }, 200);
    return () => clearTimeout(id);
  }, [conciergeWidths, pairCount]);
  // THE DEBOUNCE MUST FLUSH, or it is a way to LOSE a width rather than a way to write it less.
  // A trailing timer whose cleanup only cancels drops whatever the user just set if anything tears
  // the tree down inside the window — resize the seam (or nudge it with the arrows) and quit within
  // 200ms and the next launch restores the old width.
  useEffect(() => {
    // ALL THREE TEARDOWN SIGNALS, not just `pagehide` — which is the one this codebase never leans
    // on alone. A native window close in a Tauri/WKWebView destroys the webview outright, and React
    // does not unmount on process teardown, so hanging the quit path on a single event that may
    // never fire loses the width exactly as before. `projectStore` solves the identical problem with
    // this same trio, and `main.tsx` calls `beforeunload` "the pragmatic best-effort 'app closing'
    // hook in the webview". The effect cleanup covers a real React unmount; all read the ref, so
    // whichever fires first writes the latest committed width.
    const flush = () => {
      // EACH KEY ANSWERS FOR ITSELF, in its OWN `try`. Sharing one means a throw on the first write
      // (quota, storage disabled) silently skips the second, so a mode that did not fail loses its
      // width too — one failure taking out an unrelated write (roborev 55847).
      for (const count of conciergeDirty.current) {
        try {
          localStorage.setItem(conciergeWidthKeyFor(count), String(conciergeWidthsRef.current[count]));
        } catch {
          // A width we cannot persist is a cosmetic loss; it must not take the shutdown with it.
        }
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, []);
  // `projects` is read further up — the concierge's storage key depends on `pairCount`, which is
  // derived from it, so the width plumbing needs it before this point.
  const currentProjectId = useCurrentProjectId();
  const isMainWindow = useIsMainWindow();
  const currentWindowLabel = useCurrentWindowLabel();
  const openAgentIds = useRuntimeStore((s) => s.openAgentIds);
  const open = useRuntimeStore((s) => s.open);
  const reconcile = useRuntimeStore((s) => s.reconcile);
  const activeSpecial = useUiStore((s) => s.activeSpecial);
  const workModeBySide = useUiStore((s) => s.workModeBySide);
  const pinnedProjectId = useUiStore((s) => s.pinnedProjectId);
  // Resolve the pin DEFENSIVELY: it is persisted and load-bearing (it scopes the concierge vitals),
  // but a project can be deleted from another webview or a stale blob can name one that no longer
  // exists — and no tab renders for a missing project, so a dangling pin would silently zero the
  // concierge's surfaced P0/P1 with no affordance to clear it. Unknown id → "no pin".
  // (projectStore.removeProject clears the pin for the common case; this is the read-site backstop
  // for a stale persisted blob or a project that vanished through the cross-window merge.)
  const resolvedPinnedProjectId = useMemo(
    () => resolvePinnedProjectId(projects, pinnedProjectId),
    [projects, pinnedProjectId],
  );
  // Improve Sparkle is per-window: this window's own Sparkle copy is keyed by this id (the main
  // window keeps the canonical id, secondary windows get their own). See services/sparkleAgent.
  const sparkleAgentId = sparkleAgentIdFor(currentWindowLabel);
  const [settingsProject, setSettingsProject] = useState<Project | null>(null);
  const [closing, setClosing] = useState(false);
  const zoomIn = useUiStore((s) => s.zoomIn);
  const zoomOut = useUiStore((s) => s.zoomOut);
  const resetZoom = useUiStore((s) => s.resetZoom);

  // The cross-project status-band feed (CM-U3) drives BOTH the per-tab Needs-you glow and the concierge
  // column. Built ONCE here and passed down: two `useConciergeFeed`s meant two tray-roster fetches,
  // two roster listeners, two full recomputes per status tick — and two copies that could disagree
  // across render commits, so a tab badge and the vitals line could show different counts.
  const feed = useConciergeFeed({ pinnedProjectId: resolvedPinnedProjectId });

  // ⌘K history search (CM-U5). The controller owns the global binding; the overlay is fixed-position
  // so it can mount anywhere in the tree.
  const palette = useCommandPalette();

  // The hourly self-improvement pass clock (consent banner's "once per hour" promise). Main
  // window only — one scheduler per app, never one per window.
  useImprovementScheduler(isMainWindow);

  // On boot, drop any persisted open-agent ids whose agent no longer exists (e.g. deleted
  // between launches) so a resumed session can't reference a vanished agent (bead ).
  // projectStore hydrates synchronously from localStorage, so the first commit has the full set.
  useEffect(() => {
    // validIds MUST stay derived from ALL projects: openAgentIds is global (every tab's agents
    // live in it), so a project-scoped reconcile would evict other tabs' live PTYs.
    const validIds = projects.flatMap((p) => p.agents.map((a) => a.id));
    // The Sparkle agent is app-owned (never in a project's `agents`). Improve Sparkle is now
    // per-window, so the SHARED open set can hold several Sparkle ids at once (one per window, all in
    // the `__sparkle_self__` namespace) and reconcile() is a non-merging whole-array filter. The
    // whitelist rules are subtle (preserve other windows' LIVE ids, but prune dead per-window ids on
    // main's cold boot so the persisted set doesn't grow unboundedly) — see sparkleOpenSetWhitelist.
    const sparkleWhitelist = sparkleOpenSetWhitelist({
      isMainWindow,
      ownId: sparkleAgentId,
      openIds: useRuntimeStore.getState().openAgentIds,
    });
    reconcile([...validIds, ...sparkleWhitelist]);
    // If the Sparkle view was active at last quit, re-mount THIS window's pane so it resumes. Each
    // window has its own copy now, keyed by its own id — so this is correct in every window, not
    // just the main one.
    if (useUiStore.getState().activeSpecial === "sparkle") open(sparkleAgentId);
    // Otherwise, WARM the pane at launch when consent allows it (shouldWarmSparkleAtLaunch):
    // `open()` alone mounts the pane with visible=false, which spawns/resumes its claude session
    // behind the current view. Deliberately NOT paired with an activeSpecial change — warming must
    // never steal the user's view at startup; it only means that when they do open the row, the
    // agent is already up instead of cold-starting on the click.
    else if (
      shouldWarmSparkleAtLaunch({
        consent: useSettingsStore.getState().sparkleImprovementConsent,
        optIn: useSettingsStore.getState().improvementLaunchWarm,
        isMainWindow,
      })
    ) {
      open(sparkleAgentId);
    }
    // Run once on mount; the persisted open set is reconciled against the hydrated projects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep this window's project list in sync with changes made in other webviews (tray / capture).
  useEffect(() => subscribeToCrossWindowSync(), []);

  // Presence (Here | Away) — frontmost subscription + the idle tick. App-level, not concierge-level:
  // the signal is fed by TERMINAL keystrokes as much as by the compose box, and it must be current
  // the moment anything reads it, so it cannot wait on whatever the user happens to have on screen.
  // `startPresenceTracking` is ref-counted and returns an idempotent disposer, so a StrictMode/HMR
  // double-mount installs one ticker and one listener (stores/presenceStore).
  useEffect(() => startPresenceTracking(), []);

  // Start the orchestration listener singleton. The singleton guard in the listener prevents
  // double-registration under React StrictMode / HMR. An `unmounted` flag handles the race
  // where the component unmounts before the start promise resolves: if that happens we invoke
  // the cleanup immediately so the listener is always torn down exactly once.
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let unmounted = false;
    void startOrchestrationListener()
      .then((c) => {
        if (unmounted) c();
        else cleanup = c;
      })
      // Terminal catch: a start failure (e.g. the Tauri event bus is transiently unavailable
      // at boot) must not become a silent unhandled rejection — surface a diagnostic. No retry
      // here; the listener's singleton clears its start guard on failure so a later remount
      // re-arms it.
      .catch((e: unknown) => console.error("[orchestration] listener failed to start:", e));
    return () => {
      unmounted = true;
      cleanup?.();
    };
  }, []);

  // Start the app-level sparkle-control listener singleton (mirrors the orchestration listener
  // above, but is app-global — one control bridge shared by ALL agent kinds, not per-Build-agent).
  // Its own singleton guard makes this safe under StrictMode / HMR double-mount; the `unmounted`
  // flag tears it down exactly once if we unmount before the start promise resolves. Started here at
  // app boot — NOT per-pane — so the control surface exists regardless of whether any agent runs.
  //
  // MAIN-WINDOW ONLY: the control bridge is an app-level SINGLETON and Tauri emits "control:request"
  // app-globally, so a second app window would dispatch the same request twice — violating "reply
  // EXACTLY once per reqId". The shell is single-window now, which makes this gate a no-op in
  // practice; it stays as the belt-and-braces guard for the capture/tray webviews.
  useEffect(() => {
    if (!isMainWindow) return;
    let cleanup: (() => void) | undefined;
    let unmounted = false;
    void startControlListener()
      .then((c) => {
        if (unmounted) c();
        else cleanup = c;
      })
      .catch((e: unknown) => console.error("[control] listener failed to start:", e));
    return () => {
      unmounted = true;
      cleanup?.();
    };
  }, [isMainWindow]);

  // Reap orphaned per-window Sparkle worktrees left behind by the old multi-window shell: each
  // secondary window (`win-<uuid>`) cut its own Sparkle worktree, and those windows no longer exist,
  // so their worktrees would sit there forever. Sweep them on boot — once, from the app window,
  // which is now the only one. The canonical worktree is always preserved. Best-effort: a failure
  // just leaves stale dirs.
  useEffect(() => {
    if (!isMainWindow) return;
    void invoke("reap_secondary_sparkle_worktrees").catch((e) =>
      console.debug("reap_secondary_sparkle_worktrees failed", e),
    );
  }, [isMainWindow]);

  // Intercept the window's close (red traffic light) so we can ask keep-vs-kill before closing.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    // safeUnlisten awaits the listen() promise on cleanup so a handler that resolves AFTER unmount
    // is still torn down (and the Tauri teardown race is swallowed).
    const unlistenPromise = getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      setClosing(true);
    });
    return () => void safeUnlisten(unlistenPromise);
  }, []);

  // ── THE CABLE ───────────────────────────────────────────────────────────────────────────────
  // One value, read once, projected onto the shell root as `data-wired`. Every visual consequence
  // — the concierge taking the terminal's material, the seam vanishing at the wired boundary, the
  // far pair receding — is a CSS rule in index.css keyed off that attribute. MAPPING.md is explicit
  // that this must not become scattered component state, so this is the ONLY read of it in the
  // shell, and the rules themselves live in engine/cable.ts.
  const wired = useCableStore((s) => s.wired);
  const overlay = useCableStore((s) => s.overlay);
  const unbind = useCableStore((s) => s.unbind);

  // UNBIND GESTURE 1 — ESCAPE — lives BELOW, with the pair resolution it needs.
  //
  // It is the odd one out in this block and the displacement is deliberate: Escape is now a
  // two-step release whose SECOND step clears the active build row in each on-screen pair, so the
  // listener has to see `leftProjectId`/`rightProjectId`, which are resolved further down this
  // component. Find it beside them, under "ESCAPE — THE PROGRESSIVE RELEASE".

  /** WHEN an Escape-release sequence was armed — i.e. when an Escape unwired the cable — or null.
   *
   *  This is what makes the second rung reachable ONLY by a second Escape, instead of by every
   *  Escape pressed while nothing is patched (which is the app's default state — see the listener
   *  below, and roborev 55373). A ref rather than state on purpose: nothing renders from it, and a
   *  re-render between the two presses must not reset it.
   *
   *  A TIMESTAMP RATHER THAN A BOOLEAN, so the latch expires. It was a boolean, and the event-based
   *  clears turned out not to cover the case the feature is most about: xterm cancels propagation on
   *  every key it sends to the PTY, so a whole keyboard-only terminal session disarmed nothing
   *  (roborev 55491). `engine/cable`'s `releaseStillArmed` reads it. */
  const releaseArmedAtRef = useRef<number | null>(null);

  // UNBIND GESTURE 2 — clicking anywhere that is NOT a build agent row does the same thing.
  //
  // The SAME state change as Escape (engine/cable's `unbindCable`), which is why both call one
  // function rather than each setting the enum themselves.
  //
  // `pointerdown` in the CAPTURE phase, on `window`: the gesture has to survive handlers that stop
  // propagation (menus, the sidebar's own row press, drag starts), and it must land before the
  // click it precedes so the unbind and whatever the click does are not fighting over one frame.
  // Capture also means a row press is judged on where it STARTED, not on where a re-render left the
  // element — a row that unmounts under the pointer would otherwise read as "not a row" and unbind
  // the very cable the click just patched.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      // ANY pointer press ends an Escape-release sequence. Two reasons, and both matter: a press is
      // the user moving on to something else, so a later Escape is a fresh press rather than "the
      // second one"; and this gesture ALSO unbinds — arming from here would let a click-away make
      // the next Escape blank the terminal column, which is the very over-reach the latch exists to
      // prevent. Disarmed unconditionally, before the predicate, because a press that does NOT
      // unbind (on the wired row, inside Sparkle) is just as much "the user moved on".
      releaseArmedAtRef.current = null;
      // The in-terminal toll ends here too, and for the first of those reasons: a click is the user
      // moving on, so the next Escape inside a terminal is a first press again and belongs to the
      // process. (A click INTO a terminal is also what makes that terminal deliberate, so this is the
      // same press that starts the gesture — it must not arrive pre-paid.)
      clearTerminalEscapeToll();
      if (unbindsOnPointerDown(useCableStore.getState(), e.target)) unbind();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [unbind]);

  // Cmd +/- to resize the terminal text, Cmd 0 to reset (matches browser/editor
  // conventions). The size factor is applied to the terminal font only — see Terminal.tsx —
  // so the surrounding UI chrome (sidebar, tabs, buttons) stays fixed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        resetZoom();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomIn, zoomOut, resetZoom]);

  // ── THE TWO PAIRS ────────────────────────────────────────────────────────────────────────────
  // Which side each project lives on, and therefore which stage mounts its panes. Every rule is in
  // engine/pairs; this reads the map and applies them. See PAIR_COUNT's note for why the second
  // pair could not simply be rendered twice.
  const openProjectIds = useUiStore((s) => s.openProjectIds);
  // `pairAssignment` and `pairCount` are read further up — which key the concierge's width uses is a
  // function of the count, so the plumbing above needs it before this point.
  const leftProjectIdRaw = useUiStore((s) => s.leftProjectId);
  const prunePairAssignment = useUiStore((s) => s.prunePairAssignment);
  // Drop assignments for projects that are gone. Without this a removed project's entry keeps the
  // left pair open forever with no tab in it and no way to close it. In an effect (not render) so
  // it never sets state in another component mid-render; the derivations below already ignore
  // entries naming absent projects, so one commit of lag changes nothing on screen.
  useEffect(() => prunePairAssignment(projects), [projects, prunePairAssignment]);

  // "Only OPEN projects can be a pair's selection" lives inside `resolveSideProject` now, along with
  // the rest of that chain. The three memos that used to compose it here — open → on this side, twice
  // — went with it: leaving them would have kept a second, unused copy of the exact derivation this
  // consolidation exists to have only once, which is the divergence path it set out to close.
  // `pairCount` — two pairs or one, derived from the assignment map and never stored — is computed
  // with the width plumbing above, for the reason given there.

  // ── THE ROW'S ONE CEILING ──────────────────────────────────────────────────────────────────────
  //
  // There used to be three, chained: the left pair's, the concierge's (which depended on it), and the
  // painted mirror of each. There is one column with a stored width in the row now, so there is one.
  //
  // TWO MODES, TWO BUDGETS. The paired row reserves every OTHER column at the shared 50px floor plus
  // both rails — no longer the build columns' live widths, so widening a builder can no longer lower
  // this column's ceiling (the squeeze is absorbed by paint, and the stored widths spring back; see
  // `conciergePairedReserve`). The single-pair row keeps the shape of the arithmetic it shipped with,
  // now against the shared floor.
  const conciergeMax =
    pairCount === 2
      ? conciergePairedMax(windowWidth, CONCIERGE_MIN_WIDTH)
      : windowAwareMax(
          CONCIERGE_MAX_WIDTH,
          windowWidth,
          conciergeSingleRowReserve(),
          CONCIERGE_MIN_WIDTH,
        );
  // THE PAINT, BOUNDED WITHOUT TOUCHING THE PREFERENCE. A window that shrinks under an already-set
  // width brings the paint down on its own, the stored width is never rewritten, and re-widening
  // restores the width the user chose (roborev 55910). It is also what the pull tab drags FROM: a tab
  // handed the raw state starts its gesture at a width that is not on screen, going dead for the
  // difference and collapsing the stored preference on the first pointer-down (roborev 55948).
  const renderedConciergeWidth = Math.min(conciergeWidth, conciergeMax);

  // PUBLISH IT WHERE THE COLUMN READS IT. The drag writes this same custom property at pointer rate
  // with no React involvement; this is the other writer — the committed value, written after every
  // render that changes it. One target, so there is nothing to reconcile and no order to get wrong.
  useEffect(() => {
    publishColumnWidthVar(CONCIERGE_WIDTH_VAR, renderedConciergeWidth);
  }, [renderedConciergeWidth]);

  // Each side's selection, validated against what that side actually holds. The RIGHT pair keeps
  // using `selectedProjectId` — that value means "the current project" to the concierge feed,
  // notifications, capture and satellite ownership, and re-pointing it at a two-sided concept would
  // change all of them. The left pair gets its own slot.
  // Through `resolveSideProject` — the shared chain — rather than composing the four steps here. The
  // cable's projection hook needs the same answer, and when it composed them itself it composed them
  // WRONG (roborev 55490); one shared function is what stops the two disagreeing about which project
  // is on a side.
  const project = resolveSideProject("right", projects, openProjectIds, pairAssignment, currentProjectId);
  const leftProject = resolveSideProject("left", projects, openProjectIds, pairAssignment, leftProjectIdRaw);
  const rightProjectId = project?.id ?? null;
  const leftProjectId = leftProject?.id ?? null;
  // COMMIT THE RIGHT PAIR'S FALLBACK BACK TO THE STORE.
  //
  // `resolveSideSelection` is a local repair, so without this `selectedProjectId` and the project
  // actually on screen diverge indefinitely once the selected project moves to the left pair — and
  // `selectedProjectId` is what the rest of the app means by "the current project". Two observed
  // consequences (roborev 55149): the concierge feed lookup missed, so `isCalmBand(undefined)` read
  // CALM and desaturated a busy agent's terminal — the very regression `terminalCalm`'s note exists
  // to prevent; and the user could not click their way out, because the tab bar guards a re-click
  // against the RESOLVED id while the commit path guards against the STORE's, making the highlighted
  // tab a double no-op.
  const selectProject = useProjectStore((s) => s.selectProject);
  useEffect(() => {
    if (rightProjectId !== null && rightProjectId !== currentProjectId) selectProject(rightProjectId);
  }, [rightProjectId, currentProjectId, selectProject]);

  // ── ESCAPE — THE PROGRESSIVE RELEASE ────────────────────────────────────────────────────────
  //
  // Founder's ask, in two sentences: *"pressing Escape once detaches the concierge from the build
  // row"* — confirmed working — and *"pressing Escape AGAIN detaches the ACTIVE BUILD ROW itself.
  // After the second Escape there is no active build row at all, and the terminal column shows
  // nothing."* A third press does nothing rather than escalating further.
  //
  // ONE LISTENER, TWO RUNGS, AND RUNG 2 IS REACHABLE ONLY THROUGH RUNG 1.
  //
  // `releaseArmed` is the latch that makes that true, and it exists because the first version of
  // this was WRONG in a way worth spelling out (roborev 55373). That version fired rung 2 whenever
  // `wired === "off"`, reasoning that "not attached" means "the next thing to release is the row".
  // But `wired === "off"` is `CABLE_REST` — the app's DEFAULT — so it does not mean "you already
  // pressed Escape once", it means "no cable has ever been patched". Every Escape pressed anywhere,
  // at any time, blanked the terminal column. Escape is the most common key in an agent terminal
  // (vim, `less`, interrupting Claude Code) and `Terminal.tsx` lets it bubble, so the user would
  // have deselected the very agent whose terminal they were typing in.
  //
  // So rung 2 now requires POSITIVE EVIDENCE that a release is under way: it fires only on an
  // Escape that follows an Escape which actually unwired. That makes it strictly NARROWER than rung
  // 1 — the safe direction, since rung 1's reach is behavior the founder has already confirmed.
  //
  // THE LATCH IS CLEARED BY ANYTHING THAT IS NOT THE SECOND HALF OF THE GESTURE: rung 2 firing (a
  // third press finds it disarmed); any pointer press (the user moved on — and click-away unbinding
  // must not arm a rung the keyboard did not); any keydown that is not Escape *and that reaches this
  // listener*; and focus leaving the window. It also EXPIRES after RELEASE_ARM_WINDOW_MS.
  //
  // THAT LIST IS NOT EXHAUSTIVE AND MUST NOT BE READ AS SUCH — an earlier draft said it was, and the
  // gap was the surface this whole feature is about (roborev 55491). xterm's handler ends in
  // `CoreBrowserTerminal.cancel()`, which calls `preventDefault()` AND `stopPropagation()` for every
  // key it turns into a PTY sequence, so ordinary typing in a focused terminal never reaches a
  // `window` listener and clears nothing. A latch armed before an hour of keyboard-only work was
  // still armed after it. The EXPIRY is what closes that, and it is deliberately a wall clock rather
  // than one more event to subscribe to: it cannot be defeated by the next component that decides to
  // cancel its own keydowns.
  //
  // AUTOREPEAT IS EXCLUDED SEPARATELY, at the top of the handler. A held Escape delivers a second
  // keydown after the OS repeat delay, and that one is not a second decision by the user.
  //
  // RE-PATCHING THE CABLE IS *NOT* ON THAT LIST, and an earlier draft of this comment claimed it was
  // (roborev 55478). Nothing clears the latch on patch: `releaseArmedAtRef` is local to this component
  // and `cableStore.patch` never touches it. What actually keeps a stale latch harmless is the
  // `wired === "off"` term inside `clearsSelectionOnKey` — while a cable is patched, rung 2 cannot
  // fire at all, and the Escape that would unpatch it is rung 1. Patching by hand also goes through
  // a row press, which disarms. Do not relax that `wired === "off"` term on the belief that a
  // clear-on-patch is backing it up; there isn't one.
  //
  // WHY IT LISTENS ON `window`: the press that most needs to be heard is the one made while focus
  // is inside a terminal or the compose box, and a root-level React handler only sees what bubbles
  // through React's tree. NOT preventDefault'd and NOT stopped — Escape is a busy key, and this is
  // an additional meaning for it, not a claim on it.
  //
  // …AND ONLY WHEN NOTHING ELSE IS CLAIMING THE PRESS. Fifteen components treat Escape as "close
  // me", so with a cable patched one Escape aimed at a modal also unbound — two state changes for
  // one press (roborev 54697). That hazard is strictly worse on the second rung: emptying the
  // terminal column behind a dialog the user was only dismissing is a change they did not ask for
  // and cannot see happen. Both rungs are gated on the same reading, and rung 2 additionally
  // declines a press another handler has already claimed via `preventDefault` — several
  // Escape-owning surfaces (SelectionPopup, PinnedPrompt, the version popover) carry no dialog role
  // for the DOM probe to find, and `defaultPrevented` is the signal they do leave behind.
  //
  // BOTH PAIRS, NOT JUST THE CURRENT PROJECT. "No active build row AT ALL" is a statement about the
  // cockpit, and the cockpit shows up to two pairs; clearing only `rightProjectId` would leave the
  // left pair's row selected and its terminal populated, which is visibly not what was asked for.
  // Projects that are not on screen are deliberately left alone — deselecting them would lose the
  // user's place in a tab they never touched.
  //
  // THE VISUALS ARE NOT MINE. This wires the key handling and writes the state; how the cable, the
  // flood and the connector look at each step belongs to the agent that owns the cockpit chrome.
  // FOCUS PROVENANCE FOR TERMINALS, installed HERE rather than in `App` because this is its only
  // consumer — the Escape handler below. Co-located deliberately: with it mounted a level up, a
  // `<Workspace/>` rendered without `<App/>` had no tracker at all, so `terminalFocusWasDeliberate()`
  // was permanently false and the in-terminal gesture silently degraded to "Escape always unbinds".
  // That degradation is the SAFE direction, which is precisely why it would have shipped unnoticed.
  useEffect(() => installTerminalFocusIntentTracker(), []);

  useEffect(() => {
    const disarm = () => {
      releaseArmedAtRef.current = null;
      clearTerminalEscapeToll();
    };
    const onKey = (e: KeyboardEvent) => {
      // AN AUTOREPEAT IS NOT A SECOND PRESS. Holding Escape a beat too long delivers keydown #2 after
      // the OS repeat delay (~500ms, and configurable down to ~120ms on macOS); by then rung 1 has
      // unwired, so `unbindsOnKey` is false and the repeat fell straight through to rung 2 and blanked
      // the terminal column. Nothing could disarm in between, because the repeat IS an Escape
      // (roborev 55491). Skipped before the branch below so a held non-Escape key does not churn the
      // ref either. This is the one disarm rule that costs the user nothing at all.
      if (e.repeat) return;
      // ⌘⇧U — THE UNMOUNT THAT WORKS FROM INSIDE A TERMINAL.
      //
      // Escape no longer unbinds while the caret is in a terminal, because there it belongs to the
      // running program (see `voice/dictationFocus` and both cable predicates). That left no keyboard
      // way off the cable from a terminal, which matters now that clicking one patches it. This chord
      // is that way, and it is deliberately focus-BLIND: it does the same thing wherever the caret is,
      // so it cannot become another gesture whose meaning depends on where you happen to be.
      //
      // CHECKED BEFORE THE DISARM BRANCH BELOW, which returns early on any non-Escape key — a chord
      // handled after it would be swallowed by the very line that ends the release sequence.
      //
      // IT DOES NOT ARM RUNG 2, following the click-away precedent: the two-step ladder is an
      // Escape-Escape gesture, and letting ⌘⇧U arm it would mean a chord silently changed what the
      // NEXT Escape does, in a different part of the app, for reasons the user never sees.
      if (matchesChord(e, useKeybindingsStore.getState().bindings.unmountCable)) {
        if (useCableStore.getState().wired !== "off") {
          e.preventDefault();
          unbind();
        }
        releaseArmedAtRef.current = null;
        return;
      }
      // ANY OTHER KEY ENDS THE SEQUENCE — this is what gives the latch a LIFETIME.
      //
      // Without it the latch was cleared only by a pointer press, so "the second Escape" was not the
      // NEXT press, it was any later Escape, arbitrarily far away and in a different context: unwire
      // the cable, then keep working from the keyboard alone (typing in the composer or a PTY clears
      // nothing), and the next Escape — leaving insert mode in vim, dismissing `less`, interrupting
      // Claude Code — blanked the terminal column. That is the same destructive outcome the latch
      // exists to prevent, merely gated behind one earlier and unrelated press (roborev 55478).
      //
      // BARE MODIFIER PRESSES DISARM TOO, so tapping Shift between the two Escapes drops a release
      // the user did intend. That is the FAIL-CLOSED direction and it is the one to be wrong in: the
      // cost is pressing Escape once more, against emptying a terminal column nobody asked to empty.
      if (e.key !== "Escape") {
        releaseArmedAtRef.current = null;
        // The in-terminal toll expires on any other key for the same reason: typing between two
        // Escapes means the second is a fresh press, not the back half of a gesture. Note xterm
        // cancels propagation on keys it forwards, so most typing in a terminal never reaches here —
        // which is exactly why the toll is wall-clock bounded rather than event-cleared alone.
        clearTerminalEscapeToll();
        return;
      }
      // The SHARED probe — see `dismissibleSurfaceOpen`. Both Escape paths must ask the same question
      // with the same selector, or routing them through one predicate buys nothing.
      const dismissibleOpen = dismissibleSurfaceOpen(document);
      // DOES THIS ESCAPE BELONG TO THE TERMINAL ALONE? Three facts, combined by
      // `engine/terminalEscape` rather than here, so the precedence is unit-tested without a DOM:
      //
      //   - IN a terminal, read from the LIVE DOM at the instant of the press. Not a mirrored store
      //     value: leaving a terminal for a non-focusable target often raises no `focusin`, so a
      //     mirror goes stale in exactly the direction that hurts.
      //   - DELIBERATE, i.e. the user put the caret there rather than the pane's auto-focus. Without
      //     this term the guard was catastrophically over-broad: `AgentPane` parks the caret in the
      //     terminal whenever a pane is visible and ready, so "in a terminal" is the app's RESTING
      //     state and Escape-to-unbind became unreachable in the normal case.
      //   - SECOND PRESS. The founder's gesture: inside a terminal, one Escape is the process's, and
      const cable = useCableStore.getState();
      // RUNG 1 — unwire the concierge from the row it is patched into, and ARM the second rung.
      if (unbindsOnKey(cable, e.key, { dismissibleOpen })) {
        unbind();
        // ARM ONLY ON A PRESS NOBODY ELSE HAD ALREADY CLAIMED. Rung 2 declines a `defaultPrevented`
        // press; arming had to as well, or an Escape claimed by one of the surfaces the DOM probe
        // cannot see (SelectionPopup, PinnedPrompt, the version popover — no dialog role,
        // `preventDefault` only) would unbind AND arm, and the user's next Escape at that same
        // surface would clear the row. Unbinding still happens either way: rung 1's reach is
        // behavior the founder has confirmed, and only the ARMING is new (roborev 55478).
        releaseArmedAtRef.current = e.defaultPrevented ? null : Date.now();
        return;
      }
      // RUNG 2 — clear the active build row itself, in every pair on screen.
      const armed = releaseStillArmed(releaseArmedAtRef.current, Date.now()) && !e.defaultPrevented;
      if (
        !clearsSelectionOnKey(cable, e.key, {
          dismissibleOpen,
          releaseArmed: armed,
          // NEVER clear the build row while the caret is in a terminal, at any press count — see
          // `terminalBlocksSelectionRelease`. Gated on PRESENCE, not provenance: rung 1 needs
          // provenance so "Escape twice unmounts" works while the parked-caret ladder survives, but
          // nothing needs rung 2 reachable there, and blanking the column of the agent holding the
          // caret is the destructive outcome (roborev 55373/55722). Mostly belt-and-braces: an Escape
          // from a focused xterm never reaches this listener at all.
          terminalOwnsEscape: terminalBlocksSelectionRelease(focusOwnerNow() === "terminal"),
        })
      )
        return;
      // DISARM FIRST. A third press must find nothing to do, and that promise should not rest on
      // `selectAgent` happening to no-op on an unchanged selection — it should rest on this rung
      // being unreachable again until the user re-patches and presses Escape afresh.
      releaseArmedAtRef.current = null;
      const { selectAgent } = useProjectStore.getState();
      for (const id of [leftProjectId, rightProjectId]) {
        if (id !== null) selectAgent(id, null);
      }
    };
    window.addEventListener("keydown", onKey);
    // FOCUS LEAVING THE WINDOW ENDS THE SEQUENCE TOO. An Escape pressed after cmd-tabbing away and
    // back is a fresh press, not the back half of a gesture begun before the user left — and the
    // keydowns they made in the other app never reached this listener to disarm it.
    window.addEventListener("blur", disarm);
    document.addEventListener("visibilitychange", disarm);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", disarm);
      document.removeEventListener("visibilitychange", disarm);
    };
  }, [unbind, leftProjectId, rightProjectId]);

  // The window is titled "Sparkle", full stop — NOT the selected project's name.
  //
  // It used to name the project, on the theory that the macOS Window menu and dock tooltip should
  // name the work. That reasoning died with the project TAB BAR: the tabs already say which project
  // you're on, and much more precisely (they show every open project and which is selected, not
  // just the one name). All the title added was a second, redundant answer to a question already
  // answered on screen — and a confusing one, because a repo folder called e.g. "sparkle-desktop"
  // made the chrome read as a different app than the one the user launched.
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    // A rejection (e.g. window tearing down mid-call) must not surface as an unhandled rejection.
    getCurrentWindow().setTitle(WINDOW_TITLE).catch(() => {});
  }, []);

  const activeAgentId = project?.selectedAgentId ?? null;
  // The LEFT pair's selected agent — which of its panes is visible in its stage. Same rule as
  // `activeAgentId`, read off that pair's own project.
  const leftActiveAgentId = leftProject?.selectedAgentId ?? null;
  // WHICH PAIR THE CONCIERGE IS TALKING TO. `wired` is the whole answer, exactly as MAPPING.md
  // requires ("`data-wired` is the whole connection feature … do NOT implement it as scattered
  // component state"): patching the cable into a left build row means the compose box routes there.
  // Without this the left pair would be a second set of terminals the concierge could never reach —
  // the cable would light up and the prompt would still land in the right pair, which is the exact
  // "user-facing remedy that does the unsafe thing" shape AGENTS.md warns about.
  const wiredProject = wired === "left" ? leftProject : project;
  const wiredAgentId = wiredProject?.selectedAgentId ?? null;
  // WHAT THE SHELL DRAWS, from the ONE shared derivation (hooks/useEffectiveWired). It was a local
  // expression here for one commit, and `wired` has three readers — this root, the concierge column
  // via ConciergeHost, and the sidebar's row joint — so projecting it at one of them left the state
  // representable AND self-contradictory: the root said "off" while the column flooded and the rows
  // drew their joints open (roborev 55386).
  const shownWired = useEffectiveWired();
  // The agent the concierge compose box can prompt directly (CM-U7): the selected tab's selected
  // agent. This is what re-homes the removed AgentPane composer — with a target the box can send a
  // real prompt into a terminal instead of only chatting with the brain. Null → the box is
  // Sparkle-only, and its target toggle renders inert.
  // Only the TARGET is consumed now. `decidePromptTarget` also returns the honest `refusal` copy
  // ("Cloud agents take prompts in their own terminal for now"), which existed to explain a
  // DISABLED send-target toggle — and that toggle is gone (auto-routing, PRD §1). The refusal has
  // no surface left: a target that can't take input simply routes to Sparkle, where the reply is
  // recoverable, rather than sitting inert behind a tooltip. The decision function keeps returning
  // it so the reason is one edit away if a surface ever wants it again.
  // ══ THE IMPROVE-SPARKLE PANE IS THE FAR END OF THE CABLE (bead sparkle-0rf5) ══════════════════
  // When the Improve-Sparkle pane owns the shell, a concierge send belongs in ITS terminal, not the
  // pair's build agent — the pane's own composer was removed, so the concierge box is the only way
  // in. The Sparkle agent is app-owned and DELIBERATELY never a member of `project.agents`
  // (services/knownAgents), so it can only reach the compose box's target as an explicit special
  // case here; `decidePromptTarget` cannot resolve it through the roster lookup. `projectId` is ""
  // — the dispatcher keys a PTY by agent id ("PTY id === agent id", services/conciergeDispatch), and
  // this agent owns no project row.
  const sparkleTarget = useMemo(
    () =>
      activeSpecial === "sparkle"
        ? { projectId: "", agentId: sparkleAgentId, name: SPARKLE_AGENT_NAME }
        : null,
    [activeSpecial, sparkleAgentId],
  );
  const { target: promptTarget } = useMemo(
    () => decidePromptTarget(wiredProject, wiredAgentId, sparkleTarget),
    [wiredProject, wiredAgentId, sparkleTarget],
  );
  // Lets the empty-state start button create a build agent exactly like the sidebar's "+ New Build
  // Agent" row does (same hook → same behavior).
  // Runtime-aware (Local/Cloud toggle) — the same action the sidebar row runs.
  const spawnBuild = useNewAgent(project);
  const cloudCreateOpen = useUiStore((s) => s.cloudCreateOpen);
  const setCloudCreateOpen = useUiStore((s) => s.setCloudCreateOpen);
  // Cloud re-attach (Service B): a cloud session keeps running while the laptop is closed, so when
  // a project's tab is first selected we reconcile its tabs against the server's LIVE sessions and
  // recreate any that lost their tab. Best-effort and silent — signed out, offline, feature off, or
  // "this project has never run a cloud agent" all resolve to "created nothing" (see startup.ts).
  // Once per project per Workspace MOUNT (per session today — the shell never unmounts it), not
  // once per tab switch: in the tabbed shell `project` is the selected tab, so a last-id guard
  // would re-list on every A→B→A flip — and re-listing would also resurrect a cloud tab the user
  // deliberately removed while its server session was still live. Marked BEFORE the await so a
  // re-render can't double-fire, and un-marked when the attempt never got a useful answer (null:
  // auth still settling on a cold boot, offline) so a later attempt retries instead of the project
  // staying silently unreconciled until relaunch.
  //
  // AUTH IS IN THE DEPS, not just the project id (roborev 49295): the motivating null — "the token
  // hadn't landed yet on a cold boot" — resolves seconds later without anything about the project
  // changing. Keyed on the id alone, a user with ONE project (or who simply doesn't flip tabs) got
  // exactly one attempt and the un-mark had nothing to trigger it again, which made the retry a
  // no-op for the very case it was written for. Now the settling token IS the retry trigger.
  // The same gate every other cloud surface reads (services/cloudAgents/gating, via the hook) —
  // not a fourth hand-rolled copy of `tokenPresent && me?.cloudAgentsEnabled` (roborev 52648).
  const cloudAuthReady = useCloudAgentsEnabled();
  // …and CONNECTIVITY, because auth-settling is only half of what produces a retryable null. On an
  // offline cold boot for an already-signed-in user the persisted token rehydrates `tokenPresent`
  // true on the first frame, so `cloudAuthReady` never transitions and the un-mark had nothing to
  // fire it: a single-project user got exactly one attempt and stayed unreconciled until relaunch
  // (roborev 52648/52649). The offline→online transition is the trigger for that half.
  const online = useConnectionStore((s) => s.isOnline);
  const reattachedProjects = useRef<Set<string>>(new Set());
  useEffect(() => {
    const id = project?.id ?? null;
    if (!id || !cloudAuthReady || !online || reattachedProjects.current.has(id)) return;
    reattachedProjects.current.add(id);
    void reattachProjectOnOpen(id).then((r) => {
      if (r === null) reattachedProjects.current.delete(id);
    });
  }, [project?.id, cloudAuthReady, online]);
  // Files dropped on either "+ New Build Agent" button spawn a new build agent with the files
  // attached. Mounted here (not in a composer) so it also works when no agent exists yet — the
  // empty-state button has no pane to piggyback on.
  useNewBuildAgentDrop(project);

  // LAZY, STICKY pane mounting. The invariant is "don't kill the tab you LEFT" — which only needs
  // panes to stay mounted once visited, not every project's panes mounted before the user touches
  // those tabs. Mounting all of them at boot spawned N PTYs + `claude --resume` for every open agent
  // across every project (plus each pane's own effects: branch polling, alert episodes) on
  // a cold start. So: track the projects selected at least once this session — the set only ever
  // GROWS, which is exactly the no-unmount guarantee — and mount their open agents.
  // Updated during render (not in an effect) so a tab switch mounts its panes in the same commit,
  // with no frame where the newly-selected project shows its empty state.
  //
  // The user-visible cost, stated plainly: an agent left running in a project you have NOT opened
  // this session is listed as open (the sidebar and the concierge read the store) but has no PTY,
  // no live status and no attention notifications until you click that tab, at which point it
  // resumes. That is the trade for not spending a token on every project at every launch.
  // SINGLE SOURCE OF TRUTH (roborev 46351): the visited set lives in services/sessionProjects —
  // the same set the roster publisher reads — and this component subscribes to it rather than
  // mirroring it into React state. A mirrored copy diverged after a Workspace remount (HMR,
  // StrictMode, shell swap): the module set survived while the mirror re-seeded, so the publisher
  // reported projects whose panes weren't mounted. The set is deliberately never pruned when a
  // project leaves `projects` — a transient absence (a cross-window merge landing mid-render)
  // would unmount that project's panes, and a Terminal unmount KILLS its PTY. A stale id costs
  // nothing: the loop iterates `projects`, so an id naming no project matches nothing.
  const visitedVersion = useSyncExternalStore(onVisitedProjectsChange, visitedProjectsVersion);
  // Record the tab in an effect (a render-phase notify would set state in another component
  // mid-render; one commit of lag is irrelevant to a 250ms-debounced roster push). The CURRENT
  // tab is unioned in at render time below, so its panes still mount in the same commit.
  useEffect(() => markProjectVisited(currentProjectId), [currentProjectId]);
  // The left pair's project too — same reason, and it is the one the persisted assignment brings
  // back on a cold launch without ever passing through `currentProjectId`.
  useEffect(() => markProjectVisited(leftProjectId), [leftProjectId]);

  // Projects that have been pulled out into their own window (services/satelliteWindows). This is
  // the ONE subscription that has to be synchronous: the claim lands before the satellite window is
  // built, and main must drop those panes in the same commit — a Terminal unmount KILLS its PTY, so
  // if main were still holding them when the satellite mounts, both webviews would spawn an xterm
  // against the same agent id and `pty_spawn`'s `sessions.insert` would orphan one of the two child
  // processes. useSyncExternalStore (hooks/useTornOutProjects) gives that; a useEffect poll would
  // not.
  const tornOut = useTornOutProjects();

  const live: Array<{ project: Project; agent: AgentTab }> = useMemo(() => {
    const out: Array<{ project: Project; agent: AgentTab }> = [];
    // One Set for the whole nested loop: this memo re-runs on EVERY projectStore write (the file's
    // perf comment calls that the top render driver), so an O(projects × agents) scan with an
    // inner `includes` was a linear search per agent.
    const open = new Set(openAgentIds);
    for (const p of projects) {
      // Torn out → NOT ours to mount, even though it is visited and even when it is the selected
      // tab. This `continue` is the entire pane-ownership gate; see `tornOut` above for why letting
      // it slip costs a duplicated PTY rather than a duplicated pixel.
      if (tornOut.has(p.id)) continue;
      // BOTH PAIRS' SELECTIONS COUNT AS VISITED, not just the right one's.
      //
      // The visited set is module-level and NOT persisted, while `pairAssignment` and
      // `leftProjectId` ARE. Gate only on `currentProjectId` and a relaunch brings back a left pair
      // whose tab strip and sidebar are full of agent rows while `livePanes.left` is empty — a blank
      // stage, with the `!leftProject` hint not firing because `leftProject` resolves fine. Clicking
      // rows cannot repair it: this gate is per PROJECT, so `openAgentIds` never gets a say. That is
      // the "zero mounted → dead terminals under a live tab" half of the invariant engine/pairs
      // claims to make unrepresentable (roborev 55149).
      if (!wasProjectVisited(p.id) && p.id !== currentProjectId && p.id !== leftProjectId) continue;
      for (const a of p.agents) {
        if (open.has(a.id)) out.push({ project: p, agent: a });
      }
    }
    return out;
    // visitedVersion is the subscription token for the module set read via wasProjectVisited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, openAgentIds, visitedVersion, currentProjectId, leftProjectId, tornOut]);

  // WHERE EACH PAIR'S PANES ARE DISPLAYED — the DOM node, not a slice of the list.
  //
  // `live` is rendered ONCE, by a single `AgentPaneList` below, and each pane portals into the stage
  // its side owns (see `PaneHost`). So this is not the old partition under another name: there is
  // one mount site, and these are the two destinations it can portal to. `null` for the left while
  // `pairCount` is 1 and that stage is not on screen.
  //
  // State rather than a ref because the list has to RE-RENDER when a stage appears — a ref would
  // hold the node with nothing to tell the portals about it, and the left pair would come up empty
  // until some unrelated write happened to re-render the shell.
  const [leftStage, setLeftStage] = useState<HTMLElement | null>(null);
  const [rightStage, setRightStage] = useState<HTMLElement | null>(null);
  // Is the tab the user is looking at one whose columns now live in another window?
  const selectedIsTornOut = !!project && tornOut.has(project.id);
  // WHICH projects have a re-dock in flight (the ask-then-force handshake in
  // services/satelliteWindows). A SET, not a bare boolean and not a single slot — both simpler
  // shapes are wrong with up to four satellites. A boolean disabled "Bring it back here" on every
  // other torn-out tab, blocking the only recovery path for a project whose reclaim was not even
  // running. A single slot was bypassable the other way: start p1, start p2, then p1 settles (or
  // times out after REDOCK_TIMEOUT_MS) and clears the slot, re-enabling p2's button while p2's
  // reclaim is still in flight — a second click then starts a second reclaim, which is the double
  // force this state exists to prevent.
  const [reclaimingIds, setReclaimingIds] = useState<ReadonlySet<string>>(() => new Set());
  const startReclaim = (id: string) => {
    if (reclaimingIds.has(id)) return;
    setReclaimingIds((prev) => new Set(prev).add(id));
    void reclaimProject(id).finally(() =>
      setReclaimingIds((prev) => {
        // Remove only the id that finished — never replace the whole set.
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      }),
    );
  };
  // Columns ② + ③ belong to the satellite while it holds the project, so the sidebar renders EMPTY
  // rather than listing agents whose panes are somewhere else — clicking one here would select an
  // agent that this window has no terminal for.
  const sidebarProject = selectedIsTornOut ? null : project;

  // Crash/force-quit backstop. A satellite that died without releasing leaves its project owned by
  // a window that no longer exists, and nothing would ever render it again. Reconcile when main
  // regains focus — the moment a user who just force-quit a satellite comes back to look for it.
  // Also once at mount, for the case where the crash happened while main was already focused.
  useEffect(() => {
    void reconcileSatellites();
    const onFocus = () => void reconcileSatellites();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  const activeIsOpen = activeAgentId !== null && openAgentIds.includes(activeAgentId);
  // Improve Sparkle keeps its own pane slot (activeSpecial lives in uiStore, the pane is keyed by
  // this window's sparkleAgentId).
  const sparkleActive = activeSpecial === "sparkle";
  const sparkleOpen = openAgentIds.includes(sparkleAgentId);
  // The read-only Tasks board (bead sparkle-hiju.10) is the Plan view. Only meaningful with a
  // project open, and only when the Beads tool ([tools].beads) is enabled — off means the board is
  // used nowhere (the Plan chevron hides and mode reconciles away from it).
  const beadsEnabled = useSettingsStore((s) => s.beadsEnabled);
  // ONE QUESTION, ASKED ONCE PER COLUMN — with that column's own mode and its own project. These
  // two booleans are independent by construction, which is the fix: both pairs can hold different
  // boards open at the same time, and neither can close or overwrite the other's.
  // `&& !sparkleActive` RESTORES AN INVARIANT THE SPLIT REMOVED. The board and the Improve-Sparkle
  // pane used to be two values of ONE enum, so they were mutually exclusive by construction —
  // setting either cleared the other. They are independent state now, and both render into this
  // same stage, so without this the Sparkle pane mounts INVISIBLY BEHIND the board (it paints at
  // TERMINAL_PANE_Z, the board at PLAN_COLUMN_Z) and clicking Improve Sparkle from the board looks
  // like it did nothing. Gating the RENDER rather than forcing the column out of Plan keeps the
  // user's Plan choice: leaving Sparkle brings their board back.
  const boardActive = planBoardUp(workModeBySide.right, !!project, beadsEnabled) && !sparkleActive;
  const leftBoardActive = planBoardUp(workModeBySide.left, !!leftProject, beadsEnabled);

  // Is the selected agent actually ON SCREEN? `project.selectedAgentId` stays non-null while the
  // Plan board or the Improve Sparkle pane is showing, and while the agent's tab isn't open at all.
  //
  // This gates ROUTING, not the suggestions engine — the concierge needs both facts and they are
  // deliberately separate (see ConciergeHost's promptTarget/targetShown props). Under the old
  // target toggle the slack was harmless: the user had to flip a control to aim, so a stale
  // selection could never receive anything by itself. The router infers "there is a build agent in
  // view" from this, so ungated it would write an imperative typed while looking at the board into
  // a terminal the user cannot see. See PRD/sparkle/concierge-auto-routing.md §2.
  // When the Improve-Sparkle pane is the active surface it IS what the user is looking at, so a send
  // routes into its terminal (bead sparkle-0rf5). This is the SAME guard that stops an imperative
  // typed at the Plan board from landing in an unseen terminal — it now admits the sparkle pane
  // BECAUSE it is on screen, gated on `sparkleOpen` so a mount whose PTY has not come up yet still
  // routes to the brain (recoverable) rather than a terminal that isn't there.
  const promptTargetShown = sparkleActive ? sparkleOpen : !boardActive && activeIsOpen;

  // Calm terminal (PRD §3 / prototype `.terminal.calm`): when the agent you're looking at has
  // nothing for you, its terminal TEXT desaturates, so only a screen that wants something from you
  // carries color. Read from the same feed the tabs and the concierge use, so "calm" means one
  // thing app-wide.
  //
  // This is now the ONLY calm treatment. It used to run alongside a matching one in the sidebar —
  // a `grayscale(1) opacity(.72)` filter over any row this same predicate called calm — which was
  // removed on 2026-07-27 because `working` is in the calm set, so it desaturated the status dot of
  // every agent that was actually running. Do not restore a row filter here or there; the sidebar
  // carries status by DOT COLOR now. See services/conciergeFeed.isCalmBand for the full note.
  //
  // It asks `isCalmBand(status)` and not the agent's status BAND. Those are different sets by
  // design and `unmerged` is the difference: it bands `done` (it must not buy a nudge card) but is
  // NOT calm (unlanded work is exactly what you should still see). Reading the band here meant
  // selecting an unmerged agent desaturated its terminal while its sidebar row stayed fully colored
  // — the two surfaces disagreeing about the one status the split exists to protect.
  //
  // Only ever true for a VISIBLE AGENT PANE (roborev 46254-M1). It used to default to `true` with
  // no agent selected and ignore the overlays, while the treatment was a `filter` on the whole
  // stage — so a brand-new user's onboarding screen ("Welcome to Sparkle", the teal + New Build
  // Agent button, "Press ⌃ Ctrl to take a tour") rendered fully grayscale, and the Improve-Sparkle
  // pane grayed and ungrayed according to the priority of a hidden build agent it has nothing to do
  // with. The desaturation now rides the terminal's own theme (AgentPane → Terminal → xtermTheme),
  // which also keeps it off the WebGL canvas's per-frame composite path.
  const terminalCalm = useMemo(() => {
    if (sparkleActive || boardActive || !activeAgentId || !activeIsOpen) return false;
    // Keyed off the RESOLVED project, not `currentProjectId`: the two differ for a commit after the
    // selected project moves pairs, and a miss here reads as CALM and desaturates a busy terminal.
    const p = feed.projects.find((x) => x.id === project?.id);
    // An agent the feed doesn't know reads `undefined`, which isCalmBand treats as calm — the same
    // answer the old `?? 2` default gave.
    return isCalmBand(p?.agents.find((a) => a.id === activeAgentId)?.status);
  }, [feed, project, activeAgentId, activeIsOpen, sparkleActive, boardActive]);

  // THE PANE LIST'S PROPS, HOISTED OUT OF THE RENDER so `MemoAgentPaneList` can actually bail out.
  // Object literals inline at the call site are a fresh identity every render, which on a seam drag is
  // every pointer event — one `PaneHost` + `Suspense` + `ErrorBoundary` + `createPortal` per open pane,
  // times ~30 events a drag (roborev 55316). The leaf render counter could not see it, because it sits
  // inside the memo `arePanePropsEqual` already bails out of; the comparator call count can.
  //
  // `visibleAgentId` keeps main's PER-SIDE board logic — a column showing its board has no visible
  // agent pane, and the left can have a board now — it is only the identity that is stabilised here.
  const paneStages = useMemo(() => ({ left: leftStage, right: rightStage }), [leftStage, rightStage]);
  const paneVisibleAgentId = useMemo(
    () => ({
      left: leftBoardActive ? null : leftActiveAgentId,
      right: sparkleActive || boardActive ? null : activeAgentId,
    }),
    [leftBoardActive, leftActiveAgentId, sparkleActive, boardActive, activeAgentId],
  );
  const paneCalm = useMemo(() => ({ left: false, right: terminalCalm }), [terminalCalm]);

  // NO PLAN/BUILD HANDLERS HERE ANY MORE. The board used to render its own duplicate of the
  // segmented toggle, because it covered the build column and took its header away with it. It
  // takes only the TERMINAL's slot now, so the sidebar's own toggle stays on screen and is the one
  // way back to Build — with the richer "land on the first rendered row" logic this copy was
  // shadowing (AgentSidebar.onPickBuild).

  // Only computed while the prompt is up (it's the prompt's copy), but a plain call is cheaper than
  // the memo that would guard it.
  const closeScopeNames = closing
    ? closeScopeProjectNames(projects, openAgentIds, project?.id ?? null)
    : [];

  const finishClose = async (mode: "keep" | "kill") => {
    // Dismiss the prompt immediately so a second click on Keep/Kill (the handler awaits below)
    // can't re-enter this flow.
    setClosing(false);
    const win = getCurrentWindow();
    // "Keep agents running" keeps PTYs alive only while the app PROCESS lives, so the app window is
    // hidden (not destroyed) to keep the process — and thus every project's kept agents — alive.
    // "Kill … & close" quits, which necessarily stops them all (standard app-quit semantics).
    const all = await getAllWindows();
    const plan = planWindowClose(mode, all.length <= 1, isMainWindow);
    // "Stop the agents" means every project's RUNNING agents, not just the selected tab's: one
    // window hosts every project now, and leaving the others open in the runtime means the next
    // launch resumes them all. It stops them — it does not delete agents (see windowClose.ts).
    if (plan.killAgents) await killAllOpenAgents(projects, openAgentIds);
    // Keep the registry mapping when only hiding, so a later open can find and reveal the hidden
    // window (the Rust RunEvent::Reopen handler re-shows it on Dock click).
    if (plan.clearRegistry) {
      clearWindowProject(currentWindowLabel);
      clearWindowRoster(currentWindowLabel);
    }
    if (plan.hide) await win.hide();
    else await win.destroy();
  };

  return (
    <div
      // THE SHELL ROOT — `.shell` in the mock, and the one element the cockpit's state hangs off.
      // `data-pairs` and `data-wired` are the entire state surface (MAPPING.md's State table); the
      // CSS in index.css reads them and everything visual follows. `data-over` is the mock's
      // overlay state, carried here for the same reason: one attribute, no second copy.
      //
      // `data-testid` is also the visual-fidelity harness's selector hook (scripts/visual/). Two
      // agents added it independently and for the same reason — nothing else in the tree identified
      // this div — which is a fair sign it belongs here. Marker only: no styling, no behaviour.
      className="shell"
      data-testid="workspace-shell"
      data-pairs={String(pairCount)}
      data-wired={shownWired}
      data-over={overlay}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        width: "100vw",
        // Depth layer 0 — the app ink behind everything (PRD §3: Sparkle lightest → builder →
        // terminal darkest; the shell itself sits below all three).
        background: C.deepForest,
        color: C.cream,
        fontFamily: FONT_UI,
      }}
    >
      {/* Spans the very top of the app, just below the window chrome, above everything else.
          Offline sits ABOVE out-of-credits on purpose: when both are up, connectivity is the more
          urgent (and the more likely) explanation for AI features misbehaving, and a top-up can't
          be bought without a network anyway.

          These stay OUTSIDE the pairs. A pair is one project; an offline banner is a statement
          about the machine, so it spans the window rather than living above one project's columns
          (with two pairs it would otherwise have to be drawn twice, saying the same thing). */}
      <OfflineBanner />
      <ZeroCreditBanner />
      {/* Below both on purpose. Offline and a $0 balance are things the USER can act on, so they
          lead; this one they cannot act on at all. It is here rather than nowhere because the
          alternative — what shipped before — was every AI feature going dark with no explanation
          anywhere for 12 hours. Renders only while an outage is actually recorded. */}
      <ProviderUnavailableBanner />
      {/* Sibling of ProviderUnavailableBanner for the outage the server does NOT name: a SUSTAINED
          run of bare gateway/transport failures (the live 12-hour 502 incident). Detector is
          non-flappy — a lone blip never lights it — and it clears on the first successful call.
          Dismissible, unlike the provider banner, because the retry path keeps working underneath. */}
      <AiServiceBanner />
      {/* NO FULL-WIDTH PROJECT TAB STRIP. `main` still renders one here across the whole window.
          The cockpit moves it: tabs belong to the PAIR, because a pair IS one project (build and
          its terminal), and they must never sit above the concierge — which is cross-project by
          definition and would be claimed by whichever tab happened to be active. Each `Pair`
          renders its own strip; see the `tabs` prop below. Taking main's line back would put a
          second, contradicting tab bar above the whole shell. */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* THE LEFT PAIR — the other half of `TERM │ BUILD │ CONCIERGE │ BUILD │ TERM`.
            Rendered only when something is assigned to it, so an install that has never used it
            gets byte-identical layout to the single-pair shell. `Pair` mirrors the flow, so the
            children are given in the SAME [build, terminal] order as the right pair and the
            terminal ends up outboard.

            It carries no Sparkle pane and no onboarding hints: those really are single surfaces
            that belong to the primary (right) pair, and duplicating them would put two of each on
            screen with no way to say which one a click meant.

            IT DOES CARRY ITS OWN PLAN BOARD, and that sentence used to include one — which was the
            bug, not the design. The board is per-PROJECT and per-COLUMN, so "which one did a click
            mean" has an obvious answer (the column you clicked in); it is not a single surface the
            way the Sparkle pane is. See PlanBoardSlot. */}
        {pairCount === 2 && (
          <Pair
            // ELASTIC, exactly like the right pair — see `Pair`'s own note. This is the half of the
            // change that makes the concierge centred: two `flex: 1 1 0` halves divide the row's free
            // space equally, so the column between them is dead centre for free, at every window
            // width, with no arithmetic anywhere in this file.
            side="left"
            wired={wired === "left"}
            tabs={
              <MemoProjectTabsBar
                side="left"
                feed={feed}
                onOpenProjectSettings={setSettingsProject}
              />
            }
          >
            {/* `slotSide` because `leftProject` is null whenever this pair's tab is closed, and a
                column with no project cannot ask the assignment map which side it is on. */}
            <MemoAgentSidebar project={leftProject} slotSide="left" covered={leftBoardActive} />
            {/* NO `AgentPaneList` HERE. The panes are mounted once, elsewhere, and portalled in —
                this stage contributes the destination (`ref`) and nothing else, which is what keeps
                a project moving to the other pair from unmounting its terminals. See `PaneHost`. */}
            <div
              ref={setLeftStage}
              data-testid="terminal-stage-left"
              data-calm="false"
              style={{ flex: 1, position: "relative", minHeight: 0, background: C.forest }}
            >
              {!leftProject && (
                <Hint title="Nothing here yet">
                  Pick a project in the tab strip above, or move one across with{" "}
                  <strong>Move to the left pair</strong> in its build column header.
                </Hint>
              )}
            </div>
            {/* THE LEFT PAIR'S OWN PLAN BOARD — a THIRD child of the pair, and that placement is
                the point. This pair used to carry none at all (which is why pressing Plan here
                opened the board on the right), then carried one INSIDE the stage above (which is
                why the build column beside it went blank). As a sibling of both columns it lays
                over the pair's whole `paircols` box: absolutely positioned, so it is not a flex
                item and the two columns underneath keep their widths. Its project is its own;
                nothing about it is shared with the right pair's board. */}
            {leftBoardActive && leftProject && <PlanBoardSlot project={leftProject} side="left" />}
          </Pair>
        )}
        {/* ① The persistent cross-project concierge column. Unconditional — the concierge IS the
            experience now, not a flagged addition to the old UI.

            `data-concierge-root` marks it as part of the LIVE CIRCUIT (engine/cable.ts). Without
            it, the unbind gesture read every press inside Sparkle — the compose box, Send, the
            thread — as "outside", so patching in and then typing to the agent you just patched
            into dropped the cable on the very first click. */}
        {/* OUTSIDE `data-concierge-root`, deliberately. `<style>` is `display: none` so it is not a
            flex ITEM, but it is still a CHILD, and the row's structure is read by position — the box
            must have a rail immediately either side of it. Keeping this out of that group means
            nothing has to special-case it. */}
        <style>{`[data-concierge-box] > section{width:100% !important}`}</style>
        <div data-concierge-root style={{ display: "flex", minHeight: 0 }}>
        {pairCount === 2 && (
          <ColumnPullTab
            // IT OWNS THE CONCIERGE NOW, NOT THE LEFT PAIR — this is "I want to drag out from the
            // middle". The old rule was "one boundary owns the column on its own left", which made
            // this seam move the LEFT PAIR: the concierge kept its width and slid sideways as a rigid
            // block, so no gesture in the app could grow it leftward at all.
            //
            // `grows="right"` because the column this seam owns is on its RIGHT, so dragging LEFT —
            // outward — grows it. `widthPerPx={2}` is the symmetry: the edge moves dx, the column
            // gains 2·dx, and stays centred. Both seams commit the SAME width, which is why pulling
            // either one grows both sides.
            width={renderedConciergeWidth}
            onWidth={setConciergeWidth}
            min={CONCIERGE_MIN_WIDTH}
            max={conciergeMax}
            grows="right"
            widthPerPx={2}
            cssVar={CONCIERGE_WIDTH_VAR}
            label="Sparkle column"
            testId="left-pair-pull-tab"
            // JOINED ONLY WHEN THE LEFT PAIR HOLDS THE CABLE. This rail is the concierge's LEFT
            // boundary, so it is the one the left pair's mounted row runs into.
            seamFill={shownWired === "left" ? C.forest : undefined}
          />
        )}
        {/* ── THE CONCIERGE'S BOX IS OWNED BY THE SHELL, NOT BY THE COLUMN ────────────────────────
            The column's width has to be paintable WITHOUT a React render, or the drag cannot come
            off React state — that is the whole point of `--concierge-w`. But `ConciergeColumn` takes
            its width as a NUMBER and writes it as an inline style, and that file belongs to another
            worker this pass. An inline style also beats any stylesheet rule on specificity, so the
            variable cannot simply win.

            So the shell owns the BOX — this div, sized by the variable — and the one rule below
            neutralises the column's own width so it fills whatever box it is given. `!important` is
            load-bearing here for exactly the specificity reason above; it is not decoration, and it
            is scoped to a single element inside a single wrapper.

            THE RAILS ARE SIBLINGS OF THIS BOX, NEVER CHILDREN. The box is the width-bearing element
            (`width: var(--concierge-w)`, and the rule below makes the column fill it), so anything
            else inside it is width the column does not get. The left rail WAS inside, and the result
            was the exact defect this whole change exists to remove: 6px of rail plus a column forced
            to 100%, neither shrinkable, inside a box of C — so the concierge overflowed by a rail and
            painted 3px right of true centre, with its last 6px under the right rail (roborev 56086).
            `cockpitGeometry` models both rails OUTSIDE the concierge; the DOM has to agree.

            THE HONEST FIX is one line in `ConciergeColumn`: accept a CSS length instead of a number,
            and this whole block plus its rule disappears. Left as a note rather than done, because
            reaching into a concurrently-owned file to save three lines is how two agents produce the
            same conflict twice. */}
        <div
          data-concierge-box
          data-testid="concierge-box"
          style={{
            flex: "0 0 auto",
            display: "flex",
            minWidth: 0,
            // THE FALLBACK IS THE COMMITTED WIDTH, so the very first paint — before any effect has
            // run and before any drag — is already correct rather than zero-width.
            width: `var(${CONCIERGE_WIDTH_VAR}, ${renderedConciergeWidth}px)`,
          }}
        >
        <ConciergeHost
          width={renderedConciergeWidth}
          feed={feed}
          promptTarget={promptTarget}
          promptTargetShown={promptTargetShown}
          searchSlot={<PaletteTrigger onOpen={palette.openPalette} />}
          // The palette is the only surface that renders `historyStore`, so "See what it did" on a
          // closed agent's pill has to open it — seeding the query alone would paint nothing.
          onOpenHistory={palette.openPalette}
        />
        </div>
        {/* THE CONCIERGE BOUNDARY IS DRAGGABLE NOW. This column shipped at a hardcoded 360 with no
            way to move it, while the agent column beside it had a full resize strip — so of the
            shell's two vertical seams, one was adjustable and the other was a wall. Same control,
            same keyboard contract, and the 2×3 dot grip that fades in on hover; see
            ColumnResizeTab for why the grip is hidden at rest and why it cannot take pointer
            events. */}
        <ColumnPullTab
          // THE RENDERED WIDTH, NOT THE STORED ONE — the gesture has to start from what is on screen.
          // `ColumnPullTab` records `origin = { x, width }` at mousedown and commits
          // `clampWidth(origin.width + dx)`, so handing it a width above `max` makes the seam DEAD for
          // exactly `conciergeWidth - conciergeMax` px of travel, reports an out-of-range
          // `aria-valuenow`, and collapses the stored preference to the ceiling on the first
          // pointer-down — destroying the very width `renderedConciergeWidth` exists to preserve
          // (roborev 55948). Paint, gesture origin and ARIA range all read the same number now.
          width={renderedConciergeWidth}
          onWidth={setConciergeWidth}
          min={CONCIERGE_MIN_WIDTH}
          // WINDOW-AWARE, like every other seam in the row. A bare 560 here let this one column be
          // dragged over the primary pair on a narrow window — see `conciergeSingleRowReserve` and
          // `conciergePairedMax`.
          max={conciergeMax}
          // SYMMETRIC ONLY WHEN THERE ARE TWO EDGES TO BE SYMMETRIC ABOUT. With one pair the concierge
          // is pinned to the row's left and has no left edge to grow from, so doubling the travel
          // would just make this seam twice as fast for no reason — and that layout is the one that
          // must not change.
          widthPerPx={pairCount === 2 ? 2 : 1}
          cssVar={CONCIERGE_WIDTH_VAR}
          label="Sparkle column"
          testId="concierge-pull-tab"
          // THE SEAM THE FOUNDER HAS REPORTED FIVE TIMES, in the single-pair cockpit: this rail is
          // the concierge's RIGHT boundary and therefore the right pair's joint.
          //
          // `shownWired`, not the raw `wired`: it is the same derivation the concierge column paints
          // its flood from (`hooks/useEffectiveWired`), so the fill cannot appear while the column
          // beside it is still drawing itself unplugged — the shell-contradicts-itself failure
          // roborev 55386 and 55490 are both about.
          //
          // `C.forest` is the CSS var `--c-forest`, i.e. `BLUEPRINT[mode].term` — the exact token the
          // concierge floods with and the row paints in. Reading the same token is what makes the
          // three surfaces provably one plane in BOTH themes rather than three colours that happen to
          // match in dark.
          seamFill={shownWired === "right" ? C.forest : undefined}
        />
        </div>
        {/* THE PAIR — build + its terminal, one project, never split, with its OWN project tabs.
            The single-pair cockpit is the right half of `TERM │ BUILD │ CONCIERGE │ BUILD │ TERM`,
            so this pair is `data-side="right"`: build adjacent to the concierge, terminal outboard.
            Children are always [build, terminal]; `Pair` mirrors the flow for a left pair. */}
        <Pair
          side="right"
          wired={wired === "right"}
          tabs={<MemoProjectTabsBar side="right" feed={feed} onOpenProjectSettings={setSettingsProject} />}
        >
          {/* ② Builder agents. The sidebar owns the Plan/Build toggle as its header in BUILD mode;
              in Plan the board is painted over this whole column and carries its own, so this one
              goes unreachable rather than merely invisible — see AgentSidebar's `covered`. */}
          <MemoAgentSidebar project={sidebarProject} covered={boardActive} />
          {/* ③ The terminal stage. Darkest layer; the selected agent row docks into it (the row
              paints in C.forest too, so the join is seamless).

              NO `filter` here. Calm is the visible pane's own text color (see terminalCalm above):
              a filter on this container would (1) re-composite the WebGL canvas every frame of
              streaming output, (2) gray the onboarding empty states and the Sparkle pane along with
              it, and (3) — being a non-`none` filter — make this div a containing block for
              `position: fixed` descendants, which silently shrank the AccountBadge's full-screen
              click-away backdrop to the stage (roborev 46254). `data-calm` stays: it is what the
              shell tests read. */}
          <div
            ref={setRightStage}
            data-testid="terminal-stage"
            // Files dropped anywhere on the stage attach to the VISIBLE agent's next message
            // (hooks/useTerminalDrop). Tauri's drag events are window-global and carry no target
            // element, so this marker is what the hit-test resolves against (services/dndTargets).
            data-dnd-target={TERMINAL_STAGE_DND_TARGET}
            data-calm={String(terminalCalm)}
            style={{
              flex: 1,
              position: "relative",
              minHeight: 0,
              background: C.forest,
              // NO `isolation: isolate` HERE, and it is worth saying why, because it looks like the
              // tidy answer to "contain the stage's own high z-indices". It also DEMOTES the whole
              // subtree to layer 0 — including the full-window `position: fixed` surfaces that are
              // supposed to escape this stage. `composer/ModalOverlay` (fixed, inset 0, zIndex 1000)
              // and AgentPane's click-away backdrop both live in panes inside here and are meant to
              // cover column ①; isolated, they lose to any `z-index: 1` descendant of the concierge
              // column, so the dim backdrop gets punched through by the compose box and the
              // click-away stops dismissing. The sidebar's overlay panel clears this stage by
              // out-numbering it instead — see components/layers.ts.
            }}
          >
            {/* The panes portal in here — see the single `AgentPaneList` at the end of the shell. */}
            {sparkleOpen && (
              <Suspense fallback={<PaneFallback />}>
                <SparkleAgentPane visible={sparkleActive} agentId={sparkleAgentId} />
              </Suspense>
            )}

            {!sparkleActive && !boardActive && !project && (
              <Hint title="Welcome to Sparkle">
                Open a project with the <strong>+</strong> in the tab bar and choose a folder on your
                Mac to start building.
              </Hint>
            )}
            {/* The project is in its own window. Say so plainly and offer both ways out — raise
                that window, or take it back — because otherwise a torn-out tab looks like a project
                that lost its agents. "Bring it back here" is also the ONLY recovery path when the
                satellite has ended up on a monitor that is no longer plugged in. */}
            {!sparkleActive && !boardActive && selectedIsTornOut && project && (
              <Hint title={project.name}>
                <div style={{ marginBottom: 18 }}>
                  This project is open in its own window.
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                  <button
                    data-testid="focus-satellite"
                    onClick={() => void focusSatellite(project.id)}
                    style={{
                      background: C.teal,
                      color: ON_BRAND_FILL,
                      border: "none",
                      borderRadius: 6,
                      padding: "10px 20px",
                      fontWeight: FONT_WEIGHT.semibold,
                      cursor: "pointer",
                      fontFamily: FONT_UI,
                    }}
                  >
                    Show that window
                  </button>
                  {/* Re-docking is a HANDSHAKE, so it can take up to REDOCK_TIMEOUT_MS when the
                      satellite is slow to answer. Without a pending state the button looks inert
                      and gets clicked repeatedly, and each click emits another request and can
                      eventually force another window close. */}
                  <button
                    data-testid="reclaim-satellite"
                    disabled={reclaimingIds.has(project.id)}
                    // The guard lives in startReclaim, not only in `disabled`: a disabled button is
                    // a rendering detail, and this handler is also what the keyboard path reaches.
                    onClick={() => startReclaim(project.id)}
                    style={{
                      background: "transparent",
                      color: C.cream,
                      border: `1px solid ${C.muted}`,
                      borderRadius: 6,
                      padding: "10px 20px",
                      fontWeight: FONT_WEIGHT.semibold,
                      cursor: reclaimingIds.has(project.id) ? "default" : "pointer",
                      opacity: reclaimingIds.has(project.id) ? 0.6 : 1,
                      fontFamily: FONT_UI,
                    }}
                  >
                    {reclaimingIds.has(project.id) ? "Bringing it back…" : "Bring it back here"}
                  </button>
                </div>
              </Hint>
            )}
            {!sparkleActive && !boardActive && !selectedIsTornOut && project && project.agents.length === 0 && (
              <Hint title={project.name}>
                {/* The same "+ New Build Agent" button as the sidebar, so the user can start a build
                    agent right here. Hovering it also lights up the sidebar's copy blue (shared
                    buildAgentHover flag), pointing at where the affordance normally lives. */}
                <div style={{ width: 240, margin: "0 auto", display: "flex", flexDirection: "column", gap: 6 }}>
                  <NewAgentRuntimeToggle />
                  <NewBuildAgentButton onClick={spawnBuild} />
                </div>
                {/* ~3 blank rows of breathing room before the tour line. */}
                <div style={{ height: 60 }} />
                <div
                  style={{
                    fontSize: 17,
                    fontWeight: FONT_WEIGHT.semibold,
                    color: C.cream,
                    lineHeight: 1.5,
                  }}
                >
                  Press <KbdKey>⌃ Ctrl</KbdKey> key to take a tour. Happy tokenmaxxing!
                </div>
              </Hint>
            )}
            {!sparkleActive && !boardActive && !selectedIsTornOut && project && project.agents.length > 0 && !activeAgentId && (
              <Hint title={project.name}>Pick an agent on the left.</Hint>
            )}
            {!sparkleActive && !boardActive && !selectedIsTornOut && project && activeAgentId && !activeIsOpen && (
              <Hint title={project.name}>
                <button
                  onClick={() => open(activeAgentId)}
                  style={{
                    background: C.teal,
                    color: ON_BRAND_FILL,
                    border: "none",
                    borderRadius: 6,
                    padding: "10px 20px",
                    fontWeight: FONT_WEIGHT.semibold,
                    cursor: "pointer",
                    fontFamily: FONT_UI,
                  }}
                >
                  ▶ Start this agent
                </button>
              </Hint>
            )}
          </div>

          {/* The right pair's board — same component, its own project, and OUTSIDE the stage above
              for the same reason as the left pair's: it lays over both of this pair's columns, not
              over the terminal alone. Last child, so it paints over the stage's empty-state hints
              and the portalled panes as well as the Build column. */}
          {boardActive && project && <PlanBoardSlot project={project} side="right" />}
        </Pair>
      </div>

      {/* ── EVERY AGENT PANE, MOUNTED EXACTLY ONCE ────────────────────────────────────────────────
          It renders NO DOM of its own here: every pane is a `createPortal` into the stage its pair
          owns. This position in the tree is load-bearing precisely because it is boring — it is a
          child of the shell root, which never unmounts and never changes with the pair layout, so a
          project moving between pairs (or a pair opening or closing under it) cannot move this
          element. That is the whole feature: the panes' place in the REACT tree is fixed, and only
          their place in the DOM changes.

          It sits below the pairs so the portalled panes are appended AFTER the stage's own children
          (the Sparkle pane, the empty-state hints). Stacking is unaffected — `paneVisibilityStyle`
          gives the one visible pane `TERMINAL_PANE_Z` and every hidden one `visibility: hidden` plus
          `zIndex: 0`, and a stage never shows the Sparkle pane and an agent pane at once (the
          right-hand `visibleAgentId` below is null whenever Sparkle or the board is up). */}
      {/* MEMOIZED PROPS, WHICH IS WHAT MAKES THE `memo` BELOW MEAN ANYTHING — and it is a drag-latency
          fix, not tidiness (roborev 55316).

          These three were freshly-allocated object literals on every `Workspace` render, so
          `AgentPaneList` could never bail out: every pointer event of a seam drag reconciled the whole
          list — one `PaneHost` + `Suspense` + `ErrorBoundary` + `createPortal` per open pane, times
          ~30 events a drag. The render-cost harness could not see it, because its counter sits inside
          the leaf that `arePanePropsEqual` already bails out of, so it reported "ZERO pane renders"
          while the wrapper fibers above that leaf re-rendered at pointer rate.

          This branch is why it had to be fixed now rather than later: it adds a SECOND draggable seam,
          so the exposure doubles. It is also the "latency clicking around on the build agents" report,
          and the terminal-switch cost blocking the hover-to-preview work. */}
      <MemoAgentPaneList
        panes={live}
        pairAssignment={pairAssignment}
        stages={paneStages}
        // A column showing its board has no visible agent pane — EACH side answers that for itself.
        visibleAgentId={paneVisibleAgentId}
        // Calm is the RIGHT pair's treatment: it follows the agent the concierge is looking at, and
        // duplicating it on the left would desaturate a pane nobody is asking about.
        calm={paneCalm}
      />

      {/* The app's only bottom chrome: Changelog · Support · v{version}, hugging the bottom-right
          corner. A real ROW of this column (not an overlay), so it can never occlude the terminal
          stage, the composer, or any other bottom-anchored UI — they simply lay out above it. */}
      <StatusStrip />

      {/* ⌘K history search across every project's conversations (CM-U5). */}
      <CommandPalette open={palette.open} onClose={palette.closePalette} />

      {settingsProject && (
        <Suspense fallback={null}>
          <ProjectModal
            project={projects.find((p) => p.id === settingsProject.id) ?? settingsProject}
            onClose={() => setSettingsProject(null)}
          />
        </Suspense>
      )}

      {/* The cloud-agent create dialog is rendered exactly ONCE here, though the "+ New Build
          Agent" affordance that opens it exists in two places (sidebar row + empty state). Lazy so
          a local-only user never downloads it. */}
      {cloudCreateOpen && project && (
        <Suspense fallback={null}>
          <NewCloudAgentDialog project={project} onClose={() => setCloudCreateOpen(false)} />
        </Suspense>
      )}

      {closing && (
        <ClosePrompt
          projectName={project?.name ?? "this project"}
          // "Stop the agents" reaches every project's RUNNING agents (killAllOpenAgents), so the
          // copy names exactly those projects rather than implying the visible tab is the only
          // casualty — or naming the front tab when nothing in it is running. Front project first
          // (when it has any), since that's the one the user is looking at.
          runningProjectNames={closeScopeNames}
          onKeep={() => void finishClose("keep")}
          onKill={() => void finishClose("kill")}
          onCancel={() => setClosing(false)}
        />
      )}
    </div>
  );
}

/**
 * A pair's Plan board — ONE WIDE COLUMN over BOTH of that pair's columns.
 *
 * TWO SEPARATE QUESTIONS, and the history here is only confusing if they are run together:
 *
 *   WHICH PAIR does a board belong to? Each. It used to be a single block written once inside the
 *   RIGHT pair, reading a window-global, so pressing Plan on the left opened the board on the
 *   right and either column's board clobbered the other's. That is fixed and STAYS fixed: every
 *   pair renders its own, for its own project, with no shared state
 *   (Workspace.planBoardPerColumn.test.tsx).
 *
 *   HOW MUCH of that pair does it cover? BOTH COLUMNS. The per-pair fix also narrowed the board
 *   into the terminal stage, and that half was wrong — founder, 2026-07-31: "These plan columns are
 *   not taking over the builder row. They should be in both the terminal and the builder area."
 *   The Build column beside it rendered COMPLETELY EMPTY (its toggle and the Improve-Sparkle row
 *   and nothing else) while the board was squeezed into half the width it had: five board columns
 *   at a 220px floor do not fit a terminal column, so Blocked clipped mid-word at the edge and
 *   Being built / Done / Shipped sat off-screen behind a scrollbar. Spanning the pair is what pays
 *   for them — the columns are `flex: 1 1 0` with that floor, so width buys COLUMNS first and only
 *   stretches once all five are on screen (BoardView).
 *
 * IT COVERS, IT DOES NOT RE-FLOW. `position: absolute; inset: 0` over `paircols`, which is the
 * pair's own `position: relative` box holding [build, terminal]. An absolute child takes no part in
 * that flex row, so neither column is unmounted, resized, or asked to give its width up — leaving
 * Plan restores the user's layout exactly because nothing ever changed it. Unmounting would also
 * kill the terminal's PTY, and `display: none` would zero its measured size.
 *
 * IT CARRIES ITS OWN PLAN/BUILD TOGGLE, and it has to. Covering the Build column takes the
 * sidebar's copy off screen with it, so without one there is no way back to Build. This is the
 * duplicate the terminal-slot version was able to delete, and re-adding it re-inverts the paint
 * order in `layers.ts` — see the note there.
 *
 * The two handlers are the store's own paired writes (`openPlanBoard` / `showBuildStage`), the same
 * ones the satellite window's board header uses. They are deliberately THINNER than
 * AgentSidebar.onPickBuild, which additionally lands selection on the first rendered row: that
 * refinement is for a chevron pressed against a visible row list, and here there is none — leaving
 * Build with the selection it had is what "put my columns back the way they were" means.
 */
function PlanBoardSlot({ project, side }: { project: Project; side: PairSide }) {
  const mode = useUiStore((s) => s.workModeBySide[side]);
  const beadsEnabled = useSettingsStore((s) => s.beadsEnabled);
  const openPlanBoard = useUiStore((s) => s.openPlanBoard);
  const showBuildStage = useUiStore((s) => s.showBuildStage);
  return (
    <div
      data-testid="plan-column"
      data-plan-board-project={project.id}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: C.deepForest,
        zIndex: PLAN_COLUMN_Z,
      }}
    >
      {/* THE TOGGLE SITS OVER THE COLUMN IT REPLACED. A pair's Build column is its INBOARD one
          (`TERM │ BUILD │ concierge │ BUILD │ TERM`), so the left pair's is on the right and the
          right pair's on the left — align to that edge and the control stays where the user's eye
          and cursor already were, instead of jumping across the pair on one side. */}
      <div
        style={{
          paddingTop: 12,
          display: "flex",
          justifyContent: side === "left" ? "flex-end" : "flex-start",
        }}
      >
        <PlanBuildToggle
          mode={mode}
          beadsEnabled={beadsEnabled}
          onPickPlan={() => openPlanBoard(side)}
          onPickBuild={() => showBuildStage(side)}
          style={{ margin: "0 12px 8px", width: 320, maxWidth: "100%" }}
        />
      </div>
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        <Suspense fallback={<PaneFallback />}>
          <BoardView project={project} side={side} />
        </Suspense>
      </div>
    </div>
  );
}

function Hint({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        textAlign: "center",
        padding: 24,
      }}
    >
      <div style={{ fontSize: 17, fontWeight: FONT_WEIGHT.semibold, color: C.cream }}>{title}</div>
      <div style={{ color: C.muted, maxWidth: 420, lineHeight: 1.5 }}>{children}</div>
    </div>
  );
}

// A keycap "chiclet" — the same gold pill the keyboard-hint overlay uses (HintOverlay.tsx), reused
// inline in copy to render a physical key (e.g. the ⌃ Ctrl key). Sits on the text baseline center.
function KbdKey({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-block",
        verticalAlign: "middle",
        margin: "0 3px",
        // The themed opaque-gold PAIR — see theme/colors `goldFill` / ON_GOLD_FILL. This said
        // "gold #e0982f" while painting the amber STATUS token.
        background: C.goldFill,
        color: ON_GOLD_FILL,
        font: `700 15px/1 ${FONT_MONO}`,
        letterSpacing: 0.5,
        padding: "3px 8px",
        borderRadius: 4,
        border: `1px solid ${ON_GOLD_FILL}`,
        boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
        textTransform: "uppercase",
      }}
    >
      {children}
    </span>
  );
}
