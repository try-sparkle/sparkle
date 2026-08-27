import {
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useContext,
  memo,
  type DragEvent as ReactDragEvent,
} from "react";
import { createPortal } from "react-dom";
// FiAlertTriangle/FiRepeat carry the never-idle overlay (stall / thrash) — see ./rowAttention and
// the chips below. The goal chip's and notice marks' own glyph tables moved to
// ./rowAttentionChrome and took their icons with them. Icons, never emoji: this repo uses
// react-icons.
import {
  FiArchive,
  FiCloud,
  FiHelpCircle,
  FiAlertTriangle,
  FiRepeat,
  FiDownloadCloud,
  FiUploadCloud,
  FiMoreHorizontal,
  FiMessageSquare,
  FiMonitor,
} from "react-icons/fi";
import { C, AGENT_STATUS, FONT_WEIGHT } from "../theme/colors";
import { FONT_MONO, FONT_UI, RADIUS, TYPE } from "../theme/scale";
import { anchoredScrollTop } from "./anchoredScroll";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useInteractionStore } from "../stores/interactionStore";
import { useCableStore } from "../stores/cableStore";
import { mountsOnRowActivation } from "../engine/cable";
import { useCloudAgentsEnabled } from "../hooks/useCloudAgents";
import { usePreviewStore } from "../stores/previewStore";
import { openPreviewServer, PREVIEW_ALREADY_STARTING } from "../services/preview";
import { refreshAgentBranch } from "../services/branchStatus";
import { cachedReceipt } from "../services/retroReceipts";
import { retirementPill } from "../engine/retirementReadiness";
import { askFor, FOUNDER_ASK_LABEL, FOUNDER_ASK_DETAIL } from "../engine/founderAsk";
import { applyModelToRunningAgent } from "../services/agentModel";
import {
  DEPTH_INDENT,
  DOT_SIZE,
  DOT_SLOT_W,
  GLYPH_SLOT_H,
  LIST_PAD_X,
  ROW_PAD_Y,
} from "../engine/rowGeometry";
import { ActiveFillets, rowBoxFor } from "./rowAnatomy";
import { HINT_JUMP_ATTR } from "../keyboardHints/hintTargets";
import { isStalled, stallReport } from "../engine/agentStall";
import { formatActivityAge, isActivityStale } from "../engine/activityFreshness";
import { thrashReportFor } from "../engine/agentThrash";
import { quotaBlockForAgent } from "../engine/engineRegistry";
import { humanBlockIn, loginStanddownIn } from "../services/humanBlockFor";
import { useNudgeFlagSnapshot } from "../useNudgeFlags";
import { hasUnmetGoal } from "../engine/agentGoal";
import { stageFraction } from "../engine/workflowStage";
import {
  goalBadgeFor,
  stallChipFor,
  stallInputsFor,
  thrashChipLabel,
} from "./rowAttention";
import { awaitingCloseEvidenceFor } from "../services/agentGoalReading";
import { agentNotices, rowGlyphsFor, withoutSeparatelyDrawn } from "./agentNotices";
import { AgentInboxBadge } from "./AgentInboxBadge";
import { AlertToggleButton } from "./AlertToggleButton";
import { StatusDot } from "./StatusDot";
import { ModelPill } from "./ModelPill";
import { RowContextMenu } from "./RowContextMenu";
import { WorkflowLine } from "./WorkflowLine";
import {
  FittedAgentName,
  agentNameFloorFor,
  rowTitleWeight,
} from "./FittedAgentName";
import { subtreeDomId } from "./subtreeDomId";
import { SidebarScrollContext } from "./sidebarScrollContext";
import { agentRowPropsEqual, type AgentRowProps } from "./agentRowTypes";
import { WorkerNameButton, representativeWorker } from "./workerDetail";
import { useRowClock, ElapsedTimer } from "./rowClock";
import { stageChipShows, noticeClusterCollapses } from "./rowWidthThresholds";
import { StageChip } from "./StageChip";
import { AgentDetailLines } from "./AgentDetailLines";
import { DetailLine, CloseAgentButton } from "./rowCardPrimitives";
import {
  GOAL_CHIP_ICON,
  GOAL_CHIP_COLOR,
  GOAL_CHIP_SIZE,
  GOAL_CHIP_A11Y,
  NOTICE_GLYPH_ICON,
  RETIRE_COPY,
} from "./rowAttentionChrome";

/**
 * One agent row. Collapsed (default) it shows: the kind glyph, the status dot, the width-fitted
 * name, a behind/ahead pill, and a thin progress line across the bottom. On hover the row "slides
 * out" to the right OVER the terminal (a fixed-position overlay, not a modal), revealing the full
 * name, the working-directory path, and the progress line's status label. The build glyph sits left
 * of the dot, the dot left of the name (per spec). An orchestrator row additionally renders its
 * `workers` inline: a bare indented progress line each (collapsed) and a stacked detail block each
 * (expanded), so the whole build reads as one card and selecting any part opens the orchestrator.
 */
/**
 * WHAT COUNTS AS "A CONTROL, NOT THE ROW" for the double-click mount (`onRowDoubleClick`).
 *
 * The row mounts the concierge on a double press, and every chip on it stops its own CLICK — which
 * does nothing to `dblclick`. This is the one place that decides which presses belong to a chip
 * rather than to the row; see `onRowDoubleClick` for the failure it repairs (roborev 63145).
 *
 * ══ THREE OF THE FIVE CHIPS ROBOREV NAMED NEED NOTHING HERE, AND THE REASON IS WORTH KEEPING ═════
 * The finding lists five leaking controls: the notice mark, the founder-ask chip, the retire pill,
 * the epic pill and the feedback pill. Only the ones that are still on screen when the `dblclick`
 * arrives can actually leak, and three of them are not:
 *
 *   • the EPIC pill and the FEEDBACK pill both call `openPlanBoard` on their first click, which
 *     replaces this whole build column with the Plan board. The row is UNMOUNTED before the second
 *     click, let alone the `dblclick` — measured, not reasoned: a probe that clicks the feedback
 *     pill once finds no `[data-hint="agent"]` left in the document and the side's work mode
 *     already flipped to `plan`.
 *   • the retire PILL lives on the hover card, which is `createPortal`'d as a SIBLING of the row
 *     element rather than a child of it — so a press there is outside the row's React subtree and
 *     never reaches this handler at all. (The retire MARK, its collapsed-row twin, is inside the
 *     row and does leak. That pair is the whole distinction.)
 *
 * They were marked with a `data-row-control` attribute first, and every one of those markers stayed
 * GREEN under `mutation-check` — no test could make them matter, because no gesture can reach them.
 * Marking them anyway would have been three lines of defence against a press that cannot happen,
 * carrying the false implication that a chip is safe BECAUSE it is marked. What actually protects a
 * chip is one of the three facts above, and a future chip gets none of them for free.
 *
 * ══ SO WHAT REMAINS IS THE INTERACTIVE-ROLE TEST ════════════════════════════════════════════════
 * The controls that both stay mounted and sit inside the row — the retire mark, the founder-ask
 * chip, the notice marks, the goal chip, the close button, the rename input — all carry a real
 * interactive role or tag (the role + tabIndex + key-handler trio came from roborev 59545/59322).
 * A NEW chip that stays on the row must carry one too, which is the same bar a11y already sets.
 *
 * ══ SO THE LIST IS THE INTERACTIVE ROLES, NOT JUST `button` ═════════════════════════════════════
 * It recognised `role="button"` alone, which made the doc above a promise the code did not keep
 * (roborev 63236): a chip marked `role="link"`, `"switch"`, `"checkbox"`, `"menuitem"`, `"tab"`,
 * `"radio"` or `"combobox"` clears the stated bar and the a11y bar, and still leaked the mount —
 * and the symptom is the quiet one, a cable moving with no error anywhere.
 *
 * `tabindex` is deliberately NOT here. The row itself carries `tabIndex` (roving, :2443), so a
 * selector matching it would make every press look like a press on a control and disable mounting
 * outright. The `hit !== currentTarget` bound at the call site is what keeps this list safe to
 * grow; read that comment before adding anything the row itself could match.
 */
export const ROW_CONTROL_SELECTOR =
  '[role="button"],[role="link"],[role="switch"],[role="checkbox"],[role="menuitem"],' +
  '[role="tab"],[role="radio"],[role="combobox"],button,input,select,textarea,a[href]';

/**
 * How long a fold waits to see whether it is really half of a MOUNT (roborev 63145, finding 3).
 *
 * The row's fold rule ("click a row you are already on to fold its workers") and the mount rule
 * ("double click to patch the cable") are keyed on different events — `click` and `dblclick` — and
 * that is exactly why they were believed not to collide. They collide anyway, because ONE gesture
 * raises BOTH: a double press on an orchestrator you are already on folds on its FIRST click and
 * mounts on the `dblclick`, so the cable could not be patched onto an orchestrator without
 * restructuring its subtree, persistently, every time.
 *
 * ══ WHY A TIMER AND NOT JUST `e.detail >= 2` ═══════════════════════════════════════════════════
 * Because the click that folds is the FIRST one, and at the moment it arrives nothing distinguishes
 * it from a plain single click — `detail` is 1 for both, and no second press has happened yet. The
 * count test does close the other half (an UNSELECTED orchestrator, where the fold would land on
 * click two), and it is kept for that: it means no timer is armed on a press we already know is a
 * double. But the already-selected case — the common one, since you click a row to read it before
 * you double-click it to talk to it — is only reachable by waiting.
 *
 * ══ THE VALUE, AND WHAT A WRONG ONE COSTS ══════════════════════════════════════════════════════
 * The browser exposes no way to READ the OS double-click interval, so this is a guess at it. Both
 * directions of being wrong are bounded and neither is new behaviour:
 *   • too SHORT (a user whose interval is longer): the fold lands, then the mount does — i.e. the
 *     pre-fix behaviour, for that user, on that gesture. Nothing is broken that was not already.
 *   • too LONG: a deliberate fold visibly lags. This is the cost that lands on the common gesture,
 *     which is why it is not simply set to a safe 600ms.
 * 350ms sits under the macOS default and above a brisk deliberate double press. The fold is a
 * layout change rather than an answer to typing, so the delay reads as deliberation, not lag.
 */
export const FOLD_DOUBLE_PRESS_GRACE_MS = 350;

/** How far in from the row's left edge a KEYBOARD-raised context menu opens (Shift+F10 / the Menu
 *  key carry no cursor). Flush with the edge reads as a menu belonging to the column, not the row. */
const KEY_MENU_INSET = 12;

export const AgentRow = memo(function AgentRow({
  project,
  a,
  depth,
  isActive,
  isSelected,
  st,
  calmSt,
  subtreeCollapsed,
  onToggleSubtree,
  statusColor,
  isTabStop,
  dotColor,
  dotLabel,
  dotRing,
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
  paneSide,
  jointOpen,
  columnWidth,
  onDragStartAgent,
  onDragEndAgent,
  onDropAgent,
  editing,
  beadFacts,
  setEditing,
  onSelect,
  onMount,
  onLand,
  onClose,
}: AgentRowProps) {
  const renameAgent = useProjectStore((s) => s.renameAgent);
  const setAgentModel = useProjectStore((s) => s.setAgentModel);
  const pollBranchStatus = useRuntimeStore((s) => s.pollBranchStatus);
  // ── THE BEADS-STORE FACTS ARRIVE AS A PROP; THIS ROW DOES NOT SUBSCRIBE (bead sparkle-nkoxqs) ──
  //
  // All four used to be derived HERE, off two of this row's own `useBeadsStore` selectors:
  // `beadLabel(beads, a.beadId)`, `epicForBuild(beads, project.agents, a.id)`,
  // `epicPillFor(a, board, project.agents)` and `countAgentFeedbackBeads(beads, a.id)`. Each is a
  // full-store scan, and `epicPillFor` additionally allocated a fresh 4-way concatenation of the
  // whole board — so the founder's ~60 rows against a ~7,400-bead store cost 60 full scans and 60
  // whole-board allocations for every single store notification, on the main thread.
  //
  // The selectors were also WHY this row's `React.memo` could not help: they reach past
  // `agentRowPropsEqual` straight into the store, and zustand notifies on identity, so a poll that
  // minted a new `beads` array re-ran this entire body no matter what the comparator said. Reading
  // them as a prop puts them back under the comparator (`engine/agentBeadFacts` keeps an entry's
  // identity stable while its facts are unchanged), and `components/AgentSidebar` derives all of
  // them for the whole fleet in ONE indexed pass. The `kind` gating that used to sit on these lines
  // moved there with them — a worker row's `epicPill` is null because it is a worker, exactly as
  // before.
  //
  // The FEEDBACK count still comes from `engine/retroEvidence`'s one predicate, shared with the
  // retire dialog (bead `sparkle-y2p4f`): two surfaces disagreeing about that number is the defect
  // that module exists to remove, and hoisting the call did not fork it. The epic pill itself is
  // unchanged: it still prefers the agent's own `epicId` (set at sendToBuild handoff, so it shows
  // before any worker binds a bead), and clicking it still jumps to the Plan board via the
  // `boardFocusBeadId` handoff below.
  const { beadHover, epicHover, epicPill: epicPillData, feedbackCount } = beadFacts;

  const rowRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);
  // A fold waiting out FOLD_DOUBLE_PRESS_GRACE_MS to see whether a `dblclick` follows it.
  const foldTimer = useRef<number | null>(null);
  // Set true the instant Escape is pressed so the input's trailing blur (which fires when the field
  // unmounts in this Chromium webview) discards instead of committing — Escape must always cancel.
  const cancelNextBlur = useRef(false);
  const [hover, setHover] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  // Where this row's context menu is anchored, or null when it is closed. Viewport coordinates —
  // the menu is portalled to `document.body` and positioned `fixed`. See `openRowMenu`.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  // The list's auto-scroll coordinator (see SidebarScrollContext): lets this row nudge the column up
  // so its full hover card fits, then ease back when the cursor leaves.
  // Subscribed HERE rather than threaded down as a prop: AgentRow is memoized, and a per-agent
  // boolean read through a selector re-renders only the row it changed for. Narrowed to a boolean so
  // an unrelated write to the map can't invalidate every row.
  const unjudgedAsk = useRuntimeStore((s) => s.unjudgedAsk[a.id] !== undefined);
  // May the "Move to cloud" item be OFFERED at all? Subscribed here (not threaded down) for the
  // same reason as `unjudgedAsk` above: it is a boolean read through a selector, so a change
  // re-renders the rows rather than the column. This is `cloudOptionVisible` — SIGNED IN, and
  // nothing else — exactly what the creation flow gates its Cloud option on.
  const cloudOfferable = useCloudAgentsEnabled();
  // The preview affordances, read HERE for the same reason as `cloudOfferable` above: booleans
  // through a selector re-render the rows that changed, not the column.
  const previewOfferable = usePreviewStore((s) => s.capability[project.id]?.previewable === true);
  const setPreviewEntry = usePreviewStore((s) => s.setPreview);
  // The AMBIENT pill's two inputs. THIS agent's entry only — `byAgent[a.id]` is a stable reference
  // between writes (`setPreview` bails on an unchanged update), so subscribing to the entry rather
  // than to the map keeps a preview tick on one agent from re-rendering every other row.
  const previewEntry = usePreviewStore((s) => s.byAgent[a.id]);
  const openPromoteToCloud = useUiStore((s) => s.openPromoteToCloud);
  // The OTHER direction. Deliberately NOT gated on `cloudOfferable` (see the button below).
  const openDemoteToLocal = useUiStore((s) => s.openDemoteToLocal);
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
  //
  // ── AND WHEN THE REQUEST CARRIES A CURSOR, LAND AT THE CURSOR ─────────────────────────────────
  // `block: "nearest"` answers "is it on screen", which is the wrong question for a click. The
  // reader's eye is at the pointer, and the builder column runs well past a screenful, so a row
  // that arrives correctly-but-elsewhere still has to be hunted for. When the reveal carries an
  // anchor (`revealAnchorY` — the click's own viewport Y), the row is brought to it instead, with
  // the arithmetic in components/anchoredScroll: clamped at both ends of the range, and declining
  // to move at all when the row already sits at roughly that height.
  //
  // Falls back to `scrollIntoView` whenever there is no anchor (a spawn, a concierge tool call, a
  // keyboard activation) — those have no cursor behind them, and inventing one would scroll the
  // column to a place nobody was looking.
  //
  // ── SUBSCRIBED AS A BOOLEAN, FOR THE REASON `unjudgedAsk` ABOVE IS ──────────────────────────────
  // These were `useUiStore((s) => s.revealAgentId)` and `…revealAnchorY` — two SCALARS, read by
  // every row. A scalar selector changes value for EVERY subscriber whenever it is written, so one
  // reveal re-rendered all sixty rows, and then re-rendered all sixty AGAIN when `clearRevealAgent`
  // below wrote it back to null: 120 row renders to scroll one row. The comment forty lines up
  // already claims row subscriptions are narrowed to booleans precisely so an unrelated write
  // cannot invalidate every row; this is that claim made true here too.
  //
  // The ANCHOR is read from the store at effect time rather than subscribed. It only has meaning
  // for the row being revealed, it is written in the SAME `set` as `revealAgentId` (see uiStore's
  // `requestRevealAgent`), and it is cleared in the same one — so `revealMe` flipping is the only
  // edge that can bring a new anchor with it, and `getState()` inside the effect reads the freshest
  // value there is. Subscribing to it bought nothing and cost fifty-nine renders.
  const revealMe = useUiStore((s) => s.revealAgentId === a.id);
  useEffect(() => {
    if (!revealMe) return;
    const revealAnchorY = useUiStore.getState().revealAnchorY;
    sidebarScroll?.abandonReveal(true);
    const row = rowRef.current;
    const sc = sidebarScroll?.containerRef.current;
    // Both elements and a real anchor, or this is the un-anchored path. The `getBoundingClientRect`
    // check guards only against an ENVIRONMENT that does not implement it at all (a test that has
    // stubbed the prototype and not restored it) — it is NOT the zero-layout guard, since jsdom
    // implements the method and returns zeroes. Zero layout is caught inside `anchoredScrollTop`,
    // by `maxScroll <= 0`.
    if (
      revealAnchorY != null &&
      row &&
      sc &&
      typeof row.getBoundingClientRect === "function" &&
      typeof sc.getBoundingClientRect === "function"
    ) {
      const rect = row.getBoundingClientRect();
      // The CONTAINER's band, not just the row's position: the anchor is a click in the concierge
      // column and can name a Y outside this container entirely (see anchoredScroll's doc).
      const box = sc.getBoundingClientRect();
      const target = anchoredScrollTop({
        rowTop: rect.top,
        rowHeight: rect.height,
        anchorY: revealAnchorY,
        scrollTop: sc.scrollTop,
        maxScroll: sc.scrollHeight - sc.clientHeight,
        containerTop: box.top,
        containerHeight: sc.clientHeight,
      });
      // `null` means "already as close as it can get" — leave the column exactly where it is rather
      // than writing an identical offset, which would still cancel any in-flight smooth scroll.
      if (target !== null) sc.scrollTop = target;
    } else {
      rowRef.current?.scrollIntoView?.({ block: "nearest" });
    }
    useUiStore.getState().clearRevealAgent(a.id);
  }, [revealMe, a.id, sidebarScroll]);

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
  // RE-MEASURE ONCE THE ROW'S OWN BOX HAS SETTLED. `openCard` calls `onSelect()` — which patches the
  // cable — and then `show()` in the same handler, so the rect above is captured against the
  // PRE-patch box while the card is padded from the POST-patch one. Those disagree by exactly the
  // compensation: in a right pair not already holding the cable the row's box left moves from
  // `E + LIST_PAD_X` to `E` as its padding goes 10 → 18 (the ink stays put, which is the invariant),
  // so a card pinned at the stale left and padded 18 put its disc and title 8px right of the row's.
  // The old constant was accidentally correct in that one case, so reading the live padding without
  // this traded the left-pair jump for a right-pair one — in the DEFAULT configuration (roborev
  // 55287).
  //
  // A layout effect, so it runs after the DOM has the new box and before paint: nothing is ever
  // shown at the stale position. Keyed on the geometry inputs rather than on every render, so it
  // does not re-measure in a loop.
  useLayoutEffect(() => {
    if (!hover) return;
    const el = rowRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ left: r.left, top: r.top, width: r.width });
  }, [hover, jointOpen, paneSide, depth]);
// ── SELECTION IS CLICK-ONLY. HOVER NEVER SELECTS AND NEVER MOUNTS. ────────────────────────────
// There used to be a `HOVER_INTENT_MS = 90` dwell gate here, and an `armSelect` on the row's
// `onMouseEnter` that called `onSelect("hover")` from a timeout: resting the pointer on a row for
// 90ms selected that agent and MOUNTED its pane, with no click anywhere.
//
// The dwell gate was a mitigation, not the rule. It made a fast transit inert, which is why this
// kept reading as "fixed" — but any pause at all still activated, so reading the column was
// impossible without taking over the terminal you were reading. The founder's rule is that a
// build agent is selected ONLY on click; hover may preview, never select or mount.
//
// SO THE GATE IS GONE RATHER THAN RETUNED. A longer dwell is the same bug with a bigger number,
// and it is the shape this regressed into once already. `onSelect` no longer takes a `via`
// argument at all, so there is no hover path left to re-enable by accident — reintroducing one
// means adding a parameter back, which is a visible change rather than a one-line default.
//
// What hover still does: the row's own paint, and the auto-scroll that keeps a bottom row's card
// on screen. What opens the detail card is a RIGHT click (`openCard`). See `onRowClick` for the
// click-again-opens-workers rule.

  const hide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setHover(false), 60);
  };
  // Leaving the row starts the card's close delay. It used to also cancel a pending hover-commit;
  // there is no such thing any more (see HOVER_INTENT_MS's headstone above), so this is just the
  // card now.
  const onRowLeave = () => {
    hide();
  };
  // LEFT click = select this agent. CLICK IT AGAIN = fold/unfold its workers.
  // DOUBLE click = mount the concierge onto it (`onRowDoubleClick`, below).
  //
  // TWO STAGES, NOT ONE. The toggle used to ride along on EVERY click, so the first click on an
  // unselected head both took the terminal and threw its subtree open — you could not look at an
  // agent without also restructuring the column, and you could not open a subtree without also
  // stealing the pane. Gating the toggle on `isActive` separates them: the first click commits to
  // the agent, and only a click on the row you are ALREADY on expands it.
  //
  // `subtreeCollapsed` is null on anything without workers, so a childless row and a worker row
  // just select on every click — the second stage simply does not exist for them, which is right:
  // there is nothing to open.
  const onRowClick = (e: React.MouseEvent) => {
    const wasAlreadySelected = isSelected;
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
    // THE SECOND CLICK OF A DOUBLE PRESS IS NOT A SECOND CLICK — it is half of a mount, and the
    // fold must not read it as the "click it again" gesture (roborev 63145, finding 3).
    //
    // The two rules do not contend PER EVENT: the fold is keyed on `click`, the mount on `dblclick`.
    // But they contend as a COMPOSITE GESTURE, and that is what the claim in `engine/cable` used to
    // miss. Mounting the concierge onto an ORCHESTRATOR is always at least two clicks on a row you
    // are about to be on, so the second one always satisfies `wasAlreadySelected` — and the fold it
    // triggers is PERSISTED. Net effect: you could not patch the cable onto an orchestrator without
    // also folding or unfolding its worker subtree, restructuring the column every single time.
    //
    // `e.detail >= 2` is the whole test, and it is the click-count for a real pointer sequence — 2
    // on the second press of a double, 3 on a triple. It cannot swallow a deliberate fold: a user
    // clicking again to fold is, by construction, clicking OUTSIDE the OS double-click interval the
    // browser uses to raise `dblclick`, so their second press arrives with detail back at 1.
    //
    // NOT `!== 1`: detail 0 is the assistive-tech / HintOverlay class, which has no double form and
    // whose fold behaviour is already decided one line up by `isHintJump`. Excluding it here would
    // silently take the fold away from AT users — the exact failure roborev 53837 is cited for.
    const isDoublePress = e.detail >= 2;
    // `wasActive` — the SECOND click is the one that folds. A jump still never folds (above), and
    // a jump onto an already-selected row is still a jump, so the check stays ahead of this.
    if (subtreeCollapsed !== null && !isHintJump && !isDoublePress && wasAlreadySelected) {
      // DEFERRED, not called — see FOLD_DOUBLE_PRESS_GRACE_MS. This click may be the first half of a
      // mount, and nothing about it says so yet; `onRowDoubleClick` cancels the pending fold if the
      // `dblclick` arrives. An AT/synthetic activation (detail 0) takes the same path deliberately:
      // it can never be followed by a `dblclick`, so its fold simply lands one interval later
      // rather than acquiring a second code path that could drift from this one.
      if (foldTimer.current) clearTimeout(foldTimer.current);
      foldTimer.current = window.setTimeout(() => {
        foldTimer.current = null;
        onToggleSubtree();
      }, FOLD_DOUBLE_PRESS_GRACE_MS);
    }
    // …AND ONLY THEN, THE MOUNT. This is `false` for every ordinary mouse press (detail ≥ 1) — which
    // is the founder's whole ask — and `true` only for a click with no pointer sequence behind it:
    // an assistive-tech activation or HintOverlay's synthetic jump, neither of which can produce the
    // `dblclick` the mouse uses. See `engine/cable`'s block for the full table.
    if (mountsOnRowActivation({ type: "click", detail: e.detail })) onMount();
  };
  /**
   * DOUBLE click = MOUNT THE CONCIERGE ONTO THIS ROW. The founder's gesture, 2026-08-12.
   *
   * It does NOT re-select first: the browser delivered both clicks before this event, so `onRowClick`
   * has already run twice and the row is seated and focused. A third `onSelect()` here would be
   * harmless but would say, wrongly, that this handler is the one that seats the row.
   *
   * THE TWO CLICKS DO NOT RACE THE MOUNT, because they cannot overlap it: `click`, `click`, `dblclick`
   * is a fixed order in every engine, and each is dispatched synchronously. What the clicks do — seat
   * the agent, ask its terminal for the caret — is idempotent and already complete when this runs. The
   * one thing that WOULD have contended is the fold-on-second-click rule, which is precisely why the
   * mount is not keyed on the click count (`engine/cable`).
   *
   * ══ AND IT BAILS OVER THE ROW'S OWN CONTROLS. `stopPropagation` ON A CLICK DOES NOT STOP A
   *    DBLCLICK ═════════════════════════════════════════════════════════════════════════════════
   * Every chip on this row guards itself the same way — `onClick={(e) => { e.stopPropagation(); … }}`
   * — and that guard was complete right up until the row grew a `dblclick` handler, because `click`
   * and `dblclick` are SEPARATE events and stopping one says nothing about the other. So the day the
   * mount landed, double-pressing the retire pill opened the close dialog AND silently patched the
   * cable onto that row; the same for the notice mark, the founder-ask chip, the epic pill and the
   * feedback pill (roborev 63145). Before the mount existed those controls were simply inert on a
   * double press, which is why nothing caught it.
   *
   * ONE CENTRAL BAIL, NOT A GUARD PER CHIP. Five `onDoubleClick={(e) => e.stopPropagation()}` lines
   * beside five existing click guards is five places for the sixth chip to forget — and forgetting
   * is silent here, because the symptom is a cable quietly moving, not an error.
   */
  const onRowDoubleClick = (e: React.MouseEvent) => {
    // THE PRESS WAS A MOUNT, SO IT WAS NEVER A FOLD. Cancels the fold `onRowClick` deferred a
    // moment ago (FOLD_DOUBLE_PRESS_GRACE_MS). Done BEFORE the control bail on purpose: a press
    // that starts on a chip never armed a fold — the chip stops the click — so this is a no-op
    // there, and putting it first means the cancel can never be skipped by a later early return.
    if (foldTimer.current) {
      clearTimeout(foldTimer.current);
      foldTimer.current = null;
    }
    // BOUNDED AT THE ROW, and the bound is not defensive dressing (roborev 63236). A bare
    // `closest` walks to the document root, so any future ANCESTOR of the row matching the
    // selector — a wrapper given `role="tab"`, a column that becomes a `<button>` — would match on
    // every press and kill mounting for the whole column at once, silently and everywhere.
    //
    // It is also what makes broadening the selector safe rather than catastrophic. To be exact
    // about the state of things today (roborev 63316): the row's role is `treeitem`, which the
    // selector does NOT list, and `tabindex` is deliberately excluded — so right now `closest`
    // returns null on a press on the row and this bound is not what carries that case. It is a
    // guard against the NEXT edit, and the tests treat it that way: they give the row (and an
    // ancestor) a matching role explicitly, because a case that does not create the condition
    // cannot pin the bound. `hit !== e.currentTarget` says the control must be something OTHER than
    // the row; `contains` says it must be INSIDE it. A press on the row is then never a control.
    const hit = e.target instanceof Element ? e.target.closest(ROW_CONTROL_SELECTOR) : null;
    if (hit && hit !== e.currentTarget && e.currentTarget.contains(hit)) return;
    onMount();
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
        // TWO STAGES HERE TOO, gated identically to `onRowClick`. Enter/Space is the keyboard's
        // copy of a left click, and this line originally selected AND folded in one activation —
        // so applying the click-again rule to the mouse alone would have left the two gestures
        // doing different things, with the keyboard keeping the behaviour the founder removed.
        //
        // That divergence is the failure mode roborev 53837 is cited for a few lines down: fold
        // behaviour differing silently for the users least able to work around it. ArrowRight and
        // ArrowLeft still own explicit expand/collapse, so a keyboard user who wants the subtree
        // without a second activation has a direct key for it.
        if (subtreeCollapsed !== null && isSelected) onToggleSubtree();
        onSelect();
        // AND IT STILL MOUNTS, where a single mouse click no longer does. Enter/Space is the
        // keyboard's deliberate activation and has no double form to promote the mount to — dropping
        // it would leave keyboard-only users with no way to patch the cable at all, which is a
        // strictly worse outcome than the one the founder asked to fix. The complaint was about a
        // press you make while merely LOOKING at a row; nobody presses Enter in passing.
        if (mountsOnRowActivation({ type: "key" })) onMount();
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
  // OPEN THE DETAIL CARD. It is the only home for the model picker, Land, branch rebase, the path
  // reveal and the per-worker breakdown, so the card survives every change to how it is reached —
  // and it has been reached three ways now. A left click opened it once, which meant every glance at
  // an agent threw a full-width overlay across the terminal you were trying to read; then a bare
  // right click on the row; and since 2026-08-13 it is the menu's "Open details…" item. Selecting
  // first keeps the card and the terminal showing the same agent.
  const openCard = () => {
    onSelect();
    show();
  };
  /**
   * RIGHT click ANYWHERE ON THE ROW = the row's context menu. Founder, 2026-08-13: *"Renaming of the
   * builder row should now go into right click of the builder row. It should be an option in the
   * right click menu."*
   *
   * ══ WHAT THIS REPLACES, AND WHY ONE HANDLER RATHER THAN TWO ═══════════════════════════════════
   * A right click had two different answers depending on where on the row it landed. Over the agent
   * NAME it began an inline rename instantly (the gesture rename moved to on 2026-08-12, when the
   * double click had to be freed for the mount — roborev 63145). Anywhere ELSE it opened the detail
   * card. Both are real verbs and neither was discoverable: the name span is `flex: 1`, so the two
   * zones are wildly unequal and their boundary is drawn nowhere. Now there is ONE answer, and both
   * old outcomes are items inside it — plus Close agent, which previously had no keyboard route and
   * no route at all on a row that was not selected or hovered.
   *
   * ══ IT STILL HANDS OFF DURING A RENAME, FOR THE REASON `openCard` DID ═════════════════════════
   * The rename `<input>` is the column's only text field, and `preventDefault` here would suppress
   * the NATIVE menu inside it — i.e. cut/copy/paste (roborev 53814). Returning early also avoids
   * opening a menu whose Rename item is the state you are already in.
   *
   * ══ THE ANCHOR ════════════════════════════════════════════════════════════════════════════════
   * The cursor, except when there isn't one: the row is focusable, so it receives `contextmenu` from
   * Shift+F10 and the Menu key, which carry no coordinates. Those anchor to the row's own rect
   * instead — a menu pinned to the viewport's top-left corner for a keyboard user is not a menu they
   * can associate with the row it acts on. That path is also this app's FIRST keyboard route to
   * rename; there has never been a shortcut for it.
   */
  const openRowMenu = (e: React.MouseEvent) => {
    if (editing) return;
    e.preventDefault();
    // DELIBERATELY NOT STOPPED, where the rename handler this replaces did stop it. That
    // `stopPropagation` was claiming the event FROM the row, which no longer needs claiming: the
    // name has no handler at all now, and the card's title line is inside a portal that is a
    // SIBLING of the row, so neither can reach this handler twice. What propagation DOES still
    // reach is the window listener that abandons a push-to-talk hold on any context menu
    // (voice/usePushToTalk) — behaviour that predates this change and has no reason to stop.
    if (e.clientX !== 0 || e.clientY !== 0) {
      setMenuAt({ x: e.clientX, y: e.clientY });
      return;
    }
    const r = rowRef.current?.getBoundingClientRect();
    setMenuAt(r ? { x: r.left + KEY_MENU_INSET, y: r.bottom } : { x: 0, y: 0 });
  };
  const beginRename = () => setEditing(a.id);
  // Stable, because the menu subscribes document-level listeners keyed on it — a fresh closure each
  // render would tear those down and re-add them on every unrelated row re-render.
  const dismissRowMenu = useCallback(() => setMenuAt(null), []);
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      // A row can be unmounted mid-gesture (a fold, a filter, a project switch). Firing a deferred
      // fold afterwards would write persisted state for a row nobody is looking at any more.
      if (foldTimer.current) clearTimeout(foldTimer.current);
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
  // `?? a.activityAt` so a NEVER-TOUCHED row that carries a self-report still subscribes to the clock
  // — otherwise its open card could show a stale activity line as present-tense forever, since
  // useRowClock registers no timer when `since == null` (the narrated-then-died case this guards). It
  // only drives the tick; ElapsedTimer reads `lastTouchAt` directly, so its displayed value is unchanged.
  const clockNow = useRowClock(lastTouchAt ?? a.activityAt);

  // ── THE NEVER-IDLE OVERLAY ──────────────────────────────────────────────────────────────────────
  // Idle-and-done, idle-and-stalled and thrashing all painted the SAME gray row, and that identity
  // is the whole bug: a 153-minute stall looked exactly like an agent that had shipped its PR. Three
  // pure cores answer it — engine/agentStall, engine/agentThrash, engine/agentGoal — and this is
  // purely their rendering. No new `AgentTabStatus`: these are derived overlays read BESIDE `st`,
  // the same shape `rollupDot` takes beside `status`, so every existing `idle` branch (bands, CTA
  // gating, inMotion, the worker rollup) keeps its current meaning.
  //
  // DERIVED IN THE ROW, not threaded through props, for two reasons. `agentRowPropsEqual` is a
  // hand-maintained exhaustive comparator and a data prop omitted from it silently freezes the row
  // on stale data; and `thrashReportFor` reads a window-local, NON-REACTIVE registry, so it has to
  // be sampled at render against a clock rather than captured into a memo upstream. `clockNow` is
  // that clock: it ticks every 1s/5s for any row with an interaction to time from, which is every
  // row that could possibly be thrashing (thrash requires submitted prompts).
  //
  // Reading the two git facts straight from the store — `bs` is already a prop, but the PR probe and
  // the stage watermark are not, and rowAttention needs the RAW values to tell "false" from "never
  // looked up". Passing a resolved stage would destroy exactly that distinction.
  const wfState = useRuntimeStore((s) => s.workflowState[a.id]);
  const stageOverride = useRuntimeStore((s) => s.workflowStage[a.id]);
  // Subscribed so this row repaints when the merge watermark lands, not only when the branch poll
  // does — `awaitingCloseEvidenceFor` reads both, and a chip that lags the dot is the divergence
  // this row's own comment two lines down exists to prevent.
  // ⚠️ OPTIONAL-CHAINED, and not defensively for its own sake. Several suites mock `useRuntimeStore`
  // with a partial state that predates these two maps, so a bare index throws inside the selector and
  // takes the whole component down — 72 tests across four files, none of them about goals. Every
  // other reader of these maps (`landedEvidenceFor`, `shippedAfterGoalSet`) already chains for the
  // same reason: an absent map means "not looked up", which is a real answer here.
  const shippedLatch = useRuntimeStore((s) => s.workflowShipped?.[a.id]);
  const shippedAt = useRuntimeStore((s) => s.workflowShippedAt?.[a.id]);
  // Subscribe so this row's OWN chip repaints when a flag lands — the dot is the sidebar's
  // derivation, the chip is this one, and they must not disagree about the same agent (roborev
  // 65339). Read as a SNAPSHOT rather than a counter so the dependency is real (roborev 65409).
  const nudgeFlags = useNudgeFlagSnapshot();
  const stall = stallReport(
    // `calmSt`, NOT `st` — see the prop's docstring. Asking the stall question about an already-
    // escalated row returns `active` and no causes, so the row would go red with nothing to say.
    stallInputsFor(
      calmSt,
      clockNow,
      a.goal,
      { bs, ws: wfState, stageOverride },
      quotaBlockForAgent(a.id, clockNow),
      // THE SAME INPUT THE SIDEBAR'S REPORT GETS (roborev 65339, a High). This row builds its OWN
      // stall report, so without the flag here the DOT went red from the sidebar's reading while the
      // chip beside it never rendered "blocked on you" — a red row with no explanation attached,
      // which is the inverse of the founder's complaint rather than a fix for it.
      humanBlockIn(nudgeFlags, a.id),
      // …and the third input, for the third time on the same argument. `shipped`/`shippedAt` above
      // are subscribed ONLY to make this recompute; the value itself is read through the shared
      // builder so this row cannot answer "has it shipped for this goal" differently from the
      // sidebar's dot or from `get_state`.
      awaitingCloseEvidenceFor(a.id, a.goal),
    ),
  );
  // Referenced so the two subscriptions above are not read as unused — they exist to drive the
  // recompute of `stall`, whose evidence is read from the store rather than passed as props.
  void shippedLatch;
  void shippedAt;
  // `isStalled` is the gate, not `verdict !== "finished"`: it is true ONLY for a confident stall, so
  // the `unknown` verdict — idle with git state we never read — raises nothing. A stall claim that
  // fires on missing data trains the human to ignore the signal, which costs more than the stall.
/** THE MARK IS SILENT IN EVERY STATE, AND THAT IS A MEASURED DECISION — NOT A TIMID ONE.
 *
 *  The first cut of this gave `escalated` and `expired` visible words, on the reasoning that the two
 *  states which are somebody's PROBLEM had earned the space. Photographing the row is what settled
 *  it: at a 440px column an escalated row rendered `◎ ⚠ aι` and an expired one `◎ Goa ⚠ work`. The
 *  chips were not merely tight, they had clipped past legibility — and the first version of the fix
 *  (letting them shrink and ellipsize instead of overflowing) only converted an OVERLAP into two
 *  unreadable stubs. The row has room for exactly ONE worded chip beside the name and the stage
 *  chip, and that slot is already spoken for by the STALL chip, which names the outstanding work
 *  ("PR unmerged", "auto-continue gave up") — strictly more actionable than restating a state.
 *
 *  So the goal is a MARK, not a phrase, and the state is carried by GLYPH first and colour second.
 *  The words are not lost: they are on the chip's `title`, in its accessible name, and in full in
 *  the detail card.
 *
 *  DO NOT reintroduce visible text here without re-photographing the row at 440px. A green suite
 *  will not tell you: jsdom has no layout engine, so every assertion in this file passes just as
 *  happily against two chips drawn on top of each other. */
  // WITH THE EVIDENCE — this row already subscribes the watermark for its stall chip, and the badge
  // sits beside that chip. Without it the row renders "auto-continue gave up" next to "done —
  // awaiting your close" about the same agent, in one glance (roborev 65987).
  const goalBadge = goalBadgeFor(a.goal, clockNow, awaitingCloseEvidenceFor(a.id, a.goal));
  // `bs` is passed so an "uncommitted changes" chip can NAME the file it is talking about
  // (sparkle-biezi) — the same reading the stall question was built from, so the chip and the
  // verdict can never describe different worktree states.
  const stallChip = isStalled(stall) ? stallChipFor(stall, bs) : null;
  // `goalOutstanding` gates the no-progress alarm only (three tool-less turns are just a
  // conversation when nothing is outstanding). We genuinely know this — no goal means no goal work —
  // so `false` here is evidence, not a fabrication.
  const thrash = thrashReportFor(a.id, clockNow, {
    goalOutstanding: hasUnmetGoal(a.goal, clockNow),
    // Same wall, same clock as the stall reading above, so one row cannot say two things.
    quotaBlock: quotaBlockForAgent(a.id, clockNow),
  });
  const thrashLabel = thrashChipLabel(thrash);

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

  // ── NO PIN CHIP. AGENT PINNING IS GONE. ────────────────────────────────────────────────────
  // A pin glyph used to render here whenever `namePinned` was set, and clicking it released the
  // freeze. It had already lost most of its meaning: `namePinned` once meant BOTH "don't
  // auto-rename" AND "hold this row's position", and row anchoring was removed when rows started
  // moving only on a workflow-stage change. What was left was a pin that pinned nothing — it
  // reported that the user had renamed the agent, which the name itself already says.
  //
  // So the affordance is gone, and `unpin_agent` with it (see services/conciergeTools/policy).
  //
  // `namePinned` THE FLAG STAYS, and is still set by a manual rename. It is the reason an explicit
  // rename is not overwritten by the auto-namer moments later — see projectStore's precedence note
  // (human rename > self-name > auto-name). Removing the flag as well would have made every
  // rename temporary, which is a different and much worse bug than a redundant glyph.
  //
  // NOT TO BE CONFUSED WITH PROJECT-TAB PINNING (components/ProjectTabs), which is a live feature
  // and untouched: pinning a PROJECT scopes the concierge to it. Same word, different thing.

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

  // THE UNJUDGED ASK (the neutral middle state). This agent finished a turn that LOOKED like it was
  // asking something, and the followup judge — the thing that decides "needs you" vs "done" — could
  // not run to settle it. Neither colour is honest, so the row shows neither: a muted question glyph
  // sits beside the name and the status dot keeps saying whatever the deterministic sources say.
  //
  // Why it must exist at all: with the judge unavailable (the expected state until AI enhancement
  // moves onto the user's own `claude` CLI), the safe default of "don't paint red" would otherwise
  // make a genuine "Want me to land it?" indistinguishable from a finished turn — a silently dropped
  // ask. This is the difference between "nothing needs you" and "we couldn't tell", said out loud.
  // Muted, never red: the whole point of the surrounding work is that red means something.
  const unjudgedAskChip = unjudgedAsk ? (
    <span
      data-testid="unjudged-ask"
      title={
        "This agent finished with something that reads like a question, and the AI check that " +
        "decides whether it needs you couldn't run. Open it to see for yourself."
      }
      aria-label="Possible question — not checked"
      style={{ display: "inline-flex", flex: "0 0 auto", lineHeight: 1, color: C.muted }}
    >
      <FiHelpCircle size={11} />
    </span>
  ) : null;

  // THE STALL CHIP — "this gray row is not done", and WHAT it still owes.
  //
  // Naming the cause is the entire point. "Stalled" on its own tells the reader to go investigate,
  // and the investigation is the expensive part — so the VISIBLE text is the outstanding work
  // ("PR unmerged", "uncommitted changes", "auto-continue gave up"), the word itself lives in the
  // accessible name, and the engine's full sentence rides along as the tooltip.
  //
  // INK, and why this is not a second alarm. The row's DOT is untouched: `stallReport` returns
  // `active` for the whole red tier (waiting/approval/blocked/errored), so this chip can only ever
  // appear on a row the color system already calls calm — the gray rows nobody looks at, which are
  // the target. Amber is the status token for "this is waiting on something" (packages/ui/tokens.ts)
  // and is the right weight for a landing state that needs a human eventually. An ESCALATED goal is
  // amber TOO as of 2026-08-06 — it used to take DANGER on the reasoning that auto-continue having
  // given up is "categorically different", and the founder overruled exactly that: nothing is coming
  // for the agent, but nothing is being asked of HIM either, and red is reserved for what he must
  // act on. The difference is carried by weight and glyph size instead. Red on this surface now
  // means only the causes in `stallEscalation.OUTSTANDING`.
  // ══ THE NOTICE MARKS — A GLYPH, NEVER THE WORDS. Bead sparkle-tyter. ═══════════════════════════
  //
  // WHAT THIS REPLACES, and why it was not a styling nit. `stallChipEl` and `thrashChipEl` used to
  // render the literal notice text ("Rate limited", "Looping", "PR unmerged") into this row. The
  // thrash chip did it at `flex: "0 0 auto"` + `whiteSpace: "nowrap"` — an item that refuses to
  // shrink — while `FittedAgentName` beside it was `flex: 1; minWidth: 0`, an item that gives up
  // everything first. Flexbox did exactly that: at the real column width the NAME went to ZERO and
  // disappeared, and the notice ended up flush against the stage chip after it. Eight rows of the
  // founder's screenshot read `Rate limitedShipped` / `Rate limitedUnsaved` / `Looping Shipped`,
  // with no agent name anywhere. Nothing painted over anything; there is no absolute positioning
  // involved. A fleet list whose rows cannot identify their agents has stopped working.
  //
  // TWO THINGS FIX IT AND BOTH ARE KEPT. These marks are wordless, which BOUNDS the tail's width;
  // and `FittedAgentName` now carries a hard `minWidth` floor, which is the structural half — it
  // survives whatever chip the next branch adds here, where a bounded-width convention would not.
  //
  // ONE MARK PER CLASS, NOT PER VERDICT. `rowGlyphsFor` collapses ten warning verdicts into a single
  // mark with a count. A glyph per verdict would rebuild, in icon form, the exact wall of signal the
  // founder asked to be rid of ("I can't read all of these in line notices").
  //
  // THE MESSAGE CLASS IS NOT DRAWN HERE. `AgentInboxBadge` already renders the mailbox + count, owns
  // its own popover, and is the one mark the founder singled out as already right — so the row
  // passes NO `pendingInbox` into `agentNotices` and the badge keeps the class. The composer's pill
  // row reads the full model including the inbox; this is the one surface that deliberately does not.
  // `goalBadge` IS passed, and `rowGlyphsFor` drops the goal-class mark it produces (roborev 59278).
  // The row draws its own goal chip, so it needs no mark — but it DOES need the goal as an INPUT,
  // because a stall cause standing in for the goal takes the goal's glyph. Omitting it made this row
  // compute an amber triangle for `stall:unmet-goal` while the composer drew a blue target for the
  // very same notice, so a click still crossed from one mark to a different-looking pill.
  // The goal is passed as an INPUT (so a goal-derived stall cause is recognised) and then its notice
  // is REMOVED from the row's marks, because the goal chip beside them already draws that fact and is
  // itself clickable (roborev 59322). Without the removal the row drew `FiTarget` twice for one
  // fact, and a row whose only warning was the goal lost its amber "something is wrong" triangle.
  const noticeMarks = rowGlyphsFor(
    withoutSeparatelyDrawn(
      agentNotices({
        thrash,
        stall,
        goal: goalBadge,
        // ── THE LOGIN STAND-DOWN, ON THE SURFACE HE IS ACTUALLY SCANNING (bead sparkle-qg71dl) ──
        // From the SAME snapshot the stall input above takes, so this row cannot answer "is a
        // person needed here" differently from the pill row the founder lands on when he clicks.
        // It is not routed through `stall`: `stallReport` describes work left owing, and a dead
        // login is not owed work — it is a precondition failure that makes every other verdict on
        // this row a downstream symptom. See `agentNotices` for why it leads the warnings.
        login: loginStanddownIn(nudgeFlags, a.id),
      }),
      goalBadge,
    ),
  );
  /**
   * MOUNT THIS AGENT AND OPEN THE PILL THAT EXPLAINS `noticeId`. Bead sparkle-tyter, the founder's
   * second scope addition.
   *
   * *"When I click on the blue target it doesn't do anything. I'm not seeing any sort of notice
   * above the compose window when the concierge is mounted."* — and he chose this model when asked
   * which it should be: clicking a row icon MOUNTS that agent and shows the pill, rather than
   * explaining in place. So every clickable mark on the row runs exactly this, and the gesture is
   * one thing rather than three copies of it drifting apart.
   *
   * `stopPropagation` because the row's own click selects and folds the subtree; this gesture means
   * something more specific and must not also do that.
   */
  const openNoticePill = (noticeId: string) => {
    onSelect();
    useCableStore.getState().patch(paneSide, a.id);
    useUiStore.getState().setFocusedNotice(paneSide, noticeId);
  };
  const noticeMarksEl = noticeMarks.map((mark) => {
    const Glyph = NOTICE_GLYPH_ICON[mark.glyph];
    return (
      <span
        key={mark.cls}
        data-testid="row-notice-glyph"
        data-notice-class={mark.cls}
        // THE GLYPH NAME, exposed so a test can compare the row's mark to the composer's pill for
        // one notice id (roborev 59278). react-icons render as anonymous SVG in jsdom, so without
        // this the row-side half of the parity invariant is unassertable — which is exactly how the
        // divergence survived: the model-level test passes whether or not the ROW supplies the goal.
        data-notice-glyph={mark.glyph}
        data-notice-count={mark.count}
        data-notice-lead={mark.leadNoticeId}
        role="button"
        tabIndex={0}
        // THE HOVER IS THE NO-MOUNT READING PATH — the founder's fourth requirement, "hover or click
        // the row icon reveals the same detail WITHOUT mounting, so a glance is still possible".
        // Every label in the class, one per line.
        title={`${mark.title}\n\nClick to open on the composer`}
        aria-label={mark.ariaLabel}
        onClick={(e) => {
          e.stopPropagation();
          openNoticePill(mark.leadNoticeId);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.stopPropagation();
          e.preventDefault();
          openNoticePill(mark.leadNoticeId);
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 2,
          // Never shrinks — but unlike the chip it replaces, it has nothing to shrink: an icon and
          // at most a two-digit count. That is the difference between this and the bug.
          flex: "0 0 auto",
          lineHeight: 1.4,
          fontSize: 10,
          fontWeight: FONT_WEIGHT.semibold,
          cursor: "pointer",
          // AMBER FOR BOTH WARNING GLYPHS SINCE 2026-08-06 (roborev 59949). `escalated` used to be
          // the ONLY one inked DANGER — which had it exactly backwards once `escalated-goal` moved
          // to the amber `lapsed` tier: the lifecycle cause was painted red while `alert`, which
          // carries the causes that genuinely need the founder (uncommitted changes, unlanded work,
          // an open PR), was already amber. The two now differ by SHAPE, which is the distinction
          // that survives colour-blindness anyway; the row's DOT is what carries the red/amber tier.
          color: C.amberInk,
        }}
      >
        <Glyph size={10} style={{ flex: "0 0 auto" }} />
        {/* The count only, and only when it says something a single glyph cannot. Digits are the
            one "text" this mark may carry: bounded at two characters, so it cannot re-open the
            collision the words caused. */}
        {mark.count > 1 ? mark.count : null}
      </span>
    );
  });

  // ── THE COLLAPSED CLUSTER — one affordance standing for the goal chip AND every notice mark ────
  //
  // See `noticeClusterCollapses` for why this exists. Two properties matter and both are load
  // bearing:
  //
  //   IT CARRIES THE WORST INK IT STANDS FOR — and since 2026-08-06 an escalated goal is no longer
  //   among the worst. Collapsing must never downgrade a row the founder owes into a calm-looking
  //   one; that invariant is unchanged. What changed is which causes he is owed BY: `escalated-goal`
  //   moved to the amber `lapsed` tier, and the goal chip moved with it, so there is no longer any
  //   DANGER ink on this surface for a merely-escalated row to summarise.
  //
  //   IT OPENS WHAT IT HID. Same gesture as an individual mark (mount + reveal the pill), targeting
  //   the most actionable notice — `rowGlyphsFor` orders its marks that way, so the head is the
  //   right one; the goal is the fallback when the cluster is goal-plus-nothing-severe.
  const clusterMarkCount = noticeMarks.length + (goalBadge ? 1 : 0);
  const clusterCollapsed = noticeClusterCollapses(columnWidth ?? 0, clusterMarkCount);
  // The `m.glyph === "escalated"` term was dropped as REDUNDANT, not as a behaviour change — and
  // that correction matters, because the first version of this comment claimed it fixed a
  // width-dependent tier, which cannot happen here (roborev 59986). An `escalated` glyph can only
  // come from `stall:escalated-goal`, whose cause derives from `goalStateOf`; whenever that holds,
  // `goalBadgeFor` returns a badge with `escalated: true` AND `withoutSeparatelyDrawn` strips the
  // notice before it reaches `noticeMarks`. So the dropped term was true only when the remaining one
  // already was. Row marks cannot carry `escalated` at all — do not read this as evidence they can.
  const clusterEscalated = goalBadge?.escalated === true;
  const clusterLeadNoticeId =
    noticeMarks[0]?.leadNoticeId ?? (goalBadge ? `goal:${goalBadge.state}` : null);
  const collapsedClusterEl =
    clusterCollapsed && clusterLeadNoticeId !== null ? (
      <span
        data-testid="row-notice-overflow"
        data-notice-count={clusterMarkCount}
        data-notice-escalated={clusterEscalated ? "true" : "false"}
        role="button"
        tabIndex={0}
        // EVERY label it stands for, one per line — the same no-mount reading path the individual
        // marks offer, so collapsing costs a hover rather than the information.
        title={`${[
          ...(goalBadge ? [`Goal — ${goalBadge.label}`] : []),
          ...noticeMarks.map((m) => m.title),
        ].join("\n\n")}\n\nClick to open on the composer`}
        aria-label={`${clusterMarkCount} notices on this agent — open on the composer`}
        onClick={(e) => {
          e.stopPropagation();
          openNoticePill(clusterLeadNoticeId);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.stopPropagation();
          e.preventDefault();
          openNoticePill(clusterLeadNoticeId);
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 2,
          flex: "0 0 auto",
          lineHeight: 1.4,
          fontSize: 10,
          fontWeight: FONT_WEIGHT.semibold,
          cursor: "pointer",
          // Unconditionally amber now: nothing this cluster stands for is DANGER any more. The
          // warning marks are amber, and the goal chip's escalated state moved to amber with them
          // (GOAL_CHIP_COLOR). `clusterEscalated` is kept only as the `data-notice-escalated`
          // signal, which is a FACT about the row rather than a colour.
          color: C.amberInk,
        }}
      >
        <FiMoreHorizontal size={10} style={{ flex: "0 0 auto" }} />
        {clusterMarkCount}
      </span>
    ) : null;

  // RETAINED BUT NO LONGER RENDERED ON THE COLLAPSED ROW — the expanded CARD still uses it (see
  // `stallChip &&` further down), where there is room for the sentence and no name to crowd out.
  const stallChipEl = stallChip ? (
    <span
      data-testid="row-stall"
      // The FULL paths ride the tooltip. The chip has room for one basename, which is enough to tell
      // a forgotten fix from a build artifact at a glance; someone who needs the directory hovers.
      title={
        stallChip.files.length > 0
          ? `${stall.detail}\n\nUncommitted:\n${stallChip.files.join("\n")}`
          : stall.detail
      }
      aria-label={stallChip.ariaLabel}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        flex: "0 1 auto",
        minWidth: 0,
        maxWidth: "20ch",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        lineHeight: 1.4,
        fontSize: 10,
        // BOLD stays as the escalated distinction; the INK does not (2026-08-06, roborev 60001).
        // `stallChipFor` sets `escalated` from the same `escalated-goal` cause that GOAL_CHIP_COLOR
        // moved to amber, and this chip renders immediately beside the goal chip on the card — so
        // leaving it DANGER put an amber goal chip next to a red "auto-continue gave up" chip for
        // ONE fact. Same argument as the chip's size: the weight carries the emphasis.
        fontWeight: stallChip.escalated ? FONT_WEIGHT.bold : FONT_WEIGHT.semibold,
        color: C.amberInk,
      }}
    >
      <FiAlertTriangle size={10} style={{ flex: "0 0 auto" }} />
      {stallChip.text}
    </span>
  ) : null;

  // THE THRASH CHIP — the opposite failure to the one above: an agent that never STOPS and never
  // advances. It is not idle, so no gray-row surface would ever mention it; the live case (three
  // `/compact`s in a row, the last one failing) reported `working` throughout and the founder found
  // it by reading the terminal himself. `thrashChipLabel` returns null for BOTH a healthy agent and
  // one this window has no hook events for — the second is "not observed", never "fine".
  const thrashChipEl = thrashLabel ? (
    <span
      data-testid="row-thrash"
      title={thrash?.detail}
      aria-label={`Thrashing — ${thrashLabel}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        flex: "0 0 auto",
        lineHeight: 1.4,
        fontSize: 10,
        fontWeight: FONT_WEIGHT.semibold,
        whiteSpace: "nowrap",
        color: C.amberInk,
      }}
    >
      <FiRepeat size={10} style={{ flex: "0 0 auto" }} />
      {thrashLabel}
    </span>
  ) : null;

  // THE GOAL CHIP, collapsed-row half. EVERY goal state earns a mark here — that is bead
  // sparkle-6kz9q. It used to render for `escalated` ONLY, which made a healthy goal-bearing row
  // pixel-identical to a goal-less one: the founder scanned a fleet in which all 41 agents carried
  // a goal, saw nothing, and reasonably concluded the goals were not real. The data was fine; the
  // column was silent.
  //
  // The row is tight, so a MARK in a constant slot means "this agent has a goal", the GLYPH says
  // which state, the colour reinforces it, and the SIZE keeps escalated the loudest. No visible
  // words in any state — that is measured, not timid; see GOAL_CHIP_ICON's header for the
  // photograph that decided it, and for why the glyph and not only the ink carries the state.
  //
  // Note the deliberate overlap with the stall chip: an escalated goal is ALSO a stall cause, so a
  // resting escalated row shows both. That is not duplication — the stall chip spends the row's one
  // worded slot on the outstanding WORK, this mark says the goal itself has been handed back. They
  // no longer compete for width, because only one of them has text. A WORKING agent (stall verdict
  // `active`) gets no stall chip at all, so on those rows this mark is the only goal signal there
  // is — which is exactly the case bead sparkle-6kz9q was filed about.
  // Capitalized so JSX renders it as a component rather than the literal element `goalchipicon`.
  const GoalChipIcon = GOAL_CHIP_ICON[goalBadge?.state ?? "unmet"];
  const goalChipEl = goalBadge ? (
    <span
      // ONE testid for all four states, with the state as a DATA ATTRIBUTE. A per-state testid
      // would force a reader to know every state's name to ask "does this row have a goal at all",
      // which is the founder's actual question; and it would leave the state itself assertable only
      // by sniffing a colour.
      data-testid="row-goal"
      data-goal-state={goalBadge.state}
      // CLICKABLE NOW, and that is the founder's second scope addition rather than a flourish: the
      // blue target and the red octagon were MARKS with no onClick, on the premise that their words
      // stayed recoverable through this `title`, the `aria-label` below and the detail card. He is a
      // sighted mouse user, went straight for a click, got silence, and could not recover the
      // meaning at all — *"I really don't know what's going on"*. So the words get the route he
      // actually took. Same gesture as every other mark: mount, and open the pill that explains it.
      title={`Goal: ${goalBadge.text} — ${goalBadge.label} · click to explain it above the composer`}
      onClick={(e) => {
        e.stopPropagation();
        openNoticePill(`goal:${goalBadge.state}`);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.stopPropagation();
        e.preventDefault();
        openNoticePill(`goal:${goalBadge.state}`);
      }}
      tabIndex={0}
      // `role="button"`, NOT `role="img"` as it was. The chip is operable now, and an operable
      // control announced as an image is a control a keyboard or screen-reader user cannot find —
      // the `aria-label` below is still its accessible name either way, so nothing is lost by
      // naming it what it now is. (It was `img` because a bare generic span does not reliably
      // announce an `aria-label`; `button` has the same property and is true.)
      role="button"
      // The state, NAMED. Colour is not an accessible channel, and the `met`/`unmet` chips have no
      // visible text at all — without this a screen reader reaches an empty span on the two most
      // common rows in the fleet.
      aria-label={`${GOAL_CHIP_A11Y[goalBadge.state](goalBadge)} — ${goalBadge.text}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        lineHeight: 1.4,
        fontSize: 10,
        whiteSpace: "nowrap",
        color: GOAL_CHIP_COLOR[goalBadge.state],
        // NEVER SHRINKS. The chip's entire content is the icon, so a shrink factor would clip the
        // one mark this change exists to make visible, to save ~13px.
        flex: "0 0 auto",
      }}
    >
      <GoalChipIcon size={GOAL_CHIP_SIZE[goalBadge.state]} style={{ flex: "0 0 auto" }} />
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
        // The epic pill lives on a row in THIS column, so the board it opens is THIS column's.
        // `paneSide` is the row's own pair (handed down from the sidebar's `pairSide`) — using it
        // is what stops a left-column pill from opening the epic in the right column's board.
        //
        // openPlanBoard, not a bare setWorkMode: this means "show me the board", and the payload
        // below is a ONE-SHOT that BoardView consumes on mount — against a board the Sparkle pane
        // is covering, the handoff is spent on a surface that never renders and the overlay simply
        // never opens (roborev 55887).
        ui.openPlanBoard(paneSide);
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

  // ══ THE ROW PREVIEW PILL — "what appears unasked is a pill, not a pane" ═══════════════════════
  //
  // Design doc §10's condition zero, and the reason the auto-open feature is safe to ship at all:
  // the passive half of it. Twenty agents finishing a build within a minute of each other produce
  // twenty PILLS, which is a column that tells you where to look; the same twenty as panes is the
  // outcome §10 calls "strictly worse than no feature".
  //
  // IT IS UNCONDITIONAL ON ANY POLICY, deliberately, and that is the thing most likely to be
  // "simplified" later. There used to be a five-condition conjunction deciding whether a preview
  // PANE could open unasked (`previewOpenOutcomeFor`, plus a `[preview].auto_open` key), and the
  // pill was pointedly NOT routed through it: that conjunction gated the thing that could take the
  // screen, while a pill steals nothing. Both the pane and the conjunction are gone (founder,
  // 2026-08-19), so there is no policy left to be tempted by — but the property still matters and
  // is still pinned: the pill shows for a project nobody has previewed by hand, which is how a
  // first preview becomes discoverable at all. Gating it on prior use would make the feature
  // visible only to people already using it. `AgentSidebar.previewPill.test.tsx` holds that line.
  //
  // TWO CONDITIONS, and they are both "is there something you are not looking at":
  //   • a LIVE server with a url — `listening`/`ready`/`serving`. Not `starting` (nothing to point
  //     at yet) and not `failed`/`crashed`/`stopped` (the pane's job to explain, not the row's; a
  //     wordless mark on a dead server is an alarm with no action attached).
  //
  //     WIDER THAN `previewStore.isSurfacingState`, which stops at `ready`/`serving`, and the gap
  //     is not drift. That set decides whether to OPEN A PANE, where `listening` is wrong because
  //     the port is bound before the first build finishes and the pane would fill with the
  //     framework's own compiling page. A pill saying ":5173" at `listening` is simply true, and
  //     costs the reader nothing if the page behind it is still building.
  //   There USED to be a second condition — "the pane is not already showing it" — because a
  //   preview pane could fill this pair. That pane is gone (founder, 2026-08-19: a preview is a card
  //   in the concierge chat, not a peer column), so a live preview is ALWAYS off-screen from this
  //   row's point of view and the pill is always the honest readout.
  //
  // A READOUT, NOT AN ACTION — no `onClick`. Every other pill in this strip is a jump (`epicPill`,
  // `feedbackPill`), and the temptation is to make this one open the pane. That is precisely the
  // interruption the design refuses: the row says "there is something here", and the user decides.
  // Sized like `row-stall`: `fontSize: 10`, an icon plus the shortest true label (the port), with
  // the full url and state on the tooltip for whoever needs it.
  const previewPillEl =
    previewEntry &&
    previewEntry.url &&
    (previewEntry.status === "listening" ||
      previewEntry.status === "ready" ||
      previewEntry.status === "serving") ? (
      <span
        data-testid="row-preview"
        title={`Preview ${previewEntry.status} — ${previewEntry.url}`}
        aria-label={`Preview ${previewEntry.status} at ${previewEntry.url}`}
        style={{
          // `flex: 0 0 auto` and OUTSIDE the clipping name box (see where it renders): the name box
          // is `minWidth: 0; overflow: hidden`, so a trailing child of it is simply cut off on a
          // narrow column — which is how the retirement mark nearly vanished on exactly the rows
          // that had one.
          flex: "0 0 auto",
          display: "inline-flex",
          alignItems: "center",
          gap: 2,
          lineHeight: 1.4,
          fontSize: 10,
          fontFamily: FONT_MONO,
          // MUTED, not an accent. A live dev server is good news, and good news that draws the eye
          // as hard as a stall does makes the column's ink stop meaning anything.
          color: C.muted,
        }}
      >
        <FiMonitor size={10} style={{ flex: "0 0 auto" }} />
        {previewEntry.port ?? ""}
      </span>
    ) : null;

  // The FEEDBACK pill (feedback-pill-and-filter): a build-agent row's affordance to jump to the Plan
  // board filtered to JUST that agent's feedback — the beads labeled `agent:<id>` it created or
  // commented on. Mirrors epicPill's handoff (stopPropagation so it doesn't select the row; flip to
  // Plan → board), but sets boardAgentFilter instead of boardFocusBeadId. Shown ONLY on build rows
  // that actually have feedback (feedbackCount ≥ 1), so a row with nothing to show never offers a
  // dead click. Styled like StageChip (bordered, mono, micro, muted) but with an accent border +
  // cursor:pointer so it reads as an action rather than a status readout — structure drawn, not filled.
  const feedbackPill =
    a.kind === "build" && feedbackCount > 0 ? (
      <span
        data-testid="row-feedback-pill"
        onClick={(e) => {
          e.stopPropagation();
          const ui = useUiStore.getState();
          // THIS ROW'S OWN COLUMN, like epicPill above. This landed on main written against the
          // window-global mode + `activeSpecial: "board"`, which is the singleton this branch
          // removes — left as-is it would open the left column's feedback in the RIGHT column's
          // board, which is the reported bug wearing a different hat.
          // openPlanBoard for the same reason as the epic pill above — this pill means "show me
          // the board", and a bare mode write leaves the Sparkle pane covering it while the filter
          // is silently recorded against a surface that is not on screen.
          ui.openPlanBoard(paneSide);
          // BOTH writes take the row's own column. Migrating only the mode left the payload
          // window-global, so a left row's pill still narrowed the right column's board.
          ui.setBoardAgentFilter(paneSide, a.id);
        }}
        title={`${feedbackCount} feedback ${feedbackCount === 1 ? "bead" : "beads"} from this agent — open in Plan`}
        style={{
          flex: "0 0 auto",
          // A FLEX CONTAINER, because the compact branch below puts an <svg> beside a number. In an
          // inline span an SVG aligns to the TEXT BASELINE — the glyph rides high against the digits
          // and the descender grows the pill's line box, on the one row element whose pixel budget
          // this whole change is about — and `flex: "0 0 auto"` on the icon is inert with no flex
          // parent to honour it. Every sibling that pairs a glyph with a count (the goal chip, the
          // notice mark) already does this; the wide branch is a bare string, which is why the
          // omission was invisible until the compact form existed.
          display: "inline-flex",
          alignItems: "center",
          gap: 2,
          fontFamily: FONT_MONO,
          fontSize: TYPE.micro,
          lineHeight: 1,
          color: C.accentInk,
          border: `1px solid ${C.accentInk}`,
          borderRadius: RADIUS.sm,
          padding: "1px 5px",
          whiteSpace: "nowrap",
          cursor: "pointer",
        }}
      >
        {/* THE WORD GOES ON A NARROW COLUMN; THE PILL DOES NOT. Bead sparkle-tyter.
             "FEEDBACK 18" is ~70px of a 183px row — by far the widest thing in the tail, wider
             than the stage chip it replaces. Measured with the fixture finally seeding beads,
             `row-narrow-probe` found it starving the name back to 9 characters on exactly the rows
             that have feedback, and pushing the row's warning mark clean outside the clip — a
             notice hidden, which is the one outcome this row may never produce.
             Hiding the pill is not the answer: it is the ACTIONABLE thing in that slot and the
             founder asked for it there. So it degrades like everything else on this row — the
             glyph and the count survive (a count is the part that cannot be inferred), the word is
             what goes, and the full label stays on the hover title. */}
        {stageChipShows(columnWidth ?? 0) ? (
          `FEEDBACK ${feedbackCount}`
        ) : (
          <>
            <FiMessageSquare size={10} style={{ flex: "0 0 auto" }} />
            {feedbackCount}
          </>
        )}
      </span>
    ) : null;

  // THE RETIREMENT PILL (bead sparkle-0l9xk). The founder asked for "an informational pill, kind of
  // like the plan pill... recommending that the agent be fully retired because it is done and the
  // feedback has been completed and logged."
  //
  // INFORMATIONAL, NEVER AN ALARM. Both states take the calm accent ink and the same bordered,
  // drawn-not-filled treatment as `feedbackPill` above — never `C.sienna`/`C.dangerInk`, and no
  // warning glyph. It contributes NOTHING to the row's status dot, its band, or the filter chips:
  // `retirementPill` is a derived overlay read alongside `AgentTabStatus`, exactly as `rollupDot`
  // is, and engine/retirementReadiness.test.ts locks that. Routing it through `bandOfStatus` to
  // make it filterable would land it in `needs_you` — the false "N agents need you" that
  // buildSections.ts warns about — or in `done`, where it would be invisible. Neither is a pill.
  //
  // Clicking is the SAME action as the row's ×: it opens the retirement confirm. That is deliberate
  // — the pill's whole message is "this one is ready to go", so the obvious click must be the thing
  // it is recommending, and the human still confirms in the dialog either way.
  const retirePillState = retirementPill({
    kind: a.kind,
    // `trackerStage` is the row's already-resolved stage, threaded down by the column. Re-deriving
    // it here from a second source is how the row and the × would come to disagree about whether an
    // agent has landed — and they must not, since one paints the pill and the other opens the gate.
    stage: trackerStage ?? "thought",
    receipt: cachedReceipt(project.id, a.id),
  });
  // WHAT THIS ROW WANTS FROM THE FOUNDER, IN WORDS (engine/founderAsk). His complaint about a
  // finished agent: *"why it is showing as blocked"* — he opened it expecting a problem and found a
  // completed job. "Needs you" reads identically on a row awaiting a one-press confirm and on one
  // wedged mid-task, so every red cost him a pane-open to classify.
  //
  // The engine decides; this only renders. In particular it CANNOT redden a row — `askFor` reads the
  // status the taxonomy already settled, and returns `null` for every calm row (including a calm
  // retirement-ready one, which keeps its informational pill and stays gray).
  const founderAsk = askFor({ status: st });
  // ONE handler for both the click and the key, so the two can never drift. Every ask this module
  // can raise is answered IN THE PANE, so the action is always "select this row and let him read
  // it". It deliberately does NOT branch on a confirmation: there is no confirmation arm today, and
  // a dormant `onClose()` branch here would mean a future arm silently inherited the retirement
  // confirm as its action (roborev on 6b68205d3). Give that arm its own action when it lands.
  const askAction = () => onSelect?.();
  const askPill = founderAsk ? (
    <span
      data-testid="row-founder-ask"
      data-ask={founderAsk}
      // OPERABLE, not merely announced as operable — the same defect `retireMark` below already had
      // fixed once (roborev 59545), and this element reintroduced it: an `aria-label` on a role-less
      // <span> is not reliably exposed, and a click-only handler is unreachable from a keyboard
      // entirely. Mirrors that element exactly rather than inventing a second pattern.
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        askAction();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.stopPropagation();
        // Space would scroll the list out from under whatever the action opens.
        e.preventDefault();
        askAction();
      }}
      title={FOUNDER_ASK_DETAIL[founderAsk]}
      aria-label={`${FOUNDER_ASK_LABEL[founderAsk]} — ${FOUNDER_ASK_DETAIL[founderAsk]}`}
      style={{
        flex: "0 0 auto",
        fontFamily: FONT_MONO,
        fontSize: TYPE.micro,
        lineHeight: 1,
        // The row's own status colour, so "something is wrong" still looks wrong. When a
        // CONFIRMATION arm lands it must NOT take this ink — see the note in engine/founderAsk.
        color: statusColor,
        border: `1px solid ${statusColor}`,
        borderRadius: RADIUS.sm,
        padding: "1px 5px",
        whiteSpace: "nowrap",
        cursor: "pointer",
      }}
    >
      {FOUNDER_ASK_LABEL[founderAsk]}
    </span>
  ) : null;

  const retirePill = retirePillState ? (
    <span
      data-testid="row-retire-pill"
      data-retire-state={retirePillState}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      title={RETIRE_COPY[retirePillState].title}
      style={{
        flex: "0 0 auto",
        fontFamily: FONT_MONO,
        fontSize: TYPE.micro,
        lineHeight: 1,
        // `accentInk` for both states, differing only in border weight — the pending one is a
        // quieter draw of the same idea, not a different severity. A second colour here would be
        // the start of the fourth-hue drift tokens.ts spent a paragraph refusing.
        color: C.accentInk,
        border: `1px solid ${retirePillState === "ready" ? C.accentInk : C.hairline}`,
        borderRadius: RADIUS.sm,
        padding: "1px 5px",
        whiteSpace: "nowrap",
        cursor: "pointer",
      }}
    >
      {retirePillState === "ready" ? "READY TO RETIRE" : "RETRO PENDING"}
    </span>
  ) : null;

  // THE SAME FACT, WORDLESS, FOR THE COLLAPSED ROW (roborev 59482). The merge resolution above sent
  // the worded pill to the expanded card, because `main` had just stripped 18ch text pills off this
  // row for width (bead sparkle-tyter). Correct for the WORDS — but it left the recommendation with
  // no surface on the scannable list at all, which is precisely the gap the PRD names as the thing
  // this feature exists to close ("It has no surface on the build row at all — that absence is the
  // pill the founder asked for"). A recommendation you can only find by hovering one row at a time
  // is not a recommendation.
  //
  // So the row gets a MARK, on `cloudChip`'s terms: a single 11px icon carrying no text, which is
  // the shape the merge comment already identifies as too cheap to reproduce the collision. Same
  // click as the pill and the × — it opens the retirement confirm — and the words it replaces ride
  // in the tooltip and the accessible name.
  //
  // NOT a notice mark. `noticeMarksEl` is the WARNING class (amber, `agentNotices`), and routing
  // retirement through it would make an informational recommendation an alarm — the one thing the
  // founder explicitly did not ask for. Accent ink when ready, muted while the retro is still owed:
  // a quieter draw of one idea, never a second severity.
  const retireMark = retirePillState ? (
    <span
      data-testid="row-retire-mark"
      data-retire-state={retirePillState}
      role="button"
      // OPERABLE, not merely announced as operable (roborev 59545). `role="button"` without a tab
      // stop and a key handler is a control a keyboard or screen-reader user can hear and cannot
      // press — and this mark is now the ONLY surface the recommendation has on the scannable list
      // (the worded pill lives one hover away, and a hover is not a keyboard gesture), so the whole
      // feature was unreachable that way. Both sibling marks on this row — `goalChipEl` and
      // `noticeMarksEl` — already carry exactly this trio; the mark was the odd one out.
      tabIndex={0}
      aria-label={RETIRE_COPY[retirePillState].a11y}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.stopPropagation();
        // Space would scroll the list out from under the dialog that is about to open.
        e.preventDefault();
        onClose();
      }}
      title={RETIRE_COPY[retirePillState].title}
      style={{
        display: "inline-flex",
        flex: "0 0 auto",
        lineHeight: 1,
        cursor: "pointer",
        color: retirePillState === "ready" ? C.accentInk : C.muted,
      }}
    >
      <FiArchive size={11} />
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
              // NAMES THE ASK WHEN THERE IS ONE. `AGENT_STATUS[st].label` describes the AGENT's
              // condition ("Blocked", "Needs you"); the ask describes the FOUNDER's next action,
              // which is what he was missing. Falls back to the status label for every calm row,
              // where there is no ask and the condition is the only thing to say.
              title={
                founderAsk
                  ? `${a.kind} — ${FOUNDER_ASK_LABEL[founderAsk]}`
                  : `${a.kind} — ${AGENT_STATUS[st].label}`
              }
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
            // The disc hovers as the ASK when there is one, so the scannable row is not the one
            // surface that still says only "Blocked". `dotLabel` (the orchestrator rollup override)
            // still wins where it is set — it describes a SUBTREE, which the row's own ask does not.
            <StatusDot
              status={st}
              size={DOT_SIZE}
              color={dotColor}
              variant={dotRing ? "ring" : "fill"}
              label={dotLabel ?? (founderAsk ? FOUNDER_ASK_LABEL[founderAsk] : undefined)}
            />
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
            // rows beneath it. RIGHT-click the line for the row's menu — same affordance as
            // collapsed, and it needs its OWN handler rather than inheriting the row's: this line
            // is drawn inside the card, which is `createPortal`'d as a SIBLING of the row element,
            // so nothing here propagates to the row's `onContextMenu` at all.
            // No title tooltip (the user finds it noise). gap:8 matches the collapsed row.
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, height: GLYPH_SLOT_H }}>
              {lastTouchAt != null && (
                <ElapsedTimer since={lastTouchAt} now={clockNow} color={metaColor} />
              )}
              <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 4 }}>
                <div
                  onContextMenu={openRowMenu}
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
                      fontWeight: rowTitleWeight(isActive),
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
                {/* Same overlay on the EXPANDED strip. The card stands in for the in-flow row while
                    it is open, so omitting them here would make the signal vanish from the one row
                    the user has actually stopped on. */}
                <AgentInboxBadge agentId={a.id} />
                {goalChipEl}
                {stallChipEl}
                {thrashChipEl}
                {epicPill}
                {/* FIRST of the pills, ahead of the retirement one: it is the only chip that names
                    an action the founder takes, and a row carrying both would otherwise lead with
                    the statement rather than the request. */}
                {askPill}
                {retirePill}
                {/* Same ambient mark on the EXPANDED strip, under the rule the comment above
                    `AgentInboxBadge` states for this whole cluster: the card stands in for the
                    in-flow row while it is open, so omitting it here makes the signal vanish from
                    the one row the user has actually stopped on. */}
                {previewPillEl}
                {cloudChip}
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
            //
            // `overflow: hidden` for the same reason the name+chips box inside it carries one, and
            // it has to be BOTH. This box's siblings include the trailing × slot, so when it is
            // squeezed its children paint over the CLOSE CONTROL instead — `row-narrow-probe`
            // measured the name overlapping [×] by 273px² at a 160px column. Clipping only the
            // inner box moved the collision up a level rather than ending it, which is the shape
            // every previous pass at this row got wrong: a fix verified where it was looked for.
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                minWidth: 0,
                overflow: "hidden",
                height: GLYPH_SLOT_H,
              }}
            >
              {/* THE TIMER IS THE THIRD AND LAST THING TO YIELD, under the same rule as the stage
                  chip and the × — chrome gives way to the name when the column is narrow, and the
                  expanded card (which renders this same timer) is where it goes.
                  It is here because it was measured, not guessed: with the fixture finally seeding
                  feedback beads, `row-narrow-probe` found the worst 220px row fully packed —
                  24px disc + 18px timer + a name PINNED AT ITS 64px FLOOR + an 18px collapsed mark
                  + a 28px feedback pill = 182 of 183px. Nothing was overlapping and nothing was
                  hidden; there was simply no slack left, so the name could not reach a readable
                  length while the timer held its 26px (with gap). "24m" is metadata — how long
                  since the last prompt — while the name is what the row is FOR. */}
              {lastTouchAt != null && stageChipShows(columnWidth ?? 0) && (
                <ElapsedTimer since={lastTouchAt} now={clockNow} color={metaColor} />
              )}
              {/* `overflow: hidden` IS THE ANTI-OVERLAP FIX, and it is structural rather than a
                  tuning. This container is `minWidth: 0` ("shrink me first") while its children are
                  `flex: 0 0 auto` chips plus a name carrying a hard `AGENT_NAME_MIN_WIDTH_PX`
                  floor — a min-content width this box is routinely squeezed below. With visible
                  overflow the children simply PAINT PAST its right edge, over the stage chip that
                  follows: `row-narrow-probe` measured the name's box overlapping "Unsaved" by
                  269px² at the default 220px column, which is the two-labels-in-one-place the
                  founder photographed (FEEDBACK 3 and Looping painted in the same pixels).
                  Clipping here cannot be re-opened by the next chip anyone adds, which a
                  bounded-width convention on each chip can. It is paired with the collapse below —
                  clipping ALONE would silently swallow a mark that says something needs him, and
                  hiding that is the one thing this row may never do. */}
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  minWidth: 0,
                  overflow: "hidden",
                }}
              >
                <FittedAgentName
                  title={autoTitle}
                  name={a.name}
                  color={nameColor}
                  active={isActive}
                  // Below the width where a readable name is achievable, the floor drops so a
                  // notice mark is never pushed out of the clip by letters nobody can act on.
                  // `agentNameFloorFor` owns that decision and its OWN threshold: this used to read
                  // `stageChipShows(...) ? wide : tight`, which borrowed the stage chip's 260 for a
                  // rule documented at 220 and so applied the 16px floor across the whole 220–259
                  // band — including the default width. See AGENT_NAME_TIGHT_FLOOR_BELOW_PX.
                  minWidthPx={agentNameFloorFor(columnWidth ?? 0)}
                />
                {workerCountBadge}
                {/* "Someone has queued instructions for this agent, and it has not seen them yet."
                    Leads the chips beside the never-idle overlay because it is the one mark on a
                    calm row that says work is INBOUND rather than describing work already done —
                    and because its absence is what made the concierge's "I sent it" uncheckable
                    (bead sparkle-zm0c8). Renders nothing when the queue is empty. */}
                <AgentInboxBadge agentId={a.id} />
                {unjudgedAskChip}
                {/* THE NAME WINS, so on a narrow column the goal chip and the notice marks fold
                    into ONE affordance instead of each taking a slot — see
                    `noticeClusterCollapses`. Wide, they render separately exactly as before; this
                    is a degradation, not a removal, and the collapsed mark keeps the worst ink and
                    every label it stands for. */}
                {clusterCollapsed ? (
                  collapsedClusterEl
                ) : (
                  <>
                    {/* The never-idle overlay leads the metadata chips: it is the one thing on a
                        calm row that changes what you do about it. See the chip definitions
                        above. */}
                    {goalChipEl}
                {/* ONE WORDLESS MARK PER NOTICE CLASS, replacing the stall and thrash chips that
                    used to render their labels here and squeeze the name to zero (bead
                    sparkle-tyter — see `noticeMarksEl`). The words live on the hover and in the
                    pills above the composer.

                    `epicPill` LEFT THIS ROW with them, at the founder's call ("move it to the hover
                    card"): it is not a notice, it is a jump-to-Plan link, and — the part that
                    matters for this bead — it is a TEXT pill up to 18ch wide, so it was the row's
                    other real width consumer. It still renders on the expanded card, one hover away.

                    `cloudChip` STAYED, and that is a deliberate departure from the same instruction.
                    He asked for both to move; the cloud glyph turns out to be SPEC'd — Service B,
                    §Creation UX, "Cloud rows get a small cloud glyph next to the name; no other
                    visual difference" — and pinned by AgentSidebar.cloudGlyph.test.tsx. It is also
                    the cheap one: a single 11px icon, only on cloud rows, carrying no text at all,
                    so it cannot reproduce the collision this bead exists to fix. Removing a spec'd
                    affordance to save 11px on a subset of rows was not what he was buying. Flagged
                    back to him rather than done silently.

                    That leaves the collapsed row at three icon slots (goal · warnings · mailbox),
                    plus the rare cloud mark and one right-hand pill — the budget he asked for:
                    "one, two, or maybe three max". */}
                    {noticeMarksEl}
                  </>
                )}
                {cloudChip}
              </div>
              {/* OUTSIDE THE CLUSTER **AND OUTSIDE THE CLIP**, both on purpose (roborev 59785).
                  `main` folds the goal chip and the notice marks into one affordance on a narrow
                  column; the retirement mark is not one of them. The cluster stands for things
                  that are HAPPENING to a row (a goal, a stall, a thrash) and opens the composer;
                  this stands for an action the founder takes ON the row and opens the retire
                  confirm, so folding it in would give the collapsed mark two different meanings and
                  one click that can only serve one of them.

                  But sitting beside the cluster INSIDE the name box — where the merge first put it —
                  bought the separation at the price of the mark itself. That box is `minWidth: 0`
                  with `overflow: hidden`, so it is the thing flexbox shrinks first and its trailing
                  children are simply CUT OFF; and `clusterMarkCount` counts only notice marks and
                  the goal, so the collapse can never buy space for this one. The row's own measured
                  budget says that is not hypothetical: `row-narrow-probe` read the worst 220px row —
                  the width the app opens at — at 182 of 183px WITHOUT it, so an 11px glyph plus its
                  gap is over budget by construction, and the recommendation would vanish silently on
                  exactly the rows that have one.

                  So it lives here instead: a `flex: 0 0 auto` sibling of the name box rather than a
                  child of it, in the same slot band as the stage chip below. Flexbox shrinks the
                  `flex: 1, minWidth: 0` name box to zero before it overflows a fixed sibling, so this
                  mark cannot be clipped at any width — which is what "the only scannable surface the
                  recommendation has" has to mean (roborev 59482). The WORDED pill (RETRO PENDING /
                  READY TO RETIRE) stays on the expanded card where `main` sent `epicPill`, which is
                  the part of sparkle-tyter's width budget that actually bound. */}
              {retireMark}
              {/* THE PREVIEW PILL, in the same band as `retireMark` above and for the identical
                  reason: a `flex: 0 0 auto` SIBLING of the name box rather than a child of it.
                  Inside that box it would be clipped away on a narrow column (`minWidth: 0` +
                  `overflow: hidden` make it the first thing flexbox shrinks), and `clusterMarkCount`
                  counts only notice marks and the goal, so the collapse can never buy space for it.
                  It is also cheap by construction — an 11px glyph plus a 4-digit port, only on the
                  rows that actually have a live server, which is a small subset at any moment. */}
              {previewPillEl}
              {/* `.stg` — LAST before the close slot, exactly as the mock orders the row
                  (dot · el · nm · stg · close). Outside the name container so the title ellipsizes
                  against it rather than pushing it off the row. Collapsed only: the card already
                  renders the full WorkflowLine for this stage, and two readings of one fact in one
                  view is the thing the row was stripped down to avoid. */}
              {/* ONE PILL IN THIS SLOT, NEVER TWO. Bead sparkle-tyter, the founder verbatim:
                  *"If an agent has provided feedback then it should say 'feedback' instead of
                  'shift' or whatever. The feedback label should go where the PR or shift, etc.,
                  label goes when there is feedback."* ("shift" is dictation for "Shipped".)

                  They used to render side by side, which spent two pill-widths of the row's tail on
                  a row that also had to fit a name. Feedback WINS when there is any: it is the
                  actionable one (it opens this agent's feedback in Plan), while the stage chip is a
                  status readout the section heading above the row already carries.

                  The stage chip additionally goes silent on a narrow column and on the "nothing
                  built yet" case — both inside StageChip, so every caller gets the same rule. */}
              {feedbackPill ?? (
                trackerStage && (
                  <StageChip
                    stage={trackerStage}
                    active={isActive}
                    section={rowSection}
                    columnWidth={columnWidth}
                  />
                )
              )}
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
          {/* TIMESTAMPED QUOTE, never present-tense state (bead sparkle-s8y5t6). `activity` is a
              self-report; rendered bare it reads as what the agent is doing NOW, so a line left
              behind by an agent that has since died or gone silent looks live for hours. We stamp
              its age from `activityAt` and, once STALE, mark it explicitly as a past quote ("said …
              · Nm ago") in italics — so a stale self-report can never masquerade as current, and
              liveness is judged from the row's real status/tool activity instead of this prose. */}
          {expanded &&
            a.activity?.trim() &&
            (() => {
              // Read staleness off the ROW'S shared clock (clockNow), not a bare Date.now(): the
              // row already subscribes to it (see useRowClock above), so the fresh→stale transition
              // re-renders on its own, and a component test can drive it with a controlled `now`.
              const stale = isActivityStale(a.activityAt, clockNow);
              const age = formatActivityAge(a.activityAt, clockNow);
              const label = stale
                ? `said “${a.activity}”${age ? ` · ${age}` : " · age unknown"}`
                : a.activity;
              return (
                <div
                  title={stale ? `Self-reported${age ? ` ${age}` : " (age unknown)"}: ${a.activity}` : a.activity}
                  style={{
                    color: C.muted,
                    fontSize: 12,
                    lineHeight: 1.3,
                    marginTop: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: "100%",
                    fontStyle: stale ? "italic" : undefined,
                    opacity: stale ? 0.75 : undefined,
                  }}
                >
                  {label}
                </div>
              );
            })()}
          {/* The thin progress line under the title, with a status label to its right.

              CARD ONLY, for the same reason as the activity line above — and one more specific to
              it: the column is now GROUPED BY STAGE (the ladder sections), so a per-row bar was
              re-encoding, in a 2px gradient, the thing the section header above it already states
              in words. Two renderings of one fact, the smaller one unreadable. */}
          {expanded && trackerStage && (
            // ANCHORED so an AgentSidebar-level test can prove the card actually RECEIVES
            // `rowSection` (roborev 57902). WorkflowLine's own tests cover the copy rule, but nothing
            // asserted the wiring — deleting `section={rowSection}` here left the whole suite green,
            // and an unverified path is exactly how this lie survived the two previous fixes.
            <div style={{ marginTop: 1 }} data-testid="card-workflow-line">
              <WorkflowLine stage={trackerStage} expanded={expanded} section={rowSection} />
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
        {/* ON A NARROW COLUMN THE COLLAPSED ROW GIVES THIS SLOT BACK TO THE NAME, and it is the
            single largest thing left that can be given back: the slot plus its gap is 32px of a
            183px row — `row-narrow-probe` measured the active row's name at 66px (9 characters)
            with it, and 98px (13) without, against every other row in the column already passing.
            It was the last reason the founder's own row — the one he is working in — stayed the
            least readable one on screen.

            NOT A REMOVAL: `expanded` still renders it, and the expanded card is one hover away on
            the very row this drops it from. That is the same trade the stage chip and the epic pill
            already take (`STAGE_CHIP_MIN_COLUMN_PX`, `epicPill`), so the column has ONE rule —
            chrome yields to the name when the column is narrow, and the card is where it goes —
            rather than a third convention. Wide columns are untouched. */}
        {(expanded || (isActive && stageChipShows(columnWidth ?? 0))) && (
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
      {/* "MOVE TO CLOUD" — promotion (bead sparkle-8zpvc). The card is where a row's actions live
          (Land, rebase, the model picker, the path reveal), so this belongs here rather than as one
          more control on the dense in-flow row.

          THREE CONDITIONS, AND THE LAST IS JUST "SIGNED IN":
            • `runtime === "local"` — there is nothing to promote about an agent already in a sandbox;
            • `kind === "build"` — a shell agent has no conversation and no branch (spec §Not in scope);
            • `cloudOfferable` — the SAME `cloudOptionVisible` gate the creation flow uses, which is
              now only "is this user signed in". It used to also require an advertised capability,
              which hid the item from everyone — and a control that vanishes cannot say why.
          The rest of the precondition ladder (Claude auth / credits) is the DIALOG's job — it can
          state the block and deep-link the fix, which a missing menu item cannot. */}
      {a.runtime === "local" && a.kind === "build" && cloudOfferable && (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            data-testid="promote-to-cloud"
            onClick={(e) => {
              e.stopPropagation(); // the card's own onClick re-selects the agent
              openPromoteToCloud(a.id);
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "transparent",
              color: C.cream,
              border: `1px solid ${C.muted}`,
              borderRadius: RADIUS.sm,
              padding: "4px 9px",
              cursor: "pointer",
              fontSize: 12,
              fontFamily: FONT_UI,
            }}
          >
            <FiUploadCloud size={12} />
            Move to cloud…
          </button>
        </div>
      )}
      {/* "BRING DOWN TO LOCAL" — demotion, the mirror of the item above (plan §W4).

          TWO CONDITIONS, AND ONLY TWO:
            • `runtime === "cloud"` — there is nothing to bring down from an agent already here;
            • `kind === "build"` — a shell agent has no conversation and no branch (spec §Not in scope).

          What is deliberately ABSENT from that list is the point. There is no `cloudOfferable`
          check: a cloud tab is a running sandbox, so gating its exit on anything would strand it.
          And there is no `evaluateCloudGate`
          check: a user whose credits ran out is exactly the user who needs to bring work down, and
          a gate that hides the exit is a trap. */}
      {a.runtime === "cloud" && a.kind === "build" && (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            data-testid="demote-to-local"
            onClick={(e) => {
              e.stopPropagation(); // the card's own onClick re-selects the agent
              openDemoteToLocal(a.id);
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "transparent",
              color: C.cream,
              border: `1px solid ${C.muted}`,
              borderRadius: RADIUS.sm,
              padding: "4px 9px",
              cursor: "pointer",
              fontSize: 12,
              fontFamily: FONT_UI,
            }}
          >
            <FiDownloadCloud size={12} />
            Bring down to local…
          </button>
        </div>
      )}
      {/* "PREVIEW" — start this agent's dev server (design §8: "the card is where a row's actions
          live"), sibling of the two cloud items above and gated the same way. THE ONE PLACE A PERSON
          STARTS A PREVIEW BY HAND, now that the toggle's Preview segment is gone; what it produces
          is a card in the concierge chat, not a pane.

          TWO CONDITIONS, AND BOTH ARE "COULD THIS POSSIBLY WORK":
            • `previewOfferable` — `preview_capability` said yes for this project. ABSENT when it
              said no, and absent while it has not answered. §7 rule 5, and ColumnPullTab.tsx:130
              verbatim: "an affordance that does nothing is worse than an absent one." Never greyed;
              a disabled control here would be a promise with no way to learn why it is broken.
            • `a.worktreePath` — a preview server runs IN a worktree. An agent that has not been
              given one yet has nowhere to run it, and offering the button anyway would spend a
              round trip to produce an error about a state the row can already see. It is not a
              permanent no: the item appears when the worktree does. */}
      {previewOfferable && a.worktreePath && (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            data-testid="open-preview"
            onClick={(e) => {
              e.stopPropagation(); // the card's own onClick re-selects the agent
              // NO PANE TO OPEN ANY MORE — this button starts a SERVER, and the surface that shows
              // it is the concierge card (`Concierge/PreviewCards.tsx`), which appears on its own
              // the moment the server reaches `ready`/`serving`. It used to also flip this column
              // into Preview mode; that mode and its pane are gone (founder, 2026-08-19).
              //
              // THE FEEDBACK GAP THAT PAIRS WITH THAT is real and is covered elsewhere rather than
              // ignored: a dev server takes seconds to come up, so between this click and the card
              // appearing there is a silence. The row's own ambient preview pill fills it — it
              // shows from `listening`, i.e. as soon as a port is bound, which is earlier than the
              // card's `ready`/`serving` gate.
              void openPreviewServer({
                agentId: a.id,
                projectId: project.id,
                worktree: a.worktreePath!,
                // THIS BUTTON IS THE ONE PLACE A PERSON OPENS A PREVIEW BY HAND, which is what
                // condition 2 of the auto-open conjunction is asking about ("the user has opened a
                // preview for this project at least once this session"). The flag is fail-closed —
                // `openPreviewServer` treats an absent `initiator` as an agent — because the other
                // caller is `controlListener.handlePreview`, i.e. an AGENT opening its own preview
                // through the control bridge, and letting that count would let an agent manufacture
                // the returning-user signal that licenses a pane to open unasked.
                initiator: "user",
              }).catch((err: unknown) => {
                // ONE REJECTION IS NOT A FAILURE: a click landing while this agent's own start is
                // still in flight is REFUSED by the Rust reservation (which is what stops a second
                // dev server), and that start is still running and will populate this pane by
                // event. Painting `failed` over it would report a broken preview for the one case
                // where nothing is wrong — and the pane's failed state is terminal, so the honest
                // "starting…" would never come back.
                if (String(err).includes(PREVIEW_ALREADY_STARTING)) return;
                // A REJECTED INVOKE PRODUCES NO EVENT, so nothing else would ever write this
                // agent's entry and the pane would sit on "starting…" for good. Record the failure
                // ourselves — the pane's failed state exists precisely so a server that dies before
                // it listens says so instead of showing a blank white frame.
                setPreviewEntry(a.id, {
                  id: null,
                  status: "failed",
                  url: null,
                  port: null,
                  error: String(err),
                });
              });
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "transparent",
              color: C.cream,
              border: `1px solid ${C.muted}`,
              borderRadius: RADIUS.sm,
              padding: "4px 9px",
              cursor: "pointer",
              fontSize: 12,
              fontFamily: FONT_UI,
            }}
          >
            <FiMonitor size={12} />
            Preview
          </button>
        </div>
      )}
      {/* THE GOAL, in its own words, with its life state. The column can only afford the escalated
          case (see goalChipEl); this is where "active · 3h 20m left" and the goal TEXT live, which
          is what makes the row's chip actionable instead of merely alarming. The remaining time is a
          bound on how long auto-continue may keep spending on it, not a deadline for the work. */}
      {goalBadge && (
        <DetailLine label="Goal">
          <span
            data-testid="card-goal"
            style={{
              // Amber, not DANGER — same tier decision as GOAL_CHIP_COLOR.escalated above. The
              // WEIGHT below is what still makes it stand out, without spending the alarm colour.
              color: goalBadge.escalated ? C.amberInk : C.muted,
              fontSize: 12,
              fontWeight: goalBadge.escalated ? FONT_WEIGHT.semibold : FONT_WEIGHT.regular,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {goalBadge.text} — {goalBadge.label}
          </span>
        </DetailLine>
      )}
      {/* THE ESCALATION QUOTES A GOAL THIS AGENT NO LONGER HOLDS, said in words — and said HERE,
          which is the whole point. The escalation sentence in the line above freezes the goal text
          at the instant auto-continue gave up and is never regenerated, so `text` and that sentence
          can describe two different objectives on one row. Read as a live claim it sends someone to
          chase work that is already done: three of nine simultaneous escalations were false exactly
          this way.

          THIS BLOCK MUST NOT MIGRATE TO THE COLUMN ROW. The sidebar's goal chip is an ICON by
          explicit instruction (see goalChipEl above, and the 440px note at `goalBadgeFor`'s call
          site) — words there only ever via `title`/`aria-label`. `staleQuote` is carried as data
          precisely so this card can spend the space and the row cannot. */}
      {goalBadge?.staleQuote && (
        <DetailLine label="Escalation">
          <span
            data-testid="card-goal-stale"
            style={{
              color: C.muted,
              fontSize: 12,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            Gave up on: {goalBadge.staleQuote}. Now working on: {goalBadge.text}.
          </span>
        </DetailLine>
      )}
      {/* The stall verdict's OWN sentence, unabbreviated. The chip on the row is a headline capped
          at ~20 characters; this is the engine's full reading, including every cause beyond the
          first that the chip could only count as "+N". Rendered only for a confident stall — an
          `unknown` verdict says nothing here, exactly as it paints nothing on the row. */}
      {stallChip && (
        <DetailLine label="Stalled">
          <span
            data-testid="card-stall-detail"
            style={{
              // Amber for the same reason as the row chip above — this detail line sits directly
              // under `card-goal`, which is amber, and repeated the retired red for one fact.
              color: C.amberInk,
              fontSize: 12,
              minWidth: 0,
            }}
          >
            {stall.detail}
          </span>
        </DetailLine>
      )}
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
                  <WorkflowLine stage={w.stage} expanded section={w.section} />
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
  // status banded "calm" (isCalmBand, which THEN meant everything not asking for you), lifted from
  // the concierge prototype's `.arow.p2` so only P0/P1 carried color. `working` was inside that band
  // at the time, so a RUNNING agent's green dot came out desaturated — and sparkle-pulse
  // (opacity 1 → .35) compounded it to about a quarter opacity. The column's job is to show what is
  // live; that treatment erased exactly that. Removed outright rather than gated, because a
  // conditional leaves the same trap one isCalmBand edit away.
  // See AgentSidebar.liveStatusDots.test.tsx.
  //
  // isCalmBand no longer includes `working` — it is `{done, stopped}` now, i.e. "this agent's
  // process has exited" (bead sparkle-e7a3f3) — so the specific dot collision above cannot recur.
  // THE REMOVAL WAS NEVER CONDITIONAL ON THAT and a row filter is still wrong: the column carries
  // status by DOT COLOR, which any desaturation of the row fights whatever the predicate answers.
  // isCalmBand governs the TERMINAL's own xterm theme (Workspace.tsx), which desaturates an EXITED
  // agent's text without touching the sidebar. Do not re-wire it to a row style.
  // Show the slide-out only while hovering AND not renaming. Suppressing it during a rename means
  // the in-flow row is the SOLE owner of the rename <input> — the field never swaps mount points on
  // a hover change, so a trailing unmount-blur can't silently commit a half-typed name.
  const showOverlay = hover && !editing;

  // WHICH END OF THIS ROW OPENS INTO WHAT — see engine/rowGeometry. `filletEnds` is pulled out
  // because it names the ends to draw a mouth at, not a CSS property to spread onto the box.
  //
  // `padLeft` comes out too, and NOT onto the box: the hover card stands in for this row at this
  // row's own rect, so it has to reproduce THIS row's content offset rather than a constant. See
  // the card strip's padding.
  const { filletEnds, padLeft: rowPadLeft, padRight: rowPadRight, ...boxStyle } = rowBoxFor({
    paneSide,
    jointOpen,
    isActive,
    depthIndent: depth * DEPTH_INDENT,
  });

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
        onDoubleClick={onRowDoubleClick}
        onContextMenu={openRowMenu}
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
          // OFF-SCREEN ROWS DO NO LAYOUT — this is the renderer half of the 2026-08-12 freeze.
          // The column is UNVIRTUALIZED, so ~65 agents means ~65 live rows. A `sample` of the
          // WebContent process (not the app process — that one sat 98% idle in mach_msg, which is
          // what made this look like a backend hang) caught its main thread 30+ frames deep in
          // nested RenderBlock::simplifiedLayout → RenderFlexibleBox::layoutBlock →
          // layoutOutOfFlowBox, bottoming out in computePreferredLogicalWidths — every frame was
          // recomputing intrinsic widths across the whole tree. `content-visibility: auto` lets the
          // engine skip layout AND paint for rows outside the viewport, which is most of them.
          //
          // GATED ON `filletEnds`, and the gate is load-bearing: content-visibility implies PAINT
          // containment, which clips descendants to the border box — and the fillets deliberately
          // paint OUTSIDE it (`top: -ACTIVE_FILLET` / `bottom: -ACTIVE_FILLET`, rowAnatomy) to bite
          // the arc out of this row's corner. Containing a filleted row would square that opening
          // back off, undoing the bleed the comment above spends 20 lines protecting. Only the
          // active/concierge ends carry fillets and those rows are on screen by definition, so
          // exempting them costs nothing. They are also the only descendants that overflow — every
          // other negative offset here is the row's OWN margin, which its own containment can't clip.
          //
          // The hover card is unaffected: it is createPortal'd to document.body, so it is not a DOM
          // descendant and containment here cannot reach it.
          ...(filletEnds.length === 0
            ? {
                contentVisibility: "auto" as const,
                // `auto` remembers the row's last-rendered height, so a skipped row still reserves
                // its true size and the scrollbar doesn't jump as you scroll. The 32px fallback
                // applies only to a row that has never been on screen (one 20px line + 4px padding).
                containIntrinsicSize: "auto 32px",
              }
            : {}),
          // 4px vertical, down from 8: the row is a single 20px line of text now (the sub-line and
          // the progress bar moved to the card), so the old padding was sized for content that is
          // no longer here and left the column looking sparse rather than calm.
          //
          // HORIZONTALLY IT IS `rowBox`'S CALL, not this file's. A bleeding end pays its bleed back
          // one-for-one in padding, so the ink's inset from the column edge is constant in every
          // state; WHICH end bleeds is the pair's side, and the concierge end joins it once the
          // cable is patched. All three decisions live in engine/rowGeometry.
          ...boxStyle,
          // Active row is the TERMINAL color, extending past the list's 8px padding on the pane side
          // so it reaches the column's edge, with CONCAVE fillets (below) shaping that end into an
          // opening rather than a convex "button" corner. Idle rows are fully rounded.
          //
          // THE ROW BLEEDS THROUGH THE COLUMN'S EDGE, and the negative margin is what makes that
          // possible: it eats the list's 8px padding so the fill reaches the seam and laps its last
          // pixel, painting over it (the seam is a positioned sibling EARLIER in tree order — see
          // the column's own note). For one release the edge was a `border-right`, which no
          // descendant can paint on, and the rule ran straight across this row: the bleed became a
          // dock against a drawn line. Don't reintroduce that by moving the seam back onto the
          // border or by giving it a z-index.
          //
          // What carries the active state is the fill being the terminal's own colour where every
          // other row is transparent, plus the square pane-side corner and the fillets shaping that
          // edge into an opening — and, once the card is open, its 4px `hairline` outline. Not the
          // fill step against the column, which is ~1.08:1 and never was the signal.
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
        {!showOverlay && <ActiveFillets ends={filletEnds} paneSide={paneSide} />}
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
              onClick={() => onSelect()}
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
                // open. The row's own vertical padding is ROW_PAD_Y; its HORIZONTAL padding is
                // whatever `rowBox` gave THIS row, which is why that number is read off the row
                // instead of being written again here.
                //
                // IT USED TO BE THE CONSTANT `ROW_PAD_X`, and that was correct only while the row's
                // left padding was always 10. It is `ROW_PAD_COMPENSATED` (18) on any OPEN end — so
                // for every row in a LEFT pair, and for every row in either pair once the cable is
                // patched. A row click patches the cable, so wired is the ordinary state, and the
                // constant slid the disc and title 8px left of where they had just been the instant
                // a card opened: exactly the "everything visibly jumped" regression the rest of this
                // note exists to prevent (roborev 55270).
                //
                // The horizontal half of this was always slightly wrong; cutting the row's vertical
                // padding to 4px is what made the vertical half obvious (roborev 53814). The
                // alignment test pins BOTH axes now — it used to compare only slot widths, which
                // cannot see an offset.
                // PER SIDE, not the two-value shorthand. The shorthand applied the row's LEFT
                // padding to the card's right as well — and `padLeft` carries the depth indent on an
                // open end, so a depth-1 worker's card got a 46px right inset where it had been 6–8,
                // pulling the close ×, the elapsed timer and the progress bar ~40px off the card's
                // right edge. The card's right edge stands over the TERMINAL, not over the row, so
                // it has no business tracking the row's left padding at all (roborev 55287).
                padding: `${Math.max(0, ROW_PAD_Y - cardBorder)}px ${Math.max(0, rowPadRight - cardBorder)}px ${Math.max(0, ROW_PAD_Y - cardBorder)}px ${Math.max(0, rowPadLeft - cardBorder)}px`,
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
              onClick={() => onSelect()}
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
      {/* THE ROW'S CONTEXT MENU — a SIBLING of the row element, never a child of it, and that
          placement is load-bearing rather than tidiness.

          A portal's React events bubble through the OWNER tree, not the DOM one. Rendering this
          inside the row `<div>` would therefore send every press in the menu through the row's own
          `onClick` / `onDoubleClick` — and the row's control bail (`ROW_CONTROL_SELECTOR`) could not
          stop it, because that test is `e.currentTarget.contains(hit)` and a portalled node is
          contained by nothing in the row. A double press on an item would select the row and patch
          the cable onto it, which is roborev 63145's leak reopened through a new surface. As a
          sibling — the arrangement the hover card above already uses — nothing in the menu can reach
          the row at all. `AgentSidebar.rowContextMenu.test.tsx` pins it. */}
      {menuAt && (
        <RowContextMenu
          at={menuAt}
          label={`Actions for ${a.name}`}
          onDismiss={dismissRowMenu}
          items={[
            // The founder's order. Rename leads because it is the verb this menu was created to
            // hold — it had no home at all once the double click became the mount.
            { id: "rename", label: "Rename", onSelect: beginRename },
            { id: "open-details", label: "Open details…", onSelect: openCard },
            {
              id: "close-agent",
              label: "Close agent",
              onSelect: onClose,
              danger: true,
              separatorBefore: true,
            },
          ]}
        />
      )}
    </>
  );
}, agentRowPropsEqual);
