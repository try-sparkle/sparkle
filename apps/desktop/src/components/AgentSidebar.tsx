import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
  useContext,
  createContext,
  memo,
  Fragment,
  type RefObject,
  type DragEvent as ReactDragEvent,
} from "react";
import { createPortal } from "react-dom";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { TbPinFilled } from "react-icons/tb";
// FiChevronsLeft/Right are §10's two pull tabs; FiTool is the "+ New Build Agent" icon.
import { FiCloud, FiChevronsLeft, FiChevronsRight, FiTool } from "react-icons/fi";
import { C, AGENT_STATUS, FONT, FONT_WEIGHT, ON_BRAND_FILL, DANGER, statusInk } from "../theme/colors";
import { FONT_MONO, RADIUS, TYPE } from "../theme/scale";
import { listMyTickets, bannerFromTickets, TICKET_CREATED_EVENT, type TicketStatus } from "../services/supportApi";
import { shouldPollTickets, ticketsSignature } from "./supportTicketPoll";
import { SIDEBAR_OVERLAY_Z } from "./layers";
import { TERM_HAIRLINE } from "./terminalChrome";
import { WEB_BASE_URL } from "../services/sparkleApi";
import type { Project, AgentTab, AgentTabStatus } from "../types";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { APP_WINDOW_LABEL } from "../windowContext";
import { useInteractionStore } from "../stores/interactionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { removeAgentWorkspace } from "../services/worktree";
import { spinDownWorker } from "../services/workerSpawn";
import { terminateIfCloud } from "../services/cloudAgents/terminate";
import { killPty } from "../pty";
import { refreshAgentBranch, landAgentBranch } from "../services/branchStatus";
import type { BranchStatus } from "../services/branchStatus";
import { shouldPromptOnClose, selectionAfterClose } from "../engine/closeAgent";
import { shipAgent, saveAgent, discardAgentGit, type ShipOutcome } from "../services/closeAgentActions";
import { ModalShell } from "./ModalShell";
import { refreshAgentTitle } from "../services/sessionTitle";
import {
  isNameFromWorkCandidate,
  maybeNameFromWork,
  WORK_BACKSTOP_WINDOW_TICKS,
} from "../services/agentNaming";
import { sparkleAgentIdFor } from "../services/sparkleAgent";
import { handleImproveSparkleClick } from "../services/sparkleReveal";
import { consentPillLabel } from "./sparkleRowStatus";
import { useBeadsStore } from "../stores/beadsStore";
import { beadLabel, epicForBuild, epicPillFor } from "../services/planView";
import { type Bead } from "../services/beads";
import {
  topLevelAgents as topLevelOf,
  isTopLevelAgent,
  firstVisibleAgentId,
} from "../engine/agentOrdering";
import { firstLadderRowId } from "../engine/ladderSelection";
import { publishedStatusFor, rollupViewFor } from "../useAttentionNotifications";
import {
  bandOfStatus,
  flattenSections,
  groupAgentsByStage,
  type BuildSectionId,
  type StatusBand,
} from "../engine/buildSections";
import {
  bandOfRollup,
  rollupDot,
  rollupLabel,
  type RollupDot,
} from "../engine/workerRollup";
import { StageSectionHeader } from "./StageSectionHeader";
import { StatusFilterBar } from "./StatusFilterBar";
import {
  isUnstartedWorker,
  withUnstartedWorkerAttention,
  withRedWorkerAttention,
} from "../engine/workerAttention";
import {
  autoCollapseTargets,
  expandOnWorkerAttention,
  workerAttention,
  type WorkerAttention,
} from "../engine/workerExpansion";
import { withDismissedAlerts, alertControlKind } from "../engine/alertDismissal";
import { HINT_JUMP_ATTR } from "../keyboardHints/hintTargets";
import { withUnmergedWork } from "../engine/unmergedAttention";
import { useNewAgentCalm, useNewAgentGraceTick } from "../hooks/useNewAgentCalm";

/** Stable empty list, so the hook below is not handed a fresh `[]` on every render before a project
 *  resolves — a new array identity each time would re-arm its grace timer forever. */
const NO_AGENTS: readonly AgentTab[] = [];
import { AlertToggleButton } from "./AlertToggleButton";
import { reconcileWorkMode } from "../engine/workMode";
import { PlanBuildToggle, BUILD_INK } from "./PlanBuildToggle";
import { StatusDot } from "./StatusDot";
import { FittedAgentName, AGENT_NAME_FONT_SIZE } from "./FittedAgentName";
import { ModelPill } from "./ModelPill";
import { applyModelToRunningAgent } from "../services/agentModel";
import { WorkflowLine } from "./WorkflowLine";
import { resolveStage, rollupStages, stageFraction, stageIndex, stageMeta } from "../engine/workflowStage";
import type { WorkflowStageId } from "../engine/workflowStage";
import { useNewAgent } from "../hooks/useNewAgent";
import { NewAgentRuntimeToggle } from "./NewAgentRuntimeToggle";
import { NEW_BUILD_AGENT_DND_TARGET } from "../services/dndTargets";
import { CloseAgentPrompt } from "./CloseAgentPrompt";

/**
 * Left column: the current project's agents as a vertical list (spec layout, revised).
 * Each row is a status dot + the agent name rendered in that status's color; click a row
 * to open the agent, double-click the agent name to rename it, ×
 * to close. "+ Agent" adds one.
 */
// A dashed-outline "+ New <kind> Agent" row — the per-mode affordance for creating an agent,
// shown in the sidebar list for the active Build/Think mode: below the last row when the list
// fits, or pinned (sticky) at the top when the list is tall enough to scroll.
// Border is split into longhand props (width/style/color) so NewAgentRow's hover state can flip
// just the style (dashed → solid) and color without fighting a `border` shorthand.
// `--hd-h` from rev4.html: the height of every column header band in the cockpit — the concierge's
// `.ahd` and this column's `.bhd`. One number so the two line up across the seam; a header that is
// two pixels off its neighbour is the kind of thing that reads as "not the design" without anyone
// being able to name it.
const BUILD_HEADER_H = 34;

const DASHED_ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  margin: "2px 0 8px",
  padding: "9px 10px",
  borderWidth: 1,
  borderStyle: "dashed",
  borderColor: C.muted,
  borderRadius: 6,
  background: "transparent",
  color: C.muted,
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  cursor: "pointer",
};

// Wrapper shared by BOTH placements of the "+ New … Agent" button (sticky top / below the last
// row). A flex column so the button's margins can't collapse out of it — which keeps the button's
// flow-height contribution IDENTICAL in the two slots (block margins would collapse differently at
// the bottom of the list), so the overflow measurement is placement-independent and the placement
// can't oscillate or develop a hysteresis band at the boundary.
const NEW_AGENT_SLOT_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  // Separates the Local/Cloud runtime toggle from the button when the toggle renders (cloud
  // enabled). With the toggle absent there is a single child, so this has no effect.
  gap: 6,
};

// Coordinates the gentle auto-scroll of the agent list when a near-the-bottom row's hover card
// would otherwise be clipped by the viewport. A hovered row asks the column to `scrollToReveal`
// just enough room below it for its full card; on un-hover it `restore`s the column to where the
// user had it. `isAutoScrolling` lets a row tell OUR programmatic smooth-scroll apart from a
// user's own scroll: during ours the card glides along glued to its row; on a user scroll the
// card closes (the original behavior). All three only touch refs, so the value identity is stable.
type SidebarScrollApi = {
  containerRef: RefObject<HTMLDivElement | null>;
  // Scroll the list so `overflowPx` more of the hovered card fits below its row, remembering the
  // pre-scroll position as the baseline to return to. Capped at the list's own max scroll, so a
  // row near the natural bottom reveals as much as physically possible (the card's internal
  // max-height scroll covers any remainder).
  scrollToReveal: (overflowPx: number) => void;
  // Smoothly return the list to the baseline captured before auto-scrolling. Debounced so gliding
  // the cursor straight from one bottom row to the next keeps the same baseline instead of bouncing.
  restore: () => void;
  // Cancel a pending ease-back WITHOUT discarding the baseline — called when a card opens, so a
  // re-hover during the debounce window doesn't bounce the column back and re-clip.
  cancelRestore: () => void;
  // Drop the baseline and any pending ease-back so nothing yanks the list away from where it is
  // now. `abortInFlight` additionally kills an ease-back that is ALREADY ANIMATING, via a direct
  // scroll-offset write — pass it from the reveal path, and NOT from the user-scroll path, where
  // that write would cancel the user's own momentum scroll.
  abandonReveal: (abortInFlight?: boolean) => void;
  // True while our own smooth scroll (reveal or restore) is in flight toward its target.
  isAutoScrolling: () => boolean;
};
const SidebarScrollContext = createContext<SidebarScrollApi | null>(null);

// The "+ New <kind> Agent" button. On hover the dotted outline becomes a solid stroke and the
// icon + label light up in the mode's accent — the same gold as that mode's chevron, now that the
// strip stopped painting a decorative cyan→blue fade. It takes the INK twin of that gold
// (`BUILD_INK`), not the chevron's fill: `hoverColor` lands on `color` and `borderColor` here, and
// a fill token is only held to the 3:1 control floor — see the note on PlanBuildToggle.BUILD_INK.
// The background is left unchanged.
// `sharedHover`/`onHoverChange` let a SECOND instance of the button elsewhere (the Workspace
// empty-state start button) drive this one blue too, so hovering either lights up both.
function NewAgentRow({
  icon,
  label,
  hoverColor,
  onClick,
  sharedHover,
  onHoverChange,
  dndTarget,
  dataHint,
}: {
  icon: React.ReactNode;
  label: string;
  hoverColor: string;
  onClick: () => void;
  sharedHover?: boolean;
  onHoverChange?: (v: boolean) => void;
  // Marks the button as a webview drag-drop target (see services/dndTargets.ts) so the
  // window-global drag handlers can hit-test the cursor against it with elementFromPoint.
  dndTarget?: string;
  // Registers the button in the keyboard-hint overlay (see keyboardHints/hintTargets.ts). Only the
  // sidebar instance passes this — the Workspace empty-state copy leaves it undefined so a single
  // chiclet shows even when both buttons are on screen at once.
  dataHint?: string;
}) {
  const [hover, setHover] = useState(false);
  const lit = hover || !!sharedHover;
  return (
    <button
      data-dnd-target={dndTarget}
      data-hint={dataHint}
      onClick={onClick}
      onMouseEnter={() => {
        setHover(true);
        onHoverChange?.(true);
      }}
      onMouseLeave={() => {
        setHover(false);
        onHoverChange?.(false);
      }}
      style={{
        ...DASHED_ROW_STYLE,
        borderStyle: lit ? "solid" : "dashed",
        borderColor: lit ? hoverColor : C.muted,
        color: lit ? hoverColor : C.muted,
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

// The Build variant of NewAgentRow, wired to the shared `buildAgentHover` flag so every instance
// (the sidebar's row AND the Workspace empty-state start button) highlights in sync. Exported so
// the Workspace can drop the exact same button in place of its old "Add an agent" hint text.
// Also a drag-drop target: dropping files on it spawns a new build agent with the files attached
// to ITS composer (useNewBuildAgentDrop), which lights buildAgentHover during the drag — so the
// drag-over visual IS the normal hover visual, on both copies.
export function NewBuildAgentButton({
  onClick,
  dataHint,
}: {
  onClick: () => void;
  dataHint?: string;
}) {
  const buildAgentHover = useUiStore((s) => s.buildAgentHover);
  const setBuildAgentHover = useUiStore((s) => s.setBuildAgentHover);
  // Clear the shared flag if this button unmounts while hovered — clicking the empty-state instance
  // spawns an agent, which unmounts it before onMouseLeave can fire, otherwise leaving the sidebar's
  // copy stuck blue. Any still-hovered sibling re-lights itself via its own local hover state.
  useEffect(() => () => setBuildAgentHover(false), [setBuildAgentHover]);
  return (
    <NewAgentRow
      // A react-icon, not the ⚒ character it replaced — the same swap PlanBuildToggle's Build
      // chevron made, and for the second reason stated there as well as the emoji ban: an
      // emoji-font glyph ignores `color`, so the ⚒ could not follow the gold hover ink below.
      icon={<FiTool size={18} style={{ flexShrink: 0 }} />}
      label="+ New Build Agent"
      hoverColor={BUILD_INK}
      onClick={onClick}
      sharedHover={buildAgentHover}
      onHoverChange={setBuildAgentHover}
      dndTarget={NEW_BUILD_AGENT_DND_TARGET}
      dataHint={dataHint}
    />
  );
}

export function AgentSidebar({
  project,
  showSparkleRow = true,
}: {
  project: Project | null;
  /** Hide the pinned Improve-Sparkle row. Only a SATELLITE window passes false, and it must: the
   *  Sparkle agent's id is keyed to the window label (`sparkleAgentIdFor`), and a satellite would
   *  therefore offer to reveal MAIN's copy — a second pane on one PTY, which is the one thing the
   *  tear-off ownership split exists to prevent. Defaults to true so the main window is untouched. */
  showSparkleRow?: boolean;
}) {
  const selectAgent = useProjectStore((s) => s.selectAgent);
  const removeAgent = useProjectStore((s) => s.removeAgent);
  const open = useRuntimeStore((s) => s.open);
  const close = useRuntimeStore((s) => s.close);
  const liveStatus = useRuntimeStore((s) => s.status);
  const openAgentIds = useRuntimeStore((s) => s.openAgentIds);
  const lastObserved = useRuntimeStore((s) => s.lastObserved);
  // The open set, built once: the strand overlay below and `expectsLiveStatus` further down both
  // ask it, and two Sets from one array is two allocations per render for the same answer.
  const openIds = useMemo(() => new Set(openAgentIds), [openAgentIds]);
  // A spawned-but-never-started worker has no live status, so it (and the orchestrator it's
  // blocking) would render GRAY. Overlay RED ("Approve?") on the strand and bubble it to the parent
  // so the orchestrator row goes red — matching the TopBar dot cluster. No-op (same ref) when
  // nothing is stranded.
  // Terminal keystrokes land here and nowhere else (Terminal.onData → touch), so this is the ONLY
  // evidence that an agent driven by hand in the pane has in fact been briefed. Step (0) needs it or
  // it would keep calling such an agent "New — not briefed" forever. See newAgentAttention route 4.
  const interactionAt = useInteractionStore((s) => s.lastAt);
  // Step (0), hoisted out of the memo below and into the hook that owns its CLOCK. The backstop is
  // a deadline and an `errored` agent emits no further status writes, so a bare
  // `useMemo(… Date.now() …)` here would hold such a row gray forever (roborev 54743, finding 1).
  // Same position in the chain as before — see the comment inside the memo.
  const s0 = useNewAgentCalm(project?.agents ?? NO_AGENTS, liveStatus, interactionAt);
  // The same wake-up, exposed as a value so the rollup memo far below can depend on it too.
  const graceTick = useNewAgentGraceTick(project?.agents ?? NO_AGENTS, liveStatus, interactionAt);
  const status = useMemo(() => {
    if (!project) return liveStatus;
    // Two attention overlays, composed: (1) an unstarted worker gets a synthetic red + bubbles to
    // its orchestrator; (2) a started-then-red worker — ANY red-tier status, `blocked` included (see
    // services/windowStatus.isRedStatus) — bubbles its own red to its orchestrator so the
    // orchestrator floats up and shows red. Order matters — run (2) after
    // (1) so a strand's synthetic red also bubbles.
    // (0) FIRST, on the raw map: a spawned-but-never-briefed agent reads `new` (GRAY) rather than
    // the red `blocked` statusEngine's 25s stall timer hands it for being quiet. Before the bubbles,
    // for the reason spelled out on publishedStatusFor's step (0) — once a red has bubbled to an
    // orchestrator it is indistinguishable from that row's own. Keeping the same position here is
    // what keeps this chain equal to publishedStatusFor's (see the CONCIERGE BANDING NOTE below).
    // `s0` is that step, computed by useNewAgentCalm above so the 5-minute backstop has a clock.
    // It feeds (1) in place of the raw map; `lastObserved` (origin/main, sparkle-w340) is unrelated
    // and rides along untouched.
    const s1 = withUnstartedWorkerAttention(project.agents, s0, openIds, lastObserved);
    return withRedWorkerAttention(project.agents, s1);
  }, [project, liveStatus, openIds, s0, lastObserved]);
  // Advance each agent's alert-episode record on every change to the overlaid (pre-dismissal) status
  // — the input the "Dismiss Alert" feature reads. Runs AFTER the worker-attention overlays so a
  // worker's bubbled red counts as the orchestrator's episode too: a dismissed orchestrator re-alerts
  // when the bubbled red *signature changes kind* (e.g. a worker goes waiting→errored). Note the
  // limit — episodes key on the red kind, not worker identity — so a DIFFERENT worker later going red
  // with the SAME kind leaves the bubbled signature unchanged and does not re-alert; acceptable, since
  // the orchestrator-level signal ("a worker needs you, <kind>") hasn't changed. advanceAlerts writes
  // only on a real red-tier transition, so this is not a per-tick persist. No-ops before a project.
  const advanceAlerts = useProjectStore((s) => s.advanceAlerts);
  const dismissAlert = useProjectStore((s) => s.dismissAlert);
  const reenableAlert = useProjectStore((s) => s.reenableAlert);
  useEffect(() => {
    if (project) advanceAlerts(project.id, status);
  }, [project?.id, status, advanceAlerts]);
  const branchStatus = useRuntimeStore((s) => s.branchStatus);
  const workflowStage = useRuntimeStore((s) => s.workflowStage);
  const workflowShipped = useRuntimeStore((s) => s.workflowShipped);
  // The status map the ROW COLOR and the SORT ORDER read, built in two overlay steps:
  //   (1) withUnmergedWork — a FINISHED agent (idle/done/stopped) that still has committed work not
  //       yet landed on main is escalated to `unmerged` ("Needs merge"). That is a GRAY status, not
  //       an alarm; what it buys the row is its own ordering band (above the calm tier) and the
  //       hover label, until you open/merge its PR.
  //   (2) withDismissedAlerts — dismissed red alarms de-escalate to their non-red tier
  //       (waiting/approval/blocked→idle, errored→stopped) so a dismissed row leaves the red zone.
  // Order matters: unmerged BEFORE dismissal (`unmerged` isn't dismissible, and running it after
  // dismissal would re-redden a just-calmed row — see withUnmergedWork's header). Kept separate from
  // `status` so the badge / dock-notification consumers still read the true, un-dismissed status.
  const effectiveStatus = useMemo(
    () =>
      project
        ? withDismissedAlerts(
            project.agents,
            withUnmergedWork(project.agents, status, (id) =>
              resolveStage(branchStatus[id], workflowStage[id]),
            ),
          )
        : status,
    [project, status, branchStatus, workflowStage],
  );
  // CONCIERGE BANDING NOTE (roborev 46341-M3): `effectiveStatus` above IS the published map.
  // `status` already carries both worker overlays (withUnstartedWorkerAttention +
  // withRedWorkerAttention, see its memo), and effectiveStatus adds withUnmergedWork +
  // withDismissedAlerts — the exact composition publishedStatusFor performs. Re-running
  // publishedStatusFor here was a value-identical second computation of the whole map per render,
  // so the calm band reads effectiveStatus directly.
  const pollBranchStatus = useRuntimeStore((s) => s.pollBranchStatus);
  const activeSpecial = useUiStore((s) => s.activeSpecial);
  const setActiveSpecial = useUiStore((s) => s.setActiveSpecial);
  // The Improve-Sparkle agent is keyed by window label (sparkleAgentIdFor — see onSelectSparkle /
  // services/sparkleReveal). There is exactly one app window now, and its label is the constant
  // APP_WINDOW_LABEL; the id is spelled through it rather than the literal so the persistence key
  // that existing users already have on disk can't drift.
  const sparkleAgentId = sparkleAgentIdFor(APP_WINDOW_LABEL);

  // Which chevron is selected. Drives both the strip's coloring (active = brand, others grayscale)
  // and which agents the sidebar list shows. Defaults to Build; not persisted across launches.
  // Lifted into uiStore (workMode/setWorkMode) so other components — e.g. ThinkPanel's "Make a
  // Plan" button — can switch tabs. Behavior is identical to the old local useState.
  const mode = useUiStore((s) => s.workMode);
  const setMode = useUiStore((s) => s.setWorkMode);
  // Which status bands the column currently shows (the filter chips above the ladder).
  const statusFilter = useUiStore((s) => s.statusFilter);
  const toggleStatusBand = useUiStore((s) => s.toggleStatusBand);
  const showAllStatusBands = useUiStore((s) => s.showAllStatusBands);
  // The workflow stage an agent's own git state + any known override resolves to.
  const stageOf = (id: string): WorkflowStageId =>
    resolveStage(branchStatus[id], workflowStage[id]);
  // Has this agent ever shipped (reached On Main+)? Sticky flag set by refreshWorkflowStage, OR'd
  // with the current resolved stage so the ✓ shows even on the first tick that lands it.
  const shippedOf = (id: string): boolean =>
    (workflowShipped[id] ?? false) || stageIndex(stageOf(id)) >= stageIndex("merged");

  // Keep the workflow trackers live: re-poll branch + workflow state on a modest cadence (and once
  // immediately on project switch), so the chevrons advance toward green as work is committed, PR'd,
  // and merged without the user touching anything. Reads fresh state from the stores inside the tick
  // so the effect only re-subscribes on project change, not on every status update.
  const projectId = project?.id;
  // Per-agent count of CONSECUTIVE poll ticks a build/worker has been a name-from-work candidate
  // (unpinned default + worktree, still no aiTitle / self-name). Drives the Tier-2 grace window: the
  // paid Haiku backstop only fires once this reaches WORK_BACKSTOP_WINDOW_TICKS, giving Tier 1 (the
  // free session-title backfill below) and the agent's own self-naming first crack. Reset the instant
  // an agent stops being a candidate. A ref (not state) — it must survive re-renders without causing them.
  const workBackstopTicksRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!projectId) return;
    // A slow tick (the gh PR probe can take ~0.5s/agent) must not overlap the next interval.
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const proj = useProjectStore.getState().projects.find((p) => p.id === projectId);
        if (!proj) return;
        const { openAgentIds, status, pollProjectStatus } = useRuntimeStore.getState();
        const hasWorkflow = (a: (typeof proj.agents)[number]) =>
          a.kind !== "shell"; // shell agents have no git workflow
        // Targets: every OPEN agent, PLUS the orchestrator parent of each open worker — even when
        // that parent's pane is closed — so a worker's "Merged" (which reads its parent's stage)
        // can still advance. De-duped by id.
        const targets = new Map<string, (typeof proj.agents)[number]>();
        for (const a of proj.agents) {
          if (!openAgentIds.includes(a.id) || !hasWorkflow(a)) continue;
          targets.set(a.id, a);
          if (a.kind === "worker" && a.parentId) {
            const parent = proj.agents.find((p) => p.id === a.parentId);
            if (parent && hasWorkflow(parent)) targets.set(parent.id, parent);
          }
        }
        const all = [...targets.values()];
        // Auto-name each agent from Claude Code's own session title (ai-title in the transcript) —
        // the authoritative name once the first turn has summarized. Fire-and-forget, independent
        // of the branch-status poll below; the store action respects pins + de-dupes.
        //
        // TIER 1 (name-from-work, free): the title poll normally covers only OPEN agents, but a
        // build/worker that did real work while its pane was CLOSED can be stuck on its "Build N"/
        // "Worker N" default forever. So ALSO poll every CLOSED name-from-work candidate — its session
        // title backfills the default for free. Marked `backfill` so the free win is tallied distinctly.
        const titleTargets = new Map<string, { agent: (typeof proj.agents)[number]; backfill: boolean }>();
        for (const a of all) titleTargets.set(a.id, { agent: a, backfill: false });
        for (const a of proj.agents) {
          if (titleTargets.has(a.id)) continue;
          if (isNameFromWorkCandidate(a)) titleTargets.set(a.id, { agent: a, backfill: true });
        }
        for (const { agent: a, backfill } of titleTargets.values()) {
          void refreshAgentTitle(
            proj.id,
            a.id,
            a.worktreePath,
            backfill ? { backfill: true, kind: a.kind } : undefined,
          );
        }
        // TIER 2 (name-from-work, paid): a candidate that survives WORK_BACKSTOP_WINDOW_TICKS
        // consecutive ticks without Tier 1 or self-naming rescuing it gets ONE Haiku call named from
        // its actual WORK (maybeNameFromWork re-checks eligibility + fires once per agent). The tick
        // counter gives Tier 1 first crack; a no-longer-candidate agent resets its window.
        // Prune only the grace-window ticks (a harmless per-agent counter) for agents that dropped out
        // of this project's loaded list. The once-per-agent PAID guard is intentionally NOT pruned here:
        // it's a process-wide Set that must survive a transient drop (project switch/reload) so a
        // reappearing agent isn't charged a second Haiku call — see agentNaming.workBackstopAttempted.
        const workTicks = workBackstopTicksRef.current;
        const liveIds = new Set(proj.agents.map((a) => a.id));
        for (const id of [...workTicks.keys()]) if (!liveIds.has(id)) workTicks.delete(id); // drop gone agents
        for (const a of proj.agents) {
          if (!isNameFromWorkCandidate(a)) {
            workTicks.delete(a.id); // rescued / renamed / no longer eligible → reset the grace window
            continue;
          }
          const n = (workTicks.get(a.id) ?? 0) + 1;
          workTicks.set(a.id, n);
          if (n >= WORK_BACKSTOP_WINDOW_TICKS) void maybeNameFromWork(proj.id, a.id);
        }
        // ONE batched Rust call for the whole project (sparkle-zlic) instead of the old ~3-4
        // subprocesses PER agent: shared repo discovery + skip of fingerprint-unchanged idle agents.
        // `force` recomputes actively-working agents so their dirty/ahead counts stay fresh; the
        // batch applies orchestrators before workers internally so a worker's "Merged" derive still
        // reads its parent's fresh stage this same tick.
        await pollProjectStatus(
          proj.rootPath,
          proj.id,
          all.map((a) => ({
            id: a.id,
            kind: a.kind,
            baseBranch: a.baseBranch ?? "",
            parentBranch: a.kind === "worker" && a.parentId ? `sparkle/agent-${a.parentId}` : "",
            beadId: a.beadId,
            name: a.name,
            parentId: a.parentId,
            force: status[a.id] === "working",
          })),
          true,
        );
      } finally {
        inFlight = false;
      }
    };
    void tick();
    // 15s cadence: the same tick that advances the workflow chevrons also refreshes each agent's
    // Claude Code session-title auto-name (line ~436), so a shorter interval mainly buys a fresher
    // orchestrator name sooner ("Build N" → its real title in ~15s instead of ~30s). Kept modest —
    // the `inFlight` guard skips a tick that's still running (the gh PR probe can take ~0.5s/agent)
    // and pollProjectStatus fingerprint-skips idle agents, so halving the period stays cheap.
    const id = setInterval(() => void tick(), 15_000);
    return () => clearInterval(id);
  }, [projectId]);
  // Beads tool gate ([tools].beads). Off → the Plan chevron (the read-only Tasks board entry) is
  // hidden and no `bd` shell-out runs (see beadsStore).
  const beadsEnabled = useSettingsStore((s) => s.beadsEnabled);
  const [editing, setEditing] = useState<string | null>(null);
  // Which agent the Ship/Save/Discard close prompt is asking about (null = no prompt).
  const [closePromptId, setClosePromptId] = useState<string | null>(null);
  // What the chosen close outcome ACTUALLY did, when that differs from what the button promised
  // (roborev 54225). Rendered as a ModalShell card — the same dialog chrome CloseAgentPrompt uses,
  // stepped into the slot it just vacated, rather than a new notification channel. `null` on the
  // clean paths: a PR that opened and a branch that reached the remote need no announcement.
  const [closeNotice, setCloseNotice] = useState<{ title: string; body: string } | null>(null);

  // Draggable column width — persisted to localStorage so it survives relaunch. Clamped to
  // a sane range so the column can't be dragged to nothing or take over the window.
  const MIN_WIDTH = 160;
  const MAX_WIDTH = 480;
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("sparkle-sidebar-width"));
    return saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : 220;
  });

  const startResize = (e: React.MouseEvent) => {
    // Left button only. A right-click or a middle-click on the strip used to install the global
    // move/up listeners too, which left the body cursor pinned to col-resize until the next
    // primary click released it.
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let latest = startW;
    const onMove = (ev: MouseEvent) => {
      latest = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + (ev.clientX - startX)));
      setWidth(latest);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // Persist once the drag settles rather than on every intermediate pixel.
      localStorage.setItem("sparkle-sidebar-width", String(latest));
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Keyboard path for the same resize. The tab is a real focusable control (role="separator" with
  // aria-value*), so a pointer is not the only way to move this boundary — arrows nudge, Shift
  // jumps, Home/End slam to the clamp. Persisted on each commit: unlike a drag there is no
  // "settle" event to hang the write off.
  const RESIZE_STEP = 16;
  const commitWidth = (next: number) => {
    const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next));
    setWidth(clamped);
    localStorage.setItem("sparkle-sidebar-width", String(clamped));
  };
  const onResizeKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? RESIZE_STEP * 4 : RESIZE_STEP;
    if (e.key === "ArrowLeft") commitWidth(width - step);
    else if (e.key === "ArrowRight") commitWidth(width + step);
    else if (e.key === "Home") commitWidth(MIN_WIDTH);
    else if (e.key === "End") commitWidth(MAX_WIDTH);
    else return;
    e.preventDefault();
  };

  // OVERLAY MODE (§10, the second pull tab). Same right edge, second control: instead of RESIZING
  // the column — which reflows the whole shell and forces the terminal to re-measure — this lifts
  // the column OUT of flow and floats it over the terminal. An in-flow spacer holds the column's
  // old slot so nothing beside it moves; the panel just gets wider on top.
  //
  // Persisted like the width, and for the same reason: it's a stated preference about the shape of
  // the app, not a transient view state, so it must survive a relaunch.
  const OVERLAY_KEY = "sparkle-sidebar-overlay";
  const [overlay, setOverlay] = useState<boolean>(
    () => localStorage.getItem(OVERLAY_KEY) === "1",
  );
  const toggleOverlay = () => {
    const next = !overlay;
    setOverlay(next);
    localStorage.setItem(OVERLAY_KEY, next ? "1" : "0");
  };

  // Geometry for the floating panel. Same SHAPE as the row hover-card's anchoring math
  // (PRD/feat/hover-popout-terminal-area.md, and `cardLeft`/`ext` further down this file) — pin to
  // the anchor, grow RIGHT into the terminal area, clamp against the room available, floor it so a
  // narrow window yields a usable panel rather than a sliver — but expressed in CSS rather than in
  // a measured rect.
  //
  // WHY NOT MEASURE. The obvious build is getBoundingClientRect on a spacer + position:fixed. That
  // rect is a SNAPSHOT, and this shell moves underneath it without a window resize: OfflineBanner
  // and ZeroCreditBanner mount and unmount above the flex row and ProjectTabsBar changes height,
  // each of which slides the column down while a fixed panel stays pinned to the stale coordinates
  // — visibly detached from its own spacer, with no self-correction. Positioning against the ②+③
  // wrapper instead (it is already `position: relative`, so it is our containing block) tracks
  // every one of those shifts for free, and `max()/min()` do the clamping the same way, against
  // that wrapper's live width instead of a stored `window.innerWidth`.
  const OVERLAY_WIDTH = "max(280px, min(480px, 100%))";

  const onSelect = (id: string) => {
    if (!project) return;
    // Switching to a normal project agent leaves the special (Sparkle) view.
    setActiveSpecial(null);
    selectAgent(project.id, id);
    open(id);
  };
  // The chevron strip switches the active (colored) mode and filters the sidebar list by kind. Build
  // is two-stage: the FIRST click (when Build isn't already the active section) just switches into
  // the section; clicking the SAME chevron AGAIN while already in Build spawns a fresh build agent
  // (same as the "+ New Build Agent" button). Plan stays a pure mode switch: it has no agent concept
  // and only opens the read-only Tasks board in the main pane.
  const onPickPlan = () => {
    setMode("plan");
    setActiveSpecial("board");
  };
  // Spawn a build agent AND auto-create a bead for it, so every piece of build work is tracked
  // from the start (it floors at "Planned" until code work begins). Shared with the Workspace
  // empty-state start button via the useSpawnBuildAgent hook so both create agents identically.
  // Runtime-aware: with the Local/Cloud toggle on "Cloud" this opens the cloud create dialog
  // instead of spawning a local PTY. Identical behavior in both "+ New Build Agent" call sites.
  const spawnBuildAgent = useNewAgent(project);
  const onPickBuild = () => {
    const alreadyHere = mode === "build" && activeSpecial === null;
    setMode("build");
    setActiveSpecial(null);
    if (!project) return;
    if (alreadyHere) {
      // Second click on the active chevron: spawn a fresh build agent (≡ the + button).
      spawnBuildAgent();
      return;
    }
    // Switching INTO Build: move selection to the row the column actually renders FIRST, so the
    // pane matches the chevron (or clear it → the empty Build state with "+ New Build Agent").
    // Ladder- and filter-aware: array order would happily select a row the user has filtered out.
    const next = firstRenderedRowId(project.agents, "build") ?? firstVisibleAgentId(project.agents, "build");
    selectAgent(project.id, next);
    if (next) open(next);
  };
  // Stable so the memoized SparkleAgentRow doesn't re-render on unrelated status flips (sparkle-alrm.3).
  // Improve Sparkle is per-window: reveal THIS window's own copy in place (its own worktree/branch/
  // conversation keyed by sparkleAgentId). No cross-window focus/broadcast. See services/sparkleReveal.
  const onSelectSparkle = useCallback(() => {
    handleImproveSparkleClick({
      activateLocal: () => {
        setActiveSpecial("sparkle");
        open(sparkleAgentId);
      },
    });
  }, [setActiveSpecial, open, sparkleAgentId]);
  // Land an agent's work into its integration target: a worker → its orchestrator's branch; a build
  // agent → the project's default branch. A local --no-ff merge (see Rust land_agent_branch); the
  // tracker then advances to On Main on the next poll. Best-effort feedback via console for now
  // (dirty/conflict/etc.) — a full toast is a follow-up, matching the refresh button's pattern.
  const onLand = async (a: AgentTab): Promise<boolean> => {
    if (!project) return false;
    // Build agents ALWAYS integrate into the project's default branch — regardless of the base they
    // were spawned from — because that's the ref "On Main"/"Merged" reachability is measured against
    // (Rust resolve_default_branch), so a successful Land actually advances the chevron to green. The
    // deliberate tradeoff: a build agent intentionally cut from a NON-default integration branch is
    // still landed into the default, not that base. baseBranch is only a last-resort fallback when
    // the default is unknown. (In practice build agents are cut from the default, so this is rarely
    // observable; workers, which DO target their orchestrator's branch, are handled above.)
    const target =
      a.kind === "worker" && a.parentId
        ? `sparkle/agent-${a.parentId}`
        : project.defaultBranch ?? a.baseBranch ?? "main";
    // The target tree must be clean. For a worker the target is the live orchestrator — gate on it
    // not actively working so we never merge under a running agent. (A build agent lands into the
    // project root, which has no PTY of its own.)
    const targetBusy =
      a.kind === "worker" && a.parentId
        ? useRuntimeStore.getState().status[a.parentId] === "working"
        : false;
    const r = await landAgentBranch(project.rootPath, a.id, target, targetBusy);
    if (r.ok) {
      // Refresh the agent and (for a worker) its orchestrator so both trackers reflect the landing.
      void pollBranchStatus(project.rootPath, project.id, a.id, a.baseBranch ?? "");
      if (a.kind === "worker" && a.parentId) {
        const parent = project.agents.find((p) => p.id === a.parentId);
        void pollBranchStatus(project.rootPath, project.id, a.parentId, parent?.baseBranch ?? "");
      }
      return true;
    } else {
      console.warn("land blocked:", r.reason, r.files ?? "");
      return false;
    }
  };
  // The first row the Build column is ACTUALLY rendering, derived from fresh store state with the
  // exact same inputs the render uses: the full overlay chain (publishedStatusFor) and the
  // worker-roll-up stage. Every selection path goes through this, so none of them can drift from
  // the column again (roborev 53411/53428/53439/53440 all found the same class of bug here).
  const firstRenderedRowId = useCallback(
    (agents: readonly AgentTab[], forMode: "plan" | "build"): string | null => {
      const rt = useRuntimeStore.getState();
      const stageFor = (id: string) => resolveStage(rt.branchStatus[id], rt.workflowStage[id]);
      // Same roll-up the ladder buckets by: an orchestrator tracks its LEAST-advanced worker.
      const headStageFor = (id: string): WorkflowStageId => {
        const kids = agents.filter((a) => a.parentId === id);
        const rollup = rollupStages(kids.map((w) => stageFor(w.id)));
        return rollup ? rollup.stage : stageFor(id);
      };
      const published = publishedStatusFor(agents, rt.status, new Set(rt.openAgentIds), rt.lastObserved, stageFor);
      return firstLadderRowId(
        agents,
        forMode,
        headStageFor,
        (id) => published[id] ?? "stopped",
        useUiStore.getState().statusFilter,
      );
    },
    [],
  );

  // After a close removes an agent (and its workers), keep selection coherent with the sidebar:
  // when the OPEN agent got torn down, re-point selection at the first visible row of the current
  // mode (or null → blank first-load state). Decision logic is the pure selectionAfterClose; here
  // we just feed it the pre-removal snapshot (`project`) + the fresh post-removal list and apply
  // the result. Mirrors the workerSpawn re-select precedent.
  const reselectAfterClose = (removedRootId: string) => {
    if (!project) return;
    const fresh = useProjectStore.getState().projects.find((p) => p.id === project.id);
    if (!fresh) return;
    // Read the mode FRESH (not the render-scope value): now that AgentRow is memoized, the
    // `onClose` closure that reaches here may have been captured a few renders ago (sparkle-alrm.3).
    const freshMode = useUiStore.getState().workMode;
    // Selection must land on a row the user can actually SEE. With the filter chips, the first
    // agent in array order can easily be one the user has hidden, and selecting a hidden row leaves
    // the main pane showing an agent with no corresponding row in the column.
    const preferredNext = firstRenderedRowId(fresh.agents, freshMode);
    const decision = selectionAfterClose(
      removedRootId,
      project.selectedAgentId,
      project.agents,
      fresh.agents,
      freshMode,
      preferredNext,
    );
    if (decision.reselect) selectAgent(project.id, decision.next);
  };
  // Tear an agent down: drop it (and its workers) from the stores and remove their worktrees. The
  // BRANCH is intentionally kept (remove_worktree_at), so this is the "Save" outcome — Discard adds
  // an explicit branch+bead delete on top (onDiscardClose).
  const teardownAgent = async (id: string) => {
    if (!project) return;
    const agent = project.agents.find((a) => a.id === id);
    // Closing is the user's "stop it" for a CLOUD agent — its "process" is a metered sandbox that
    // deliberately outlives the pane (unmount only detaches), so without this the sandbox bills on
    // until idle-pause and re-attach re-materializes the tab (roborev 46881). Ahead of the worker
    // early-return and over the WHOLE subtree, so no cloud row is ever dropped with its sandbox left
    // running (roborev 46918). Not awaited: the helper never rejects and the rows go immediately.
    for (const a of [agent, ...project.agents.filter((c) => c.parentId === id)]) void terminateIfCloud(a);
    // A worker owns its OWN PTY and an on-disk manifest/worktree (.sparkle/worker.json). spinDownWorker
    // drops the row + closes the runtime SYNCHRONOUSLY up front, then kills the PTY and removes the
    // worktree/manifest in the background — the terminal process dies AND no lingering manifest is
    // left for the reconcile to resurrect the row from (removeAgent tombstones the id to guarantee
    // that; sparkle-close-resurrect). Do NOT await it: the row is already gone before its first await,
    // so reselecting immediately keeps the × instant instead of waiting on the ~1-2s worktree removal.
    if (agent?.kind === "worker") {
      void spinDownWorker({ projectId: project.id, workerId: id });
      reselectAfterClose(id);
      return;
    }
    // Build agent (plus any workers it still owns). Drop the ROWS + close the panes FIRST so the
    // sidebar updates instantly — a build agent with N workers otherwise means N sequential git
    // worktree removals (~seconds each) before the row disappears, the "× closes the terminal but
    // the row lingers/comes back" report. removeAgent cascades to the workers and TOMBSTONES every
    // removed id (pendingLocalRemovals), so no disk reconcile or stale cross-window rehydrate can
    // resurrect a row while the worktrees are still being torn down below (sparkle-close-resurrect).
    const childIds = project.agents.filter((a) => a.parentId === id).map((a) => a.id);
    const allIds = [id, ...childIds];
    for (const cid of allIds) close(cid);
    removeAgent(project.id, id);
    reselectAfterClose(id);
    // Background: kill each PTY and remove each worktree. NOT awaited on the interaction path — the
    // rows are already gone; this only reclaims disk + processes. Sequential to avoid a git worktree
    // lock storm. Best-effort (the BRANCHES are intentionally kept — this is the "Save" outcome).
    void (async () => {
      for (const cid of allIds) {
        await killPty(cid).catch(() => {});
        await removeAgentWorkspace(project.rootPath, project.id, cid).catch(() => {});
      }
    })();
  };
  // The × button. A Build agent with unmerged work at risk gets the Ship/Save/Discard choice; every
  // other case (already merged, no real work, workers/think/shell) closes silently. See
  // engine/closeAgent.shouldPromptOnClose.
  const requestClose = (id: string) => {
    if (!project) return void teardownAgent(id);
    const agent = project.agents.find((a) => a.id === id);
    if (!agent) return;
    // Read branch/workflow FRESH from the store rather than the render-scope maps: AgentRow is now
    // memoized, so its `onClose` closure can be a few renders stale — the close-prompt decision must
    // reflect the live git state, not a snapshot (sparkle-alrm.3).
    const rt = useRuntimeStore.getState();
    const stage = resolveStage(rt.branchStatus[id], rt.workflowStage[id]);
    if (shouldPromptOnClose(agent.kind, stage, rt.branchStatus[id])) setClosePromptId(id);
    else void teardownAgent(id);
  };

  // ── Close-agent Ship / Save / Discard (sparkle-o341) ───────────────────────────────────────────
  const closingAgent = project?.agents.find((a) => a.id === closePromptId) ?? null;

  // Ship it: push + open a PR (review, not straight to main); local-land fallback when remoteless.
  // Orchestration (incl. the bead close/deliver + land-failure handling) lives in shipAgent so it's
  // unit-tested; here we just resolve the target, READ THE OUTCOME, and tear down after.
  //
  // THE OUTCOME IS NOT OPTIONAL READING (roborev 54225). shipAgent returns a discriminated
  // ShipOutcome and only `pr-opened` / `landed` mean the work went somewhere. This handler used to
  // discard it and call teardownAgent unconditionally, so `land-failed` (nothing happened at all)
  // and `pushed-no-pr` (branch is safe, no review open) both looked exactly like a shipped PR: the
  // tab and worktree vanished, the bead stayed untouched, and nothing said why. The concierge's
  // lifecycle.shipAgent has refused/reported on these since 54175 — this is the same path taken by
  // the button most people actually click, so it has to tell the same story.
  const onShipClose = async () => {
    const id = closePromptId;
    setClosePromptId(null);
    if (!id || !project) return;
    const agent = project.agents.find((a) => a.id === id);
    const target = project.defaultBranch ?? agent?.baseBranch ?? "main";
    const name = agent?.name || "this agent";
    let outcome: ShipOutcome;
    try {
      outcome = await shipAgent({
        root: project.rootPath,
        agentId: id,
        targetBranch: target,
        prTitle: agent?.name ?? "",
        beadId: agent?.beadId,
      });
    } catch (e) {
      // Only a PUSH failure throws — the branch never left the machine. Keep the agent, exactly as
      // lifecycle.shipAgent does; tearing down here removed the worktree over a failed ship.
      console.warn("ship-on-close failed (agent kept):", e);
      setCloseNotice({
        title: `Couldn’t ship “${name}”`,
        body: `Pushing the branch failed (${e instanceof Error ? e.message : String(e)}). I’ve left the agent open, so nothing is lost — its branch and worktree are exactly where they were.`,
      });
      return;
    }
    if (outcome.kind === "land-failed") {
      // No remote AND the local merge failed: the work is where it was. Same treatment as a throw.
      setCloseNotice({
        title: `Couldn’t ship “${name}”`,
        body: `This repo has no remote, and merging the branch into ${target} locally failed (${outcome.reason}). I’ve left the agent open, so nothing is lost.`,
      });
      return;
    }
    await teardownAgent(id);
    if (outcome.kind === "pushed-no-pr") {
      // The BRANCH is safe on the remote, so the teardown loses nothing — but there is no review
      // open and the bead is still in progress, and neither is guessable from a tab that vanished.
      setCloseNotice({
        title: `Pushed “${name}”, but no pull request was opened`,
        body: `The branch is on the remote, so nothing is lost — but nothing is under review either (${outcome.reason}). Open the pull request when you’re ready; the task stays open until you do.`,
      });
    }
  };

  // Save for later: back the branch up to the remote (best-effort), keep the bead; teardownAgent
  // removes the worktree but KEEPS the branch — exactly "save". The push is best-effort, so what it
  // DID comes back as a SaveOutcome: the button's promise ("keep the branch, backed up to the
  // remote") is half a claim about the network, made after the worktree is already gone (54225).
  const onSaveClose = async () => {
    const id = closePromptId;
    setClosePromptId(null);
    if (!id || !project) return;
    const name = project.agents.find((a) => a.id === id)?.name || "this agent";
    const save = await saveAgent(project.rootPath, id);
    // Every SaveOutcome is a success — the branch and the bead survive locally, which is what save
    // promises — so the teardown is unconditional. Only the sentence changes.
    await teardownAgent(id);
    if (!save.pushed) {
      setCloseNotice({
        title: `Saved “${name}” — but the branch wasn’t backed up`,
        body:
          save.kind === "no-remote"
            ? "This repo has no remote, so there was nowhere to push it. The branch (and its task) are kept, on this machine only."
            : `Pushing it to the remote failed (${save.reason}). The branch (and its task) are kept, on this machine only — push it yourself when you’re back online.`,
      });
    }
  };

  // Discard: drop the agent + its workers from the store, delete their worktrees + branches and ALL
  // their beads (workers carry their own). Behind an explicit confirm. Irreversible — never merged.
  const onDiscardClose = async () => {
    const id = closePromptId;
    setClosePromptId(null);
    if (!id || !project) return;
    const row = project.agents.find((a) => a.id === id);
    const children = project.agents.filter((a) => a.parentId === id);
    const ids = [id, ...children.map((a) => a.id)];
    const beadIds = [row?.beadId, ...children.map((a) => a.beadId)].filter(
      (b): b is string => !!b,
    );
    for (const cid of ids) close(cid);
    // Discard is the most explicit "destroy this" there is — every cloud sandbox under it goes too
    // (roborev 46881, 46918). The background loop below still runs killPty/removeAgentWorkspace for
    // cloud ids — harmless no-ops (no local PTY or worktree to reap).
    for (const a of [row, ...children]) void terminateIfCloud(a);
    await discardAgentGit({ root: project.rootPath, projectId: project.id, ids, beadIds });
    removeAgent(project.id, id);
    reselectAfterClose(id);
  };

  // NOTE: workers are deliberately NOT modal-prompted. A worker lives BELOW an orchestrator, which
  // owns its full lifecycle (spawn → integrate → spin down) so the human never has to think about,
  // or even know about, individual workers existing. The old "Close this worker?" nudge fired off a
  // sticky parent-reached-main watermark and popped up (often wrongly, while the orchestrator was
  // still pushing) over whatever pane was visible — exactly the intrusion this design avoids. Workers
  // are closed by the orchestrator's spin-down, or manually via a row's × (→ teardownAgent →
  // spinDownWorker). See CloseAgentPrompt below for the Build-agent Ship/Save/Discard choice, which
  // is still shown — but only on an explicit user close of a top-level agent, never auto-popped.
  // Manual reorder drag state. The id of the top-level agent currently being dragged by its grip;
  // dropping it on another row moves it to that row's slot in `project.agents`, which IS the order
  // rows render in within a stage section (see engine/buildSections.groupAgentsByStage).
  const reorderAgent = useProjectStore((s) => s.reorderAgent);
  const [dragId, setDragId] = useState<string | null>(null);
  // The ladder section the dragged row came FROM. Tracked alongside the id so every potential drop
  // target can decide, at hover time, whether it would accept this drag — that's what lets rows in
  // other sections stay visibly inert instead of lighting up and then silently rejecting the drop.
  const [dragSection, setDragSection] = useState<BuildSectionId | null>(null);
  const onAgentDragStart = (id: string, section?: BuildSectionId) => {
    setDragId(id);
    setDragSection(section ?? null);
  };
  const onAgentDragEnd = () => {
    setDragId(null);
    setDragSection(null);
  };
  // A drop is only honored WITHIN a stage section. Dragging across sections is refused rather than
  // applied, because a row's section is derived from its git state — dropping a PR-open agent into
  // "Local: Uncommitted" would have to either un-open its PR (absurd) or silently snap back, and a
  // control that silently undoes itself reads as broken. `dropSectionOf` lets the drop target tell
  // us which section the cursor is over; a cross-section drop just cancels the drag.
  const onAgentDrop = (targetId: string, targetSection?: BuildSectionId) => {
    // Skip a self-drop (released on the agent's own row) — a no-op move, so don't churn the store
    // for a drag that visually did nothing (roborev 13174/13175) — and skip a cross-section drop.
    if (dragId && project && dragId !== targetId && targetSection === dragSection) {
      reorderAgent(project.id, dragId, targetId);
    }
    onAgentDragEnd();
  };

  // Whether the agent list overflows its viewport. Drives where the "+ New … Agent" button lives:
  // a short list gets it BELOW the last row; once the list is tall enough to scroll, it pins to the
  // top (sticky) so it's always reachable without scrolling. The button occupies the same flow
  // height in either placement, so the comparison is placement-independent — no oscillation.
  const [listOverflows, setListOverflows] = useState(false);
  // Deliberately dep-less: content height changes whenever the row set re-renders, and the check is
  // one DOM read + a bail-out setState. Container-size changes that DON'T re-render React (window /
  // column resize) are caught by the ResizeObserver below.
  //
  // The rule's concern is an infinite chain of updates from a dep-less effect that setStates. The
  // bail-out below makes that impossible: `prev === next ? prev : next` returns the SAME reference
  // when the value is unchanged, so React bails out of the re-render and the loop cannot sustain
  // itself. Adding `[]` — the rule's suggested fix — would be wrong here: it would run the check
  // once on mount and never again, so the button placement would stop tracking the row set.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const sc = listScrollRef.current;
    if (!sc) return;
    const next = sc.scrollHeight > sc.clientHeight;
    setListOverflows((prev) => (prev === next ? prev : next));
  });
  useEffect(() => {
    const sc = listScrollRef.current;
    if (!sc || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const next = sc.scrollHeight > sc.clientHeight;
      setListOverflows((prev) => (prev === next ? prev : next));
    });
    ro.observe(sc);
    return () => ro.disconnect();
  }, []);

  // Gentle auto-scroll of the agent list so a bottom row's hover card is never clipped. The list's
  // scroll container is `listScrollRef` (attached to the overflow:auto div below). `baselineRef`
  // remembers where the user had the list before we auto-scrolled, so we can ease back on un-hover.
  // `autoTargetRef` (non-null while our own smooth scroll is settling) is how rows tell our scroll
  // apart from a user's. `restoreTimerRef` debounces the ease-back so cursor travel between adjacent
  // bottom rows doesn't bounce the column.
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const baselineRef = useRef<number | null>(null);
  const autoTargetRef = useRef<number | null>(null);
  const autoClearTimerRef = useRef<number | null>(null);
  const restoreTimerRef = useRef<number | null>(null);
  // Our smooth scroll fires a stream of scroll events; clear the "auto" flag once the container
  // actually reaches the target (or close enough), which also flips rows back to close-on-scroll.
  useEffect(() => {
    const sc = listScrollRef.current;
    if (!sc) return;
    const onScroll = () => {
      if (autoTargetRef.current != null && Math.abs(sc.scrollTop - autoTargetRef.current) <= 1) {
        autoTargetRef.current = null;
        if (autoClearTimerRef.current) {
          clearTimeout(autoClearTimerRef.current);
          autoClearTimerRef.current = null;
        }
      }
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => sc.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(
    () => () => {
      if (restoreTimerRef.current) clearTimeout(restoreTimerRef.current);
      if (autoClearTimerRef.current) clearTimeout(autoClearTimerRef.current);
    },
    [],
  );
  // Two-finger scroll must keep working while a hover card is open. The card is a fixed-position
  // portal on document.body, so wheel events over it never reach this list's overflow:auto
  // container — and since a card covers whatever row the cursor is on (and there's nearly always a
  // card), the list was effectively unscrollable. When the POINTER sits inside the list's box but
  // the wheel event is riding an overlay — the hover card, or document.body, where Chromium
  // retargets the remainder of a scroll gesture after the card under it unmounts — forward the
  // delta straight to the container. The resulting scroll event then closes the card via the rows'
  // own user-scroll handling, and hover re-evaluates on whatever row lands under the cursor.
  // Window-level so it survives the card's mid-gesture unmount, and a NATIVE passive:false
  // listener because forwarding must preventDefault (React registers onWheel passively) so a
  // scrollable card detail can't also consume the same delta.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const sc = listScrollRef.current;
      if (!sc) return;
      const r = sc.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      const t = e.target;
      if (t instanceof Node && sc.contains(t)) return; // over the list itself — native scroll owns it
      // Over the card's scrollable detail (a tall many-worker card) → let the CARD scroll its own
      // content natively instead of forwarding the delta to the column. Gated on it actually being
      // scrollable, so a short card still forwards to the list (keeps the list reachable under it).
      const detail = t instanceof Element ? t.closest("[data-hovercard-detail]") : null;
      if (detail instanceof HTMLElement && detail.scrollHeight > detail.clientHeight) return;
      const overCard = t instanceof Element && t.closest('[data-testid="agent-hover-card"]') != null;
      const orphaned = t === document.body || t === document.documentElement;
      if (!overCard && !orphaned) return; // some OTHER overlay (menu, modal) owns this wheel
      e.preventDefault();
      // A direct scrollTop write cancels any in-flight smooth reveal; drop the "auto" flag with it
      // so the rows treat the resulting scroll as the user's (close the card, keep their position).
      autoTargetRef.current = null;
      sc.scrollTop += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    };
    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => window.removeEventListener("wheel", onWheel, { capture: true });
  }, []);
  const sidebarScroll = useMemo<SidebarScrollApi>(() => {
    // Start a programmatic smooth scroll to `target`, marking it "ours" until the container reaches
    // it. A fallback timer drops the flag even if the animation is interrupted or never lands within
    // 1px, so a stuck flag can't misclassify the user's NEXT scroll as ours (roborev).
    const smoothScrollTo = (sc: HTMLDivElement, target: number) => {
      autoTargetRef.current = target;
      if (autoClearTimerRef.current) clearTimeout(autoClearTimerRef.current);
      autoClearTimerRef.current = window.setTimeout(() => {
        autoTargetRef.current = null;
        autoClearTimerRef.current = null;
      }, 700);
      sc.scrollTo({ top: target, behavior: "smooth" });
    };
    const clearRestoreTimer = () => {
      if (restoreTimerRef.current) {
        clearTimeout(restoreTimerRef.current);
        restoreTimerRef.current = null;
      }
    };
    return {
      containerRef: listScrollRef,
      scrollToReveal: (overflowPx: number) => {
        const sc = listScrollRef.current;
        if (!sc || overflowPx <= 0) return;
        clearRestoreTimer(); // a new reveal cancels a pending ease-back → one baseline across rows
        if (baselineRef.current == null) {
          // If an ease-back is still ANIMATING (its debounce already fired, so baseline was nulled),
          // the live scrollTop is a transient mid-animation value — capture the ease-back's TARGET
          // (autoTargetRef) instead, which is the user's true resting position.
          baselineRef.current = autoTargetRef.current ?? sc.scrollTop;
        }
        const maxScroll = Math.max(0, sc.scrollHeight - sc.clientHeight);
        const target = Math.min(sc.scrollTop + overflowPx, maxScroll);
        if (target <= sc.scrollTop) return; // already as far up as the list can go
        smoothScrollTo(sc, target);
      },
      restore: () => {
        clearRestoreTimer();
        restoreTimerRef.current = window.setTimeout(() => {
          restoreTimerRef.current = null;
          const sc = listScrollRef.current;
          const baseline = baselineRef.current;
          baselineRef.current = null;
          if (sc && baseline != null && Math.abs(sc.scrollTop - baseline) > 1) {
            smoothScrollTo(sc, baseline);
          }
        }, 90);
      },
      cancelRestore: clearRestoreTimer,
      abandonReveal: (abortInFlight = false) => {
        clearRestoreTimer();
        baselineRef.current = null;
        // CLEARING THE TIMER ONLY CANCELS AN EASE-BACK THAT HASN'T FIRED YET. Once restore()'s 90ms
        // debounce elapses it nulls the baseline ITSELF and starts smoothScrollTo, so from that
        // moment the two lines above are a no-op while the animation keeps gliding toward the old
        // baseline — and the animation outlives the debounce by far (roborev 53907). A direct
        // scrollTop write aborts an in-flight smooth scroll, the same trick the wheel handler above
        // uses.
        //
        // WHO IS CALLING decides whether we touch the offset, stated by the caller rather than
        // inferred (roborev 53940). An earlier revision gated on `autoTargetRef.current != null` as
        // a proxy for "a programmatic scroll is live", which fails both ways: that flag has a hard
        // 700ms fallback lifetime, so an ease-back outliving it (long distance, busy main thread
        // right after a spawn click, WebKit's slower curve) finds the flag already null and skips
        // the abort — silently restoring the bug this exists to fix.
        //
        //   - reveal path (abortInFlight): always abort. There may be an animation to kill.
        //   - hover-card user-scroll path: never write. It runs from INSIDE a live user gesture,
        //     and writing the scroll offset during trackpad momentum or Chromium's animated wheel
        //     scroll cancels it, stopping the user's flick dead. (It also returns early whenever
        //     isAutoScrolling(), so it could never have anything to abort in the first place.)
        if (abortInFlight) {
          const sc = listScrollRef.current;
          if (sc) {
            // Perturb, THEN restore. Writing the identical value back can be elided — engines
            // early-return from the scroll-offset setter on a zero delta, and during a smooth
            // scroll scrollTop reads the live animated offset — which would leave the animation
            // running and this whole abort doing nothing. The wheel handler's `+= delta` never has
            // that problem. Both writes land in one task, so nothing paints in between.
            const here = sc.scrollTop;
            sc.scrollTop = here + (here > 0 ? -1 : 1);
            sc.scrollTop = here;
          }
        }
        // Flag and its fallback timer are cleared TOGETHER, unconditionally. Splitting them (the
        // flag inside a guard, the timer outside) could drop the timer while leaving the flag set
        // forever — a stuck "this scroll is ours" state where cards stop closing on user scroll and
        // scrollToReveal captures a stale baseline, which is the exact failure that fallback timer
        // was added to prevent.
        autoTargetRef.current = null;
        if (autoClearTimerRef.current) {
          clearTimeout(autoClearTimerRef.current);
          autoClearTimerRef.current = null;
        }
      },
      isAutoScrolling: () => autoTargetRef.current != null,
    };
  }, []);
  // Keep the chevron coherent with what the main pane shows. The pane renders the SELECTED agent's
  // terminal, so the active mode must be Build whenever a real agent is selected — otherwise a
  // cross-mode select (Ask-Sparkle from a build terminal, a notification/history jump, or a
  // selection restored on boot) leaves the chevron pointing at Plan while that agent's terminal is
  // showing. It leaves Plan/Sparkle (activeSpecial) and the empty pane untouched. The chevron
  // handlers move selection in the other direction, so the two converge.
  useEffect(() => {
    const hasSelection = !!project?.agents.find((a) => a.id === project.selectedAgentId);
    const next = reconcileWorkMode(hasSelection, mode, activeSpecial !== null);
    if (next) setMode(next);
  }, [project, mode, activeSpecial, setMode]);
  // If Beads is turned off while the user is parked on the (now-hidden) Plan board, leave it — the
  // board won't render and the Plan chevron is gone, so a stuck empty state would result otherwise.
  // Also covers Plan mode without the board special, so no code path can strand the user in a Plan
  // mode they can't leave.
  useEffect(() => {
    if (beadsEnabled) return;
    if (activeSpecial === "board" || mode === "plan") {
      setActiveSpecial(null);
      setMode("build");
    }
  }, [beadsEnabled, activeSpecial, mode, setActiveSpecial, setMode]);
  // Top-level agents (group heads + orphaned workers), matching the list's isTopLevel logic, PLUS a
  // parentId→children bucket built in the SAME single pass. Both are memoized on `project` so a PTY
  // status tick (which never touches the agent SET, only runtimeStore.status) reuses them instead of
  // re-filtering every render — and the per-orchestrator worker lookup in the list below becomes an
  // O(1) map hit rather than an O(agents) `.filter` per top-level agent. Children keep project.agents
  // insertion order (identical to the old per-row `.filter`), so worker row order is byte-for-byte
  // unchanged. topLevelAgents is still used so the per-mode empty hints key off the SAME set the list
  // renders — never "No X agents" beside rows.
  const { topLevelAgents, childrenByParent } = useMemo(() => {
    if (!project)
      return {
        topLevelAgents: [] as AgentTab[],
        childrenByParent: new Map<string, AgentTab[]>(),
      };
    const childrenByParent = new Map<string, AgentTab[]>();
    for (const a of project.agents) {
      if (a.parentId) {
        const arr = childrenByParent.get(a.parentId);
        if (arr) arr.push(a);
        else childrenByParent.set(a.parentId, [a]);
      }
    }
    // The rule itself comes from engine/agentOrdering.isTopLevelAgent — the SAME predicate the
    // ladder's `topLevelOf` and the concierge feed's `topLevel` stamp use. It used to be re-spelled
    // inline here ("mirror orderedTopLevelAgents' rule"), which is precisely how the digest's count
    // and the column's rows are able to stop agreeing; there is one copy now.
    const topLevelAgents = project.agents.filter(isTopLevelAgent(project.agents));
    return { topLevelAgents, childrenByParent };
  }, [project]);

  // Which orchestrators have their worker subtree collapsed. Subscribed (not read via getState) so
  // a chevron click re-renders the list. A Set of the COLLAPSED ids, derived from the persisted
  // record, keeping uiStore's "absent → collapsed" default: an id is collapsed unless it is
  // explicitly `false`. Membership is what the row map tests, so the default lives in exactly one
  // expression rather than at every call site.
  const collapsedRecord = useUiStore((s) => s.collapsedOrchestrators);
  const collapsed = useMemo(() => {
    const out = new Set<string>();
    for (const a of project?.agents ?? []) {
      if (a.kind === "build" && collapsedRecord[a.id] !== false) out.add(a.id);
    }
    return out;
  }, [project?.agents, collapsedRecord]);
  const toggleOrchestratorCollapsed = useUiStore((s) => s.toggleOrchestratorCollapsed);

  // AUTO-EXPAND ON ATTENTION. collapsedOrchestrators reads a missing entry as COLLAPSED, and that
  // stays the default: a subtree opens by itself only when a worker under it enters the `needs_you`
  // band, and at no other time. It does NOT open on spawn — gaining a worker is not something that
  // requires the user, and popping every subtree on every spawn is what this replaced.
  //
  // Never auto-COLLAPSES when the red clears: yanking a subtree shut while the user is reading it is
  // worse than leaving it open. Expansion is automatic; collapsing stays the user's gesture.
  //
  // Driven off a snapshot COMPARISON rather than a status callback because a worker can turn red via
  // several paths (the live PTY map, reconcileWorkersFromDisk, cross-window adopt, the synthetic
  // overlays in engine/workerAttention), and because only a comparison can distinguish "just went
  // red" from "is still red" — re-asserting on a steady red would re-open a subtree the user just
  // collapsed. `effectiveStatus` is the status source, so a DISMISSED alarm is already de-escalated
  // and correctly re-opens nothing.
  // Starts EMPTY, and that is the whole first-mount story: expandOnWorkerAttention skips any id
  // absent from the previous snapshot, so the first pass records a baseline and expands nothing —
  // a relaunch with an already-red worker respects the persisted collapse (the head row shows that
  // red on its own). There is deliberately no second `first render?` guard here — one rule, in the
  // tested pure helper, rather than two that can drift. See engine/workerExpansion.
  //
  // Remembered PER PROJECT, for the same reason the selection map below is: one AgentSidebar stays
  // mounted across project switches, and the snapshot only ever covers the CURRENT project's agents.
  // With a single record, switching away drops every other project's entry, so coming back reads as
  // first observation — and since red is a level and not an edge, a worker that went red while you
  // were elsewhere would never open its subtree on any later tick either. That was invisible while
  // subtrees only ever opened; with auto-collapse below it means the subtree is shut and stays shut
  // on the one alarm that most needs to be seen. A map keyed by project id makes "did THIS project
  // just go red" the actual question, and an unvisited project still baselines and expands nothing.
  // Is a live PTY status still COMING for this worker? The third state of the attention snapshot
  // hangs off this: a worker with no status entry is `unknown` only while one is expected, and says
  // nothing at all otherwise. Two ways a reading is pending — the pane is mounted (in `openAgentIds`)
  // and simply has not reported yet, which is every worker for the first commit after launch; or the
  // worker is a spawned-but-unstarted STRAND, the open/evict race that drops it out of `openAgentIds`
  // before its pane mounts (engine/workerAttention.isUnstartedWorker — the same predicate that paints
  // its synthetic red, so the two can't disagree).
  //
  // A worker that is neither is a closed pane under a closed orchestrator — the settled fleet after a
  // relaunch that restored the rows but opened nothing. `runtimeStore` does not persist `status`, so
  // that worker is statusless for the WHOLE session; counting it as pending pinned its head open
  // forever, auto-collapse dead for that head with a mark that never cleared (roborev 54018).
  //
  // Note what the strand clause therefore does NOT cover, and deliberately: a materialized worker
  // whose pane is shut while its orchestrator is LIVE is not a closed pane, it is a strand — the app
  // paints it red and `ensureWorkersOpen` re-opens it. Its subtree stays open, which is the point:
  // that red row is the one the user has to click. If the self-heal exhausts its budget the subtree
  // stays open showing red, rather than filing a broken worker away out of sight (roborev 54031).
  const expectsLiveStatus = useCallback(
    (w: AgentTab) => openIds.has(w.id) || isUnstartedWorker(w, liveStatus, openIds, lastObserved),
    [openIds, liveStatus, lastObserved],
  );

  const prevWorkerAttention = useRef(new Map<string, Record<string, WorkerAttention>>());
  useEffect(() => {
    if (!project) return;
    const next = workerAttention(
      project.agents,
      (id) => effectiveStatus[id] ?? "stopped",
      (id) => liveStatus[id] !== undefined,
      expectsLiveStatus,
    );
    const attention = expandOnWorkerAttention(
      prevWorkerAttention.current.get(project.id) ?? {},
      next,
    );
    prevWorkerAttention.current.set(project.id, next);
    if (attention.length > 0)
      useUiStore.getState().expandOrchestrators(attention, { auto: true });
  }, [project, effectiveStatus, liveStatus, expectsLiveStatus]);

  // REVEAL THE SELECTION. Orthogonal to attention above: a SELECTED worker must always have a
  // visible row, or the terminal shows an agent that no row is highlighting — the original bug that
  // made workers get rows at all (see the header of AgentSidebar.workerRows.test.tsx). Spawning no
  // longer trips this, because spawnWorker's `select: false` never selects the new worker — under
  // ANY prior selection, including a null one (that flag is absolute; see AddAgentOpts.select, which
  // it briefly wasn't). This is the guard for every other way selection reaches a worker.
  //
  // Fires on a CHANGE of selection, not on the state of it, for the same reason as the attention
  // rule: a user who selects a worker and then collapses its subtree must stay collapsed, and
  // re-asserting every render would undo that gesture immediately. The first observation DOES count
  // here (unlike the attention baseline) — a relaunch that restores a worker selection must render
  // its row, and this opens the ONE subtree that holds it rather than all of them.
  //
  // Remembered PER PROJECT, not as one last-seen id, because exactly one AgentSidebar stays mounted
  // across project switches (Workspace renders it once with `project` as a prop). With a single ref,
  // leaving project A and coming back reads as two selection changes and the return trip re-expands
  // a subtree the user had deliberately collapsed — even though A's selection never moved. A map
  // keyed by project id makes "did THIS project's selection change" the actual question. It is
  // bounded by the number of projects.
  //
  // The entry is written only once the agent RESOLVES, so a selection naming an id not yet in
  // `project.agents` (a cross-window adopt landing after the selection) is still revealed when its
  // record arrives, instead of being dropped for good.
  const selectedAgentId = project?.selectedAgentId ?? null;
  const revealedSelection = useRef(new Map<string, string | null>());
  useEffect(() => {
    if (!project) return;
    const seen = revealedSelection.current;
    if (seen.has(project.id) && seen.get(project.id) === selectedAgentId) return;
    const sel = project.agents.find((a) => a.id === selectedAgentId);
    // Not resolvable yet — leave the map alone so the arriving record still gets its reveal.
    if (selectedAgentId !== null && !sel) return;
    seen.set(project.id, selectedAgentId);
    if (sel?.kind === "worker" && sel.parentId) {
      // `auto`, like the attention rule: the reason this subtree opened is that you are looking at
      // the worker inside it, so once you look elsewhere the reason is spent. Auto-collapse exempts
      // the subtree holding the selection, so this can never be undone while it is still true.
      useUiStore.getState().expandOrchestrators([sel.parentId], { auto: true });
    }
  }, [selectedAgentId, project]);


  // PUT IT AWAY AGAIN. The counterpart to the two rules above, and the end of the one-way expansion
  // that let a settled fleet leave a wall of green worker rows with no undo but a chevron click per
  // orchestrator. A subtree the APP opened closes once nothing under it needs you — never the one you
  // are reading, and never one you opened yourself. The rule and its exemptions are pure and tested
  // in engine/workerExpansion.autoCollapseTargets; this is the wiring.
  //
  // Its own effect rather than a tail on the attention effect, and the deps are the reason: closing
  // has to react to the SELECTION moving (navigating away from a subtree is what releases it) and to
  // the mark changing, neither of which that effect watches — and it must not re-run the expansion's
  // edge detector, which would consume a rising edge as a side effect of a selection change. The
  // snapshot is recomputed rather than shared for the same reason; it is one pure pass over `agents`.
  //
  // Acts on the CURRENT snapshot with no baseline of its own, which is only safe because that
  // snapshot distinguishes `calm` from `unknown`: a subtree with any worker the PTY has not reported
  // on reads `unknown` and is left alone. Without that third state this effect closed every
  // persisted auto mark on the first commit after launch — the status map is still empty then — and
  // flapped a subtree shut-and-open on every round of the open/evict race (roborev 53994).
  const autoExpandedRecord = useUiStore((s) => s.autoExpandedOrchestrators);
  useEffect(() => {
    if (!project) return;
    const attention = workerAttention(
      project.agents,
      (id) => effectiveStatus[id] ?? "stopped",
      (id) => liveStatus[id] !== undefined,
      expectsLiveStatus,
    );
    const stale = autoCollapseTargets(
      project.agents,
      attention,
      (headId) => autoExpandedRecord[headId] === true,
      project.selectedAgentId,
    );
    if (stale.length > 0) useUiStore.getState().collapseAutoExpanded(stale);
  }, [project, liveStatus, effectiveStatus, autoExpandedRecord, expectsLiveStatus]);

  // The stage ladder the list renders: top-level rows bucketed into workflow-stage sections, in
  // `project.agents` order within each section (that order is the user's own drag arrangement), with
  // rows whose status band is filtered off removed and any section thereby emptied dropped entirely.
  //
  // NOTE what is NOT here: any sort. A row's vertical position is a function of its workflow STAGE
  // and nothing else, which is the whole point — see engine/buildSections.ts for why the old
  // attention sort was removed. `effectiveStatus` is still read, but only to decide VISIBILITY (the
  // filter) and the row's dot COLOR, never its position.
  // The ONE stage per top-level row, used by BOTH the ladder section and the row's own progress
  // tracker. An orchestrator that delegates rolls up its workers (overall = the LEAST-advanced
  // worker, since the whole thing isn't done until every unit is); with no workers it is just its
  // own git stage.
  //
  // These were two different values until roborev 53371: the section used the orchestrator's OWN
  // git state while the tracker used the worker roll-up, so for any delegating orchestrator they
  // disagreed BY CONSTRUCTION — a head with no commits of its own sat under "Local: Uncommitted"
  // ("closing this agent loses them") while the bar on that very row showed its workers at "In PR".
  // The section is the load-bearing new claim about where the work got to, so two adjacent signals
  // contradicting each other undercut the whole feature.
  const headStageOf = useCallback(
    (id: string): WorkflowStageId => {
      const kids = childrenByParent.get(id) ?? [];
      const rollup = rollupStages(kids.map((w) => resolveStage(branchStatus[w.id], workflowStage[w.id])));
      return rollup ? rollup.stage : resolveStage(branchStatus[id], workflowStage[id]);
    },
    [childrenByParent, branchStatus, workflowStage],
  );

  // THE ONE ROLLUP. Every surface that asks "what color is this row, and which chip finds it?" goes
  // through here: the disc in renderRow, the ladder's filter, and the chip counts. The stage-ladder
  // work already recorded that this column has THREE places that independently know how to build
  // the ladder and that they drift; a rolled-up dot filtered by its own raw status would be that
  // failure in its purest form — a row painted red that the "Needs you" chip cannot find.
  //
  // Only `kind: "worker"` children count, matching engine/workerExpansion.workerAttention: they are
  // the only children that render as rows, so a nested shell must not tint its parent's disc.
  // ONE composition, shared with publishedStatusFor — see rollupViewFor. This used to assemble the
  // `own` map, the dismissed set and the in-motion predicate inline, which was a second copy of that
  // chain and therefore a second thing to keep in step. A slip in the copy (reading `effectiveStatus`
  // where the pre-dismissal map is required, which returns null for every dismissed agent) would
  // have made the column band differently from every other surface with no test failing.
  const { own: ownStatus, dotOf: rollupOf } = useMemo(
    () =>
      rollupViewFor(project?.agents ?? [], liveStatus, new Set(openAgentIds), lastObserved, (id) =>
        resolveStage(branchStatus[id], workflowStage[id]),
      ),
    // `graceTick` is deliberate: this memo runs step (0) with an internally-sampled clock, and for a
    // held `errored` agent none of the other deps ever change again — so the row's disc and its
    // "Needs you" chip would stay gray `new` while `status` above had already gone red. The two
    // disagreeing inside one component is exactly what this shared tick exists to prevent
    // (roborev 54830).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project?.agents, liveStatus, openAgentIds, lastObserved, branchStatus, workflowStage, graceTick],
  );
  const rowBandOf = useCallback((id: string) => bandOfRollup(rollupOf(id)), [rollupOf]);

  const sections = useMemo(
    () =>
      project
        ? groupAgentsByStage(
            topLevelOf(project.agents, mode),
            headStageOf,
            (id) => effectiveStatus[id] ?? "stopped",
            statusFilter,
            rowBandOf,
          )
        : [],
    [project, effectiveStatus, mode, headStageOf, statusFilter, rowBandOf],
  );
  // The flat rendered order, used for the empty-state check and by anything that needs "the rows,
  // top to bottom" without caring about section boundaries.
  const ordered = useMemo(() => flattenSections(sections), [sections]);

  // Every row id the column actually renders, top to bottom — heads plus the workers of any head
  // that is open. Exists to pick the column's ONE tab stop (roving tabindex): the tree is a single
  // stop, and arrow keys move within it, rather than every agent and worker being its own stop and
  // making Tab walk the whole fleet to reach the terminal.
  //
  // Computed as a list, not a Set, because "the first rendered row" is the fallback when nothing is
  // selected — and it has to be the FIRST one, not an arbitrary member.
  const renderedRowIds = useMemo(() => {
    const ids: string[] = [];
    for (const top of ordered) {
      ids.push(top.id);
      if (!collapsed.has(top.id)) {
        for (const w of childrenByParent.get(top.id) ?? []) ids.push(w.id);
      }
    }
    return ids;
  }, [ordered, collapsed, childrenByParent]);
  // The selected row if it is on screen, else the first row. Never null while any row renders, so
  // the column can't become unreachable by keyboard just because selection points at a filtered-out
  // or folded-away agent.
  const tabStopId = useMemo(() => {
    const sel = project?.selectedAgentId;
    if (sel && renderedRowIds.includes(sel)) return sel;
    return renderedRowIds[0] ?? null;
  }, [project?.selectedAgentId, renderedRowIds]);

  // ── THE PINNED IMPROVE SPARKLE ROW'S VIEW MODEL ────────────────────────────────────────────────
  //
  // ONE PIPELINE, NOT TWO — and note that every line below is COPIED FROM `renderRow`, verbatim,
  // with `a.id` replaced by `sparkleAgentId`. That is deliberate and it is the whole requirement:
  //   `effectiveStatus[id] ?? "stopped"`                     → the row's status (`st`)
  //   `rollupOf(id)`                                         → the disc, via engine/workerRollup
  //   `bandOfRollup(...)` vs `bandOfStatus(ownStatus[id])`   → does the rollup override the label
  //   `bandOfRollup(...)`                                    → which filter chip finds it
  // The row used to hold its own copy of this logic, so a fix to status derivation — the
  // picker/approval-footer detection, say — landed on every build row and silently missed this one.
  // That is how it came to render GREEN while sitting on an unanswered four-option picker. Sharing
  // the pipeline means it inherits such fixes by construction; do NOT reintroduce a local
  // derivation here or in SparkleAgentRow.
  //
  // Both maps work for an id that is not in `project.agents`. `effectiveStatus`'s overlays only
  // rewrite ids they find in the agent list and pass every other key through, and `ownStatus` (from
  // rollupViewFor) is the same chain minus the worker bubbles — so this id resolves to its live PTY
  // status with or without a project open, and `?? "stopped"` is the row's pre-spawn state.
  //
  // `ownStatus`, NOT `sparkleStatus`, on the override line. They differ exactly when a worker's red
  // has been bubbled onto this row, which is the case the override exists to describe — comparing
  // the bubbled status against itself makes the two bands agree by construction and the override
  // never fires. rollupDotAccessor's `ownStatusOf` note documents this trap at length; it is easy to
  // write the wrong one and nothing else goes red when you do.
  //
  // Workers: the same `kind === "worker" && parentId` rule the column uses — `rollupOf` buckets them
  // itself, so this list is only for the `+N` badge. The improvement pass runs a single agent today,
  // so it is empty; derived rather than hardcoded so a future subtree needs nothing added here.
  const sparkleWorkerCount = useMemo(
    () =>
      (project?.agents ?? []).filter(
        (a) => a.kind === "worker" && a.parentId === sparkleAgentId,
      ).length,
    [project?.agents, sparkleAgentId],
  );
  const sparkleStatus = effectiveStatus[sparkleAgentId] ?? "stopped";
  const sparkleRollup = rollupOf(sparkleAgentId);
  const sparkleBand = bandOfRollup(sparkleRollup);
  const sparkleRollupOverrides =
    sparkleBand !== bandOfStatus(ownStatus[sparkleAgentId] ?? "stopped");

  // Per-band counts for the filter chips. Counted over the UNFILTERED top-level rows on purpose: a
  // chip must keep showing how many rows it would reveal while it is toggled OFF, otherwise a
  // hidden band reads "0" and the user has no idea anything is behind it.
  //
  // TWO COUNTS, because they answer two different questions. `agentBandCounts` is the project's own
  // rows and is what the empty-state logic below reasons about; `bandCounts` adds the pinned
  // Improve Sparkle row and is what the chips render. Folding Improve Sparkle into the first would
  // make a project with no agents report "All agents are hidden by the status filter" — a way back
  // from a filter nobody applied.
  const agentBandCounts = useMemo(() => {
    const counts: Record<StatusBand, number> = { needs_you: 0, running: 0, done: 0 };
    if (!project) return counts;
    for (const a of topLevelOf(project.agents, mode)) {
      // Same rollup the row's disc and the ladder's filter use. A chip counting raw statuses while
      // the filter counts rollups would report a number that doesn't match what clicking it reveals.
      counts[rowBandOf(a.id)] += 1;
    }
    return counts;
  }, [project, mode, rowBandOf]);
  // A RED IMPROVE SPARKLE HAS TO INCREMENT THE RED CHIP. The chips are the column's summary of
  // "what wants me" — the header tally people read instead of scanning — so a row that can go red
  // while the tally says 0 is the same defect as a collapsed worker that doesn't count: the number
  // claims nothing needs you when something does.
  //
  // The row is counted but NEVER HIDDEN by the filter. Every other row a chip hides is reachable
  // again by turning the chip back on; this one is the only way into the improvement agent, and it
  // is pinned precisely so it is always there. A chip that counts a row it cannot hide is a small
  // inconsistency; a filter that can make the Improve Sparkle agent unreachable is a bigger one.
  const bandCounts = useMemo(() => {
    if (!showSparkleRow) return agentBandCounts;
    return { ...agentBandCounts, [sparkleBand]: agentBandCounts[sparkleBand] + 1 };
  }, [agentBandCounts, showSparkleRow, sparkleBand]);
  // Did the FILTER (rather than an empty project) hide everything? Drives which empty state shows —
  // "you filtered everything out, here's the way back" vs "you have no agents yet".
  const hiddenByFilter =
    ordered.length === 0 && Object.values(agentBandCounts).some((n) => n > 0);

  // NOTE: a SECOND filter used to live here — the helper island's P0/P1 `attentionTierFocus`,
  // which narrowed this same list by `conciergePriority`. It was removed when the island's chiclets
  // were rewired to drive `statusFilter` directly (the chips above), because two independent stores
  // deciding "which rows does the Build column show" is a race with no winner. The island now
  // ISOLATES a band through the same state the chips render, so its effect is visible in the chip
  // bar rather than being an invisible mode you can only exit via a special dismiss chip.

  // The active mode's "+ New Build Agent" button (null in Plan / no project).
  // Rendered in ONE of two slots in the scroll container below, chosen by listOverflows.
  const newAgentButton =
    project && mode === "build" ? (
      // A fragment, not a wrapper element: both placement slots are already flex columns, and the
      // button must stay THEIR direct child (the sticky/below-the-list placement is asserted on the
      // button's parent). The toggle renders null unless cloud is enabled, so a local-only sidebar
      // is byte-for-byte the same tree as before.
      <>
        <NewAgentRuntimeToggle />
        <NewBuildAgentButton onClick={spawnBuildAgent} dataHint="newbuild" />
      </>
    ) : null;

  return (
    <SidebarScrollContext.Provider value={sidebarScroll}>
    {/* The in-flow SLOT. Only exists in overlay mode, where the column itself has left the flow:
        it holds the column's old width so the terminal beside it does not reflow (and does not
        re-measure its PTY) just because the panel popped out. Empty and inert by construction. */}
    {overlay && (
      <div
        data-testid="agent-sidebar-slot"
        aria-hidden
        style={{ width, flex: "0 0 auto", height: "100%" }}
      />
    )}
    <div
      data-testid="agent-sidebar-column"
      data-overlay={String(overlay)}
      style={{
        width,
        flex: "0 0 auto",
        position: "relative",
        background: C.deepForest,
        // THE LINE IS GONE BECAUSE SOMETHING HAS TO FLOW THROUGH THIS SEAM. The active agent row
        // is painted in `forest`, the terminal's own colour, so it reads as an opening INTO the
        // pane it selects, and the concave fillets below shape that opening. A 1px rule here cuts
        // straight across it: the row docks against the line instead of bleeding through, and the
        // fillets curve into nothing. See the seam rule beside the plane tokens in theme/colors —
        // it is "does anything cross this boundary", not "how big is the step".
        //
        // The rule was added in the first place because the black-and-gold repaint had flattened
        // this pair to almost nothing — a boundary with neither a fill step nor a line, so it
        // stopped existing. Blueprint re-derives the ramp and the pair is a real step again, which
        // is what makes an undrawn seam viable. (No ratio quoted here on purpose: the last two
        // review rounds were spent on ratios written into comments that then went stale.)
        //
        // THIS COMMENT HAS OVERCLAIMED THE GUARD TWICE, AND THE SECOND TIME IS WORTH RECORDING.
        // First it said chromeContrast asserted the step when the only assertions naming the pair
        // were CEILINGS (`toBeLessThan`) — nothing held it up (roborev 54215). The correction cited
        // a band, "≥ PLANE_MIN_SPLIT … < CHROME_MIN_CONTRAST". That floor no longer exists:
        // `PLANE_MIN_SPLIT` was DELETED, because the approved direction's own planes measure
        // 1.069–1.194 and would fail it — separation here is by LINE WEIGHT, not by fill.
        //
        // So the honest statement is that there is no floor under this seam by design, and none is
        // wanted. What holds the pair up instead is fidelity: both values are ported verbatim from
        // the spec (theme/blueprintSpec.ts) and blueprintSpec.test.ts fails on byte drift, so the
        // step cannot go flat without failing a diff against the design itself.
        borderRight: "none",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        // OVERLAY MODE: the same element, lifted out of flow and laid over the terminal. Absolute
        // against the ②+③ wrapper, whose content box starts exactly where this column starts — so
        // left/top/bottom 0 reproduces the docked anchor with no measurement, and the spacer below
        // holds the slot so nothing beside it reflows.
        ...(overlay
          ? {
              position: "absolute" as const,
              left: 0,
              top: 0,
              bottom: 0,
              height: "auto",
              width: OVERLAY_WIDTH,
              // See components/layers.ts: above the (isolated) terminal stage, below Plan mode's
              // board. Both sides of that ordering live in that one module.
              zIndex: SIDEBAR_OVERLAY_Z,
              boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
            }
          : null),
      }}
    >
      {/* THE SEAM: this column's edge against the terminal stage. It is a 1px `hairline` rule and
          it is drawn HERE, as the column's first positioned child at `right: 0`, rather than as
          the column's `border-right`. The position is the whole point.

          A `border-right` sits OUTSIDE the padding box, so nothing inside the column can paint on
          it — the rule ran unbroken down the full height, including across the SELECTED row. That
          row is supposed to read as an opening onto the terminal: it fills with the terminal's own
          `C.forest`, squares its right corners, extends `marginRight:-8` to eat the list's padding
          and reach this edge, and flares into the stage with the concave fillets below. A rule
          across that edge cancels the effect — the row stops bleeding and starts butting against a
          drawn line. The founder reported exactly that, and it is a regression from ea1b7bd93,
          which turned this edge from `forest` (a seam matching the terminal, i.e. invisible) into
          `hairline` (a visible rule) for roborev 53551. That finding was right about the general
          case and wrong about this one pixel column.

          Moving the rule one pixel INWARD — into the last 1px of the padding box — resolves both.
          The hairline still marks the app's most prominent structural boundary everywhere the
          rows don't reach (idle rows stop 8px short of it), so 53551 stays fixed. But the ACTIVE
          row's fill now overlaps this element's 1px and, being a later positioned sibling in tree
          order, paints OVER it — so the seam breaks exactly across the selected row and the bleed
          is restored, with no geometry to measure and nothing to keep in sync while scrolling.

          Consequences of that choice, so they aren't "fixed" back later:
            • This must stay the column's FIRST child and must NOT take a z-index, AND the agent row
              must stay `position: relative`. All three are what put the rows above it. The last one
              is the least obvious and the most fragile: a NON-positioned block's background paints
              in step 4 of the painting order, which is BELOW positioned `z-index: auto` elements
              (step 8) — so a row that lost `position: relative` would go back under this rule and
              the reported regression would return silently. The row carries it for the fillets and
              the drop target too, which is exactly why it looks safe to move.
            • The column's OUTER width is unchanged. `index.css` sets `* { box-sizing: border-box }`
              globally and this column has an explicit `width`, so the border was always inside that
              box — dropping it doesn't narrow the column, it widens the CONTENT box by the 1px the
              border used to occupy. That extra pixel is the one the active row's `-8` now laps, and
              it is why the hover card's measured `colW` is unaffected. Do NOT "compensate" with
              `width + 1`: that WOULD shift the terminal and re-break the geometry.
            • The pull-tab / overlay button cluster at `right: 0` covers the seam for its own
              height. It is a chrome shape with its own `hairline` outline sitting on the edge, so
              the boundary is still drawn there — by the tab instead of by this rule. */}
      <div
        aria-hidden
        data-testid="sidebar-terminal-seam"
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          width: 1,
          height: "100%",
          background: C.hairline,
          pointerEvents: "none",
        }}
      />
      {/* The brand chrome that used to top this column — the Sparkle.ai logo, the voice waveform
          under it, and the remaining-credit badge — now tops column ①, the concierge, which is
          mounted for the life of the app rather than only while a project is open
          (PRD/sparkle/concierge-chrome-and-credits.md). The last thing left in that row was a
          "Show Helper" button, deleted along with the island's Hide Helper (§6); with nothing to
          hold, the row itself is gone rather than conditional, and the Plan/Build toggle is now
          the top of this column. */}

      {/* ── `.bhd` — THE COLUMN HEADER ────────────────────────────────────────────────────────────
          One band, `--hd-h` tall, with a bottom hairline: Build/Plan segment · spacer · the status
          filter chips. Straight from rev4.html:

            .bhd{display:flex;align-items:center;gap:8px;height:var(--hd-h);padding:0 10px;
                 flex:0 0 auto;border-bottom:1px solid var(--k-hair);…}
            .bhd .sp{flex:1}

          TWO THINGS MOVED HERE, and the second one is the point. The Plan/Build strip was the top
          of the column with a bare 20px gap above it, floating rather than banded — the gap existed
          only to stop it welding to ProjectTabsBar. A header with its own bottom rule solves that
          by being a band instead of by holding empty space, so the gap is gone rather than kept.
          And the STATUS FILTER CHIPS were the first thing inside the SCROLLING list, which meant
          the control that decides what the list shows scrolled away from the list it governs. In
          the header they are always on screen, which is what makes them usable as the single filter
          mechanism (see below).

          EXACTLY ONE FILTER MECHANISM. An earlier iteration had a header pill and per-column chips
          each hiding rows with their own CSS, and they disagreed: the pill hid the green rows while
          the green chip still read ON, so the controls lied about the view. The chips are the only
          thing in this column that hides anything; anything global must DRIVE them rather than
          filter alongside them. rev4.html carries the same warning in its own CSS.

          NOT BUILT: the mock's hover-only `.pm` (`+`/`−`) beside the chips, which duplicates the
          PAIR onto the free side. `Workspace` renders one sidebar and one terminal stage — there is
          no second pair for it to create, and pane mounting is keyed per project/agent so making
          one is real work (MAPPING.md's own gap #3). A visible control that cannot do anything is
          worse than an absent one; see PRD/sparkle/blueprint-agent-sidebar.md. */}
      {project && (
        <div
          data-testid="build-column-header"
          style={{
            display: "flex",
            alignItems: "center",
            // THE BAND WRAPS, and it has to. The chip bar is the only item here with a real shrink
            // share — the mini segment is `0 0 auto` (~80px) and the spacer's basis is 0 — so
            // without this the bar absorbs the entire deficit: at the sidebar's MIN_WIDTH of 160
            // it is handed ~42px, narrower than ONE chip, and every chip lands on its own line with
            // `Reset` (nowrap, unshrinkable) overflowing a container that sets no overflow. That is
            // strictly worse than where the bar came from, where it had the full list width.
            // Wrapping here lets it drop to a full-width second line under the segment instead.
            flexWrap: "wrap",
            gap: 8,
            flex: "0 0 auto",
            // minHeight, not height: the band grows by a line when the bar wraps rather than
            // letting the chips spill through the rule below. `--hd-h` is the UNFILTERED width-wise
            // case — the height the two columns' headers line up at across the seam.
            minHeight: BUILD_HEADER_H,
            padding: "0 10px",
            borderBottom: `1px solid ${C.hairline}`,
          }}
        >
          <PlanBuildToggle
            variant="mini"
            mode={mode}
            beadsEnabled={beadsEnabled}
            onPickPlan={onPickPlan}
            onPickBuild={onPickBuild}
          />
          {/* `.bhd .sp` — the spacer that pushes the chips to the pane-side end. */}
          <span aria-hidden style={{ flex: 1, minWidth: 0 }} />
          {/* Hidden in Plan (no rows to filter) and when the project has no top-level agents at all
              — three dead controls over an empty-state hint is worse than no controls. */}
          {mode !== "plan" && ordered.length + (hiddenByFilter ? 1 : 0) > 0 && (
            <StatusFilterBar
              counts={bandCounts}
              visible={statusFilter}
              onToggle={toggleStatusBand}
              onReset={showAllStatusBands}
            />
          )}
        </div>
      )}

      {/* The full-text search bar that used to sit here is GONE. It now lives in column ① as the
          concierge command palette (Concierge/CommandPalette.tsx), which reads and writes the SAME
          historyStore query — so this was a second input onto one piece of state, taking permanent
          vertical space above the list for a search most people reach by keyboard. The
          HistorySearch MODULE stays: the palette imports `relativeTime` and `renderSnippet` from
          it, and its own comments already called this mount the legacy one. */}

      {/* NO role="tree" on this element. It was here for one commit and that was wrong: a tree may
          only own `treeitem`s and `group`s, and this scroll container also holds the sticky
          "+ New Agent" button, the StatusFilterBar chips, the stage section headers and the
          empty-state text — i.e. the fix for role="button" reintroduced the same class of problem
          one level up, this time swallowing the only agent-creation control. The tree is an INNER
          wrapper around the rows alone (below). */}
      <div
        ref={listScrollRef}
        data-testid="agent-list-scroll"
        // `LIST_PAD_X`, NOT a literal 8. Every row's `marginRight: -LIST_PAD_X` exists to eat
        // exactly this padding and land on the column's edge, and `ROW_PAD_RIGHT` pays it back —
        // three values that are only correct together. Typed separately, changing this to `0 12px`
        // leaves every row 4px short of the seam (the active row's fill stops lapping the seam
        // element, and the fillets flare from a shape that no longer touches the pane) with the
        // geometry tests still green, because they read the row's own margin and never this.
        // rowGeometry now asserts the two agree.
        style={{ flex: 1, overflowY: "auto", padding: `0 ${LIST_PAD_X}px` }}
      >
        {/* Per-mode "+ New … Agent" affordance — the only way to create agents now that the chevrons
            are a selector. Plan has none (no agents in Plan). Placement is dynamic (listOverflows):
            a list short enough to fit gets the button BELOW its last row; a list tall enough to
            scroll pins it here at the top (sticky) so it's always visible. The sticky wrapper is a
            flex column (margins can't collapse through it) with the sidebar background so rows
            scrolling underneath never show through the button's transparent fill/margins. */}
        {newAgentButton && listOverflows && (
          <div
            style={{
              ...NEW_AGENT_SLOT_STYLE,
              position: "sticky",
              top: 0,
              // Above the rows' drag drop-target overlays (zIndex 2), so a drop released over the
              // pinned button can't land on a hidden row's target underneath it.
              zIndex: 3,
              background: C.deepForest,
            }}
          >
            {newAgentButton}
          </div>
        )}
        {/* The status-band filter USED TO BE HERE, as the first thing inside the scroll container.
            It moved into the `.bhd` column header above: a control that governs which rows the list
            shows must not scroll away with the list. Nothing replaces it here — do not add a second
            one, that is the two-disagreeing-filters bug the header's note describes. */}
        {(() => {
          if (!project) return null;
          if (mode === "plan") return null; // Plan: sidebar list stays clear (board shows in main pane)
          // The stage ladder: one group per NON-EMPTY workflow-stage section, top to bottom, each
          // with a header and its rows in the user's drag order. Sections with no visible rows are
          // absent entirely (groupAgentsByStage drops them), so the column shows only the rungs that
          // currently have work on them.
          //
          // Selection is tracked by id (project.selectedAgentId), so a row changing section never
          // changes which agent is open. Nested workers stay under their parent in insertion order.
          // THE TREE STARTS HERE, wrapping ONLY the rows — never the filter chips, the new-agent
          // button or the empty states, which are not treeitems and which AT drops or misannounces
          // inside a tree.
          //
          // Each stage section is a `group`, which is what a tree may own besides treeitems. The
          // visible StageSectionHeader is aria-hidden and the group carries the same text as its
          // aria-label instead: the header is a heading, not a treeitem, so leaving it exposed
          // inside the tree would be the same invalid-content problem in miniature.
          return (
            <div role="tree" aria-label="Build agents" data-agent-tree>
          {sections.map((section) => (
            <div
              key={section.id}
              data-testid={`stage-section-${section.id}`}
              role="group"
              aria-label={section.meta.label}
            >
              <div aria-hidden>
                <StageSectionHeader meta={section.meta} count={section.rows.length} />
              </div>
              {section.rows.map((top) => {
            // O(1) lookup into the memoized parentId→children bucket (built once above), in place of
            // an O(agents) `.filter` per orchestrator. Same set, same insertion order — see childrenByParent.
            const workers = top.kind === "build" ? childrenByParent.get(top.id) ?? [] : [];
            // (A `rollup`/`workerStages` pair used to be computed here and never read — the head's
            // stage comes from headStageOf below, which does its own roll-up. Removed rather than
            // renamed to `_rollup`: it was a second, drifting answer to a question already owned by
            // headStageOf, and roborev 53371 is what happens when two of those disagree.)
            //
            // The per-worker view-model, still built here where stageOf/status/branchStatus/
            // shippedOf are in scope. It feeds the head's hover-card detail blocks; each worker's
            // own ROW is rendered separately below from `childrenByParent`.
            const workerDetails = workers.map((w) => {
              const wst = status[w.id] ?? "stopped";
              const wcolor =
                AGENT_STATUS[wst].color === AGENT_STATUS.done.color
                  ? C.agentIdle
                  : AGENT_STATUS[wst].color;
              return {
                id: w.id,
                name: w.name,
                autoTitle: w.autoNameVariants?.title?.trim() || null,
                description: w.autoNameVariants?.description?.trim() || "",
                stage: stageOf(w.id) as WorkflowStageId | null,
                status: wst,
                statusColor: wcolor,
                branchStatus: branchStatus[w.id],
                shipped: shippedOf(w.id),
                worktreePath: w.worktreePath,
                baseBranch: w.baseBranch,
                active: !activeSpecial && project.selectedAgentId === w.id,
                onLand: () => onLand(w),
                onOpen: () => onSelect(w.id),
              };
            });
            const renderRow = (
              a: (typeof project.agents)[number],
              trackerStage: WorkflowStageId | null,
              // Which ladder section this row is rendered in. Passed down so a drop target can tell
              // a same-section reorder (honored) from a cross-section drag (refused — a row's
              // section is derived from git state, not something a drag may change).
              rowSection?: BuildSectionId,
            ) => {
          // The EFFECTIVE status (dismissed reds de-escalated) drives the whole row's appearance —
          // color, glyph, tooltip — so a dismissed row reads calm. The TRUE status is read separately
          // below only to decide the Dismiss/Re-enable button state.
          const st = effectiveStatus[a.id] ?? "stopped";
          const trueSt = status[a.id] ?? "stopped";
          // Resolve the status color to a light-mode-legible TEXT ink: the brand gray (idle,
          // blocked, done, stopped) and the brand green (working) are too light on the white
          // light sidebar, so statusInk darkens both in light mode while keeping them brand-color
          // in dark; red/amber pass through. (See statusInk — it tracks the AGENT_STATUS taxonomy.)
          const color = statusInk(AGENT_STATUS[st].color);
          // The alert toggle to show on this row's expanded card: "dismiss" when it's truly red and
          // not yet dismissed, "reenable" when red-underneath but dismissed, null otherwise.
          const alertControl = alertControlKind(a.alert, trueSt);
          const isActive = !activeSpecial && project.selectedAgentId === a.id;
          const bs = branchStatus[a.id];
          // The ✓ on the head row reflects the whole build: itself OR any worker that has shipped.
          const rowShipped =
            shippedOf(a.id) || (a.id === top.id && workers.some((w) => shippedOf(w.id)));
          // Indent by tree position, not by parentId: the group head (top) sits at depth 0 and its
          // nested workers at 1. (Workers are never top-level heads — orderedTopLevelAgents filters
          // them out — so a head is always a build/think orchestrator.)
          const depth = a.id === top.id ? 0 : 1;
          // THE HEAD'S DISC REPORTS ITS SUBTREE, not just its own PTY. Subtrees are folded by
          // default, so a head is usually standing in for rows you cannot see — and an orchestrator
          // idling while three of its workers sit blocked rendered GRAY, i.e. "nothing to do here",
          // with the fold hiding everything that disagreed. See engine/workerRollup for the law
          // (grey ignored; red+green → orange; the head's OWN red wins outright).
          //
          // Only when the rollup DISAGREES with the row's own band does the disc get overridden.
          // Agreeing cases keep the row's own status label, which is strictly more specific —
          // "Blocked" tells you more than "Workers need you".
          // HEADS ONLY. A worker row has no subtree to summarize, and running one through this
          // anyway mislabelled it: a stranded worker reads `approval` in `st` (the unstarted-worker
          // overlay) but `stopped` in `ownStatus` (which strips that overlay), so the bands differed,
          // the override fired, and the row hovered as "Workers need you" — a worker with no
          // workers, having lost the "Approve?" that tells you to start it.
          //
          // Compared against the head's OWN band, not `st`: `st` is already bubbled, so a head with
          // one red worker reads red there, matches the rollup's band, and the override never fires.
          // That would leave the orange case invisible and every rolled-up head hovering as whatever
          // red the overlay guessed rather than "Workers need you".
          const isHead = a.id === top.id;
          const rollup = isHead ? rollupOf(a.id) : rollupDot(st, []);
          const rollupOverrides =
            isHead && bandOfRollup(rollup) !== bandOfStatus(ownStatus[a.id] ?? "stopped");
          return (
            <AgentRow
              key={a.id}
              project={project}
              a={a}
              depth={depth}
              isActive={isActive}
              st={st}
              statusColor={color}
              isTabStop={a.id === tabStopId}
              dotColor={rollupOverrides ? ROLLUP_DOT_COLOR[rollup] : undefined}
              dotLabel={rollupOverrides ? rollupLabel(rollup) : undefined}
              alertControl={alertControl}
              onDismissAlert={() => dismissAlert(project.id, a.id, trueSt)}
              onReenableAlert={() => reenableAlert(project.id, a.id)}
              bs={bs}
              trackerStage={trackerStage}
              shipped={rowShipped}
              workerCount={a.id === top.id ? workers.length : 0}
              workers={a.id === top.id ? workerDetails : []}
              // The disclosure only belongs on a head that HAS workers; a childless row would show
              // a control that toggles nothing. Children never carry one (no grandchildren).
              subtreeCollapsed={
                a.id === top.id && workers.length > 0 ? collapsed.has(top.id) : null
              }
              onToggleSubtree={() => toggleOrchestratorCollapsed(top.id)}
              rowSection={rowSection}
              dragSection={dragSection}
              dragActive={dragId != null}
              onDragStartAgent={onAgentDragStart}
              onDragEndAgent={onAgentDragEnd}
              onDropAgent={onAgentDrop}
              editing={editing === a.id}
              setEditing={setEditing}
              onSelect={() => onSelect(a.id)}
              onLand={() => onLand(a)}
              onClose={() => requestClose(a.id)}
            />
          );
            }; // end renderRow

            // The orchestrator's own chevron — the SAME headStageOf the ladder bucketed this row
            // by, so the section header and the bar under it can never tell different stories
            // (roborev 53371). Shell agents have no git workflow → no tracker (null).
            const headStage: WorkflowStageId | null =
              top.kind === "shell" ? null : headStageOf(top.id);
            // Every worker gets its OWN indented row under its orchestrator, revealed by the head's
            // chevron. Hiding workers was tried and abandoned: five surfaces each leaked them
            // independently (PRD/sparkle/hide-worker-agents-from-sidebar.md), and a worker with no
            // row is unreachable and unattributable — a spawn moves selection to the new worker, so
            // the terminal would show an agent no row is highlighting.
            //
            // The children are rendered HERE, inside the head's own section wrapper, rather than
            // fed through the ladder. That is not a style choice: groupAgentsByStage buckets PER
            // ROW by workflow stage, so a worker at a different stage than its parent would be
            // torn out of the subtree and filed under another section header. topLevelAgents is
            // therefore left excluding workers, and row position stays a pure function of the
            // PARENT's stage plus insertion order — the invariant engine/agentOrdering.ts warns
            // about at length.
            //
            // Children are likewise NOT re-filtered by the status-band chips. The chips decide
            // which top-level rows the ladder shows; applying them again per child would leave an
            // expanded parent with an empty subtree, or hide a working worker under a visible head.
            const kids = collapsed.has(top.id) ? [] : workers;
            return (
              // A FRAGMENT, not a wrapper div. An anonymous div here would sit between the section's
              // `group` and its `treeitem`s, so the group would own generic content — the same "a
              // tree may own only treeitems and groups" rule this structure exists to satisfy, one
              // level down (roborev 53891).
              <Fragment key={top.id}>
                {renderRow(top, headStage, section.id)}
                {/* The subtree is a `group` that the head OWNS BY ID (aria-owns on the row). It is a
                    DOM sibling because nesting it inside the row's div would put the worker rows
                    inside their parent's box and wreck the layout; aria-owns is the standard way to
                    state the relationship when the visual tree can't nest. Without it the head's
                    aria-expanded describes nothing and the workers read as items of the SECTION,
                    one level up from their actual parent.
                    Rendered only when there ARE children: an empty group inside a tree is something
                    a screen reader announces and then finds nothing in. */}
                {kids.length > 0 && (
                  <div
                    id={subtreeDomId(top.id)}
                    role="group"
                    aria-label={`Workers for ${top.name}`}
                  >
                    {kids.map((w) => renderRow(w, stageOf(w.id)))}
                  </div>
                )}
              </Fragment>
            );
              })}
            </div>
          ))}
            </div>
          );
        })()}
        {/* Default placement: below the last row, when the list fits without scrolling. (When it
            doesn't fit, the sticky top slot above renders the button instead.) Same wrapper as the
            sticky slot minus the pinning, so the button adds the same height either way. */}
        {newAgentButton && !listOverflows && (
          <div style={NEW_AGENT_SLOT_STYLE}>{newAgentButton}</div>
        )}
        {/* Everything hidden by the FILTER, not by an empty project. Distinct from the "no agents
            yet" hint below, and it offers the way back — a user who has toggled all three chips off
            sees an empty column, and without this has to work out that they did it to themselves. */}
        {project && mode === "build" && hiddenByFilter && (
          <div style={{ color: C.muted, fontSize: 12, padding: "2px 10px 10px", lineHeight: 1.5 }}>
            All agents are hidden by the status filter.{" "}
            <button
              onClick={showAllStatusBands}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                font: "inherit",
                color: C.accent,
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              Show all
            </button>
          </div>
        )}
        {/* Empty hint: the dashed "+ New Build Agent" row above is the call to action. */}
        {project && mode === "build" && topLevelAgents.length === 0 && (
          <div style={{ color: C.muted, fontSize: 12, padding: "2px 10px 10px", lineHeight: 1.5 }}>
            No Build agents yet — use <strong>+ New Build Agent</strong> above to start one.
          </div>
        )}
        {!project && (
          <div style={{ color: C.muted, fontSize: 12, padding: 10, lineHeight: 1.5 }}>
            Create a project to add agents.
          </div>
        )}
      </div>

      {/* THE VERY BOTTOM OF THE COLUMN, and deliberately outside the scroll container that closes
          just above. The row therefore sits below every stage group AND below "+ New Build Agent"
          (which lives inside that container, either pinned at its top or after its last row), takes
          no group header of its own, and does not scroll away with the list.
          That position is the ENTIRE expression of "this one is different" — it works on Sparkle
          itself, not the user's project, and it can't be closed. Everything else about it is a
          build row (see SparkleAgentRow), including the status derivation feeding it here. */}
      {showSparkleRow && (
        <SparkleAgentRow
          active={activeSpecial === "sparkle"}
          status={sparkleStatus}
          dotColor={sparkleRollupOverrides ? ROLLUP_DOT_COLOR[sparkleRollup] : undefined}
          dotLabel={sparkleRollupOverrides ? rollupLabel(sparkleRollup) : undefined}
          workerCount={sparkleWorkerCount}
          onSelect={onSelectSparkle}
        />
      )}

      {/* Support-ticket status banner: shows the user's OPEN tickets (Submitted / Responded).
          Renders nothing when there are none. Sits between Improve Sparkle and the footer. */}
      <SupportTicketRow />

      {/* (The old bottom-left StatusBar — version popover / changelog / support — is gone: that
          chrome now lives in the top-right kebab menu, see Concierge/KebabMenu.tsx.) */}

      {/* Ship / Save / Discard, shown when closing a Build agent with unmerged work at risk. */}
      {closingAgent && (
        <CloseAgentPrompt
          agentName={closingAgent.name || "this agent"}
          unsaved={!!branchStatus[closingAgent.id]?.dirty}
          onShip={onShipClose}
          onSave={onSaveClose}
          onDiscard={onDiscardClose}
          onCancel={() => setClosePromptId(null)}
        />
      )}

      {/* What that choice actually DID, when it wasn't what the button promised (roborev 54225):
          a ship that landed nowhere (agent kept), a push with no PR behind it, a save that never
          reached the remote. Same ModalShell chrome + zIndex as the prompt it replaces, so the
          outcome lands where the human is already looking instead of in a console nobody reads. */}
      {closeNotice && (
        <ModalShell width={460} zIndex={200} onCancel={() => setCloseNotice(null)}>
          <div style={{ fontSize: TYPE.title, fontWeight: FONT_WEIGHT.bold, marginBottom: 8 }}>
            {closeNotice.title}
          </div>
          <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.5, marginBottom: 20 }}>
            {closeNotice.body}
          </div>
          <button
            onClick={() => setCloseNotice(null)}
            style={{
              background: "transparent",
              color: C.accent,
              border: `1px solid ${C.accent}`,
              borderRadius: 6,
              padding: "9px 18px",
              cursor: "pointer",
              fontSize: TYPE.body,
              fontWeight: FONT_WEIGHT.semibold,
              fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
            }}
          >
            Got it
          </button>
        </ModalShell>
      )}

      {/* THE TWO PULL TABS on the right edge (§10). Left boundary only — this is the one column
          boundary that gets them.

          1. RESIZE — the full-height 6px `col-resize` strip. It reflows the layout: the column
             takes the space, the terminal gives it up.
          2. OVERLAY — pops this column OUT as a floating panel over the terminal instead, leaving
             the layout alone (an in-flow spacer holds the slot). The SAME button docks it back,
             and it rides on the panel itself, so the overlay can never hide its own way out.

          They are stacked vertically and each carries its own accessible name and title, so they
          read as two distinct controls rather than two mystery grey strips.

          zIndex: the sticky "+ New Build Agent" wrapper is zIndex 3 but stops 8px shy of this edge
          (the scroll container's padding), so the 6px strip never actually fought it. The overlay
          tab is wider than that 8px gap, so both tabs are lifted ABOVE 3 rather than left to rely
          on two pixels of clearance.

          The resize strip is suppressed while floating: the panel's width is derived from the
          viewport, not dragged, so a drag there would silently move a boundary you can't see. */}
      {!overlay && (
        <div
          onMouseDown={startResize}
          onKeyDown={onResizeKey}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the agent column"
          aria-valuenow={width}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          tabIndex={0}
          title="Drag to resize the agent column (or focus it and use ← →)"
          data-testid="sidebar-resize-tab"
          style={{
            // Kept fully inside the column (right:0) so the 6px hit area can't intercept
            // clicks on the adjacent panel's left edge.
            position: "absolute",
            top: 0,
            right: 0,
            width: 6,
            height: "100%",
            cursor: "col-resize",
            zIndex: 4,
          }}
        />
      )}
      <div
        style={{
          position: "absolute",
          right: 0,
          top: "50%",
          transform: "translateY(-50%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 6,
          zIndex: 5,
          // The WRAPPER is inert; only the button below re-enables pointer events. It sits above
          // the resize strip (zIndex 5 vs 4) and is wider than the grip inside it, so without this
          // it swallows the mousedown over the one part of the resize tab a user can actually SEE
          // — the grip — and the visible affordance becomes the single dead spot on the edge.
          // Caught in the browser (the grip looked fine and did nothing); jsdom cannot hit-test.
          pointerEvents: "none",
        }}
      >
        {/* The grip: pure signage for the strip behind it, so the resize tab is VISIBLE and not
            just a 6px band of nothing. pointerEvents:none — every drag belongs to the strip. */}
        {!overlay && (
          <div
            aria-hidden
            data-testid="sidebar-resize-grip"
            style={{
              width: 4,
              height: 28,
              marginRight: 1,
              borderRadius: 3,
              background: C.hairline,
              pointerEvents: "none",
            }}
          />
        )}
        <button
          type="button"
          onClick={toggleOverlay}
          aria-pressed={overlay}
          aria-label={
            overlay
              ? "Dock the agent column back into the layout"
              : "Pop the agent column out over the terminal"
          }
          title={
            overlay
              ? "Dock the agent column back into the layout"
              : "Pop the agent column out over the terminal"
          }
          data-testid="sidebar-overlay-tab"
          style={{
            // Also kept fully inside the column, for the same reason as the strip: a tab hanging
            // over the terminal would eat clicks meant for the terminal's left edge.
            width: 14,
            height: 34,
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            // Re-enabled against the inert wrapper above — this button is the ONLY interactive
            // thing in the cluster; everything else falls through to the resize strip.
            pointerEvents: "auto",
            border: `1px solid ${C.hairline}`,
            borderRight: "none",
            borderRadius: "4px 0 0 4px",
            background: C.barSurface,
            color: overlay ? C.accentInk : C.muted,
          }}
        >
          {overlay ? <FiChevronsLeft size={11} /> : <FiChevronsRight size={11} />}
        </button>
      </div>
    </div>
    </SidebarScrollContext.Provider>
  );
}

// The leading glyph slot is a fixed height so the glyph AND the title beside it sit at the exact
// same spot whether the card is collapsed or expanded — on hover the card only grows DOWNWARD,
// so the eye never sees the pickaxe or title jump. Module-level so the elapsed timer can match it.
const GLYPH_SLOT_H = 20;
// Depth indent (px) per nesting level. Set so a WORKER's status disc lands exactly where its
// parent's TITLE begins: a head row's title starts at padding-left(10) + disc slot(24) + gap(8) =
// 42px, and a child at marginLeft(32) + its own padding-left(10) puts its disc at that same 42px.
// The subtree therefore reads as a hanging indent off the parent's text rather than as a second,
// arbitrary column. Changing the disc slot or the row padding means changing this too.
const DEPTH_INDENT = 32;

// DOM id of a head's worker `group`. One function so the row's aria-owns and the group's own id
// cannot drift — a mismatched pair is a dangling reference that reads as no relationship at all.
const subtreeDomId = (headId: string) => `agent-subtree-${headId}`;

// The row box. Named because the hover card has to reproduce them EXACTLY (minus its own border)
// to stand over a row without anything jumping — see the card strip's padding.
const ROW_PAD_Y = 4;
const ROW_PAD_X = 10;

// ── THE ROW ANATOMY, SHARED WITH THE PINNED IMPROVE SPARKLE ROW ───────────────────────────────
// Improve Sparkle is not a project agent — it has no AgentTab, so it cannot go through AgentRow —
// but it IS a row in this column and has to read as one. It used to be styled by hand, and drifted:
// a bigger disc, a different left inset, its own font size, its own progress bar. These constants
// are the contract. AgentSidebar.sparkleRow.test.tsx asserts the two rows agree on every one of
// them by measuring BOTH rows in a rendered sidebar, so a change here that lands in only one of
// the two call sites goes red.
//
// Width of the leading disc slot on a build/worker row (a shell row's ▶ takes a narrower one). The
// disc is CENTERED in it, so this — not the padding alone — is what fixes the disc's left edge.
const DOT_SLOT_W = 24;
// Diameter of the status disc on a row (StatusDot's own default 9 is for the TopBar cluster).
const DOT_SIZE = 12;

// The agent list's own horizontal padding (`agent-list-scroll`), and therefore exactly how far a
// row has to reach BACK to touch the column's edge. Named rather than typed twice because the
// row's margin and its compensating padding both depend on it and must move together.
const LIST_PAD_X = 8;

// ── GEOMETRY BELONGS TO EVERY ROW, NEVER ONLY THE SELECTED ONE ─────────────────────────────────
//
// `.row` in the mock carries the pane-side margin; `.row.on` changes only what is PAINTED. The
// version this replaces put `marginRight: isActive ? -8 : 0` on the row, which meant the row's
// CONTENT BOX narrowed by 8px the instant you selected it — so the title under the pointer jumped
// ~10px on click and jumped back on the next row. The founder reported the list twitching every
// time they changed agents; this is that bug, and it is a layout property masquerading as a
// selection style.
//
// The fix is the mock's: every row runs to the seam and every row pays the same padding back, so
// the ink sits at a constant inset from the column's edges in all states. See MAPPING.md,
// "Row geometry belongs to `.row`, never to `.row.on`" — `padding compensates margin one-for-one
// instead of just changing it` is the exact instruction, and it is why ROW_PAD_RIGHT exists rather
// than the row simply keeping `ROW_PAD_X` on both sides.
const ROW_PAD_RIGHT = ROW_PAD_X + LIST_PAD_X;

// ── THE MOUTH IS 26 × 9, NOT 9 × 9 ─────────────────────────────────────────────────────────────
//
// `--r-delta` (9px) is the fillet's RISE and `--m-run` (26px) is its RUN. It is not a square, and
// the founder rejected the square: a circular 9×9 corner-round is 78% quarter-disc, so it packs the
// whole flare into the last ~4px before the seam. The near-white build column (`deepForest`, the
// spec's `--k-bridge`) therefore ran flush beside the row right up to the pane and stopped in a
// rounded stub — two pale claws pinching the row where it enters the terminal. That is the "white
// lines shouldn't be there when rounded" report: nothing stray, just a corner-round doing what a
// corner-round does.
//
// Stretched to 26 × 9 the same arc leaves the row's edge with a HORIZONTAL tangent (flush with the
// row) and meets the seam with a VERTICAL one (flush with the column boundary), so it is smooth at
// both ends and the bank sweeps out of frame instead of hooking back. Same colours, same anchor,
// same 9px rise — only the run is longer. 26 is `--grid-step`; the mock records that 38 reads melty.
const ACTIVE_FILLET = 9;
const ACTIVE_FILLET_RUN = 26;

// ── THE SELECTED ROW'S GEOMETRY, IN ONE PLACE ─────────────────────────────────────────────────
// The active row's corners: square on the PANE side (it opens into the terminal — the mouth below
// does that work) and rounded on the concierge side; fully rounded when it isn't selected.
//
// Named, because two rows draw it: a build/worker row and the pinned Improve Sparkle row. They were
// literals in both for one commit, which is the one-sided-drift hazard the rest of the row anatomy
// was consolidated to remove — changing one leaves the other on the old geometry with every test
// green. AgentSidebar.sparkleRow.test.tsx compares the two rows' computed radius and mouth paint
// directly, so a change has to land here to satisfy both.
//
// `RADIUS.modal`, not a literal: a stray `10` is both off-scale (theme/scale.test.ts is a ratchet at
// 0) and the kind of local re-derivation blueprintSpec.ts exists to end. The mock's leading radius
// is `--r-lead: 10px` and RADIUS tops out at 6 (`modal`); this holds at the token and the missing
// step is reported rather than hard-coded.
const ACTIVE_ROW_RADIUS = `${RADIUS.modal}px 0 0 ${RADIUS.modal}px`;
const IDLE_ROW_RADIUS = RADIUS.modal;

/** THE MOUTH: a concave fillet where a selected row opens into the pane — NOT a corner.
 *
 *  A `border-radius` curves the corner IN. It cuts material away, so the row NECKS DOWN as it
 *  reaches the pane — the exact opposite of what a junction should do. A mouth curves OUT, the way a
 *  river opens into a delta: the channel widens and the bank sweeps away from it. NO radius value
 *  produces that at any size; it is a different construction, and the distinction cost ~20 review
 *  rounds (MAPPING.md, "Geometry vocabulary"). If a review says "rounded the wrong way / backwards",
 *  changing the number is not converging.
 *
 *  The construction, straight from the mock's `--m-tr` / `--m-br`: an `--m-run` × `--r-delta` box
 *  sitting just above / below the row at its pane-side end, filled with the PANE's colour, with an
 *  ELLIPTICAL quadrant bitten out of the corner FURTHEST from the junction — `radial-gradient(ellipse
 *  farthest-side at <far corner>, transparent 0 calc(100% - .5px), <pane> 100%)`. Read it as "inside
 *  the ellipse → transparent, so the build column shows through; outside → pane colour". It rounds
 *  the BUILD COLUMN's corner away from the row, never the row's own.
 *
 *  `farthest-side` is what makes the box's own dimensions the radii, so the 26 × 9 shape falls out of
 *  `width`/`height` rather than being restated. The `-0.5px` is the mock's antialias feather: without
 *  it the gradient's hard stop lands on a pixel boundary and the arc renders as a stair.
 *
 *  The two documented ways to make a CORRECT mouth invisible, so neither is re-diagnosed as bad
 *  geometry: an ancestor `overflow:hidden` clipping the overhang, and the pane painting over it
 *  because it is later in the DOM (needs z-index on the columns). Both live outside this file — see
 *  PRD/sparkle/blueprint-agent-sidebar.md.
 *
 *  `pointerEvents:none` so they never eat clicks; `aria-hidden` since they are pure chrome. The
 *  caller positions them by making its own box `position: relative`, and is responsible for any
 *  suppression rule of its own (the build row hides them behind its open hover card). */
function ActiveFillets() {
  return (
    <>
      <div
        aria-hidden
        data-testid="row-mouth-top"
        style={{
          position: "absolute",
          top: -ACTIVE_FILLET,
          right: 0,
          width: ACTIVE_FILLET_RUN,
          height: ACTIVE_FILLET,
          background: `radial-gradient(ellipse farthest-side at top left, transparent 0 calc(100% - .5px), ${C.forest} 100%)`,
          pointerEvents: "none",
        }}
      />
      <div
        aria-hidden
        data-testid="row-mouth-bottom"
        style={{
          position: "absolute",
          bottom: -ACTIVE_FILLET,
          right: 0,
          width: ACTIVE_FILLET_RUN,
          height: ACTIVE_FILLET,
          background: `radial-gradient(ellipse farthest-side at bottom left, transparent 0 calc(100% - .5px), ${C.forest} 100%)`,
          pointerEvents: "none",
        }}
      />
    </>
  );
}

// What a rolled-up disc is painted. The three definite marks reuse the AGENT_STATUS tier colors
// straight (NOT statusInk — that resolves a color to a legible TEXT ink, and this is a filled
// shape), so a rolled-up green is pixel-identical to a working agent's own dot rather than a near
// miss. `mixed` is the one color with no status behind it; see theme/colors mixedInk.
const ROLLUP_DOT_COLOR: Record<RollupDot, string> = {
  green: AGENT_STATUS.working.color,
  red: AGENT_STATUS.waiting.color,
  gray: AGENT_STATUS.idle.color,
  orange: C.mixedInk,
};

// Format an elapsed duration (ms) for the sidebar timer: integer seconds while under 100s (each
// second is visible there), then minutes / hours / days each to one decimal with a trailing ".0"
// stripped (so 2 minutes reads "2m", 1.5 reads "1.5m"). Pure + exported for testing.
export function formatElapsed(ms: number): string {
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  if (ms < 100 * SEC) return `${Math.floor(ms / SEC)}s`;
  const oneDp = (n: number) => {
    const s = n.toFixed(1);
    return s.endsWith(".0") ? s.slice(0, -2) : s;
  };
  if (ms < 100 * MIN) return `${oneDp(ms / MIN)}m`;
  if (ms < 24 * HOUR) return `${oneDp(ms / HOUR)}h`;
  return `${oneDp(ms / DAY)}d`;
}

/**
 * One ticking clock per agent row. Returns a `now` (epoch ms) that advances every 1s while the
 * agent has been idle under 100s (where each second matters) and relaxes to a 5s beat after that.
 * Owned ONCE by the row and shared by BOTH the collapsed and the hover-overlay ElapsedTimer, so the
 * elapsed count is identical in both — going on/off hover never swaps to a second timer with its own
 * out-of-phase clock, which previously made the count visibly jump backward (read as a spurious
 * "reset"). `since` is the user's last interaction; null means no timer, so the interval is skipped.
 */
export function useRowClock(since: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  const fast = since != null && now - since < 100_000;
  useEffect(() => {
    if (since == null) return;
    // Only tick while the window is actually visible. A hidden/backgrounded window has no one
    // watching the elapsed counter, so a per-second (or 5s) re-render there is pure wasted work and
    // wakeups — with many rows it adds up. The interval pauses when the document is hidden and
    // resumes (catching the clock up immediately) on the visibilitychange back to visible.
    const visible = () =>
      typeof document === "undefined" || document.visibilityState === "visible";
    let id: ReturnType<typeof setInterval> | undefined;
    const startTicking = () => {
      if (id == null) id = setInterval(() => setNow(Date.now()), fast ? 1000 : 5000);
    };
    const stopTicking = () => {
      if (id != null) {
        clearInterval(id);
        id = undefined;
      }
    };
    const onVisibility = () => {
      if (visible()) {
        setNow(Date.now()); // catch up the (frozen-while-hidden) clock the instant we're shown
        startTicking();
      } else {
        stopTicking();
      }
    };
    if (visible()) startTicking();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      stopTicking();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [fast, since]);
  return now;
}

/**
 * Presentational elapsed counter: shows how long since `since` (the user's last interaction with the
 * agent — a composer Send or terminal keystroke) given the row's shared `now`. The value resets only
 * when `since` advances (a new prompt/keystroke), never on hover. Takes the agent's status color so
 * the counter matches the name (green / red / gray); tabular-nums so it never jitters as digits
 * change. Stateless by design — the ticking clock lives in useRowClock so both render sites agree.
 */
function ElapsedTimer({ since, now, color }: { since: number; now: number; color: string }) {
  return (
    <div
      data-testid="row-elapsed"
      style={{
        flex: "0 0 auto",
        height: GLYPH_SLOT_H,
        display: "flex",
        alignItems: "center",
        // `.row .el{font:var(--t-micro) var(--k-mono);color:var(--k-faint)}` — the mock's own rule.
        // It was 12px system-ui, i.e. the same face and nearly the same size as the NAME beside it,
        // so the row's two spans read as one run of text with a number in front. Mono at 10px is
        // what makes the elapsed value read as an instrument reading rather than as part of the
        // title, and it is the same treatment the stage chip and the group headers take.
        fontFamily: FONT_MONO,
        fontSize: TYPE.micro,
        color,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {formatElapsed(Math.max(0, now - since))}
    </div>
  );
}

/**
 * `.stg` — the row's stage chip. The mock:
 *
 *   .row .stg{font:var(--t-micro) var(--k-mono);color:var(--k-muted);
 *             border:1px solid var(--k-hair-solid);border-radius:var(--r-sm);padding:1px 5px}
 *   .row.on .stg{border-color:rgba(125,150,180,.4);color:var(--k-term-muted)}
 *
 * BORDERED, NOT FILLED, and near-square (`--r-sm` = 3px). That is the design's thesis applied to
 * the smallest object in the column — *structure is drawn, not filled* — and it is why this is not
 * one more coloured pill: a filled chip on every row would be a second wall of colour beside the
 * status dots, which is the treatment the column has already been walked back from twice.
 *
 * The text is `stageMeta(stage).short` — "Unsaved", "Saved", "Pushed", "In PR" — the same strings
 * the mock shows, which is not a coincidence: the mock was drawn from this ladder.
 *
 * It answers a different question from the group header above it. The header says which RUNG the
 * section is; the chip says where this row sits, which matters because a row can be read out of
 * order (scrolled past its header, or pulled up in a filtered view) and because the two disagree
 * for a head whose stage rolls up from its workers.
 */
function StageChip({ stage, active }: { stage: WorkflowStageId; active: boolean }) {
  const meta = stageMeta(stage);
  return (
    <span
      data-testid="row-stage-chip"
      title={meta.detail}
      style={{
        flex: "0 0 auto",
        fontFamily: FONT_MONO,
        fontSize: TYPE.micro,
        lineHeight: 1,
        // `--k-muted`. NOT the stage's own colour: the column's rule is that status never colours a
        // row's text, and a per-stage hue here would put ten of them down one column.
        color: C.muted,
        // TWO PLANES, TWO EDGE TOKENS — and BOTH are themed, which the first cut was not.
        //
        // Idle row: `--k-hair-solid`, which is `pillFill` here (theme/colors maps it straight from
        // BLUEPRINT[mode].hairSolid), so this is the spec value exactly.
        //
        // ACTIVE row: the row is painted the TERMINAL's colour, so the chip is no longer sitting on
        // the build column at all and the column's edge token is the wrong one for it. The mock
        // swaps to `rgba(125,150,180,.4)` there; that shipped here as a literal for one commit and
        // it was wrong twice — it is theme-blind (one alpha, applied in both themes, from a
        // dark-mode mock) and `chromeContrast` / `blueprintSpec` cannot sweep a literal. It takes
        // `TERM_HAIRLINE` now (components/terminalChrome.ts) — `BLUEPRINT[mode].termHair`, the
        // spec's own edge FOR THE TERMINAL PLANE, which is precisely what this chip is now sitting
        // on. `chromeContrast.test.ts` floors that token against the terminal plane specifically,
        // so unlike the literal it is actually swept.
        //
        // Measured on `forest`, so the next person does not have to re-derive it: `termHairline` is
        // 1.222:1 light / 1.480:1 dark, against the idle chip's 1.332 / 1.583 on the column. So the
        // chip holds roughly its weight across the two planes, which is what the mock's swap is
        // for — but note it does not get STRONGER in light, and no token in the set would: in light
        // `forest` (#d9e3f3) sits inside the hairline band, so every candidate lands between 1.12
        // and 1.22. Making this edge read on the light terminal plane needs a token that does not
        // exist; reported in PRD/sparkle/blueprint-agent-sidebar.md. The chip's MEANING never rode
        // on the border — its ink is `muted`, 4.756:1 on `forest` in light and 7.764 in dark.
        border: `1px solid ${active ? TERM_HAIRLINE : C.pillFill}`,
        borderRadius: RADIUS.sm,
        padding: "1px 5px",
        whiteSpace: "nowrap",
      }}
    >
      {meta.short}
    </span>
  );
}

// The minimal per-worker view-model an orchestrator row needs to render its workers itself: one
// bare indented progress line per worker collapsed, and a stacked Location/Status/Progress block
// per worker in the hover overlay. Computed in AgentSidebar (where stageOf/status/branchStatus are
// in scope) and threaded down so workers share the orchestrator's single hover target. `onLand`
// fires the same merge as a standalone worker row's green pill did. `[]` for non-orchestrator rows.
type WorkerDetail = {
  id: string;
  name: string;
  autoTitle: string | null;
  description: string;
  stage: WorkflowStageId | null;
  status: AgentTabStatus;
  statusColor: string;
  branchStatus?: BranchStatus;
  shipped: boolean;
  worktreePath: string | null;
  baseBranch: string | null;
  /** True when this worker is the selected tab, so its inline line reads as open. */
  active: boolean;
  onLand: () => void;
  /** Select + open this worker (its inline named line and hover-card name are clickable). */
  onOpen: () => void;
};

// A worker's name inside the orchestrator's hover card. Clicking it opens the worker in the main
// pane. stopPropagation keeps the click off the card's own onClick (which selects the orchestrator).
function WorkerNameButton({ w }: { w: WorkerDetail }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${w.autoTitle || w.name}`}
      title="Open this sub-agent"
      onClick={(e) => {
        e.stopPropagation();
        w.onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          w.onOpen();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        minWidth: 0,
        lineHeight: 1.3,
        cursor: "pointer",
        textDecoration: hover ? "underline" : "none",
      }}
    >
      <span style={{ color: w.statusColor, fontSize: 12, fontWeight: FONT_WEIGHT.semibold }}>
        {w.autoTitle || w.name}
      </span>
      {w.description && (
        <span style={{ color: w.statusColor, fontSize: 12, fontWeight: FONT_WEIGHT.regular }}>
          {`:  ${w.description}`}
        </span>
      )}
    </div>
  );
}

// The worker whose title/progress best represents the whole build for the collapsed head row: the
// LEAST-ADVANCED worker — the same one the head's rollup progress bar reflects — so the promoted head
// title and that bar describe the same piece of work. A null stage sorts as "not started" (fraction
// 0). Ties break to the FIRST worker in insertion order: the strict `<` below only replaces `rep` on
// a STRICTLY smaller fraction, so equal-fraction workers keep the earliest one. Returns null for an
// empty list. Used to auto-promote an orchestrator's generic "Build N" name to describe the real work.
function representativeWorker(workers: WorkerDetail[]): WorkerDetail | null {
  let rep: WorkerDetail | null = null;
  let repFrac = Infinity;
  for (const w of workers) {
    const f = w.stage ? stageFraction(w.stage) : 0;
    if (f < repFrac) {
      rep = w;
      repFrac = f;
    }
  }
  return rep;
}

/**
 * One agent row. Collapsed (default) it shows: the kind glyph, the status dot, the width-fitted
 * name, a behind/ahead pill, and a thin progress line across the bottom. On hover the row "slides
 * out" to the right OVER the terminal (a fixed-position overlay, not a modal), revealing the full
 * name, the working-directory path, and the progress line's status label. The build glyph sits left
 * of the dot, the dot left of the name (per spec). An orchestrator row additionally renders its
 * `workers` inline: a bare indented progress line each (collapsed) and a stacked detail block each
 * (expanded), so the whole build reads as one card and selecting any part opens the orchestrator.
 */
// Stable empty fallback for the beads selector — a `?? []` literal in a zustand selector returns a
// fresh reference every render and loops the store. Reuse one array.
const NO_BEADS: Bead[] = [];

// How long the pointer must dwell on a row before hovering it activates that terminal. Short enough
// to feel instant when you mean it; long enough that a cursor merely crossing the column on its way
// elsewhere never activates the rows it transits. A click never waits on this (see openCard).
const HOVER_INTENT_MS = 90;

type AgentRowProps = {
  project: Project;
  a: AgentTab;
  depth: number;
  isActive: boolean;
  st: AgentTabStatus;
  /** Is this row's worker subtree collapsed? `null` means "no disclosure here" — a row with no
   *  workers, or a worker row itself. Only a head with ≥1 worker gets a chevron. */
  subtreeCollapsed: boolean | null;
  /** Flip this row's subtree. Only called when `subtreeCollapsed` is non-null. */
  onToggleSubtree: () => void;
  statusColor: string;
  /** Paint the leading disc this instead of the row's own status color, and hover it as `dotLabel`.
   *  Set ONLY on an orchestrator head whose workers roll up to a different band than its own status
   *  — including the `mixedInk` orange, which is not a status at all (engine/workerRollup). Both are
   *  undefined on every other row, and the two always travel together. */
  /** This row is the column's single tab stop (roving tabindex): exactly one rendered row has it,
   *  so the whole tree is ONE Tab stop and arrow keys move within it. */
  isTabStop: boolean;
  dotColor?: string;
  dotLabel?: string;
  /** The alert toggle to show on this row's expanded card: "dismiss" (truly red, not dismissed),
   *  "reenable" (red-underneath but dismissed), or null (not red). Computed from the TRUE status. */
  alertControl: "dismiss" | "reenable" | null;
  /** Acknowledge this row's red alert (recolor + drop out of the red zone; status untouched). */
  onDismissAlert: () => void;
  /** Clear a dismissal so the row goes red again. */
  onReenableAlert: () => void;
  bs?: BranchStatus;
  trackerStage: WorkflowStageId | null;
  /** This agent has reached On Main at least once → render a sticky ✓ on the progress line. */
  shipped?: boolean;
  // Number of workers under this row (orchestrators only; 0 for workers/leaf agents) — shown in
  // the hover card's "Progress" line.
  workerCount: number;
  // The orchestrator's workers, rendered inline on this row (collapsed lines + expanded detail).
  // `[]` for every non-orchestrator row.
  workers: WorkerDetail[];
  // The agent's current row in the ordered top-level stack (undefined for nested workers).
  // Passed to renameAgent so a manual rename anchors the row there (the unified pin). Also the
  // drop index for drag-reorder. The drag props are only acted on for top-level rows.
  // Which ladder section this row renders in (undefined for a nested worker row, which is not
  // independently draggable). Drag-reorder is only offered WITHIN a section — see dragSection.
  rowSection?: BuildSectionId;
  // The section the in-flight drag STARTED in, or null when nothing is being dragged. A row only
  // presents itself as a drop target when this matches its own section, so a cross-section drag
  // shows no landing spots at all rather than lighting up and then silently refusing the drop.
  dragSection: BuildSectionId | null;
  dragActive: boolean;
  onDragStartAgent: (id: string, section?: BuildSectionId) => void;
  onDragEndAgent: () => void;
  onDropAgent: (targetId: string, targetSection?: BuildSectionId) => void;
  editing: boolean;
  setEditing: (id: string | null) => void;
  onSelect: () => void;
  onLand: () => void;
  onClose: () => void;
};

// Do two orchestrator worker view-models render identically? Compared field-by-field (the closures
// are excluded — see agentRowPropsEqual) so a fresh `workers` array built each parent render doesn't
// force the orchestrator row to re-render when none of its workers' DISPLAY data actually changed.
function workerDetailsEqual(a: WorkerDetail[], b: WorkerDetail[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.autoTitle !== y.autoTitle ||
      x.description !== y.description ||
      x.stage !== y.stage ||
      x.status !== y.status ||
      x.statusColor !== y.statusColor ||
      x.branchStatus !== y.branchStatus || // branchStatus[id] ref is stable unless that agent polled
      x.shipped !== y.shipped ||
      x.worktreePath !== y.worktreePath ||
      x.baseBranch !== y.baseBranch ||
      x.active !== y.active
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Memo comparator for AgentRow (sparkle-alrm.3). A row re-renders ONLY when its OWN display data
 * changes — so one agent's frequent status flip re-paints just that agent's row instead of the whole
 * sidebar subtree. Every data prop is compared here; the callback props (onSelect/onLand/onClose/
 * drag handlers/setEditing) are deliberately EXCLUDED: `project` is compared (any project mutation
 * re-renders the row with fresh closures), and the close/reselect paths read live store state via
 * getState(), so a slightly-stale callback closure can never act on stale data. This list MUST stay
 * exhaustive: omitting a DATA prop that changed makes this return `true`, which SKIPS the re-render
 * and leaves the row painting stale data (a visual/correctness bug, not merely an extra render).
 */
function agentRowPropsEqual(prev: AgentRowProps, next: AgentRowProps): boolean {
  return (
    prev.project === next.project &&
    prev.a === next.a &&
    prev.depth === next.depth &&
    prev.isActive === next.isActive &&
    prev.st === next.st &&
    prev.subtreeCollapsed === next.subtreeCollapsed &&
    prev.statusColor === next.statusColor &&
    prev.isTabStop === next.isTabStop &&
    prev.dotColor === next.dotColor &&
    prev.dotLabel === next.dotLabel &&
    prev.alertControl === next.alertControl &&
    prev.bs === next.bs &&
    prev.trackerStage === next.trackerStage &&
    prev.shipped === next.shipped &&
    prev.workerCount === next.workerCount &&
    prev.rowSection === next.rowSection &&
    prev.dragSection === next.dragSection &&
    prev.dragActive === next.dragActive &&
    prev.editing === next.editing &&
    workerDetailsEqual(prev.workers, next.workers)
  );
}

const AgentRow = memo(function AgentRow({
  project,
  a,
  depth,
  isActive,
  st,
  subtreeCollapsed,
  onToggleSubtree,
  statusColor,
  isTabStop,
  dotColor,
  dotLabel,
  alertControl,
  onDismissAlert,
  onReenableAlert,
  bs,
  trackerStage,
  shipped,
  workerCount,
  workers,
  rowSection,
  dragSection,
  dragActive,
  onDragStartAgent,
  onDragEndAgent,
  onDropAgent,
  editing,
  setEditing,
  onSelect,
  onLand,
  onClose,
}: AgentRowProps) {
  const renameAgent = useProjectStore((s) => s.renameAgent);
  const unpinAgent = useProjectStore((s) => s.unpinAgent);
  const setAgentModel = useProjectStore((s) => s.setAgentModel);
  const pollBranchStatus = useRuntimeStore((s) => s.pollBranchStatus);
  // Beads for this project (stable fallback to avoid a re-render loop). Drives the Build-tab
  // linkage hovers: a worker shows the bead it's on; an orchestrator shows its epic.
  const beads = useBeadsStore((s) => s.byProject[project.id]?.beads ?? NO_BEADS);
  const beadHover = a.kind === "worker" ? beadLabel(beads, a.beadId) : null;
  const epicHover = a.kind === "build" ? epicForBuild(beads, project.agents, a.id) : null;
  // Always-visible epic pill on orchestrator rows (spec §8): prefers the agent's own epicId (set at
  // sendToBuild handoff, so it shows before any worker binds a bead), else the worker-derived epic.
  // Click jumps to the Plan board and opens that epic's DetailOverlay via the boardFocusBeadId handoff.
  const board = useBeadsStore((s) => s.byProject[project.id]?.board ?? null);
  const epicPillData = a.kind === "build" ? epicPillFor(a, board, project.agents) : null;

  const rowRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);
  // Hover-intent gate: activating the terminal on the very first mouseenter means a cursor merely
  // transiting the column (on its way somewhere else) activates every row it crosses, landing on
  // whichever it happened to leave last. A short dwell requirement fixes that — the pointer must
  // linger HOVER_INTENT_MS on one row before it commits. A click bypasses it entirely (openCard).
  const hoverTimer = useRef<number | null>(null);
  // Set true the instant Escape is pressed so the input's trailing blur (which fires when the field
  // unmounts in this Chromium webview) discards instead of committing — Escape must always cancel.
  const cancelNextBlur = useRef(false);
  const [hover, setHover] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  // The list's auto-scroll coordinator (see SidebarScrollContext): lets this row nudge the column up
  // so its full hover card fits, then ease back when the cursor leaves.
  const sidebarScroll = useContext(SidebarScrollContext);
  // The two halves of the rendered card — measured to decide whether (and how far) to auto-scroll.
  const stripRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  // One-shot guard so the reveal fires once per hover-open, not on every reposition during the scroll.
  const didReveal = useRef(false);

  // Scroll-into-view on request (§13): the spawn hook sets uiStore.revealAgentId to a brand-new
  // agent, and the row that matches brings itself on screen so the user lands in the thing they just
  // created instead of hunting for it below the fold. `block: "nearest"` is the house pattern
  // (PinnedPrompt.tsx) — an already-visible row doesn't move. Clearing makes it one-shot, so a
  // remount of the list later can't yank the column away from where the user put it. Optional call:
  // jsdom has no layout and no scrollIntoView.
  //
  // ORDER MATTERS: `abandonReveal()` FIRST, then scroll. This scrolls the very container the hover
  // auto-scroll coordinator drives, and `restore()` schedules a 90ms debounced ease-back to
  // `baselineRef` when a hover card closes. Leave the cursor an open card and click "+ New Build
  // Agent" — the spawn adds the agent synchronously, so this effect runs at CLICK time — and
  // without this the ease-back drags the column straight back, silently undoing the whole feature.
  // `abandonReveal(true)` handles both halves: it cancels a pending ease-back AND aborts one
  // already animating. The `true` is load-bearing — the user-scroll caller must NOT abort, or it
  // would cancel the user's own momentum scroll (see the api's doc comment). Doing this after the
  // scroll would race the animation instead of preventing it, which is why the order is asserted
  // in AgentSidebar.revealRow.test. The visual outcome is not testable in jsdom (no layout, no
  // scroll animation) — the CALL ORDER is (roborev 53784, 53907, 53929, 53940).
  const revealAgentId = useUiStore((s) => s.revealAgentId);
  useEffect(() => {
    if (revealAgentId !== a.id) return;
    sidebarScroll?.abandonReveal(true);
    rowRef.current?.scrollIntoView?.({ block: "nearest" });
    useUiStore.getState().clearRevealAgent(a.id);
  }, [revealAgentId, a.id, sidebarScroll]);

  // Hover open/close with a short close delay, so moving the cursor from the in-flow row onto the
  // overlay sitting on top of it (which fires the row's mouseleave) doesn't flicker it shut.
  const show = () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    // Re-hovering (this row or, mid-travel, a neighbor) cancels any pending ease-back so the column
    // doesn't bounce back to baseline and re-clip while a card is open.
    sidebarScroll?.cancelRestore();
    const el = rowRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setRect({ left: r.left, top: r.top, width: r.width });
    }
    setHover(true);
  };
  const hide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setHover(false), 60);
  };
  // Arm the hover-intent gate: only after the pointer has dwelled HOVER_INTENT_MS on THIS row does
  // it commit to activating the terminal. A cursor sweeping through the column re-arms per row and
  // never dwells long enough on any one, so a mere transit no longer activates anything.
  const armSelect = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      onSelect();
    }, HOVER_INTENT_MS);
  };
  const disarmSelect = () => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };
  // Leaving the row cancels any pending hover-commit (so a transit never lands) and starts the
  // card's close delay.
  const onRowLeave = () => {
    disarmSelect();
    hide();
  };
  // LEFT click = select this agent, and fold/unfold its workers. Both bypass the hover-intent
  // dwell: a deliberate click should act NOW, so cancel any armed hover-commit and select
  // immediately. The subtree toggle rides along on the same click because the chevron that used to
  // own it is gone (see CardHeader) — `subtreeCollapsed` is null on anything without workers, so a
  // childless row and a worker row just select.
  const onRowClick = (e: React.MouseEvent) => {
    disarmSelect();
    onSelect();
    // HintOverlay marks the element while it fires its synthetic click for a keyboard jump. A jump
    // means "take me to this agent"; folding its subtree as well — and PERSISTING that — made
    // repeated jumps flip-flop a subtree the user never touched (roborev 53814).
    //
    // An explicit attribute, not `e.detail === 0`: detail describes the dispatch mechanism, so AT
    // activations (VoiceOver / Switch Control AXPress) arrive with detail 0 too and would have been
    // misread as jumps, quietly losing the fold for the users least able to work around it
    // (roborev 53837). See keyboardHints/hintTargets.HINT_JUMP_ATTR.
    const isHintJump = (e.currentTarget as HTMLElement).hasAttribute(HINT_JUMP_ATTR);
    if (subtreeCollapsed !== null && !isHintJump) onToggleSubtree();
  };
  // The row is the disclosure control now, so it has to be a real one: focusable, and operable by
  // Enter/Space like the button it replaced. Without this the `aria-expanded` below is invalid ARIA
  // on a generic div AND the fold is mouse-only — deleting the chevron would have deleted keyboard
  // access to folding outright (roborev 53814).
  //
  // Making the row focusable also restores a keyboard path to the DETAIL CARD for free: a focused
  // element receives `contextmenu` from Shift+F10 / the Menu key, which is exactly the handler the
  // card hangs off. That path did not exist before this branch either (the card opened from a click
  // on this same non-focusable div), so it is a gain rather than a restoration.
  const onRowKeyDown = (e: React.KeyboardEvent) => {
    // Only the row's own keys. The rename input and the inner buttons keep theirs — without this,
    // typing a space into a rename would fold the subtree.
    if (e.target !== e.currentTarget) return;
    const row = e.currentTarget as HTMLElement;
    switch (e.key) {
      case "Enter":
      case " ":
        e.preventDefault(); // Space would scroll the list
        onSelect();
        if (subtreeCollapsed !== null) onToggleSubtree();
        return;
      // Standard tree keys: Right opens a closed node, Left closes an open one. Separating them
      // from Enter is the point — a keyboard user can read a subtree without stealing the terminal.
      case "ArrowRight":
        if (subtreeCollapsed === true) {
          e.preventDefault();
          onToggleSubtree();
        }
        return;
      case "ArrowLeft":
        if (subtreeCollapsed === false) {
          e.preventDefault();
          onToggleSubtree();
        }
        return;
      // Roving focus. Walks the rendered rows in DOM order, which IS the visual order — the ladder
      // renders sections top to bottom and workers inside their head's wrapper.
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        const rows = Array.from(
          row.closest("[data-agent-tree]")?.querySelectorAll<HTMLElement>('[data-hint="agent"]') ??
            [],
        );
        const i = rows.indexOf(row);
        const next = rows[i + (e.key === "ArrowDown" ? 1 : -1)];
        next?.focus();
        return;
      }
    }
  };
  // RIGHT click = the detail card. It is the only home for the model picker, Land, branch rebase,
  // the path reveal and the per-worker breakdown, so the card survives — it just stopped being what
  // a plain click does. Left-click used to open it, which meant every glance at an agent threw a
  // full-width overlay across the terminal you were trying to read. preventDefault suppresses the
  // native context menu; selecting first keeps the card and the terminal showing the same agent.
  const openCard = (e: React.MouseEvent) => {
    // Hands off during a rename. This is the column's only text field, and preventDefault here
    // suppresses the NATIVE context menu inside it — i.e. cut/copy/paste. Returning early also
    // avoids arming `hover`, which `showOverlay = hover && !editing` merely masks: the card would
    // spring open the instant the rename committed (roborev 53814).
    if (editing) return;
    e.preventDefault();
    disarmSelect();
    onSelect();
    show();
  };
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );
  // The overlay is pinned to the row's rect captured at hover time. On a USER scroll it would detach
  // from its row, so we close it (the original behavior). But during OUR OWN auto-scroll-to-fit
  // (sidebarScroll.isAutoScrolling) we instead re-pin to the row's live position each event, so the
  // card glides smoothly upward glued to its row instead of vanishing. A resize still just closes.
  useEffect(() => {
    if (!hover) return;
    const onScroll = (e: Event) => {
      // The card's OWN detail scroll (overflow-y:auto) bubbles here in the capture phase — that is
      // the user reading a tall worker list INSIDE the card, NOT scrolling the list away, so it must
      // never close the card. Ignore any scroll originating within the detail region.
      const t = e.target;
      if (t instanceof Node && detailRef.current?.contains(t)) return;
      if (sidebarScroll?.isAutoScrolling()) {
        const el = rowRef.current;
        if (el) {
          const r = el.getBoundingClientRect();
          setRect({ left: r.left, top: r.top, width: r.width });
        }
        return;
      }
      // A USER scroll closes the card — and since they've taken the list where they want it, drop
      // our reveal so the un-hover ease-back can't override their position. didReveal=false also
      // stops the un-hover effect below from calling restore().
      didReveal.current = false;
      sidebarScroll?.abandonReveal();
      setHover(false);
    };
    const onResize = () => setHover(false);
    window.addEventListener("scroll", onScroll, true); // capture: catch the sidebar's inner scroll too
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [hover, sidebarScroll]);
  // When the card opens, measure its full natural height; if it would spill past the viewport bottom,
  // ask the column to gently scroll up by exactly the overflow so the whole card fits. Fires once per
  // open (didReveal). The detail's own scrollHeight is used (not its clipped offsetHeight) so the
  // measurement reflects the full content even before any room is made.
  useLayoutEffect(() => {
    if (!hover || !rect || didReveal.current || !sidebarScroll) return;
    const strip = stripRef.current;
    const detail = detailRef.current;
    if (!strip || !detail) return;
    const neededH = strip.offsetHeight + detail.scrollHeight;
    const REVEAL_MARGIN = 16; // breathing room kept below the card
    const overflow = rect.top + neededH + REVEAL_MARGIN - window.innerHeight;
    if (overflow > 1) {
      didReveal.current = true;
      // Cap the reveal so it never drags the clicked row above the TOP of the list. A card far
      // taller than the viewport (a many-subworker worker) overflows by more than the row's whole
      // headroom; scrolling by that full overflow would pull the row clean off the top of the list —
      // which visually deselects it and, once the auto-scroll settles, closes the card. Instead we
      // scroll AT MOST the distance that brings the row's top up to the list's top edge, and let the
      // card's own maxH + detail overflow scroll cover the remainder (the subworkers then scroll
      // INSIDE the card rather than pushing the row away). See the reveal-cap test.
      const listTop = sidebarScroll.containerRef.current?.getBoundingClientRect().top ?? 0;
      const maxReveal = Math.max(0, rect.top - listTop);
      sidebarScroll.scrollToReveal(Math.min(overflow, maxReveal));
    }
  }, [hover, rect, sidebarScroll]);
  // On un-hover, if we had auto-scrolled to reveal this card, ease the column back to where the user
  // had it. Guarded by didReveal so a row that never scrolled doesn't disturb the column.
  useEffect(() => {
    if (hover) return;
    if (didReveal.current) {
      didReveal.current = false;
      sidebarScroll?.restore();
    }
  }, [hover, sidebarScroll]);

  const busy = st === "working";
  // The behind/ahead pill + its branch-status geometry now live in AgentDetailLines, which renders
  // the Location/Status/Progress block for this row AND for each inline worker (same logic, no dupe).

  // A BUILD row's leading mark is a plain colored disc carrying its status (red = needs you, green =
  // running, gray = done) — it replaced the ⚒ pick-and-axe on 2026-07-26. Two things changed at
  // once and both matter: the row's TEXT went back to a neutral ink (the whole row used to take the
  // status color, which made a column of agents read as a wall of red), and the status moved into a
  // single small shape that's easy to scan down. Shell (▶) rows keep their glyph — it's a
  // structural marker, not a status.
  //
  // WORKERS take the disc too, as of the child-rows change. They used to render a ↳ because they
  // had no row of their own — the arrow marked an inline line inside the parent's card, where
  // nesting was not otherwise visible. Now that a worker IS a row, its indent carries the nesting
  // and the ↳ would be saying it twice while displacing the one thing the row is missing: its own
  // live status. A worker's status is no longer "already readable from its parent's card"; the
  // card is not open most of the time, and a running worker is exactly what the column should show.
  const kindGlyph = a.kind === "shell" ? "▶" : null;
  // Width of the leading glyph slot, kept identical for the glyph and its hover-state × so the
  // name never shifts horizontally when the row expands. Workers size with build rows now: they
  // carry the same disc, and a narrower slot would make the child dots visibly smaller than their
  // parent's for no reason.
  const glyphWidth = a.kind === "shell" ? 12 : DOT_SLOT_W;
  // EVERY row's text is neutral ink; the status is carried ENTIRELY by the leading disc.
  //
  // Build rows went neutral first, because colouring the name turned a column of working agents
  // into a wall of green and a column of finished ones into a wall of red — at which point the
  // color stopped meaning anything. WORKER and SHELL rows were exempted on the argument that a
  // child row is smaller and set back, so a red name is what makes one stand out inside an expanded
  // subtree, and the wall-of-color risk doesn't apply because workers are only visible while their
  // parent is open.
  //
  // That argument stopped holding once the row lost its sub-line and its progress bar: the title is
  // now the ONLY text on a row, so status-inked worker titles are the only colored text in the
  // column, and a parent with six red workers reproduces the wall in miniature — inside the one
  // place you opened precisely to read the names. The disc already says it, per row, in the column
  // the eye scans down. `statusColor` is still live for that disc and for the card's own controls.
  const nameColor = C.cream;
  // Same reasoning for the elapsed timer — metadata, not a status readout. The mock puts `.el` a
  // tier below the name it leads (`--k-faint`), and this does NOT follow it there, for the same
  // measured reason the group header does not: `agentIdle` on this column is 3.377:1 in light and
  // 4.353:1 in dark, under AA for what is 10px text. The mono face and the micro size already
  // separate the reading from the title; the ink does not have to go under the floor to do it.
  const metaColor = C.muted;

  // Rebase a branch (this row's, or one of its inline workers') onto its base. Parameterized by id +
  // base so the orchestrator's own Status pill and each worker's Status pill share one code path.
  const refreshBranch = async (id: string, base: string, e: React.MouseEvent) => {
    e.stopPropagation();
    // Re-read status at click time: the closed-over `busy` could be stale, and this gate is the
    // only thing stopping a rebase under a live agent.
    const liveBusy = useRuntimeStore.getState().status[id] === "working";
    const r = await refreshAgentBranch(project.rootPath, project.id, id, base, liveBusy);
    if (r.ok) void pollBranchStatus(project.rootPath, project.id, id, base);
    else console.warn("refresh blocked:", r.reason, r.files ?? ""); // toast UI is a follow-up
  };
  const handleRefresh = (e: React.MouseEvent) => refreshBranch(a.id, a.baseBranch ?? "", e);

  // The auto-name title (shown truncated when collapsed) and its one-sentence description (revealed
  // in the detail card). Legacy/manual agents have no title → fall back to the canonical `name`.
  // Auto-promotion: an orchestrator still on its generic "Build N" default (no work-derived title of
  // its own, not manually pinned, and not self-named) borrows its representative worker's
  // title/description, so the ONE collapsed row describes the real work instead of a slot number. The
  // representative is the same least-advanced worker the rollup progress bar reflects, so the head
  // name and bar stay in sync. Its own auto-title, once earned, always wins; a manual rename
  // (namePinned) or an agent's self-chosen name (selfNamed) is never overridden.
  const ownAutoTitle = a.autoNameVariants?.title?.trim() || null;
  const promotedWorker =
    a.kind === "build" && !ownAutoTitle && !a.namePinned && !a.selfNamed
      ? representativeWorker(workers)
      : null;
  const autoTitle = ownAutoTitle || promotedWorker?.autoTitle || promotedWorker?.name || null;
  const fullTitle = autoTitle || a.name;
  const description =
    a.autoNameVariants?.description?.trim() || promotedWorker?.description || "";
  // Overall completion for the hover "Progress" line: the same fraction the thin line fills to.
  const progressPct = trackerStage ? Math.round(stageFraction(trackerStage) * 100) : null;

  // Epoch ms of the user's last INTERACTION with this agent — the collapsed-row timer counts up
  // from here and resets to 0 the instant the user touches the agent again. "Interaction" is the
  // later of: the most recent composer Send (promptHistory) and the most recent terminal keystroke
  // (interactionStore, throttled). Anchoring to interaction — not just composer prompts — is why a
  // terminal-driven Send now resets the timer too. undefined until the first interaction (no timer).
  const lastInteractionAt = useInteractionStore((s) => s.lastAt[a.id]);
  const lastPromptAt = a.promptHistory[a.promptHistory.length - 1]?.at;
  const lastTouchAt =
    Math.max(lastPromptAt ?? 0, lastInteractionAt ?? 0) || undefined;
  // One clock for the row, shared by the collapsed timer AND the hover-overlay timer so the elapsed
  // count is identical in both and never jumps when the cursor moves on/off the row (see useRowClock).
  const clockNow = useRowClock(lastTouchAt);

  // Per-agent Claude model (bead sparkle-i6rw). Only claude-terminal kinds get the pill — think
  // (Chief chat) and shell (plain command) tabs never spawn `claude`, so a model is meaningless
  // there. Picking a model ALWAYS persists it (next spawn adds --model); when the agent's PTY is
  // already live it's ALSO delivered in-session by typing `/model <id>` into the REPL — so a model
  // chosen right after spawn (idle or working) takes effect without a respawn.
  const showModelPill = a.kind === "build" || a.kind === "worker";
  const handleModelChange = (modelId: string) => {
    setAgentModel(project.id, a.id, modelId); // store normalizes "default" → undefined
    void applyModelToRunningAgent(a.id, modelId);
  };

  // The name-freeze chip. `namePinned` used to mean two things — "don't auto-rename" AND "hold this
  // row's position" — but row anchoring is gone (rows only move when their workflow stage changes,
  // so there is nothing to anchor against). The flag now means exactly one thing, and the tooltip
  // says so. Click to release and let the agent name itself from its work again.
  const pinChip = a.namePinned ? (
    <span
      onClick={(e) => {
        e.stopPropagation();
        unpinAgent(project.id, a.id);
      }}
      title="Renamed by you — won't auto-rename. Click to release."
      style={{ display: "inline-flex", flex: "0 0 auto", cursor: "pointer", lineHeight: 1, color: C.muted }}
    >
      <TbPinFilled size={11} />
    </span>
  ) : null;

  // "+3" — how many workers are folded away under this row. It stands in for the disclosure
  // chevron that used to sit ahead of the disc, and it is strictly more informative: the chevron
  // said only THAT a subtree existed, at the cost of 20px of gutter on every row in the column
  // including the ones with no subtree at all.
  //
  // Shown only while COLLAPSED. Expanded, the workers are on screen and counting them again is
  // noise — and the count is not a status readout, so it takes the muted metadata ink rather than
  // anything that competes with the disc. `subtreeCollapsed` is non-null only on a head that has
  // workers, so a childless row can't reach this and `+0` is unreachable by construction.
  const workerCountBadge =
    subtreeCollapsed === true && workerCount > 0 ? (
      <span
        aria-label={`${workerCount} ${workerCount === 1 ? "worker" : "workers"}`}
        title={`${workerCount} ${workerCount === 1 ? "worker" : "workers"} — click the row to show`}
        style={{ flex: "0 0 auto", color: C.muted, fontSize: 12, lineHeight: 1 }}
      >
        +{workerCount}
      </span>
    ) : null;

  // Cloud glyph (Service B): a small cloud next to the name marks an agent whose PTY runs in a
  // Sparkle sandbox rather than on this Mac — so "why is this still running with my laptop shut"
  // and "why does this one spend credits" are answerable at a glance. Deliberately the ONLY visual
  // difference from a local row (spec §Creation UX: "no other visual difference"). Rendered from
  // the tab's own `runtime`, so it survives a relaunch and a re-attach without any live state.
  const cloudChip =
    a.runtime === "cloud" ? (
      <span
        data-testid="cloud-glyph"
        title="Runs in the cloud — keeps going with your laptop closed; bills credits per running minute."
        aria-label="Cloud agent"
        style={{ display: "inline-flex", flex: "0 0 auto", lineHeight: 1, color: C.muted }}
      >
        <FiCloud size={11} />
      </span>
    ) : null;

  // The source-epic pill (spec §8): a small 4px-radius chip on orchestrator rows showing the epic
  // title (ellipsized ~18ch). Clicking it (stopPropagation so it doesn't select the agent) jumps to
  // the Plan board and opens that epic's DetailOverlay via the one-shot boardFocusBeadId handoff.
  const epicPill = epicPillData ? (
    <span
      onClick={(e) => {
        e.stopPropagation();
        const ui = useUiStore.getState();
        ui.setWorkMode("plan");
        ui.setActiveSpecial("board");
        ui.setBoardFocusBeadId(epicPillData.id);
      }}
      title={`Epic ${epicPillData.id} · ${epicPillData.title} — open in Plan`}
      style={{
        flex: "0 1 auto",
        minWidth: 0,
        maxWidth: "18ch",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        cursor: "pointer",
        fontSize: 10,
        lineHeight: 1.4,
        padding: "1px 5px",
        borderRadius: 4,
        background: C.deepForest,
        color: C.teal,
        // `C.hairline`, not a teal tint. This chip sits INSIDE the hover card, whose surface moved
        // to `barSurface`, and its old `${C.teal}55` edge measured 1.376:1 against that card in
        // dark — under the chrome floor, so the chip had no boundary from any direction (its fill is
        // `deepForest`, a plane on a plane at 1.079:1). `hairline` is the token for a 1px rule that
        // has to be SEEN and clears every plane: 3.230/3.915 on the barSurface card, 3.769/4.314 on
        // the `forest` one. Same remedy as ApprovalsMenu's notice well (roborev 53568/1).
        //
        // The FILL deliberately stays `deepForest` rather than moving to `pillFill` like the two
        // chips below: this chip's ink is `C.teal`, which measures 1.828/1.610 on `pillFill` — the
        // fill that makes it a proper chip is the one that destroys its ink. See the STATED
        // EXCEPTION in PRD/sparkle/pr676-finding-drain.md; `teal` on `deepForest` (4.139/3.272) is
        // a pre-existing brand-ink gap, and this change strictly improves the chip's boundary
        // without touching it.
        border: `1px solid ${C.hairline}`,
      }}
    >
      {epicPillData.title}
    </span>
  ) : null;

  // The card's TOP STRIP: glyph/× + timer + name (or rename input) + the progress bar. It's the
  // SAME element collapsed (in the column) and expanded (the unified hover card's top strip, which
  // spans the column into the terminal area) — `expanded` only swaps the glyph for the × close,
  // reveals the full title + description, and widens the progress bar's status label. The detail
  // (Location/Status/Progress + per-worker blocks) is NOT here — it lives in CardDetail so the card
  // can be L-shaped (strip full width, detail dropping only on the terminal side). `ownsInput`
  // renders the rename <input>; only the collapsed column row ever owns it (the card is suppressed
  // during a rename), so there is always exactly one input.
  const CardHeader = ({ expanded, ownsInput }: { expanded: boolean; ownsInput: boolean }) => (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
        {/* THE DISCLOSURE CHEVRON IS GONE, and with it the 12px slot that was reserved ahead of the
            disc on EVERY row (childless ones included) to keep the discs on one vertical line.
            Two things replace it, because it was doing two jobs:
              • the toggle → the row's own left click (see onRowClick), which already selected the
                agent; folding its workers on the same click costs no chrome at all;
              • "this row has hidden workers" → the `+N` count beside the title (below), which says
                HOW MANY rather than merely that there are some.
            Removing the slot reclaims 20px of left gutter on every row in the column, and the
            discs still line up — they now all start at the same padding, with nothing in front. */}
        {/* Leading glyph slot — a FIXED-height box so the glyph (and the title beside it) sit at the
            same vertical spot collapsed or expanded; the card only grows downward on hover. The
            glyph IS the status indicator (its color = the agent's status) and on hover it morphs
            into the × close control in this same slot, so nothing shifts. */}
        <div
          style={{
            flex: "0 0 auto",
            width: glyphWidth,
            height: GLYPH_SLOT_H,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {/* THE STATUS MARK IS ALWAYS HERE. The × close control used to take this slot on the
              active/expanded row, on the reasoning that "the status stays legible via the
              status-colored title" — which stopped being true the moment titles went neutral. The
              row you are actually working in was then the one row in the column with no status
              signal at all: no disc, no colored title, no sub-line, no bar, no pulse (roborev
              53837). The × moved to a trailing slot instead; see below. */}
          {kindGlyph ? (
            <span
              title={`${a.kind} — ${AGENT_STATUS[st].label}`}
              style={{
                fontSize: 12,
                // STATUS-inked, and it has to be. A shell row renders this glyph INSTEAD of a disc
                // (see the ternary), so it is the only thing on the row that can carry status —
                // muting it left shell rows with no status signal at all, under a comment claiming
                // "color lives in the disc" about a row that has none (roborev 53814). The column's
                // rule is that status never colors the row's TEXT; this is the icon slot.
                color: statusColor,
                // line-height 0 keeps the glyph centered in the slot without driving row height.
                lineHeight: 0,
              }}
            >
              {kindGlyph}
            </span>
          ) : (
            // Build row: the status disc. Sized to hold the visual weight the ⚒ used to carry in
            // this slot. It no longer PULSES: with the row stripped to a disc and a title, a column
            // of running agents was a column of blinking dots, and motion that is always on stops
            // reading as "look here". The color already separates running from done.
            <StatusDot status={st} size={DOT_SIZE} color={dotColor} label={dotLabel} />
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          {ownsInput ? (
            <input
              autoFocus
              defaultValue={a.name}
              onBlur={(e) => {
                // Escape requested a cancel → consume the flag and discard without committing.
                if (cancelNextBlur.current) {
                  cancelNextBlur.current = false;
                  setEditing(null);
                  return;
                }
                // Only commit a real change. A no-op blur (double-click to edit, then click away
                // without typing) must NOT pin the name or wipe the auto-name.
                const next = e.target.value;
                if (next.trim() && next !== a.name) renameAgent(project.id, a.id, next);
                setEditing(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  // Mark cancel BEFORE blurring so the resulting onBlur discards the edit.
                  cancelNextBlur.current = true;
                  (e.target as HTMLInputElement).blur();
                }
              }}
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "100%",
                background: C.deepForest,
                color: C.cream,
                border: `1px solid ${C.teal}`,
                borderRadius: 4,
                padding: "2px 6px",
                fontSize: 13,
                outline: "none",
                minWidth: 0,
                boxSizing: "border-box",
              }}
            />
          ) : expanded ? (
            // Expanded: the SAME leading "elapsed since last prompt" timer as collapsed, then
            // "Title:  description" on ONE row-height line — the bold title followed by the
            // regular-weight description. The whole line is nowrap + ellipsis, so a long
            // description truncates ("…") rather than wrapping and growing the strip over the column
            // rows beneath it. Double-click the line to edit (rename) — same affordance as collapsed.
            // No title tooltip (the user finds it noise). gap:8 matches the collapsed row.
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, height: GLYPH_SLOT_H }}>
              {lastTouchAt != null && (
                <ElapsedTimer since={lastTouchAt} now={clockNow} color={metaColor} />
              )}
              <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 4 }}>
                <div
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditing(a.id);
                  }}
                  style={{
                    flex: "0 1 auto",
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    lineHeight: `${GLYPH_SLOT_H}px`,
                  }}
                >
                  <span
                    style={{
                      color: nameColor,
                      fontSize: 13,
                      fontWeight: isActive ? FONT_WEIGHT.bold : FONT_WEIGHT.semibold,
                    }}
                  >
                    {fullTitle}
                  </span>
                  {description && (
                    <span style={{ color: nameColor, fontSize: 13, fontWeight: FONT_WEIGHT.regular }}>
                      {`:  ${description}`}
                    </span>
                  )}
                </div>
                {/* Alert toggle, to the RIGHT of the full name (only on the expanded card, only when
                    the row is red-underneath). See AlertToggleButton. */}
                {alertControl && (
                  <AlertToggleButton
                    kind={alertControl}
                    statusColor={statusColor}
                    onDismiss={onDismissAlert}
                    onReenable={onReenableAlert}
                  />
                )}
                {epicPill}
                {cloudChip}
                {pinChip}
              </div>
              {/* The model pill anchors the card's top-right corner, above the progress bar's
                  status text — clickable any time (idle or running) to change this agent's
                  Claude model. Its own clicks stop propagation so it never selects the card. */}
              {showModelPill && (
                <ModelPill value={a.model} onChange={handleModelChange} compact />
              )}
            </div>
          ) : (
            // Collapsed: the live "elapsed since last prompt" timer (once there's a prompt to time
            // from), then the bold title truncated with an ellipsis (the hover card reveals the full
            // title + description). The timer leads the row — rather than sitting outside this name
            // column — so the thin progress line below spans under the timer too, not just the name.
            // gap:8 matches the glyph↔content spacing; the name+pin sub-row keeps its tighter gap:4.
            // Fixed to the glyph-slot height so the title line aligns with the glyph.
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, height: GLYPH_SLOT_H }}>
              {lastTouchAt != null && (
                <ElapsedTimer since={lastTouchAt} now={clockNow} color={metaColor} />
              )}
              <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
                <FittedAgentName
                  title={autoTitle}
                  name={a.name}
                  color={nameColor}
                  active={isActive}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditing(a.id);
                  }}
                />
                {workerCountBadge}
                {epicPill}
                {cloudChip}
                {pinChip}
              </div>
              {/* `.stg` — LAST before the close slot, exactly as the mock orders the row
                  (dot · el · nm · stg · close). Outside the name container so the title ellipsizes
                  against it rather than pushing it off the row. Collapsed only: the card already
                  renders the full WorkflowLine for this stage, and two readings of one fact in one
                  view is the thing the row was stripped down to avoid. */}
              {trackerStage && <StageChip stage={trackerStage} active={isActive} />}
            </div>
          )}
          {/* The agent's live first-person "what I'm building now" narration, self-reported via the
              sparkle-control MCP set_agent_activity op.

              CARD ONLY (`expanded`). It used to render on the in-flow row as a muted second line,
              which is what made the column a list of two-line blocks instead of a list: with a
              narration on most rows, a screenful held about half as many agents, and the sub-line
              was the same muted ink on every row so it carried no scannable signal — you had to
              read it to learn anything. It is genuinely useful when you have stopped ON an agent,
              which is exactly when the card is open. */}
          {expanded && a.activity?.trim() && (
            <div
              title={a.activity}
              style={{
                color: C.muted,
                fontSize: 12,
                lineHeight: 1.3,
                marginTop: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: "100%",
              }}
            >
              {a.activity}
            </div>
          )}
          {/* The thin progress line under the title, with a status label to its right.

              CARD ONLY, for the same reason as the activity line above — and one more specific to
              it: the column is now GROUPED BY STAGE (the ladder sections), so a per-row bar was
              re-encoding, in a 2px gradient, the thing the section header above it already states
              in words. Two renderings of one fact, the smaller one unreadable. */}
          {expanded && trackerStage && (
            <div style={{ marginTop: 1 }}>
              <WorkflowLine stage={trackerStage} expanded={expanded} />
            </div>
          )}
          {/* NOTE: the per-worker progress lines no longer render in the collapsed column row — the
              head shows only its own rollup bar there. Every worker is revealed on CLICK, as a stacked
              detail block in CardDetail below (the row's onClick opens the card). */}
        </div>
        {/* TRAILING × slot. It used to sit in the LEADING slot, replacing the status disc on the
            active/expanded row — which left the row you are working in as the only one in the column
            with no status mark, once the titles went neutral. Trailing keeps both: the disc stays
            put (nothing shifts, and the column is still scannable straight down) and the close
            control is still one click away on the row it applies to. Fixed-height like the glyph
            slot so it can't drive the row's height. */}
        {(expanded || isActive) && (
          <div
            style={{
              flex: "0 0 auto",
              width: glyphWidth,
              height: GLYPH_SLOT_H,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <CloseAgentButton onClose={onClose} width={glyphWidth} />
          </div>
        )}
      </div>
    </>
  );

  // The card's DETAIL region — this row's Location / Status / Progress, its bead/epic linkage, then
  // one stacked block per worker. Rendered ONLY in the detail card (opened by a click on the row),
  // offset to the terminal side so it drops below the strip without covering the column rows beneath
  // it (the L-shape). Collapsed, none of this shows — the column row keeps just the title + rollup bar.
  const CardDetail = () => (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <AgentDetailLines
        worktreePath={a.worktreePath}
        rootPath={project.rootPath}
        bs={bs}
        baseBranch={a.baseBranch}
        isWorker={a.kind === "worker"}
        busy={busy}
        shipped={shipped}
        progressPct={progressPct}
        workerCount={workerCount}
        onLand={onLand}
        onRefresh={handleRefresh}
      />
      {/* Bead/epic linkage — a worker shows the bead it's on; an orchestrator its epic. Moved here
          from the (now removed) collapsed worker-lines block so the collapsed row stays title + bar. */}
      {beadHover && (
        <DetailLine label="Bead">
          <span style={{ color: C.muted, fontSize: 12 }}>{beadHover}</span>
        </DetailLine>
      )}
      {epicHover && (
        <DetailLine label="Epic">
          <span style={{ color: C.muted, fontSize: 12 }}>{epicHover}</span>
        </DetailLine>
      )}
      {/* One stacked detail block per worker — as if every worker had been expanded onto this single
          orchestrator card. Each shows the worker's own title/description, its OWN progress bar (with
          the stage status label, just like the orchestrator's), then its Location / Status / Progress.
          Indented 16px so they read as nested. */}
      {workers.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8, marginLeft: 16 }}>
          {workers.map((w) => (
            <div key={w.id} style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <WorkerNameButton w={w} />
              {/* The worker's progress bar moves DOWN to here on hover (collapsed it's the bare
                  indented line under the orchestrator in the column). Expanded, so it carries the same
                  stage status label the orchestrator's bar gets. */}
              {w.stage && (
                <div style={{ marginTop: 2 }}>
                  <WorkflowLine stage={w.stage} expanded />
                </div>
              )}
              <AgentDetailLines
                worktreePath={w.worktreePath}
                rootPath={project.rootPath}
                bs={w.branchStatus}
                baseBranch={w.baseBranch}
                isWorker
                busy={w.status === "working"}
                shipped={w.shipped}
                progressPct={w.stage ? Math.round(stageFraction(w.stage) * 100) : null}
                workerCount={0}
                onLand={w.onLand}
                onRefresh={(e) => refreshBranch(w.id, w.baseBranch ?? "", e)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );

  // The unified hover card is ONE L-shaped card pinned to the row's OWN position (not a separate
  // pop-out to the side). Its top strip starts at the row's left edge and WIDENS right into the
  // terminal area (so the single progress bar just gets wider); the detail drops down only on the
  // terminal side. The in-flow column row is hidden while it's open (the card stands in for it), so
  // the name + progress bar never duplicate.
  //  • cardLeft/cardTop — pinned to the captured rect so the strip sits exactly over the row.
  //  • colW             — the column row's width; the detail is offset by this so it lands past the
  //                       sidebar's right edge (terminal area) and never covers the rows below.
  //  • ext              — terminal-side room added to the right. The card stretches almost the full
  //                       terminal width — from the sidebar's right edge to 50px shy of the viewport
  //                       edge — so the inline "Title: description" line and the per-worker detail
  //                       blocks have room to breathe (≥280 floor for a narrow window).
  //  • maxH             — height cap for the detail so a tall card (many workers) scrolls.
  const cardLeft = rect ? rect.left : 0;
  const colW = rect ? rect.width : 0;
  const ext = rect ? Math.max(280, window.innerWidth - (rect.left + colW) - 50) : 320;
  const totalW = colW + ext;
  // Anchor the card at the row's top — but if the row sits so low that the remaining room can't hold
  // a reasonable card, shift the anchor UP so there's always room for the strip (which doesn't shrink)
  // plus some detail (standard popover viewport-flip). For the common case cardTop === rect.top, so
  // the strip sits exactly over the row; only a bottom-of-viewport row nudges upward.
  const MIN_CARD_H = 180;
  const cardTop = rect ? Math.max(8, Math.min(rect.top, window.innerHeight - 16 - MIN_CARD_H)) : 0;
  const maxH = rect ? window.innerHeight - cardTop - 16 : undefined;
  // Three row states, but they do NOT all read by contrast, and it is worth being exact about
  // which is which. Idle rows are transparent. The row you're IN is the TERMINAL color (C.forest),
  // which under the near-black palette is ~1.08:1 against this column — that is not an oversight to
  // be fixed by nudging the planes, it is the point: the active card reads as an EXTENSION of the
  // terminal it opens over, merging into it (no right border, no drop-shadow — mergeIntoTerminal
  // below drives that), and what separates it from the terminal text behind it is the card's
  // `hairline` outline, not a fill step. Don't read the phrase "three states" as three contrast
  // steps; two of them are.
  //
  // THE HOVER CARD IS A PANEL, SO IT TAKES A PLANE. It used to take CHAT_USER_BUBBLE — a row-state
  // FILL — while being a full content surface: DetailLine's `muted` labels, PathReveal's `muted`
  // path (hovering to `accentInk`), the "Up to date with…" line, the `successInk` "✓ Landed". Those
  // are the COLUMN's inks, designed against the depth planes, and they do not clear their floor on
  // a chrome fill in either theme — nor could any value of that token make them, since every fill
  // far enough from the planes to read as a fill is already past what `muted` can be read on (see
  // THE NEUTRAL LADDER in theme/colors). `barSurface` is the token for a surface that FRAMES the
  // live terminal, which is exactly what this floating card is; it is a lift above this column in
  // both themes, and every ink the card paints clears AA on it in both themes.
  const mergeIntoTerminal = isActive;
  // `C.barSurface` (not CHAT_USER_BUBBLE) comes from main: it is the token for a surface that
  // FRAMES the live terminal, which is what this floating card is — see the note just above.
  const cardBg = isActive ? C.forest : C.barSurface;
  // Border width of the card, needed BOTH for the border itself and to subtract from the strip's
  // padding so its content lines up with the row it stands over.
  const cardBorder = mergeIntoTerminal ? 4 : 2;
  // NO FILTER GOES ON THIS ROW. Rows used to render `filter: grayscale(1) opacity(.72)` when their
  // status banded "calm" (isCalmBand — everything not asking for you), lifted from the concierge
  // prototype's `.arow.p2` so only P0/P1 carried color. `working` is deliberately inside that band,
  // so a RUNNING agent's green dot came out desaturated — and sparkle-pulse (opacity 1 → .35)
  // compounded it to about a quarter opacity. The column's job is to show what is live; that
  // treatment erased exactly that. Removed outright rather than gated, because a conditional leaves
  // the same trap one isCalmBand edit away. See AgentSidebar.liveStatusDots.test.tsx.
  //
  // isCalmBand still exists and is still right for what it now governs — the TERMINAL's own xterm
  // theme (Workspace.tsx), which desaturates a landed agent's text without touching the sidebar.
  // Do not re-wire it to a row style.
  // Show the slide-out only while hovering AND not renaming. Suppressing it during a rename means
  // the in-flow row is the SOLE owner of the rename <input> — the field never swaps mount points on
  // a hover change, so a trailing unmount-blur can't silently commit a half-typed name.
  const showOverlay = hover && !editing;

  // The drag handle for reorder (top-level rows only; workers keep insertion order). Grab and drop
  // on another row to pin this agent at that row's position (manual-agent-reorder-pin). Suppressed
  // while renaming so the <input> behaves normally. These props go on the in-flow row AND on BOTH
  // halves of the unified card (strip + detail): on hover the row is visibility:hidden and the card
  // stands in over it, so the card must carry the drag grab — and because the card can shift up for a
  // bottom-of-viewport row, the cursor may sit over the detail (not the strip) when it opens, so the
  // whole card is grabbable rather than the strip alone.
  const dragProps =
    rowSection != null && !editing
      ? {
          draggable: true,
          // Signal draggability to assistive tech without an aria-label (which would override the
          // row's name). aria-roledescription supplements the announced content instead.
          "aria-roledescription": "draggable agent card",
          onDragStart: (e: ReactDragEvent) => {
            e.stopPropagation();
            onDragStartAgent(a.id, rowSection);
          },
          onDragEnd: onDragEndAgent,
        }
      : {};

  return (
    <>
      <div
        ref={rowRef}
        data-hint="agent"
        {...dragProps}
        onClick={onRowClick}
        onContextMenu={openCard}
        onKeyDown={onRowKeyDown}
        // The row absorbed the chevron's job, so it absorbs the chevron's SEMANTICS. Without this,
        // deleting the button quietly deleted the feature for anyone not using a mouse.
        //
        // `treeitem`, NOT `button`. This was `button` for one commit and that was wrong twice over
        // (roborev 53837): `button` has PRESENTATIONAL CHILDREN, so AT prunes the subtree — and this
        // row owns a rename <input>, a close button, the model pill and several chips, all of which
        // would have gone unannounced and unreachable, with the row's accessible name collapsing
        // into "timer + title + +3 + epic". `treeitem` permits owned content, carries aria-expanded
        // and aria-selected natively, and is what this actually is: a nested list of orchestrators
        // with foldable worker children.
        //
        // tabIndex is ROVING — one stop for the whole column, arrows to move within it. Unconditional
        // tabIndex={0} (also one commit only) made every agent AND worker its own tab stop, so
        // reaching the terminal meant tabbing past the entire fleet.
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={isActive}
        tabIndex={isTabStop ? 0 : -1}
        aria-expanded={subtreeCollapsed !== null ? !subtreeCollapsed : undefined}
        // Points at the worker `group` rendered as this row's DOM sibling. `aria-expanded` is a
        // claim about a group the treeitem contains or OWNS, so without this the head expanded
        // nothing structurally. Only when the group is actually on screen — aria-owns pointing at a
        // missing id is worse than none.
        aria-owns={subtreeCollapsed === false ? subtreeDomId(a.id) : undefined}
        onMouseEnter={armSelect}
        onMouseLeave={onRowLeave}
        style={{
          // LOAD-BEARING FOR THE BLEED, not just for the fillets and the drop target that anchor
          // against it. The column's seam is an absolutely positioned element, and a NON-positioned
          // block's background paints in step 4 of the painting order — BELOW positioned
          // `z-index: auto` elements at step 8. Drop this and the active row's fill goes back UNDER
          // the seam, redrawing the vertical rule across it. See the seam's note on the column.
          position: "relative",
          display: "flex",
          flexDirection: "column",
          // 4px, down from 8: the row is a single 20px line of text now (the sub-line and the
          // progress bar moved to the card), so the old padding was sized for content that is no
          // longer here and left the column looking sparse rather than calm.
          //
          // The RIGHT padding is `ROW_PAD_RIGHT`, not `ROW_PAD_X`, and it is not decoration: it
          // pays back, one-for-one, the `marginRight` below that every row now carries. Content
          // inset from the column's pane-side edge is `ROW_PAD_RIGHT - LIST_PAD_X` = ROW_PAD_X in
          // every state, which is the whole point — see ROW_PAD_RIGHT.
          padding: `${ROW_PAD_Y}px ${ROW_PAD_RIGHT}px ${ROW_PAD_Y}px ${ROW_PAD_X}px`,
          marginLeft: depth * DEPTH_INDENT,
          // Active row is the TERMINAL color, extending past the list's 8px right padding
          // (marginRight:-8) so it reaches the sidebar's right border. Left corners round into the
          // sidebar (8px); the right edge is square here, with CONCAVE fillets (below) shaping it
          // into an opening rather than a convex "button" corner. Idle rows are fully rounded.
          //
          // THE ROW BLEEDS THROUGH THE COLUMN'S EDGE, and the -8 is what makes that possible: it
          // eats the list's 8px right padding so the fill reaches the seam and laps its last pixel,
          // painting over it (the seam is a positioned sibling EARLIER in tree order — see the
          // column's own note). For one release the edge was a `border-right`, which no descendant
          // can paint on, and the rule ran straight across this row: the bleed became a dock
          // against a drawn line. Don't reintroduce that by moving the seam back onto the border or
          // by giving it a z-index.
          //
          // What carries the active state is the fill being the terminal's own colour where every
          // other row is transparent, plus the square right corner and the fillets shaping that
          // edge into an opening — and, once the card is open, its 4px `hairline` outline. Not the
          // fill step against the column, which is ~1.08:1 and never was the signal.
          // PAINT, not layout: a radius on a transparent box draws nothing, so this may key off
          // selection where the margin below may not. The leading (concierge-side) end takes a
          // radius; the pane-side end is SQUARE here and is opened by the concave mouth below —
          // a radius there would neck the row DOWN as it reaches the pane, which is the opposite
          // operation (MAPPING.md, "Geometry vocabulary"). Both values are shared with the pinned
          // Improve Sparkle row — see ACTIVE_ROW_RADIUS, which carries the `RADIUS.modal` rationale.
          borderRadius: isActive ? ACTIVE_ROW_RADIUS : IDLE_ROW_RADIUS,
          // EVERY ROW, unconditionally. See ROW_PAD_RIGHT: making this conditional on `isActive`
          // is the list-twitch bug, not a saving.
          marginRight: -LIST_PAD_X,
          cursor: "pointer",
          // The whole card is a drag handle for reorderable rows — suppress text selection so a
          // drag grabs the card instead of highlighting the name underneath the cursor. Gated on
          // !editing (like dragProps) so the rename <input> keeps normal text selection.
          userSelect: rowSection != null && !editing ? "none" : undefined,
          // Active = the terminal's own color (merges into it); the hover state's fill lives on the
          // unified card, not here. Cleared while the card is open (showOverlay) so the row reads as
          // empty behind the stand-in card.
          background: !showOverlay && isActive ? C.forest : "transparent",
          // Heads keep a 2px beat between them; a WORKER sits flush against the row above it, so a
          // subtree reads as one block hanging off its parent rather than as more loose rows in the
          // list. Cheap to do now that the rows are single-line.
          marginBottom: depth > 0 ? 0 : 2,
          // NOTE: visibility is NOT toggled on the whole row anymore — only the strip content below is
          // hidden (visibility:hidden) while the card is open, so its layout slot is preserved and the
          // rows beneath never jump.
        }}
      >
        {/* Strip content (glyph + name + own progress bar): the overlay card stands in for exactly
            this, so hide it while the card is open. visibility:hidden keeps its layout slot, so the
            worker lines below (and the rows beneath) never jump. */}
        <div style={{ visibility: showOverlay ? "hidden" : "visible" }}>
          {CardHeader({ expanded: false, ownsInput: editing })}
        </div>
        {/* Collapsed the row shows ONLY the head strip above: the orchestrator's title (auto-promoted
            from its representative worker) and its single rollup progress bar summarizing every worker.
            The individual workers — and the bead/epic detail — are revealed on CLICK, in the detail
            card (see CardDetail); they no longer render inline here. */}
        {/* The mouth where the active tab opens into the pane — see ActiveFillets, which the
            pinned Improve Sparkle row draws from too, so the two can never drift apart. Suppressed
            HERE while the card is open (showOverlay): the row is no longer visibility:hidden, so
            these would otherwise show through beside the stand-in card. */}
        {isActive && !showOverlay && <ActiveFillets />}
        {/* Drop target — live only while a drag is in flight, only on top-level rows, and only when
            the drag STARTED in this row's own section. Moving a row between sections is not a thing
            the user can do: a row's section is derived from its git state, so "drag it into Merged"
            would have to either merge the branch or snap back. Refusing to offer the target at all
            is honest; offering it and rejecting the drop reads as a bug. */}
        {rowSection != null && dragActive && dragSection === rowSection && (
          <div
            data-testid="agent-drop-target"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              onDropAgent(a.id, rowSection);
            }}
            style={{ position: "absolute", inset: 0, zIndex: 2 }}
          />
        )}
      </div>
      {showOverlay &&
        rect &&
        createPortal(
          // Outer wrapper is pure positioning and NON-interactive (pointerEvents:none): its
          // transparent lower-left quadrant — under the column, beside the dropped-down detail —
          // passes hover/clicks straight through to the rows beneath, which is what keeps them live.
          // The two children below re-enable pointer events and carry the hover/click handlers. One
          // drop-shadow on the wrapper traces the L outline (the lower-left is transparent). It's a
          // flex column capped to maxH (the room from the row's top to the viewport bottom): the
          // strip takes its natural height and the detail flex-shrinks + scrolls within the rest, so
          // a tall card can't run past the viewport (the cap is on the whole card, not just detail).
          <div
          // PART OF THE LIVE CIRCUIT (see engine/cable.ts). This card is portalled to
          // document.body, so ancestry cannot tie it back to the row that owns it — without this
          // marker, hovering the agent you just patched into and clicking anything in its card
          // read as "you left" and dropped the cable.
          data-circuit
            data-testid="agent-hover-card"
            style={{
              position: "fixed",
              left: cardLeft,
              top: cardTop,
              width: totalW,
              maxHeight: maxH,
              zIndex: 50,
              pointerEvents: "none",
              display: "flex",
              flexDirection: "column",
              // No shadow when active: the card is the terminal's own color and merges into it — a
              // drop-shadow would draw the very seam we're removing. Hover-only cards keep the lift.
              filter: mergeIntoTerminal ? "none" : "drop-shadow(0 8px 16px rgba(0,0,0,0.45))",
              animation: "-slide 140ms ease-out",
            }}
          >
            {/* TOP STRIP — full width, spanning the column into the terminal area; the single progress
                bar widens with it. Rounded except the bottom-RIGHT inner corner, where the detail
                steps down to form the L. A drag grab on hover (see dragProps) — BOTH the strip and
                the detail carry it, so the WHOLE card is grabbable: the cursor lands over the detail
                when the card is shifted up for a bottom-of-viewport row, so the strip alone wouldn't
                be reachable to start a drag there. */}
            <div
              ref={stripRef}
              {...dragProps}
              onClick={onSelect}
              onMouseEnter={show}
              onMouseLeave={hide}
              style={{
                pointerEvents: "auto",
                boxSizing: "border-box",
                flex: "0 0 auto",
                display: "flex",
                flexDirection: "column",
                gap: 4,
                // PADDING MINUS THE BORDER, so the card's content lands exactly where the row's
                // content is. The card is pinned at the row's own rect (cardTop = rect.top,
                // cardLeft = rect.left) and stands in for it, but the card has a 2/4px border the
                // row doesn't — so a flat `8px 10px` here put the disc and title several pixels
                // down-and-right of where they had just been, and everything visibly jumped on
                // open. The row's own padding is 4px/10px (ROW_PAD_Y / ROW_PAD_X).
                //
                // The horizontal half of this was always slightly wrong; cutting the row's vertical
                // padding to 4px is what made the vertical half obvious (roborev 53814). The
                // alignment test pins BOTH axes now — it used to compare only slot widths, which
                // cannot see an offset.
                padding: `${Math.max(0, ROW_PAD_Y - cardBorder)}px ${Math.max(0, ROW_PAD_X - cardBorder)}px`,
                cursor: "pointer",
                userSelect: rowSection != null && !editing ? "none" : undefined,
                background: cardBg,
                // ACTIVE: the fill is the terminal's own color so the card reads as part of the
                // terminal. HOVER-ONLY: `barSurface`, a lift above this column — the card is a
                // floating panel there, not an extension of the terminal, and it carries the
                // column's own inks (see `cardBg`). Either way a border outlines the card shape so
                // its text is distinguishable from the terminal text behind it, 4px when active
                // (easier to tell apart from terminal content) and 2px on a hover-only card.
                //
                // That border used to be a DEPTH PLANE — C.deepForest for the active card "because
                // it is lighter than C.forest", C.forest for the hover card. Under the black-and-gold
                // palette those planes are a hair apart, so the active card's outline would be drawn
                // in a colour indistinguishable from the terminal it is supposed to be outlined
                // against: no outline at all. It is `hairline` now, in both states — the token whose
                // whole job is to be a line you can see on any plane (see theme/colors, and the floor
                // in theme/chromeContrast.test.ts).
                border: `${cardBorder}px solid ${C.hairline}`,
                borderRadius: "6px 6px 0 6px",
              }}
            >
              {CardHeader({ expanded: true, ownsInput: false })}
            </div>
            {/* DETAIL — offset right by the column width so it drops ONLY on the terminal side (column
                rows below stay visible). marginTop:-1 laps the strip's bottom border so the two read
                as one card; the strip's bottom border then shows only in the column-width "step". Also
                carries dragProps (see the strip) so the whole card is a drag handle. */}
            <div
              ref={detailRef}
              // Marks the card's scrollable region so the sidebar wheel-forwarder yields to it (2b)
              // — wheeling a tall many-worker card scrolls the card, not the column.
              data-hovercard-detail=""
              {...dragProps}
              onClick={onSelect}
              onMouseEnter={show}
              onMouseLeave={hide}
              style={{
                pointerEvents: "auto",
                boxSizing: "border-box",
                // Offset right by the column width, then lap LIST_PAD_X back over the column so the
                // detail overlaps the sidebar by that much rather than butting flush against its
                // edge. UNCONDITIONAL now: every row carries `marginRight: -LIST_PAD_X`, so the
                // measured `colW` already runs to the column's edge in every state and the active /
                // inactive split this used to make no longer describes anything. (It existed
                // because only the ACTIVE row had the negative margin — the same asymmetry that
                // made the list twitch; removing it here is the same fix, one surface along.)
                marginLeft: colW - LIST_PAD_X,
                // Lap the strip's bottom border (4px when active, else 2px) so the two halves read
                // as one continuous outline.
                marginTop: mergeIntoTerminal ? -4 : -2,
                // The card laps LIST_PAD_X back over the column (marginLeft above), so widen by the
                // same amount to keep its RIGHT edge anchored at the terminal edge — the card grows
                // into the column rather than sliding left and pulling short on the right.
                width: ext + LIST_PAD_X,
                userSelect: rowSection != null && !editing ? "none" : undefined,
                // flex-shrink + scroll within the wrapper's maxH budget (minus the strip), so the
                // detail's scroll boundary lands inside the viewport even for a tall card.
                flex: "1 1 auto",
                minHeight: 0,
                overflowY: "auto",
                padding: "2px 10px 8px",
                cursor: "pointer",
                background: cardBg,
                // Same outline as the strip (4px when active) continues down the L's left/right/
                // bottom so the whole card is encapsulated against the terminal behind it.
                borderLeft: `${mergeIntoTerminal ? "4px" : "2px"} solid ${C.hairline}`,
                borderRight: `${mergeIntoTerminal ? "4px" : "2px"} solid ${C.hairline}`,
                borderBottom: `${mergeIntoTerminal ? "4px" : "2px"} solid ${C.hairline}`,
                borderRadius: "0 0 6px 6px",
              }}
            >
              {CardDetail()}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}, agentRowPropsEqual);

/** The Location / Status / Progress detail block for ONE agent in the hover card. Shared by the
 *  orchestrator's own detail and each of its inline workers, so the behind/ahead pill logic lives
 *  in exactly one place. `onRefresh` rebases the branch onto its base (red "behind" pill, gated on
 *  `busy`); `onLand` merges it forward (green "ahead" pill). `isWorker` only swaps the green pill's
 *  wording (merge into the worker's orchestrator vs. into the base). */
function AgentDetailLines({
  worktreePath,
  rootPath,
  bs,
  baseBranch,
  isWorker,
  busy,
  shipped,
  progressPct,
  workerCount,
  onLand,
  onRefresh,
}: {
  worktreePath: string | null;
  rootPath: string;
  bs?: BranchStatus;
  baseBranch: string | null;
  isWorker: boolean;
  busy: boolean;
  shipped?: boolean;
  progressPct: number | null;
  workerCount: number;
  onLand: () => void;
  onRefresh: (e: React.MouseEvent) => void;
}) {
  const behind = bs?.behind ?? 0;
  const ahead = bs?.ahead ?? 0;
  // The pill: RED "-N" when the branch is behind its base (click rebases it — catch YOU up), else
  // GREEN "+N" when it's ahead (click merges it — catch the base up to you). Behind wins when both.
  const showPill = !!bs && (behind > 0 || ahead > 0);
  const pillBehind = behind > 0;
  // Behind is INFORMATIONAL, not an alarm: a branch trailing its base is normal (the base moves) and
  // says nothing about whether the work shipped — so it reads as a calm, muted OUTLINE pill (no red,
  // no fill). Red is reserved for genuine errors. Ahead stays the green actionable "land" pill with
  // the faint `${C.success}22` alpha tint — which is why the green path uses the BRAND-literal hex
  // C.success (a CSS var can't take a hex-alpha suffix); the muted path is a var() and uses no tint.
  const pillInk = pillBehind ? C.muted : C.successInk;
  const baseLabel = baseBranch ?? "main";
  // Shared pill geometry — squared off to roughly match the Land/old action pills (borderRadius 5),
  // not a fully-round chip. The behind/ahead variants layer color + action on top.
  const pillBase: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    lineHeight: 1,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    padding: "2px 7px",
    // RADIUS.sm, not a hand-typed 5. theme/scale.test.ts is a ratchet on off-scale values and this
    // pill was one of them; 4 vs 5 is imperceptible at this size, and the migration is the
    // direction the ratchet exists to push.
    borderRadius: RADIUS.sm,
    flex: "0 0 auto",
    whiteSpace: "nowrap",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4 }}>
      <DetailLine label="Location">
        <PathReveal path={worktreePath ?? rootPath} />
      </DetailLine>
      <DetailLine label="Status">
        {showPill ? (
          pillBehind ? (
            // BEHIND (red): click rebases this branch onto its base — catches YOU up. Gated on the
            // agent not actively writing (a rebase under a live PTY would race).
            <button
              disabled={busy}
              onClick={onRefresh}
              style={{
                ...pillBase,
                color: pillInk,
                background: "transparent",
                border: `1px solid ${pillInk}`,
                cursor: busy ? "not-allowed" : "pointer",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busy
                ? `Update available · ${behind} behind ${baseLabel} — pause the agent to catch up`
                : `Update available · ${behind} behind ${baseLabel} — click to catch up`}
            </button>
          ) : (
            // AHEAD (green): click merges this branch forward — catches the base up to you.
            <button
              onClick={(e) => {
                e.stopPropagation();
                onLand();
              }}
              style={{
                ...pillBase,
                color: pillInk,
                // TRANSPARENT, like the BEHIND variant above — these are one control in two states
                // and there is no reason for one to be tinted. It carried `${C.success}22`, and the
                // ladder's justification table measured `successInk` on the BARE plane (light
                // 4.552 on `barSurface`) rather than on the stack it is actually composited over.
                // Measured there, the 13.3% green wash took it to 4.127 in light — under the AA
                // floor — while buying 1.103:1 against the card, i.e. nothing anyone can see. The
                // chip reads by its border, which is what the behind variant already relies on.
                background: "transparent",
                border: `1px solid ${pillInk}`,
                cursor: "pointer",
              }}
            >
              {isWorker
                ? `${ahead} ahead. Click to merge into this worker's orchestrator`
                : `${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${baseLabel}. Click to merge`}
            </button>
          )
        ) : (
          <span style={{ color: C.muted, fontSize: 12 }}>Up to date with {baseLabel}</span>
        )}
      </DetailLine>
      {progressPct != null && (
        <DetailLine label="Progress">
          <span style={{ color: C.muted, fontSize: 12 }}>
            {workerCount > 0 ? `${workerCount} worker${workerCount === 1 ? "" : "s"}. ` : ""}
            {progressPct}% complete{workerCount > 0 ? " overall" : ""}.
            {/* The sticky "landed" signal, in WORDS. The ✓ glyph that used to lead it went with the
                one on the progress line — the column says "landed" through its stage sections now,
                and two checkmarks for one fact was the thing being cut. The card is the detail
                surface, so the fact itself stays; it just reads rather than decorates. */}
            {shipped && (
              <span style={{ color: C.successInk, fontWeight: 600 }}> Landed</span>
            )}
          </span>
        </DetailLine>
      )}
    </div>
  );
}

/** One "Label: value" line in the hover card (Location / Status / Progress). The label is a muted
 *  fixed-width-content prefix; the value flexes and is allowed to shrink (minWidth:0) so a long
 *  path or status button can ellipsize/wrap instead of forcing the card wider. */
function DetailLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <span style={{ flex: "0 0 auto", color: C.muted, fontSize: 12, fontWeight: FONT_WEIGHT.semibold }}>
        {label}:
      </span>
      <span style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center" }}>{children}</span>
    </div>
  );
}

/** The agent's working-directory path in the expanded row. Click to reveal the folder in Finder
 *  (Tauri opener `revealItemInDir`); underlines on hover so it reads as clickable. */
function PathReveal({ path }: { path: string }) {
  const [hover, setHover] = useState(false);
  return (
    <span
      onClick={(e) => {
        e.stopPropagation(); // don't also select the agent
        revealItemInDir(path).catch((err) => console.error("reveal in Finder failed:", err));
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Click to reveal this folder in Finder"
      style={{
        color: hover ? C.accentInk : C.muted,
        fontSize: 12,
        fontFamily: FONT.mono,
        whiteSpace: "nowrap",
        cursor: "pointer",
        textDecoration: hover ? "underline" : "none",
        // Ellipsize a long path inside the DetailLine instead of forcing the card wider.
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: "100%",
        display: "block",
      }}
    >
      {path}
    </span>
  );
}

/** Close (×) control that stands in for the leading kind glyph while a row is hovered. It takes
 *  the glyph's slot width so the name doesn't shift on hover, with a thin pill that fades in to
 *  make the hit target feel intentional. */
function CloseAgentButton({ onClose, width }: { onClose: () => void; width: number }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Close agent"
      aria-label="Close agent"
      style={{
        color: hover ? C.accentInk : C.muted,
        fontSize: 17,
        lineHeight: 1,
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        // Width matches the glyph slot so the name stays put; the pill stays a comfortable 22 tall.
        width,
        height: 22,
        padding: 0,
        cursor: "pointer",
        borderRadius: 999,
        border: `1px solid ${hover ? C.muted : "transparent"}`,
        // `pillFill` — the token whose role IS a filled chip — not `deepForest`, which is a PLANE
        // and measured 1.079/1.248 against the hover card it opens on (`barSurface`), so the hover
        // pill was a fill you could not see. 2.098/2.537 now, and 2.449/2.795 on the `forest` card.
        // The hover ink is `accentInk`, which clears it comfortably (5.118/6.097).
        background: hover ? C.pillFill : "transparent",
        transition: "background 120ms ease, border-color 120ms ease, color 120ms ease",
      }}
    >
      ×
    </button>
  );
}

/** The pinned, always-present Sparkle self-improvement agent row.
 *
 *  IT IS A BUILD ROW THAT HAPPENS TO BE PINNED, and everything below is about keeping it that way.
 *  It had drifted into a special case with its own vocabulary — a larger disc, its own left inset,
 *  its own font size, a sweeping gradient progress bar, a divider rule above it and a bordered
 *  consent pill — none of which any other row in the column had. The whole point of the column is
 *  that it is scannable straight down; a row with its own dialect is a row you have to stop and
 *  read.
 *
 *  So: same disc slot (DOT_SLOT_W / DOT_SIZE), same box (ROW_PAD_*, LIST_PAD_X), same title size
 *  (AGENT_NAME_FONT_SIZE) and neutral ink, same leading ElapsedTimer, same `+N` treatment for both
 *  the worker count and the consent word. It is separate from the project agents by POSITION only
 *  — pinned below the list, outside every stage group — and by nothing else.
 *
 *  What it still does NOT have, and shouldn't: a close button (it can't be closed), a rename (its
 *  name is the product's), and a stage section (it never lands work on the user's branch).
 *
 *  `st` / `dotColor` / `dotLabel` come from the caller, which derives them with the SAME
 *  effectiveStatus + rollupDot pipeline every build row goes through — see the `sparkleRow` memo in
 *  AgentSidebar. Do NOT re-derive status here; a second derivation is how the row ended up green
 *  while sitting on an unanswered picker.
 *
 *  `React.memo`'d (sparkle-alrm.3) with primitive props + a stable `onSelect`, so a project agent's
 *  status flip re-renders only that agent's row, never this pinned footer row. */
const SparkleAgentRow = memo(function SparkleAgentRow({
  active,
  status,
  dotColor,
  dotLabel,
  workerCount,
  onSelect,
}: {
  active: boolean;
  status: AgentTabStatus;
  /** Rolled-up disc paint, when this row's workers disagree with its own status. Same override the
   *  build rows take; `undefined` means "use the status taxonomy". */
  dotColor?: string;
  dotLabel?: string;
  /** Workers folded under this row. 0 today (the improvement pass runs a single agent), wired to
   *  the same rule build rows use so a future subtree gets the same badge for free. */
  workerCount: number;
  onSelect: () => void;
}) {
  const consent = useSettingsStore((s) => s.sparkleImprovementConsent);
  const pill = consentPillLabel(consent);
  // The SAME "elapsed since the user last touched this agent" the build rows show — read from the
  // same interactionStore, formatted by the same ElapsedTimer, ticked by the same useRowClock.
  // `undefined` until the first interaction, so a never-touched row shows no timer at all rather
  // than an ever-growing number (see this row's note in PRD/sparkle/improve--parity.md).
  const lastTouchAt = useInteractionStore((s) => s.lastAt[sparkleAgentIdFor(APP_WINDOW_LABEL)]);
  const clockNow = useRowClock(lastTouchAt);
  return (
    <div
      data-hint="improve"
      onClick={onSelect}
      title="Improve Sparkle — reviews your usage to propose improvements to the open-source app"
      style={{
        flex: "0 0 auto",
        // The active fill's concave fillets are absolutely positioned against this box.
        position: "relative",
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        // LIST_PAD_X as a LEFT margin, because this row is pinned OUTSIDE the padded scroll
        // container — that inset plus ROW_PAD_X plus the centered disc slot is what puts the disc on
        // the same vertical line as every build row's.
        //
        // NOTHING HERE IS CONDITIONAL ON `active`, and that is the same rule the build rows follow:
        // geometry belongs to every row, never only the selected one. A `marginRight: active ? …`
        // narrows the row's CONTENT BOX the instant you select it, so the title under the pointer
        // jumps — the list-twitch the build rows were just fixed for. This row is outside the
        // padded container, so it already reaches the seam at margin-right 0; it pays the inset back
        // through ROW_PAD_RIGHT exactly as a build row does, leaving the ink at the identical
        // distance from the column's pane-side edge in every state.
        //
        // The trailing 6 is the gap to the footer, not a separator.
        margin: `0 0 6px ${LIST_PAD_X}px`,
        padding: `${ROW_PAD_Y}px ${ROW_PAD_RIGHT}px ${ROW_PAD_Y}px ${ROW_PAD_X}px`,
        cursor: "pointer",
        // THE SELECTED STATE IS THE BUILD ROW'S, NOT A BESPOKE ONE — and that resolves the long
        // argument this comment used to record.
        //
        // The history, kept because the measurements are still the reason the fill is `forest`:
        // this row painted CHAT_USER_BUBBLE until roborev 53613, where its label measured 3.20/3.71
        // (dark/light), its consent pill 3.20/2.38, and the status DOT 2.64/1.70 red and 4.56/1.01
        // green — the dot the whole row reads by, invisible in light. On `forest` those become
        // 6.37/8.36, 6.37/5.35, 5.25/3.83 and 9.07/2.22, better at both ends than the sidebar's own
        // `deepForest` plane. So the active fill is `forest`, and stays.
        //
        // But `forest` on a `deepForest` column is 1.08/1.38 — the fill step is not visible and
        // never was (roborev 53662). On a BUILD row that is fine, because what actually carries
        // selection there is the SQUARE RIGHT EDGE plus the concave fillets shaping it into an
        // opening onto the terminal. This row used to have none of that geometry, which is why it
        // needed a `hairline` outline of its own to avoid being a WCAG 1.4.11 failure (roborev
        // 53814) — and that outline was the row's last piece of private vocabulary.
        //
        // It now takes the geometry instead: same square right edge, same fillets, same fill. The
        // outline is gone because the thing it was compensating for is gone. Do NOT reintroduce it,
        // and do NOT restore the older `3px solid C.goldFill` rail either — the colored version is
        // the decoration the column cleanup deliberately cut.
        //
        // NO borderTop. It was a divider rule marking this row off from the list above, and it was
        // the only horizontal rule anywhere in the column. Position already says the row is
        // separate — it is pinned below the scroll container, outside every stage group — so the
        // rule was saying it a second time, in the one vocabulary no other row uses.
        background: active ? C.forest : "transparent",
        borderRadius: active ? ACTIVE_ROW_RADIUS : IDLE_ROW_RADIUS,
      }}
    >
      {/* The disc, in the SAME fixed slot a build row gives it: fixed height so the title beside it
          sits on the glyph's line, fixed width with the disc CENTERED so its left edge lands on the
          column's one vertical line of discs. */}
      <div
        style={{
          flex: "0 0 auto",
          width: DOT_SLOT_W,
          height: GLYPH_SLOT_H,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <StatusDot status={status} size={DOT_SIZE} color={dotColor} label={dotLabel} />
      </div>
      {/* Timer, then title, then badges — the collapsed build row's strip, element for element. */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: GLYPH_SLOT_H,
        }}
      >
        {lastTouchAt != null && (
          <ElapsedTimer since={lastTouchAt} now={clockNow} color={C.muted} />
        )}
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
          <span
            style={{
              flex: "0 1 auto",
              minWidth: 0,
              // NEUTRAL INK, like every other row's title. It used to be
              // `statusInk(AGENT_STATUS[status].color)`, which made this the one row in the column
              // whose text changed color with its status — the exact thing build and worker rows
              // were taken off years of ago. Color lives in the disc.
              color: C.cream,
              fontSize: AGENT_NAME_FONT_SIZE,
              fontWeight: active ? FONT_WEIGHT.bold : FONT_WEIGHT.semibold,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            Improve Sparkle
          </span>
          {/* Same `+N` a collapsed orchestrator shows. 0 today; see the prop's note. */}
          {workerCount > 0 && (
            <span
              aria-label={`${workerCount} ${workerCount === 1 ? "worker" : "workers"}`}
              title={`${workerCount} ${workerCount === 1 ? "worker" : "workers"}`}
              style={{ flex: "0 0 auto", color: C.muted, fontSize: 12, lineHeight: 1 }}
            >
              +{workerCount}
            </span>
          )}
          <SparkleConsentBadge label={pill} />
        </div>
      </div>
      {/* THE SAME COMPONENT a selected build row draws, not a copy of it — they are what makes the
          1.08:1 fill step legible as selection, so they are not decoration and must not be dropped.
          No `showOverlay` condition here: this row has no hover card to be stood in for. */}
      {active && <ActiveFillets />}
    </div>
  );
});

/** Red Feather `alert-circle`, inline (no emoji — house rule). Sized to the caller. */
function AlertCircleIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      // `currentColor` IN THE ATTRIBUTE, THE TOKEN IN A CSS PROPERTY — never the token here.
      // `stroke` is an SVG PRESENTATION ATTRIBUTE, and `var()` is not substituted in those (WebKit,
      // which is what Tauri renders with on macOS, does not support it). Passing `stroke={DANGER}`
      // once DANGER became `var(--c-danger-ink)` made the attribute invalid, so it fell back to the
      // initial `none` and this icon rendered INVISIBLE — with the whole suite green, because
      // nothing measured attribute-vs-property usage (roborev 54231).
      //
      // Routing through `color` works because that IS a CSS property, where var() resolves, and
      // `currentColor` reads it back out. theme/svgTokens.test.ts now sweeps for the broken form.
      stroke="currentColor"
      style={{ color: DANGER }}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

/** Open a ticket's web thread in the system browser — same `/support/t/[token]` link + opener
 *  hand-off SupportModal uses for "View your ticket". */
function openTicketThread(token: string) {
  openUrl(`${WEB_BASE_URL}/support/t/${token}`).catch((err) =>
    console.error("Failed to open support ticket:", err),
  );
}

/** Pinned status banner for the signed-in user's OPEN support tickets, shown between the "Improve
 *  Sparkle" row and the footer StatusBar. Renders nothing when there are no open tickets. Polls
 *  every 60s while the window is visible — a hidden window skips the tick and catches up on
 *  `visibilitychange`, so a backgrounded app doesn't fetch once a minute for hours nobody sees.
 *  Also refetches on window focus and when a ticket is created (via TICKET_CREATED_EVENT). An
 *  unchanged poll result is dropped rather than re-set, so the memo'd row doesn't re-render every
 *  minute for identical tickets (see supportTicketPoll). One open ticket → click opens its thread;
 *  many → click toggles an
 *  expanded per-ticket list directly beneath the banner. `memo`'d (no props) so unrelated sidebar
 *  re-renders don't churn it. */
const SupportTicketRow = memo(function SupportTicketRow() {
  const [tickets, setTickets] = useState<TicketStatus[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    // Last signature we applied. Kept in a ref-like closure rather than state so comparing it
    // never itself triggers the render it exists to avoid.
    let lastSig = ticketsSignature([]);
    const refetch = () => {
      listMyTickets()
        .then((t) => {
          if (!alive) return;
          const sig = ticketsSignature(t);
          if (sig === lastSig) return; // same tickets as last poll — don't churn the memo'd row
          lastSig = sig;
          setTickets(t);
        })
        .catch(() => {
          // Signed-out / offline / transient — leave the last-known list; the banner just hides
          // when there are no open tickets. Not worth surfacing an error in the sidebar chrome.
        });
    };
    // A hidden window gets no scheduled polls; onVisible catches it up on the way back. The
    // event-driven paths (focus, ticket-created) always fetch — they only fire when someone is
    // actually here, and a just-created ticket should appear without waiting for the next tick.
    const onTick = () => {
      if (shouldPollTickets()) refetch();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refetch();
    };
    refetch();
    const timer = window.setInterval(onTick, 60_000);
    window.addEventListener("focus", refetch);
    window.addEventListener(TICKET_CREATED_EVENT, refetch);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refetch);
      window.removeEventListener(TICKET_CREATED_EVENT, refetch);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const banner = bannerFromTickets(tickets);
  if (!banner) return null;
  const { label, alert, openTickets } = banner;
  const multiple = openTickets.length > 1;

  const onBannerClick = () => {
    if (multiple) {
      setExpanded((e) => !e);
    } else {
      openTicketThread(openTickets[0]!.token);
    }
  };

  return (
    <div style={{ flex: "0 0 auto", margin: "0 8px 6px" }}>
      {/* The blue status banner. Mirrors SparkleAgentRow's inline-styled pill idiom. */}
      <div
        onClick={onBannerClick}
        title={
          multiple
            ? `${openTickets.length} open support tickets — click to ${expanded ? "hide" : "show"}`
            : "View your support ticket"
        }
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          borderRadius: expanded ? "6px 6px 0 0" : 6,
          cursor: "pointer",
          background: C.teal,
          color: ON_BRAND_FILL,
          fontSize: 13,
          fontWeight: FONT_WEIGHT.semibold,
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          Ticket: {label}
        </span>
        {multiple && (
          <span style={{ flex: "0 0 auto", fontSize: 12, opacity: 0.85 }}>{openTickets.length}</span>
        )}
        {alert && (
          // Top-right corner alert marker (support replied, waiting on the user). A white halo keeps
          // the red glyph legible against the blue fill.
          <span
            style={{
              position: "absolute",
              top: -6,
              right: -6,
              display: "inline-flex",
              borderRadius: "50%",
              background: ON_BRAND_FILL,
              padding: 1,
            }}
          >
            <AlertCircleIcon size={15} />
          </span>
        )}
      </div>

      {/* Expanded per-ticket list, directly beneath the banner (only when >1 open ticket). */}
      {multiple && expanded && (
        <div
          style={{
            border: `1px solid ${C.teal}`,
            borderTop: "none",
            borderRadius: "0 0 6px 6px",
            overflow: "hidden",
          }}
        >
          {openTickets.map((t, i) => {
            const rowAlert = t.status === "awaiting_user";
            return (
              <div
                key={t.id}
                onClick={() => openTicketThread(t.token)}
                title={t.subject}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 10px",
                  cursor: "pointer",
                  background: C.deepForest,
                  // A row separator, not a seam: one near-black plane ruled onto another is the
                  // exact "plane used as a divider" defect `hairline` exists to remove (1.08:1).
                  borderTop: i === 0 ? "none" : `1px solid ${C.hairline}`,
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 12,
                    color: C.cream,
                  }}
                >
                  {t.subject}
                </span>
                {rowAlert ? (
                  <span style={{ flex: "0 0 auto", display: "inline-flex" }}>
                    <AlertCircleIcon size={13} />
                  </span>
                ) : (
                  <span
                    style={{
                      flex: "0 0 auto",
                      fontSize: 10,
                      fontWeight: FONT_WEIGHT.semibold,
                      color: C.muted,
                      letterSpacing: 0.2,
                    }}
                  >
                    Submitted
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

/** The Always / Manual / Off badge on the Improve Sparkle row — reflects the consent mode. */
/** The consent mode (Always | Manual | Off) beside the Improve Sparkle title.
 *
 *  IT IS THE `+N` BADGE'S TWIN, not a pill. It used to be a 10px semibold capsule with a teal
 *  outline and a letter-spaced label — the only bordered chip in the column, on the only row that
 *  had one, which made a piece of ordinary row metadata read as a status announcement. It is the
 *  same class of fact as "+2 workers": a small muted note about the row, sitting in the same slot
 *  the `+N` occupies. So it takes the same ink, size and weight, and no box at all.
 *
 *  It keeps its `title`, because unlike "+2" the word alone doesn't say what it modifies. */
function SparkleConsentBadge({ label }: { label: string }) {
  return (
    <span
      title={`Improvement PRs: ${label}`}
      style={{ flex: "0 0 auto", color: C.muted, fontSize: 12, lineHeight: 1, whiteSpace: "nowrap" }}
    >
      {label}
    </span>
  );
}

// `SparkleRowProgress` LIVED HERE AND IS GONE. It was a 3px rail under the Improve Sparkle title
// with the sparkle.ai cyan→blue gradient sweeping across it (the `.sparkle-build` animation) while
// the agent worked.
//
// It was deleted, not hidden, for the same reason the per-row WorkflowLine left the collapsed build
// rows: the column is a quiet list, and this was the only moving thing in it — a permanent
// animation on a permanently-present row, which is motion that stops reading as "look here" and
// becomes the background. It also had nothing to report that the disc didn't: the bar's three
// states were off / idle / building, and green-vs-gray already carries running-vs-not.
//
// If a progress affordance is ever wanted here again, the answer is the shared WorkflowLine on the
// detail card, not a second bar rendered inline on this one row.

// "Show Helper" lived here. It rendered ONLY while the floating island was hidden, and it was the
// only way back from right-click → Hide Helper — so it could not be deleted on its own without
// stranding anyone already in that state. Hide Helper went with it (helper/HelperApp.tsx), which is
// what made the removal safe. Its literal chrome, recorded because a later stream reuses the value:
// borderRadius 6, padding "3px 8px", fontSize 11, border `1px solid ${C.muted}`.

