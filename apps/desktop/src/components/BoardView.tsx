import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { C, FONT_WEIGHT, MODAL_SHADOW, SCRIM } from "../theme/colors";
import { PILL, RADIUS } from "../theme/scale";
import type { Project } from "../types";
import {
  epicIndexOf,
  isEpicIndexed,
  childrenOfIndexed,
  openChildCountIndexed,
  parentEpicOfIndexed,
  epicDisplayTitle,
  labelBead,
  STALLED_LABEL,
  SWEEP_NO_AUTO_LABEL,
  mergeShaOf,
  severityOf,
  DELIVERED_LABEL,
  type Bead,
  type Board,
  type BoardColumn,
} from "../services/beads";
import { DECOMPOSE_FAILED_LABEL, DECOMPOSING_LABEL } from "../services/epicDecompose";
import {
  EPIC_LADDER_COLUMNS,
  PLAN_KINDS,
  STAGE_LABELS,
  bucketEpics,
  emptyEpicBoard,
  ladderKeyOf,
  tasksOnly,
  withPlanning,
  type EpicBoard,
  type EpicLadderKey,
} from "../services/epicBoard";
import { safeUnlisten } from "../services/safeUnlisten";
import { useBeadsStore } from "../stores/beadsStore";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import type { PairSide } from "../engine/cable";
import { useUiStore } from "../stores/uiStore";
import { useShallow } from "zustand/react/shallow";
import {
  workersForBead,
  beadStage,
  epicChildViews,
  orchestratorNameForEpic,
  type EpicChildView,
} from "../services/planView";
import { WorkflowLine } from "./WorkflowLine";
import { FiUsers, FiChevronRight, FiCheck, FiCircle } from "react-icons/fi";
import { stageMeta, stageLineColor, type WorkflowStageId } from "../engine/workflowStage";
import { agentDisplayName } from "../engine/agentDisplayName";
import {
  boardFilterIsActive,
  isDateSort,
  matchesBoardFilter,
  NO_BOARD_FILTER,
} from "../services/boardFilters";
import { sortEpicBoard } from "../services/boardSort";
import type { AgentTab } from "../types";
import { getConfig, onConfigChanged } from "../services/config";
import { readStageDef, isDefined, type StageKey, type StageDefinition } from "../services/stageDefs";
import {
  startDeliveryMonitor,
  stopDeliveryMonitor,
  type DeliveryMonitorUpdate,
  type WatchedBead,
} from "../services/deliveryMonitor";
import { DefineStageModal } from "./DefineStageModal";
import { StageColumnHeader, DefineStageCta, definableStageKey, type DeliveryChip } from "./StageColumnHeader";
import { CardCriteria } from "./CardCriteria";
import { BeadCard } from "./BeadCard/BeadCard";
import { BeadPriorityChip } from "./BeadCard/BeadPriorityChip";
import { EpicPill } from "./BeadCard/EpicPill";
import { BeadSeverityBadge } from "./BeadCard/BeadSeverityBadge";
import { useBeadBuildActions } from "./BeadCard/useBeadBuildActions";
import { setBeadPriority } from "./BeadCard/beadPriority";
import { beadCardMenuIsOpen } from "./BeadCard/PriorityPill";
import { beadsComment, beadsDetail, type BeadComment } from "../services/beadsCommands";
import { FONT_MONO, FONT_UI } from "../theme/scale";

/** The next board stage a card in `columnKey` is progressing toward (whose criteria we evaluate):
 *  Backlog / In Progress → Done; Done → Delivered; Delivered is terminal (none). */
// Takes the LADDER key rather than `BoardColumn` because the Epics mode renders one column the task
// board has no bucket for (`planning`). Widening the parameter is the whole change: an epic sitting
// in Planning is open and unstarted, so it wants the same "next stage" as Backlog — which is what
// the existing `backlog` arm already answers.
function nextStageOf(columnKey: EpicLadderKey): StageKey | null {
  if (columnKey === "backlog" || columnKey === "planning" || columnKey === "inProgress")
    return "done";
  if (columnKey === "done") return "delivered";
  return null;
}

/** Per-project Done/Delivered definitions, read once from config and refreshed on config-changed. */
interface StageDefs {
  done?: StageDefinition;
  delivered?: StageDefinition;
}

// The four board columns, in display order, paired with the Board snapshot key each reads.
//
// THE LABELS ARE THE FOUNDER'S WORDS; THE KEYS ARE THE DATA'S. They are deliberately allowed to
// disagree. `inProgress`/`delivered` are the Board snapshot's keys and bd's own vocabulary, and
// renaming them would be a data-layer change for a wording decision. What the user reads is
// "Being built" and "Shipped" — plain-language states a non-developer can act on, which is the
// whole point of this column being a window rather than a bug tracker.
// BLOCKED SITS SECOND, between what hasn't started and what is being worked. That is where it
// belongs in the reading order — you scan left to right asking "what's next", and a blocked item is
// something that WOULD be next except it can't be. Putting it after "Being built" would file it as
// a kind of progress, which is the opposite of what it is.
// ARCHIVED SITS LAST, after Shipped, and is the one column that is COLLAPSED by default.
//
// ── THE CAP USED TO GUARD THIS COLUMN AND ONLY THIS COLUMN, WHICH GUARDED NOTHING ────────────
// The comment here used to say a background sweep closes ~1,800 low-signal beads "each stamped
// `archived`". No such writer exists: `ARCHIVED_LABEL` is READ in `columnOf` and is written
// nowhere in this repo, so the Archived column is permanently EMPTY and its 50-card cap protected
// an empty column. Meanwhile every closed bead falls through to DONE, uncapped — 4,476 of them on
// the founder's store, 60% of the whole DB, mounted as live cards behind a board the user is
// trying to click. The cap is now wired to the TERMINAL columns (Done, Shipped, Archived), which
// is what it was always for: they are resting places, not worklists.
//
// THE WORDS COME FROM `epicBoard.STAGE_LABELS`, not from here. They used to be written out inline,
// and the epic ladder wrote its own copy — which drifted: this list said "Being built" while the
// ladder said "Building" for the SAME column. One record now feeds both lists and the status chip
// on every bead card, so a card and the header above it cannot name the same stage differently.
const COLUMN_KEYS: readonly BoardColumn[] = [
  "backlog",
  "blocked",
  "inProgress",
  "done",
  "delivered",
  "archived",
];
const COLUMNS: readonly { key: BoardColumn; label: string }[] = COLUMN_KEYS.map((key) => ({
  key,
  label: STAGE_LABELS[key],
}));

/** How many cards a TERMINAL column (Done, Shipped, Archived) renders at once — the rest are a
 *  "+N more" count, never DOM nodes, until the user asks for another page. The bucketing still
 *  visits every bead (cheap, scalar work in `bucketBeads`); only the render is bounded, which is
 *  the part that janks.
 *
 *  50 is one screenful with room to scroll. The columns this guards are the ones that only grow:
 *  nothing is ever removed from Done, so an uncapped Done is a DOM that grows without bound for
 *  the life of the project. */
const TERMINAL_RENDER_CAP = 50;

/** The columns the cap applies to — terminal states, where volume accumulates and nobody is
 *  working. A live column (Backlog, Blocked, Being built) is never capped: a card you cannot see
 *  there is work you will not do. */
const TERMINAL_COLUMNS: ReadonlySet<EpicLadderKey> = new Set<EpicLadderKey>([
  "done",
  "delivered",
  "archived",
]);

/**
 * Does this monitor tick say the same thing as the one we are already holding?
 *
 * The delivery monitor fires on a timer and always hands back a FRESH object, so without this the
 * board took a new `delivery` identity every tick and re-rendered itself and every card on an idle
 * screen. Compared by VALUE, and deliberately field-by-field rather than by JSON round-trip: this
 * runs on every tick, and a stringify of the whole signal list allocates far more than the walk it
 * replaces.
 *
 * `tags` is compared too. It is not read by anything the board renders TODAY, which is exactly why
 * it must be here: treating it as irrelevant would make this function quietly lossy the moment a
 * caller starts reading it, and a stale tag list is the kind of bug that presents as "the UI just
 * stopped updating" long after this line was written.
 */
export function sameDeliveryUpdate(
  a: DeliveryMonitorUpdate | null,
  b: DeliveryMonitorUpdate | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.detectable !== b.detectable || a.status !== b.status) return false;
  if (a.signals.length !== b.signals.length) return false;
  for (let i = 0; i < a.signals.length; i++) {
    const x = a.signals[i]!;
    const y = b.signals[i]!;
    if (x.beadId !== y.beadId || x.inRelease !== y.inRelease) return false;
    if (x.tags.length !== y.tags.length) return false;
    for (let t = 0; t < x.tags.length; t++) if (x.tags[t] !== y.tags[t]) return false;
  }
  return true;
}

const DESC_PREVIEW = 120;

// Stable empty fallback: a `?? []` literal inside a zustand selector returns a NEW reference every
// render, which makes the store re-render in a loop. Reuse one frozen array instead.
const NO_AGENTS: AgentTab[] = [];

// Same reasoning as NO_AGENTS directly above, for the bead list. `snapshot?.beads ?? []` builds a
// NEW empty array on every render whenever there is no snapshot yet, so every `useMemo` keyed on
// `allBeads` re-ran each time and memoised nothing — the two that predate the Epics mode included.
// One frozen array makes the identity stable, which is what the deps array is comparing.
const NO_BEADS: Bead[] = [];

/** The card list inside a column — the only element on this board that scrolls vertically, and the
 *  one `boardScrollDelta` asks whether it still has room. */
const COLUMN_LIST_ATTR = "data-board-column-list";

/** A vertically scrollable list's geometry — the three numbers, so a test can state a case without
 *  a layout engine (jsdom reports every element as 0×0 and would make the real thing untestable). */
export type ListScroll = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** A wheel's deltas are only PIXELS when `deltaMode` says so. A mouse reporting LINE mode sends
 *  `deltaY ≈ 3` per notch, so a handler that adds the raw number to `scrollLeft` creeps 3px a notch
 *  — indistinguishable from "the wheel does nothing". `AgentSidebar`'s forwarder already scales by
 *  16 for line mode; match it rather than letting two handlers disagree about the same input.
 *  (0 = pixel, 1 = line, 2 = page.) */
const LINE_PX = 16;
const PAGE_PX = 400;
export function wheelPixels(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * LINE_PX;
  if (deltaMode === 2) return delta * PAGE_PX;
  return delta;
}

/**
 * HOW MUCH THE BOARD SCROLLS HORIZONTALLY FOR ONE WHEEL EVENT — the axis rule, as a pure function.
 *
 * A kanban is a HORIZONTAL thing, and the wheel is the gesture people reach for to move along it.
 * The browser will not do that on its own: `deltaY` scrolls the nearest ancestor that overflows on
 * Y, and the board row overflows on X, so a plain wheel over this board could only ever move a
 * column's cards. That is what the founder hit — BACKLOG holding 606 items ate every scroll while
 * BLOCKED sat clipped at the right edge with no gesture that would reach it.
 *
 * So a vertical wheel drives the board sideways. The ONE exception is the case where the user is
 * plainly reading a column: if the pointer is over a card list that can still move in the wheel's
 * own direction, that list keeps the event. Chaining that way round is what keeps a 606-card column
 * readable — the alternative (board always wins) makes its cards reachable only by dragging a
 * scrollbar. Once the list is at its end the board takes over, so one continuous gesture reads to
 * the bottom of a column and then carries on across the board.
 *
 * `deltaX` is returned untouched-by-us (0): a horizontal wheel or trackpad swipe already lands on
 * the board row, which is the nearest X scroller, so the browser does the right thing unaided.
 *
 * @returns pixels to add to the board's `scrollLeft`; 0 means "leave this event alone".
 */
export function boardScrollDelta(
  { deltaX, deltaY, deltaMode = 0 }: { deltaX: number; deltaY: number; deltaMode?: number },
  list: ListScroll | null,
): number {
  // A horizontal gesture is already aimed at the board. Don't double-apply it.
  if (Math.abs(deltaX) > Math.abs(deltaY)) return 0;
  if (deltaY === 0) return 0;
  deltaY = wheelPixels(deltaY, deltaMode);
  if (list) {
    // Sub-pixel slack: a fractional scrollHeight/clientHeight (zoom, fractional DPR) otherwise
    // leaves a list permanently "able to scroll" by a hair, and the board would never take over.
    const room = list.scrollHeight - list.clientHeight - list.scrollTop;
    if (deltaY > 0 && room > 1) return 0;
    if (deltaY < 0 && list.scrollTop > 1) return 0;
  }
  return deltaY;
}

/**
 * Read-only Tasks Kanban for a project (bead sparkle-hiju.10). A window, NOT a control panel:
 * it polls `bd` via the beads store and renders the four buckets (Backlog / In Progress / Done /
 * Delivered) as columns of cards. Clicking a card opens a detail overlay. There are deliberately
 * no drag handles, status dropdowns, or any edit controls — nothing here mutates a bead.
 */
// `side` is REQUIRED, deliberately. It defaulted to "right" for one commit and that is precisely
// how the satellite's board silently read a different column than its own sidebar wrote — a
// required prop surfaces every call site at compile time instead.
//
// `onBeadChat` is the OPPOSITE call — optional on purpose, and its absence is what hides the bead
// card's Chat button in the satellite window (bead sparkle-1cpomd). The satellite mounts no
// ConciergeHost and no composer anywhere in its tree, so a draft handed over there would land in a
// store with no reader and be dropped silently; `Workspace` supplies it, `SatelliteApp` does not,
// and `BeadCard`'s callback-is-the-switch rule does the hiding with no window check involved. See
// BeadCardProps.onChat.
export function BoardView({
  project,
  side,
  onBeadChat,
}: {
  project: Project;
  side: PairSide;
  onBeadChat?: (bead: Bead) => void;
}) {
  const snapshot = useBeadsStore((s) => s.byProject[project.id]);
  const error = useBeadsStore((s) => s.error[project.id]);
  // ══ THE OPEN CARD IS ADDRESSED BY ID, AND READ BACK FROM THE LIVE POLL ═══════════════════════
  // An ID, never the Bead OBJECT. `beadsStore` replaces its snapshot wholesale every 5s, so a held
  // object is a photograph: an open card would show the title, status and priority the bead had at
  // click time, forever.
  //
  // That is not cosmetic here — it silently breaks the priority write. `BeadCard` holds its
  // optimistic value until `bead.priority` agrees with it, which is exactly the acknowledgement a
  // frozen object can never deliver, so a priority set from the board would stay latched on the
  // optimistic number with no way to tell a saved value from an unsaved one.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // The horizontally scrolling row of columns, and the wheel that drives it — see boardScrollDelta.
  const colsRef = useRef<HTMLDivElement | null>(null);
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const row = colsRef.current;
    if (!row) return;
    // NOT preventDefault'ed, and it does not need to be: React binds `wheel` PASSIVELY at the root,
    // so a preventDefault here is a no-op plus a console warning. Nothing double-applies anyway —
    // when this returns non-zero the list under the pointer is at its end, and the row does not
    // scroll on Y, so the browser's own handling of the event moves nothing.
    const dx = boardScrollDelta(e, (e.target as HTMLElement).closest<HTMLElement>(`[${COLUMN_LIST_ATTR}]`));
    if (dx !== 0) row.scrollLeft += dx;
  };

  // Live the board off the beads-store poller: start it on mount, stop on unmount. The store is
  // idempotent (one timer per project), so this co-exists with any other viewer of the same project.
  useEffect(() => {
    useBeadsStore.getState().startPolling(project.id, project.rootPath);
    return () => useBeadsStore.getState().stopPolling(project.id);
  }, [project.id, project.rootPath]);

  const board = snapshot?.board;
  const allBeads = snapshot?.beads ?? NO_BEADS;

  /**
   * The bead the open overlay is showing, read from the CURRENT poll rather than held.
   *
   * BOTH SOURCES, because they can legitimately disagree. `snapshot.beads` is the flat list and
   * `snapshot.board` is the bucketed one; production derives the second from the first, but they
   * are separate fields and nothing forces a bead present in a LANE to also appear in the flat
   * list. Resolving from only one would make an open card vanish for a bead the board is visibly
   * still rendering.
   *
   * `undefined` — and so no overlay — once the bead is in neither. That is the honest outcome: a
   * detail card for a bead the board no longer has would show a row nothing else on screen agrees
   * exists.
   */
  const selectedBead = useMemo(() => {
    if (selectedId === null) return undefined;
    const hit = allBeads.find((b) => b.id === selectedId);
    if (hit) return hit;
    if (!board) return undefined;
    for (const lane of [
      board.backlog,
      board.blocked,
      board.inProgress,
      board.done,
      board.delivered,
      board.archived,
    ]) {
      const inLane = lane.find((b) => b.id === selectedId);
      if (inLane) return inLane;
    }
    return undefined;
  }, [selectedId, allBeads, board]);

  // ── Definable Done & Delivered (Unit 5) ──────────────────────────────────────────────────────
  // Which stage's Define/Edit modal is open (null = none).
  const [defineStage, setDefineStage] = useState<StageKey | null>(null);
  // Per-project Done/Delivered definitions: read once per project, refreshed on config-changed.
  const [defs, setDefs] = useState<StageDefs>({});
  // Latest delivery-monitor tick (drives the Delivered header chip + per-card `in_release`).
  const [delivery, setDelivery] = useState<DeliveryMonitorUpdate | null>(null);
  // STABLE ACROSS RENDERS, and load-bearing rather than tidy: this reaches every card, so as an
  // inline `(b) => setSelectedId(b.id)` it was a new function identity on every render and
  // `React.memo` on `Card` would have missed 100% of the time — a memo that never hits is worse
  // than none, because it costs a props comparison per card and buys nothing.
  const handleOpen = useCallback((b: Bead) => setSelectedId(b.id), []);

  // Load the definitions once per project, then live-refresh on any config write/edit. The modal's
  // save fires `config-changed`, so the board picks up a fresh definition without a manual poll.
  useEffect(() => {
    let cancelled = false;
    const apply = (cfg: Parameters<typeof readStageDef>[0]) => {
      if (cancelled) return;
      setDefs({ done: readStageDef(cfg, "done"), delivered: readStageDef(cfg, "delivered") });
    };
    getConfig(project.rootPath)
      .then((eff) => apply(eff.config))
      .catch(() => {
        /* undefined-as-a-whole is the honest fallback; the board renders as today. */
      });
    let unlisten: (() => void) | undefined;
    onConfigChanged((eff) => apply(eff.config))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      // Route teardown through safeUnlisten so the benign Tauri "listeners map already torn
      // down" race (window close / rapid remount) can't surface as an unhandled rejection.
      void safeUnlisten(unlisten);
    };
  }, [project.rootPath]);

  const deliveredDefined = isDefined(defs.delivered);

  // The delivery monitor watches in-flight/closed beads for a shipped-release signal and pushes live
  // updates. It runs only once Delivered is defined (no point otherwise). We feed it a fresh watch
  // set each tick via a ref so add/remove beads don't restart it. Each bead carries the commit SHA
  // its branch landed as (captured at land time onto a `merged-sha:` label, Task B); when present the
  // monitor tests THAT exact commit for release containment, and when absent (shipped via PR, or an
  // older build) it honestly reports not-in-release rather than claiming a delivery it can't verify.
  const boardRef = useRef(board);
  boardRef.current = board;
  useEffect(() => {
    if (!deliveredDefined) {
      stopDeliveryMonitor();
      setDelivery(null);
      return;
    }
    const getBeads = (): WatchedBead[] => {
      const b = boardRef.current;
      if (!b) return [];
      // Candidates for a delivery signal: everything that's reached Done or beyond (plus in-flight).
      return [...b.inProgress, ...b.done, ...b.delivered].map((x) => ({
        beadId: x.id,
        mergeSha: mergeShaOf(x),
      }));
    };
    // KEEP THE OLD OBJECT WHEN THE TICK SAYS THE SAME THING. The monitor fires on a timer and
    // hands us a FRESH object every time, so `setDelivery(u)` changed React state on every tick
    // whether or not anything about the delivery picture moved. That is the 90-second idle
    // re-render: an untouched board rebuilt `inReleaseByBead`, re-derived `deliveryChip`, and
    // re-rendered every card, forever, with nobody looking at it.
    //
    // It is also what makes memoising the cards WORTHLESS on its own — a new `delivery` identity
    // invalidates every derived prop below, so `React.memo` on `Card` would miss on every tick no
    // matter how stable the rest of the props are. The two fixes only work together.
    startDeliveryMonitor(
      project.rootPath,
      (u) => setDelivery((prev) => (sameDeliveryUpdate(prev, u) ? prev : u)),
      getBeads,
    );
    return () => stopDeliveryMonitor();
  }, [project.rootPath, deliveredDefined]);

  // Per-bead `in_release` verdict from the latest tick, for the Delivered criteria evaluation.
  const inReleaseByBead = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const s of delivery?.signals ?? []) m.set(s.beadId, s.inRelease);
    return m;
  }, [delivery]);

  // MEMOISED, because this is a prop that reaches every card. As a bare object literal it minted a
  // new identity on every render of this component — so even with `delivery` held stable above, any
  // unrelated re-render here would still invalidate `React.memo` on every `Card` beneath it.
  const deliveryChip: DeliveryChip | undefined = useMemo(
    () =>
      delivery
        ? // We render our own FiCheck/FiAlertTriangle icon, so strip ANY leading glyph/symbol/space
          // the monitor prepends (⚠/✓ today, but robust to any future marker) to avoid a doubled
          // indicator.
          { detectable: delivery.detectable, label: delivery.status.replace(/^[^\p{L}\p{N}]+/u, "") }
        : undefined,
    [delivery],
  );

  // One-shot board-focus handoff (spec §8): the sidebar epic pill sets boardFocusBeadId before
  // switching here; once the bead is present in a snapshot, open its DetailOverlay and clear the
  // handoff. Deliberately left SET while the bead is still missing (e.g. first poll in flight) —
  // the effect re-runs when the snapshot lands, so the jump survives the loading state.
  const boardFocusBeadId = useUiStore((s) => s.boardFocusBeadId);
  useEffect(() => {
    if (!boardFocusBeadId || !snapshot) return;
    const hit = snapshot.beads.find((b) => b.id === boardFocusBeadId);
    if (hit) {
      setSelectedId(hit.id);
      useUiStore.getState().setBoardFocusBeadId(null);
    }
  }, [boardFocusBeadId, snapshot]);
  // Per-agent feedback filter (feedback-pill-and-filter): a build-agent's FEEDBACK pill sets
  // boardAgentFilter to its agent id before switching here; the board then shows ONLY beads labeled
  // `agent:<id>` — the beads that agent created or commented on, stamped by the buildAgent shell.
  // Client-side: we narrow the ALREADY-bucketed columns rather than re-querying, so the poll and the
  // store's fetch are untouched and the 5-column bucketing stays intact. Unlike boardFocusBeadId this
  // filter PERSISTS across polls (it is a view mode, not a one-shot) — cleared by the banner's Clear.
  // THIS COLUMN'S filter. Two boards can be mounted at once (one per pair), and a single global
  // string had both of them narrowing to whatever the last pill clicked — including across two
  // different projects. See uiStore.boardAgentFilterBySide.
  const boardAgentFilter = useUiStore((s) => s.boardAgentFilterBySide[side]);
  // The priority + date-range filter rides the SAME seam as the agent filter — one predicate over
  // the five already-bucketed lanes — so the poll, the fetch and the bucketing stay untouched.
  const boardFilter = useUiStore((s) => s.boardFilterBySide[side]);
  const filterActive = boardFilterIsActive(boardFilter);
  /** The board narrowed by the AGENT filter alone — the baseline the priority/date notice measures
   *  against. See `hiddenByFilter`. */
  const agentOnlyBoard = useMemo(() => {
    if (!board || boardAgentFilter === null) return board;
    const label = `agent:${boardAgentFilter}`;
    const keep = (arr: Bead[]) => arr.filter((b) => b.labels.includes(label));
    return {
      backlog: keep(board.backlog),
      blocked: keep(board.blocked),
      inProgress: keep(board.inProgress),
      done: keep(board.done),
      delivered: keep(board.delivered),
      archived: keep(board.archived),
    };
  }, [board, boardAgentFilter]);

  const displayBoard = useMemo(() => {
    if (!agentOnlyBoard || !filterActive) return agentOnlyBoard;
    // ONE `now` FOR THE WHOLE PASS. Reading the clock per bead would let a bead near the window's
    // edge fall on a different side of it than its neighbour in the same render.
    const now = Date.now();
    const keep = (arr: Bead[]) => arr.filter((b) => matchesBoardFilter(b, boardFilter, now));
    return {
      backlog: keep(agentOnlyBoard.backlog),
      blocked: keep(agentOnlyBoard.blocked),
      inProgress: keep(agentOnlyBoard.inProgress),
      done: keep(agentOnlyBoard.done),
      delivered: keep(agentOnlyBoard.delivered),
      archived: keep(agentOnlyBoard.archived),
    };
  }, [agentOnlyBoard, boardFilter, filterActive]);

  // ══ TASKS / EPICS — the Plan board's two independent kind toggles ════════════════════════════
  const planKinds = useUiStore((s) => s.planKindsBySide[side]);
  /**
   * The columns to render and the beads in each, for the kinds currently switched on.
   *
   * EPICS-ONLY is the ONLY combination that changes the column SET: it swaps the task board's six
   * columns for the founder's seven-stage ladder — Backlog > Blocked > Planning > Building > Done
   * > Shipped > Archived — whose one addition is Planning, an EPIC-only derived stage. Every other
   * combination keeps the familiar columns, because Planning is a statement about an epic's
   * children and has nothing to put in it once tasks are on the board too.
   *
   * NEITHER KIND ON renders an explicitly EMPTY board rather than falling through to the unfiltered
   * one. Falling through is the bug that shape invites: the user switches everything off and the
   * board answers by showing them everything, which reads as the controls being ignored.
   *
   * IT NARROWS `displayBoard`, NOT `board` — so the mode COMPOSES with the agent filter and the
   * priority/date filter rather than quietly discarding them. Narrowing the raw snapshot here would
   * show a board wider than the user's own controls say it should be.
   *
   * `allBeads` is passed UNFILTERED on purpose, and it is a different set from the one being
   * bucketed: epic-ness and the child roll-up are properties of the whole store (a bead cannot tell
   * you whether anything points at it), so asking them against a filtered list would demote an epic
   * whose children a filter happened to hide.
   */
  // The two fields of `boardFilter` that decide ORDER rather than membership. Read as scalars so
  // the sort memo below depends on them and not on the whole filter object.
  const sortBy = boardFilter.sortBy;
  const dateField = boardFilter.dateField;
  const { columns, viewBoard } = useMemo((): {
    columns: readonly { key: EpicLadderKey; label: string }[];
    viewBoard: EpicBoard | null;
  } => {
    // ── THE ORDER IS APPLIED ONCE, TO WHATEVER THE MODE PRODUCED ─────────────────────────────
    // Every branch below builds a differently-shaped board and NONE of them sorts: `bucketEpics`
    // filters in input order and `withPlanning` just widens the shape. Ordering the finished
    // `EpicBoard` here — rather than inside each branch — is what makes ONE comparator serve both
    // modes, which is the requirement: the founder's order must hold on the Epics-only ladder
    // exactly as it does on the default Tasks+Epics board.
    const ordered = (b: EpicBoard) => sortEpicBoard(b, sortBy, dateField, allBeads);
    if (!displayBoard) return { columns: COLUMNS, viewBoard: null };
    if (!planKinds.tasks && !planKinds.epics)
      return { columns: COLUMNS, viewBoard: emptyEpicBoard() };
    if (!planKinds.tasks)
      return {
        columns: EPIC_LADDER_COLUMNS,
        viewBoard: ordered(bucketEpics(displayBoard, allBeads)),
      };
    if (!planKinds.epics)
      return {
        columns: COLUMNS,
        viewBoard: ordered(withPlanning(tasksOnly(displayBoard, allBeads))),
      };
    // ── BOTH KINDS ON — AND THIS REPLACES `epicsFirst`, WHICH THE COMPARATOR SUBSUMES ──────────
    // `main` reached this line via `withPlanning(epicsFirst(displayBoard, allBeads))`: every epic
    // hoisted above every task, in bd's arbitrary order within each group. That is the founder's
    // ORIGINAL spec, which he then corrected — "we should have p zero epics show first and then
    // all the p zero tasks and then p one epics would show below that … epics basically show at
    // the beginning of the priority list" — i.e. INTERLEAVED by priority band, not epics-above-
    // everything. He was explicit that the hoisting reading survives as ONE option of four:
    // "Type IS the epics-above-everything behaviour I originally specced — it is one option among
    // four, not the default."
    //
    // So `epicsFirst`'s exact behaviour is preserved as `sortBy: "type"`, and the DEFAULT becomes
    // the corrected interleave. Keeping both mechanisms would be two answers to one question —
    // the drift this codebase fights everywhere else — so the call site goes and the comparator
    // owns board order outright.
    return { columns: COLUMNS, viewBoard: ordered(withPlanning(displayBoard)) };
    // `sortBy`/`dateField` are read off `boardFilter` OUTSIDE this memo (see above) so the deps are
    // the two scalars that actually change the order — depending on `boardFilter` itself would
    // re-sort the whole board every time the user touched the priority or date-window filter.
  }, [displayBoard, planKinds, allBeads, sortBy, dateField]);

  /**
   * EVERY USER-DRIVEN CONTROL THAT SWAPS A COLUMN'S DATASET, as one string.
   *
   * Used only as part of the `Column` key, so any of them remounts the column rather than handing
   * the new dataset the old one's `pages`/`expanded`. The kind toggles were the obvious pair; the
   * AGENT and PRIORITY/DATE filters do the same thing and were missed on the first pass — both
   * have an in-UI **Clear**, so: page Done out to 10 pages, narrow to one agent (paging is
   * invisible there, `overflow === 0`), hit Clear, and the restored 4,476-bead column mounts 500
   * cards in one frame against a dataset it was never expanded against (roborev 65718).
   *
   * ALL OF THESE CHANGE ONLY ON USER ACTION, which is what makes them safe to key on. The beads
   * array was the other candidate and is not: it is rebuilt by every 5-second poll, so keying on it
   * would reset the user's paging while they were reading.
   */
  const datasetKey =
    `${planKinds.tasks ? "t" : ""}${planKinds.epics ? "e" : ""}` +
    `|${boardAgentFilter ?? ""}` +
    `|${filterActive ? JSON.stringify(boardFilter) : ""}` +
    // THE SORT BELONGS HERE TOO, and it is deliberately NOT covered by the line above: a sort
    // narrows nothing, so `filterActive` is false for a board whose order the user just changed —
    // and a Done column paged out to 500 cards would then be handed a completely reordered dataset
    // while keeping the old column's `pages`. `dateField` only participates when a date sort reads
    // it, so flipping Created/Updated with no window and no date sort does not reset paging.
    `|${sortBy}${isDateSort(sortBy) ? `:${dateField}` : ""}`;

  /**
   * How many cards the PRIORITY/DATE filter removed — and only when it removed all of them.
   *
   * ══ THE BASELINE IS THE AGENT-FILTERED BOARD, NOT THE WHOLE SNAPSHOT ═════════════════════════
   * These are two independent filters stacked on one seam, and measuring the doubly-filtered board
   * against the UNfiltered one attributes the agent filter's removals to this notice. Two ways that
   * went wrong (roborev 59075), both of which tell the reader something false:
   *   - 50 beads, the agent filter leaves 2, a P0 filter hides those 2 → "50 cards are hidden".
   *     The priority filter hid two.
   *   - The agent filter alone empties the board while any board filter is set → the notice fires,
   *     blames the priority/date filter, and offers a "Clear filters" button that resets only
   *     `boardFilter` and leaves the board just as empty. A remedy that cannot work is worse than
   *     no remedy: the reader follows it, nothing happens, and the real cause (named in the agent
   *     banner directly above) goes unread.
   * Requiring a NON-EMPTY agent-filtered baseline is what keeps the two explanations from
   * competing — an agent-filter emptiness belongs to the agent banner.
   */
  const hiddenByFilter = useMemo(() => {
    if (!agentOnlyBoard || !displayBoard || !filterActive) return 0;
    const size = (b: Board) =>
      b.backlog.length +
      b.blocked.length +
      b.inProgress.length +
      b.done.length +
      b.delivered.length +
      b.archived.length;
    const baseline = size(agentOnlyBoard);
    return baseline > 0 && size(displayBoard) === 0 ? baseline : 0;
  }, [agentOnlyBoard, displayBoard, filterActive]);
  // Workers live in the agent store; the Plan view reads them to show who's building each bead.
  const agents = useProjectStore((s) => s.projects.find((p) => p.id === project.id)?.agents ?? NO_AGENTS);

  /**
   * The NAME of the agent the board is filtered to, for the banner below.
   *
   * The banner used to print `boardAgentFilter` raw — a uuid the founder never chose and cannot
   * read, which told him the board was narrowed without telling him by whom. The id was always
   * resolvable: `agents` is right there, scoped to this board's project, and the filter is set from
   * a FEEDBACK pill on the same pair side (uiStore keys it per side precisely so a cross-project id
   * cannot land here).
   *
   * `agentDisplayName`, never `a.name` raw — a pinned or self-chosen name outranks the auto-name,
   * and reading the field directly is the stale-name split that helper exists to close.
   *
   * `null` means the agent is genuinely gone (closed, or the project switched under an open board).
   * The filter is deliberately NOT auto-cleared in that case: the beads are still labelled
   * `agent:<id>`, so the board really is narrowed, and this banner is the only visible explanation
   * for why. Dropping it would leave a silently short board with nothing to say why.
   */
  const filterAgentName = useMemo(() => {
    if (!boardAgentFilter) return null;
    const hit = agents.find((a) => a.id === boardAgentFilter);
    return hit ? agentDisplayName(hit) : null;
  }, [agents, boardAgentFilter]);

  return (
    <div
      // WHICH SIDE'S BOARD THIS IS. A pair mounts two of these at once and every per-side piece of
      // state (the agent filter, the priority/date filter, the Tasks/Epics kind toggles) is supposed to
      // move one of them without touching the other — a property that cannot be observed, or tested,
      // unless the two are told apart in the tree.
      data-board-side={side}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: C.forest,
        color: C.cream,
        minHeight: 0,
      }}
    >
      {/* NO TITLE ROW. It used to read "Tasks — <project>" above the columns, and the founder's call
          (third correction of this sitting) is that it says nothing the tab bar directly above does
          not already say — the project name is up there, and Plan/Build is the toggle beside it. A
          full-width 17px row plus its hairline was ~44px of the board's height spent restating that,
          taken from the cards, which is what the user actually came to read.

          The ERROR is what that row also carried, and it stays: a fetch failure keeps any prior
          snapshot on screen rather than wiping it, so the message is the only sign anything is
          stale. It gets its own thin banner now, rendered ONLY when there is one — an empty row is
          not reserved against the possibility. */}
      {error && (
        <div
          data-testid="board-error"
          style={{
            padding: "6px 16px",
            borderBottom: `1px solid ${C.hairline}`,
            color: C.sienna,
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          {error}
        </div>
      )}

      {/* Per-agent feedback filter banner: shown only while a FEEDBACK pill has narrowed the board.
          Clicking Clear drops the filter (boardAgentFilter → null) and the full board returns. */}
      {boardAgentFilter && (
        <div
          data-testid="board-agent-filter-banner"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 16px",
            borderBottom: `1px solid ${C.hairline}`,
            background: C.deepForest,
            color: C.cream,
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          <span data-testid="board-agent-filter-label">
            {filterAgentName === null ? (
              // The agent is gone. Say so in words rather than printing a bare uuid as if it were a
              // name, but still show a truncated id — it is the only handle left for "which one was
              // that", and an empty <strong> would read as a rendering bug.
              <>
                Showing feedback from a closed agent{" "}
                <strong>{boardAgentFilter.slice(0, 8)}…</strong>
              </>
            ) : (
              <>
                Showing feedback from <strong>{filterAgentName}</strong>
              </>
            )}
          </span>
          <span style={{ color: C.muted }}>·</span>
          <button
            type="button"
            onClick={() => useUiStore.getState().setBoardAgentFilter(side, null)}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              color: C.accentInk,
              cursor: "pointer",
              font: "inherit",
              textDecoration: "underline",
            }}
          >
            Clear
          </button>
        </div>
      )}

      {/* ══ A FILTER THAT EMPTIES THE BOARD MUST SAY SO ══════════════════════════════════════════
          Five empty columns are indistinguishable from a project with no work — the board would
          report "nothing here" while concealing every card, which is precisely the failure
          `sparkle-qogah` names ("never hide a row that needs action"). The count of what was hidden
          is the honest part: it says the work exists and the filter is why you cannot see it. The
          Clear here is a second copy of the bar's, deliberately, because the bar lives in a host row
          this component does not own and may be scrolled away from the empty space. */}
      {displayBoard && filterActive && hiddenByFilter > 0 && (
        <div
          data-testid="board-filter-empty-notice"
          style={{
            padding: "10px 16px",
            borderBottom: `1px solid ${C.hairline}`,
            background: C.deepForest,
            color: C.cream,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <span>
            No cards match this filter — <strong>{hiddenByFilter}</strong>{" "}
            {hiddenByFilter === 1 ? "card is" : "cards are"} hidden.
          </span>
          <button
            type="button"
            onClick={() => useUiStore.getState().setBoardFilter(side, NO_BOARD_FILTER)}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              color: C.accentInk,
              cursor: "pointer",
              font: "inherit",
              textDecoration: "underline",
            }}
          >
            Clear filters
          </button>
        </div>
      )}

      {/* ══ NEITHER KIND ON IS ALSO A FILTER THAT EMPTIES THE BOARD ═════════════════════════════
          Same contract as the notice directly above, for the one state the old exclusive mode could
          not reach: with two independent toggles the user can switch BOTH off, and the board then
          has every column present and empty. `hiddenByFilter` cannot speak to this — it measures
          the priority/date filter — so without this the board would silently report "nothing here"
          while concealing all of it, the exact failure `sparkle-qogah` names.

          The remedy is a real one, which is the property the sibling notice's own comment insists
          on: "Show both" writes both kinds back on, so following it always refills the board. A
          remedy that cannot work is worse than no remedy. */}
      {displayBoard && !planKinds.tasks && !planKinds.epics && (
        <div
          data-testid="board-plan-kinds-empty-notice"
          style={{
            padding: "10px 16px",
            borderBottom: `1px solid ${C.hairline}`,
            background: C.deepForest,
            color: C.cream,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <span>Neither Tasks nor Epics is shown — the board is hiding everything.</span>
          <button
            type="button"
            data-testid="board-plan-kinds-show-both"
            onClick={() => {
              // Re-read between the two flips. `togglePlanKind` is a flip, not a set, so acting on
              // one snapshot for both kinds would turn a kind back OFF if anything changed it in
              // between — a remedy that empties the board is the failure this notice exists to fix.
              for (const kind of ["tasks", "epics"] as const) {
                if (!useUiStore.getState().planKindsBySide[side][kind])
                  useUiStore.getState().togglePlanKind(side, kind);
              }
            }}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              color: C.accentInk,
              cursor: "pointer",
              font: "inherit",
              textDecoration: "underline",
            }}
          >
            Show both
          </button>
        </div>
      )}

      {/* ══ TASKS / EPICS ══════════════════════════════════════════════════════════════════════
          The founder could not SEE epics working: they were mixed into the task columns with
          nothing marking them out, and the `planning` stage had no column at all. These are the
          controls that separate them, and they are TWO INDEPENDENT TOGGLES — there is no "Both".
          "Both" was never a third kind of thing; it named the absence of a filter, so the control
          had three buttons for two facts and the way to see everything was the button whose label
          named neither kind. Each toggle now answers exactly one question: is this kind on the
          board.

          Rendered UNCONDITIONALLY, above the columns, and that placement is the point — switching
          either one off HIDES work, and a control that hides work has to be visible from the board
          it narrowed.

          `aria-pressed` (not `aria-checked`) with `role="group"`: these are two toggle BUTTONS
          whose states are independent, not a radiogroup with one winner. That distinction is the
          whole change, and it is the part a screen reader has to get right too. */}
      <div
        data-testid="board-plan-kinds"
        role="group"
        aria-label="Show tasks or epics"
        style={{
          display: "flex",
          gap: 2,
          padding: "6px 16px",
          borderBottom: `1px solid ${C.hairline}`,
          flexShrink: 0,
        }}
      >
        {PLAN_KINDS.map(({ kind, label }) => {
          const on = planKinds[kind];
          return (
            <button
              key={kind}
              type="button"
              data-testid={`board-plan-kind-${kind}`}
              aria-pressed={on}
              onClick={() => useUiStore.getState().togglePlanKind(side, kind)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 10px",
                borderRadius: PILL,
                // ALWAYS 1px, never `none`, so the two states occupy the SAME box and the row does
                // not reflow on a click. Only the colour changes: the selected pill's edge matches
                // its own fill, so it reads as one solid shape rather than as an outlined one.
                border: `1px solid ${on ? C.forest : C.hairline}`,
                cursor: "pointer",
                font: "inherit",
                fontSize: 12,
                fontWeight: on ? FONT_WEIGHT.semibold : FONT_WEIGHT.regular,
                background: on ? C.forest : "transparent",
                color: on ? C.cream : C.muted,
              }}
            >
              {/* THE MARKER IS WHAT MAKES "SELECTED" A PROPERTY OF THIS PILL, not of the row.
                  A filled-vs-empty pill alone is the language of a segmented control — one of N
                  wins — which is exactly the wrong reading now that the two toggles are
                  independent and can both be on. A per-pill mark says "this one is on" without
                  reference to its neighbour.

                  REACT-ICONS, NOT CHARACTERS. The first cut drew these as a check dingbat and a
                  white-circle dingbat (U+2713 / U+25CB) and `glyphIcons.test` caught it, correctly:
                  a dingbat resolves through whatever face the element inherits, so it changes
                  weight, baseline and optical size across platforms, while a Feather icon is
                  geometry on a fixed grid. `BoardView.tsx` is on that test's SWEPT list, so the
                  surface is held at ZERO rather than merely under a ceiling — and the scanner reads
                  comments too, so naming the codepoints is the way to describe them here without
                  putting one back.

                  BOTH STATES RENDER AN ICON of the same `size`, and the off state is a real ring
                  rather than nothing: a marker that appears and disappears would shift the label
                  sideways on every click, which is the cheapest possible way to make a good
                  control feel broken. */}
              <span
                aria-hidden="true"
                data-testid={`board-plan-kind-${kind}-marker`}
                data-mark={on ? "on" : "off"}
                style={{ display: "inline-flex", alignItems: "center", opacity: on ? 1 : 0.55 }}
              >
                {on ? <FiCheck size={11} /> : <FiCircle size={9} />}
              </span>
              {label}
            </button>
          );
        })}
      </div>

      {/* No snapshot yet → loading. Otherwise the current mode's columns. */}
      {!viewBoard ? (
        <div style={{ padding: 24, color: C.muted, fontSize: 13 }}>Loading tasks…</div>
      ) : (
        <div
          ref={colsRef}
          data-testid="board-columns"
          // THE BOARD OWNS THE WHEEL — see `boardScrollDelta`. Without this a vertical wheel could
          // only ever scroll a column's cards, so a board wider than its pair had columns that were
          // simply unreachable: the founder's BLOCKED column was clipped mid-card at the right edge
          // with no gesture that would bring it in.
          onWheel={onWheel}
          style={{
            flex: 1,
            display: "flex",
            gap: 12,
            padding: 16,
            overflowX: "auto",
            // Y IS NOT THIS ELEMENT'S AXIS. Leaving it `visible` makes the used value `auto` (CSS
            // overflow: one axis non-visible forces the other), which would put a second vertical
            // scroller around the columns and make "which thing did I just scroll" unanswerable.
            overflowY: "hidden",
            minHeight: 0,
          }}
        >
          {columns.map(({ key, label }) => (
            <Column
              // KEYED ON THE DATASET, not just the column — see `datasetKey` for which controls
              // are in it and why the beads array deliberately is not.
              key={`${datasetKey}:${key}`}
              columnKey={key}
              label={label}
              beads={viewBoard[key]}
              allBeads={allBeads}
              agents={agents}
              project={project}
              defs={defs}
              deliveryChip={deliveryChip}
              inReleaseByBead={inReleaseByBead}
              onDefine={setDefineStage}
              onOpen={handleOpen}
              // Archived stays the one COLLAPSED column (a header + count, no cards). The CAP is
              // wider than that: every terminal column gets it, because Done is where the volume
              // actually is. See TERMINAL_RENDER_CAP.
              collapsible={key === "archived"}
              renderCap={TERMINAL_COLUMNS.has(key) ? TERMINAL_RENDER_CAP : undefined}
            />
          ))}
        </div>
      )}

      {selectedBead && (
        <DetailOverlay
          bead={selectedBead}
          // THE BUCKET THAT PLACED THE CARD, read back off the board this view is actually
          // rendering — so the chip says "Being built" under the Being built header and "Planning"
          // under Planning in Epics mode, with no second rule to keep in step. Re-deriving it from
          // the bead would be wrong for exactly the epic case (see `ladderKeyOf`).
          placedIn={viewBoard === null ? null : ladderKeyOf(viewBoard, selectedBead.id)}
          projectId={project.id}
          allBeads={allBeads}
          agents={agents}
          onClose={() => setSelectedId(null)}
          onOpen={(b) => setSelectedId(b.id)}
          onBeadChat={onBeadChat}
        />
      )}

      {/* Definable Done & Delivered — the Define/Edit modal, opened from a column header or CTA. */}
      {defineStage && (
        <DefineStageModal
          stageKey={defineStage}
          projectName={project.name}
          projectRoot={project.rootPath}
          onClose={() => setDefineStage(null)}
        />
      )}
    </div>
  );
}

function Column({
  columnKey,
  label,
  beads,
  allBeads,
  agents,
  project,
  defs,
  deliveryChip,
  inReleaseByBead,
  onDefine,
  onOpen,
  collapsible = false,
  renderCap,
}: {
  // The LADDER key, not `BoardColumn`: the Epics mode renders a `planning` column the task board
  // has no bucket for. Every consumer below already answers null/false for an unrecognised key.
  columnKey: EpicLadderKey;
  label: string;
  beads: Bead[];
  allBeads: Bead[];
  agents: AgentTab[];
  project: Project;
  defs: StageDefs;
  deliveryChip?: DeliveryChip;
  inReleaseByBead: Map<string, boolean>;
  onDefine: (key: StageKey) => void;
  onOpen: (b: Bead) => void;
  /** Start collapsed (header + count only, no cards); the user expands on demand. Archived only. */
  collapsible?: boolean;
  /** When expanded, render at most this many cards; the rest are a "+N more" count. */
  renderCap?: number;
}) {
  // This column's own stage (for the header chip + undefined CTA), and the next stage a card here
  // is progressing toward (whose criteria the cards evaluate).
  const ownStageKey = definableStageKey(columnKey);
  const ownDef = ownStageKey ? defs[ownStageKey] : undefined;
  const ownDefined = isDefined(ownDef);
  const nextStageKey = nextStageOf(columnKey);
  const nextDef = nextStageKey ? defs[nextStageKey] : undefined;
  const nextDefined = isDefined(nextDef);

  // A collapsible column (Archived) starts closed so its ~thousands of cards are never mounted
  // until asked for. Local, not persisted: the resting default every time the board opens is
  // "closed", which is the whole point — it must not compete with the columns that carry live work.
  const [expanded, setExpanded] = useState(false);
  const isCollapsed = collapsible && !expanded;
  // PAGES REVEALED BEYOND THE CAP. A capped column that offers no way past the cap does not bound
  // the DOM, it HIDES work — fine for Archived, which is collapsible and explicitly a resting
  // place, and not fine for Done, which people scroll to find what shipped. Each click mounts one
  // more page instead of all 4,476, so the DOM stays bounded by what was actually asked for.
  // Local and not persisted, like `expanded`: every time the board opens, the cheap state is back.
  const [pages, setPages] = useState(1);
  // When expanded, cap the rendered cards. `bucketBeads` already visited every bead; only the DOM
  // is bounded here — the count above the cap is a number, never a node.
  const cap = renderCap === undefined ? beads.length : renderCap * pages;
  const rendered = isCollapsed ? [] : beads.slice(0, cap);
  const overflow = isCollapsed ? beads.length : beads.length - rendered.length;

  return (
    <div
      // Named so a measurement can ask which of the five columns actually FIT. The board is
      // `flex: 1 1 0` against a floor, in a horizontally scrolling row: width buys COLUMNS first
      // and only stretches once all five are on screen. That is the whole reason the board spans
      // its pair rather than one column of it (Workspace.PlanBoardSlot), so it needs to be
      // measurable rather than argued about.
      data-board-column={columnKey}
      style={{
        flex: "1 1 0",
        minWidth: 220,
        display: "flex",
        flexDirection: "column",
        background: C.deepForest,
        borderRadius: 6,
        minHeight: 0,
      }}
    >
      <StageColumnHeader
        columnKey={columnKey}
        label={label}
        count={beads.length}
        defined={ownDefined}
        deliveryChip={deliveryChip}
        onDefine={onDefine}
      />
      <div
        // The one vertical scroller on the board, and the element `boardScrollDelta` interrogates
        // before letting the wheel move the board sideways.
        {...{ [COLUMN_LIST_ATTR]: "" }}
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: "0 10px 12px",
          overflowY: "auto",
          // WHY THIS IS NOT LEFT ALONE: `overflow-x` defaults to `visible`, and CSS forces the used
          // value to `auto` when the other axis is not visible. So this list was silently a
          // HORIZONTAL scroller too — any card wider than the column (a long unbreakable title, an
          // id, a path) gave it scrollable width, and one sideways trackpad nudge pushed its
          // contents left. That is the founder's "card text clipped on the left edge": titles
          // reading "window drop is" / "causes" with the first words scrolled out of view. The
          // cards wrap now (see Card), and this makes the axis unavailable regardless.
          overflowX: "hidden",
          // CONTAIN THE Y AXIS ONLY, AND THE AXIS SUFFIX IS THE WHOLE POINT (roborev 57312).
          // Y: don't hand a spare vertical scroll to an ancestor — the wheel handler above decides
          // what happens at this list's end, and native chaining would race it.
          // X: this element is still a scroll CONTAINER on X (a hidden axis is a clipped scrollport,
          // not an absent one), so the unsuffixed `contain` also latched horizontal gestures HERE —
          // where nothing can move — instead of letting them chain to the board row. Over a column
          // tall enough to be a scroller (the 606-item BACKLOG) that left NO gesture that reached
          // the board: the vertical rule gives the list the wheel, and `contain` swallowed the
          // sideways swipe. Exactly the bug this change exists to fix, on the column that reported it.
          overscrollBehaviorY: "contain",
          minHeight: 0,
        }}
      >
        {/* Undefined Done/Delivered → the centered blue Define CTA (shown even above legacy cards). */}
        {ownStageKey && !ownDefined && (
          <DefineStageCta stageKey={ownStageKey} label={label} onDefine={onDefine} />
        )}
        {beads.length === 0 ? (
          // Suppress the "nothing here yet" hint when the Define CTA already fills an empty column.
          ownStageKey && !ownDefined ? null : (
            <div style={{ color: C.muted, opacity: 0.5, fontSize: 12, padding: "8px 2px" }}>
              Nothing here yet
            </div>
          )
        ) : isCollapsed ? (
          // COLLAPSED (Archived, default): no cards mounted at all — just the affordance to open.
          // The heading's count already states how many are in here; this button is the way in.
          <button
            type="button"
            data-testid={`board-column-expand-${columnKey}`}
            onClick={() => setExpanded(true)}
            style={{
              background: "transparent",
              border: `1px solid ${C.hairline}`,
              borderRadius: 6,
              color: C.accentInk,
              cursor: "pointer",
              font: "inherit",
              fontSize: 12,
              padding: "8px 10px",
              textAlign: "left",
            }}
          >
            Show {overflow} {label.toLowerCase()} {overflow === 1 ? "bead" : "beads"}
          </button>
        ) : (
          <>
            {rendered.map((b) => (
              <Card
                key={b.id}
                bead={b}
                allBeads={allBeads}
                agents={agents}
                project={project}
                nextStageKey={nextDefined ? nextStageKey : null}
                nextDef={nextDefined ? nextDef : undefined}
                inRelease={inReleaseByBead.get(b.id)}
                onOpen={onOpen}
              />
            ))}
            {/* THE FOOTER RENDERS WHENEVER THERE IS SOMETHING FOR IT TO SAY — an overflow to
                report, OR a collapsible column to close. Those are different conditions, and
                collapsing the two was a real bug: `Collapse` used to live INSIDE `overflow > 0`, so
                paging a collapsible column to its end unmounted the whole row and took the only
                route back to the cheap state with it. Archived with 51-100 beads reaches that after
                a SINGLE `Show more`, and from then on the column could not be closed again for the
                rest of the session — the affordance vanishing exactly where the DOM is most
                expensive (roborev 65718). */}
            {(overflow > 0 || (collapsible && expanded)) && (
              <div
                data-testid={`board-column-overflow-${columnKey}`}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 2px" }}
              >
                {overflow > 0 && (
                  <span style={{ color: C.muted, fontSize: 12 }}>
                    +{overflow} more not shown
                  </span>
                )}
                {/* THE WAY PAST THE CAP. Without this the cap is a content bug: on the founder's
                    store Done holds 4,476 beads, so a bare 50-card cap would make 4,426 of them
                    unreachable. One more page per click, never the whole pile. */}
                {overflow > 0 && (
                <button
                  type="button"
                  data-testid={`board-column-show-more-${columnKey}`}
                  onClick={() => setPages((n) => n + 1)}
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    color: C.accentInk,
                    cursor: "pointer",
                    font: "inherit",
                    fontSize: 12,
                    textDecoration: "underline",
                  }}
                >
                  Show more
                </button>
                )}
                {collapsible && (
                  <button
                    type="button"
                    // BOTH, not just `expanded`. Collapsing is the user saying "make this cheap
                    // again"; leaving `pages` behind means the next expand mounts N x CAP cards in
                    // one frame -- strictly worse than the unbounded column this cap replaced, and
                    // on the one column that exists to be cheap by default (roborev 65673).
                    onClick={() => {
                      setExpanded(false);
                      setPages(1);
                    }}
                    style={{
                      background: "transparent",
                      border: "none",
                      padding: 0,
                      color: C.accentInk,
                      cursor: "pointer",
                      font: "inherit",
                      fontSize: 12,
                      textDecoration: "underline",
                    }}
                  >
                    Collapse
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}


/** "Contains N tasks" — N is the count of OPEN children, i.e. remaining work, not total work. */
function ContainsTasks({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      data-testid="epic-contains-tasks"
      onClick={onToggle}
      aria-expanded={open}
      style={{
        alignSelf: "flex-start",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: "pointer",
        color: C.muted,
        fontSize: 12,
        fontFamily: FONT_UI,
      }}
    >
      <FiChevronRight
        size={11}
        aria-hidden
        style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms" }}
      />
      Contains {count} {count === 1 ? "task" : "tasks"}
    </button>
  );
}

/**
 * "Part of Epic: <name>" on a task card — the NAME, never the bead id. A raw `sparkle-131ms` tells
 * the reader nothing at a glance; "Concierge chat surface" tells them what the work is for.
 *
 * TRUNCATED RATHER THAN WRAPPED. The card already carries title, description preview, id, priority
 * chip, severity badge, workers line and the stage bar; a long epic name that wrapped to three
 * lines would push all of that around and make the column ragged.
 */
function ParentEpicLine({ epic, onOpen }: { epic: Bead; onOpen: (b: Bead) => void }) {
  return (
    <button
      data-testid="part-of-epic"
      onClick={() => onOpen(epic)}
      title={`Part of Epic: ${epicDisplayTitle(epic.title)}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        maxWidth: "100%",
        minWidth: 0,
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: "pointer",
        textAlign: "left",
        color: C.muted,
        fontSize: 12,
        fontFamily: FONT_UI,
      }}
    >
      <span style={{ flex: "0 0 auto" }}>Part of Epic:</span>
      <span
        style={{
          flex: "0 1 auto",
          minWidth: 0,
          color: C.tealInk,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {epicDisplayTitle(epic.title)}
      </span>
    </button>
  );
}

/**
 * ONE BOARD CARD — MEMOISED, and the memo is the point of this component's shape.
 *
 * The board mounts one of these per bead: 6,644 of them on the founder's store. Unmemoised, ANY
 * state change anywhere in `BoardView` — a delivery tick, a hover, opening the detail overlay —
 * re-rendered every one of them, and each card re-runs the epic resolvers and rebuilds its subtree.
 * That is the Plan->Build stall and the idle re-render, and it is why `onOpen` is a `useCallback`
 * and `delivery` is held at a stable identity: a memo whose props change identity every render is
 * strictly worse than no memo, because it pays a comparison per card and never skips.
 *
 * Default shallow comparison is correct here — every prop is either a primitive, a value from the
 * snapshot (stable per poll), or the stable `handleOpen`. Do not hand it a custom comparator to
 * paper over a prop that ought to be stable; fix the prop.
 */
const Card = memo(function Card({
  bead,
  allBeads,
  agents,
  project,
  nextStageKey,
  nextDef,
  inRelease,
  onOpen,
}: {
  bead: Bead;
  // NO `columnKey`. The card used to take the ladder key for one reason only — gating its inline
  // Build It on `backlog`/`planning` — and that gate moved into `useBeadBuildActions`, where it is
  // asked of the BEAD's own status so the detail overlay and the concierge card (neither of which
  // has a column) can answer it too. Leaving the prop here would invite the gate to grow back.
  allBeads: Bead[];
  agents: AgentTab[];
  project: Project;
  /** The defined next stage this card evaluates toward (null when that stage is undefined). */
  nextStageKey: StageKey | null;
  nextDef?: StageDefinition;
  inRelease?: boolean;
  onOpen: (b: Bead) => void;
}) {
  const preview =
    bead.description.length > DESC_PREVIEW
      ? `${bead.description.slice(0, DESC_PREVIEW)}…`
      : bead.description;
  const workers = workersForBead(agents, bead.id);
  // The unified 10-stage progress for this unit of work: prefer the live build progress of any
  // worker(s) on the bead, else map the bead's own status. Shown as the blue logo-gradient line.
  const workerIds = agents
    .filter((a) => a.kind === "worker" && a.beadId === bead.id)
    .map((a) => a.id);
  // Subscribe to ONLY this bead's workers' stages (shallow-compared) so a stage tick on an
  // unrelated agent doesn't re-render every card on the board.
  const workerStages = useRuntimeStore(
    useShallow(
      (s) => workerIds.map((id) => s.workflowStage[id]).filter(Boolean) as WorkflowStageId[],
    ),
  );
  const stage = beadStage(bead.status, bead.labels.includes(DELIVERED_LABEL), workerStages);

  // ── EPIC vs TASK — ONE RESOLVER, BOTH DIRECTIONS ─────────────────────────────────────────────
  // `isEpic` is the single predicate (typed `epic` OR has children); `parentEpicOf` is its inverse.
  // Keying either off `type === "epic"` is the mistake this codebase already made three times: // epic-guard-ok — this line only NAMES the anti-pattern in prose; it is not a condition.
  // several real parents are typed `feature`/`bug`/`task` and one of them has 19 children, so a
  // type check would leave every one of those children unlabelled.
  // INDEX-BACKED, and the reason is the whole point of this change: each of these four resolvers
  // used to walk the ENTIRE store, once per card. On the founder's 7,331-bead store that is four
  // 7,331-element scans x 6,644 cards on every render of the board — the 5-30s stall on show/hide
  // and Plan->Build. `epicIndexOf` is cached on array IDENTITY, so the first card pays the single
  // O(n) build and every other card is an O(1) map read.
  const epicIndex = epicIndexOf(allBeads);
  const beadIsEpic = isEpicIndexed(epicIndex, bead);
  // Only asked for a TASK. An epic that is itself nested would otherwise wear both the pill and a
  // parent line, which is more chrome than the card can carry.
  const parentEpic = beadIsEpic ? null : parentEpicOfIndexed(epicIndex, bead);
  // PER-CARD AND DELIBERATELY NOT PERSISTED — same contract as the Tasks/Epics kind toggles.
  // Collapsed is the default because a board of auto-expanded epics is unreadable.
  const [childrenOpen, setChildrenOpen] = useState(false);
  const openKids = beadIsEpic ? openChildCountIndexed(epicIndex, bead.id) : 0;
  const hasKids = beadIsEpic && childrenOfIndexed(epicIndex, bead.id).length > 0;

  return (
    // The card's visual shell is a div so the interactive Start button can live BESIDE the
    // clickable body (a <button> must not contain a nested <button>). The body button opens detail;
    // StartControls is a sibling, so a Start click never bubbles to the body.
    <div
      data-testid={beadIsEpic ? "board-card-epic" : "board-card-task"}
      // THE FOUNDER'S ASK: "I want epic cards to have a different colored background than regular
      // cards." Themed, because the two modes need different answers — see `epicCardFill`.
      style={{
        background: beadIsEpic ? C.epicCardFill : C.forest,
        border: `1px solid ${C.hairline}`,
        borderRadius: 6,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontFamily: FONT_UI,
        // NO `minWidth: 0` HERE, DELIBERATELY (roborev 57312). The reflex is to add one so a long
        // word cannot widen the card — but the content-based automatic minimum is a MAIN-AXIS rule
        // (CSS Flexbox §4.5), and this card is an item of a `flex-direction: column` list, so its
        // `min-width: auto` already resolves to 0. The declaration would be dead style that a later
        // reader would preserve, and worse, would suggest the wrap fix below is conditional on it.
        // What actually keeps a title inside its column is `overflowWrap: anywhere`.
      }}
    >
      <button
        onClick={() => onOpen(bead)}
        style={{
          textAlign: "left",
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          width: "100%",
          fontFamily: FONT_UI,
        }}
      >
        {/* TOP LEFT, on the same left edge the title starts on — the founder was explicit that this
            is not a floated-right corner badge. It carries the literal word EPIC, so the epic/task
            distinction is never colour-only (WCAG 1.4.1) even though the background carries it too. */}
        {beadIsEpic && <EpicPill />}
        <div
          style={{
            color: C.cream,
            fontWeight: FONT_WEIGHT.semibold,
            fontSize: 13,
            lineHeight: 1.3,
            // `anywhere`, not `break-word`: bead titles carry paths, branch names and identifiers
            // with no break opportunity at all, and `break-word` still lets such a word establish
            // the box's min-content width (it only breaks AFTER overflow is unavoidable).
            overflowWrap: "anywhere",
          }}
        >
          {/* Render-time only — the stored title is never rewritten. See `epicDisplayTitle`. */}
          {beadIsEpic ? epicDisplayTitle(bead.title) : bead.title}
        </div>
        {preview && (
          <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.4, overflowWrap: "anywhere" }}>
            {preview}
          </div>
        )}
        {/* The id line, now sharing its row with the priority chip. The chip reads at a glance on
            EVERY card (the founder's ask) without stealing a line from the title above it: the id is
            already the quietest row on the card, and priority is metadata of the same weight. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              color: C.muted,
              opacity: 0.7,
              fontSize: 12,
              fontFamily: FONT_MONO,
              minWidth: 0,
              overflowWrap: "anywhere",
            }}
          >
            {bead.id}
          </span>
          <BeadPriorityChip priority={bead.priority} />
          {/* SEVERITY — a SEPARATE axis beside priority (the founder asked for both visible). Reads
              the `sev-<N>` label; renders nothing when the bead has no score, which is most of them. */}
          <BeadSeverityBadge severity={severityOf(bead)} />
        </div>
        {workers.length > 0 && (
          <div style={{ color: C.tealInk, fontSize: 12, lineHeight: 1.4 }}>
            <FiUsers size={11} style={{ verticalAlign: "-2px", marginRight: 3 }} aria-hidden />
            {workers.length === 1 ? "1 worker" : `${workers.length} workers`}: {workers.join(", ")}
          </div>
        )}
        {/* Unified Think→Plan→Build progress: the blue logo-gradient line + its stage label. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <WorkflowLine stage={stage} height={3} />
          </div>
          <span
            style={{
              flex: "0 0 auto",
              fontSize: 10,
              fontWeight: 600,
              color: stageLineColor(stage),
              whiteSpace: "nowrap",
            }}
          >
            {stageMeta(stage).short}
          </span>
        </div>
      </button>
      {/* ── BELOW THE STATUS BAR ─────────────────────────────────────────────────────────────────
          Both of these are SIBLINGS of the body button, not children of it: they are interactive,
          and a <button> may not contain another one. That also keeps their clicks off the
          open-detail handler, so expanding an epic does not open it. */}
      {beadIsEpic &&
        (hasKids ? (
          <ContainsTasks
            count={openKids}
            open={childrenOpen}
            onToggle={() => setChildrenOpen((v) => !v)}
          />
        ) : (
          // "An epic with zero children should say so plainly rather than expanding into nothing."
          <span style={{ color: C.muted, fontSize: 12 }}>Contains no tasks yet</span>
        ))}
      {beadIsEpic && childrenOpen && (
        <EpicLiveStatus epicId={bead.id} allBeads={allBeads} agents={agents} onOpen={onOpen} />
      )}
      {/* The mirror of the pill — from a child you can see the theme it serves, and click through to
          it. Absent for an orphan task: those are normal, not an error state, and must not be
          visually shamed. */}
      {parentEpic && <ParentEpicLine epic={parentEpic} onOpen={onOpen} />}
      {/* Build It: claim + hand off to Build, with the epic decompose-state affordances (disabled
          while decomposing/childless, retry on failure).

          ── NO COLUMN CHECK AND NO TYPE CHECK ON THIS LINE ANY MORE ──────────────────────────────
          Both used to live here — `(columnKey === "backlog" || columnKey === "planning") &&
          isEpic(allBeads, bead)` — and NEITHER was shared with the detail overlay or the concierge
          card. That is the whole reason the two gates disagreed: this line hid Build It outside
          Backlog/Planning and on every non-epic, while the overlay gated on TYPE alone and offered
          it in any column, including on work already in progress. Two gates, two answers, one
          question.

          `StartControls` now asks `useBeadBuildActions` — the SAME hook the other two surfaces ask
          — and renders nothing when it says no. The rule moved; it did not get deleted. */}
      <StartControls bead={bead} allBeads={allBeads} project={project} />
      {/* Definable Done & Delivered (Unit 5): when the card's NEXT stage is defined, show its compact
          criteria progress + the confirm-first "Mark as …" control (only when every criterion is met).
          A sibling of the body button so its clicks never open the detail overlay. */}
      {nextStageKey && nextDef && (
        <CardCriteria
          bead={bead}
          stageKey={nextStageKey}
          def={nextDef}
          stage={stage}
          inRelease={inRelease}
          projectRoot={project.rootPath}
        />
      )}
    </div>
  );
});

/**
 * The card's inline "Build It" (spec §7) — claim the bead (→ in_progress) and hand it to the Build
 * orchestrator.
 *
 * ══ IT NO LONGER HAND-ROLLS THE HANDOFF, AND THAT IS THE POINT ═════════════════════════════════
 * This used to call `sendToBuildBlockedReason` → `claimBead` → `sendToBuild` itself: a FOURTH copy
 * of an ordering that had already been a review finding twice (roborev 55139, 55150). It also
 * always took `sendToBuild`'s DEFAULT mode — "epic" — which was invisible while only epics could
 * reach it and becomes wrong the moment a bug can: the epic seed prompt says "decompose them
 * across isolated worker agents", which is not what a single bug wants to hear.
 *
 * Going through `useBeadBuildActions` fixes both at once and buys the thing the founder actually
 * asked for: this card, the detail overlay and the concierge's `BeadPill` now offer Build It on
 * exactly the same beads, because there is only one rule and none of them owns it.
 *
 * What stays here is the part that is genuinely the CARD's: the epic decompose-state affordances.
 * Disabled with a "decomposing…" tooltip while an epic is still being decomposed (zero children)
 * or carries the `decomposing` label; both the `decomposing…` and `decompose failed` badges are
 * click-to-clear (stuck-label recovery / retry — clearing the label lets the next sweep
 * re-decompose). All clicks stopPropagation so they never open the card's detail overlay.
 */
function StartControls({
  bead,
  allBeads,
  project,
}: {
  bead: Bead;
  allBeads: Bead[];
  project: Project;
}) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // THE SHARED GATE AND THE SHARED HANDOFF. `buildIt` is `buildEpic` for an epic and `buildTask`
  // for everything else, already carrying the preflight-before-claim ordering and the right
  // `mode` — and it is NULL once the bead has been started or closed, which is what makes this
  // card agree with the overlay and the concierge without knowing their rules.
  const { buildIt } = useBeadBuildActions({ bead, projectId: project.id, allBeads });
  const beadIsEpic = isEpicIndexed(epicIndexOf(allBeads), bead);
  const isDecomposing = bead.labels.includes(DECOMPOSING_LABEL);
  const isFailed = bead.labels.includes(DECOMPOSE_FAILED_LABEL);
  // AN EPIC-ONLY GATE, and it has to be — a childless EPIC has nothing to fan out to, so Build It
  // waits for decompose. A bug, task or feature IS the unit of work and never has children, so
  // asking it the same question would disable the button on every single non-epic bead: the exact
  // bug this change exists to fix, re-created one line below the fix.
  const noChildren = beadIsEpic && childrenOfIndexed(epicIndexOf(allBeads), bead.id).length === 0;
  const startDisabled = isDecomposing || noChildren || busy;
  const isStalled = bead.labels.includes(STALLED_LABEL);

  // ══ THE EARLY RETURN IS NARROW ON PURPOSE — A REFUSAL MUST NOT EAT THE REMEDY ════════════════
  // This used to be `if (!buildIt) return null`, which took the recovery badges down with the
  // button. That is at its worst for exactly the bead that needs them: the sweep writes
  // STALLED_LABEL to mean "we spent this epic's restart and it bought nothing; wait for the human",
  // `beads.ts` names being PICKED UP as one of only three ways back — and Build It is that pickup.
  // So hiding the button hid the last in-app way out, leaving `bd label remove` at the CLI as the
  // founder's only remedy, and a stalled epic that had ALSO failed to decompose lost its
  // click-to-clear retry at the same time (roborev 65607).
  //
  // So: render nothing only when there is genuinely nothing to show. The button is conditional; the
  // badges are not.
  const showButton = buildIt !== null;
  if (!showButton && !isDecomposing && !isFailed && !isStalled && !err) return null;

  async function handleStart(e: MouseEvent) {
    e.stopPropagation(); // never let Build It also open the detail overlay
    if (startDisabled || !buildIt) return;
    setErr("");
    setBusy(true);
    try {
      // The preflight-before-claim ordering (roborev 55139) lives in the hook now: `claimBead`
      // moves the bead to in_progress, which is a state this control does not render in at all —
      // so claiming and THEN failing would hide the button the user just pressed.
      await buildIt();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  // ══ CLEARING "STALLED" MUST MIRROR THE SWEEP'S OWN CLEAR — BOTH LABELS ══════════════════════
  // `epicSweepRunner` takes STALLED_LABEL and SWEEP_NO_AUTO_LABEL off together, with the invariant
  // stated at its clear path: "BOTH labels come off, on a genuine clear and on a stand-in reset
  // alike. Leaving the marker behind would reset the epic on every tick from here on."
  //
  // A board chip that removed only the first would orphan the marker, and the sweep cannot then
  // reach it: the condition it keys on is `already-escalated`, which is exactly what clearing the
  // stalled label erases. The orphan surfaces much later, as ONE EXTRA automatic restart handed to
  // an epic whose contract is "wait for the human" (roborev 65617).
  //
  // The removals are sequential and the second is tolerant of the label being absent — the common
  // case is a stalled epic with no marker at all, written while the restart half was enabled.
  async function clearStalled(e: MouseEvent) {
    e.stopPropagation();
    setErr("");
    try {
      await labelBead(project.rootPath, "remove", bead.id, STALLED_LABEL);
      await labelBead(project.rootPath, "remove", bead.id, SWEEP_NO_AUTO_LABEL);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    }
  }

  async function clearLabel(e: MouseEvent, label: string) {
    e.stopPropagation();
    setErr("");
    try {
      await labelBead(project.rootPath, "remove", bead.id, label);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
      {showButton && (
      <button
        // Scoped per card, because "Build It" is no longer unique on the board: it now appears on
        // every startable card, so `getByText("Build It")` is ambiguous by design rather than by
        // accident. Distinct from the detail overlay's `board-bead-card-build-it`.
        data-testid="board-card-build-it"
        onClick={handleStart}
        disabled={startDisabled}
        title={
          startDisabled
            ? "decomposing…"
            : beadIsEpic
              ? "Build It — claim this epic and hand it to the Build orchestrator"
              : "Build It — claim this unit of work and hand it to the Build orchestrator"
        }
        style={{
          background: startDisabled ? C.deepForest : C.teal,
          color: startDisabled ? C.muted : C.cream,
          border: "none",
          borderRadius: 4,
          padding: "3px 12px",
          fontSize: 12,
          fontWeight: FONT_WEIGHT.semibold,
          cursor: startDisabled ? "default" : "pointer",
          fontFamily: FONT_UI,
        }}
      >
        Build It
      </button>
      )}
      {/* THE STALLED CHIP — the way back the refusal above owes the user. Clearing the label takes
          the epic out of the Blocked lane, which makes `isStartable` true again and brings Build It
          back on the very next poll. Same click-to-clear shape as its two neighbours. */}
      {isStalled && (
        <button
          data-testid="board-card-clear-stalled"
          onClick={(e) => clearStalled(e)}
          title="Stalled — the sweep gave up and is waiting for you. Click to clear the label and hand it off again"
          style={{
            background: "transparent",
            border: `1px solid ${C.sienna}`,
            borderRadius: 4,
            color: C.sienna,
            cursor: "pointer",
            padding: "2px 8px",
            fontSize: 12,
            fontFamily: FONT_UI,
          }}
        >
          stalled
        </button>
      )}
      {isDecomposing && (
        <button
          onClick={(e) => clearLabel(e, DECOMPOSING_LABEL)}
          title="Stuck? Click to clear the decomposing label so the next sweep retries"
          style={{
            background: "transparent",
            border: `1px solid ${C.muted}`,
            borderRadius: 4,
            color: C.muted,
            cursor: "pointer",
            padding: "2px 8px",
            fontSize: 12,
            fontFamily: FONT_UI,
          }}
        >
          decomposing…
        </button>
      )}
      {isFailed && (
        <button
          onClick={(e) => clearLabel(e, DECOMPOSE_FAILED_LABEL)}
          title="Decompose failed — click to retry (clears the label; the next sweep re-decomposes)"
          style={{
            background: "transparent",
            border: `1px solid ${C.sienna}`,
            borderRadius: 4,
            color: C.sienna,
            cursor: "pointer",
            padding: "2px 8px",
            fontSize: 12,
            fontFamily: FONT_UI,
          }}
        >
          decompose failed
        </button>
      )}
      {err && <span style={{ color: C.sienna, fontSize: 12 }}>{err}</span>}
    </div>
  );
}

/**
 * The epic's live build status (spec §7): the bound orchestrator's name + one row per child task
 * showing its live WorkflowLine stage and the workers on it — "see the whole epic's build from
 * Plan". Renders nothing until the epic has children (a still-decomposing epic shows the
 * decomposing badge on its board card instead).
 */
function EpicLiveStatus({
  epicId,
  allBeads,
  agents,
  onOpen,
}: {
  epicId: string;
  allBeads: Bead[];
  agents: AgentTab[];
  /** Open a child's own card. Optional so a read-only mount stays possible. */
  onOpen?: (b: Bead) => void;
}) {
  const rows = epicChildViews(allBeads, agents, epicId);
  if (rows.length === 0) return null;
  const orchestrator = orchestratorNameForEpic(allBeads, agents, epicId);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, fontSize: 13 }}>
        <span style={{ color: C.muted, minWidth: 90 }}>Orchestrator</span>
        <span style={{ color: orchestrator ? C.teal : C.muted }}>
          {orchestrator ?? "not started"}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((row) => (
          <EpicChildRow key={row.bead.id} row={row} agents={agents} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

/** One child-task row of the epic's live status view: title + live stage (from the child's
 *  worker(s), same subscription pattern as the board Card) + the workers on it. */
function EpicChildRow({
  row,
  agents,
  onOpen,
}: {
  row: EpicChildView;
  agents: AgentTab[];
  onOpen?: (b: Bead) => void;
}) {
  const { bead, workers } = row;
  const workerIds = agents
    .filter((a) => a.kind === "worker" && a.beadId === bead.id)
    .map((a) => a.id);
  const workerStages = useRuntimeStore(
    useShallow(
      (s) => workerIds.map((id) => s.workflowStage[id]).filter(Boolean) as WorkflowStageId[],
    ),
  );
  const stage = beadStage(bead.status, bead.labels.includes(DELIVERED_LABEL), workerStages);
  // CLICKABLE WHEN A HANDLER IS GIVEN — "I basically want to be able to easily go between task cards
  // and epic cards with clicks relating the two to each other." Rendered as a real <button> in that
  // case rather than a div with onClick, so it is keyboard-reachable and announced as actionable;
  // without a handler it stays the plain div it has always been.
  const Tag = onOpen ? "button" : "div";
  return (
    <Tag
      {...(onOpen
        ? { onClick: () => onOpen(bead), type: "button" as const, "data-testid": "epic-child-row" }
        : {})}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "6px 8px",
        background: C.forest,
        borderRadius: 6,
        // Only meaningful on the button arm; harmless on the div.
        width: "100%",
        textAlign: "left",
        border: "none",
        font: "inherit",
        cursor: onOpen ? "pointer" : undefined,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0, color: C.cream, fontSize: 13 }}>{bead.title}</span>
        <span
          style={{
            flex: "0 0 auto",
            fontSize: 10,
            fontWeight: 600,
            color: stageLineColor(stage),
            whiteSpace: "nowrap",
          }}
        >
          {stageMeta(stage).short}
        </span>
      </div>
      <WorkflowLine stage={stage} height={3} />
      {workers.length > 0 && (
        <div style={{ color: C.tealInk, fontSize: 12, lineHeight: 1.4 }}>{workers.join(", ")}</div>
      )}
    </Tag>
  );
}

function DetailOverlay({
  bead,
  placedIn,
  projectId,
  allBeads,
  agents,
  onClose,
  onOpen,
  onBeadChat,
}: {
  bead: Bead;
  /** Which column of the board behind this overlay holds the bead — the status chip's whole
   *  content. Threaded from `BoardView` rather than re-derived so the chip and the header the
   *  reader just clicked through cannot disagree. */
  placedIn: EpicLadderKey | null;
  projectId: string;
  allBeads: Bead[];
  agents: AgentTab[];
  onClose: () => void;
  /** Swap the overlay to another bead — a child row, so the epic↔task walk works here too. */
  onOpen: (b: Bead) => void;
  /** Threaded straight through from `BoardView`. Absent in a window with no composer — see the
   *  note on BoardView's own prop. */
  onBeadChat?: (bead: Bead) => void;
}) {
  const beadIsEpic = isEpicIndexed(epicIndexOf(allBeads), bead);
  const workers = workersForBead(agents, bead.id);
  // The project's checkout root — every WRITE is addressed by PATH. Looked up here because the
  // overlay only receives a projectId.
  const rootPath = useProjectStore(
    (s) => s.projects.find((p) => p.id === projectId)?.rootPath ?? null,
  );

  // THE THREE BUILD HANDOFFS, from the shared hook rather than three local copies.
  // They used to be ~75 lines of `handleBuildIt`/`handleBuildTask`/`handleBuildAllPrd` right here,
  // which is precisely why the concierge card could not offer them: the logic was welded to this
  // component. `onStarted: onClose` preserves the old behaviour of dismissing on a successful
  // handoff.
  const buildActions = useBeadBuildActions({ bead, projectId, allBeads, onStarted: onClose });

  // The unified Think→Plan→Build stage — the SAME computation the collapsed `Card` does. Its
  // absence here is the founder's item 1: the blue line and its word were on the closed card and
  // vanished the moment he opened it, because these were two components sharing no code.
  const workerIds = agents
    .filter((a) => a.kind === "worker" && a.beadId === bead.id)
    .map((a) => a.id);
  const workerStages = useRuntimeStore(
    useShallow(
      (s) => workerIds.map((id) => s.workflowStage[id]).filter(Boolean) as WorkflowStageId[],
    ),
  );
  const stage = beadStage(bead.status, bead.labels.includes(DELIVERED_LABEL), workerStages);

  // ── COMMENT THREAD — READ LAZILY, ONLY ON OPEN ───────────────────────────────────────────────
  // This overlay mounts only when a card is OPENED (`selectedBead && <DetailOverlay>`), so the one
  // `beads_detail` call below — which carries `--include-comments` — runs per-open, NOT on the board's
  // 5s list poll. Pulling every bead's whole thread on every tick would hammer the already-contended
  // bd store; the poll stays on `listBeads`, which never asks for comments.
  const [comments, setComments] = useState<BeadComment[] | undefined>(undefined);
  // Bumped after a successful post so the thread re-reads and shows the new comment.
  const [commentReload, setCommentReload] = useState(0);
  useEffect(() => {
    if (rootPath === null) return;
    let alive = true;
    beadsDetail(rootPath, bead.id)
      .then((d) => {
        if (alive) setComments(d.comments);
      })
      // A failed detail read degrades to an empty thread — the card must still be usable — and the
      // compose box below (which has its own error surface) remains available.
      .catch(() => {
        if (alive) setComments([]);
      });
    return () => {
      alive = false;
    };
  }, [rootPath, bead.id, commentReload]);

  // The write half. Absent when the project has no path (every bd write is addressed by path), which
  // makes `BeadCard` render a read-only thread with no compose box.
  const handleComment =
    rootPath === null
      ? undefined
      : async (text: string) => {
          await beadsComment(rootPath, bead.id, text);
          setCommentReload((n) => n + 1);
        };

  // ── ESCAPE CLOSES IT ─────────────────────────────────────────────────────────────────────────
  // The scrim already dismissed on an outside click; Escape was simply absent from this file. The
  // founder hit the same dead end on the concierge card ("right now I have to click back on the
  // bead pill to close it"), and the two surfaces get the same contract.
  //
  // `defaultPrevented` first, then `preventDefault`: Escape has a global consumer (engine/cable),
  // so one press must peel exactly one layer.
  //
  // ══ THE MENU GUARD IS NOT OPTIONAL, AND THE OBVIOUS REASONING ABOUT IT IS BACKWARDS ══════════
  // An earlier version of this comment claimed the priority menu "registers its listener LATER and
  // therefore runs first". That is inverted: same-target, same-phase listeners fire in REGISTRATION
  // order, so THIS handler — registered when the overlay mounted — runs BEFORE the menu's, which is
  // registered only when the menu opens. Without the guard, one Escape with the menu open closes
  // the whole overlay, and the menu's own `defaultPrevented` bail then swallows the press it was
  // supposed to consume. `BeadPill` already guards exactly this way; the component that exists so
  // these two surfaces cannot diverge had diverged here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (beadCardMenuIsOpen()) return; // the menu is the innermost layer; let it take this press
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ── THE OVERLAY IS NOW A FRAME AROUND THE SHARED CARD ────────────────────────────────────────
  // Everything the panel used to draw by hand — title, close, id, priority, type, labels, epic,
  // description, workers — is `BeadCard`, the SAME component the concierge renders. That is the
  // whole point of the change: the two presentations diverged field by field precisely because
  // they were two hand-maintained copies, and the founder could not trust either view to be
  // complete. What stays here is what is genuinely board-only: the scrim, the panel box, and the
  // epic child roll-up.
  //
  // The card also brings the STATUS LINE the open card was missing (his item 1): it was on the
  // collapsed card and vanished on open, because `Card` and `DetailOverlay` shared no JSX.
  return (
    <div
      // Click-outside (the scrim) dismisses — and so does Escape now; see the effect above. The
      // pair is the app's standard modal contract (ModalShell), and the overlay had only half of it.
      onClick={onClose}
      style={{
        position: "absolute",
        inset: 0,
        background: SCRIM,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        zIndex: 50,
      }}
    >
      <div
        // ══ IT MUST ANNOUNCE ITSELF AS AN ESCAPE-OWNING SURFACE ═══════════════════════════════
        // `engine/cable.ts`'s `dismissibleSurfaceOpen` probes for exactly
        // `[role="dialog"], [role="menu"], [data-dismissible-open="true"]`. Workspace's Escape
        // listener is registered at APP MOUNT — before this overlay's — so it runs FIRST, and with
        // nothing here for that probe to find, `unbindsOnKey` returned true: rung 1 unwired the
        // concierge from its row and, since `defaultPrevented` was still false at that instant,
        // ARMED rung 2. The overlay then closed, so the user's next Escape hit rung 2 and cleared
        // the build row in every pair on screen. That is the precise failure roborev 55478 was
        // closed to prevent, re-created through a surface the DOM probe could not see.
        role="dialog"
        aria-modal="true"
        // Stop clicks inside the card from bubbling to the scrim (which would close it).
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(620px, 100%)",
          maxHeight: "100%",
          overflowY: "auto",
          background: C.dialogSurface,
          border: `1px solid ${C.dialogEdge}`,
          borderRadius: RADIUS.modal,
          boxShadow: MODAL_SHADOW,
          padding: 20,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <BeadCard
          bead={bead}
          chrome="board"
          stage={stage}
          placedIn={placedIn}
          workers={workers}
          // NO `descMaxHeight` — the panel above is already the scroller (`maxHeight: 100%` +
          // `overflowY: auto`). Capping the description again would put a second scrollbar inside
          // the first. The concierge passes 180 because it has no such panel of its own.
          onClose={onClose}
          // Bound to THIS bead here rather than in `BeadCard`, which takes a bare `() => void` so it
          // never has to know what a bead chat is addressed by.
          onChat={onBeadChat === undefined ? undefined : () => onBeadChat(bead)}
          // A project missing from the store has no path, and every bd write is addressed by path —
          // so the card degrades to read-only rather than offering a control that cannot work.
          onSetPriority={
            rootPath === null ? undefined : (p) => setBeadPriority(rootPath, bead.id, p)
          }
          onBuildIt={buildActions.buildIt ?? undefined}
          // `buildAllPrd` is null for anything that is not an epic — the gate lives in the hook now,
          // so this surface and the concierge cannot drift apart on it again.
          onBuildAllPrd={buildActions.buildAllPrd ?? undefined}
          prdEpicCount={buildActions.prdEpics.length}
          // Lazily-read thread + the shipped `beadsComment` write path. Both undefined when the
          // project has no path, degrading the card to a read-only thread.
          comments={comments}
          onComment={handleComment}
        />

        {/* BOARD-ONLY, and the reason this overlay still exists as more than a frame: the per-child
            stage roll-up for an epic. It is a view of OTHER beads, not of this one, so it is not a
            field the concierge card is missing — it is a different surface that happens to live
            here. */}
        {beadIsEpic && (
          <EpicLiveStatus epicId={bead.id} allBeads={allBeads} agents={agents} onOpen={onOpen} />
        )}
      </div>
    </div>
  );
}
