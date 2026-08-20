// @vitest-environment jsdom
//
// A BORROWED RED IS DRAWN DIFFERENTLY FROM AN OWN RED.
//
// The founder, on a sidebar where nearly every row carried the red dot: *"Why are all these agents
// showing as red when they're not blocked by me? As a human."* Part of that wall is legitimate —
// an orchestrator whose worker sits at a permission prompt DOES need surfacing, and
// `engine/workerRollup` bubbling that red up is the feature. What was wrong is that the head was
// painted IDENTICALLY to a head blocked in its own right, so "answer this" and "something under
// here needs answering" could not be told apart without expanding the subtree.
//
// Same hue — it still has to draw the eye — different fill: own red is a FILLED disc, a rolled-up
// red is a RING. This pins both directions through the real sidebar, because the decision is made
// at the AgentRow call site (`dotRing={rollupOverrides && …}`) and a StatusDot-only test would not
// see whether the sidebar ever passes it — the defaulted-seam trap in AGENTS.md.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
vi.mock("../services/branchStatus", () => ({
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { AgentSidebar } from "./AgentSidebar";
import { CONCIERGE_AGENTS_HINT } from "./ConciergeAgentsRow";
import { SPARKLE_AGENT_ID } from "../services/sparkleAgent";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, AgentTabStatus, Project } from "../types";
import { asRgb } from "./statusDotTestUtils";
import { AGENT_STATUS } from "@sparkle/ui";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, ...over,
  };
}

/** Orchestrator "Alpha" with one worker, each given an explicit live status. */
function seed(headStatus: AgentTabStatus, workerStatus: AgentTabStatus): Project {
  const head = mkAgent("a1", "Alpha", { namePinned: true });
  const worker = mkAgent("w1", "Fix The Parser", {
    kind: "worker", parentId: "a1", baseBranch: "main", worktreePath: "/wt/w1", createdAt: 1,
  });
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    agents: [head, worker],
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: {},
    status: { a1: headStatus, w1: workerStatus } as Record<string, AgentTabStatus>,
    openAgentIds: ["a1", "w1"],
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

/** The head row's leading status disc. Located by shape (a full circle) rather than by title, so the
 *  assertion does not depend on which tooltip the rollup happens to choose. */
function headDot(): HTMLElement {
  const row = screen.getByText("Alpha").closest('[data-hint="agent"]') as HTMLElement;
  const dot = Array.from(row.querySelectorAll("span")).find(
    (el) => (el as HTMLElement).style.borderRadius === "50%",
  );
  if (!dot) throw new Error("no status disc found on the head row");
  return dot as HTMLElement;
}

const RED = asRgb(AGENT_STATUS.waiting.color);

beforeEach(() => {
  useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
});
afterEach(cleanup);

describe("AgentSidebar — an own red fills, a worker's red rings", () => {
  it("draws a RING on a calm head whose worker needs the human", () => {
    render(<AgentSidebar project={seed("idle", "waiting")} />);
    const dot = headDot();
    // Still red — the row must keep drawing the eye…
    // (jsdom normalizes `background` to rgb() but leaves `box-shadow`'s color as authored, so this
    // side is compared against the raw token while the fill cases below use asRgb.)
    expect(dot.style.boxShadow).toContain(AGENT_STATUS.waiting.color);
    expect(dot.style.boxShadow).toContain("inset");
    // …but hollow, so it reads as "something under here", not "answer me".
    expect(dot.style.background).toBe("transparent");
    // And the ring costs no layout: no border is used, so the disc's box is unchanged.
    expect(dot.style.borderWidth).toBe("");
  });

  it("draws a FILL when the head itself is the one blocked", () => {
    render(<AgentSidebar project={seed("waiting", "working")} />);
    const dot = headDot();
    expect(dot.style.background).toBe(RED);
    expect(dot.style.boxShadow).toBe("");
  });

  it("draws a FILL on a head that is blocked in its own right even while a worker is too", () => {
    // Own-red short-circuits the rollup before any worker is counted, so the bands agree, the
    // override never fires, and the head keeps its own filled disc. Pinned so a future change to
    // `rollupOverrides` cannot quietly turn a genuinely-blocked head into a ring — which would
    // under-state the one row that really is asking.
    render(<AgentSidebar project={seed("approval", "waiting")} />);
    const dot = headDot();
    expect(dot.style.background).toBe(asRgb(AGENT_STATUS.approval.color));
    expect(dot.style.boxShadow).toBe("");
  });

  it("leaves a fully calm subtree alone — no ring, no red", () => {
    render(<AgentSidebar project={seed("idle", "working")} />);
    const dot = headDot();
    expect(dot.style.boxShadow).toBe("");
    expect(dot.style.background).not.toBe(RED);
  });
});

// ── THE SAME RULE ON THE TWO PINNED ROWS (roborev 63208) ─────────────────────────────────────────
//
// `AgentSidebar` threads `dotRing` at THREE call sites — the ordinary head row above, plus
// `ConciergeAgentsRow` and `SparkleAgentRow`. Only the first had a test: the suite that owns the
// pinned rows (`AgentSidebar.sparkleRow.test.tsx`) never mentions `dotRing`, and this file rendered
// only the head row. The pinned rows sit at the bottom of the column PERMANENTLY, so a borrowed red
// drawn as an own red is more persistent there, not less — which is the whole reason those two sites
// were wired in the first place.
describe("AgentSidebar — the pinned rows ring too", () => {
  /** The Improve Sparkle agent with one worker of its own. Its own status stays calm, so the band
   *  the rollup lands in disagrees with the band of its own status and the override fires. */
  function seedSparkle(sparkleStatus: AgentTabStatus, workerStatus: AgentTabStatus): Project {
    const alpha = mkAgent("a1", "Alpha", { namePinned: true });
    const sparkleWorker = mkAgent("sw1", "Sparkle Worker", {
      kind: "worker", parentId: SPARKLE_AGENT_ID, baseBranch: "main",
      worktreePath: "/wt/sw1", createdAt: 1,
    });
    const project: Project = {
      id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
      createdAt: new Date(0).toISOString(), selectedAgentId: null,
      agents: [alpha, sparkleWorker],
    };
    useProjectStore.setState({ projects: [project] } as never);
    useRuntimeStore.setState({
      branchStatus: {}, workflowStage: {},
      status: {
        a1: "idle",
        [SPARKLE_AGENT_ID]: sparkleStatus,
        sw1: workerStatus,
      } as Record<string, AgentTabStatus>,
      openAgentIds: ["a1", SPARKLE_AGENT_ID, "sw1"],
      open: vi.fn(),
      pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    return project;
  }

  /** Located exactly like `headDot` — by shape, off the pinned row's own `data-hint`. */
  function pinnedDot(hint: string): HTMLElement {
    const row = document.querySelector(`[data-hint="${hint}"]`) as HTMLElement | null;
    if (!row) throw new Error(`no row with data-hint="${hint}"`);
    const dot = Array.from(row.querySelectorAll("span")).find(
      (el) => (el as HTMLElement).style.borderRadius === "50%",
    );
    if (!dot) throw new Error(`no status disc found on the ${hint} row`);
    return dot as HTMLElement;
  }

  it("draws a RING on Improve Sparkle when its own worker needs the human", () => {
    render(<AgentSidebar project={seedSparkle("idle", "waiting")} />);
    const dot = pinnedDot("improve");
    expect(dot.style.boxShadow).toContain(AGENT_STATUS.waiting.color);
    expect(dot.style.boxShadow).toContain("inset");
    expect(dot.style.background).toBe("transparent");
  });

  it("draws a FILL on Improve Sparkle when the row itself is the one blocked", () => {
    // Own-red short-circuits the rollup before any worker is counted, so the bands agree and the
    // override never fires — the same pairing the head row takes above. Without this, a `dotRing`
    // hardcoded to `true` would satisfy the ring case alone.
    render(<AgentSidebar project={seedSparkle("waiting", "working")} />);
    const dot = pinnedDot("improve");
    expect(dot.style.background).toBe(RED);
    expect(dot.style.boxShadow).toBe("");
  });

  // ⚠️ THE CONCIERGE ROW'S RING IS WIRED BUT NOT CURRENTLY REACHABLE, and saying so is the point.
  // `researchRollupStatuses` maps every LIVE task to `working` and drops the terminal ones — its
  // docstring states the consequence as a decision: *"the collapsed row is GREEN while anything is
  // live and GRAY otherwise, and it never goes red."* So `conciergeRollup` is never red or orange,
  // and the `dotRing={…}` expression at that call site is always `false` today.
  //
  // The wiring is kept rather than deleted because that same docstring designs for the extension —
  // *"if research ever grows a state that genuinely blocks the founder, add it here and the whole
  // rollup/band/chip chain follows for free"* — and "for free" is only true if the call site is
  // already threaded. What CAN be pinned is the half that would silently break: that the prop
  // reaches the disc's variant at all. That is asserted directly on the component, at the foot of
  // `ConciergeAgentsRow.test.tsx`; this row pins the reachable sidebar state, so a change
  // that starts painting the pinned row hollow on ordinary live work fails here.
  it("draws no ring on Concierge Agents while research is merely running", () => {
    render(<AgentSidebar project={seedSparkle("idle", "working")} />);
    const dot = pinnedDot(CONCIERGE_AGENTS_HINT);
    expect(dot.style.boxShadow).toBe("");
    expect(dot.style.background).not.toBe("transparent");
  });
});

// ── THE TERMINAL-GRAY RULE, AT THE RENDER SITE (the founder, 2026-08-19) ─────────────────────────
// *"Nothing should ever be gray unless it has been effectively finished. So that would be like a
// remote merge domain or shipped status."*
//
// ══ THE SUBJECTS ARE `done` / `stopped`, AND THAT IS MEASURED, NOT ASSUMED ═══════════════════════
// I probed all 15 (status × stage) cells against the base branch to find which ones this rule
// actually moves. It is exactly three, all at a pre-terminal stage:
//
//     done @ building_saved     GRAY → AMBER
//     stopped @ building_saved  GRAY → AMBER
//     new @ building_saved      GRAY → AMBER
//
// Every other cell is unchanged, because the PRE-EXISTING stall escalation already handles it:
// `idle` and `unmerged` at a pre-terminal stage were ALREADY amber via `unlanded-work` → LIFECYCLE.
// So this rule's whole incremental effect is the population the cause-driven path REFUSES —
// `withStallAttention` skips a dead process and only ever looks at `ESCALATABLE` (`idle`/`unmerged`).
//
// ⚠️ AN EARLIER VERSION OF THIS BLOCK USED `idle`/`unmerged` AND WAS VACUOUS. It passed with the
// call site reverted, because it was pinning that pre-existing escalation rather than this rule —
// the exact "assert the side effect, not the precondition" trap in AGENTS.md. The mutation check
// below is what caught it; the cases here are chosen so reverting `dotColor={dotFillFor(...)}` goes
// red.
function seedStage(
  headStatus: AgentTabStatus,
  stage: string | null,
): Project {
  const project = seed(headStatus, "idle");
  useRuntimeStore.setState({
    branchStatus: {},
    // `null` = this window has read NOTHING for the head — the cold-start / failed-poll case.
    // BOTH ROWS get the stage, because a head is BUCKETED by `headStageOf`, which rolls up its
    // least-advanced worker — an unread worker floors to the first rung and would drag the head into
    // a pre-terminal heading no matter what its own branch says. These cases are about a uniform
    // subtree; the split-stage disagreement gets its own fixture below.
    workflowStage: (stage === null ? {} : { a1: stage, w1: stage }) as never,
    status: { a1: headStatus, w1: "idle" } as Record<string, AgentTabStatus>,
    openAgentIds: [],
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

describe("AgentSidebar — gray is legal only in a terminal section", () => {
  it("paints a FINISHED head amber when its work is not on main yet", () => {
    // The founder's case, and the one the cause-driven path cannot reach: `done` is not in
    // `ESCALATABLE`, so nothing took it out of the calm tier before this rule.
    render(<AgentSidebar project={seedStage("done", "building_saved")} />);
    expect(headDot().style.background).toBe(asRgb(AGENT_STATUS.lapsed.color));
  });

  it("paints a STOPPED head amber too — a dead process still owes the work", () => {
    // `withStallAttention` refuses a dead process on purpose (it must never say a dead PTY "needs
    // you"). Amber makes the opposite claim — "unfinished, NOT yours" — so this population is
    // reachable here without reopening that refusal.
    render(<AgentSidebar project={seedStage("stopped", "building_saved")} />);
    expect(headDot().style.background).toBe(asRgb(AGENT_STATUS.lapsed.color));
  });

  it("leaves a finished head GRAY once its work is on main — the paired positive", () => {
    // Without this, "nothing is gray" would also pass for a rule that repainted unconditionally,
    // destroying the one state the founder said gray is FOR.
    render(<AgentSidebar project={seedStage("done", "merged")} />);
    expect(headDot().style.background).toBe(asRgb(AGENT_STATUS.idle.color));
  });

  it("EVIDENCE, NOT INFERENCE — an UNPOLLED head is not repainted", () => {
    // A head's ladder bucket comes from `resolveStage`, which FLOORS at the first rung, so reusing
    // it for paint would make every head look pre-terminal before its first branch-status poll and
    // paint the whole cold-start fleet amber out of ignorance. The paint section is read from the
    // raw readings for exactly that reason.
    render(<AgentSidebar project={seedStage("done", null)} />);
    expect(headDot().style.background).toBe(asRgb(AGENT_STATUS.idle.color));
  });

  // ── THE DISC MUST NOT CONTRADICT THE HEADING IT SITS UNDER ──────────────────────────────────
  // A head is BUCKETED by `headStageOf`, which rolls up its LEAST-ADVANCED WORKER and only falls
  // back to the head's own readings when it has none. Judging the paint by the head's own branch
  // instead produced two disagreements at once, and both are visible in one glance:
  //   * a delegating head whose OWN branch had merged painted calm gray under a pre-terminal
  //     heading — the rule under-firing on exactly the row the ladder calls unfinished;
  //   * and the louder mirror, a head bucketed under a terminal heading painting amber
  //     "Unfinished, not yours" directly beneath it.
  // Both are pinned here because the fix is to share ONE roll-up, and a single case would let the
  // other direction regress silently.
  function seedSplit(headStage: string, workerStage: string): Project {
    const project = seed("done", "done");
    useRuntimeStore.setState({
      branchStatus: {},
      workflowStage: { a1: headStage, w1: workerStage } as never,
      status: { a1: "done", w1: "done" } as Record<string, AgentTabStatus>,
      openAgentIds: [],
      open: vi.fn(),
      pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    return project;
  }

  it("a head whose OWN branch merged still paints amber while a worker lags", () => {
    // Bucket rolls up the worker → `local_committed`, a pre-terminal heading. Judged by the head's
    // own `merged` section it would have been gray-legal and stayed calm.
    render(<AgentSidebar project={seedSplit("merged", "building_saved")} />);
    expect(headDot().style.background).toBe(asRgb(AGENT_STATUS.lapsed.color));
  });

  it("a head that still owes its OWN work paints amber, even under a terminal heading", () => {
    // ⚠️ THIS CASE PREVIOUSLY ASSERTED GRAY, AND THAT WAS PINNING THE DEFECT. The BUCKET rule
    // (`headStageOf`) ignores a head's own readings once it has kids, so this row files under a
    // merged heading; wiring the paint to that rule made the disc agree — and agree WRONGLY, with
    // the column asserting "effectively finished" about a head holding unlanded local work. A
    // mutation check cannot catch that: the test had a perfect grip on an expectation nobody wanted
    // (the "a test can pin the defect" shape in AGENTS.md).
    //
    // The disc is judged by the least-advanced READ row among the head and its workers, so it
    // declines to call this finished. It may therefore disagree with the heading — deliberately, and
    // in the conservative direction: the disc only ever refuses to say "finished".
    render(<AgentSidebar project={seedSplit("building_saved", "merged")} />);
    expect(headDot().style.background).toBe(asRgb(AGENT_STATUS.lapsed.color));
  });

  it("an UNREAD worker does not drag a merged head into amber", () => {
    // The other half of the same helper. The bucket rule maps an unread worker through a
    // stage-resolver that FLOORS to the first rung, so one unpolled kid would drag the whole subtree
    // pre-terminal and paint a merged head amber out of pure ignorance — reachable for any
    // just-spawned worker, and PERMANENTLY for a child that is never polled at all. Unread rows are
    // skipped rather than floored.
    const project = seed("done", "done");
    useRuntimeStore.setState({
      branchStatus: {},
      workflowStage: { a1: "merged" } as never, // w1 deliberately absent
      status: { a1: "done", w1: "done" } as Record<string, AgentTabStatus>,
      openAgentIds: [],
      open: vi.fn(),
      pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    render(<AgentSidebar project={project} />);
    expect(headDot().style.background).toBe(asRgb(AGENT_STATUS.idle.color));
  });

  it("does not repaint a head that is asking for something", () => {
    // Blast radius: a red disc must survive, or the rule silently un-pages the founder.
    render(<AgentSidebar project={seedStage("waiting", "building_saved")} />);
    expect(headDot().style.background).toBe(RED);
  });
});
