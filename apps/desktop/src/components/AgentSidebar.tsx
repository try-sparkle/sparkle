import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
  useSyncExternalStore,
  Fragment,
} from "react";
import { C, AGENT_STATUS, FONT_WEIGHT, statusInk } from "../theme/colors";
import { FONT_UI, TYPE } from "../theme/scale";
import { SupportTicketRow } from "./SupportTicketRow";
import { subtreeDomId } from "./subtreeDomId";
import { SparkleAgentRow } from "./SparkleAgentRow";
import { ConciergeAgentsRow, researchRollupStatuses } from "./ConciergeAgentsRow";
import { liveTasks, useResearchStore } from "../services/research/store";
import { AgentRow } from "./AgentRow";
import { SidebarScrollContext, type SidebarScrollApi } from "./sidebarScrollContext";
import { WorkerPeek } from "./WorkerPeek";
import { PairCountControl, SubtreeDisclosureControl } from "./BuildColumnHeaderControls";
// Imported here AND re-exported below, never `export { … } from "…"` — see the note on the
// `formatElapsed` re-export for why the bare form would break this file's own call sites.
import {
  STAGE_CHIP_MIN_COLUMN_PX,
  stageChipShows,
  NOTICE_CLUSTER_MIN_COLUMN_PX,
  noticeClusterCollapses,
} from "./rowWidthThresholds";
import { BUILD_COLUMN_Z, SIDEBAR_OVERLAY_Z } from "./layers";
import { ColumnPullTab, publishColumnWidthVar } from "./ColumnPullTab";
import { ZOOM_COLUMN_ATTR } from "../engine/columnZoom";
import { PAIR_COLUMN_ATTR } from "../engine/pairColumns";
import { formatElapsed, useRowClock, ROLLUP_DOT_COLOR } from "./rowClock";
import { useColumnZoom, useZoomColumnForSide } from "../hooks/useZoomColumn";
import { useWindowWidth } from "../hooks/useWindowWidth";
import {
  BUILD_COLUMN_MIN_WIDTH,
  BUILD_WIDTH_EVENT,
  TERMINAL_MIN_WIDTH,
  buildColumnMax,
  buildWidthKey,
  buildWidthVar,
  readStoredBuildWidth,
} from "../engine/columnResize";
import type { Project, AgentTab, AgentTabStatus } from "../types";
import { useProjectStore } from "../stores/projectStore";
import { usePreviewStore } from "../stores/previewStore";
import { refreshPreviewCapability } from "../services/preview";
import { useRuntimeStore } from "../stores/runtimeStore";
import { SPARKLE_PANE_SIDE, useUiStore } from "../stores/uiStore";
import { APP_WINDOW_LABEL } from "../windowContext";
import { useInteractionStore } from "../stores/interactionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { removeAgentWorkspace } from "../services/worktree";
import { spinDownWorker } from "../services/workerSpawn";
import { terminateIfCloud } from "../services/cloudAgents/terminate";
import { useCloudGate } from "../hooks/useCloudAgents";
import { PromoteToCloudDialog, promoteDialogDeps } from "./PromoteToCloudDialog";
import { DemoteToLocalDialog, demoteDialogDeps } from "./DemoteToLocalDialog";
import { killPty } from "../pty";
import { landAgentBranch } from "../services/branchStatus";
import { closeDecision, selectionAfterClose } from "../engine/closeAgent";
import { retroSettled } from "../engine/retroReceiptTypes";
import { retroStanding, mayRecordRetroGap, type RetroStanding } from "../engine/retroEvidence";
// ONE implementation, shared with the concierge's retire path — see that module's header for why a
// second hand-written copy of this rule is the specific defect shape in this area.
import { feedbackEvidenceFor } from "../services/feedbackEvidenceRead";
import { canAnswerRetroPing } from "../engine/retirementReadiness";
import {
  cachedReceipt,
  loadRetroReceipts,
  recordRetroOverridden,
  retroReceiptsVersion,
  subscribeRetroReceipts,
} from "../services/retroReceipts";
import { subscribeRetirementConfirmRequests } from "../services/retirementConfirmRequest";
import { RetireAgentConfirm } from "./RetireAgentConfirm";
import { log } from "../logger";
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
import {
  topLevelAgents as topLevelOf,
  isTopLevelAgent,
  firstVisibleAgentId,
} from "../engine/agentOrdering";
import { firstLadderRowId } from "../engine/ladderSelection";
import { sideOf } from "../engine/pairs";
import {
  LIST_PAD_X,
} from "../engine/rowGeometry";
import type { PairSide } from "../engine/rowGeometry";
// The shared row anatomy every row type in this column must honour — see that file's header.
import { useCableStore } from "../stores/cableStore";
import { usePaneFocusStore } from "../stores/paneFocusStore";
import { usePairIsLive } from "../hooks/useEffectiveWired";
import { publishedStatusFor, rollupViewFor } from "../useAttentionNotifications";
import {
  bandOfStatus,
  flattenSections,
  groupAgentsByStage,
  sectionOfRow,
  type BuildSectionId,
  type StatusBand,
} from "../engine/buildSections";
import {
  bandOfRollup,
  rollupDot,
  rollupLabel,
} from "../engine/workerRollup";
import { StageSectionHeader } from "./StageSectionHeader";
import { ChatSection } from "./ChatSection";
import { StatusFilterBar } from "./StatusFilterBar";
import {
  withUnstartedWorkerAttention,
  withRedWorkerAttention,
} from "../engine/workerAttention";
import { attentionWorkersOf } from "../engine/workerExpansion";
import { withDismissedAlerts, alertControlKind } from "../engine/alertDismissal";
import { withUnmergedWork } from "../engine/unmergedAttention";
import { withNudgeLoopCalm } from "../engine/nudgeLoopCalm";
import { withFinishedHeadCalm } from "../engine/finishedHeadCalm";
import { thrashReportFor } from "../engine/agentThrash";
import { withDismissedStallAttention, withStallAttention } from "../engine/stallEscalation";
import { processAliveFor } from "../services/goalContinuationRunner";
// The never-idle overlay: three pure cores, read ALONGSIDE `status` (never folded into it — see the
// architecture note at the top of engine/agentStall.ts). ./rowAttention does the evidence-gathering
// and the wording; nothing here re-decides a verdict.
import { stallReport } from "../engine/agentStall";
import { quotaBlockForAgent } from "../engine/engineRegistry";
import {
  stallInputsFor,
} from "./rowAttention";
// ONE producer for what an agent is complaining about, shared with the composer's pill row so the
// two surfaces cannot drift — the taxonomy drift engine/workerRollup.ts warns about twice.
import { splitStatusPollTargets } from "../engine/statusPollTargets";
import { useNewAgentCalm, useNewAgentGraceTick } from "../hooks/useNewAgentCalm";

/** Stable empty list, so the hook below is not handed a fresh `[]` on every render before a project
 *  resolves — a new array identity each time would re-arm its grace timer forever. */
const NO_AGENTS: readonly AgentTab[] = [];
import { reconcileWorkMode, type WorkMode } from "../engine/workMode";
import { PlanBuildToggle } from "./PlanBuildToggle";
import {
  resolveStage,
  rollupHoldsWork,
  rollupStages,
  stageIndex,
  uncommittedWorkEvidence,
} from "../engine/workflowStage";
import type { WorkflowStageId } from "../engine/workflowStage";
import { useSpawnBuildAgent } from "../hooks/useSpawnBuildAgent";
import { NewAgentButtons } from "./NewAgentButtons";
import { CloseAgentPrompt } from "./CloseAgentPrompt";

/**
 * Left column: the current project's agents as a vertical list (spec layout, revised).
 * Each row is a status dot + the agent name rendered in that status's color; × to close,
 * "+ Agent" adds one.
 *
 * THE ROW'S GESTURES, as the founder settled them (*"double click mounts. right click to
 * rename."*) — this block described the retired set until roborev 63223, which is worth a line of
 * its own: it is the top-of-file description the next reader trusts, and it contradicted the
 * governing comments in `AgentRow.tsx` / `FittedAgentName.tsx`.
 *
 *   single click            select the agent and hand its terminal the caret — no cable. AND, on a
 *                           row that was ALREADY selected and has workers, fold/unfold its subtree
 *                           — which PERSISTS. That is not a footnote: the first version of this
 *                           list said "no cable" and stopped, which reads as "selection only, no
 *                           side effects" (roborev 63321). The fold is also why the click is
 *                           DEFERRED by `FOLD_DOUBLE_PRESS_GRACE_MS` — it may turn out to be half
 *                           of a mount, and one gesture must not mean two things.
 *   double click            mount the concierge onto it (see `ROW_CONTROL_SELECTOR` for the
 *                           controls this deliberately does not fire on)
 *   Enter / Space           also mount — the row is the disclosure control, so it is operable from
 *                           the keyboard; a synthetic `detail: 0` click takes the same path. Any
 *                           change to the mount rule has to hold for these, not only for the mouse.
 *   right click ON THE NAME open the rename editor
 *   right click ELSEWHERE   open the detail card
 *
 * Read `AgentRow.tsx` for the authority on each; this is the index, and it is exhaustive as of
 * roborev 63321 — if you add a gesture, it belongs here too.
 */
// `--hd-h` from rev4.html: the height of every column header band in the cockpit — the concierge's
// `.ahd` and this column's `.bhd`. One number so the two line up across the seam; a header that is
// two pixels off its neighbour is the kind of thing that reads as "not the design" without anyone
// being able to name it.
const BUILD_HEADER_H = 34;


// Wrapper shared by BOTH placements of the "+ New … Agent" button (sticky top / below the last
// row). A flex column so the button's margins can't collapse out of it — which keeps the button's
// flow-height contribution IDENTICAL in the two slots (block margins would collapse differently at
// the bottom of the list), so the overflow measurement is placement-independent and the placement
// can't oscillate or develop a hysteresis band at the boundary.
const NEW_AGENT_SLOT_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  // Separates the two create rows ("+ Local Agent" / "+ Cloud Agent") from each other, and the
  // cloud row from its block-reason line when one is shown.
  gap: 6,
};

export function AgentSidebar({
  project,
  slotSide = "right",
  forcePairSide,
  showSparkleRow = true,
  showConciergeRow = true,
  covered = false,
}: {
  project: Project | null;
  /** WHICH STAGE MOUNTED THIS COLUMN — used ONLY when `project` is null.
   *
   *  The side normally comes from the project's own assignment, and deliberately so: the map is the
   *  single answer to "where does this project live", and a prop is a second copy that can disagree
   *  with the stage the panes mount in. But the left stage renders `project={null}` whenever its tab
   *  is closed, and there is no early return — so with no project to ask, `sideOf(assignment, "")`
   *  answered "right" and the EMPTY LEFT column seeded from, and on a drag wrote over, the right
   *  column's width. Exactly the cross-column clobber the per-side key removed, one case further out
   *  (roborev 55490). The slot knows its own side; this is the only thing it is asked. */
  slotSide?: PairSide;
  /** Override the derived pair side outright. ONLY a satellite passes this, and it must: a
   *  satellite is a single column, but this component otherwise derives its side from the project's
   *  PERSISTED pair assignment — so a project the user had assigned to the left pair resolves
   *  "left" inside a satellite whose only board reads "right". Every per-side write this column
   *  makes (the mode, the FEEDBACK filter) then lands on a side nothing in that window renders, and
   *  the control does nothing at all. The main window must NOT pass this: there the assignment map
   *  is the correct answer, and it is what keeps a project moving between pairs consistent. */
  forcePairSide?: PairSide;
  /** Hide the pinned Improve-Sparkle row. Only a SATELLITE window passes false, and it must: the
   *  Sparkle agent's id is keyed to the window label (`sparkleAgentIdFor`), and a satellite would
   *  therefore offer to reveal MAIN's copy — a second pane on one PTY, which is the one thing the
   *  tear-off ownership split exists to prevent. Defaults to true so the main window is untouched. */
  showSparkleRow?: boolean;
  /**
   * Whether THIS sidebar renders the pinned "Concierge Agents" row.
   *
   * Its own flag rather than a reuse of `showSparkleRow`, which was the first attempt: those two
   * rows are suppressed for the same STRUCTURAL reason (this component mounts twice when two pairs
   * are open — bead `sparkle-x0pvw`) but they are not the same decision, and the existing tests set
   * `showSparkleRow={false}` precisely to silence the Sparkle row while still exercising this one.
   * Conflating them made those tests render no row at all.
   */
  showConciergeRow?: boolean;
  /** IS SOMETHING OPAQUE PAINTED OVER THIS WHOLE COLUMN? True while the pair's Plan board is up,
   *  which covers both columns (Workspace.PlanBoardSlot).
   *
   *  A column that cannot be SEEN must also not be reachable, and covering it does not achieve that
   *  by itself. The board renders its own Plan/Build toggle — it has to, since it takes this one
   *  off screen — and with this column still fully live there were two of every control underneath:
   *  Tab still walked the hidden agent rows and a second mode toggle, AT announced two identical
   *  toggles, and the ⌃-hint overlay drew a second "b"/"p" chiclet FLOATING OVER THE BOARD whose
   *  key fired the hidden button (first-in-DOM wins, and this column precedes the board).
   *
   *  TWO MECHANISMS, AND BOTH ARE LOAD-BEARING — `visibility: hidden` ALONE IS NOT INERT.
   *
   *  `visibility: hidden` is the treatment `paneVisibilityStyle` already uses for a covered pane,
   *  and it is here for one property the alternatives lack: it keeps the LAYOUT BOX. This column's
   *  measured width is what the seam and the CSS clamp both read, so `display: none` would zero it
   *  and lose the user's width outright.
   *
   *  But `visibility` is INHERITED, which means a descendant can take it back — and two here do.
   *  `StatusFilterBar`'s Reset link is `visibility: filtered ? "visible" : "hidden"`, so with any
   *  status chip active it computes VISIBLE under the board: a tab stop behind an opaque surface,
   *  and Enter clears a filter the user cannot see (`pointer-events` never enters it — keyboard
   *  activation does not hit-test). Every agent row's strip content does the same. So `inert` is
   *  the one that actually makes the subtree unreachable: it is NOT overridable from inside, and
   *  it covers focus, activation and the a11y tree together. (roborev 57298) */
  covered?: boolean;
}) {
  const selectAgent = useProjectStore((s) => s.selectAgent);
  const removeAgent = useProjectStore((s) => s.removeAgent);
  const open = useRuntimeStore((s) => s.open);
  const close = useRuntimeStore((s) => s.close);
  const liveStatus = useRuntimeStore((s) => s.status);
  const openAgentIds = useRuntimeStore((s) => s.openAgentIds);
  const lastObserved = useRuntimeStore((s) => s.lastObserved);
  // The open set, built once: the strand overlay below and the peek both
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
  const branchStatus = useRuntimeStore((s) => s.branchStatus);
  const workflowStage = useRuntimeStore((s) => s.workflowStage);
  // The PR-probe map, needed by the stall inputs at the SIDEBAR level (the row reads its own slice).
  const workflowState = useRuntimeStore((s) => s.workflowState);
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
  //   (1b) withStallAttention — GRAY IS A TERMINAL STATE (the founder's rule, 2026-07-29): a row that
  //       is resting but still owes work — an unmet goal, uncommitted changes, an open PR, unlanded
  //       commits — leaves the calm tier for red `blocked`. It runs AFTER (1) so a
  //       committed-but-unlanded row is already wearing `unmerged` and is visible to it, and BEFORE
  //       (2) — but it honours the dismissal record itself, so an acknowledged row is skipped and
  //       stays in its OWN band instead of being de-escalated to `idle` by (2), which would erase the
  //       "Needs merge" label and the evidence that the branch exists. See engine/stallEscalation.
  const calmStatus = useMemo(
    () =>
      project
        ? withUnmergedWork(project.agents, status, (id) =>
            resolveStage(branchStatus[id], workflowStage[id]),
          )
        : status,
    [project, status, branchStatus, workflowStage],
  );
  // The stall question is asked about `calmStatus` — the PRE-escalation map — for the reason spelled
  // out on AgentRowProps.calmSt: `stallReport` answers `active` for the red tier, so feeding it the
  // escalated map would collapse every report to "nothing outstanding" and the escalation would erase
  // its own justification.
  //
  // AND IT IS ASKED ONCE PER AGENT, WHICH IS WHY THE LOOKUP IS INDEXED (sparkle perf, 2026-08-08).
  // `withStallAttention` walks every agent and hands the callback below an `id`; the callback needs
  // that agent's `goal`, and it used to get it with `project.agents.find((x) => x.id === id)` — a
  // linear scan nested inside a linear walk, i.e. O(agents²) element visits *per memo evaluation*.
  // This memo's deps include `branchStatus`, `workflowState` and `workflowStage`, every one of which
  // is rewritten by ANY agent's probe, so on a 60-agent fleet it re-ran constantly and each run cost
  // ~1,830 comparisons (Σ i for i≤60 — `find` stops at the match) to answer 60 questions. Indexed by
  // id it is 60 map lookups. Hoisted into its OWN memo keyed on the agents array rather than rebuilt
  // inside the one below, because the agents array changes far less often than the probe maps do.
  //
  // ⚠️ THIS DOES NOT MAKE THE MEMO LINEAR, and the difference matters to whoever profiles it next
  // (roborev 60536). `withStallAttention` also asks `engine/inMotion.isInMotion` once per
  // escalatable agent, and that runs its own full `agents.some(...)` scan for any agent not itself
  // `working` — i.e. for the entire escalatable set. At 60 agents that is ~3,600 element visits,
  // LARGER than the term removed here. Closing it means handing `withStallAttention` a precomputed
  // parent → working-worker index instead of the raw array, which is a change to `engine/inMotion`
  // and `engine/stallEscalation`, not to this file. Tracked as bead sparkle-z5gq8.
  //
  // Nor is that the largest survivor. Measured at 60 agents, the render path's scans over the
  // agents array are ~360 element visits from `find` (this fix), ~3,600 from `some`
  // (sparkle-z5gq8), and ~4,080 from the per-id `agents.filter((a) => a.parentId === id)`
  // callbacks (sparkle-k3wab). So this removed 1,830 visits from a path that still does ~8,000.
  // `AgentSidebar.escalationCost.test` counts all three separately and ASSERTS the two unfixed
  // ones are still present, so neither can go quietly dead and neither can be fixed without
  // forcing this comment to be corrected.
  const agentsById = useMemo(() => {
    const index = new Map<string, AgentTab>();
    for (const a of project?.agents ?? NO_AGENTS) index.set(a.id, a);
    return index;
  }, [project?.agents]);
  // THE STALL READING, HOISTED (bead sparkle-hpbkw). It used to be an anonymous callback inside the
  // escalation memo below, which meant the only consumer of the verdict was that memo. `engine/
  // finishedHeadCalm` needs the SAME verdict — a head is only calmed where the app has positively
  // read it as `finished` — and the Build column's rollup needs it too, so it is named here and
  // passed to all three. Re-deriving it in two places is how this subsystem has drifted before.
  const stallReportOf = useCallback(
    (id: string) => {
      const agent = agentsById.get(id);
      if (agent === undefined) return undefined;
      return stallReport(
        stallInputsFor(
          calmStatus[id] ?? "stopped",
          Date.now(),
          agent.goal,
          { bs: branchStatus[id], ws: workflowState[id], stageOverride: workflowStage[id] },
          quotaBlockForAgent(id, Date.now()),
        ),
      );
    },
    [agentsById, calmStatus, branchStatus, workflowState, workflowStage],
  );
  /** Positively read as FINISHED, or `undefined` when the git state was never read. `undefined` is a
   *  real answer and it demotes nothing — see engine/finishedHeadCalm. */
  const isFinishedOf = useCallback(
    (id: string) => {
      const r = stallReportOf(id);
      return r === undefined ? undefined : r.verdict === "finished";
    },
    [stallReportOf],
  );
  const escalatedStatus = useMemo(() => {
    if (!project) return status;
    const escalated = withStallAttention(
      project.agents,
      calmStatus,
      (id) => {
        const agent = agentsById.get(id);
        if (agent === undefined) return undefined;
        return stallReport(
          stallInputsFor(
            calmStatus[id] ?? "stopped",
            Date.now(),
            agent.goal,
            {
              bs: branchStatus[id],
              ws: workflowState[id],
              stageOverride: workflowStage[id],
            },
            // The account-limit wall. Without it this surface — the one the founder actually watches —
            // computes its own reading that can never see a quota block, so the row goes red with no
            // reason attached and the "Rate limited" chip is unreachable.
            quotaBlockForAgent(id, Date.now()),
          ),
        );
      },
      (id) => processAliveFor(id, status, openIds),
    );
    return escalated;
  }, [project, agentsById, calmStatus, status, branchStatus, workflowStage, workflowState, openIds]);
  // The map the ROW PRESENTS: acknowledged escalations handed back to the band they came from.
  //
  // TWO MAPS, AND WHICH ONE EACH CONSUMER GETS IS THE WHOLE FIX (roborev 55423/55434). The episode
  // recorder and the Dismiss/Re-enable control must see the PRE-undo map (`escalatedStatus`), because
  // the counter only advances from what it is shown: fed the post-undo map it saw `unmerged` after a
  // dismissal, never bumped `seq` past `dismissedSeq`, and the suppression became a permanent ratchet
  // that no future stall could lift — while `trueSt` read `unmerged` too, so the Re-enable control
  // vanished and the human could not even undo it. Only the row's COLOUR reads this one.
  const presentedStatus = useMemo(
    () =>
      project
        ? withDismissedStallAttention(project.agents, escalatedStatus, calmStatus)
        : escalatedStatus,
    [project, escalatedStatus, calmStatus],
  );
  const effectiveStatus = useMemo(
    () =>
      project
        ? // LAST IN THE CHAIN: a row Sparkle has been pinging into silence stops asking (bead
          // sparkle-hpbkw). This map is what the row COLOUR and the band FILTER read, so a nudge
          // loop that was only calmed inside `composeRollup` would still be counted by the needs-you
          // chip here — the surface the founder was actually reading when he asked why two agents
          // that needed nothing were red.
          //
          // `Date.now()` needs no tick of its own: the `nudge-loop` verdict is a pure counter over
          // the hook stream and does not decay with time, unlike the quota and compaction windows.
          // It is passed only because `thrashReportFor` requires a clock for its other verdicts.
          withFinishedHeadCalm(
            project.agents,
            withNudgeLoopCalm(
              project.agents,
              withDismissedAlerts(project.agents, presentedStatus),
              (id) => thrashReportFor(id, Date.now(), {}),
            ),
            // `calmStatus` is the pre-bubble map — the row's OWN status. Handing this the bubbled or
            // presented map would make an inherited red read as the head's own and the rule a no-op.
            calmStatus,
            isFinishedOf,
          )
        : status,
    [project, presentedStatus, status, calmStatus, isFinishedOf],
  );
  // Advance each agent's alert-episode record on every change to the overlaid (pre-dismissal) status
  // — the input the "Dismiss Alert" feature reads. Declared HERE, below `escalatedStatus`, because a
  // hook's dependency array is evaluated during render: referencing it from higher up the body would
  // read a `const` in its temporal dead zone and throw.
  //
  // Fed the ESCALATED map, not the raw one. Every dismissal entry point takes a status, and handed
  // the pre-escalation map they would see `idle`/`unmerged`, record no `blocked` episode, and render
  // no Dismiss control — a red the human cannot acknowledge, which is exactly what forced the
  // 2026-07-26 rollback of the last red `unmerged` (roborev 55318).
  //
  // Runs AFTER the worker-attention overlays so a worker's bubbled red counts as the orchestrator's
  // episode too: a dismissed orchestrator re-alerts when the bubbled red *signature changes kind*
  // (e.g. a worker goes waiting→errored). Note the limit — episodes key on the red kind, not worker
  // identity — so a DIFFERENT worker later going red with the SAME kind leaves the bubbled signature
  // unchanged and does not re-alert; acceptable, since the orchestrator-level signal ("a worker needs
  // you, <kind>") hasn't changed. That limit now bites `blocked` hardest, since the stall escalation
  // makes it the most-recurring red. advanceAlerts writes only on a real red-tier transition, so this
  // is not a per-tick persist. No-ops before a project.
  useEffect(() => {
    if (project) advanceAlerts(project.id, escalatedStatus);
  }, [project?.id, escalatedStatus, advanceAlerts]);
  // CONCIERGE BANDING NOTE (roborev 46341-M3): `effectiveStatus` above IS the published map.
  // `status` already carries both worker overlays (withUnstartedWorkerAttention +
  // withRedWorkerAttention, see its memo), and effectiveStatus adds withUnmergedWork +
  // withDismissedAlerts — the exact composition publishedStatusFor performs. Re-running
  // publishedStatusFor here was a value-identical second computation of the whole map per render,
  // so the calm band reads effectiveStatus directly.
  const pollBranchStatus = useRuntimeStore((s) => s.pollBranchStatus);
  const activeSpecial = useUiStore((s) => s.activeSpecial);
  const setActiveSpecial = useUiStore((s) => s.setActiveSpecial);
  // WHICH PAIR THIS SIDEBAR IS IN — derived from the project it is rendering, not passed as a prop.
  // The assignment map is already the single answer to "where does this project live" (engine/pairs),
  // and a prop would be a second copy of it that could disagree with the stage its panes mount in.
  const pairAssignment = useUiStore((s) => s.pairAssignment);
  // With no project there is nothing to ask the map, and `sideOf("")` answers "right" — so the empty
  // left column has to fall back to the side of the SLOT it was mounted in. See `slotSide`.
  // `forcePairSide` first: a satellite is one column and the persisted assignment map is simply not
  // about that window. Otherwise the map is the single answer to "where does this project live",
  // falling back to the slot's own side when there is no project to ask (see slotSide).
  const pairSide = forcePairSide ?? (project ? sideOf(pairAssignment, project.id) : slotSide);
  // IS THE IMPROVE-SPARKLE PANE COVERING **THIS** COLUMN'S STAGE? Asked once, here, because every
  // consumer below needs the same answer and the raw `activeSpecial` cannot give it: the flag is
  // window-global but the pane mounts in exactly ONE pair's stage (Workspace renders
  // `SparkleAgentPane` only in the primary pair, and its left-hand pane id has no `sparkleActive`
  // term at all). So in the LEFT column the bare global is a lie in both directions — it claims a
  // pane that is not there while that column's own build terminal is still on screen.
  //
  // Reading it unscoped is what made the left sidebar paint "Improve Sparkle is the active row and
  // no build row is selected" over a live build terminal, and then made the Build chevron disagree
  // with that painting: `alreadyHere` came out true, so a press meant as "get me back from Sparkle"
  // spawned a brand-new build agent — worktree and PTY — and another on every further press. Same
  // class of split as the singleton this file's per-column work removed, one layer further down: a
  // scoped write beside an unscoped read.
  const paneCoversMe = pairSide === SPARKLE_PANE_SIDE && activeSpecial !== null;
  const patchCable = useCableStore((s) => s.patch);
  // "Put the caret in that agent's terminal" — the other half of what a single click now does. The
  // pane owns the terminal handle, so this is a request it consumes (stores/paneFocusStore).
  const requestPaneFocus = usePaneFocusStore((s) => s.request);
  // DOES THIS PAIR HOLD THE CABLE? Read from the one enum, never mirrored into local state — the
  // rows use it to open their concierge end (engine/rowGeometry), which is the second half of the
  // circuit the flood and the vanishing seam are the rest of. `pairIsLive` rather than a `===` so
  // "one live circuit" is stated in exactly one place (engine/cable).
  // The PROJECTED side, not the raw store: a joint drawn open onto a pair with nothing selected
  // is the same lie the flood was (roborev 55386). Visual treatment takes the projection.
  // The cable is still selected as a BOOLEAN inside the hook, so this column re-renders when its own
  // circuit opens or closes and not on every unrelated cable move (patching the other side, floating
  // an overlay). That narrowing lived HERE until the projection moved the read into `usePairIsLive`;
  // written the short way (`useEffectiveWired() === pair`) it took the enum and dropped the narrowing
  // while this sentence still promised it (roborev 55490).
  const jointOpen = usePairIsLive(pairSide);
  // The Improve-Sparkle agent is keyed by window label (sparkleAgentIdFor — see onSelectSparkle /
  // services/sparkleReveal). There is exactly one app window now, and its label is the constant
  // APP_WINDOW_LABEL; the id is spelled through it rather than the literal so the persistence key
  // that existing users already have on disk can't drift.
  const sparkleAgentId = sparkleAgentIdFor(APP_WINDOW_LABEL);

  // Which chevron is selected. Drives both the strip's coloring (active = brand, others grayscale)
  // and which agents the sidebar list shows. Defaults to Build; not persisted across launches.
  // Lifted into uiStore so other components — e.g. ThinkPanel's "Make a Plan" button — can switch
  // tabs.
  //
  // SCOPED TO **THIS COLUMN'S** PAIR, and that is the bug fix, not a refinement. Both sidebars read
  // one global `workMode`, so the two chevrons were the same control wearing two coats of paint:
  // pressing Plan on the left lit the right column's chevron too and opened the right column's
  // board. `pairSide` above is already the honest answer to "which column am I" — reading and
  // writing the mode through it is what makes the chevron actually belong to the column it is
  // drawn in. Same shape as the mount cable, where only the paint knew which side it was on.
  const mode = useUiStore((s) => s.workModeBySide[pairSide]);
  const setWorkMode = useUiStore((s) => s.setWorkMode);
  const openPlanBoard = useUiStore((s) => s.openPlanBoard);
  const showBuildStage = useUiStore((s) => s.showBuildStage);
  const openPreview = useUiStore((s) => s.openPreview);
  // MAY THIS PROJECT BE PREVIEWED AT ALL? Narrowed to a boolean through the selector so a
  // capability write for the OTHER project cannot re-render this column. `undefined` (not probed
  // yet) reads as false, which is the honest answer — see the probe effect below.
  const previewable = usePreviewStore((s) => s.capability[project?.id ?? ""]?.previewable === true);
  const setMode = useCallback((m: WorkMode) => setWorkMode(pairSide, m), [setWorkMode, pairSide]);
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
        // EVERY non-shell agent gets asked about, split into two batches by whether anyone is
        // looking at it. `probed` (open agents + the orchestrator parent of each open worker) keeps
        // the PR probe; `local` — every CLOSED row — gets pure local git.
        //
        // The closed batch is not an optimization, it is the bug fix: a closed pane used to mean
        // NOTHING ever ran git for that agent, so a branch holding eleven unpushed commits read as an
        // empty agent. See engine/statusPollTargets for the full account.
        const { probed, local } = splitStatusPollTargets(proj.agents, openAgentIds);
        // The naming tiers below still work off the PROBED set, which is what `all` has always
        // meant to them: they have their own closed-agent backfill a few lines down.
        const all = probed;
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
        const toInput = (a: (typeof proj.agents)[number]) => ({
          id: a.id,
          kind: a.kind,
          baseBranch: a.baseBranch ?? "",
          parentBranch: a.kind === "worker" && a.parentId ? `sparkle/agent-${a.parentId}` : "",
          beadId: a.beadId,
          name: a.name,
          parentId: a.parentId,
          force: status[a.id] === "working",
        });
        await pollProjectStatus(proj.rootPath, proj.id, all.map(toInput), true);
        // The CLOSED rows, with the PR probe OFF. `probePrState: false` is what keeps this cheap:
        // Rust skips the origin fetch and the per-agent `gh` call entirely, so this batch is local
        // ref reads — and after the first tick, fingerprint-unchanged agents are skipped outright.
        // ahead/dirty is all `hasUnmergedCommittedWork` needs to stop a branch full of commits from
        // reading as an empty agent; PR state can wait until someone opens the pane.
        //
        // Awaited AFTER the probed batch rather than in parallel, so the rows someone is actually
        // looking at are never queued behind a sweep of the whole fleet.
        if (local.length > 0) {
          await pollProjectStatus(proj.rootPath, proj.id, local.map(toInput), false);
        }
        // THE RETIREMENT RECEIPTS (bead sparkle-0l9xk). One Rust call for the whole project, on the
        // same tick as the chevrons — `retirementPill` reads the cache SYNCHRONOUSLY during render
        // and cannot await, exactly like branch status above.
        //
        // Without this line the cache is never populated and `cachedReceipt` returns `undefined`
        // forever, which the fail-closed rule reads as "has not reported": every landed agent would
        // wear RETRO PENDING permanently, including the ones that filed properly. A gate that says
        // no to everyone is not a gate, it is an outage — and it would look exactly like working
        // code, because the pill renders and the dialog opens.
        await loadRetroReceipts(proj.id);
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
  /** Is the pointer (or focus) anywhere in the column header? Reveals `PairCountControl`, which
   *  cannot reveal itself — a hidden box takes neither hover nor Tab. */
  const [headerHover, setHeaderHover] = useState(false);
  // Which agent the Ship/Save/Discard close prompt is asking about (null = no prompt).
  const [closePromptId, setClosePromptId] = useState<string | null>(null);
  // The RETIREMENT confirm (bead sparkle-0l9xk) — a landed build agent the human is removing.
  // Separate state from `closePromptId` on purpose: the two dialogs answer different questions
  // ("what about the work?" vs "are you done with this row?"), and sharing one id would make an
  // Escape out of one able to leave the other half-open.
  const [retireConfirmId, setRetireConfirmId] = useState<string | null>(null);
  // What the chosen close outcome ACTUALLY did, when that differs from what the button promised
  // (roborev 54225). Rendered as a ModalShell card — the same dialog chrome CloseAgentPrompt uses,
  // stepped into the slot it just vacated, rather than a new notification channel. `null` on the
  // clean paths: a PR that opened and a branch that reached the remote need no announcement.
  const [closeNotice, setCloseNotice] = useState<{ title: string; body: string } | null>(null);

  // Draggable column width — persisted to localStorage so it survives relaunch. Clamped to
  // a sane range so the column can't be dragged to nothing or take over the window.
  //
  // 480 WAS THE WALL THE FOUNDER HIT ("blocked as to max width I can make the builder columns"), and
  // it was a bare constant, not a negotiation failure: the terminal beside this column is `flex: 1`
  // against effectively no min-content (its panes are `position: absolute`), so it already yields
  // space freely — nothing was refusing to give, the clamp simply stopped asking. 480 also predates
  // the five-column cockpit, where this column is one of TWO builders and a laptop-width window can
  // comfortably spare more than that for the one the user is reading.
  //
  // 1200 rather than "unbounded": a bound still has to exist so the column cannot be dragged over the
  // concierge and the terminal entirely, which is unrecoverable without editing localStorage. This is
  // "to taste" for any real window while keeping that floor of sanity.
  //
  // AND CLAMPED AGAINST THE LIVE WINDOW, because 1200 alone re-opened the very lockout the paragraph
  // above claims to prevent (roborev 55847). This column's pull tab is absolutely positioned at its
  // pair-side edge, so on a 900–1100px window — `tauri.conf.json` allows 900 — a column dragged to
  // 1200 puts its resize tab AND its overlay chevron past the viewport edge, with `overflow: hidden`
  // and nothing to reflow them back. The width persists, so the only ways out were widening the window
  // or editing localStorage. The reserve is the concierge at its minimum plus a terminal worth
  // showing; the restore path below reads this same value, so a width saved on a large display is
  // rejected rather than restored onto a small one.
  //
  // THE CEILING AND THE RESTORE RULE MOVED TO `engine/columnResize`, unchanged in value. `Workspace`
  // has to know how wide these columns are to bound the CONCIERGE against them, and a ceiling spelled
  // once in each file is precisely the drift that module exists to prevent — the row would reserve
  // for a column whose real limit had moved.
  const MIN_WIDTH = BUILD_COLUMN_MIN_WIDTH;
  const windowWidth = useWindowWidth();
  const MAX_WIDTH = buildColumnMax(windowWidth);
  // TWO BOUNDS WITH DIFFERENT JOBS, because one of them cannot do the other's (roborev 55869).
  //
  // `MAX_WIDTH` above bounds the GESTURE — where the drag and the arrow keys stop. `RENDERED_WIDTH`
  // below bounds the PAINT, in CSS, against this column's own live container. The JS bound alone was
  // not enough, twice over: (1) it is recomputed as the window changes but the stored `width` was
  // never reconciled against it, so a column set to 1200 on a large display kept rendering at 1200
  // after the window shrank — handle off the viewport, `overflow: hidden`, no way back; and (2) its
  // reserve describes a ONE-pair cockpit, while this component mounts twice once the left pair opens,
  // so with two pairs the permitted maximum exceeded the space the pair actually had.
  //
  // A CSS `min()` against `100%` fixes both without a resize listener, a reconciling effect, or a
  // measurement: the percentage resolves against `.paircols` — this column's real container, which is
  // the PAIR and therefore already accounts for the sibling pair — and the browser re-evaluates it at
  // layout, so a window resize brings the rendered width down on its own. The stored preference is
  // left intact, so re-docking to a large display restores the width the user chose rather than
  // discarding it. This is the same idiom `OVERLAY_WIDTH` above already uses, and for the same reason.
  // KEYED PER SIDE. `Workspace` mounts this component TWICE once the left pair is open (plus once
  // more in the satellite window) and each instance owns its own `width` state, so a single shared
  // key made the two race: whichever flushed last overwrote the other's value, and the plainest form
  // needed no clamp at all — resize left, resize right, quit, and the last-mounted instance wins
  // with its own stale number. A key per side removes the race rather than narrowing it, so a flush
  // can never speak for the other column (roborev 55391).
  const widthKey = buildWidthKey(pairSide);
  // The restore — including the read-through of the pre-split key, so a user's existing width
  // survives — is `readStoredBuildWidth`. It USED to be shared with the row that reserved space for
  // this column; that reserve is the shared 50px floors now, so this is the function's only caller.
  const [width, setWidth] = useState<number>(() => readStoredBuildWidth(pairSide, windowWidth));

  /** Commit a width the pull tab has ALREADY clamped and logged.
   *
   *  This used to be three things — an inline `Math.min/Math.max`, its own `log.info`, and an
   *  `onKeyDown` implementing arrows/Home/End — because this column owned a bespoke resize strip.
   *  `ColumnPullTab` owns the whole gesture now: it clamps through `engine/columnResize`, emits the
   *  `requested → applied, clamped by …` line for BOTH the drag and the arrow keys, and guards the
   *  auto-repeat case.
   *
   *  MEMOIZED, AND NOT PERSISTED PER PIXEL — both halves are on the drag's hot path, and both were
   *  wrong here for one commit in exactly the way `Workspace` documents for the concierge seam.
   *  `ColumnPullTab.commit` calls `onWidth` on EVERY mousemove, so a plain function meant a
   *  synchronous disk-backed `localStorage.setItem` per pointer event where the deleted strip did
   *  one per drag; and a fresh closure each render changed `commit`'s identity, which tears down and
   *  re-adds the live drag's window listeners mid-gesture. The write is debounced on a trailing
   *  timer and flushed on teardown, so a drag writes once and the keyboard path — which has no
   *  settle event of its own — is covered by the same timer. */
  const commitWidth = useCallback((next: number) => {
    // DIRTY ONLY ON AN ACTUAL CHANGE. `ColumnPullTab.commit` calls `onWidth(applied)`
    // unconditionally, so an arrow press or a drag pinned at a bound used to mark this instance dirty
    // while the width never moved — enough to make its flush speak for a column the user never
    // touched (roborev 55391).
    if (next === widthRef.current) return;
    widthDirty.current = true;
    setWidth(next);
  }, []);
  const widthRef = useRef(width);
  widthRef.current = width;
  // ONLY AN INSTANCE THAT ACTUALLY RESIZED MAY PERSIST. `widthKey` above already stops the two
  // COLUMNS overwriting each other; this closes the remaining case, which is two instances of the
  // SAME side — the satellite window mounts one too, and each seeds its own `width` at mount with
  // nothing reconciling them afterwards.
  //
  // So an unconditional flush lets an instance that never moved overwrite the width the user did
  // set: resize the right column in the main window to 400, and the satellite's untouched 220 is
  // what the next launch comes back at. Worse on shutdown, where nothing unmounts at all: every
  // instance registers the same three teardown listeners, so the last one mounted wins regardless of
  // which one the user actually touched.
  //
  // Before the debounce landed, the write only happened on an explicit commit, so a non-resized
  // column could not write. This restores that property without giving up the debounce. (It also
  // stops the effect below firing a write on mount.)
  const widthDirty = useRef(false);
  useEffect(() => {
    if (!widthDirty.current) return;
    const id = setTimeout(() => localStorage.setItem(widthKey, String(width)), 200);
    return () => clearTimeout(id);
  }, [width, widthKey]);

  // Derived here rather than beside the constants because it reads `width` state — see the two-bounds
  // note above for why the paint gets its own bound.
  // WITH A FLOOR, which the first version dropped — and `OVERLAY_WIDTH` above, the idiom this copies,
  // has always carried one (`max(280px, min(480px, 100%))`). Without it the expression goes NEGATIVE on
  // a narrow container and the used width resolves to 0: at defaults on a 1280px window with a left
  // pair open the right pair holds 268px, so `min(220px, calc(268px - 320px))` painted the build column
  // away entirely (roborev 55883). It also handed the terminal the only hard minimum in the row, which
  // inverts engine/columnResize's documented collapse order — terminal collapses to a strip FIRST, then
  // build. `max(MIN_WIDTH, …)` restores both: the column never paints below its own minimum, and the
  // terminal goes on absorbing the shortfall the way that file says it must.
  // THE VARIABLE IS THE INNER TERM, and the clamps around it are unchanged. During a drag the pull
  // tab writes `--build-l-w`/`--build-r-w` on the root element at pointer rate and the browser
  // re-lays-out this column with no React work at all; on release React writes the same property with
  // the committed value. The floor and the terminal reserve still apply to whatever the variable says,
  // so a drag cannot paint this column below its minimum or over the terminal's — the live gesture is
  // bounded by exactly the same expression the resting layout is.
  // ONE value for both the level and the DOM marker, and routed through `ZoomColumnOverride`.
  const zoomColumn = useZoomColumnForSide("build", pairSide);
  const columnZoom = useColumnZoom(zoomColumn);
  // MAIN'S WIDTH RULE, UNCHANGED, DIVIDED BY THIS COLUMN'S ZOOM. The clamp itself is left exactly as
  // it is — floor, stored variable, container ceiling — because that is the landed width design and
  // this change has no business moving it. The division is only about keeping the two features
  // independent: CSS `zoom: Z` scales this element's used width by Z, so a column stored at 300
  // would PAINT at 360 when zoomed to 1.2, silently changing the user's width preference every time
  // they changed the text size and leaving the seam starting its drag from a number that is not on
  // screen. Dividing cancels that exactly — the box keeps its dragged width, only the CONTENTS scale.
  const RENDERED_WIDTH = `calc(max(${MIN_WIDTH}px, min(var(${buildWidthVar(pairSide)}, ${width}px), calc(100% - ${TERMINAL_MIN_WIDTH}px))) / ${columnZoom})`;
  /** The same width WITHOUT the zoom division — for boxes that do not carry `zoom` themselves.
   *  The overlay spacer is one: it is plain layout, so reusing the divided expression would size it
   *  at `stored / Z` and the terminal beside it would reflow (and re-measure its PTY) on every
   *  overlay toggle, which is the precise thing that spacer exists to prevent. */
  const SPACER_WIDTH = `max(${MIN_WIDTH}px, min(var(${buildWidthVar(pairSide)}, ${width}px), calc(100% - ${TERMINAL_MIN_WIDTH}px)))`;
  // The committed-value writer for that same property — see `publishColumnWidthVar` — and the place
  // this column ANNOUNCES its width to the row.
  //
  // ON MOUNT AND ON EVERY CHANGE, not only on commit. The concierge's paired ceiling reserves both
  // build columns at the widths they actually have, so the row's mirror has to know this column's
  // width even when the user has never dragged it. Announcing only from `commitWidth` left the two
  // diverging whenever a sidebar mounted LATER than `Workspace` at a different window width: with
  // `sparkle-sidebar-width:left = 800`, an app started at 1280 records 220 (800 exceeds that
  // window's 680 ceiling); maximise to 2560 and open the left pair, and the sidebar seeds 800 while
  // the row still reserves for 220 — permitting a concierge that squeezes the 800px builder to 220
  // while the drag reports itself unclamped (roborev 56086/56088). That is the same failure the
  // `2 * max(left, right)` reserve was introduced to remove, reached through the mirror instead of
  // through the formula.
  //
  // NOTHING LISTENS TO THIS TODAY. The paragraph above describes why the row used to need it: the
  // concierge's ceiling reserved `2 * max(left, right)`, so the shell mirrored both build widths and
  // a stale mirror let the concierge squeeze a builder. That reserve is now the shared 50px floors —
  // a constant — so the mirror was removed and this event has no subscriber. Kept as the one channel
  // that reports a build width app-wide; see `BUILD_WIDTH_EVENT`. The CSS variable beside it IS live
  // and is what actually paints this column, so this effect earns its place regardless.
  useEffect(() => {
    publishColumnWidthVar(buildWidthVar(pairSide), width);
    window.dispatchEvent(
      new CustomEvent(BUILD_WIDTH_EVENT, { detail: { side: pairSide, width } }),
    );
  }, [width, pairSide]);
  // THE THIRD SEAM'S COPY OF THE SAME FIX (roborev 55993). The shell mounts `ColumnPullTab` at three
  // boundaries; the concierge's and the left pair's already drag from what is PAINTED rather than what
  // is STORED, and this one did not. `MAX_WIDTH` is reactive through `useWindowWidth` while `width` is
  // deliberately never reconciled against it, so `width > MAX_WIDTH` is this column's normal steady
  // state after a window shrink — at which point a tab handed the raw `width` starts its drag from a
  // number that is not on screen: the seam goes dead for `width - MAX_WIDTH` px of travel,
  // `aria-valuenow` sits outside `aria-valuemax`, and the first pointer-down commits the ceiling,
  // destroying the very `sparkle-sidebar-width:<side>` preference the block above says survives a trip
  // through a small display. `RENDERED_WIDTH` and `data-width` keep the RAW state, which is what makes
  // that survival true.
  // ── THE SECOND CEILING, AND THE ONE A RENDER CANNOT SEE (bead sparkle-1kvfy) ──────────────────
  //
  // `MAX_WIDTH` closes the WINDOW-derived half of the split above. It does not close the other half,
  // and the two-bounds block already says why: its reserve describes a ONE-pair cockpit, while this
  // component mounts twice once the left pair opens. So `RENDERED_WIDTH`'s `calc(100% - 320px)` —
  // resolved against `.paircols`, which is the PAIR — is the only thing bounding the paint there,
  // and `Math.min(width, MAX_WIDTH)` stops being "what is painted" the moment a second pair exists.
  //
  // The repro needs no window resize at all, which is what makes it ordinary rather than an edge
  // case: one pair at a 1600px window puts `MAX_WIDTH` at 1000, so a drag to 700 is legal and
  // persists. Open the left pair — a first-class action — and the row is concierge 360 + two pairs
  // sharing ~1240, so this column's container is ~614 and it paints at `min(700, 614 - 320) = 294`
  // while the tab still starts its drag from 700. ~400px of dead inward travel with no `clampedBy`
  // line to explain it, which is exactly the signature `engine/columnResize` was written to abolish.
  //
  // WHY THIS IS A CALLBACK AND NOT A PROP OR AN OBSERVER, both of which were tried on paper first:
  //  • A `pairWidth` prop from `Workspace` changes on every pointer event of the CONCIERGE's drag,
  //    and `Workspace.renderCost.test.tsx` holds that drag to ZERO renders of this component — it
  //    lists every agent and has no business running at pointer rate.
  //  • A `ResizeObserver` on the pair costs the same renders, and would be invisible to the suite
  //    that guards them (jsdom never lays out, so it would never fire) — a ratchet that stays green
  //    while production regresses is worse than no ratchet.
  //  • And a render-time value could not have caught the headline case anyway: opening the left pair
  //    does not change THIS column's props, so `memo` bails out and no render happens to read one.
  //
  // Measuring the same element the CSS resolves `100%` against is also what keeps the gesture and
  // the paint from drifting: a bound re-derived from the row's arithmetic would be a second, private
  // declaration of the layout — the "one constant, two files" shape this row keeps re-finding.
  // AND IT IS NEVER CACHED IN STATE, which is the third direction this same split can be entered
  // from and the one that cost a High (roborev 56159). The first version published each reading to
  // `measuredMax` so the ARIA range could name it, and fed that into the tab's `width` prop. But a
  // reading is taken by any gesture, INCLUDING ones that commit nothing: `endDrag` deliberately
  // skips `onWidth` when a press-and-release never travelled. So click the dots once with the left
  // pair open (container 614, stored width 700) and `width` is still 700 while the tab is handed
  // 294 — then CLOSE the left pair, and the column paints at 700 again while the tab still starts
  // its drag from the stale 294, jumping ~416px on the first pointer move and persisting the
  // result. The cache was the only stale thing in the design; the fix is to not have one.
  //
  // So the reading is read and discarded, per gesture, by `ColumnPullTab` alone: it latches the
  // value for the duration of one drag or keypress, clears it at the end, and nothing outlives that.
  //
  // THE COST IS THE ARIA RANGE, and it is a known, filed defect rather than an oversight —
  // `aria-valuemax` names the window ceiling, so with the left pair open the seam advertises a range
  // roughly twice the one it will honour. Retaining the reading to fix that was tried five ways and
  // every one of them had a state strictly WORSE than this; the full autopsy is in `ColumnPullTab`
  // beside the `aria-value*` attributes, and the work is bead sparkle-xbnw7. Read that before
  // "fixing" this, because the obvious repairs are the ones already known to fail.
  const columnRef = useRef<HTMLDivElement>(null);
  const measureGestureMax = useCallback((): number | null => {
    const box = columnRef.current?.parentElement;
    const w = box?.getBoundingClientRect().width ?? 0;
    // A container with no layout yet — the first frame of a mount, or a test environment with no
    // layout engine — is UNKNOWN, not a bound of zero. Reporting zero here would pin the column to
    // its minimum on the strength of a measurement that never happened.
    if (!Number.isFinite(w) || w <= 0) return null;
    return Math.max(MIN_WIDTH, Math.round(w) - TERMINAL_MIN_WIDTH);
  }, [MIN_WIDTH]);
  const RENDERED_TAB_WIDTH = Math.min(width, MAX_WIDTH);
  useEffect(() => {
    // A debounce that only cancels is a way to LOSE a width. Same trio the concierge seam and
    // projectStore register, for the same reason: a native window close destroys the webview and
    // React never unmounts, so `pagehide` alone is not enough.
    const flush = () => {
      if (!widthDirty.current) return;
      try {
        localStorage.setItem(widthKey, String(widthRef.current));
      } catch {
        // A width we cannot persist is cosmetic; it must not take the shutdown with it.
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
  }, [widthKey]);

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

  /**
   * PUT A BUILD AGENT IN FRONT OF THE USER, AND PLUG THE CABLE INTO IT.
   *
   * The one place selection-plus-wiring lives, because the producer landed on `onSelect` alone and
   * the sibling paths in this same file kept moving the selection WITHOUT the cable — the identical
   * "only half the callers got it" shape as the reopen/picker split two commits ago (roborev 55234).
   *
   * The far-pair case is worse than a no-op: the shell's pointerdown capture sees a chevron or the
   * "+ New Build Agent" row — no `[role="treeitem"]`, not inside a wired pair — and UNBINDS first.
   * So creating an agent in the unwired pair dropped the cable to "off", selected the new agent, and
   * sent the very next prompt ("start on X") to Sparkle instead of the agent just created. Clicking
   * that agent's row afterwards wired it; creating it did not.
   */
  const selectAndWire = (id: string | null) => {
    if (!project) return;
    // ── NO `showBuildStage` HERE, AND THAT IS A MEASURED CONCLUSION, NOT AN OVERSIGHT ──────────
    // Seating an agent is only half of putting it in front of the user: `Workspace` derives
    //
    //   paneVisibleAgentId.right = sparkleActive || boardActive || previewActive ? null : activeAgentId
    //
    // and `null` means NO AgentPane is visible on that side. So a path that moves the selection
    // while this column shows its Plan board, its Preview slot, or the Improve-Sparkle pane seats
    // an agent whose terminal never appears — the bug this helper looks like it should fix.
    //
    // It must not fix it here, because ALL THREE of this helper's callers already guarantee the
    // stage, and a fourth copy would be a line no test can hold (a `mutation-check` on it stays
    // green, since breaking it leaves the real guarantee untouched):
    //
    //   • `onMount`      — every route to it is preceded by `onSelect`, which reveals the stage
    //                      itself. `AgentRow.onRowClick` calls `onSelect()` unconditionally on its
    //                      first line (AgentRow.tsx:458) for EVERY click, `detail: 0` AT
    //                      activations included, and the keyboard path seats before it mounts the
    //                      same way. A `dblclick` is by construction preceded by two of those.
    //   • `onPickBuild`  — calls `showBuildStage(pairSide)` explicitly before it gets here.
    //   • `spawnBuildAgent` → `spawnBuildAgentInProject` → `landInAgent`, whose steps 1 and 2 are
    //                      `setActiveSpecial(null)` + `setWorkMode(side, "build")` — the same two
    //                      writes, from the helper whose entire job is "the thing you just asked
    //                      for is what you are now looking at" (services/landInAgent.ts:47-55).
    //
    // THE DEPENDENCY IN THE FIRST BULLET IS REAL AND IS GUARDED, not assumed: if AgentRow ever
    // stops seating a row before mounting it, the double-click case in
    // Workspace.mountRevealsTerminal.test.tsx goes red, because it asserts the mounted agent's pane
    // is actually PAINTED rather than merely selected.
    selectAgent(project.id, id);
    // NOTHING TO PLUG INTO — SEAT NOTHING, PATCH NOTHING. `id` is nullable because `onPickBuild`
    // passes null on purpose: a pair with no build rows clears the selection and shows the empty
    // Build state. Patching anyway claims a live circuit whose far end is EMPTY — `wiredAgentId`
    // reads the now-null selection, so `promptTarget` (Workspace) falls back to Sparkle while
    // `data-wired` floods this side and recedes the other. With two pairs it is the same lost
    // message this helper exists to prevent, just via the chevron: cable patched LEFT onto a real
    // agent, user clicks the RIGHT pair's Build chevron in a project that has no build agents, and
    // the next prompt goes to Sparkle instead of the agent they plugged into. A gesture that seats
    // no agent is not a connection (roborev 55246).
    if (!id) return;
    open(id);
    // `id`, not the selection: THIS is the agent the gesture named, and pinning it here is what
    // stops the live cable from following whatever row is clicked next (roborev 63145, finding 4).
    // The early return above guarantees it is non-null — a gesture that seats no agent is not a
    // connection, and a pin of `null` would fall straight back to the selection-following bug.
    patchCable(pairSide, id);
  };
  /**
   * SEAT THE AGENT AND HAND ITS TERMINAL THE CARET. A SINGLE CLICK, AND NO CABLE.
   *
   * Founder, 2026-08-12: *"I had also asked for a single click to not mount the concierge. And to
   * for a double click to be what mounts it."* This is the single-click half; {@link onMount} is the
   * other. Which gesture is which is `engine/cable`'s `mountsOnRowActivation`, not a rule the row or
   * this file may restate.
   *
   * IT IS NOT `selectAndWire` MINUS A LINE — the two are deliberately separate helpers rather than
   * one with a flag. A boolean parameter here is how the split silently collapses back: every future
   * caller has to pick a value, the safe-looking default is the old behaviour, and the founder's rule
   * is one careless `true` from being undone. The chevron and the spawn paths keep `selectAndWire`
   * because putting an agent in front of you by CREATING it, or by switching into Build, is still an
   * unambiguous "talk to this one" — neither is a press you make while merely reading the column.
   *
   * `requestPaneFocus` is the second half of the founder's sentence: a click that no longer mounts
   * must still put you somewhere useful, and the terminal is the agent's own input surface. The pane
   * consumes it once it is visible and its PTY is up — see stores/paneFocusStore for why the pane's
   * existing auto-focus cannot cover this on its own.
   *
   * WHICH IS WHY THE STAGE MATTERS MORE HERE THAN ANYWHERE, and why this is the ONE handler that
   * reveals it. "Put you somewhere useful" and "hand the caret to a pane you cannot see" are
   * opposites: under Plan/Preview (or the Improve-Sparkle pane) `paneVisibleAgentId` is forced to
   * `null`, so this used to focus a terminal that renders nowhere. A seat with no stage is not a
   * seat. {@link onMount} and {@link selectAndWire} carry no copy of the call and explain why.
   */
  const onSelect = (id: string) => {
    if (!project) return;
    // ── SHOW THIS COLUMN'S BUILD STAGE. THE ONE SITE THAT REVEALS IT FOR A ROW GESTURE ─────────
    // This replaces a bare `setActiveSpecial(null)`, which handled only ONE of the three surfaces
    // that can hide a pane. `Workspace` forces `paneVisibleAgentId[side]` to `null` while a column
    // shows its Plan board, its Preview slot, OR the Improve-Sparkle pane — so clearing the special
    // alone left a column sitting in Plan/Preview, and the click seated an agent whose terminal
    // never appeared. The concierge said "Chatting with X" over a stage still showing something
    // else, and nothing recovered it: `reconcileWorkMode` returns null for any non-Build mode.
    //
    // `showBuildStage`, not `setWorkMode` and not a bare clear. Its declaration
    // (stores/uiStore.ts:350-352) states the rule this call site was breaking: *"put a column into
    // Build **and** make its stage actually visible. Same rule — anything meaning 'show me the
    // terminal/rows' uses this."* Both writes live in the store so they cannot drift apart again.
    //
    // AND IT COVERS THE MOUNT TOO, which is why `onMount`/`selectAndWire` carry no copy: `AgentRow`
    // seats a row before it ever mounts one — `onRowClick` calls `onSelect()` on its first line for
    // every click (AgentRow.tsx:458), and a double press is two of those before the `dblclick`. See
    // the note in `selectAndWire` for the full caller audit.
    //
    // SCOPED TO THIS PAIR rather than global, which is the one deliberate behaviour change here:
    // `showBuildStage` yields the Sparkle pane only for the side that owns it (SPARKLE_PANE_SIDE),
    // so a LEFT column's row click no longer reaches across to close a RIGHT-pair surface. That
    // matches how visibility is derived (`paneVisibleAgentId.left` does not read `sparkleActive` at
    // all) and the cross-pair reach `openPlanBoard`'s scoping exists to prevent (roborev 55878).
    showBuildStage(pairSide);
    selectAgent(project.id, id);
    open(id);
    requestPaneFocus(id);
  };
  /**
   * Patch the cable onto a row — the DOUBLE click, and the activations with no double form.
   *
   * NO `setActiveSpecial(null)` OF ITS OWN ANY MORE. It used to run one here before delegating, and
   * that bare clear was the bug: it yielded the Improve-Sparkle pane but said nothing about the work
   * MODE, so double-clicking a row while the column showed its Plan board or Preview slot mounted an
   * agent whose terminal never appeared — the founder's report, with the concierge announcing
   * "Chatting with X" over a stage that was still showing something else.
   *
   * NOTHING REPLACES IT HERE, and that is deliberate. `onSelect` reveals the stage, and every route
   * into this function has already been through it: `AgentRow.onRowClick` seats the row on its first
   * line for EVERY click (AgentRow.tsx:458) — `detail: 0` assistive-tech activations included — and
   * the keyboard path seats before it mounts too, so by the time a `dblclick` reaches here the
   * column is already showing its Build stage. A second call would be a line no test could hold:
   * breaking it leaves `onSelect` covering for it, so `mutation-check` reports it green and the
   * "covered" verdict would be false. Measured, not assumed — that is exactly what a first cut of
   * this fix did, and the check caught it.
   *
   * The founder, 2026-08-13, asked what the pane should show when you mount onto agent X: *"X's
   * terminal, always — Mounting is also a selection: the terminal pane follows the MOUNTED agent,
   * and shows X's live terminal immediately."* Note what that does NOT say: the stage is not FROZEN
   * to X. A later single click on row Y still moves the terminal to Y — only the CABLE stays pinned
   * to X (c60b17e46, "look at B without changing who you're talking to"). Revealing the stage on
   * every seat is what makes both halves true at once.
   */
  const onMount = (id: string) => {
    if (!project) return;
    selectAndWire(id);
    // ── PATCH THE CABLE ──────────────────────────────────────────────────────────────────────
    // THE GESTURE THAT MAKES THE WHOLE CONNECTION FEATURE REACHABLE. Everything downstream of
    // `wired` — the concierge's flood and lift, the shell root's `data-wired`, the seam that
    // vanishes, and `promptTarget` routing to THIS pair — was already built and correct, and none
    // of it could ever fire: nothing in app code called `patch`. The only producers were the test
    // suite and the dev-only capture handle, so in a shipped build `wired` was permanently "off"
    // and the two `workspace-wired-*` surfaces captured a state no user could reach (roborev 55221).
    //
    // Selecting a build row IS the connection: MAPPING.md's `data-wired` is "which side holds the
    // live cable", and the side is this sidebar's own pair. ONE LIVE CIRCUIT falls out of
    // `patchCable` — patching the other side moves the cable rather than lighting both.
    //
    // A DELIBERATE ACTIVATION ONLY — and now that is the only kind there is. This function used to
    // take a `via?: "hover"` flag and serve two callers: a click, and a 90ms dwell timer on plain
    // mouseenter. The hover half selected and mounted but deliberately SKIPPED the patch below,
    // because hanging the patch on it broke two documented behaviours (roborev 55234):
    //
    //  1. It defeated the unbind gestures. engine/cable states Escape and click-away are the one way
    //     back to floating middle; after either, moving the pointer back across the column re-patched
    //     with no intent at all.
    //  2. WORSE, it re-routed prompts ACROSS PAIRS. `promptTarget` derives from `wired`, so with two
    //     pairs and the cable patched left, a cursor crossing the RIGHT sidebar and pausing 90ms
    //     moved the cable — and Send delivered the user's message to a different pair's terminal.
    //
    // "Selection may follow the mouse; the cable may not" was the resolution then. The founder's
    // rule supersedes it: selection may not follow the mouse EITHER. With the hover caller gone the
    // split has no reason to exist, so the flag went with it. See HOVER_INTENT_MS's headstone, which
    // lives beside the handlers it governs in ./AgentRow.
    //
    // AND THE SAME ARGUMENT CAME BACK ONE STEP FURTHER IN (2026-08-12). A dwell is not the only
    // pointer event you make while merely LOOKING at the column — a single click is one too, and it
    // was mounting. So selection and the cable split again, this time at the gesture: `onSelect`
    // above seats the row, and this function is reached only from an activation
    // `mountsOnRowActivation` calls a mount. The predicate lives in `engine/cable` and not here,
    // because "which gesture patches" is part of the connection feature MAPPING.md forbids
    // scattering into components.
  };
  // The chevron strip switches the active (colored) mode and filters the sidebar list by kind. Build
  // is two-stage: the FIRST click (when Build isn't already the active section) just switches into
  // the section; clicking the SAME chevron AGAIN while already in Build spawns a fresh build agent
  // (same as the "+ New Build Agent" button). Plan stays a pure mode switch: it has no agent concept
  // and only opens the read-only Tasks board in the main pane.
  // ENTER PREVIEW. A pure mode switch, exactly like `onPickPlan` and deliberately unlike
  // `onPickBuild` (whose second press spawns an agent): pressing it twice must not start a second
  // dev server, and starting one at all is the hover-card action's job, not a mode toggle's. The
  // slot renders whatever state that agent's preview is in, including "none".
  const onPickPreview = () => {
    openPreview(pairSide);
  };
  const onPickPlan = () => {
    // ONE WRITE FOR THE BOARD, to THIS column. It used to also set the window-global
    // `activeSpecial = "board"`, which is what made the board a singleton — that global was the
    // thing the (single, right-pair) renderer actually read, so this column's identity was lost the
    // moment the chevron was pressed. The column's own mode is now the only truth for its own board.
    // ...via openPlanBoard, NOT `setMode("plan")`. Entering Plan also has to make the Sparkle pane
    // yield, or this is a dead control while it is up — and that pairing lives in the store so it
    // cannot drift out of one of the three paths that mean "show me the board" (roborev 55878).
    openPlanBoard(pairSide);
  };
  // Spawn a build agent AND auto-create a bead for it, so every piece of build work is tracked
  // from the start (it floors at "Planned" until code work begins). Shared with the Workspace
  // empty-state start button via the useSpawnBuildAgent hook so both create agents identically.
  // LOCAL ONLY. This path no longer has a cloud branch — the billed action lives entirely in
  // NewCloudAgentButton, which opens the create dialog rather than spawning anything here. (It used
  // to fork on a Local/Cloud toggle, via a `useNewAgent` wrapper that is now deleted.)
  const spawnBuildAgentRaw = useSpawnBuildAgent(project);
  /**
   * Spawn, then WIRE what was spawned.
   *
   * Creating an agent is the strongest possible "talk to this one" — you asked for it to exist —
   * and it was the path that left the cable off. In the far pair it actively dropped it: the shell's
   * pointerdown capture sees the "+ New Build Agent" row as outside the circuit and unbinds before
   * the spawn runs, so the next prompt went to Sparkle rather than the agent just created.
   *
   * The local spawn returns the new id synchronously, so there is always something to wire. The
   * only null is "no project", which seats nothing.
   *
   * The CLOUD row is deliberately not on this path and does NOT re-wire: the server has to start the
   * session before a tab exists, so at click time there is nothing to plug into. The row click that
   * follows its arrival does it.
   */
  const spawnBuildAgent = () => {
    const id = spawnBuildAgentRaw();
    if (id) selectAndWire(id);
    return id;
  };
  const onPickBuild = () => {
    // `paneCoversMe` (component scope) rather than the bare global — see its definition. The
    // chevron and the row highlighting have to answer "is my stage covered" the same way, or the
    // press does something other than what the column is painting.
    const alreadyHere = mode === "build" && !paneCoversMe;
    // showBuildStage, not setMode + setActiveSpecial: the pairing lives in the store so this
    // chevron and the concierge's `set_work_mode("build")` cannot answer the same request
    // differently. It also SCOPES the yield to the pane-owning pair, where this used to clear the
    // window-global unconditionally — a left column's Build press reaching across to close a
    // right-pair surface, the mirror of the bug openPlanBoard's scoping prevents.
    showBuildStage(pairSide);
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
    // Wires too: switching into Build is the user putting a build agent in front of themselves,
    // which is the same act as clicking its row.
    selectAndWire(next);
  };
  // Stable so the memoized SparkleAgentRow doesn't re-render on unrelated status flips (sparkle-alrm.3).
  // Improve Sparkle is per-window: reveal THIS window's own copy in place (its own worktree/branch/
  // conversation keyed by sparkleAgentId). No cross-window focus/broadcast. See services/sparkleReveal.
  //
  // AND IT MOUNTS, like every other build row. Founder, 2026-07-29: "I also want this same mounting
  // functionality to work for the improve sparkle agent at the bottom of the build column. It should
  // work the same way." Its own pane's composer is gone (SparkleAgentPane), so patching the cable is
  // now the ONLY way to talk to this agent — a click that seated the pane without patching would
  // leave it with no input surface but the raw terminal.
  //
  // `patchCable(pairSide)` and NOT `selectAndWire`: that helper calls `selectAgent(project.id, id)`,
  // and this id is not one of the project's agents. Same side, same reducer, same ONE LIVE CIRCUIT —
  // just without writing a foreign id into the project's selection.
  const onSelectSparkle = useCallback(() => {
    handleImproveSparkleClick({
      activateLocal: () => {
        setActiveSpecial("sparkle");
        open(sparkleAgentId);
        // PINNED TO THE SPARKLE AGENT, which is the one this gesture named (roborev 63145 #4).
        // It is deliberately NOT `project.selectedAgentId`: this agent is never a roster member, so
        // the selection here names some OTHER agent entirely — exactly the mismatch the pin exists
        // to remove. Routing to the pane goes through `decidePromptTarget`'s special arm rather than
        // this pin, so the value is truthful state rather than the thing that decides the send.
        patchCable(pairSide, sparkleAgentId);
      },
    });
  }, [setActiveSpecial, open, sparkleAgentId, patchCable, pairSide]);
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
    (agents: readonly AgentTab[], forMode: WorkMode): string | null => {
      const rt = useRuntimeStore.getState();
      const stageFor = (id: string) => resolveStage(rt.branchStatus[id], rt.workflowStage[id]);
      // Same roll-up the ladder buckets by: an orchestrator tracks its LEAST-advanced worker.
      const headStageFor = (id: string): WorkflowStageId => {
        const kids = agents.filter((a) => a.parentId === id);
        const rollup = rollupStages(kids.map((w) => stageFor(w.id)));
        return rollup ? rollup.stage : stageFor(id);
      };
      const published = publishedStatusFor(agents, rt.status, new Set(rt.openAgentIds), rt.lastObserved, stageFor);
      // The SAME subtree fold the column uses (headHoldsWorkOf). `local_none` sorts above
      // `local_uncommitted`, so omitting this here would compute a different first row than the one
      // rendered — the drift roborev 53411/53428/53439/53440 kept finding, reached through the
      // section axis rather than the band axis.
      const headHoldsWorkFor = (id: string): boolean | undefined =>
        rollupHoldsWork([
          uncommittedWorkEvidence(rt.branchStatus[id]),
          ...agents.filter((a) => a.parentId === id).map((w) => uncommittedWorkEvidence(rt.branchStatus[w.id])),
        ]);
      return firstLadderRowId(
        agents,
        forMode,
        headStageFor,
        (id) => published[id] ?? "stopped",
        useUiStore.getState().statusFilter,
        headHoldsWorkFor,
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
    const freshMode = useUiStore.getState().workModeBySide[pairSide];
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
    // reflect the live git state, not a snapshot (sparkle-alrm.3). The receipt is read the same way
    // and for the same reason: an agent can file its retro while this row sits under the cursor.
    const rt = useRuntimeStore.getState();
    const stage = resolveStage(rt.branchStatus[id], rt.workflowStage[id]);
    const decision = closeDecision(agent.kind, stage, rt.branchStatus[id], {
      settled: retroSettled(cachedReceipt(project.id, id)),
    });
    if (decision === "work-at-risk-prompt") setClosePromptId(id);
    // THE FOUNDER'S GATE (bead sparkle-0l9xk): "the build agent shouldn't be removed from the build
    // list until I, as the human, confirm that." Before this, `shouldPromptOnClose` returned false
    // for a landed agent and this line read that as permission to tear down — so merged and shipped
    // rows were the one population that vanished on a single click with no prompt at all.
    else if (decision === "retirement-confirm") setRetireConfirmId(id);
    else void teardownAgent(id);
  };

  // ── Close-agent Ship / Save / Discard (sparkle-o341) ───────────────────────────────────────────
  const closingAgent = project?.agents.find((a) => a.id === closePromptId) ?? null;

  // ── Retirement confirm (sparkle-0l9xk) ─────────────────────────────────────────────────────────
  // SUBSCRIBED, so a receipt that lands mid-poll actually repaints. `retirementPill` reads the cache
  // synchronously during render and `AgentRow` is memoized, so without this the 15s load updated a
  // module-level Map that nothing was watching: the pill would keep saying RETRO PENDING until some
  // unrelated state change happened to re-render the row, and an OPEN dialog would never update at
  // all (roborev 59153). The version counter is the whole snapshot — it is bumped on every mutation.
  const receiptVersion = useSyncExternalStore(subscribeRetroReceipts, retroReceiptsVersion);
  const retiringAgent = project?.agents.find((a) => a.id === retireConfirmId) ?? null;

  // A MACHINE CLOSE THAT GOT REFUSED ENDS UP HERE. `closeBuildAgent` turns the concierge, the phone
  // and the green suggestion button away for a landed agent; each of them then asks for this dialog
  // rather than giving up, so the click still leads to the human instead of nowhere.
  //
  // OWNERSHIP IS CHECKED, and that is the whole reason the listener returns a boolean: two sidebars
  // are mounted (one per column) and each renders a DIFFERENT project. The one that does not hold
  // this agent must decline, or it would open a confirm for a row it cannot show and report the
  // human as asked.
  useEffect(() => {
    return subscribeRetirementConfirmRequests((agentId) => {
      // Read the project FRESH from the store, not from the render-scope `project`: this closure
      // outlives the render that created it, and a stale capture would decline a request for an
      // agent this column has since taken on.
      const p = useProjectStore.getState().projects.find((x) => x.id === projectId);
      if (!p?.agents.some((a) => a.id === agentId)) return false;
      setRetireConfirmId(agentId);
      return true;
    });
  }, [projectId]);

  /** The human said yes. Record the gap FIRST when there is one, then tear the row down.
   *
   *  ORDER IS LOAD-BEARING. `removeAgent` is a hard delete plus a tombstone — after it runs there is
   *  no row, no `agent:<id>` to attribute a bead to, and no way to tell later that this agent left
   *  owing a retro. So the override receipt is AWAITED before teardown, not fired alongside it.
   *
   *  A failed write does NOT block the retirement. The human has decided, and refusing to remove a
   *  row because we could not write a note about it would strand exactly the dead agents this path
   *  exists to clear — the failure mode the override was added to prevent. It is logged instead. */
  const confirmRetire = async (id: string, shown?: RetroStanding) => {
    if (!project) return void teardownAgent(id);
    // THE GATE ON THE PERMANENT MARK (bead `sparkle-y2p4f`). This used to be `!settled`, i.e. "no
    // receipt on file" — which is true of EVERY agent, because no production path writes a
    // `captured` receipt. So the gap note was written on the absence of evidence rather than on
    // evidence of absence, and 19 of the 29 receipts on disk when this was fixed were against
    // agents that had filed 1–13 feedback beads apiece. A receipt has no delete path anywhere in
    // the app, so each of those is permanent.
    //
    // Re-read here rather than trusting the dialog's prop: the modal can sit open across polls, and
    // this is the call that writes.
    const standing = retroStanding(
      retroSettled(cachedReceipt(project.id, id)),
      feedbackEvidenceFor(project.id, id),
    );
    // ── THE RE-READ MAY ONLY CANCEL THE WRITE, NEVER INTRODUCE ONE (roborev, on this commit) ─────
    // `shown` is the standing the dialog actually had on screen. The beads read is UNSUBSCRIBED and
    // a freshness-only `unknown`→`absent` transition mutates no store state at all (an unchanged
    // poll advances the module-scope `polledAt` and deliberately leaves `byProject` identical), so
    // between open and click the fresh answer can become `absent` while the human is still reading
    // "I won't record anything against this agent either" under a plain "Retire it". Taking the
    // fresh answer alone would write the permanent, undeletable gap receipt that copy just ruled
    // out — the same false mark this whole path exists to stop, in a narrower window.
    //
    // So both must agree. A machine caller with no dialog behind it passes nothing and writes
    // nothing: silence is not evidence, and this is the branch that cannot be undone.
    if (mayRecordRetroGap(standing) && shown !== undefined && mayRecordRetroGap(shown)) {
      const rt = useRuntimeStore.getState();
      const bs = rt.branchStatus[id];
      const wrote = await recordRetroOverridden(project.id, id, {
        // WHAT WAS ESTABLISHED, NOT WHAT WAS INFERRED (roborev 59153). This used to read "Retired
        // without a retro: the agent could not be asked for one", which asserts a gap this app
        // cannot see: nothing yet writes a `captured` receipt, so an agent that filed a perfectly
        // good retro through the merge hook — into beads, where this store cannot look — reads as
        // unsettled here. Recording that as "never reported" would put a false gap in the one store
        // the whole feature exists to make trustworthy. The receipt survives the agent, so it says
        // only what the app actually knows.
        // NOW A STRONGER, NARROWER CLAIM. The old text had to hedge — "none was recorded HERE — a
        // retro filed through the merge hook is not visible to this store yet" — because the app
        // genuinely could not see the beads store and was recording a gap it could not stand
        // behind. It can see it now, and this line is only reached once BOTH stores have been read
        // and both came back empty, so the receipt says what was actually checked.
        reasonText:
          "Retired by the founder with no retro receipt on file, and no agent-feedback beads " +
          "attributed to this agent in a fresh read of the backlog at the time.",
        // Display-only evidence, captured while the row still exists — see RetroReceipt.branchEvidence.
        ...(bs ? { branchEvidence: `${bs.ahead} ahead, ${bs.dirty ? "dirty" : "clean"}` } : {}),
      });
      if (!wrote) {
        // THE ROW STAYS (knightwatch probe 4). This used to log and tear down anyway, on the
        // reasoning that refusing to remove a row over a failed note would strand the dead agents
        // this path exists to clear. But the dialog's own button says "record the gap", and the
        // teardown is a hard delete: proceeding destroys the row AND the record, leaving nothing to
        // retry from and no trace that the gap ever existed — in the one store this feature exists
        // to make trustworthy. Keeping the row is recoverable; he can press it again.
        log.warn("retire", "override write FAILED — row kept for retry", { agentId: id });
        setRetireConfirmId(null);
        setCloseNotice({
          title: `Couldn’t record the retro gap for “${project.agents.find((a) => a.id === id)?.name || "this agent"}”`,
          body: "I’ve left the agent in your list rather than removing it, because retiring it now would take the row and the record with it. Try again in a moment.",
        });
        return;
      }
    }
    // `teardownAgent`, DELIBERATELY, and not `closeBuildAgent(id, true)` — knightwatch 5204094441#1
    // asks for the funnel and it was tried here. The probe is right that the two paths differ:
    // `closeBuildAgent` also runs `spinDownAgentGit` with `deleteBranch: deleteMergedBranch`, so the
    // founder's "delete merged branches" setting does not apply on the retirement path (tracked as
    // bead `sparkle-a2uoq` — it is a real gap and it is not this one).
    //
    // What the funnel costs is the reason it is not taken: `closeBuildAgent` AWAITS the git teardown
    // before dropping the rows, while this path drops them first and reclaims disk in the background
    // — on purpose, and named in `teardownAgent`'s own comment as the fix for "× closes the terminal
    // but the row lingers/comes back". Routing the human's most-clicked retire button through the
    // awaiting version puts a multi-second worktree removal in front of the row disappearing, and
    // makes a git failure leave the row standing with its panes already closed. Trading a settings
    // gap for a re-opened UX regression is not an improvement; the gap gets its own fix.
    void teardownAgent(id);
  };

  // ── Move to cloud (promotion, bead sparkle-8zpvc) ──────────────────────────────────────────────
  // SCOPED TO THIS COLUMN'S PROJECT. `promoteAgentId` is one app-wide id; resolving it against
  // `project.agents` is what keeps the other column — which renders a DIFFERENT project — from
  // mounting a second copy of the same dialog.
  const promoteAgentId = useUiStore((s) => s.promoteAgentId);
  const closePromoteToCloud = useUiStore((s) => s.closePromoteToCloud);
  const promoteAgent = project?.agents.find((a) => a.id === promoteAgentId) ?? null;
  const promoteGate = useCloudGate();
  // Workers stay LOCAL when their orchestrator is promoted (spec §Not in scope), which is a thing
  // the dialog has to say — so the count is resolved here, where the agent list is, and handed to
  // the pure plan.
  const promoteWorkerCount = promoteAgent
    ? (project?.agents.filter((a) => a.parentId === promoteAgent.id).length ?? 0)
    : 0;
  const promoteDeps = useMemo(
    () =>
      project && promoteAgent
        ? promoteDialogDeps({
            project,
            agent: promoteAgent,
            gate: promoteGate,
            workerCount: promoteWorkerCount,
          })
        : null,
    [project, promoteAgent, promoteGate, promoteWorkerCount],
  );

  // ── Bring down to local (demotion, plan §W4) ───────────────────────────────────────────────────
  // The mirror of the block above, scoped to this column's project for the same reason. NOTHING
  // here consults `useCloudGate`: a user whose credits ran out is exactly the user who needs to
  // bring work down, and a gate that hides the exit is a trap.
  const demoteAgentId = useUiStore((s) => s.demoteAgentId);
  const closeDemoteToLocal = useUiStore((s) => s.closeDemoteToLocal);
  const demoteAgent = project?.agents.find((a) => a.id === demoteAgentId) ?? null;
  const demoteDeps = useMemo(
    () => (project && demoteAgent ? demoteDialogDeps({ project, agent: demoteAgent }) : null),
    [project, demoteAgent],
  );

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
        projectId: project.id,
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
    // A SUCCESSFUL SHIP IS EXACTLY WHAT MAKES THE RETIREMENT GATE APPLY (knightwatch probe 2).
    // This was an unconditional teardown, which meant the one gesture that MOST reliably lands work
    // was also the one that removed the row without a confirm — the fifth door, after the four
    // machine paths `closeBuildAgent` already gates. Shipping is not a reason to skip the founder's
    // confirm; it is the reason he is owed one.
    // `outcome.landed`, NOT `kind`: a `pr-opened` ship has `landed: false` — the branch is up for
    // review, nothing is merged, and the gate does not apply. Only the local-land path merges here.
    if (outcome.landed) {
      // PERSIST IT, don't just open the dialog (knightwatch 5204094441#3). `outcome.landed` is a fact
      // about THIS tick and nothing else remembers it: the 15s poll derives the stage from git, and a
      // no-remote land leaves a clean tree 0 commits ahead — indistinguishable from an agent that
      // never built anything. Dismiss the dialog and the next × resolved to `silent` and removed the
      // row. `resolveStage` takes the MAX of derived and override, so this only ever ratchets up.
      useRuntimeStore.getState().setWorkflowStage(id, "merged_local");
      setRetireConfirmId(id);
      return;
    }
    await teardownAgent(id);
    if (outcome.kind === "pushed-no-pr") {
      // NOT landed: the branch is safe on the remote but nothing is merged, so the retirement gate
      // does not apply and the teardown stands. There is no review open and the bead is still in
      // progress, and neither is guessable from a tab that vanished.
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
  // ── HOW WIDE IS THIS COLUMN? (bead sparkle-tyter) ────────────────────────────────────────────
  // The founder: *"If the column is narrow, I don't think we should show the in PR or saved or
  // shipped pill."* Measured ONCE here and threaded down as a prop rather than measured per row —
  // forty rows each observing the same element is forty callbacks per resize frame to learn one
  // number, and `agentRowPropsEqual` (which now compares it) keeps the re-render cost to the rows
  // that actually cross the threshold.
  //
  // 0 until the first observation, which `stageChipShows` reads as the WIDE form: booting into the
  // hidden state and revealing the chip a frame later flickers every row in the column at once.
  const [columnWidth, setColumnWidth] = useState(0);
  useEffect(() => {
    const el = listScrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      // `borderBoxSize`, NOT `contentRect` (roborev 58758). This element carries
      // `padding: 0 ${LIST_PAD_X}px`, so `contentRect.width` is the COLUMN width minus 16 — and
      // minus the scrollbar gutter on top of that. Comparing that to a constant documented as "the
      // column width" is a systematic under-read that biases every row toward the hidden form.
      // `offsetWidth` is the fallback for the jsdom/older-observer path where the box array is
      // absent; both are border-box readings, which is what the threshold is written against.
      const entry = entries[0];
      if (entry === undefined) return;
      const w = entry.borderBoxSize?.[0]?.inlineSize ?? (entry.target as HTMLElement).offsetWidth;
      if (typeof w === "number" && w > 0) setColumnWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
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
    // Scoped for the same reason as the reads above, though note this one carries no behavior
    // today and no test asserts it: `reconcileWorkMode` short-circuits on any non-Build mode and
    // otherwise `mode` is already "build", so it answers `null` in every state where `hasSpecial`
    // could matter. It is passed scoped so the column has ONE answer to "is my stage covered"
    // rather than two that could drift.
    //
    // THE THIRD MODE ARRIVED, and this comment used to end "if that helper ever grows a third
    // mode" — it did, and the prediction was right: under the old `mode === "plan"` guard this
    // effect wrote "build" over `"preview"` on the frame it was entered, because a row is always
    // selected here. The guard asks the property now (`mode !== "build"`), which is why the
    // sentence above says "any non-Build mode" rather than naming them.
    const next = reconcileWorkMode(hasSelection, mode, paneCoversMe);
    if (next) setMode(next);
  }, [project, mode, paneCoversMe, setMode]);
  // ASK ONCE PER PROJECT WHETHER IT CAN BE PREVIEWED. Nothing else fills `previewStore.capability`,
  // so without this every preview affordance is permanently absent — the feature would be inert with
  // nothing logged, which is the exact failure shape this repo keeps re-finding.
  //
  // GATED ON "not asked yet" rather than re-run on mount: the probe is an `invoke` that walks the
  // worktree's manifests, and both columns plus every remount would repeat it. The cost of the gate
  // is that a project which GAINS a dev script mid-session keeps its old answer until the next
  // launch; that is a Phase 2 refresh, not a reason to spend a bounded filesystem walk per mount.
  //
  // `rootPath`, not an agent worktree: detection is a property of the project's own manifests
  // (design §7), and every worktree of it answers the same.
  useEffect(() => {
    if (!project) return;
    if (usePreviewStore.getState().capability[project.id] !== undefined) return;
    // Fire and forget: the service records an ANSWER (previewable or a decline) and records NOTHING
    // when the probe fails, which is what keeps a transient failure re-askable — so there is
    // nothing to await and nothing here to handle. The gate above is therefore self-limiting only
    // once an answer lands; until then this re-probes on each new `project` identity, which is the
    // intended behaviour. Awaiting would only delay a render that already has its honest default
    // ("we do not know" → no affordance).
    void refreshPreviewCapability(project.id, project.rootPath);
  }, [project]);
  // If Beads is turned off while the user is parked on the (now-hidden) Plan board, leave it — the
  // board won't render and the Plan chevron is gone, so a stuck empty state would result otherwise.
  // Also covers Plan mode without the board special, so no code path can strand the user in a Plan
  // mode they can't leave.
  useEffect(() => {
    if (beadsEnabled) return;
    // Only THIS column is rescued, and only if it is the one parked in Plan. Reading the global
    // `activeSpecial === "board"` here used to drag the other column out of Plan as well.
    if (mode === "plan") setMode("build");
  }, [beadsEnabled, mode, setMode]);
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

  // The heads the expand-all / collapse-all control acts on: every top-level build agent in THIS
  // column that actually has workers. A head with no workers has no subtree and no chevron, so
  // including it would let "collapse all" write entries for rows that cannot be expanded.
  const subtreeHeadIds = useMemo(
    () =>
      topLevelAgents
        .filter((a) => a.kind === "build" && (childrenByParent.get(a.id)?.length ?? 0) > 0)
        .map((a) => a.id),
    [topLevelAgents, childrenByParent],
  );
  // Whether the column is ALREADY fully one way — used only to dim the half that would do nothing.
  // Two separate reads, not one flag and its negation: a MIXED column (some open, some shut) is
  // neither, and both halves stay live because pressing either genuinely changes something. Deriving
  // "fully collapsed" as `!allExpanded` painted the collapse half dead in exactly that case while it
  // still worked, which is worse than no dimming at all.
  const allSubtreesExpanded =
    subtreeHeadIds.length > 0 && subtreeHeadIds.every((id) => !collapsed.has(id));
  const allSubtreesCollapsed =
    subtreeHeadIds.length > 0 && subtreeHeadIds.every((id) => collapsed.has(id));

  // NOTHING HERE OPENS A SUBTREE. A parent's expanded state is USER STATE — written by the head-row
  // click and by the header's expand-all / collapse-all, and by nothing else. Two effects used to
  // live at this spot: one opened a subtree when a worker under it went red, the other closed the
  // ones it had opened once the red cleared. Together they produced a parent sitting open under a
  // project the user never touched, showing a GREEN worker. Both are gone, along with the
  // `autoExpandedOrchestrators` mark that told them apart — see uiStore.setOrchestratorsCollapsed
  // for why one writer makes that state unreachable rather than merely fixed, and why a periodic
  // "is anything wrongly open?" sweep must NOT be added back.
  //
  // What replaced the capability they provided is the PEEK further down: a CLOSED parent with a red
  // worker under it renders one inset line naming it (or a count, when several are red). It is
  // derived from the current attention snapshot on every render and writes no state at all, which is
  // why it needs neither the edge detector nor the first-sighting baseline those effects carried.
  //
  // The PEEK is what replaced the capability those effects provided: a CLOSED parent with a red
  // worker under it renders one inset line naming it (or a count, when several are red). It is
  // derived from the current statuses on every render and writes no state at all, which is why it
  // needs neither the edge detector nor the first-sighting baseline those effects carried — and why
  // it cannot leave a subtree standing open after the red has gone. See WorkerPeek below.
  //
  // Note what is NOT here any more: an `expectsLiveStatus` predicate and the three-state attention
  // snapshot it fed. That third state (`unknown` — "a reading is still coming for some worker under
  // this head") existed to stop AUTO-COLLAPSE acting on a fact it did not have. With nothing closing
  // rows on the user's behalf there is no such decision to protect, and the peek needs only the
  // two-valued question `attentionWorkersOf` asks: is this worker live, and is it red?

  // REVEAL THE SELECTION. A SELECTED worker must always have a
  // visible row, or the terminal shows an agent that no row is highlighting — the original bug that
  // made workers get rows at all (see the header of AgentSidebar.workerRows.test.tsx). Spawning no
  // longer trips this, because spawnWorker's `select: false` never selects the new worker — under
  // ANY prior selection, including a null one (that flag is absolute; see AddAgentOpts.select, which
  // it briefly wasn't). This is the guard for every other way selection reaches a worker.
  //
  // This is a USER-INTENT write, and the only one in this file: selecting a worker is a human act,
  // and it names exactly one subtree. That is what distinguishes it from the deleted attention rule,
  // which opened rows in response to a machine event nobody asked about.
  //
  // Fires on a CHANGE of selection, not on the state of it: a user who selects a worker and then
  // collapses its subtree must stay collapsed, and re-asserting every render would undo that gesture
  // immediately. The first observation DOES count — a relaunch that restores a worker selection must
  // render its row, and this opens the ONE subtree that holds it rather than all of them.
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
      useUiStore.getState().expandOrchestrators([sel.parentId]);
    }
  }, [selectedAgentId, project]);

  // NOTE what is deliberately absent here: the "put it away again" effect that used to close subtrees
  // the app had opened. It existed only to undo the app's OWN expansions, and with nothing left that
  // opens a row automatically it has nothing to undo. Re-adding it — or any periodic sweep that
  // closes rows it judges stale — would make the app a writer of user state again and reintroduce the
  // flap it cost two roborev findings (53994, 54031) to tune out. If a row is open, a human opened
  // it, and only a human closes it.

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

  // Does this row's SUBTREE hold anything uncommitted? Rolled up exactly like `headStageOf` above,
  // and for the reason that comment gives: the head is bucketed by its least-advanced worker, so
  // answering from its own tree alone would file a head under "Local: Nothing Yet" while the bar on
  // that same row showed a worker mid-edit. `rollupHoldsWork` owns the precedence
  // (true > undefined > false) so this and `firstRenderedRowId` cannot fold it differently.
  const headHoldsWorkOf = useCallback(
    (id: string): boolean | undefined => {
      const kids = childrenByParent.get(id) ?? [];
      return rollupHoldsWork([
        uncommittedWorkEvidence(branchStatus[id]),
        ...kids.map((w) => uncommittedWorkEvidence(branchStatus[w.id])),
      ]);
    },
    [childrenByParent, branchStatus],
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
      rollupViewFor(
        project?.agents ?? [],
        liveStatus,
        new Set(openAgentIds),
        lastObserved,
        (id) => resolveStage(branchStatus[id], workflowStage[id]),
        undefined,
        undefined,
        undefined,
        // The column's disc must agree with every other surface about a finished head — otherwise
        // the row reads red here and calm in the digest (bead sparkle-hpbkw).
        isFinishedOf,
      ),
    // `graceTick` is deliberate: this memo runs step (0) with an internally-sampled clock, and for a
    // held `errored` agent none of the other deps ever change again — so the row's disc and its
    // "Needs you" chip would stay gray `new` while `status` above had already gone red. The two
    // disagreeing inside one component is exactly what this shared tick exists to prevent
    // (roborev 54830).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project?.agents, liveStatus, openAgentIds, lastObserved, branchStatus, workflowStage, graceTick, isFinishedOf],
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
            headHoldsWorkOf,
          )
        : [],
    [project, effectiveStatus, mode, headStageOf, statusFilter, rowBandOf, headHoldsWorkOf],
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

  // ── THE PINNED CONCIERGE AGENTS ROW'S VIEW MODEL (bead sparkle-s7rfc) ──────────────────────────
  //
  // THE SAME FOUR LINES THE SPARKLE ROW ABOVE TAKES, and for the same reason: the row must not hold
  // a private copy of this derivation, because a private derivation does not inherit fixes. That is
  // the failure recorded at length above — the Improve Sparkle row rendering GREEN while its agent
  // sat on an unanswered picker — and it is the one thing `ConciergeAgentsRow`'s header forbids.
  //
  // WHAT IS DIFFERENT, and why it is not a second pipeline:
  //
  //   • The row's OWN status is `stopped`, always. A research task is not an agent (no worktree, no
  //     branch, no pane, no PTY — see the row's header for why widening `AgentKind` was refused), so
  //     there is no id to look up in `effectiveStatus` and nothing of its own for the row to report.
  //     `"stopped"` is the identical fallback every build row takes before it has ever spawned.
  //   • Its "workers" are the LIVE research tasks, translated into the column's status vocabulary by
  //     `agentStatusForResearch`. `rollupDot` / `bandOfRollup` / `ROLLUP_DOT_COLOR` / `rollupLabel`
  //     are then the SAME four functions, unchanged, so this row lands in the same taxonomy as every
  //     other disc in the column.
  //
  // `researchRollupStatuses` deliberately feeds only the LIVE tasks — see its docstring: a failed
  // research task has no "read" gesture, so escalating it here would paint the row red forever after
  // the first failure. The failure is not hidden; it is one click away in the expanded list.
  //
  // NOT counted into `bandCounts`. The chips summarize the BUILD roster, and these are not build
  // rows; adding them would make "3 running" mean two different populations at once, which is the
  // one-signal-many-meanings failure recorded as sparkle-345q5.
  const researchById = useResearchStore((s) => s.byId);
  const researchHydrated = useResearchStore((s) => s.hydrated);
  // `liveTasks` from the store, NOT a local filter — the badge and the disc read the same selector,
  // so they cannot come to disagree about what "running" means.
  const conciergeLive = useMemo(() => liveTasks(Object.values(researchById)), [researchById]);
  const conciergeStatus: AgentTabStatus = "stopped";
  const conciergeRollup = rollupDot(conciergeStatus, researchRollupStatuses(conciergeLive));
  const conciergeRollupOverrides =
    bandOfRollup(conciergeRollup) !== bandOfStatus(conciergeStatus);

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
    const counts: Record<StatusBand, number> = { needs_you: 0, questions: 0, running: 0, done: 0 };
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

  // The active mode's create options (null in Plan / no project).
  // Rendered in ONE of two slots in the scroll container below, chosen by listOverflows.
  const newAgentButton =
    project && mode === "build" ? (
      // BOTH create options — "+ Local Agent" and "+ Cloud Agent" (see NewAgentButtons for why the
      // cloud row is always rendered rather than hidden when it can't be used). It expands to a
      // FRAGMENT, not a wrapper element: both placement slots are already flex columns and the
      // rows must stay THEIR direct children (the sticky/below-the-list placement is asserted on a
      // button's parent in AgentSidebar.newAgentPlacement.test.tsx).
      <NewAgentButtons onLocalClick={spawnBuildAgent} projectId={project.id} dataHint />
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
        style={{ width: SPACER_WIDTH, flex: "0 0 auto", height: "100%" }}
      />
    )}
    <div
      // The handle `measureGestureMax` reaches the CONTAINER through — see GESTURE_MAX. It reads
      // `parentElement` rather than taking a ref to the pair, because the parent IS the box the CSS
      // clamp resolves against, and asking the DOM for it cannot disagree with the stylesheet.
      ref={columnRef}
      data-testid="agent-sidebar-column"
      // ONE OF THE PAIR'S COLUMNS — so the project tab sitting above this column can find it and
      // paint its face in whatever plane this column is painted in. The tab reads THIS element's
      // background rather than naming `C.deepForest` itself, which is what stops the two drifting
      // apart when the column is restyled. See engine/pairColumns.
      {...{ [PAIR_COLUMN_ATTR]: "build" }}
      data-overlay={String(overlay)}
      // THIS BUILD COLUMN, for Cmd +/- — and PER SIDE, which is the whole point: the two builders
      // are independent, so zooming the left one must leave the right one alone. Routed through
      // `ZoomColumnOverride` so a torn-off satellite does not read (or advertise itself as) the
      // cockpit's right builder. Every row here is a `<button>`, which is exactly the case DOM focus
      // cannot answer in this webview — see services/columnFocusTracker.
      {...{ [ZOOM_COLUMN_ATTR]: zoomColumn }}
      data-covered={String(covered)}
      // THE HALF A DESCENDANT CANNOT UNDO — see the `covered` prop. React 19 renders this as the
      // real `inert` attribute; `false` omits it entirely.
      inert={covered}
      // The NUMBER, separate from the CSS `min()` in `width` — see RENDERED_WIDTH.
      data-width={String(width)}
      style={{
        // CSS-clamped against this column's own container, then divided by the zoom — see
        // RENDERED_WIDTH.
        width: RENDERED_WIDTH,
        // THIS COLUMN'S TEXT SIZE. `zoom` rather than `transform: scale()`: a transform paints at
        // the new size but lays out at the old one, so the column would visually overlap its
        // neighbours while the row still reserved the unscaled width, and every hit-test inside
        // would be offset from what the user sees. `zoom` participates in layout.
        zoom: columnZoom,
        flex: "0 0 auto",
        position: "relative",
        // COVERED BY THE PAIR'S PLAN BOARD — see the `covered` prop. Layout box kept, everything
        // inside it unreachable: no tab stop, no a11y announcement, no keyboard-hint chiclet, and
        // no click that lands on a control the user cannot see.
        ...(covered ? { visibility: "hidden" as const, pointerEvents: "none" as const } : null),
        // THE HALF OF THE CIRCUIT THAT WAS NEVER WIRED — and the reason the selected row read as
        // plugged in at the concierge end and dead flat at the terminal end.
        //
        // `layers.ts` has described this fix since the pair lift landed: the selected row bleeds out
        // of this column INTO the terminal pane, and that overhang plus its concave mouths are what
        // make the row read as an opening into the pane it selects. The terminal is LATER IN THE DOM
        // than this column, so at an equal stacking level the pane paints last and simply covers the
        // overhang. `paneVisibilityStyle` puts `TERMINAL_PANE_Z` (1) on the visible pane; this column
        // carried NO z-index at all, so it sat at `auto` and lost — every time.
        //
        // The constant existed, the ordering was even asserted, and nothing applied it: the guard
        // compared `BUILD_COLUMN_Z > TERMINAL_PANE_Z` as two numbers, which is true whether or not
        // either one reaches an element. So the mock's `.paircols .build{z-index:2}` was documented,
        // tested, and absent from the running app. The row test below asserts it on the DOM instead.
        //
        // NOT on the terminal stage, deliberately — see the note at `terminal-stage` in Workspace and
        // the `isolation: isolate` note in layers.ts: giving the STAGE a z-index makes it a stacking
        // context and caps the `position: fixed` surfaces rendered from inside panes, which exist to
        // cover the concierge column. The panes are already stacking contexts, so pinning them one
        // BELOW this column reproduces the mock's ordering without containing anything new.
        zIndex: BUILD_COLUMN_Z,
        background: C.deepForest,
        // NO BORDER IS DECLARED HERE AT ALL, AND THAT IS DELIBERATE — index.css owns both of this
        // column's edges (`border-inline: none`, then one border on the CONCIERGE side per pair,
        // turned transparent by `[data-wired]` when the cable is patched in). An inline declaration
        // outranks every selector, so a single `borderRight: "none"` here — which is what shipped —
        // silently deleted the whole mechanism for the LEFT pair, whose concierge edge IS its right:
        // no seam when unplugged, and nothing for the wired rule to erase when plugged in. It was
        // invisible for as long as the app had one pair, on the right, where the property it named
        // was the terminal edge and dropping it was correct.
        //
        // THE LINE IS GONE ON THE TERMINAL EDGE BECAUSE SOMETHING HAS TO FLOW THROUGH THAT SEAM.
        // The active agent row is painted in `forest`, the terminal's own colour, so it reads as an
        // opening INTO the pane it selects, and the concave fillets below shape that opening. A 1px
        // rule there cuts straight across it: the row docks against the line instead of bleeding
        // through, and the fillets curve into nothing. See the seam rule beside the plane tokens in
        // theme/colors — it is "does anything cross this boundary", not "how big is the step".
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
        display: "flex",
        flexDirection: "column",
        height: "100%",
        // OVERLAY MODE: the same element, lifted out of flow and laid over the terminal. Absolute
        // against the ②+③ wrapper, whose content box starts exactly where this column starts — so
        // anchoring it at the column's OWN edge reproduces the docked position with no measurement,
        // and the spacer below holds the slot so nothing beside it reflows.
        //
        // THE ANCHOR MIRRORS WITH THE PAIR, and it did not. `left: 0` was correct while the only
        // pair was the right one, where the build column is the first item in the row. A LEFT pair
        // lays its columns out `row-reverse`, so the build column sits at the RIGHT of the wrapper
        // and `left: 0` pinned the floating panel to the far side of the terminal — the column
        // visibly teleported across the row on toggle, taking its dock tab with it, several hundred
        // pixels from the spacer holding its slot. The mirrored chevron actively invited that by
        // telling a left-pair user the panel would come toward them (roborev 55337).
        ...(overlay
          ? {
              position: "absolute" as const,
              [pairSide === "right" ? "left" : "right"]: 0,
              top: 0,
              bottom: 0,
              height: "auto",
              width: OVERLAY_WIDTH,
              // See components/layers.ts: above the terminal stage AND above a column's Plan
              // board, which is now just what fills that terminal slot. Both sides of that
              // ordering live in that one module.
              zIndex: SIDEBAR_OVERLAY_Z,
              boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
            }
          : null),
      }}
    >
      {/* THE SEAM: this column's edge against the terminal stage. It is a 1px `hairline` rule and
          it is drawn HERE, as the column's first positioned child at the PANE-SIDE edge, rather
          than as a border on the column. The position is the whole point.

          ANCHORED TO `pairSide`, like the overlay above it and the pull-tab rail below it, and it
          was the one anchor in this column that never learned. `right: 0` was written when the app
          had a single pair, on the right, where right IS the terminal edge. `TERM │ BUILD │
          CONCIERGE │ BUILD │ TERM` — a LEFT pair's terminal is on the row's LEFT, so an unmirrored
          `right: 0` painted this rule on the CONCIERGE edge instead: a full-height hairline standing
          exactly where a mounted row runs THROUGH into the concierge, on the one boundary that is
          supposed to vanish when the cable is patched (`[data-wired]` in index.css turns the
          column's `border-inline` transparent there — and cannot touch an element inside it). The
          terminal edge it was meant to mark got nothing. Both halves of that are the same typo.

          A border sits OUTSIDE the padding box, so nothing inside the column can paint on
          it — the rule ran unbroken down the full height, including across the SELECTED row. That
          row is supposed to read as an opening onto the terminal: it fills with the terminal's own
          `C.forest`, squares its pane-side corners, bleeds `-LIST_PAD_X` to eat the list's padding
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
            • The pull-tab / overlay button cluster covers the seam for its own height. It is
              anchored to `[pairSide]: 0` too, so the two stay on the same edge in both pairs: it is
              a chrome shape with its own `hairline` outline sitting on the boundary, so the
              boundary is still drawn there — by the tab instead of by this rule. */}
      <div
        aria-hidden
        data-testid="sidebar-terminal-seam"
        style={{
          position: "absolute",
          top: 0,
          [pairSide]: 0,
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

          THE MOCK'S `.pm` IS BUILT — `PairCountControl` below, hover/focus-revealed beside the
          chips. It read "NOT BUILT… there is no second pair for it to create" for as long as the
          shell had one pair; the left pair closed MAPPING.md's gap #3, so the control adds and
          removes a pair rather than duplicating anything. */}
      {project && (
        <div
          data-testid="build-column-header"
          // THE REVEAL LIVES ON THE HEADER, not on the control it reveals. A `visibility: hidden`
          // box is not a hit-test target — the pointer passes straight through it, so `mouseenter`
          // never fires — and it is skipped by sequential focus navigation, so Tab cannot reach it
          // either. Wiring `onMouseEnter`/`onFocus` to the hidden element made BOTH reveal paths
          // dead: the control could never be summoned in a real browser, only in a test that
          // dispatches at the node and bypasses hit-testing entirely (roborev 55349).
          //
          // `ColumnPullTab` already documents this exact trap and solves it the same way: hover is
          // owned by the always-live rail, and only the descendant tab is hidden. React's focus
          // events bubble, so `onFocus` here also catches a Tab onto the button inside.
          onMouseEnter={() => setHeaderHover(true)}
          onMouseLeave={() => setHeaderHover(false)}
          onFocus={() => setHeaderHover(true)}
          onBlur={() => setHeaderHover(false)}
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
            // ABSENT, NEVER GREYED (design §7 rule 5 / ColumnPullTab.tsx:130). A project with no
            // dev server shows two segments, not three greyed ones.
            previewEnabled={previewable}
            onPickPreview={onPickPreview}
          />
          {/* Expand-all / collapse-all, where the `«` chevron used to sit. Hidden in Plan (no rows)
              and when NO head has workers — a control that would act on nothing is worse than none.
              Distinct from `PairCountControl` at the other end of the band: that one adds/removes a
              whole PAIR, this one only folds worker subtrees. */}
          {mode !== "plan" && subtreeHeadIds.length > 0 && (
            <SubtreeDisclosureControl
              headIds={subtreeHeadIds}
              allExpanded={allSubtreesExpanded}
              allCollapsed={allSubtreesCollapsed}
            />
          )}
          {/* `.bhd .sp` — the spacer that pushes the chips to the pane-side end. It is the SOLE
              consumer of the band's free space, which is why the bar beside it grows 0; if the bar
              grew too they would split it and the chips would sit mid-header. */}
          <span aria-hidden data-testid="build-header-spacer" style={{ flex: 1, minWidth: 0 }} />
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
          <PairCountControl projectId={project.id} pairSide={pairSide} shown={headerHover} />
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
        // `overflowX: "hidden"` is LOAD-BEARING, not tidiness (roborev 58758). A row's name now has
        // a hard `AGENT_NAME_MIN_WIDTH_PX` floor and its chips are `flex: 0 0 auto`, so at a column
        // dragged near `BUILD_COLUMN_MIN_WIDTH` the row is genuinely wider than this container —
        // and `overflow-y: auto` with `overflow-x: visible` computes the other axis to `auto`, so
        // the whole list would gain a horizontal scrollbar and slide sideways. Clipping is the
        // degradation we want: the name ellipsizes, the tail is cut, the column never scrolls.
        style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: `0 ${LIST_PAD_X}px` }}
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
        {/* CHAT — a fixed block at the TOP of the list, above the first stage header, which is what
            the founder's "above the Local Nothing Yet row" looks like on his screen. Deliberately
            NOT anchored to that header: `groupAgentsByStage` drops empty sections, so `local_none`
            comes and goes with git state and Chat's position would come and go with it.

            It renders even with ZERO people — its `[+]` is the only way to add the first one.
            Primary pair only (the same "there is exactly one of these" rule `uiStore` names for
            SPARKLE_PANE_SIDE) and never in Plan, whose sidebar list stays clear. Everything else
            about it lives in ChatSection.tsx; this is the one line AgentSidebar owns. */}
        {pairSide === SPARKLE_PANE_SIDE && mode !== "plan" && (
          <ChatSection pairSide={pairSide} jointOpen={jointOpen} />
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
              // `statusInk`, not a hand-rolled done→agentIdle branch. That branch was a copy of
              // statusInk's FIRST case and stopped there, so a worker row's name — which is an
              // underlined-on-hover LINK (WorkerRow below) — was painted with the raw brand green
              // at 2.22:1 and the raw brand red at 3.83:1 on light's white column.
              const wcolor = statusInk(AGENT_STATUS[wst].color);
              return {
                id: w.id,
                name: w.name,
                autoTitle: w.autoNameVariants?.title?.trim() || null,
                description: w.autoNameVariants?.description?.trim() || "",
                stage: stageOf(w.id) as WorkflowStageId | null,
                // The worker's OWN rung, so its card line cannot claim unsaved work it does not have
                // (roborev 57902). Computed here rather than in the renderer because both inputs are
                // already in hand at this site — the head row's `rowSection` describes the HEAD, and
                // handing that to a worker would be a different wrong answer.
                section: sectionOfRow(
                  stageOf(w.id) as WorkflowStageId,
                  uncommittedWorkEvidence(branchStatus[w.id]),
                ),
                status: wst,
                statusColor: wcolor,
                branchStatus: branchStatus[w.id],
                shipped: shippedOf(w.id),
                worktreePath: w.worktreePath,
                baseBranch: w.baseBranch,
                active: !paneCoversMe && project.selectedAgentId === w.id,
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
          // The TRUE (pre-dismissal) status, read from the ESCALATED map rather than the raw one.
          //
          // It fed `alertControlKind` and `dismissAlert` from `status` before, which silently made a
          // stall escalation unacknowledgeable: the row rendered red from `effectiveStatus` while this
          // line still said `idle`, so `alertControlKind` returned null, no Dismiss control appeared,
          // and no `blocked` episode was ever recorded — a permanent red with no way to calm it, which
          // is exactly what forced the 2026-07-26 rollback of the last red `unmerged` (roborev 55318).
          // Every other row is unaffected: the escalated map differs from the raw one only where a
          // resting row was relabelled `unmerged` or escalated.
          const trueSt = escalatedStatus[a.id] ?? "stopped";
          // Resolve the status color to a light-mode-legible TEXT ink: the brand gray (idle,
          // blocked, done, stopped) and the brand green (working) are too light on the white
          // light sidebar, so statusInk darkens both in light mode while keeping them brand-color
          // in dark; red/amber pass through. (See statusInk — it tracks the AGENT_STATUS taxonomy.)
          const color = statusInk(AGENT_STATUS[st].color);
          // The alert toggle to show on this row's expanded card: "dismiss" when it's truly red and
          // not yet dismissed, "reenable" when red-underneath but dismissed, null otherwise.
          const alertControl = alertControlKind(a.alert, trueSt);
          const isActive = !paneCoversMe && project.selectedAgentId === a.id;
          // SELECTION, PLAIN — distinct from `isActive`, which ANDs in `paneCoversMe` (a floating
          // pane laid over this column makes a still-selected row read inactive). The click-again
          // fold has to key off "is this the row I am already on", and that is the selection alone:
          // gating it on `isActive` made the fold dead whenever a pane covered the column.
          const isSelected = project.selectedAgentId === a.id;
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
              isSelected={isSelected}
              st={st}
              calmSt={calmStatus[a.id] ?? "stopped"}
              statusColor={color}
              isTabStop={a.id === tabStopId}
              dotColor={rollupOverrides ? ROLLUP_DOT_COLOR[rollup] : undefined}
              dotLabel={rollupOverrides ? rollupLabel(rollup) : undefined}
              // A BORROWED RED IS DRAWN AS A RING, an own red as a fill. `rollupOverrides` already
              // means "this disc is reporting the SUBTREE, not this row", so a red/orange under it
              // is by construction a worker's, never the head's own — own-red short-circuits
              // `rollupDot` before any worker is counted, which makes the bands agree and the
              // override never fire. So no new state is consulted: this reads the same truth the
              // color and the tooltip already read. See StatusDot's `variant`.
              dotRing={rollupOverrides && (rollup === "red" || rollup === "orange")}
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
              paneSide={pairSide}
              jointOpen={jointOpen}
              columnWidth={columnWidth}
              onDragStartAgent={onAgentDragStart}
              onDragEndAgent={onAgentDragEnd}
              onDropAgent={onAgentDrop}
              editing={editing === a.id}
              receiptVersion={receiptVersion}
              setEditing={setEditing}
              onSelect={() => onSelect(a.id)}
              onMount={() => onMount(a.id)}
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
            // THE PEEK. A CLOSED head with a worker asking for you shows ONE inset line naming it.
            // Read only when the head is closed: opening it renders the real child rows, and both at
            // once would say the same thing twice. Empty for a green/gray subtree, so a settled
            // fleet stays exactly as compact as it is today.
            //
            // ONE STATUS EXPRESSION, TWO CONSUMERS. `peekStatusOf` is what SELECTS the peek's
            // workers and what PAINTS them, named once rather than written twice — the peek and the
            // worker's own row disagreed for exactly as long as they derived a worker's attention
            // separately (see WorkerPeek's header, and workerPeekRowAgreement.test.tsx). It is the
            // same `effectiveStatus[id] ?? "stopped"` the row above reads into `st`, so a worker's
            // dot means the same thing folded and unfolded.
            const peekStatusOf = (id: string): AgentTabStatus => effectiveStatus[id] ?? "stopped";
            const peek = collapsed.has(top.id)
              ? attentionWorkersOf(
                  project?.agents ?? [],
                  top.id,
                  peekStatusOf,
                  (id) => liveStatus[id] !== undefined,
                )
              : [];
            return (
              // A FRAGMENT, not a wrapper div. An anonymous div here would sit between the section's
              // `group` and its `treeitem`s, so the group would own generic content — the same "a
              // tree may own only treeitems and groups" rule this structure exists to satisfy, one
              // level down (roborev 53891).
              <Fragment key={top.id}>
                {renderRow(top, headStage, section.id)}
                {peek.length > 0 && (
                  <WorkerPeek
                    workers={peek}
                    statusOf={peekStatusOf}
                    headName={top.name}
                    onOpen={() => toggleOrchestratorCollapsed(top.id)}
                  />
                )}
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
                // accentInk, not BRAND.accent — a link, not a fill. The constant cyan reads at
                // 1.6:1 on light mode's white column; see the ink/fill split in colors.ts.
                color: C.accentInk,
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              Show all
            </button>
          </div>
        )}
        {/* Empty hint: the dashed create rows above are the call to action. */}
        {project && mode === "build" && topLevelAgents.length === 0 && (
          <div style={{ color: C.muted, fontSize: 12, padding: "2px 10px 10px", lineHeight: 1.5 }}>
            No Build agents yet — use <strong>+ Local Agent</strong> or <strong>+ Cloud Agent</strong> above to start one.
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
      {/* CONCIERGE AGENTS — one pinned row DIRECTLY ABOVE Improve Sparkle, holding the research
          tasks the concierge has dispatched (bead sparkle-s7rfc). Founder: "a row right above
          improved sparkle called 'Concierge Agents'. it's just one row, like a build orchestrator
          with '+[n]' showing how many agents are running."

          ALWAYS PRESENT — but "always" means once per WINDOW, not once per sidebar. A row that
          appeared only when work existed would leave the founder with nowhere to look for work he
          had just asked for and no way to learn the surface exists; the `+0` it renders instead is
          a real answer, which is why `hydrated` is passed separately from the count.

          IT IS GATED ON `showConciergeRow` — its OWN flag; see that prop's doc for why reusing
          `showSparkleRow` was tried and abandoned. What the two flags share is the structural
          reason a gate is needed at all: `AgentSidebar` mounts TWICE when two pairs are open
          (Workspace.tsx, left and right), and a duplicated pinned row is a founder-reported bug —
          bead `sparkle-x0pvw`, which is what put the Improve Sparkle row behind a flag in the first
          place. Shipping this one unconditionally rebuilt that bug one row higher: two rows, both
          polling `refreshResearch()`, a duplicated DOM id whose `aria-controls` resolved to the
          wrong column's subtree, and — because `openTaskId` lives in the shared store while
          `expanded` is local — opening a task in the right column silently opened it in the left
          (roborev 61699). `Workspace.tsx` is what passes `false` to all but one sidebar, and
          `Workspace.sparkleRowOneColumn.test.tsx` is what pins that wiring. */}
      {showConciergeRow && (
        <ConciergeAgentsRow
          status={conciergeStatus}
          dotColor={conciergeRollupOverrides ? ROLLUP_DOT_COLOR[conciergeRollup] : undefined}
          dotLabel={conciergeRollupOverrides ? rollupLabel(conciergeRollup) : undefined}
          // Same borrowed-red-draws-a-ring rule as the ordinary head row (roborev 63126). These two
          // pinned rows sit at the bottom of the column permanently, so a borrowed red that looked
          // like an own red was MORE persistent here, not less.
          dotRing={
            conciergeRollupOverrides &&
            (conciergeRollup === "red" || conciergeRollup === "orange")
          }
          liveCount={conciergeLive.length}
          hydrated={researchHydrated}
          paneSide={pairSide}
          jointOpen={jointOpen}
        />
      )}

      {showSparkleRow && (
        <SparkleAgentRow
          // Scoped, like every other read of this flag in the column: the row may only claim to be
          // active where the pane it stands for actually mounts. `activeSpecial` is `"sparkle" | null`,
          // so this is the same test, asked per column.
          active={paneCoversMe}
          status={sparkleStatus}
          dotColor={sparkleRollupOverrides ? ROLLUP_DOT_COLOR[sparkleRollup] : undefined}
          dotLabel={sparkleRollupOverrides ? rollupLabel(sparkleRollup) : undefined}
          dotRing={
            sparkleRollupOverrides && (sparkleRollup === "red" || sparkleRollup === "orange")
          }
          workerCount={sparkleWorkerCount}
          onSelect={onSelectSparkle}
          paneSide={pairSide}
          jointOpen={jointOpen}
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

      {/* THE RETIREMENT CONFIRM (bead sparkle-0l9xk) — a landed build agent leaving the build list.
          MOUNTED BY THE COLUMN, not by the row, for the same reason as the promote/demote dialogs
          below: `AgentRow` is memoized and can unmount under an open dialog (a section fold, a
          band chip, a project switch), and a half-made decision about removing a row must not
          vanish with the row it is about. */}
      {retiringAgent && (
        <RetireAgentConfirm
          agentName={retiringAgent.name || "this agent"}
          receipt={project ? cachedReceipt(project.id, retiringAgent.id) : undefined}
          // The SECOND source — the same `agent:<id>` beads the row's own FEEDBACK pill counts, so
          // the dialog and the row can no longer contradict each other (bead `sparkle-y2p4f`).
          // Read fresh from the store like the branch fields below, not from the render-scope maps.
          // With no project we cannot look at all, which is `unknown` — never "reported nothing".
          feedback={
            project
              ? feedbackEvidenceFor(project.id, retiringAgent.id)
              : ({ kind: "unknown" } as const)
          }
          // FRESH from the store, not from the render-scope maps: this dialog can sit open while the
          // 15s poll updates the tree underneath it, and the files it names are the ones retirement
          // would destroy (knightwatch probe 1).
          dirtyFiles={useRuntimeStore.getState().branchStatus[retiringAgent.id]?.dirtyFiles}
          // The raw safety field AND the true total, alongside the capped preview — the dialog gates
          // on `dirty` and renders "+N more" from `dirtyCount` (roborev 59423).
          dirty={useRuntimeStore.getState().branchStatus[retiringAgent.id]?.dirty}
          dirtyCount={useRuntimeStore.getState().branchStatus[retiringAgent.id]?.dirtyCount}
          canAnswer={canAnswerRetroPing(
            status[retiringAgent.id],
            Boolean(quotaBlockForAgent(retiringAgent.id, Date.now())),
          )}
          // `shown` is what the dialog DISPLAYED. `confirmRetire` re-reads the standing (the modal
          // can sit open across polls) and may only ever narrow it from here — see its own note.
          onRetire={(shown) => {
            const id = retiringAgent.id;
            setRetireConfirmId(null);
            void confirmRetire(id, shown);
          }}
          onCancel={() => setRetireConfirmId(null)}
        />
      )}

      {/* "Move to cloud" — the promotion confirm surface (bead sparkle-8zpvc).
          MOUNTED BY THE COLUMN, not by the row that opened it: `AgentRow` is memoized and can
          unmount under the dialog (a section fold, a status-band chip, a project switch), and a
          half-made decision about moving work off this machine must not vanish with its row.
          Gated on the agent belonging to THIS column's project, so the two sidebars in a pair can
          never both put one up for the same id. */}
      {promoteAgent && promoteDeps && (
        <PromoteToCloudDialog
          agent={promoteAgent}
          deps={promoteDeps}
          onClose={closePromoteToCloud}
        />
      )}

      {/* "Bring down to local" — the demotion confirm surface (plan §W4). Mounted by the COLUMN for
          the same reason its sibling above is: a half-made decision about shutting down a running
          sandbox must not vanish when a memoized row unmounts underneath it. */}
      {demoteAgent && demoteDeps && (
        <DemoteToLocalDialog
          agent={demoteAgent}
          deps={demoteDeps}
          onClose={closeDemoteToLocal}
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
              fontFamily: FONT_UI,
            }}
          >
            Got it
          </button>
        </ModalShell>
      )}

      {/* ── ONE TAB, AT THE TOP OF THE BOUNDARY ──────────────────────────────────────────────
          This replaces THREE controls that used to live on this edge: a full-height 6px
          `col-resize` strip, a 4×28 grey grip floating at mid-height as its only signage, and a
          separate `»` chevron button in a rounded box below that grip. The founder's read was that
          the mid-height pair is redundant now that the hover affordance lives at the TOP of a
          boundary — and that they were visual noise on the shell's most prominent seam.

          So the agent-column boundary finally takes the same `ColumnPullTab` the concierge seam has
          had, carrying BOTH gestures in two zones:

            ›   the chevron zone — OVERLAY. Put this column OVER the terminal instead of sharing
                width with it. This matters MORE at five columns, not less: when there is no width
                left to redistribute, overlay is how a column gets real space without starving a
                neighbour.
            ⣿   the dot zone      — RESIZE. Drag to move the boundary; arrows nudge it.

          That closes the handoff `ColumnPullTab`'s own header has described since it shipped — it
          said the shell mounted only one, on the concierge seam, and that `grows: "right"` had no
          production caller. It has one now: the LEFT pair, whose terminal is on the row's left, so
          its boundary and its drag direction both mirror.

          ANCHORED TO THE PANE-SIDE EDGE, which is `pairSide`. `TERM │ BUILD │ CONCIERGE │ BUILD │
          TERM` — the terminal is to the row's right in the right pair and to its left in the left
          one, so the boundary this tab owns flips with the pair exactly as the row geometry does.

          Suppressed while OVERLAID for the resize half only — the component already handles that
          (its dots become a "dock me" button), so the round trip out and back rides on the panel
          itself and the overlay can never hide its own way out. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          [pairSide]: 0,
          width: 6,
          display: "flex",
          // The rail inside is a flex item; `stretch` is what gives it the column's full height
          // without this wrapper having to know one.
          alignItems: "stretch",
        }}
      >
        <ColumnPullTab
          // PAINTED, not stored — see RENDERED_TAB_WIDTH.
          width={RENDERED_TAB_WIDTH}
          onWidth={commitWidth}
          min={MIN_WIDTH}
          // The WINDOW ceiling only. The container's is `maxAt`'s job and is intersected with this
          // one per gesture — deliberately not folded in here, because a render-time copy of it can
          // go stale in the direction that destroys a width (see the note above `measureGestureMax`).
          max={MAX_WIDTH}
          maxAt={measureGestureMax}
          label="agent column"
          overlaid={overlay}
          onOverlayToggle={toggleOverlay}
          // `grows` names where the OWNED column sits relative to the boundary, which is the
          // opposite of the side the terminal is on: in the right pair build is left of the seam
          // (drag right to grow it), in the left pair it is right of it (drag left to grow it).
          grows={pairSide === "right" ? "left" : "right"}
          cssVar={buildWidthVar(pairSide)}
          testId="sidebar-pull-tab"
        />
      </div>
    </div>
    </SidebarScrollContext.Provider>
  );
}

// The row anatomy every row in this column shares — the numbers (`ROW_PAD_Y`, `DOT_SLOT_W`,
// `DOT_SIZE`, `GLYPH_SLOT_H`, `DEPTH_INDENT`, `ACTIVE_FILLET*`) live in `engine/rowGeometry`
// beside the `rowBox` rule that consumes them, and the React half (`rowBoxFor`, `ActiveFillets`)
// in `./rowAnatomy`. Both are imported at the top of this file. They moved out so a row type in
// its OWN file — `PersonRow` — can honour the same anatomy; see rowAnatomy.tsx's header.

// The row's ticking clock (`useRowClock`), its two presentational leaves (`ElapsedTimer`,
// `ROLLUP_DOT_COLOR`) and the `formatElapsed` re-export now live in `./rowClock`. `useRowClock` is
// consumed by BOTH AgentRow and SparkleAgentRow, so it could not sit inside either.
//
// `formatElapsed` itself LIVES in `engine/elapsed`, so the concierge's RESOLVED nudge card can
// spell a duration the same way this row does without importing a 3,300-line component. It is
// re-exported rather than relocated outright because this is the import path every existing caller
// and `AgentSidebar.elapsedTimer.test` already names; `useRowClock` likewise, for
// `AgentSidebar.rowClock.test`.
//
// Imported at the top of the file AND re-exported here, not `export { … } from "…"`: the bare
// re-export form creates no LOCAL binding, so the row's own call sites below would have stopped
// resolving — a compile error, but only for this file, which is the sort of thing a re-export looks
// like it handles and does not.
export { formatElapsed, useRowClock };

// The row's two column-width thresholds and their pure predicates now live in
// `./rowWidthThresholds` (they have three consumers, only one of which is this file). Re-exported
// on the same terms as `formatElapsed` above — imported at the top so the call sites below still
// resolve, and re-exported here because `AgentSidebar.rowNotices.test.tsx` names this import path.
export {
  STAGE_CHIP_MIN_COLUMN_PX,
  stageChipShows,
  NOTICE_CLUSTER_MIN_COLUMN_PX,
  noticeClusterCollapses,
};

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

