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
