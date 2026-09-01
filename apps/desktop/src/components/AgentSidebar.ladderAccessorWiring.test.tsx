// @vitest-environment jsdom
//
// ══ ONE TEST PER PRODUCTION CALL SITE OF THE LADDER'S SECTION ACCESSORS (bead `sparkle-l5fi7`) ══
//
// THE RULE THIS FILE GUARDS. `holdsWorkOf` and `crossRepoOf` decide which RUNG a row lands on, and
// therefore the whole rendered row ORDER — `tracked_elsewhere` is ladder slot 0 and `local_none`
// sorts above `local_uncommitted`. Every production caller must derive them the same way and pass
// them, or selection points at a row the column is not rendering (roborev 53858 / 67500).
//
// WHY IT NEEDS TESTS SHAPED LIKE THIS. Both are OPTIONAL TRAILING ARGUMENTS on
// `groupAgentsByStage` / `firstLadderRowId`. Deleting one from a call site used to be neither a
// type error nor a test failure: the rungs appeared only in pure-function unit tests, while every
// component test seeded `branchStatus: {}` and no cross-repo assignment, so every row read
// `undefined` on both axes and the wiring was invisible to the suite (PR #1186's own retro,
// `sparkle-l5fi7`). A code comment asserting the drift is impossible is not a mechanism.
//
// Two mechanisms replaced that comment, and this file is the second of them:
//   1. TYPES — both parameters are now REQUIRED (a caller with no reading passes an explicit
//      `undefined`), so DELETING one at a call site is a compile error. See buildSections.ts.
//   2. THESE TESTS — one per production call site, driving the real entry point, seeding state that
//      exercises the NON-DEFAULT value, and asserting the SIDE EFFECT (which row is drawn first /
//      which row selection lands on), never the precondition. Each is mutation-checked by actually
//      deleting the argument at its own call site.
//
// THE CALL SITES, and where each is covered:
//   • AgentSidebar `sections` memo → groupAgentsByStage        — holdsWorkOf: AgentSidebar.stageLadder.test
//                                                              — crossRepoOf: HERE
//   • AgentSidebar `firstRenderedRowId` → firstLadderRowId     — both: HERE
//   • conciergeTools/sidebarView `columnView` → groupAgentsByStage — both: sidebarView.test
//
// SEEDING EMPTY STATE IS THE FAILURE MODE, NOT THE SETUP. Every fixture below puts the two rows in
// DISAGREEMENT — array order says one thing, the section split says the other — so an assertion
// that was already true before the accessor was threaded cannot pass.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
// The close path reaps a worktree and kills a PTY over the Tauri boundary, which does not exist
// under jsdom. Stubbed so the teardown's background reap is deterministic and never rejects into
// the test — the rows are already gone by then, and it is the SELECTION these tests read.
vi.mock("../services/worktree", () => ({ removeAgentWorkspace: vi.fn(() => Promise.resolve()) }));
vi.mock("../pty", () => ({ killPty: vi.fn(() => Promise.resolve()) }));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import {
  __clearRepoSlugCache,
  __setRepoSlugForTest,
} from "../services/conciergeTools/repoSlug";
import type { AgentTab, Project } from "../types";
import type { WorkflowStageId } from "../engine/workflowStage";

const ROOT = "/tmp/ladder-accessors";
const BOUND = "drodio/sparkle";
const OTHER_REPO = "drodio/drodio-website";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: "main", lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, ...over,
  } as AgentTab;
}

function seed(agents: AgentTab[], selectedAgentId: string | null = null): Project {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: ROOT, defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId, agents,
  };
  useProjectStore.setState({ projects: [project] } as never);
  return project;
}

const proj = () => useProjectStore.getState().projects[0]!;
const selectedNow = () => proj().selectedAgentId;

/** A worktree reading as Rust sends it. `worktreeOnBranch: true` is load-bearing on the DIRTY arm —
 *  a parked dirty tree reads `undefined` (attribution unknown) and would stay in
 *  `local_uncommitted` for the wrong reason. */
const bs = (dirty: boolean) => ({
  ahead: 0, behind: 0, dirty, filesChanged: dirty ? 1 : 0,
  insertions: dirty ? 1 : 0, deletions: 0, branch: "sparkle/agent-x",
  worktreeOnBranch: true, dirtyFiles: dirty ? ["src/x.ts"] : [], dirtyCount: dirty ? 1 : 0,
});

/** The victim of the ×: a build agent whose close is SILENT (clean tree, 0 ahead, a measured
 *  branch), so no Ship/Save/Discard modal stands between the click and `reselectAfterClose`. */
const closableBs = (id: string) => ({
  ahead: 0, behind: 0, dirty: false, filesChanged: 0, insertions: 0, deletions: 0,
  branch: `sparkle/agent-${id}`, worktreeOnBranch: true, dirtyFiles: [], dirtyCount: 0,
});

function setStages(stages: Record<string, WorkflowStageId>) {
  useRuntimeStore.setState({ workflowStage: stages } as never);
}

/** Row names in rendered DOM order — the thing the user actually sees. */
function renderedNames(names: string[]): string[] {
  return names
    .map((n) => ({ n, el: screen.queryByText(n) }))
    .filter((x): x is { n: string; el: HTMLElement } => x.el != null)
    .sort((a, b) =>
      a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    )
    .map((x) => x.n);
}

/** Click the × on the SELECTED row. The affordance is persistent on the active row only. */
function closeSelectedRow() {
  useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
  render(<AgentSidebar project={proj()} />);
  fireEvent.click(screen.getByLabelText("Close agent"));
}

beforeEach(() => {
  useRuntimeStore.setState({
    status: {}, workflowStage: {}, branchStatus: {},
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  useUiStore.getState().showAllStatusBands();
  __clearRepoSlugCache();
  __setRepoSlugForTest(ROOT, BOUND);
});
afterEach(() => cleanup());

// ── CALL SITE 1: the COLUMN — AgentSidebar's `sections` memo → groupAgentsByStage ────────────────
//
// `holdsWorkOf` at this call site is covered by AgentSidebar.stageLadder.test ("files a CLEAN
// pre-commit row under `local_none`…"). This block closes the OTHER accessor at the same call site:
// `crossRepoOf` was threaded through all three callers later, with the identical optional shape, and
// nothing rendered asserted it.
describe("call site 1 — the column passes `crossRepoOf` to groupAgentsByStage", () => {
  it("draws the CROSS-REPO row on ladder slot 0, above a row that is first in the array", () => {
    // ARRAY ORDER AND SECTION ORDER DISAGREE, deliberately: "Local" is seeded FIRST, so a column
    // that ignored this axis would draw it first. Only the accessor can invert them.
    const project = seed([
      mkAgent("a1", "Localwork"),
      mkAgent("a2", "Elsewhere", { assignmentRepos: [OTHER_REPO] }),
    ]);
    setStages({ a1: "building_unsaved", a2: "building_unsaved" });
    render(<AgentSidebar project={project} />);

    expect(screen.getByTestId("stage-header-tracked_elsewhere")).toBeTruthy();
    expect(renderedNames(["Localwork", "Elsewhere"])).toEqual(["Elsewhere", "Localwork"]);
    // The negative control: the sibling did NOT move, so this is the accessor routing ONE row
    // rather than the whole column shifting.
    expect(screen.getByTestId("stage-header-local_uncommitted")).toBeTruthy();
  });

  it("…and a fleet with no cross-repo assignment grows no such rung — the paired control", () => {
    // The other half of the pair. Same fixture, same stages; the ONLY difference is the assignment,
    // so the two together pin the assignment as the cause rather than something ambient.
    const project = seed([mkAgent("a1", "Localwork"), mkAgent("a2", "Alsolocal")]);
    setStages({ a1: "building_unsaved", a2: "building_unsaved" });
    render(<AgentSidebar project={project} />);

    expect(screen.queryByTestId("stage-header-tracked_elsewhere")).toBeNull();
    expect(renderedNames(["Localwork", "Alsolocal"])).toEqual(["Localwork", "Alsolocal"]);
  });
});

// ── CALL SITE 2: SELECTION — AgentSidebar's `firstRenderedRowId` → firstLadderRowId ──────────────
//
// THIS IS THE CALL SITE THE ORIGINAL FIX LEFT UNCOVERED, and the reason this bead exists.
// `ladderSelection.holdsWork.test.ts` drives the PURE FUNCTION with the accessor passed by hand —
// which proves the function reads it and says nothing at all about whether AgentSidebar hands it
// over. Deleting `headHoldsWorkFor` / `headCrossRepoFor` from `firstRenderedRowId` left that whole
// file green.
//
// The production entry point is `reselectAfterClose`: close the OPEN row and selection must land on
// the first row the column is actually drawing. That is the side effect; the accessor is the input.
describe("call site 2 — `firstRenderedRowId` passes both accessors to firstLadderRowId", () => {
  it("re-selects the CLEAN row after a close, because `local_none` sorts above `local_uncommitted`", () => {
    // Survivors are seeded DIRTY-FIRST on purpose: "Dirty" wins on array order, "Cleanly" wins only
    // on the section split. Without `holdsWorkOf` both rows read `undefined`, land in
    // `local_uncommitted` together, and selection falls to "Dirty".
    seed([mkAgent("v", "Victim"), mkAgent("a1", "Dirty"), mkAgent("a2", "Cleanly")], "v");
    setStages({ v: "building_unsaved", a1: "building_unsaved", a2: "building_unsaved" });
    useRuntimeStore.setState({
      branchStatus: { v: closableBs("v"), a1: bs(true), a2: bs(false) },
    } as never);

    closeSelectedRow();

    expect(useProjectStore.getState().projects[0]!.agents.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(selectedNow()).toBe("a2");
  });

  it("…and with BOTH survivors dirty it falls back to array order — the paired control", () => {
    // The control that pins the cause. Identical fixture but for `a2`'s worktree reading: with
    // nothing for the accessor to separate them by, the first row IS the array-order one. One test
    // proving a row is chosen is ambiguous; the pair says the worktree reading is what chose it.
    seed([mkAgent("v", "Victim"), mkAgent("a1", "Dirty"), mkAgent("a2", "Cleanly")], "v");
    setStages({ v: "building_unsaved", a1: "building_unsaved", a2: "building_unsaved" });
    useRuntimeStore.setState({
      branchStatus: { v: closableBs("v"), a1: bs(true), a2: bs(true) },
    } as never);

    closeSelectedRow();

    expect(selectedNow()).toBe("a1");
  });

  it("re-selects the CROSS-REPO row after a close, because `tracked_elsewhere` is ladder slot 0", () => {
    // Again in disagreement: "Localwork" is first in the array among the survivors. Without
    // `crossRepoOf` the cross-repo row is computed into `local_uncommitted` and selection lands on
    // "Localwork" — a row that is NOT the first one on screen, which is the whole failure
    // (roborev 67500).
    seed([
      mkAgent("v", "Victim"),
      mkAgent("a1", "Localwork"),
      mkAgent("a2", "Elsewhere", { assignmentRepos: [OTHER_REPO] }),
    ], "v");
    setStages({ v: "building_unsaved", a1: "building_unsaved", a2: "building_unsaved" });
    useRuntimeStore.setState({ branchStatus: { v: closableBs("v") } } as never);

    closeSelectedRow();

    expect(selectedNow()).toBe("a2");
  });

  it("…and an UNRESOLVED bound slug re-selects the array-order row — the fail-closed control", () => {
    // Same fixture, same assignment; only the bound slug is unknown, which `crossRepoAccessors`
    // treats as "cannot tell" and fails closed on. Nothing is cross-repo, so selection is array
    // order — proving the assignment (not the mere presence of the field) is what moved the row.
    __setRepoSlugForTest(ROOT, null);
    seed([
      mkAgent("v", "Victim"),
      mkAgent("a1", "Localwork"),
      mkAgent("a2", "Elsewhere", { assignmentRepos: [OTHER_REPO] }),
    ], "v");
    setStages({ v: "building_unsaved", a1: "building_unsaved", a2: "building_unsaved" });
    useRuntimeStore.setState({ branchStatus: { v: closableBs("v") } } as never);

    closeSelectedRow();

    expect(selectedNow()).toBe("a1");
  });
});
