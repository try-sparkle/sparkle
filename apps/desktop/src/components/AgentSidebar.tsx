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
  type RefObject,
  type DragEvent as ReactDragEvent,
} from "react";
import { createPortal } from "react-dom";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { TbPinFilled, TbBulb } from "react-icons/tb";
import { FaTasks } from "react-icons/fa";
import { C, AGENT_STATUS, FONT, FONT_WEIGHT, CHAT_USER_BUBBLE, ON_BRAND_FILL, ON_BRAND_FILL_DARK, DANGER, statusInk } from "../theme/colors";
import { listMyTickets, bannerFromTickets, TICKET_CREATED_EVENT, type TicketStatus } from "../services/supportApi";
import { WEB_BASE_URL } from "../services/sparkleApi";
import type { Project, AgentTab, AgentTabStatus } from "../types";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useInteractionStore } from "../stores/interactionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAiFeatureVisible } from "../services/aiGate";
import { removeAgentWorkspace } from "../services/worktree";
import { spinDownWorker } from "../services/workerSpawn";
import { killPty } from "../pty";
import { refreshAgentBranch, landAgentBranch } from "../services/branchStatus";
import type { BranchStatus } from "../services/branchStatus";
import { shouldPromptOnClose, selectionAfterClose } from "../engine/closeAgent";
import { shipAgent, saveAgent, discardAgentGit } from "../services/closeAgentActions";
import { refreshAgentTitle } from "../services/sessionTitle";
import {
  isNameFromWorkCandidate,
  maybeNameFromWork,
  WORK_BACKSTOP_WINDOW_TICKS,
} from "../services/agentNaming";
import { sparkleAgentIdFor } from "../services/sparkleAgent";
import { handleImproveSparkleClick } from "../services/sparkleReveal";
import { parseWindowLabelFromSearch } from "../services/projectWindows.url";
import { consentPillLabel, sparkleBarState, type SparkleBarState } from "./sparkleRowStatus";
import { useBeadsStore } from "../stores/beadsStore";
import { beadLabel, epicForBuild, epicPillFor } from "../services/planView";
import { type Bead } from "../services/beads";
import { orderedTopLevelAgents, firstVisibleAgentId } from "../engine/agentOrdering";
import { withUnstartedWorkerAttention, withRedWorkerAttention } from "../engine/workerAttention";
import { withDismissedAlerts, alertControlKind } from "../engine/alertDismissal";
import { AlertToggleButton } from "./AlertToggleButton";
import { reconcileWorkMode } from "../engine/workMode";
import { selectAndOpen } from "../useAttentionNotifications";
import { StatusDot } from "./StatusDot";
import { StatusBar } from "./StatusBar";
import { LogoWaveform } from "./LogoWaveform";
import { FittedAgentName } from "./FittedAgentName";
import { ModelPill } from "./ModelPill";
import { applyModelToRunningAgent } from "../services/agentModel";
import { WorkflowLine } from "./WorkflowLine";
import { HistorySearch } from "./HistorySearch";
import { OtherWindowAgentRow } from "./OtherWindowAgentRow";
import { useOtherWindowsRedGroups } from "../useOtherWindowsRedAgents";
import type { OtherWindowAgent } from "../services/windowStatus";
import { emitFocusAgent } from "../services/attention";
import { findWindowForProject } from "../services/windowRegistry";
import { openProjectInWindow, defaultDeps } from "../services/projectWindows";
import { resolveStage, rollupStages, stageFraction, stageIndex, LINE_FROM, LINE_TO } from "../engine/workflowStage";
import type { WorkflowStageId } from "../engine/workflowStage";
import { useSpawnBuildAgent } from "../hooks/useSpawnBuildAgent";
import { NEW_BUILD_AGENT_DND_TARGET } from "../services/dndTargets";
import { CloseAgentPrompt } from "./CloseAgentPrompt";
import { BalanceBadge } from "./BalanceBadge";

/**
 * Left column: the current project's agents as a vertical list (spec layout, revised).
 * Each row is a status dot + the agent name rendered in that status's color; click a row
 * to open the agent, double-click the agent name to rename it, ×
 * to close. "+ Agent" adds one.
 */
// The three create buttons (Think / Plan / Build) form one continuous Sparkle blue→cyan
// fade, split into thirds. These are the four fade boundaries: the cyan "S" accent on the far
// left of Think, the primary brand blue on the far right of Build, and two interpolated stops
// at 1/3 and 2/3 so each button paints exactly its slice of the SAME overall gradient.
const FADE_0 = C.accent; // #34e0f0 — logo cyan, far-left edge of Think
const FADE_1 = "#32b9f5"; // 1/3 stop (Think→Plan seam)
const FADE_2 = "#3192fa"; // 2/3 stop (Plan→Build seam)
const FADE_3 = C.teal; // #2f6bff — primary brand blue, far-right edge of Build

// Depth (px) of the chevron point/notch carved into a button's vertical edge.
const CHEVRON = 11;

// Width (px) of the hairline left between adjacent chevrons. We underlap the tessellation by this
// much (overlap = CHEVRON - SEAM) so a thin diagonal sliver of the wrapper's background shows
// through at each Think→Plan / Plan→Build seam.
const SEAM = 1;

// Build the clip-path for a button in the chevron strip. The OUTER edges of the strip
// (Think's left, Build's right) stay flat ("vertical button surfaces"); interior seams are
// arrow-shaped: a button that isn't last grows a rightward point, a button that isn't first
// gets a matching inward notch on its left so the previous button's point nests into it.
function chevronClip(leftNotch: boolean, rightPoint: boolean): string {
  const d = `${CHEVRON}px`;
  const pts: string[] = ["0 0"];
  if (rightPoint) {
    pts.push(`calc(100% - ${d}) 0`, "100% 50%", `calc(100% - ${d}) 100%`);
  } else {
    pts.push("100% 0", "100% 100%");
  }
  pts.push("0 100%");
  if (leftNotch) pts.push(`${d} 50%`);
  return `polygon(${pts.join(", ")})`;
}

// Shared style for a chevron in the mode strip: a solid gradient slice with NO border/stroke,
// clipped to its chevron shape. `fillText` is the per-chevron ink chosen for contrast on that fill.
// The strip's rounded outer corners come from the wrapper (overflow:hidden + borderRadius), so the
// chevrons themselves are square; `leftNotch` chevrons overlap the previous one by CHEVRON px
// (negative margin) so the point tessellates exactly into the notch. `active` is the currently
// selected mode: the active chevron keeps its brand color; the other two render grayscale.
function createBtnStyle(
  from: string,
  to: string,
  fillText: string,
  leftNotch: boolean,
  rightPoint: boolean,
  active: boolean,
): React.CSSProperties {
  return {
    flex: 1,
    padding: "9px 10px",
    border: "none",
    borderRadius: 0,
    marginLeft: leftNotch ? -(CHEVRON - SEAM) : 0,
    clipPath: chevronClip(leftNotch, rightPoint),
    cursor: "pointer",
    fontFamily: '"IBM Plex Sans", sans-serif',
    fontSize: 13,
    whiteSpace: "nowrap",
    background: `linear-gradient(90deg, ${from}, ${to})`,
    color: fillText,
    // The active mode shows its brand color; the inactive two desaturate to grayscale.
    filter: active ? "none" : "grayscale(1)",
    opacity: active ? 1 : 0.9,
    transition: "filter 120ms ease, opacity 120ms ease",
    // Flex-center the (enlarged, line-height-0) glyph against the label so the
    // icon sits on the label's vertical center rather than its text baseline.
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  };
}

// A dashed-outline "+ New <kind> Agent" row — the per-mode affordance for creating an agent,
// shown in the sidebar list for the active Build/Think mode: below the last row when the list
// fits, or pinned (sticky) at the top when the list is tall enough to scroll.
// Border is split into longhand props (width/style/color) so NewAgentRow's hover state can flip
// just the style (dashed → solid) and color without fighting a `border` shorthand.
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
  borderRadius: 8,
  background: "transparent",
  color: C.muted,
  fontFamily: '"IBM Plex Sans", sans-serif',
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
  // The user took over the scroll (their own wheel/drag closed the card): drop the baseline and any
  // pending ease-back so we never yank the list away from where they just put it.
  abandonReveal: () => void;
  // True while our own smooth scroll (reveal or restore) is in flight toward its target.
  isAutoScrolling: () => boolean;
};
const SidebarScrollContext = createContext<SidebarScrollApi | null>(null);

// The "+ New <kind> Agent" button. On hover the dotted outline becomes a solid stroke and the
// icon + label light up in the mode's brand color — the same blue/cyan as that mode's chevron
// (Build → FADE_3 brand blue, Think → FADE_0 logo cyan). The background is left unchanged.
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
      icon={<span style={{ fontSize: 20, lineHeight: 0 }}>⚒</span>}
      label="+ New Build Agent"
      hoverColor={FADE_3}
      onClick={onClick}
      sharedHover={buildAgentHover}
      onHoverChange={setBuildAgentHover}
      dndTarget={NEW_BUILD_AGENT_DND_TARGET}
      dataHint={dataHint}
    />
  );
}

export function AgentSidebar({ project }: { project: Project | null }) {
  const selectAgent = useProjectStore((s) => s.selectAgent);
  const touchProjectOpened = useProjectStore((s) => s.touchProjectOpened);
  const addAgent = useProjectStore((s) => s.addAgent);
  const removeAgent = useProjectStore((s) => s.removeAgent);
  const open = useRuntimeStore((s) => s.open);
  const close = useRuntimeStore((s) => s.close);
  const liveStatus = useRuntimeStore((s) => s.status);
  const openAgentIds = useRuntimeStore((s) => s.openAgentIds);
  // A spawned-but-never-started worker has no live status, so it (and the orchestrator it's
  // blocking) would render GRAY. Overlay RED ("Approve?") on the strand and bubble it to the parent
  // so the orchestrator row goes red — matching the TopBar dot cluster. No-op (same ref) when
  // nothing is stranded.
  const status = useMemo(() => {
    if (!project) return liveStatus;
    // Two attention overlays, composed: (1) an unstarted worker gets a synthetic red + bubbles to
    // its orchestrator; (2) a started-then-red worker (waiting/approval/errored) bubbles its own red
    // to its orchestrator so the orchestrator floats up and shows red. Order matters — run (2) after
    // (1) so a strand's synthetic red also bubbles.
    const s1 = withUnstartedWorkerAttention(project.agents, liveStatus, new Set(openAgentIds));
    return withRedWorkerAttention(project.agents, s1);
  }, [project, liveStatus, openAgentIds]);
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
  // The status map the ROW COLOR and the SORT ORDER read: the overlaid status with dismissed red
  // alarms de-escalated to their non-red tier (waiting/approval→idle, errored→stopped). Kept separate
  // from `status` so the OTHER consumers of red (cross-window publishing, dock notifications, the
  // alert-button state) still see the true, un-dismissed status.
  const effectiveStatus = useMemo(
    () => (project ? withDismissedAlerts(project.agents, status) : status),
    [project, status],
  );
  const branchStatus = useRuntimeStore((s) => s.branchStatus);
  const workflowStage = useRuntimeStore((s) => s.workflowStage);
  const workflowShipped = useRuntimeStore((s) => s.workflowShipped);
  const pollBranchStatus = useRuntimeStore((s) => s.pollBranchStatus);
  const activeSpecial = useUiStore((s) => s.activeSpecial);
  const setActiveSpecial = useUiStore((s) => s.setActiveSpecial);
  // This window's opaque label — derived from the same URL primitive the windowContext provider
  // uses (label param absent → "main"), read directly so this leaf doesn't require the provider
  // (keeps the component render-testable). Fixed for a window's life, so it's stable across
  // renders. Improve Sparkle is per-window: this window's own copy is keyed by
  // sparkleAgentIdFor(windowLabel) (see onSelectSparkle / services/sparkleReveal).
  const windowLabel =
    parseWindowLabelFromSearch(typeof window !== "undefined" ? window.location.search : "") ?? "main";
  const sparkleAgentId = sparkleAgentIdFor(windowLabel);

  // Red agents in OTHER open windows — surfaced as a block at the top of the sidebar, COLLAPSED to
  // one row per window (representative = most recently red; "+N" badge = the rest in that window).
  const otherWindowRedGroups = useOtherWindowsRedGroups();
  // Clicking such a row raises the owning window and selects the agent. Same three-way router as
  // HistorySearch.onResultClick: same project → focus in place; another OPEN window → emitFocusAgent
  // (the live path, since these only come from open windows); no window → open one (covers the rare
  // race where that window closed between render and click).
  const onOtherWindowAgentClick = (a: OtherWindowAgent) => {
    if (project && a.projectId === project.id) {
      // Same project shown here too: focus in place via the shared reveal (leaves any Sparkle/board
      // overlay AND switches the chevron to the agent's kind, so it's surfaced even from Plan mode —
      // where the reconcile effect alone wouldn't switch). Same path a cross-WINDOW jump takes.
      selectAndOpen(a.projectId, a.agentId);
      return;
    }
    if (findWindowForProject(a.projectId) != null) {
      emitFocusAgent({ projectId: a.projectId, agentId: a.agentId });
    } else {
      void openProjectInWindow(
        a.projectId,
        "new",
        defaultDeps(() => {}, touchProjectOpened, "main"),
        a.agentId,
      );
    }
  };

  // Which chevron is selected. Drives both the strip's coloring (active = brand, others grayscale)
  // and which agents the sidebar list shows. Defaults to Build; not persisted across launches.
  // Lifted into uiStore (workMode/setWorkMode) so other components — e.g. ThinkPanel's "Make a
  // Plan" button — can switch tabs. Behavior is identical to the old local useState.
  const mode = useUiStore((s) => s.workMode);
  const setMode = useUiStore((s) => s.setWorkMode);
  const agentOrdering = useUiStore((s) => s.agentOrdering);
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
          a.kind !== "think" && a.kind !== "shell"; // those have no git workflow
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
  // AI Brainstorming feature gate (Use AI Features menu). Off → hide the ✦ Brainstorm button.
  // VISIBLE (settings flag only, ignores credits): the Think chevron + Think-mode navigation must
  // show during the trial / when out of credits so the user can SEE the feature. The buy-to-use
  // upsell fires later, in ThinkPanel's submit (aiFeatureLockedNow("brainstorm")) — this variable
  // only governs UI presence and work-mode reconciliation, never an AI action, so `visible` is
  // correct for every site it gates.
  const aiBrainstorm = useAiFeatureVisible("brainstorm");
  // Beads tool gate ([tools].beads). Off → the Plan chevron (the read-only Tasks board entry) is
  // hidden and no `bd` shell-out runs (see beadsStore). Mirrors the Think chevron's aiBrainstorm gate.
  const beadsEnabled = useSettingsStore((s) => s.beadsEnabled);
  const [editing, setEditing] = useState<string | null>(null);
  // Which agent the Ship/Save/Discard close prompt is asking about (null = no prompt).
  const [closePromptId, setClosePromptId] = useState<string | null>(null);

  // Draggable column width — persisted to localStorage so it survives relaunch. Clamped to
  // a sane range so the column can't be dragged to nothing or take over the window.
  const MIN_WIDTH = 160;
  const MAX_WIDTH = 480;
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("sparkle-sidebar-width"));
    return saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : 220;
  });

  const startResize = (e: React.MouseEvent) => {
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

  const onSelect = (id: string) => {
    if (!project) return;
    // Switching to a normal project agent leaves the special (Sparkle) view.
    setActiveSpecial(null);
    selectAgent(project.id, id);
    open(id);
  };
  const onAddThink = () => {
    if (!project) return;
    setActiveSpecial(null); // creating an agent leaves the special (Sparkle) view
    // Think now allows multiple agents per project: always create a fresh one (parallels Build).
    const id = addAgent(project.id, { kind: "think" });
    selectAgent(project.id, id);
    open(id);
  };
  // The chevron strip switches the active (colored) mode and filters the sidebar list by kind. Think
  // and Build are two-stage: the FIRST click (when that mode isn't already the active section) just
  // switches into the section; clicking the SAME chevron AGAIN while already in that section spawns a
  // fresh agent of that kind (same as the "+ New Think/Build Agent" buttons). Plan stays a pure mode
  // switch: it has no agent concept and only opens the read-only Tasks board in the main pane.
  const onPickThink = () => {
    // "Already in the Think section" = Think mode AND not parked in a special (Sparkle/board) view.
    const alreadyHere = mode === "think" && activeSpecial === null;
    setMode("think");
    setActiveSpecial(null);
    if (!project) return;
    if (alreadyHere) {
      // Second click on the active chevron: spawn a fresh agent of this kind (≡ the + button).
      const id = addAgent(project.id, { kind: "think" });
      selectAgent(project.id, id);
      open(id);
      return;
    }
    // Switching INTO Think: move selection to the first Think row so the pane matches the chevron
    // (or clear it → the empty Think state). Without this the pane keeps rendering the previously
    // selected build agent under a Think chevron.
    const next = firstVisibleAgentId(project.agents, "think", agentOrdering, status);
    selectAgent(project.id, next);
    if (next) open(next);
  };
  const onPickPlan = () => {
    setMode("plan");
    setActiveSpecial("board");
  };
  // Spawn a build agent AND auto-create a bead for it, so every piece of build work is tracked
  // from the start (it floors at "Planned" until code work begins). Shared with the Workspace
  // empty-state start button via the useSpawnBuildAgent hook so both create agents identically.
  const spawnBuildAgent = useSpawnBuildAgent(project);
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
    // Switching INTO Build: move selection to the first Build row so the pane matches the chevron
    // (or clear it → the empty Build state with "+ New Build Agent"). Pass the fresh build agent so
    // selection lands on the same top row the list renders.
    const next = firstVisibleAgentId(
      project.agents,
      "build",
      agentOrdering,
      status,
      project.freshBuildAgentId,
    );
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
  // After a close removes an agent (and its workers), keep selection coherent with the sidebar:
  // when the OPEN agent got torn down, re-point selection at the first visible row of the current
  // mode (or null → blank first-load state). Decision logic is the pure selectionAfterClose; here
  // we just feed it the pre-removal snapshot (`project`) + the fresh post-removal list and apply
  // the result. Mirrors the workerSpawn re-select precedent.
  const reselectAfterClose = (removedRootId: string) => {
    if (!project) return;
    const fresh = useProjectStore.getState().projects.find((p) => p.id === project.id);
    if (!fresh) return;
    // Read ALL inputs FRESH (not the render-scope `status`/`mode`/`agentOrdering`): now that AgentRow
    // is memoized, the `onClose` closure that reaches here may have been captured a few renders ago.
    // `agentOrdering` in particular is reachable-stale — toggling attention-ordering keeps a row whose
    // orderedIndex didn't change mounted, so its captured closure would otherwise pick the next
    // selection against the old ordering (sparkle-alrm.3).
    const rt = useRuntimeStore.getState();
    const { workMode: freshMode, agentOrdering: freshOrdering } = useUiStore.getState();
    const freshStatus = withUnstartedWorkerAttention(
      fresh.agents,
      rt.status,
      new Set(rt.openAgentIds),
    );
    const decision = selectionAfterClose(
      removedRootId,
      project.selectedAgentId,
      project.agents,
      fresh.agents,
      freshMode,
      freshOrdering,
      freshStatus,
    );
    if (decision.reselect) selectAgent(project.id, decision.next);
  };
  // Tear an agent down: drop it (and its workers) from the stores and remove their worktrees. The
  // BRANCH is intentionally kept (remove_worktree_at), so this is the "Save" outcome — Discard adds
  // an explicit branch+bead delete on top (onDiscardClose).
  const teardownAgent = async (id: string) => {
    if (!project) return;
    const agent = project.agents.find((a) => a.id === id);
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
  // unit-tested; here we just resolve the target and tear down after.
  const onShipClose = async () => {
    const id = closePromptId;
    setClosePromptId(null);
    if (!id || !project) return;
    const agent = project.agents.find((a) => a.id === id);
    const target = project.defaultBranch ?? agent?.baseBranch ?? "main";
    try {
      await shipAgent({
        root: project.rootPath,
        agentId: id,
        targetBranch: target,
        prTitle: agent?.name ?? "",
        beadId: agent?.beadId,
      });
    } catch (e) {
      console.warn("ship-on-close failed (agent kept):", e);
    }
    await teardownAgent(id);
  };

  // Save for later: back the branch up to the remote (best-effort), keep the bead; teardownAgent
  // removes the worktree but KEEPS the branch — exactly "save".
  const onSaveClose = async () => {
    const id = closePromptId;
    setClosePromptId(null);
    if (!id || !project) return;
    await saveAgent(project.rootPath, id);
    await teardownAgent(id);
  };

  // Discard: drop the agent + its workers from the store, delete their worktrees + branches and ALL
  // their beads (workers carry their own). Behind an explicit confirm. Irreversible — never merged.
  const onDiscardClose = async () => {
    const id = closePromptId;
    setClosePromptId(null);
    if (!id || !project) return;
    const children = project.agents.filter((a) => a.parentId === id);
    const ids = [id, ...children.map((a) => a.id)];
    const beadIds = [
      project.agents.find((a) => a.id === id)?.beadId,
      ...children.map((a) => a.beadId),
    ].filter((b): b is string => !!b);
    for (const cid of ids) close(cid);
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
  // Manual reorder drag state (spec: manual-agent-reorder-pin). The id of the top-level agent
  // currently being dragged by its grip; drop pins it at the target row via pinAgentAt.
  const pinAgentAt = useProjectStore((s) => s.pinAgentAt);
  const [dragId, setDragId] = useState<string | null>(null);
  const onAgentDragStart = (id: string) => setDragId(id);
  const onAgentDragEnd = () => setDragId(null);
  const onAgentDrop = (index: number, targetId: string) => {
    // Skip a self-drop (released on the agent's own row): it's a no-op move, so don't pin/freeze
    // the name for a drag that visually did nothing (roborev 13174/13175).
    if (dragId && project && dragId !== targetId) pinAgentAt(project.id, dragId, index);
    setDragId(null);
  };

  // Whether the agent list overflows its viewport. Drives where the "+ New … Agent" button lives:
  // a short list gets it BELOW the last row; once the list is tall enough to scroll, it pins to the
  // top (sticky) so it's always reachable without scrolling. The button occupies the same flow
  // height in either placement, so the comparison is placement-independent — no oscillation.
  const [listOverflows, setListOverflows] = useState(false);
  // Deliberately dep-less: content height changes whenever the row set re-renders, and the check is
  // one DOM read + a bail-out setState. Container-size changes that DON'T re-render React (window /
  // column resize) are caught by the ResizeObserver below.
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
      abandonReveal: () => {
        clearRestoreTimer();
        baselineRef.current = null;
      },
      isAutoScrolling: () => autoTargetRef.current != null,
    };
  }, []);
  // Keep the chevron coherent with what the main pane shows. The pane renders the SELECTED agent by
  // its kind (think → ThinkPanel, else terminal), so the active mode must match the selected agent's
  // kind — otherwise a cross-kind select (Ask-Sparkle from a build terminal, a notification/history
  // jump, or a selection restored on boot) leaves the chevron pointing at the wrong section while
  // that agent's pane is showing. reconcileWorkMode also subsumes the old brainstorm-gate fallback
  // (never sit on a hidden Think chevron). It leaves Plan/Sparkle (activeSpecial) and the empty pane
  // untouched. The chevron handlers move selection in the other direction, so the two converge.
  useEffect(() => {
    const selKind = project?.agents.find((a) => a.id === project.selectedAgentId)?.kind;
    const next = reconcileWorkMode(selKind, mode, activeSpecial !== null, aiBrainstorm);
    if (next) setMode(next);
  }, [project, aiBrainstorm, mode, activeSpecial, setMode]);
  // If Beads is turned off while the user is parked on the (now-hidden) Plan board, leave it — the
  // board won't render and the Plan chevron is gone, so a stuck empty state would result otherwise.
  // Also covers Plan mode without the board special (e.g. ThinkPanel's decompose hand-off sets
  // workMode "plan" alone), so no code path can strand the user in a Plan mode they can't leave.
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
    const buildIds = new Set<string>();
    for (const a of project.agents) {
      if (a.kind === "build") buildIds.add(a.id);
      if (a.parentId) {
        const arr = childrenByParent.get(a.parentId);
        if (arr) arr.push(a);
        else childrenByParent.set(a.parentId, [a]);
      }
    }
    const topLevelAgents = project.agents.filter((a) => !a.parentId || !buildIds.has(a.parentId));
    return { topLevelAgents, childrenByParent };
  }, [project]);

  // The ordered top-level stack the list renders. Memoized (sparkle-alrm.3) so it only re-sorts when
  // the agent set, overlaid status, mode, or ordering actually change — not on every unrelated
  // re-render. Sorts on `effectiveStatus` (dismissed reds de-escalated) so a dismissed row drops out
  // of the red zone. Shares orderedTopLevelAgents + the same attention-ordering and dismissal overlays
  // with the TopBar dot cluster, so the two stay in lockstep for those (see TopBar effStatus for the
  // one pre-existing gap: TopBar omits withRedWorkerAttention's worker→orchestrator red bubble).
  const ordered = useMemo(
    () =>
      project
        ? orderedTopLevelAgents(
            project.agents,
            effectiveStatus,
            mode,
            agentOrdering === "attention",
            project.freshBuildAgentId,
          )
        : [],
    [project, effectiveStatus, mode, agentOrdering],
  );

  // The active mode's "+ New … Agent" button (null in Plan / no project / Think gated off).
  // Rendered in ONE of two slots in the scroll container below, chosen by listOverflows.
  const newAgentButton =
    project && mode === "build" ? (
      <NewBuildAgentButton onClick={spawnBuildAgent} dataHint="newbuild" />
    ) : project && mode === "think" && aiBrainstorm ? (
      <NewAgentRow
        icon={<TbBulb size={16} style={{ flexShrink: 0 }} />}
        label="+ New Think Agent"
        hoverColor={FADE_0}
        onClick={onAddThink}
      />
    ) : null;

  return (
    <SidebarScrollContext.Provider value={sidebarScroll}>
    <div
      style={{
        width,
        flex: "0 0 auto",
        position: "relative",
        background: C.deepForest,
        borderRight: `1px solid ${C.forest}`,
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      {/* position:relative + zIndex keep the Sparkle.ai logo IN FRONT of the voice-orb glow
          that the waveform paints below — the glow can bleed upward into this row, but the
          logo must stay crisp on top of it, never washed out behind it. */}
      <div
        style={{
          padding: "14px 14px 6px",
          position: "relative",
          zIndex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        {/* Anchor (not a bare clickable <img>) so the logo is focusable and announced as a
            link; the system browser is opened via the Tauri opener, so we preventDefault and
            surface any opener failure rather than swallowing the promise. */}
        <a
          href="https://sparkle.ai"
          title="Open sparkle.ai"
          onClick={(e) => {
            e.preventDefault();
            openUrl("https://sparkle.ai").catch((err) =>
              console.error("Failed to open sparkle.ai:", err),
            );
          }}
          style={{ display: "inline-flex", cursor: "pointer" }}
        >
          <img src="/sparkle-logo.svg" alt="Sparkle" style={{ height: 25 }} />
        </a>
        {/* Remaining AI-credit balance, top-right of the left column beside the wordmark. */}
        <BalanceBadge />
      </div>
      <LogoWaveform />

      {project && (
        <div
          style={{
            display: "flex",
            margin: "0 10px 8px",
            borderRadius: 8,
            overflow: "hidden",
            // Seam between chevrons = the sidebar background (light gray, theme-aware), not white.
            background: C.deepForest,
          }}
        >
          {/* Think / Plan / Build form one chevron strip painting a single blue→cyan fade. It's a
              MODE SELECTOR: the active chevron keeps its color, the other two go grayscale.
              Think is AI feature-gated (the "Enable AI Thinking" toggle): off → it disappears
              and Plan becomes the strip's flat-left start. The gate flag stays aiBrainstorm. */}
          {aiBrainstorm && (
            <button
              data-hint="think"
              onClick={onPickThink}
              title="Think mode — your Think agents"
              // First in the strip: flat left, points right into Plan. Cyan ("S" color) leads; dark ink.
              style={createBtnStyle(FADE_0, FADE_1, ON_BRAND_FILL_DARK, false, true, mode === "think")}
            >
              <TbBulb size={18} style={{ flexShrink: 0 }} />
              <span>Think</span>
            </button>
          )}
          {beadsEnabled && (
            <button
              data-hint="plan"
              onClick={onPickPlan}
              title="Plan mode — this project's read-only Tasks board"
              // Full chevron when Think is present (notch left + point right); flat-left start when not.
              style={createBtnStyle(FADE_1, FADE_2, ON_BRAND_FILL_DARK, aiBrainstorm, true, mode === "plan")}
            >
              <FaTasks size={14} style={{ flexShrink: 0 }} />
              <span>Plan</span>
            </button>
          )}
          <button
            data-hint="build"
            onClick={onPickBuild}
            title="Build mode — your Build orchestrator agents"
            // Last in the strip: notched left when anything precedes it (Think and/or Plan), flat right.
            style={createBtnStyle(FADE_2, FADE_3, ON_BRAND_FILL, aiBrainstorm || beadsEnabled, false, mode === "build")}
          >
            <span style={{ fontSize: 26, lineHeight: 0, transform: "translateY(-3.5px)" }}>⚒</span>
            <span>Build</span>
          </button>
        </div>
      )}

      {/* Full-text search across all projects' prompts & responses. Lives directly under the
          chevron strip; hidden in Plan mode (the sidebar is kept clear for the board). */}
      {project && mode !== "plan" && <HistorySearch currentProjectId={project.id} />}

      <div
        ref={listScrollRef}
        data-testid="agent-list-scroll"
        style={{ flex: 1, overflowY: "auto", padding: "0 8px" }}
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
        {/* Cross-window attention block: red agents from OTHER open windows, each tagged with a
            project pill. Sits ABOVE this window's own agents (and below the "+ New … Agent" button
            when the overflowing list pins it to the top — with a short list the button renders
            below the last row instead); hidden when there are none. Click raises the owning window
            and selects the agent. */}
        {otherWindowRedGroups.length > 0 && (
          <div style={{ paddingTop: 2, paddingBottom: 6, marginBottom: 4, borderBottom: `1px solid ${CHAT_USER_BUBBLE}` }}>
            {otherWindowRedGroups.map((group) => (
              <OtherWindowAgentRow
                key={group.windowLabel}
                agent={group.agent}
                extraCount={group.count - 1}
                onClick={() => onOtherWindowAgentClick(group.agent)}
              />
            ))}
          </div>
        )}
        {(() => {
          if (!project) return null;
          if (mode === "plan") return null; // Plan: sidebar list stays clear (board shows in main pane)
          // Top-level agents (build agents + workers orphaned by a missing parent), mode-filtered
          // and attention-ordered. Shared with the TopBar dot cluster via orderedTopLevelAgents so
          // the header dots can't drift out of sync with these rows. Only the top-level stack
          // reorders; nested workers stay under their parent in insertion order. Selection is
          // tracked by id (project.selectedAgentId), so re-sorting never changes which agent is open.
          // `ordered` is memoized in the component body above (sparkle-alrm.3).
          return ordered.map((top, orderedIndex) => {
            // O(1) lookup into the memoized parentId→children bucket (built once above), in place of
            // an O(agents) `.filter` per orchestrator. Same set, same insertion order — see childrenByParent.
            const workers = top.kind === "build" ? childrenByParent.get(top.id) ?? [] : [];
            // The orchestrator's chevron rolls up its workers (overall = least-advanced worker);
            // with no workers it just shows its own git stage. A worker/think/shell row shows
            // its own. (Think has no worktree, so it resolves to the harmless start stage and
            // we simply don't render a tracker for it — see renderRow.)
            const workerStages = workers.map((w) => stageOf(w.id));
            const rollup = rollupStages(workerStages);
            // EVERY worker renders as a named, clickable inline line INSIDE the orchestrator's own
            // AgentRow — its name (red when it needs you) beside its own progress bar — plus an
            // expanded detail block on the head's hover card. There is no separate pop-out row: a
            // worker that needs attention is shown by its inline name going red (and the attention
            // still bubbles red up to the orchestrator's own row + the TopBar dot, so it's noticed).
            // Pre-compute the minimal per-worker view-model here, where stageOf/status/branchStatus/
            // shippedOf are in scope.
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
              rowIndex?: number,
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
          // Indent by tree position, not by parentId: the group head (top) sits at depth 0 — so
          // an orphaned worker surfaced as its own head isn't mis-indented — and real children at 1.
          const depth = a.id === top.id ? 0 : 1;
          return (
            <AgentRow
              key={a.id}
              project={project}
              a={a}
              depth={depth}
              isActive={isActive}
              st={st}
              statusColor={color}
              alertControl={alertControl}
              onDismissAlert={() => dismissAlert(project.id, a.id, trueSt)}
              onReenableAlert={() => reenableAlert(project.id, a.id)}
              bs={bs}
              trackerStage={trackerStage}
              shipped={rowShipped}
              workerCount={a.id === top.id ? workers.length : 0}
              workers={a.id === top.id ? workerDetails : []}
              orderedIndex={rowIndex}
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

            // The orchestrator's own chevron: the roll-up of its workers, or its own git stage when
            // it has none. Think/shell agents have no git workflow → no tracker (null).
            const headStage: WorkflowStageId | null =
              top.kind === "think" || top.kind === "shell"
                ? null
                : rollup
                  ? rollup.stage
                  : stageOf(top.id);
            // The orchestrator's head row owns ALL its workers, passed via AgentRow's `workers` prop.
            // Collapsed, the head shows only its own title (auto-promoted from its representative
            // worker) + this rollup bar — no inline worker rows. Every worker renders as a stacked
            // detail block inside the CLICK-opened detail card (see CardDetail / WorkerNameButton).
            // A worker that needs attention still bubbles red up to this head row + the TopBar dot, so
            // it's noticed without being expanded.
            return <div key={top.id}>{renderRow(top, headStage, orderedIndex)}</div>;
          });
        })()}
        {/* Default placement: below the last row, when the list fits without scrolling. (When it
            doesn't fit, the sticky top slot above renders the button instead.) Same wrapper as the
            sticky slot minus the pinning, so the button adds the same height either way. */}
        {newAgentButton && !listOverflows && (
          <div style={NEW_AGENT_SLOT_STYLE}>{newAgentButton}</div>
        )}
        {/* Per-mode empty hint: the dashed "+ New …" row above is the call to action. */}
        {project &&
          mode === "build" &&
          topLevelAgents.filter((a) => a.kind !== "think").length === 0 && (
            <div style={{ color: C.muted, fontSize: 12, padding: "2px 10px 10px", lineHeight: 1.5 }}>
              No Build agents yet — use <strong>+ New Build Agent</strong> above to start one.
            </div>
          )}
        {project &&
          mode === "think" &&
          aiBrainstorm &&
          topLevelAgents.filter((a) => a.kind === "think").length === 0 && (
            <div style={{ color: C.muted, fontSize: 12, padding: "2px 10px 10px", lineHeight: 1.5 }}>
              No Think agents yet — use <strong>+ New Think Agent</strong> above to start one.
            </div>
          )}
        {!project && (
          <div style={{ color: C.muted, fontSize: 12, padding: 10, lineHeight: 1.5 }}>
            Create a project to add agents.
          </div>
        )}
      </div>

      {/* Pinned above the footer: the Sparkle self-improvement agent. Always present (even with
          no project open), can't be closed — it works on Sparkle itself, not the user's project. */}
      <SparkleAgentRow
        active={activeSpecial === "sparkle"}
        status={status[sparkleAgentId] ?? "stopped"}
        onSelect={onSelectSparkle}
      />

      {/* Support-ticket status banner: shows the user's OPEN tickets (Submitted / Responded).
          Renders nothing when there are none. Sits between Improve Sparkle and the footer. */}
      <SupportTicketRow />

      {/* Bottom-left: version + "Show logs". Pinned under the agent list. */}
      <StatusBar />

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

      {/* Drag handle on the right edge — resize the column wider/narrower. */}
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        style={{
          // Kept fully inside the column (right:0) so the 6px hit area can't intercept
          // clicks on the adjacent panel's left edge.
          position: "absolute",
          top: 0,
          right: 0,
          width: 6,
          height: "100%",
          cursor: "col-resize",
          zIndex: 1,
        }}
      />
    </div>
    </SidebarScrollContext.Provider>
  );
}

// The leading glyph slot is a fixed height so the glyph AND the title beside it sit at the exact
// same spot whether the card is collapsed or expanded — on hover the card only grows DOWNWARD,
// so the eye never sees the pickaxe or title jump. Module-level so the elapsed timer can match it.
const GLYPH_SLOT_H = 20;

// Radius of the concave fillets that flare the active row's right edge open into the terminal.
const ACTIVE_FILLET = 8;

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
      style={{
        flex: "0 0 auto",
        height: GLYPH_SLOT_H,
        display: "flex",
        alignItems: "center",
        fontSize: 11,
        color,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {formatElapsed(Math.max(0, now - since))}
    </div>
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
  statusColor: string;
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
  orderedIndex?: number;
  dragActive: boolean;
  onDragStartAgent: (id: string) => void;
  onDragEndAgent: () => void;
  onDropAgent: (index: number, targetId: string) => void;
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
    prev.statusColor === next.statusColor &&
    prev.alertControl === next.alertControl &&
    prev.bs === next.bs &&
    prev.trackerStage === next.trackerStage &&
    prev.shipped === next.shipped &&
    prev.workerCount === next.workerCount &&
    prev.orderedIndex === next.orderedIndex &&
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
  statusColor,
  alertControl,
  onDismissAlert,
  onReenableAlert,
  bs,
  trackerStage,
  shipped,
  workerCount,
  workers,
  orderedIndex,
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
  // Click opens the detail card ("modal"). It bypasses the hover-intent dwell entirely: a deliberate
  // click should select + open NOW, so cancel any armed hover-commit and select immediately, then
  // open the card. Hover no longer opens the card; only a deliberate click does.
  const openCard = () => {
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

  const kindGlyph =
    a.kind === "think" ? (
      <TbBulb size={16} />
    ) : a.kind === "worker" ? (
      "↳"
    ) : a.kind === "shell" ? (
      "▶"
    ) : (
      "⚒"
    );
  // Width of the leading glyph slot, kept identical for the glyph and its hover-state × so the
  // name never shifts horizontally when the row expands.
  const glyphWidth = a.kind === "build" ? 24 : a.kind === "think" ? 20 : 12;

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

  // The pin chip (manual pin: name frozen + row anchored). Click to release. Shared by both states.
  const pinChip = a.namePinned ? (
    <span
      onClick={(e) => {
        e.stopPropagation();
        unpinAgent(project.id, a.id);
      }}
      title="Pinned — won't auto-rename or reorder. Click to unpin."
      style={{ display: "inline-flex", flex: "0 0 auto", cursor: "pointer", lineHeight: 1, color: C.muted }}
    >
      <TbPinFilled size={11} />
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
        border: `1px solid ${C.teal}55`,
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
          {/* The × close control lives in this slot on hover (expanded) — AND persistently on the
              ACTIVE row, whose output fills the main pane, so the agent you're looking at always has
              a visible way to close it (the status stays legible via the status-colored title). */}
          {expanded || isActive ? (
            <CloseAgentButton onClose={onClose} width={glyphWidth} />
          ) : (
            <span
              title={`${a.kind} — ${AGENT_STATUS[st].label}`}
              style={{
                fontSize: a.kind === "build" ? 28.8 : a.kind === "think" ? 19.5 : 12,
                color: statusColor,
                // line-height 0 lets the enlarged ⚒ overflow its line box (staying centered in the
                // slot) without driving the row's height.
                lineHeight: 0,
              }}
            >
              {kindGlyph}
            </span>
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
                if (next.trim() && next !== a.name) renameAgent(project.id, a.id, next, orderedIndex);
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
                <ElapsedTimer since={lastTouchAt} now={clockNow} color={statusColor} />
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
                      color: statusColor,
                      fontSize: 13,
                      fontWeight: isActive ? FONT_WEIGHT.bold : FONT_WEIGHT.semibold,
                    }}
                  >
                    {fullTitle}
                  </span>
                  {description && (
                    <span style={{ color: statusColor, fontSize: 13, fontWeight: FONT_WEIGHT.regular }}>
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
                <ElapsedTimer since={lastTouchAt} now={clockNow} color={statusColor} />
              )}
              <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
                <FittedAgentName
                  title={autoTitle}
                  name={a.name}
                  color={statusColor}
                  active={isActive}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditing(a.id);
                  }}
                />
                {epicPill}
                {pinChip}
              </div>
            </div>
          )}
          {/* The agent's live first-person "what I'm building now" narration, self-reported via the
              sparkle-control MCP set_agent_activity op. A subtle muted secondary line under the name,
              truncated to one line so a long report can't grow the strip over the rows beneath. */}
          {a.activity?.trim() && (
            <div
              title={a.activity}
              style={{
                color: C.muted,
                fontSize: 11,
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
          {/* The thin progress line under the title. Collapsed it's just the line (no text);
              expanded (on hover) it grows a status label to the RIGHT of the bar describing the
              current stage — the same bar+readout in both states, so the hover card keeps the
              visual progress bar, not only the worded "Progress" detail line below. */}
          {trackerStage && (
            <div style={{ marginTop: 1 }}>
              <WorkflowLine stage={trackerStage} expanded={expanded} shipped={shipped} />
            </div>
          )}
          {/* NOTE: the per-worker progress lines no longer render in the collapsed column row — the
              head shows only its own rollup bar there. Every worker is revealed on CLICK, as a stacked
              detail block in CardDetail below (the row's onClick opens the card). */}
        </div>
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
          <span style={{ color: C.muted, fontSize: 11 }}>{beadHover}</span>
        </DetailLine>
      )}
      {epicHover && (
        <DetailLine label="Epic">
          <span style={{ color: C.muted, fontSize: 11 }}>{epicHover}</span>
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
                  <WorkflowLine stage={w.stage} expanded shipped={w.shipped} />
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
  // Three shading states read at a glance: the row you're IN is the TERMINAL color (C.forest) so the
  // active card reads as an extension of the terminal it opens over; a row you're merely hovering
  // (not selected) is CHAT_USER_BUBBLE; idle rows are transparent. When active, the card "merges"
  // into the terminal — no right border, no drop-shadow — so there's no seam between the column and
  // the terminal window (mergeIntoTerminal below drives that).
  const mergeIntoTerminal = isActive;
  const cardBg = isActive ? C.forest : CHAT_USER_BUBBLE;
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
    orderedIndex != null && !editing
      ? {
          draggable: true,
          // Signal draggability to assistive tech without an aria-label (which would override the
          // row's name). aria-roledescription supplements the announced content instead.
          "aria-roledescription": "draggable agent card",
          onDragStart: (e: ReactDragEvent) => {
            e.stopPropagation();
            onDragStartAgent(a.id);
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
        onClick={openCard}
        onMouseEnter={armSelect}
        onMouseLeave={onRowLeave}
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          padding: "8px 10px",
          marginLeft: depth * 16,
          // Active row is the TERMINAL color, extending past the list's 8px right padding
          // (marginRight:-8) to the sidebar's right border — which is also C.forest, as is the
          // terminal beyond it — so the row flows into the terminal window. Left corners round into
          // the sidebar (8px); the right edge is square here, with CONCAVE fillets (below) flaring it
          // open into the terminal rather than a convex "button" corner. Idle rows are fully rounded.
          borderRadius: isActive ? "8px 0 0 8px" : 8,
          marginRight: isActive ? -8 : 0,
          cursor: "pointer",
          // The whole card is a drag handle for reorderable rows — suppress text selection so a
          // drag grabs the card instead of highlighting the name underneath the cursor. Gated on
          // !editing (like dragProps) so the rename <input> keeps normal text selection.
          userSelect: orderedIndex != null && !editing ? "none" : undefined,
          // Active = the terminal's own color (merges into it); the hover state's CHAT_USER_BUBBLE
          // lives on the unified card, not here. Cleared while the card is open (showOverlay) so the
          // row reads as empty behind the stand-in card.
          background: !showOverlay && isActive ? C.forest : "transparent",
          marginBottom: 2,
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
        {/* CONCAVE corner fillets where the active tab opens into the terminal. Each is a small box
            just above / below the tab's right edge; a radial-gradient paints the terminal color
            (C.forest) everywhere EXCEPT a quarter-disc cut from the corner nearest the sidebar, so
            the forest flares outward into the terminal with a smooth inward (concave) curve — an
            "opening", not a convex button corner. pointerEvents:none so they never eat clicks.
            Suppressed while the card is open (showOverlay): the row is no longer visibility:hidden,
            so — unlike before — these would otherwise show through beside the stand-in card. */}
        {isActive && !showOverlay && (
          <>
            <div
              aria-hidden
              style={{
                position: "absolute",
                top: -ACTIVE_FILLET,
                right: 0,
                width: ACTIVE_FILLET,
                height: ACTIVE_FILLET,
                background: `radial-gradient(circle at top left, transparent ${ACTIVE_FILLET}px, ${C.forest} ${ACTIVE_FILLET}px)`,
                pointerEvents: "none",
              }}
            />
            <div
              aria-hidden
              style={{
                position: "absolute",
                bottom: -ACTIVE_FILLET,
                right: 0,
                width: ACTIVE_FILLET,
                height: ACTIVE_FILLET,
                background: `radial-gradient(circle at bottom left, transparent ${ACTIVE_FILLET}px, ${C.forest} ${ACTIVE_FILLET}px)`,
                pointerEvents: "none",
              }}
            />
          </>
        )}
        {/* Drop target — only while a drag is in flight and only on top-level rows. Dropping here
            pins the dragged agent at THIS row's index (manual-agent-reorder-pin). */}
        {orderedIndex != null && dragActive && (
          <div
            data-testid="agent-drop-target"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              onDropAgent(orderedIndex, a.id);
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
                padding: "8px 10px",
                cursor: "pointer",
                userSelect: orderedIndex != null && !editing ? "none" : undefined,
                background: cardBg,
                // The card fill is the terminal's own color so it reads as part of the terminal; a
                // 4px border in the SIDEBAR color (C.deepForest, lighter than C.forest) then outlines
                // the card shape so its text is distinguishable from the terminal text behind it.
                // (Doubled from 2px so the card is easier to tell apart from the terminal content.)
                // Hover-only (non-active) cards keep the thinner forest border on their bubble fill.
                border: `${mergeIntoTerminal ? "4px" : "2px"} solid ${mergeIntoTerminal ? C.deepForest : C.forest}`,
                borderRadius: "8px 8px 0 8px",
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
                // Offset right by the column width so the detail drops on the terminal side — but lap
                // 8px back over the column when active, so the active card overlaps the first column
                // by the same ~8px the inactive (hover-only) card already does. (The active in-flow
                // row's marginRight:-8 widens its measured colW by 8px, so without this it would land
                // flush at the sidebar edge with no overlap, unlike the inactive card.)
                marginLeft: mergeIntoTerminal ? colW - 8 : colW,
                // Lap the strip's bottom border (4px when active, else 2px) so the two halves read
                // as one continuous outline.
                marginTop: mergeIntoTerminal ? -4 : -2,
                // When the active card laps 8px back over the column (marginLeft above), widen by the
                // same 8px so its RIGHT edge stays anchored at the terminal edge — the card grows into
                // the column rather than sliding left and pulling short on the right.
                width: mergeIntoTerminal ? ext + 8 : ext,
                userSelect: orderedIndex != null && !editing ? "none" : undefined,
                // flex-shrink + scroll within the wrapper's maxH budget (minus the strip), so the
                // detail's scroll boundary lands inside the viewport even for a tall card.
                flex: "1 1 auto",
                minHeight: 0,
                overflowY: "auto",
                padding: "2px 10px 8px",
                cursor: "pointer",
                background: cardBg,
                // Same outline as the strip (4px sidebar color when active) continues down the L's
                // left/right/bottom so the whole card is encapsulated against the terminal behind it.
                borderLeft: `${mergeIntoTerminal ? "4px" : "2px"} solid ${mergeIntoTerminal ? C.deepForest : C.forest}`,
                borderRight: `${mergeIntoTerminal ? "4px" : "2px"} solid ${mergeIntoTerminal ? C.deepForest : C.forest}`,
                borderBottom: `${mergeIntoTerminal ? "4px" : "2px"} solid ${mergeIntoTerminal ? C.deepForest : C.forest}`,
                borderRadius: "0 0 8px 8px",
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
    fontFamily: FONT.ui,
    padding: "2px 7px",
    borderRadius: 5,
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
                background: `${C.success}22`,
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
          <span style={{ color: C.muted, fontSize: 11 }}>Up to date with {baseLabel}</span>
        )}
      </DetailLine>
      {progressPct != null && (
        <DetailLine label="Progress">
          <span style={{ color: C.muted, fontSize: 11 }}>
            {workerCount > 0 ? `${workerCount} worker${workerCount === 1 ? "" : "s"}. ` : ""}
            {progressPct}% complete{workerCount > 0 ? " overall" : ""}.
            {/* Carry the sticky "landed" signal into the expanded card too, so the ✓ doesn't
                vanish on hover — it persists even after the bar resets for a new cycle. */}
            {shipped && (
              <span style={{ color: C.successInk, fontWeight: 600 }}> ✓ Landed</span>
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
      <span style={{ flex: "0 0 auto", color: C.muted, fontSize: 11, fontWeight: FONT_WEIGHT.semibold }}>
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
        fontSize: 11,
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
        fontSize: 18,
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
        background: hover ? C.deepForest : "transparent",
        transition: "background 120ms ease, border-color 120ms ease, color 120ms ease",
      }}
    >
      ×
    </button>
  );
}

/** The pinned, always-present Sparkle self-improvement agent row. Distinct from project agents:
 *  no emoji and no close button — it reads "Improve Sparkle" + a consent pill (Always | Manual |
 *  Off) and a status-driven progress bar, and works on Sparkle itself, not the user's project.
 *  `React.memo`'d (sparkle-alrm.3) with primitive props + a stable `onSelect`, so a project agent's
 *  status flip re-renders only that agent's row, never this pinned footer row. */
const SparkleAgentRow = memo(function SparkleAgentRow({
  active,
  status,
  onSelect,
}: {
  active: boolean;
  status: AgentTabStatus;
  onSelect: () => void;
}) {
  const color = statusInk(AGENT_STATUS[status].color);
  const consent = useSettingsStore((s) => s.sparkleImprovementConsent);
  const pill = consentPillLabel(consent);
  const barState = sparkleBarState(status, consent);
  return (
    <div
      data-hint="improve"
      onClick={onSelect}
      title="Improve Sparkle — reviews your usage to propose improvements to the open-source app"
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 8,
        margin: "0 8px 6px",
        padding: "8px 10px",
        borderRadius: 8,
        cursor: "pointer",
        // Match the agent rows' selected treatment: a clean lighter lift, no accent bar.
        background: active ? CHAT_USER_BUBBLE : "transparent",
        borderTop: `1px solid ${C.forest}`,
      }}
    >
      <StatusDot status={status} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span
            style={{
              color,
              fontSize: 13,
              fontWeight: active ? FONT_WEIGHT.semibold : FONT_WEIGHT.medium,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            Improve Sparkle
          </span>
          <SparkleConsentPill label={pill} />
        </div>
        <SparkleRowProgress state={barState} />
      </div>
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
      stroke={DANGER}
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
 *  every 60s, refetches on window focus, and refreshes when a ticket is created (via
 *  TICKET_CREATED_EVENT). One open ticket → click opens its thread; many → click toggles an
 *  expanded per-ticket list directly beneath the banner. `memo`'d (no props) so unrelated sidebar
 *  re-renders don't churn it. */
const SupportTicketRow = memo(function SupportTicketRow() {
  const [tickets, setTickets] = useState<TicketStatus[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    const refetch = () => {
      listMyTickets()
        .then((t) => {
          if (alive) setTickets(t);
        })
        .catch(() => {
          // Signed-out / offline / transient — leave the last-known list; the banner just hides
          // when there are no open tickets. Not worth surfacing an error in the sidebar chrome.
        });
    };
    refetch();
    const timer = window.setInterval(refetch, 60_000);
    window.addEventListener("focus", refetch);
    window.addEventListener(TICKET_CREATED_EVENT, refetch);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refetch);
      window.removeEventListener(TICKET_CREATED_EVENT, refetch);
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
          borderRadius: expanded ? "8px 8px 0 0" : 8,
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
          <span style={{ flex: "0 0 auto", fontSize: 11, opacity: 0.85 }}>{openTickets.length}</span>
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
            borderRadius: "0 0 8px 8px",
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
                  borderTop: i === 0 ? "none" : `1px solid ${C.forest}`,
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 12.5,
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
                      fontSize: 10.5,
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
function SparkleConsentPill({ label }: { label: string }) {
  // "Off" reads as muted/inactive; Always + Manual share the brand-teal outline (active modes).
  const off = label === "Off";
  return (
    <span
      style={{
        flex: "0 0 auto",
        fontSize: 10,
        lineHeight: 1.4,
        fontWeight: FONT_WEIGHT.semibold,
        letterSpacing: 0.2,
        padding: "1px 6px",
        borderRadius: 4,
        color: off ? C.muted : C.teal,
        border: `1px solid ${off ? C.muted : C.teal}`,
        opacity: off ? 0.7 : 1,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

/**
 * The Improve Sparkle row's progress bar. Like every other row's WorkflowLine it shows PROGRESS in
 * the sparkle.ai cyan→blue logo gradient — NOT status color. Red/green/gray status (including
 * "needs you": waiting/approval/errored) is carried by the row's StatusDot, not the bar. States
 * (see sparkleBarState):
 *   - building → the cyan→blue gradient sweeps left→right (agent is actively working a cycle)
 *   - idle     → faint gray rail (not running / finished a cycle — no on-main ✓ terminal, since
 *                this agent issues PRs and the backend handles merges for most users)
 *   - off      → faint gray rail, dimmed (consent is Never)
 */
function SparkleRowProgress({ state }: { state: SparkleBarState }) {
  const TRACK = "rgba(138,160,196,0.22)";
  const barLabel = state === "off" ? "Off" : state === "building" ? "Working" : "Idle";
  return (
    <div
      role="img"
      aria-label={`Improve Sparkle: ${barLabel}`}
      style={{
        position: "relative",
        height: 3,
        borderRadius: 999,
        background: TRACK,
        overflow: "hidden",
        opacity: state === "off" ? 0.5 : 1,
      }}
    >
      {state === "building" && (
        <div
          className="sparkle-build"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            width: "40%",
            borderRadius: 999,
            // The same cyan "S" → blue "i" logo gradient the WorkflowLine rows build in.
            background: `linear-gradient(90deg, ${LINE_FROM}, ${LINE_TO})`,
          }}
        />
      )}
    </div>
  );
}
