// @vitest-environment jsdom
//
// The SIDEBAR VIEW-STATE concierge tool domain. These pin the five properties the domain exists to
// guarantee, in the order they matter:
//
//   1. every function returns a TYPED result — a refusal is a value, never a thrown string;
//   2. the risk map is EXHAUSTIVE over the operation list (a typecheck failure AND a runtime test,
//      because a `Record` only catches the mistake at the boundary of this module), and only the
//      SELECTION op is classified `disruptive`;
//   3. every filter/subtree write is REVERSIBLE from its own result — the prior state it reports is
//      re-appliable and restores the column exactly;
//   4. live state is read from the STORES, never from a caller-supplied flag;
//   5. it is a façade over the real store actions: the resulting state is the one the chips, the
//      chevrons and the reveal paths produce, and nothing here reaches the backend at all.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  SIDEBAR_VIEW_OPS,
  SIDEBAR_VIEW_OP_RISK,
  STATUS_BAND_IDS,
  allBands,
  collapseOrchestrators,
  expandOrchestrators,
  isolateStatusBand,
  listBuildRows,
  readSidebarView,
  revealRow,
  selectRow,
  setOrchestratorsCollapsed,
  setStatusBands,
  setWorkMode,
  showAllStatusBands,
  toggleStatusBand,
  type BandVisibility,
  type BuildRow,
  type SidebarViewRiskClass,
} from "./sidebarView";
import { __clearRepoSlugCache, __setRepoSlugForTest } from "./repoSlug";
import { useProjectStore } from "../../stores/projectStore";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { useUiStore } from "../../stores/uiStore";
import type { AgentTab, AgentTabStatus, Project } from "../../types";

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────
// One project ("web") with the three bands represented, and one delegating orchestrator so the
// subtree ops have something real to open. A second project ("api") for the cross-project select.
//
//   b1  build, waiting  → needs_you
//   b2  build, working  → running, with workers w1/w2 (idle)
//   b3  build, idle     → done
//   b4  build, idle     → done, in project "api"

function mkAgent(id: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id,
    name: id.toUpperCase(),
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
    ...over,
  } as AgentTab;
}

function mkProject(id: string, name: string, agents: AgentTab[]): Project {
  return {
    id,
    name,
    rootPath: `/tmp/${id}`,
    defaultBranch: null,
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    agents,
  } as Project;
}

const STATUS: Record<string, AgentTabStatus> = {
  b1: "waiting",
  b2: "working",
  w1: "idle",
  w2: "idle",
  b3: "idle",
  b4: "idle",
};

function web(): Project {
  return mkProject("p1", "web", [
    mkAgent("b1"),
    mkAgent("b2"),
    mkAgent("w1", { kind: "worker", parentId: "b2" }),
    mkAgent("w2", { kind: "worker", parentId: "b2" }),
    mkAgent("b3"),
  ]);
}

/**
 * The same project, plus the children the column renders that are NOT workers.
 *
 * This is the shape the façade and the column used to disagree about. `AgentSidebar` buckets
 * children by `parentId` REGARDLESS of kind (`childrenByParent`, AgentSidebar.tsx:1109) and unfolds
 * every one of them under a `kind === "build"` head (:1626), so a nested shell is a row in its
 * head's subtree exactly like a worker is. `sh1` is b1's ONLY child — a head that has a chevron on
 * screen while having no workers at all — and `ow` is an orphan worker, which the column renders
 * nowhere (`isTopLevelAgent` excludes every worker, and no build head claims it).
 */
function webWithNestedShells(): Project {
  return mkProject("p1", "web", [
    mkAgent("b1"),
    mkAgent("sh1", { kind: "shell", parentId: "b1" }),
    mkAgent("b2"),
    mkAgent("w1", { kind: "worker", parentId: "b2" }),
    mkAgent("sh2", { kind: "shell", parentId: "b2" }),
    mkAgent("b3"),
    mkAgent("ow", { kind: "worker", parentId: null }),
  ]);
}

/** The listed rows, addressable by id. Asserts presence rather than handing back `| undefined`:
 *  a row the column forgot about is a failure worth naming, not a silent optional chain. */
function rowsById(rows: BuildRow[]): (id: string) => BuildRow {
  const map = new Map(rows.map((r) => [r.id, r]));
  return (id) => {
    const row = map.get(id);
    if (!row) throw new Error(`no row ${id} in [${[...map.keys()].join(", ")}]`);
    return row;
  };
}

/** A project by id, likewise asserted. */
function proj(id: string): Project {
  const p = useProjectStore.getState().projects.find((x) => x.id === id);
  if (!p) throw new Error(`no project ${id}`);
  return p;
}

/** Unwrap an `ok` result, failing loudly (rather than casting) when it refused. */
function value<T>(result: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!result.ok) throw new Error(`expected ok, got refusal: ${result.message}`);
  return result.value;
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
  localStorage.clear();
  useProjectStore.setState({
    projects: [web(), mkProject("p2", "api", [mkAgent("b4")])],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({
    status: { ...STATUS },
    // Empty on purpose: an open parent with a status-less worker would trip
    // withUnstartedWorkerAttention's synthetic red and change the bands under the tests.
    openAgentIds: [],
    branchStatus: {},
    workflowStage: {},
    workflowShipped: {},
  } as never);
  useUiStore.setState({
    statusFilter: allBands(),
    collapsedOrchestrators: {},
    workModeBySide: { left: "build", right: "build" },
    activeSpecial: null,
    openProjectIds: null,
    pinnedProjectId: null,
    revealAgentId: null,
  } as never);
});

// ── contract 2: the risk map ─────────────────────────────────────────────────────────────────
describe("the risk map", () => {
  it("classifies every operation — exhaustively", () => {
    for (const op of SIDEBAR_VIEW_OPS) {
      expect(SIDEBAR_VIEW_OP_RISK[op], `${op} is unclassified`).toBeTruthy();
    }
    expect(Object.keys(SIDEBAR_VIEW_OP_RISK).sort()).toEqual([...SIDEBAR_VIEW_OPS].sort());
  });

  it("marks ONLY the selection op disruptive — view changes are not selection changes", () => {
    // The type is DOMAIN-PREFIXED on purpose: `workspace.ts` exports its own risk vocabulary where
    // `disruptive` means "work in flight dies", not "the pane moved". Two `RiskClass` types in one
    // directory, sharing a member name that means different things, is how a caller ends up
    // applying a tab-close's amount of care to a filter chip. This annotation pins the name.
    const disruptive: SidebarViewRiskClass = "disruptive";
    expect(SIDEBAR_VIEW_OPS.filter((op) => SIDEBAR_VIEW_OP_RISK[op] === disruptive)).toEqual([
      "select_row",
    ]);
  });

  it("keeps the filter/subtree/chevron ops in the low-risk view class", () => {
    for (const op of [
      "toggle_status_band",
      "isolate_status_band",
      "set_status_bands",
      "show_all_status_bands",
      "expand_orchestrators",
      "collapse_orchestrators",
      "set_orchestrators_collapsed",
      "set_work_mode",
      "reveal_row",
    ] as const) {
      expect(SIDEBAR_VIEW_OP_RISK[op], op).toBe("view");
    }
    expect(SIDEBAR_VIEW_OP_RISK.read_sidebar_view).toBe("read-only");
    expect(SIDEBAR_VIEW_OP_RISK.list_build_rows).toBe("read-only");
  });

  it("stamps the performed op and its risk on every result, ok or refusal", () => {
    const okResult = showAllStatusBands();
    expect(okResult.op).toBe("show_all_status_bands");
    expect(okResult.risk).toBe("view");
    const refusal = toggleStatusBand("nope");
    expect(refusal.ok).toBe(false);
    expect(refusal.op).toBe("toggle_status_band");
    expect(refusal.risk).toBe("view");
  });
});

// ── contract 5: no backend, ever ─────────────────────────────────────────────────────────────
describe("the domain is pure store state", () => {
  it("issues no backend COMMAND across every operation — only store writes", () => {
    readSidebarView();
    listBuildRows();
    toggleStatusBand("done");
    isolateStatusBand("needs_you");
    setStatusBands(allBands());
    showAllStatusBands();
    expandOrchestrators(["b2"]);
    collapseOrchestrators(["b2"]);
    setOrchestratorsCollapsed({ b2: false });
    setWorkMode("plan");
    setWorkMode("build");
    revealRow("b1");
    selectRow("b1");
    // `frontend_log` is excluded, and only that: it is the log RELAY, emitted by projectStore's own
    // `perfStart` when a selection switches panes. It carries no state and answers nothing back.
    // Every other invoke would be this domain reaching past the stores it is supposed to be a façade
    // over — which is also what keeps these operations synchronous and unable to reject.
    const commands = invoke.mock.calls.map((c) => c[0]).filter((name) => name !== "frontend_log");
    expect(commands).toEqual([]);
  });
});

// ── reading the column ───────────────────────────────────────────────────────────────────────
describe("readSidebarView", () => {
  it("reports the scope, chevron, filter and per-band counts the chips show", () => {
    const v = value(readSidebarView());
    expect(v.projectId).toBe("p1");
    expect(v.projectName).toBe("web");
    expect(v.workMode).toBe("build");
    expect(v.bands).toEqual({ needs_you: true, questions: true, running: true, done: true });
    // Counts are over TOP-LEVEL rows only — workers never claim a row of their own.
    expect(v.bandCounts).toEqual({ needs_you: 1, questions: 0, running: 1, done: 1 });
    expect(v.hiddenByFilter).toBe(false);
  });

  it("counts a band that is switched OFF, so the concierge can say what turning it back on reveals", () => {
    isolateStatusBand("needs_you");
    const v = value(readSidebarView());
    expect(v.bands).toEqual({ needs_you: true, questions: false, running: false, done: false });
    expect(v.bandCounts).toEqual({ needs_you: 1, questions: 0, running: 1, done: 1 });
    expect(v.visibleRows).toBe(1);
  });

  it("distinguishes 'you filtered everything out' from 'there is nothing here'", () => {
    expect(value(readSidebarView()).hiddenByFilter).toBe(false);
    setStatusBands({ needs_you: false, questions: false, running: false, done: false });
    expect(value(readSidebarView()).hiddenByFilter).toBe(true);
    // An empty project is NOT hiddenByFilter — there is nothing to reveal.
    useProjectStore.setState({ projects: [mkProject("p1", "web", [])], selectedProjectId: "p1" } as never);
    expect(value(readSidebarView()).hiddenByFilter).toBe(false);
  });

  it("answers with the chevron and filter even when no project is scoped", () => {
    useProjectStore.setState({ selectedProjectId: null } as never);
    const v = value(readSidebarView());
    expect(v.projectId).toBeNull();
    expect(v.bands).toEqual(allBands());
    expect(v.totalRows).toBe(0);
  });

  it("reads the stores LIVE — a store write made behind its back is reflected", () => {
    useUiStore.getState().toggleStatusBand("done");
    useUiStore.getState().expandOrchestrators(["b2"]);
    const v = value(readSidebarView());
    expect(v.bands.done).toBe(false);
    expect(v.expandedOrchestrators).toEqual(["b2"]);
  });
});

describe("listBuildRows", () => {
  it("bands each row the way the column's own chips do", () => {
    const row = rowsById(value(listBuildRows()));
    expect(row("b1").band).toBe("needs_you");
    expect(row("b2").band).toBe("running");
    expect(row("b3").band).toBe("done");
    expect(row("b2").workerCount).toBe(2);
    expect(row("b1").workerCount).toBe(0);
  });

  it("hides a head's workers behind its folded subtree, and says so", () => {
    const row = rowsById(value(listBuildRows()));
    expect(row("b2").collapsed).toBe(true);
    expect(row("w1").visible).toBe(false);
    expect(row("w1").hiddenReason).toBe("subtree-collapsed");
    expandOrchestrators(["b2"]);
    const after = rowsById(value(listBuildRows()));
    expect(after("w1").visible).toBe(true);
    expect(after("w1").hiddenReason).toBeNull();
  });

  it("reports a filtered-out row as band-filtered — with its workers, not a reason of their own", () => {
    expandOrchestrators(["b2"]);
    isolateStatusBand("needs_you");
    const row = rowsById(value(listBuildRows()));
    expect(row("b1").visible).toBe(true);
    expect(row("b2").visible).toBe(false);
    expect(row("b2").hiddenReason).toBe("band-filtered");
    expect(row("b2").section).toBeNull();
    expect(row("w1").hiddenReason).toBe("band-filtered");
  });

  it("says plan-mode rather than pretending the filter hid the column", () => {
    setWorkMode("plan");
    const rows = value(listBuildRows());
    expect(rows.every((r) => !r.visible)).toBe(true);
    expect(new Set(rows.map((r) => r.hiddenReason))).toEqual(new Set(["plan-mode"]));
  });

  it("marks the selected row and places rows in a ladder section", () => {
    useProjectStore.getState().selectAgent("p1", "b3");
    const row = rowsById(value(listBuildRows()));
    expect(row("b3").selected).toBe(true);
    expect(row("b1").selected).toBe(false);
    // With no branch status and no override every agent resolves to the first rung.
    expect(row("b1").section).toBe("local_uncommitted");
  });

  it("reports `local_none` for a clean pre-commit row — the concierge sees what the column shows", () => {
    // roborev 57842: this view exists to tell the concierge what the Build column is rendering, so a
    // row it files under a different rung than the column does is a lie about the screen. Nothing
    // asserted the wiring — every case here seeds `branchStatus: {}`, so every row read `undefined`
    // and `local_none` was unreachable from this surface regardless of whether it worked.
    useRuntimeStore.setState({
      branchStatus: {
        b1: { ahead: 0, behind: 0, dirty: false, filesChanged: 0, insertions: 0, deletions: 0, worktreeOnBranch: true },
        b2: { ahead: 0, behind: 0, dirty: true, filesChanged: 0, insertions: 0, deletions: 0, worktreeOnBranch: true },
      },
    } as never);
    const row = rowsById(value(listBuildRows()));
    expect(row("b1").section).toBe("local_none");
    // The control: same stage, dirty tree, stays put. Without it this would pass on a blanket rename.
    expect(row("b2").section).toBe("local_uncommitted");
  });

  it("keeps an UNREAD row in `local_uncommitted` from this surface too", () => {
    useRuntimeStore.setState({ branchStatus: {} } as never);
    const row = rowsById(value(listBuildRows()));
    expect(row("b1").section).toBe("local_uncommitted");
  });

  it("refuses rather than returning an empty list when no project is scoped", () => {
    useProjectStore.setState({ selectedProjectId: null } as never);
    const r = listBuildRows();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-project");
  });
});

// ── the subtree is whatever the COLUMN renders under a head, not just its workers ────────────
describe("a head's subtree mirrors the column's own predicate", () => {
  /** The nested-shell fleet, with a status for every row so no synthetic overlay fires. */
  function useNestedShells(stage: Record<string, string> = {}): void {
    useProjectStore.setState({
      projects: [webWithNestedShells(), mkProject("p2", "api", [mkAgent("b4")])],
      selectedProjectId: "p1",
    } as never);
    useRuntimeStore.setState({
      status: { ...STATUS, sh1: "idle", sh2: "idle", ow: "idle" },
      openAgentIds: [],
      branchStatus: {},
      workflowStage: { ...stage },
      workflowShipped: {},
    } as never);
  }

  beforeEach(() => useNestedShells());

  it("lists a non-worker child as a row under its head — the column renders it, so this must too", () => {
    const rows = value(listBuildRows());
    expect(rows.map((r) => r.id)).toEqual(["b1", "sh1", "b2", "w1", "sh2", "b3"]);
    const row = rowsById(rows);
    expect(row("sh1").parentId).toBe("b1");
    expect(row("sh1").hiddenReason).toBe("subtree-collapsed");
    // The count the column puts on the head row (AgentSidebar's `workerCount` prop) is the size of
    // the rendered subtree, whatever the children's kinds are.
    expect(row("b1").workerCount).toBe(1);
    expect(row("b2").workerCount).toBe(2);
  });

  it("gives a head whose only child is a shell the chevron state the column shows it with", () => {
    const row = rowsById(value(listBuildRows()));
    expect(row("b1").collapsed).toBe(true);
    expect(value(expandOrchestrators(["b1"])).collapsed).toEqual({ b1: false });
    const after = rowsById(value(listBuildRows()));
    expect(after("b1").collapsed).toBe(false);
    expect(after("sh1").visible).toBe(true);
    expect(after("sh1").hiddenReason).toBeNull();
  });

  it("rolls a non-worker child's stage into its head, exactly as AgentSidebar's headStageOf does", () => {
    // b1 is itself in PR; its shell child has no branch at all. The column buckets the head by the
    // roll-up over ALL its children, so b1 sits on the first rung, not under "In PR".
    useNestedShells({ b1: "pull_request" });
    const row = rowsById(value(listBuildRows()));
    expect(row("b1").stage).toBe("building_unsaved");
    expect(row("b1").section).toBe("local_uncommitted");
  });

  it("opens the head's subtree when selecting a non-worker child, instead of landing on nothing", () => {
    const v = value(selectRow("sh1"));
    expect(v.priorCollapsed).toEqual({ b1: true });
    const row = rowsById(value(listBuildRows()));
    expect(row("sh1").visible).toBe(true);
    expect(row("sh1").selected).toBe(true);
  });

  it("bands a non-worker child on its HEAD — the row the filter actually keys on", () => {
    isolateStatusBand("needs_you"); // b1's band; b2 (running) is hidden, and sh2 lives under it
    const v = value(selectRow("sh2"));
    expect(v.priorBands).toEqual({ needs_you: true, questions: false, running: false, done: false });
    expect(useUiStore.getState().statusFilter.running).toBe(true);
    expect(rowsById(value(listBuildRows()))("sh2").visible).toBe(true);
  });

  it("refuses an agent that EXISTS but has no row with its own reason, not unknown-agent", () => {
    const r = revealRow("ow");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("no-row");
      expect(r.message).toContain("OW");
    }
    expect(useUiStore.getState().revealAgentId).toBeNull();
  });

  it("will not land the human on a rowless agent unless they opt out of ensureVisible", () => {
    const r = selectRow("ow");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-row");
    expect(proj("p1").selectedAgentId).toBeNull();
    // Opting out is an explicit "I know it has no row" — the selection then goes through.
    expect(value(selectRow("ow", { ensureVisible: false })).agentId).toBe("ow");
    expect(proj("p1").selectedAgentId).toBe("ow");
  });
});

// ── contract 3: filtering, and putting it back ───────────────────────────────────────────────
describe("status-band filtering", () => {
  it("toggles the chip the user would have clicked", () => {
    const v = value(toggleStatusBand("done"));
    expect(v.bands.done).toBe(false);
    expect(v.priorBands.done).toBe(true);
    expect(v.changed).toEqual(["done"]);
    expect(useUiStore.getState().statusFilter.done).toBe(false);
  });

  it("isolates to one band and reports the whole prior set", () => {
    toggleStatusBand("running"); // start from a non-default state
    const v = value(isolateStatusBand("needs_you"));
    expect(v.bands).toEqual({ needs_you: true, questions: false, running: false, done: false });
    expect(v.priorBands).toEqual({ needs_you: true, questions: true, running: false, done: true });
  });

  it("is REVERSIBLE — the prior set restores the column exactly", () => {
    const before: BandVisibility = { needs_you: true, questions: true, running: false, done: true };
    setStatusBands(before);
    const isolated = value(isolateStatusBand("running"));
    expect(useUiStore.getState().statusFilter).toEqual({
      needs_you: false,
      questions: false,
      running: true,
      done: false,
    });
    setStatusBands(isolated.priorBands);
    expect(useUiStore.getState().statusFilter).toEqual(before);
  });

  it("allows turning every band off — the empty column explains itself", () => {
    const v = value(setStatusBands({ needs_you: false, questions: false, running: false, done: false }));
    expect(v.bands).toEqual({ needs_you: false, questions: false, running: false, done: false });
    expect(value(listBuildRows()).every((r) => !r.visible)).toBe(true);
  });

  it("reports an idempotent call as changing nothing", () => {
    const v = value(showAllStatusBands());
    expect(v.changed).toEqual([]);
    expect(v.bands).toEqual(v.priorBands);
  });

  it("refuses an unknown band instead of silently doing nothing", () => {
    for (const r of [toggleStatusBand("urgent"), isolateStatusBand("URGENT")]) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("unknown-band");
        expect(r.message).toContain("needs_you");
      }
    }
    expect(useUiStore.getState().statusFilter).toEqual(allBands());
  });

  it("refuses a PARTIAL filter — a band hidden by omission has no visible cause", () => {
    const r = setStatusBands({ needs_you: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // NOT `unknown-band`: every key supplied WAS a band. The caller's mistake is the omission,
      // and a caller branching on the reason has to be able to tell "you named a band I don't have"
      // from "you named real bands but not all of them" — the fixes are different.
      expect(r.reason).toBe("incomplete-bands");
      expect(r.message).toContain("running");
      expect(r.message).toContain("done");
    }
    expect(useUiStore.getState().statusFilter).toEqual(allBands());
  });

  it("still calls an unknown KEY unknown-band, even alongside valid ones", () => {
    const r = setStatusBands({ needs_you: true, running: true, done: true, urgent: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown-band");
  });

  it("exposes the band vocabulary rather than making callers guess it", () => {
    // FOUR bands since 2026-08-05: `questions` (BLUE) sits between the alarm and the calm bands.
    // Order is the chip order, and the concierge reads this to name bands back to the founder.
    expect([...STATUS_BAND_IDS]).toEqual(["needs_you", "questions", "running", "done"]);
  });
});

// ── orchestrator subtrees ────────────────────────────────────────────────────────────────────
describe("orchestrator subtrees", () => {
  // A reveal the user asked for is STICKY. There is no longer a "close what the app opened" op that
  // could take it back — that tool existed to undo auto-expansion, and auto-expansion is gone.
  it("expands and reports what it changed", () => {
    const v = value(expandOrchestrators(["b2"]));
    expect(v.priorCollapsed).toEqual({ b2: true });
    expect(v.collapsed).toEqual({ b2: false });
    expect(useUiStore.getState().isOrchestratorCollapsed("b2")).toBe(false);
  });

  it("collapses idempotently — a retried close never re-opens a folded subtree", () => {
    expandOrchestrators(["b2"]);
    expect(value(collapseOrchestrators(["b2"])).collapsed).toEqual({ b2: true });
    const again = value(collapseOrchestrators(["b2"]));
    expect(again.changed).toEqual([]);
    expect(useUiStore.getState().isOrchestratorCollapsed("b2")).toBe(true);
  });

  it("is REVERSIBLE — a prior snapshot goes back verbatim", () => {
    const opened = value(expandOrchestrators(["b2"]));
    expect(useUiStore.getState().isOrchestratorCollapsed("b2")).toBe(false);
    setOrchestratorsCollapsed(opened.priorCollapsed);
    expect(useUiStore.getState().isOrchestratorCollapsed("b2")).toBe(true);
    setOrchestratorsCollapsed({ b2: false });
    expect(useUiStore.getState().isOrchestratorCollapsed("b2")).toBe(false);
  });

  it("refuses an id that names no agent", () => {
    const r = expandOrchestrators(["nope"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown-agent");
  });

  it("refuses a worker row and a head with no workers — neither has a subtree", () => {
    for (const id of ["w1", "b1"]) {
      const r = expandOrchestrators([id]);
      expect(r.ok, id).toBe(false);
      if (!r.ok) expect(r.reason).toBe("not-an-orchestrator");
    }
    expect(useUiStore.getState().collapsedOrchestrators).toEqual({});
  });

  it("refuses an empty id list rather than reporting a successful no-op", () => {
    const r = expandOrchestrators([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-ids");
  });

  it("writes NOTHING when any id in the batch is bad", () => {
    const r = expandOrchestrators(["b2", "nope"]);
    expect(r.ok).toBe(false);
    expect(useUiStore.getState().isOrchestratorCollapsed("b2")).toBe(true);
  });

  it("refuses when no project is scoped", () => {
    useProjectStore.setState({ selectedProjectId: null } as never);
    const r = expandOrchestrators(["b2"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-project");
  });
});

// ── chevron ──────────────────────────────────────────────────────────────────────────────────
describe("setWorkMode", () => {
  // "Show me the board" is TWO writes — the mode, and making the Improve-Sparkle pane yield, since
  // Workspace gates the board on `!sparkleActive`. This op reported success while the stage was
  // unchanged, and `reconcileWorkMode` bails on its first line whenever a special is up, so nothing
  // recovered it. The docstring asserted that reconciler would handle it; it is the one thing that
  // could not (roborev 55878).
  // THE ALREADY-IN-PLAN CASE, which is how a user actually reaches this state: open the board,
  // then click Improve Sparkle — `onSelectSparkle` never touches the mode, so the column stays in
  // Plan while the pane covers its board. A mode-equality no-op check refuses here and reports
  // "nothing to do" about a view that is not on screen, while the chevron (which calls
  // openPlanBoard unconditionally) recovers it — same request, two answers.
  it("recovers a covered board even though the column is ALREADY in Plan", () => {
    useUiStore.setState({
      workModeBySide: { left: "build", right: "plan" },
      activeSpecial: "sparkle",
    } as never);

    const v = value(setWorkMode("plan"));

    expect(v.priorWorkMode).toBe("plan");
    expect(useUiStore.getState().activeSpecial).toBeNull();
  });

  // THE MIRROR, and the more common state of the two: "build" is the default, and selecting
  // Improve Sparkle never touches the mode — so a column sitting in Build with the pane over its
  // terminal is the ordinary case. Gating the visibility question on `mode === "plan"` fixed one
  // branch of a symmetric problem and left this one refusing "already in build mode" about a stage
  // that is not on screen. It also matters because no other concierge tool means "leave Improve
  // Sparkle" without also selecting an agent.
  it("recovers a covered Build stage even though the column is ALREADY in Build", () => {
    useUiStore.setState({
      workModeBySide: { left: "build", right: "build" },
      activeSpecial: "sparkle",
    } as never);

    const v = value(setWorkMode("build"));

    expect(v.priorWorkMode).toBe("build");
    expect(useUiStore.getState().activeSpecial).toBeNull();
    expect(useUiStore.getState().workModeBySide.right).toBe("build");
  });

  // ...and it is still a genuine no-op when the board IS the visible surface, so an idempotent
  // request does not start reporting success for work it did not do.
  it("still refuses as a no-op when the column is in Plan and the board is showing", () => {
    useUiStore.setState({
      workModeBySide: { left: "build", right: "plan" },
      activeSpecial: null,
    } as never);

    const r = setWorkMode("plan");

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("no-op");
  });

  it("makes the Improve-Sparkle pane yield when it switches a column INTO Plan", () => {
    useUiStore.setState({ activeSpecial: "sparkle" } as never);

    const v = value(setWorkMode("plan"));

    expect(v.workMode).toBe("plan");
    expect(useUiStore.getState().workModeBySide.right).toBe("plan");
    expect(useUiStore.getState().activeSpecial).toBeNull();
  });

  it("switches the chevron and reports the mode it replaced", () => {
    const v = value(setWorkMode("plan"));
    expect(v).toEqual({ priorWorkMode: "build", workMode: "plan" });
    expect(useUiStore.getState().workModeBySide.right).toBe("plan");
  });

  it("leaves the pane's overlay to the sidebar's own reconciler", () => {
    setWorkMode("plan");
    expect(useUiStore.getState().activeSpecial).toBeNull();
  });

  it("distinguishes an idempotent request from a bad argument", () => {
    // Both refuse, but for reasons a caller must be able to tell apart: "already in build mode" is
    // safe to shrug off, while "kanban is not a mode" is a caller bug that retrying cannot fix.
    const noop = setWorkMode("build");
    expect(noop.ok).toBe(false);
    if (!noop.ok) expect(noop.reason).toBe("no-op");
    for (const bad of [setWorkMode("kanban"), setWorkMode("")]) {
      expect(bad.ok).toBe(false);
      if (!bad.ok) {
        expect(bad.reason).toBe("unknown-mode");
        expect(bad.message).toContain("plan");
      }
    }
    expect(useUiStore.getState().workModeBySide.right).toBe("build");
  });

  // ── EVERY MODE THE UNION HAS IS REACHABLE FROM HERE ──────────────────────────────────────────
  // The guard used to be a hand-written `mode !== "plan" && mode !== "build"` beside a type that
  // had grown a third member, so the concierge refused a mode that really existed and told the user
  // it did not (roborev 60625). The union is back to two — a preview is a concierge card now, not a
  // mode — but the shape that caused that bug is the same one that would cause the next: a guard
  // and a message that re-list the members by hand instead of reading `WORK_MODES`.
  //
  // `"preview"` IS NOW REFUSED, AND THAT IS THE CONTRACT, not a gap: there is no such mode, so
  // accepting it would put a column into a state nothing renders. Asserted beside a mode that IS
  // accepted, so this cannot be satisfied by an op that refuses everything.
  it("refuses preview — it is not a mode any more — while still accepting plan", () => {
    const bad = setWorkMode("preview");
    expect(bad.ok).toBe(false);
    expect(useUiStore.getState().workModeBySide.right).toBe("build");

    const good = value(setWorkMode("plan"));
    expect(good.workMode).toBe("plan");
    expect(useUiStore.getState().workModeBySide.right).toBe("plan");
  });

  // `openPlanBoard`, not a bare `setWorkMode` — the mode-plus-yield family. The Improve-Sparkle
  // pane covers whichever surface the column is showing, so entering another mode while it is up
  // has to make it yield or the op reports success over an unchanged stage.
  it("drops a covering Improve-Sparkle pane when it enters Plan", () => {
    useUiStore.setState({ activeSpecial: "sparkle" } as never);
    value(setWorkMode("plan"));
    expect(useUiStore.getState().workModeBySide.right).toBe("plan");
    expect(useUiStore.getState().activeSpecial).toBeNull();
  });

  // THE REFUSAL MESSAGE IS BUILT FROM THE LIST, which is the half a widened guard alone would leave
  // standing: the mode would be accepted while the help text still named the wrong set.
  it("names every mode when it refuses an unknown one", () => {
    const bad = setWorkMode("kanban");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      for (const m of ["plan", "build"]) expect(bad.message).toContain(m);
      // …and it must NOT name a mode that no longer exists, which is the same failure in reverse:
      // a help text offering "preview" would send the caller straight back to the refusal above.
      expect(bad.message).not.toContain("preview");
    }
  });
});

// ── reveal (scroll, don't steal) ─────────────────────────────────────────────────────────────
describe("revealRow", () => {
  it("asks the column to scroll WITHOUT touching the selection or the pane", () => {
    const v = value(revealRow("b3"));
    expect(v.visible).toBe(true);
    expect(v.hiddenReason).toBeNull();
    expect(v.expiresInMs).toBeGreaterThan(0);
    expect(useUiStore.getState().revealAgentId).toBe("b3");
    expect(proj("p1").selectedAgentId).toBeNull();
    expect(useRuntimeStore.getState().openAgentIds).toEqual([]);
  });

  it("says when the row it was asked to scroll to is not on screen", () => {
    isolateStatusBand("needs_you");
    const v = value(revealRow("b3"));
    expect(v.visible).toBe(false);
    expect(v.hiddenReason).toBe("band-filtered");
  });

  it("refuses an agent outside the scoped project", () => {
    const r = revealRow("b4");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown-agent");
    expect(useUiStore.getState().revealAgentId).toBeNull();
  });
});

// ── selection: the one disruptive op ─────────────────────────────────────────────────────────
describe("selectRow", () => {
  it("lands the human on the row — selection, pane, chevron, overlay and scroll", () => {
    useUiStore.setState({ activeSpecial: "sparkle", workModeBySide: { left: "build", right: "plan" } } as never);
    const v = value(selectRow("b3"));
    expect(v.agentId).toBe("b3");
    expect(v.projectId).toBe("p1");
    expect(v.priorWorkMode).toBe("plan");
    expect(v.priorActiveSpecial).toBe("sparkle");
    expect(v.switchedProject).toBe(false);
    const ui = useUiStore.getState();
    expect(ui.activeSpecial).toBeNull();
    expect(ui.workModeBySide.right).toBe("build");
    expect(ui.revealAgentId).toBe("b3");
    expect(proj("p1").selectedAgentId).toBe("b3");
    expect(useRuntimeStore.getState().openAgentIds).toContain("b3");
  });

  it("reports the selection it replaced, so the human can be put back", () => {
    useProjectStore.getState().selectAgent("p1", "b1");
    const v = value(selectRow("b3"));
    expect(v.priorSelection).toEqual({ projectId: "p1", agentId: "b1" });
  });

  it("unhides the row first: turns its band back on and reports the prior set", () => {
    isolateStatusBand("needs_you");
    const v = value(selectRow("b3"));
    expect(v.priorBands).toEqual({ needs_you: true, questions: false, running: false, done: false });
    expect(useUiStore.getState().statusFilter.done).toBe(true);
    const row = rowsById(value(listBuildRows()));
    expect(row("b3").visible).toBe(true);
    // …and it is REVERSIBLE.
    setStatusBands(v.priorBands as BandVisibility);
    expect(useUiStore.getState().statusFilter).toEqual({
      needs_you: true,
      questions: false,
      running: false,
      done: false,
    });
  });

  it("opens a worker's head subtree, and bands on the HEAD the column actually filters", () => {
    isolateStatusBand("running"); // b2's band; w1 lives under it
    const v = value(selectRow("w1"));
    expect(v.priorCollapsed).toEqual({ b2: true });
    expect(v.priorBands).toBeNull(); // b2's band was already visible — nothing to unhide
    const row = rowsById(value(listBuildRows()));
    expect(row("w1").visible).toBe(true);
    expect(row("w1").selected).toBe(true);
  });

  it("touches no view state when ensureVisible is off — and says the row is still hidden", () => {
    isolateStatusBand("needs_you");
    const v = value(selectRow("b3", { ensureVisible: false }));
    expect(v.priorBands).toBeNull();
    expect(v.priorCollapsed).toBeNull();
    expect(useUiStore.getState().statusFilter).toEqual({
      needs_you: true,
      questions: false,
      running: false,
      done: false,
    });
    const row = rowsById(value(listBuildRows()));
    expect(row("b3").selected).toBe(true);
    expect(row("b3").visible).toBe(false);
  });

  it("follows a row into ANOTHER project — scoping the column at it, not just selecting it", () => {
    const v = value(selectRow("b4"));
    expect(v.switchedProject).toBe(true);
    expect(v.projectId).toBe("p2");
    expect(useProjectStore.getState().selectedProjectId).toBe("p2");
    expect(value(readSidebarView()).projectId).toBe("p2");
    expect(proj("p2").selectedAgentId).toBe("b4");
  });

  it("refuses an agent that exists nowhere, changing nothing", () => {
    const r = selectRow("ghost");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown-agent");
    expect(proj("p1").selectedAgentId).toBeNull();
    expect(useUiStore.getState().revealAgentId).toBeNull();
  });
});

// ── contract 1: nothing throws ───────────────────────────────────────────────────────────────
describe("every entry point returns a value", () => {
  it("never throws, even with junk arguments and an empty app", () => {
    useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
    const calls: Array<() => unknown> = [
      () => readSidebarView(),
      () => listBuildRows(),
      () => toggleStatusBand(""),
      () => isolateStatusBand("done"),
      () => setStatusBands({}),
      () => setStatusBands({ nope: true } as Record<string, boolean>),
      () => showAllStatusBands(),
      () => expandOrchestrators([]),
      () => expandOrchestrators(["x"]),
      () => collapseOrchestrators(["x"]),
      () => setOrchestratorsCollapsed({}),
      () => setWorkMode(""),
      () => revealRow(""),
      () => selectRow(""),
      () => selectRow("", { ensureVisible: false }),
    ];
    for (const call of calls) {
      const r = call() as { ok: boolean; op: string };
      expect(typeof r.ok).toBe("boolean");
      expect(SIDEBAR_VIEW_OPS).toContain(r.op);
    }
  });
});

// ── The concierge's view must agree with the column about `tracked_elsewhere` ────────────────────
//
// This whole module exists so the concierge describes the SCREEN rather than its own recomputation
// of it, and `crossRepoOf` is an optional trailing argument to `groupAgentsByStage` — so dropping it
// here is neither a type error nor, without this block, a test failure. It would silently restore the
// state roborev 67500 found: the column showing a row on ladder slot 0 while this view reported it in
// `local_none`, at a different index (roborev 67613).
describe("cross-repo rows (bead `sparkle-pgh1ue`)", () => {
  const ROOT = "/tmp/p1";

  beforeEach(() => {
    __clearRepoSlugCache();
    __setRepoSlugForTest(ROOT, "drodio/sparkle");
  });

  it("files a row whose ASSIGNMENT named another repo under `tracked_elsewhere`", () => {
    useProjectStore.setState({
      projects: [
        mkProject("p1", "web", [
          mkAgent("b1", { assignmentRepos: ["drodio/drodio-website"] }),
          mkAgent("b3"),
        ]),
      ],
      selectedProjectId: "p1",
    } as never);
    const row = rowsById(value(listBuildRows()));
    expect(row("b1").section).toBe("tracked_elsewhere");
    // The negative control: the sibling is untouched, so this is the accessor doing the work rather
    // than the whole column moving.
    expect(row("b3").section).toBe("local_uncommitted");
  });

  it("files a row carrying a landing STAMP by what the stamp proves", () => {
    useProjectStore.setState({
      projects: [
        mkProject("p1", "web", [
          mkAgent("b1", {
            landedElsewhere: { repo: "drodio/drodio-website", prNumber: 253, state: "merged", stampedAt: 1 },
          }),
        ]),
      ],
      selectedProjectId: "p1",
    } as never);
    // ⚠️ THE ASSERTION IS POSITIVE, NOT A NEGATION — the first cut of this test asserted only
    // `not.toBe("local_none")`, which a bare `mkAgent` in this suite already satisfies (no
    // branchStatus ⇒ holdsWork undefined ⇒ `local_uncommitted`). It was therefore TRUE BEFORE the
    // stamp was read at all: deleting `landedElsewhere` from the accessor entirely left it green
    // (roborev 67730). A stamp alone satisfies `isCrossRepo`, so the rung it actually produces here
    // is `tracked_elsewhere`, and pinning that is what can tell "the stamp routed the row" from "the
    // stamp was ignored".
    const row = rowsById(value(listBuildRows()));
    expect(row("b1").section).toBe("tracked_elsewhere");
  });

  it("…and a row with NO stamp and no assignment is the control that keeps that test honest", () => {
    // The negative half of the pair. Same fixture shape, same absent branchStatus — the ONLY
    // difference is the stamp, so the two together isolate it.
    useProjectStore.setState({
      projects: [mkProject("p1", "web", [mkAgent("b1")])],
      selectedProjectId: "p1",
    } as never);
    expect(rowsById(value(listBuildRows()))("b1").section).toBe("local_uncommitted");
  });

  it("an UNRESOLVED bound slug files nothing as cross-repo — the fail-closed arm", () => {
    __setRepoSlugForTest(ROOT, null);
    useProjectStore.setState({
      projects: [mkProject("p1", "web", [mkAgent("b1", { assignmentRepos: ["drodio/drodio-website"] })])],
      selectedProjectId: "p1",
    } as never);
    expect(rowsById(value(listBuildRows()))("b1").section).toBe("local_uncommitted");
  });

  it("a head inherits a WORKER's cross-repo assignment, like every other subtree fold here", () => {
    useProjectStore.setState({
      projects: [
        mkProject("p1", "web", [
          mkAgent("b2"),
          mkAgent("w1", {
            kind: "worker",
            parentId: "b2",
            task: "publish at https://github.com/drodio/drodio-website",
          }),
        ]),
      ],
      selectedProjectId: "p1",
    } as never);
    expect(rowsById(value(listBuildRows()))("b2").section).toBe("tracked_elsewhere");
  });
});
