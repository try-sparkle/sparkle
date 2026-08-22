// The SIDEBAR VIEW-STATE tool domain for the concierge — the Build column's own controls.
//
// WHY IT EXISTS. The concierge can already SAY "3 agents need you in web". It could not PUT THE
// HUMAN THERE: filtering the column to those rows, opening the subtree the row lives in, landing on
// it, and clearing the noise were all mouse-only. Every one of those is a store write that already
// exists and is already tested — they simply had no callable surface. This module is that surface,
// and nothing more.
//
// This module is a FAÇADE, not an implementation. Every operation wraps a path that already exists
// (uiStore's status-band filter and orchestrator collapse records, services/agentReveal's
// selectAndOpen, engine/buildSections' grouping, useAttentionNotifications' rollup composition).
// Nothing here re-derives a rule those modules own.
//
// FIVE CONTRACTS, each enforced rather than merely documented:
//
// 1. TYPED RESULTS, NEVER THROWN STRINGS. Every function returns `SidebarViewResult<T>`: an `ok`
//    value or a refusal carrying a machine-readable `reason` plus a sentence the concierge can say
//    out loud. Same shape, and same reasoning, as services/conciergeTools/workspace.ts — a tool
//    caller has to branch on WHY, and an exception across a bridge arrives as an opaque string.
//    Nothing in this domain is async and nothing here can throw, so there is no `backend-failed`.
//
// 2. AN EXHAUSTIVE RISK MAP. `SidebarViewOp` is derived from the `SIDEBAR_VIEW_OPS` list and
//    `SIDEBAR_VIEW_OP_RISK` is a `Record<SidebarViewOp, SidebarViewRiskClass>` — so adding an
//    operation to the list without classifying it is a TYPECHECK FAILURE, not a runtime surprise.
//
// 3. THESE ARE VIEW-STATE OPS, AND THEY ARE CLASSIFIED HONESTLY. Nothing here starts, stops, kills
//    or deletes anything; the heaviest thing in the domain rearranges pixels. So the classes are
//    `read-only` and `view` — deliberately NOT borrowed from workspace.ts's destructive ladder,
//    where `disruptive` means "work in flight dies". Reusing those words here would train a caller
//    to read "routine" on a tab close and "routine" on a filter chip as the same amount of care.
//    ONE EXCEPTION: `select_row` is `disruptive`, because changing the SELECTED row swaps the
//    terminal pane out from under a human who may be mid-sentence in the composer. Filtering the
//    column around someone is rude; moving the pane they are typing into loses their place. That
//    distinction — filter vs. selection — is the whole reason this domain has two write classes.
//
// 4. EVERY FILTER/ISOLATE OP IS REVERSIBLE AND SAYS HOW. Each write returns the state it REPLACED
//    (`priorBands`, `priorCollapsed`, `priorSelection`, `priorWorkMode`) alongside the new state, so
//    the concierge can put the view back exactly as it found it — `setStatusBands(prior)` and
//    `setOrchestratorsCollapsed(prior)` take those snapshots back verbatim. A concierge that
//    narrows someone's column to answer a question and cannot undo it has made the column worse.
//
// 5. LIVE STATE IS READ FROM THE STORES, NEVER FROM THE CALLER. No operation takes a "the row is
//    currently visible" or "this agent is an orchestrator" flag; it reads uiStore / projectStore /
//    runtimeStore at call time. A tool call arrives with whatever the model believed one turn ago.
//
// WHAT IS DELIBERATELY ABSENT: project scoping and the concierge pin. The Build column is scoped by
// `projectStore.selectedProjectId` (windowContext.useCurrentProjectId → Workspace → AgentSidebar),
// and `selectProject` / `openProjectTab` / `setProjectPinned` are already
// services/conciergeTools/workspace.ts's operations. A second door onto the same state is how two
// domains start disagreeing about which one owns it. The cross-project case IS still covered:
// `selectRow` lands through services/openProjectTab, which selects the owning project's tab on the
// way in — a row you cannot see because its project isn't scoped is not a row you were taken to.
// There is also NO search box in the Build column to wrap — the full-text search moved to the
// concierge command palette (historyStore), and workspace.ts already exposes `search_history`.
import { useProjectStore } from "../../stores/projectStore";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { REVEAL_REQUEST_TTL_MS, SPARKLE_PANE_SIDE, useUiStore, type WorkMode } from "../../stores/uiStore";
import { sideOf } from "../../engine/pairs";
import { useBeadsStore } from "../../stores/beadsStore";
import { epicIndexOf, isEpicIndexed } from "../../services/beads";
// The MODE LIST as a value, so the guard below is derived from the same source as the type rather
// than re-listing it (roborev 60625).
import { WORK_MODES, isWorkMode } from "../../engine/workMode";
import type { PairSide } from "../../engine/cable";
import {
  BUILD_SECTIONS,
  STATUS_BANDS,
  allBandsVisible,
  groupAgentsByStage,
  type BuildSectionId,
  type StatusBand,
} from "../../engine/buildSections";
import { crossRepoAccessors } from "../../engine/crossRepo";
import { slugForRoot } from "./repoSlug";
import { topLevelAgents } from "../../engine/agentOrdering";
import {
  resolveStage,
  rollupHoldsWork,
  rollupStages,
  uncommittedWorkEvidence,
  type WorkflowStageId,
} from "../../engine/workflowStage";
import { bandOfRollup } from "../../engine/workerRollup";
import { publishedStatusFor, rollupViewFor } from "../../useAttentionNotifications";
import { openProjectTab } from "../openProjectTab";
import type { AgentKind, AgentTab, AgentTabStatus, Project } from "../../types";

// ---------------------------------------------------------------------------------------------
// Operations + risk
// ---------------------------------------------------------------------------------------------

/** Every operation this domain offers. The source of the `SidebarViewOp` union — add here and the
 *  risk map below stops compiling until the new operation is classified. */
export const SIDEBAR_VIEW_OPS = [
  "read_sidebar_view",
  "list_build_rows",
  "toggle_status_band",
  "isolate_status_band",
  "set_status_bands",
  "show_all_status_bands",
  "expand_orchestrators",
  "collapse_orchestrators",
  "set_orchestrators_collapsed",
  "set_work_mode",
  "focus_epic",
  "clear_epic_focus",
  "reveal_row",
  "select_row",
] as const;

export type SidebarViewOp = (typeof SIDEBAR_VIEW_OPS)[number];

/**
 * How much a caller should think before invoking an operation. THREE classes, and the domain only
 * needs three because nothing here touches work in flight (see contract 3).
 *
 *  • `read-only`  — observes; changes nothing.
 *  • `view`       — changes WHAT THE HUMAN SEES and nothing else: which bands the column shows,
 *                   which subtrees are open, which chevron is active, where the column is scrolled.
 *                   Every one of these is one click away from undone, and each returns the state it
 *                   replaced so the caller can undo it without the human clicking at all.
 *  • `disruptive` — changes the SELECTED row. Reserved for exactly that: selection swaps the
 *                   terminal pane, so a human mid-sentence in the composer loses their place and
 *                   has to find their way back. No amount of "it's only the view" makes that free.
 *
 * DOMAIN-PREFIXED on purpose, matching `LifecycleRisk` / `WorkflowRiskClass` / `SettingsRiskClass`.
 * services/conciergeTools/workspace.ts exports its OWN risk vocabulary from this same directory,
 * and the two share the member name `disruptive` while meaning different things by it — there,
 * work in flight dies; here, the pane moved. An aggregator that imports both (policy.ts) would
 * otherwise have to alias one, and a caller gating on `risk === "disruptive"` across domains would
 * apply a tab-close's amount of care to a filter chip. The prefix is what keeps them distinct.
 */
export type SidebarViewRiskClass = "read-only" | "view" | "disruptive";

/**
 * The classification. EXHAUSTIVE by construction: `Record<SidebarViewOp, SidebarViewRiskClass>`
 * means an operation added to `SIDEBAR_VIEW_OPS` without a line here fails `tsc`.
 *
 * Two entries are worth their reasoning:
 *  • `select_row` is the domain's ONLY `disruptive` op, for the reason in contract 3 — it is the
 *    one operation that moves the pane rather than the column.
 *  • `reveal_row` is `view`, NOT disruptive, even though it scrolls: it asks the column to bring a
 *    row into sight and leaves the selection, the pane and the composer's caret exactly where they
 *    were. Scrolling past someone's cursor is not the same as taking it away from them.
 */
export const SIDEBAR_VIEW_OP_RISK: Record<SidebarViewOp, SidebarViewRiskClass> = {
  read_sidebar_view: "read-only",
  list_build_rows: "read-only",
  toggle_status_band: "view",
  isolate_status_band: "view",
  set_status_bands: "view",
  show_all_status_bands: "view",
  expand_orchestrators: "view",
  collapse_orchestrators: "view",
  set_orchestrators_collapsed: "view",
  set_work_mode: "view",
  // "view", NOT "disruptive", on the same test every other entry here takes: it changes WHAT THE
  // HUMAN SEES and nothing else. A narrowed column hides rows; it never stops, starts, retargets or
  // touches an agent, and the state it writes is transient — a relaunch starts unnarrowed. It is
  // strictly less invasive than `select_row`, which moves the user's actual selection.
  focus_epic: "view",
  clear_epic_focus: "view",
  reveal_row: "view",
  select_row: "disruptive",
};

// ---------------------------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------------------------

/**
 * Why an operation refused. Machine-readable so a caller can branch; the accompanying `message`
 * is what the concierge says to the human.
 *
 * The reasons SEPARATE a caller bug from an idempotent request, because those want opposite
 * responses: a bad argument must not be retried, an already-satisfied one is safe to ignore. That
 * is why `unknown-mode` is not folded into `no-op` and `incomplete-bands` is not folded into
 * `unknown-band` — a reason that covers both cases answers neither question.
 */
export type SidebarViewRefusalReason =
  | "no-project" // nothing is scoped into the Build column, so there is no view to change
  | "unknown-agent" // no agent by that id exists at all
  | "no-row" // the agent EXISTS, but the column renders no row for it (e.g. an orphan worker)
  | "not-an-orchestrator" // the id names a row, but not one with a subtree to open
  | "unknown-band" // a band name outside needs_you | questions | running | done
  | "incomplete-bands" // every key was a real band, but the record did not name all of them
  | "unknown-mode" // a work mode outside plan | build
  | "unknown-bead" // no bead by that id in the scoped project's backlog
  | "not-an-epic" // the id names a real bead, but not one the build column can narrow to
  | "no-ids" // an empty id list — almost always a caller bug, never a silent no-op
  | "no-op"; // the request was VALID and would change nothing

export interface SidebarViewOk<T> {
  ok: true;
  op: SidebarViewOp;
  risk: SidebarViewRiskClass;
  value: T;
}

export interface SidebarViewRefusal {
  ok: false;
  op: SidebarViewOp;
  risk: SidebarViewRiskClass;
  reason: SidebarViewRefusalReason;
  /** A sentence fit to say to the user. Never an exception, never a bare error string. */
  message: string;
}

export type SidebarViewResult<T> = SidebarViewOk<T> | SidebarViewRefusal;

function ok<T>(op: SidebarViewOp, value: T): SidebarViewOk<T> {
  return { ok: true, op, risk: SIDEBAR_VIEW_OP_RISK[op], value };
}

function refuse(
  op: SidebarViewOp,
  reason: SidebarViewRefusalReason,
  message: string,
): SidebarViewRefusal {
  return { ok: false, op, risk: SIDEBAR_VIEW_OP_RISK[op], reason, message };
}

// ---------------------------------------------------------------------------------------------
// Reading the column
// ---------------------------------------------------------------------------------------------

/** The set of bands the column is showing. The same shape uiStore persists, so it round-trips
 *  through `setStatusBands` unchanged — that is what makes every filter op undoable. */
export type BandVisibility = Record<StatusBand, boolean>;

const BAND_IDS: readonly StatusBand[] = STATUS_BANDS.map((b) => b.id);

function isBand(value: string): value is StatusBand {
  return (BAND_IDS as readonly string[]).includes(value);
}

/** The project the Build column is scoped to right now — `projectStore.selectedProjectId`, which is
 *  what windowContext.useCurrentProjectId hands Workspace and Workspace hands AgentSidebar. Read
 *  live rather than taken from the caller (contract 5). */
function scopedProject(): Project | null {
  const { projects, selectedProjectId } = useProjectStore.getState();
  return projects.find((p) => p.id === selectedProjectId) ?? null;
}

/**
 * Which COLUMN these tools are talking about. The work mode is per-pair now, so "the Build column"
 * is only a well-defined phrase once you know which pair the scoped project sits in — reading a
 * window-global mode here used to report (and set) the wrong column's chevron whenever the scoped
 * project lived in the left pair. `sideOf` defaults to the primary side, which is also the right
 * answer when nothing is scoped.
 */
function scopedSide(): PairSide {
  return sideOf(useUiStore.getState().pairAssignment, scopedProject()?.id ?? "");
}

/**
 * Whose subtree is this? Keyed by `parentId` over EVERY child, whatever its kind.
 *
 * This is AgentSidebar's `childrenByParent` (AgentSidebar.tsx:1109), byte for byte — same key, same
 * insertion order, same absence of a kind filter. It used to keep only `kind === "worker"` children
 * here, on the reasoning that workers are the only children that render as rows. That reasoning is
 * true of engine/workerRollup (which tints a head's DOT and must not let a nested shell colour it)
 * but NOT of the column's row list: `AgentSidebar.tsx:1626` unfolds `childrenByParent.get(top.id)`
 * under any `kind === "build"` head without looking at the children's kinds, and `:1307`'s
 * `headStageOf` rolls up that same unfiltered bucket.
 *
 * So a build head with a nested shell under it had a chevron, a child row and a rolled-up stage on
 * screen while this façade reported no subtree at all — `listBuildRows` dropped the row,
 * `expandOrchestrators` refused `not-an-orchestrator`, and `selectRow` treated the child as its own
 * head and landed the human on an invisible row. Mirroring the renderer is the only way that stays
 * fixed; re-deriving the rule here is how it broke.
 */
function childrenByParent(agents: readonly AgentTab[]): Map<string, AgentTab[]> {
  const map = new Map<string, AgentTab[]>();
  for (const a of agents) {
    if (!a.parentId) continue;
    const arr = map.get(a.parentId);
    if (arr) arr.push(a);
    else map.set(a.parentId, [a]);
  }
  return map;
}

/** The children the column actually RENDERS beneath a top-level row — AgentSidebar.tsx:1626's own
 *  predicate. Only a `kind === "build"` head unfolds (a shell row carries no disclosure triangle),
 *  and when it does it unfolds all of its children. */
function renderedChildren(head: AgentTab, kids: Map<string, AgentTab[]>): AgentTab[] {
  return head.kind === "build" ? kids.get(head.id) ?? [] : [];
}

/**
 * The column's own derivation, assembled ONCE here and shared by both read operations.
 *
 * Every input is the SANCTIONED shared export, not a local re-derivation — `rollupViewFor` for the
 * rolled-up dot (which is why `bandOfRollup(dotOf(id))` is spelled out rather than reaching for the
 * deleted `rollupBandAccessor`), `publishedStatusFor` for the status, `topLevelAgents` for which
 * agents claim a row, `rollupStages` for a head's stage, and `groupAgentsByStage` for the ladder.
 * The codebase has shipped the "column bands one way, everyone else bands another" drift three
 * times (roborev 53371 / 53858 / 53411); this module is a fourth surface asking the same question,
 * so it asks it through the same functions.
 *
 * The one deliberate difference from AgentSidebar's `effectiveStatus`: the status REPORTED per row
 * is `publishedStatusFor`, which additionally applies `withWorkerRollupGreen`. That promotion is
 * exactly what keeps the reported status consistent with the reported band here — a head whose
 * workers are running rolls up to a green dot (band `running`), and the published map calls it
 * `working` to match. The BAND, which is what filtering actually keys on, comes from the same
 * rollup the column uses, so grouping is identical either way.
 */
interface ColumnView {
  project: Project;
  mode: WorkMode;
  bands: BandVisibility;
  status: Record<string, AgentTabStatus>;
  bandOf: (id: string) => StatusBand;
  stageOf: (id: string) => WorkflowStageId;
  headStageOf: (id: string) => WorkflowStageId;
  /** Every child bucketed by `parentId`, kind-agnostic — see `childrenByParent`. */
  kids: Map<string, AgentTab[]>;
  /** The rows the column unfolds beneath a top-level row — see `renderedChildren`. */
  childRows: (head: AgentTab) => AgentTab[];
  /** The top-level row an id renders under: itself when it is one, its head when it is a child of
   *  one, and `null` when the column renders NO row for it (an orphan worker, a child of a
   *  non-build row). That last case is a refusal, not a row to land on. */
  headOf: (id: string) => AgentTab | null;
  topLevel: AgentTab[];
  /** Heads that survived the band filter, in ladder order, with their section. */
  sections: { id: BuildSectionId; rows: AgentTab[] }[];
  isCollapsed: (id: string) => boolean;
}

function columnView(project: Project): ColumnView {
  const ui = useUiStore.getState();
  const rt = useRuntimeStore.getState();
  const agents = project.agents;
  const openIds = new Set(rt.openAgentIds);
  const stageOf = (id: string): WorkflowStageId =>
    resolveStage(rt.branchStatus[id], rt.workflowStage[id]);

  const { dotOf } = rollupViewFor(agents, rt.status, openIds, rt.lastObserved, stageOf);
  const bandOf = (id: string): StatusBand => bandOfRollup(dotOf(id));
  const status = publishedStatusFor(agents, rt.status, openIds, rt.lastObserved, stageOf);

  const kids = childrenByParent(agents);
  // A delegating head reports its CHILDREN's least-advanced stage, not its own git state — the same
  // rule AgentSidebar's headStageOf applies (:1307, over the same unfiltered bucket), and for the
  // same reason: a head with no commits of its own would otherwise sit under "Local: Uncommitted"
  // while its tracker showed its workers in PR.
  const headStageOf = (id: string): WorkflowStageId => {
    const rollup = rollupStages((kids.get(id) ?? []).map((w) => stageOf(w.id)));
    return rollup ? rollup.stage : stageOf(id);
  };

  // Rolled up over the SAME unfiltered bucket as `headStageOf`, and passed to `groupAgentsByStage`
  // below for the same reason that function does: this view exists to tell the concierge what the
  // column is showing, so a row it files under a different rung than the column does is a lie about
  // the screen. `rollupHoldsWork` owns the precedence so this cannot fold it differently from
  // AgentSidebar's copy.
  const headHoldsWorkOf = (id: string): boolean | undefined =>
    rollupHoldsWork([
      uncommittedWorkEvidence(rt.branchStatus[id]),
      ...(kids.get(id) ?? []).map((w) => uncommittedWorkEvidence(rt.branchStatus[w.id])),
    ]);

  const mode = ui.workModeBySide[scopedSide()];
  const bands = ui.statusFilter;
  const topLevel = topLevelAgents(agents, mode);
  const childRows = (head: AgentTab): AgentTab[] => renderedChildren(head, kids);
  // Which top-level row each id renders under. Built from `childRows`, so "has a row" here means
  // exactly "the column draws one" — an agent absent from this map is one no reveal can reach.
  const headById = new Map<string, AgentTab>();
  for (const head of topLevel) {
    headById.set(head.id, head);
    for (const child of childRows(head)) headById.set(child.id, head);
  }
  // The SAME shared builder AgentSidebar uses, for the same reason `headHoldsWorkOf` is folded by a
  // shared helper: this view exists to tell the concierge what the COLUMN is showing, so a rung it
  // computes differently is a lie about the screen. `tracked_elsewhere` is ladder slot 0, so a
  // disagreement here also reorders the rows it reports (roborev 67500).
  const { head: headCrossRepoOf } = crossRepoAccessors(agents, slugForRoot(project.rootPath));
  const sections = groupAgentsByStage(
    topLevel,
    headStageOf,
    (id) => status[id] ?? "stopped",
    bands,
    bandOf,
    headHoldsWorkOf,
    headCrossRepoOf,
  ).map((g) => ({ id: g.id, rows: g.rows }));

  return {
    project,
    mode,
    bands,
    status,
    bandOf,
    stageOf,
    headStageOf,
    kids,
    childRows,
    headOf: (id: string) => headById.get(id) ?? null,
    topLevel,
    sections,
    isCollapsed: ui.isOrchestratorCollapsed,
  };
}

/** Why a row the column KNOWS about isn't on screen. `null` means it is rendered right now. */
export type RowHiddenReason =
  | "band-filtered" // its status band's chip is off
  | "subtree-collapsed" // it is a worker under a folded head
  | "plan-mode"; // the Plan chevron is active, so the column renders no rows at all

export interface BuildRow {
  id: string;
  name: string;
  kind: AgentKind;
  /** The head this row hangs under, or `null` for a top-level row. */
  parentId: string | null;
  /** Which chip finds this row — the rolled-up band, exactly as the column filters on it. */
  band: StatusBand;
  status: AgentTabStatus;
  stage: WorkflowStageId;
  /** The ladder section this row renders in; workers inherit their head's. `null` when the band
   *  filter removed the head, so no section claims it. */
  section: BuildSectionId | null;
  visible: boolean;
  hiddenReason: RowHiddenReason | null;
  /** For a head with a subtree: is it folded? `null` for rows with no subtree. */
  collapsed: boolean | null;
  /** How many rows this head unfolds — the same number the column puts on the row (AgentSidebar's
   *  `workerCount` prop), which counts every child of a build head, not only its workers. */
  workerCount: number;
  selected: boolean;
}

export interface SidebarViewState {
  /** The project the column is scoped to — `null` when nothing is selected and it shows nothing. */
  projectId: string | null;
  projectName: string | null;
  workMode: WorkMode;
  /** Which special view owns the main pane, if any — a selected row is not visible behind one.
   *  "board" USED to be reported here; it is not a window-global any more, because each column has
   *  its own Plan board. Read `workMode === "plan"` above for that — it is this column's answer,
   *  where the old field could only give the window's. */
  activeSpecial: "sparkle" | "research" | null;
  bands: BandVisibility;
  /** Per-band totals over the UNFILTERED top-level rows, so a band that is switched off still
   *  reports how many rows turning it back on would reveal — the same count the chips show. */
  bandCounts: Record<StatusBand, number>;
  /** True when the column is empty ONLY because of the filter — i.e. there is something to reveal.
   *  This is the state the concierge should offer to undo rather than describe as "no agents". */
  hiddenByFilter: boolean;
  selectedAgentId: string | null;
  /** Heads whose subtree is open right now.
   *
   *  There is no longer an "and these ones the app opened" companion to this. Expansion is user
   *  state with a single writer (uiStore.setOrchestratorsCollapsed), so an open head means a human
   *  opened it — there is no second class of expansion that might fold itself away, and nothing for
   *  a concierge to reason about beyond this list. */
  expandedOrchestrators: string[];
  totalRows: number;
  visibleRows: number;
}

/** What the Build column looks like right now: scope, chevron, filter, counts, selection, subtrees.
 *  The read a concierge does BEFORE it changes anything, and again to describe what it did. */
export function readSidebarView(): SidebarViewResult<SidebarViewState> {
  const ui = useUiStore.getState();
  const project = scopedProject();
  const base = {
    workMode: ui.workModeBySide[scopedSide()],
    activeSpecial: ui.activeSpecial,
    bands: { ...ui.statusFilter },
    expandedOrchestrators: Object.entries(ui.collapsedOrchestrators)
      .filter(([, collapsed]) => collapsed === false)
      .map(([id]) => id),
  };
  if (!project) {
    // NOT a refusal: "no project is scoped" is a true and useful answer to "what does the column
    // look like", and a concierge asking that question deserves the chevron and filter state it
    // will be restoring later regardless.
    return ok("read_sidebar_view", {
      ...base,
      projectId: null,
      projectName: null,
      bandCounts: { needs_you: 0, questions: 0, running: 0, done: 0 },
      hiddenByFilter: false,
      selectedAgentId: null,
      totalRows: 0,
      visibleRows: 0,
    });
  }

  const view = columnView(project);
  const bandCounts: Record<StatusBand, number> = {
    needs_you: 0,
    questions: 0,
    running: 0,
    done: 0,
  };
  for (const a of view.topLevel) bandCounts[view.bandOf(a.id)] += 1;
  const rows = buildRows(view);
  return ok("read_sidebar_view", {
    ...base,
    projectId: project.id,
    projectName: project.name,
    bandCounts,
    hiddenByFilter:
      view.sections.length === 0 && Object.values(bandCounts).some((n) => n > 0),
    selectedAgentId: project.selectedAgentId,
    totalRows: rows.length,
    visibleRows: rows.filter((r) => r.visible).length,
  });
}

/** Every row the column knows about, in rendered order (ladder order, workers under their head),
 *  each carrying whether it is on screen and — when it is not — WHY. That last field is the point:
 *  "3 agents need you" is only actionable if the concierge can also say which of them the human's
 *  current filter is hiding, and then turn that band back on. */
function buildRows(view: ColumnView): BuildRow[] {
  const selected = view.project.selectedAgentId;
  const inSection = new Map<string, BuildSectionId>();
  for (const s of view.sections) for (const r of s.rows) inSection.set(r.id, s.id);
  const planMode = view.mode === "plan";

  const rows: BuildRow[] = [];
  const pushRow = (
    a: AgentTab,
    section: BuildSectionId | null,
    collapsed: boolean | null,
    visible: boolean,
    hiddenReason: RowHiddenReason | null,
    stage: WorkflowStageId,
  ): void => {
    rows.push({
      id: a.id,
      name: a.name,
      kind: a.kind,
      parentId: a.parentId,
      band: view.bandOf(a.id),
      status: view.status[a.id] ?? "stopped",
      stage,
      section,
      visible,
      hiddenReason,
      collapsed,
      workerCount: view.childRows(a).length,
      selected: selected === a.id,
    });
  };

  // Ladder order first: heads that survived the filter, each followed by the rows it unfolds.
  for (const s of view.sections) {
    for (const head of s.rows) {
      const kids = view.childRows(head);
      const collapsed = kids.length > 0 ? view.isCollapsed(head.id) : null;
      pushRow(head, s.id, collapsed, !planMode, planMode ? "plan-mode" : null, view.headStageOf(head.id));
      for (const w of kids) {
        const hidden = planMode ? "plan-mode" : collapsed ? "subtree-collapsed" : null;
        pushRow(w, s.id, null, !hidden, hidden, view.stageOf(w.id));
      }
    }
  }
  // Then the heads the band filter removed, in the column's own top-level order, with their
  // subtrees — a filtered-out head takes its subtree with it, so the children report the head's
  // reason rather than inventing one of their own.
  for (const head of view.topLevel) {
    if (inSection.has(head.id)) continue;
    const kids = view.childRows(head);
    const collapsed = kids.length > 0 ? view.isCollapsed(head.id) : null;
    const reason: RowHiddenReason = planMode ? "plan-mode" : "band-filtered";
    pushRow(head, null, collapsed, false, reason, view.headStageOf(head.id));
    for (const w of kids) pushRow(w, null, null, false, reason, view.stageOf(w.id));
  }
  return rows;
}

/** The column's rows, top to bottom, with visibility and the reason for any that are hidden. */
export function listBuildRows(): SidebarViewResult<BuildRow[]> {
  const project = scopedProject();
  if (!project) {
    return refuse(
      "list_build_rows",
      "no-project",
      "No project is open in the Build column, so there are no rows to list.",
    );
  }
  return ok("list_build_rows", buildRows(columnView(project)));
}

// ---------------------------------------------------------------------------------------------
// Status-band filtering — every one of these is undoable from its own result
// ---------------------------------------------------------------------------------------------

/** What a filter change replaced and what it produced. `priorBands` is a complete, re-appliable
 *  snapshot: `setStatusBands(result.value.priorBands)` restores the column exactly (contract 4). */
export interface BandChange {
  priorBands: BandVisibility;
  bands: BandVisibility;
  /** Which bands actually flipped — empty when the call was idempotent. */
  changed: StatusBand[];
}

function bandsNow(): BandVisibility {
  return { ...useUiStore.getState().statusFilter };
}

function changedBands(before: BandVisibility, after: BandVisibility): StatusBand[] {
  return BAND_IDS.filter((b) => before[b] !== after[b]);
}

function bandChange(op: SidebarViewOp, before: BandVisibility): SidebarViewOk<BandChange> {
  const after = bandsNow();
  return ok(op, { priorBands: before, bands: after, changed: changedBands(before, after) });
}

/** Flip one chip — uiStore.toggleStatusBand, the chip's own action. Turning the last visible band
 *  off is ALLOWED and leaves an empty column with its explanatory hint, exactly as the chips do;
 *  the store is explicit that a filter which refuses to reach its stated state is worse. The result
 *  says what it replaced, so the concierge can put it back. */
export function toggleStatusBand(band: string): SidebarViewResult<BandChange> {
  if (!isBand(band)) return unknownBand("toggle_status_band", band);
  const before = bandsNow();
  useUiStore.getState().toggleStatusBand(band);
  return bandChange("toggle_status_band", before);
}

/** Show ONLY this band — uiStore.isolateStatusBand, the same action the helper island's chiclets
 *  use, writing the same `statusFilter` the chips render. This is the "take me to the 3 that need
 *  you" move: the resulting state is visible as chips and clearable with `showAllStatusBands`. */
export function isolateStatusBand(band: string): SidebarViewResult<BandChange> {
  if (!isBand(band)) return unknownBand("isolate_status_band", band);
  const before = bandsNow();
  useUiStore.getState().isolateStatusBand(band);
  return bandChange("isolate_status_band", before);
}

/**
 * Set the whole filter at once — including putting back a `priorBands` snapshot from any earlier
 * call in this domain. Built out of the store's OWN actions rather than a `setState` on
 * `statusFilter`: `showAllStatusBands` for the all-on case, then `toggleStatusBand` per band that
 * still disagrees. That keeps this module a façade (no second writer of the filter shape) and means
 * a future change to what toggling a band entails lands here for free.
 *
 * A record missing a band is REFUSED rather than defaulted, and so is an unknown key, so a caller
 * cannot hide a band by omission. That is not pedantry: the v2 persisted-blob migration in
 * stores/composerPersist exists precisely because a partial `statusFilter` hides rows with no
 * visible cause, and a tool call is the easiest way to write one.
 */
export function setStatusBands(bands: Partial<Record<string, boolean>>): SidebarViewResult<BandChange> {
  const unknown = Object.keys(bands).find((k) => !isBand(k));
  if (unknown !== undefined) return unknownBand("set_status_bands", unknown);
  const missing = BAND_IDS.filter((b) => typeof bands[b] !== "boolean");
  if (missing.length) {
    // `incomplete-bands`, NOT `unknown-band`: every key the caller supplied WAS a band. The two are
    // different caller bugs with different fixes — "you named a band I don't have" versus "you
    // named real bands but left some out" — and a `reason` that says the first when it means the
    // second sends a branching caller to correct a spelling that was never wrong.
    return refuse(
      "set_status_bands",
      "incomplete-bands",
      // COUNT COMES FROM BAND_IDS, never a literal. This said "all three bands" and went stale the
      // day `questions` was added — the caller was then told to supply three keys by a validator
      // that would refuse anything but four.
      `A band filter must name all ${BAND_IDS.length} bands; ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing.`,
    );
  }
  const target = Object.fromEntries(BAND_IDS.map((b) => [b, bands[b] === true])) as BandVisibility;
  const before = bandsNow();
  const ui = useUiStore.getState();
  ui.showAllStatusBands();
  for (const b of BAND_IDS) if (!target[b]) ui.toggleStatusBand(b);
  return bandChange("set_status_bands", before);
}

/** Clear the filter — uiStore.showAllStatusBands, the "Show all" the empty state offers. The way
 *  back from any isolate, and idempotent (`changed` comes back empty when nothing was hidden). */
export function showAllStatusBands(): SidebarViewResult<BandChange> {
  const before = bandsNow();
  useUiStore.getState().showAllStatusBands();
  return bandChange("show_all_status_bands", before);
}

function unknownBand(op: SidebarViewOp, band: string): SidebarViewRefusal {
  return refuse(
    op,
    "unknown-band",
    `"${band}" is not a status band. The Build column has ${BAND_IDS.join(", ")}.`,
  );
}

// ---------------------------------------------------------------------------------------------
// Orchestrator subtrees
// ---------------------------------------------------------------------------------------------

/** What a subtree change replaced. `priorCollapsed` is a per-id snapshot that
 *  `setOrchestratorsCollapsed` takes back verbatim (contract 4). */
export interface CollapseChange {
  priorCollapsed: Record<string, boolean>;
  collapsed: Record<string, boolean>;
  changed: string[];
}

/** Ids that name a head with a subtree, or a refusal naming the first one that doesn't. Heads are
 *  `kind === "build"` (engine/workerExpansion's own marker); a row with no CHILDREN — of any kind,
 *  matching the disclosure triangle's own condition at AgentSidebar.tsx:1626 — has no triangle in
 *  the column, so "expand" it would be a write with no visible effect. */
function resolveHeads(
  op: SidebarViewOp,
  project: Project,
  ids: readonly string[],
): { heads: AgentTab[] } | SidebarViewRefusal {
  const heads: AgentTab[] = [];
  const kids = childrenByParent(project.agents);
  for (const id of ids) {
    const agent = project.agents.find((a) => a.id === id);
    if (!agent) {
      return refuse(op, "unknown-agent", `"${project.name}" has no agent ${id}.`);
    }
    if (agent.kind !== "build") {
      return refuse(
        op,
        "not-an-orchestrator",
        `${agent.name} (${id}) is a ${agent.kind} row — only build agents have a subtree.`,
      );
    }
    if (renderedChildren(agent, kids).length === 0) {
      return refuse(
        op,
        "not-an-orchestrator",
        `${agent.name} (${id}) has nothing nested under it, so it has no subtree to open or close.`,
      );
    }
    heads.push(agent);
  }
  return { heads };
}

function collapseSnapshot(ids: readonly string[]): Record<string, boolean> {
  const isCollapsed = useUiStore.getState().isOrchestratorCollapsed;
  return Object.fromEntries(ids.map((id) => [id, isCollapsed(id)]));
}

function collapseChange(
  op: SidebarViewOp,
  ids: readonly string[],
  before: Record<string, boolean>,
): SidebarViewOk<CollapseChange> {
  const after = collapseSnapshot(ids);
  return ok(op, {
    priorCollapsed: before,
    collapsed: after,
    changed: ids.filter((id) => before[id] !== after[id]),
  });
}

/**
 * Open these subtrees — uiStore.expandOrchestrators, called WITHOUT `{ auto: true }`.
 *
 * That flag is the whole decision here. `auto` marks a subtree as "the app opened this", which lets
 * engine/workerExpansion's auto-collapse fold it away again on a later status tick. A concierge
 * expansion is a reveal the human ASKED for — "show me those workers" — so folding it back up while
 * they read it is the 53737 bug returning. uiStore's own doc-comment says the concierge reveal
 * paths must not pass `auto`; this is that caller.
 */
export function expandOrchestrators(ids: readonly string[]): SidebarViewResult<CollapseChange> {
  return writeSubtrees("expand_orchestrators", ids, (heads) => {
    useUiStore.getState().expandOrchestrators(heads.map((h) => h.id));
  });
}

/**
 * Fold these subtrees back up — uiStore.setOrchestratorsCollapsed, the store's single writer.
 *
 * Idempotent by construction now: the setter takes the state it should ARRIVE at rather than
 * flipping, so a retried "close these" is a no-op instead of re-opening what it just closed. This
 * used to have to guard each id against the live collapse state by hand, because a toggle was the
 * only unconditional write the store offered.
 */
export function collapseOrchestrators(ids: readonly string[]): SidebarViewResult<CollapseChange> {
  return writeSubtrees("collapse_orchestrators", ids, (heads) => {
    useUiStore.getState().setOrchestratorsCollapsed(heads.map((h) => h.id), true);
  });
}

/** Put a `priorCollapsed` snapshot back — the undo for either of the two above, and the reason both
 *  of them return one. Expands and collapses in one call, through the same single writer. */
export function setOrchestratorsCollapsed(
  collapsed: Record<string, boolean>,
): SidebarViewResult<CollapseChange> {
  const ids = Object.keys(collapsed);
  return writeSubtrees("set_orchestrators_collapsed", ids, (heads) => {
    const ui = useUiStore.getState();
    const wanted = (want: boolean) => heads.filter((h) => !!collapsed[h.id] === want).map((h) => h.id);
    const toExpand = wanted(false);
    const toCollapse = wanted(true);
    if (toExpand.length) ui.setOrchestratorsCollapsed(toExpand, false);
    if (toCollapse.length) ui.setOrchestratorsCollapsed(toCollapse, true);
  });
}

/** The shared validate → snapshot → write → report path for the four subtree operations. */
function writeSubtrees(
  op: SidebarViewOp,
  ids: readonly string[],
  write: (heads: AgentTab[]) => void,
): SidebarViewResult<CollapseChange> {
  const project = scopedProject();
  if (!project) {
    return refuse(op, "no-project", "No project is open in the Build column, so it has no subtrees.");
  }
  if (ids.length === 0) {
    // A caller that passes nothing has almost certainly lost its id list; answering "done, changed
    // nothing" would let that bug through as a success.
    return refuse(op, "no-ids", "Name at least one build agent whose subtree to change.");
  }
  const resolved = resolveHeads(op, project, ids);
  if ("ok" in resolved) return resolved;
  const before = collapseSnapshot(ids);
  write(resolved.heads);
  return collapseChange(op, ids, before);
}

// ---------------------------------------------------------------------------------------------
// Chevron, reveal, selection
// ---------------------------------------------------------------------------------------------

export interface WorkModeChange {
  priorWorkMode: WorkMode;
  workMode: WorkMode;
}

/**
 * Switch the Plan/Build chevron — uiStore.setWorkMode.
 *
 * Plan mode renders NO rows in this column (it puts a board in the main pane), so switching to it
 * hides every row the other operations here talk about; `listBuildRows` reports that honestly as
 * `hiddenReason: "plan-mode"` rather than pretending the filter did it. Reversible, and the result
 * carries the mode it replaced.
 *
 * Switching to PLAN goes through `uiStore.openPlanBoard`, which also makes the Improve-Sparkle pane
 * yield. This docstring used to claim the opposite — that touching `activeSpecial` was deliberately
 * left to `engine/workMode.reconcileWorkMode` in the sidebar's effect — and that was wrong in the
 * one case it mattered: `reconcileWorkMode` returns null on its FIRST line whenever a special view
 * is up, so the named reconciler is precisely the thing that cannot run here. The op reported
 * success while the stage was unchanged and the caller had no signal the view never appeared.
 */
export function setWorkMode(mode: string): SidebarViewResult<WorkModeChange> {
  // VALIDATED AGAINST THE UNION'S OWN LIST, never against a hand-written pair (roborev 60625). This
  // read `mode !== "plan" && mode !== "build"` with a refusal message naming those two — so for one
  // commit after `"preview"` joined the union, the concierge told the user that a mode the app
  // actually has "is not a work mode". An enumeration copied beside a type is the trap the type
  // exists to close; `WORK_MODES` is what both are built from, so this cannot go stale again.
  if (!isWorkMode(mode)) {
    // `unknown-mode`, NOT `no-op`. Both refuse and both change nothing, but a caller has to tell
    // them apart: "kanban is not a mode" is a caller bug that retrying cannot fix, while "already
    // in build mode" below is an idempotent request that is safe to shrug off. One reason covering
    // both makes the first indistinguishable from success-by-another-name.
    return refuse(
      "set_work_mode",
      "unknown-mode",
      // The message is BUILT FROM THE LIST too. A hard-coded sentence is the half of this defect a
      // widened guard alone would leave standing: the mode would be accepted and the help text
      // would still name two of three.
      `"${mode}" is not a work mode — the modes are ${WORK_MODES.map((m) => `"${m}"`).join(", ")}.`,
    );
  }
  const side = scopedSide();
  const priorWorkMode = useUiStore.getState().workModeBySide[side];
  // "ALREADY IN THAT MODE" IS ONLY A NO-OP IF THE MODE'S SURFACE IS ACTUALLY ON SCREEN.
  //
  // A column can sit in Plan while showing the Improve-Sparkle pane — indeed that is the ordinary
  // way to get there (open the board, then click Improve Sparkle; `onSelectSparkle` never touches
  // the mode). Refusing here would report "nothing to do" about a view the caller cannot see, and
  // would leave the pane up — while the CHEVRON, which calls `openPlanBoard` unconditionally,
  // recovers the board on a second press. Same request, two answers: exactly the drift
  // `openPlanBoard` exists to prevent, relocated into this guard.
  // NOT gated on `mode === "plan"`. The pane covers whichever surface the column is showing, so
  // the Build half has the identical hole — and it is the more common one, since "build" is the
  // default and selecting Improve Sparkle never touches the mode. Gating this on Plan was fixing
  // one branch of a symmetric problem.
  const surfaceHidden =
    side === SPARKLE_PANE_SIDE && useUiStore.getState().activeSpecial !== null;
  if (priorWorkMode === mode && !surfaceHidden) {
    return refuse("set_work_mode", "no-op", `The column is already in ${mode} mode.`);
  }
  // EVERY branch goes through the store action that owns the mode-plus-yield pairing, so none can
  // drift from the chevron the way this call site twice did. The union is back to two members — a
  // preview is a concierge card now, not a mode — so there are exactly two branches, and the
  // message a bad `mode` gets is built from `WORK_MODES` rather than re-listed here, which is what
  // stopped that message going stale the last time the union changed.
  if (mode === "plan") useUiStore.getState().openPlanBoard(side);
  else useUiStore.getState().showBuildStage(side);
  return ok("set_work_mode", { priorWorkMode, workMode: mode });
}

// ---------------------------------------------------------------------------------------------
// Narrowing the column to one epic
// ---------------------------------------------------------------------------------------------

/** What `focus_epic` changed, in the same prior/next shape `set_work_mode` reports. */
export interface EpicFocusChange {
  /** The epic that was focused before, or null when the column was showing everything. */
  priorEpicId: string | null;
  epicId: string;
  /** Whether the call also had to put the column into Build — see the note in the body. */
  switchedToBuild: boolean;
}

/**
 * NARROW THE BUILD COLUMN TO ONE EPIC — the concierge's half of the gesture the epics column and
 * the bead card's "Open in column" link already offer.
 *
 * It exists so the concierge can answer "show me what's building on the auth epic" by MOVING THE
 * VIEW rather than by describing it in prose. Everything it needs was already here: the tool
 * surface could flip a column's mode (`set_work_mode`) but had no way to narrow one.
 *
 * ══ TWO WRITES, AND THE SECOND IS NOT OPTIONAL ═════════════════════════════════════════════════
 * The narrowing is INVISIBLE while that side is showing the Plan board: `AgentSidebar` gates the
 * focus banner — the only thing on screen that says a filter is in force, and the only place its
 * "Show all" clear lives — on `mode !== "plan"`. So this calls `showBuildStage(side)` when it has
 * to, exactly as `BeadPill.viewInColumn` does, and REPORTS having done it (`switchedToBuild`) so
 * the concierge can say so rather than silently relocating the user.
 *
 * ══ `openEpicFocus`, NEVER `setEpicFocus` ══════════════════════════════════════════════════════
 * The latter TOGGLES, so asking twice for the same epic would clear the narrowing — a tool whose
 * second identical call undoes the first is a tool no caller can use safely. The no-op refusal
 * below is the honest way to say "already there".
 *
 * ══ IT VALIDATES THE BEAD AGAINST THE SHARED RESOLVER ══════════════════════════════════════════
 * `isEpicIndexed`, never a raw comparison of the bead's `type` field — a second definition of epic
 * membership fails CI (`scripts/lib/epic-membership-guard.sh`), and that type test is `isTypedEpic`,
 * a DIFFERENT question that misses every structural epic nobody declared. Two refusals, not one, because they want opposite
 * responses: `unknown-bead` is a caller bug no retry fixes, while `not-an-epic` names a real bead
 * the caller may simply have mistaken for a plan.
 */
export function focusEpic(epicId: string): SidebarViewResult<EpicFocusChange> {
  const project = scopedProject();
  if (project === null) {
    return refuse("focus_epic", "no-project", "No project is scoped into the Build column.");
  }
  const beads = useBeadsStore.getState().byProject[project.id]?.beads ?? [];
  const bead = beads.find((b) => b.id === epicId);
  if (bead === undefined) {
    return refuse(
      "focus_epic",
      "unknown-bead",
      `There is no bead "${epicId}" in ${project.name}'s backlog.`,
    );
  }
  if (!isEpicIndexed(epicIndexOf(beads), bead)) {
    return refuse(
      "focus_epic",
      "not-an-epic",
      `"${epicId}" is a bead but not an epic, so the Build column has nothing to narrow to.`,
    );
  }
  const side = scopedSide();
  const ui = useUiStore.getState();
  const priorEpicId = ui.epicFocusBySide[side];
  // ALREADY NARROWED TO THIS EPIC **AND** ALREADY SHOWING IT **AND** NOT STILL DRILLED INTO A
  // CHILD. Three conditions, and each one is a state in which "already narrowed to that epic" is
  // true while the caller's request is NOT satisfied:
  //
  //   * the MODE — a column focused on this epic while sitting in Plan is not showing it, and
  //     refusing there leaves the narrowing invisible (the hole `set_work_mode`'s `surfaceHidden`
  //     guard closes one surface over);
  //   * the CHILD — `beadFocusBySide` is the narrower rung and WINS while it holds, so a column
  //     drilled into one task of this epic is showing that TASK's agents, not the epic's. Calling
  //     that a no-op would refuse the one request that widens it back.
  const showing = ui.workModeBySide[side] === "build";
  const drilledIntoChild = ui.beadFocusBySide[side] !== null;
  if (priorEpicId === epicId && showing && !drilledIntoChild) {
    return refuse("focus_epic", "no-op", `The Build column is already narrowed to ${epicId}.`);
  }
  const switchedToBuild = !showing;
  if (switchedToBuild) ui.showBuildStage(side);
  ui.openEpicFocus(side, epicId);
  return ok("focus_epic", { priorEpicId, epicId, switchedToBuild });
}

/**
 * SHOW EVERY AGAIN — the mirror, and the tool form of the column's own "Show all" link.
 *
 * `setEpicFocus(side, null)` rather than `openEpicFocus`: clearing is precisely the case the
 * toggling setter handles correctly and the idempotent one deliberately cannot express (it takes a
 * non-null id, because "open nothing" is not a gesture). This does NOT touch the work mode — a
 * caller asking to widen the filter has not asked to be moved to another surface.
 */
export function clearEpicFocus(): SidebarViewResult<{ priorEpicId: string }> {
  const side = scopedSide();
  const priorEpicId = useUiStore.getState().epicFocusBySide[side];
  if (priorEpicId === null) {
    return refuse(
      "clear_epic_focus",
      "no-op",
      "The Build column is not narrowed to an epic.",
    );
  }
  useUiStore.getState().setEpicFocus(side, null);
  return ok("clear_epic_focus", { priorEpicId });
}

export interface RevealOutcome {
  agentId: string;
  /** Would the column actually render this row right now? A reveal of a row hidden by the filter or
   *  by a folded subtree scrolls to nothing, so the caller is told rather than left to assume. */
  visible: boolean;
  hiddenReason: RowHiddenReason | null;
  /** The request EXPIRES — uiStore.REVEAL_REQUEST_TTL_MS — if no matching row mounts to consume it. */
  expiresInMs: number;
}

/**
 * Ask the column to scroll a row into sight — uiStore.requestRevealAgent — WITHOUT selecting it.
 *
 * This is the light-touch half of "put the human there": the composer keeps the caret, the pane
 * keeps its terminal, and the human simply gets to see the row being talked about. That is why it
 * is classed `view` and `selectRow` is not.
 *
 * The request is one-shot and expires (roborev 53784): the row is not guaranteed to MOUNT — the
 * band filter may hide it, its head may be folded, Plan mode renders nothing — so an unbounded
 * request would fire at an arbitrary later moment. Rather than paper over that, this reports
 * `visible` / `hiddenReason` from the live column so a caller that wanted the human to actually see
 * something can unhide it first (`setStatusBands`, `expandOrchestrators`) and ask again.
 */
export function revealRow(agentId: string): SidebarViewResult<RevealOutcome> {
  const project = scopedProject();
  if (!project) {
    return refuse("reveal_row", "no-project", "No project is open in the Build column.");
  }
  const row = buildRows(columnView(project)).find((r) => r.id === agentId);
  if (!row) {
    // "no agent by that name" and "an agent the column draws no row for" are different problems and
    // the caller's next move differs: correct the id, versus stop asking to scroll to something
    // that has no place to scroll to. Orphan workers and children of a non-build row are the second
    // kind — real agents with real panes that simply never claim a row.
    const agent = project.agents.find((a) => a.id === agentId);
    if (!agent) {
      return refuse("reveal_row", "unknown-agent", `"${project.name}" has no agent ${agentId}.`);
    }
    return refuse(
      "reveal_row",
      "no-row",
      `${agent.name} (${agentId}) has no row in the Build column, so there is nothing to scroll to.`,
    );
  }
  useUiStore.getState().requestRevealAgent(agentId);
  return ok("reveal_row", {
    agentId,
    visible: row.visible,
    hiddenReason: row.hiddenReason,
    // uiStore's own constant, never a literal: the deadline belongs to the store that arms it.
    expiresInMs: REVEAL_REQUEST_TTL_MS,
  });
}

export interface SelectRowOptions {
  /**
   * Also make the row actually VISIBLE before landing on it: turn its status band back on if the
   * filter hid it, and open its head's subtree if it is nested under a folded one. Default TRUE,
   * because selecting a row the human cannot see is the failure this whole domain exists to fix —
   * the column jumps, the pane changes, and nothing on screen explains why.
   *
   * Both unhides are reported and reversible (`priorBands`, `priorCollapsed`).
   *
   * When the agent has NO row at all — an orphan worker, a child of a row that does not unfold —
   * there is nothing to unhide and the call refuses with `no-row` rather than landing somewhere
   * invisible. Pass `false` to say "I know, open it anyway": that skips the unhiding entirely, so
   * the row may well stay hidden, which is the caller's stated intent rather than a surprise.
   */
  ensureVisible?: boolean;
}

export interface SelectRowOutcome {
  agentId: string;
  projectId: string;
  /** What was selected before, so the caller can put the human back where they were. `null` when
   *  nothing was selected in that project. */
  priorSelection: { projectId: string; agentId: string | null } | null;
  priorWorkMode: WorkMode;
  priorActiveSpecial: "sparkle" | "research" | null;
  /** Present only when `ensureVisible` had to change the filter. Re-appliable. */
  priorBands: BandVisibility | null;
  /** Present only when `ensureVisible` had to open a subtree. Re-appliable. */
  priorCollapsed: Record<string, boolean> | null;
  /** Did the selection cross into another project (opening its tab on the way)? */
  switchedProject: boolean;
}

/**
 * DISRUPTIVE — land the human ON a row: select it, mount its pane, and put the column in a state
 * where the row is actually on screen.
 *
 * The landing itself is services/openProjectTab — the same call the ⌘K palette, a history hit and
 * the tray row make. With an `agentId` it opens the owning project's TAB, selects that project
 * (which is what scopes this column at all), and hands off to services/agentReveal.selectAndOpen:
 * drop any Sparkle/board overlay, switch the chevron to Build, mount the PTY pane, select the
 * agent. Six store writes in a documented order; re-implementing five of them is how "it's red
 * somewhere but I can't find it" gets reported again. It is also why this op works ACROSS projects
 * — selectAndOpen alone would select an agent in a project the column isn't showing.
 *
 * WHY THIS IS THE DOMAIN'S ONLY `disruptive` OP: it swaps the terminal pane. A human mid-sentence
 * in the composer is typing into a box that now belongs to a different agent. Every other operation
 * here can be shrugged off; this one costs the human their place, so a caller should mean it.
 *
 * Everything it changes is reported for restoration — the prior selection, chevron, overlay, and
 * any filter/subtree state `ensureVisible` had to touch.
 */
export function selectRow(
  agentId: string,
  opts: SelectRowOptions = {},
): SidebarViewResult<SelectRowOutcome> {
  const { projects } = useProjectStore.getState();
  const project = projects.find((p) => p.agents.some((a) => a.id === agentId));
  if (!project) {
    return refuse("select_row", "unknown-agent", `No agent ${agentId} in any open project.`);
  }
  const agent = project.agents.find((a) => a.id === agentId) as AgentTab;

  const ui = useUiStore.getState();
  const scoped = scopedProject();
  const priorSelection = scoped ? { projectId: scoped.id, agentId: scoped.selectedAgentId } : null;
  const priorWorkMode = ui.workModeBySide[scopedSide()];
  const priorActiveSpecial = ui.activeSpecial;
  const switchedProject = scoped?.id !== project.id;

  let priorBands: BandVisibility | null = null;
  let priorCollapsed: Record<string, boolean> | null = null;

  if (opts.ensureVisible !== false) {
    // The view is read AFTER the project is known but BEFORE the switch, against the target's own
    // column — a cross-project select lands on a column whose filter is the same persisted one, so
    // the band that hides the row here hides it there too.
    const view = columnView(project);
    // WHICH ROW does the column draw for this agent, and under which head? Asked of the column's
    // own structure rather than re-derived from `kind === "worker"`: a nested shell is a child row
    // exactly like a worker is (AgentSidebar.tsx:1626), and keying on kind treated it as its own
    // head — so neither its head's subtree got opened nor its head's band checked, and the human
    // landed on an invisible row, the precise failure this option exists to prevent.
    const head = view.headOf(agentId);
    if (!head) {
      // Real agent, no row — an orphan worker, or a child of a row that does not unfold. There is
      // nothing to unhide, so `ensureVisible` cannot be honoured and saying "ok" would be a lie.
      // `{ ensureVisible: false }` is the explicit way to land on it anyway.
      return refuse(
        "select_row",
        "no-row",
        `${agent.name} (${agentId}) has no row in the Build column, so it cannot be brought into view. Select it with ensureVisible off to open it anyway.`,
      );
    }
    // Open the head's subtree FIRST: a child row is not rendered at all while its head is folded,
    // and the band we then need to check is the HEAD's — the rollup is what the column filters on,
    // and a child's own status is not what put its head in a band.
    if (head.id !== agentId) {
      const before = collapseSnapshot([head.id]);
      if (before[head.id]) {
        // Not `{ auto: true }` — see expandOrchestrators. This subtree was opened to satisfy an
        // explicit "take me to this row"; auto-collapse must not close it a tick later.
        useUiStore.getState().expandOrchestrators([head.id]);
        priorCollapsed = before;
      }
    }
    const band = view.bandOf(head.id);
    if (!view.bands[band]) {
      const before = bandsNow();
      useUiStore.getState().toggleStatusBand(band);
      priorBands = before;
    }
  }

  openProjectTab(project.id, agentId);
  // Ask the column to scroll to it as well. Selection alone is not sightedness: the row can be
  // below the fold in a long fleet, which is exactly why requestRevealAgent exists.
  useUiStore.getState().requestRevealAgent(agentId);

  return ok("select_row", {
    agentId,
    projectId: project.id,
    priorSelection,
    priorWorkMode,
    priorActiveSpecial,
    priorBands,
    priorCollapsed,
    switchedProject,
  });
}

/** The ladder sections, for a caller that wants to name one in a sentence. Static metadata, not
 *  live state — exported here so a concierge doesn't hardcode the labels. */
export const BUILD_SECTION_LABELS: Record<BuildSectionId, string> = Object.fromEntries(
  BUILD_SECTIONS.map((s) => [s.id, s.label]),
) as Record<BuildSectionId, string>;

/** The band chips, likewise. */
export const STATUS_BAND_LABELS: Record<StatusBand, string> = Object.fromEntries(
  STATUS_BANDS.map((b) => [b.id, b.label]),
) as Record<StatusBand, string>;

/** Every band the filter understands, for a caller building an argument. */
export const STATUS_BAND_IDS: readonly StatusBand[] = BAND_IDS;

/** The all-on filter, from engine/buildSections rather than a literal — the shape `setStatusBands`
 *  round-trips and the state `showAllStatusBands` produces. */
export function allBands(): BandVisibility {
  return allBandsVisible();
}
