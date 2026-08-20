// @vitest-environment jsdom
//
// A row's status dot must show its TRUE status color. No filter may sit over it.
//
// This file replaces AgentSidebar.calmBand.test.tsx, which pinned the opposite contract. That test
// existed because the sidebar rendered "calm" rows — everything not asking for you — with
// `filter: grayscale(1) opacity(.72)`, a treatment lifted from the concierge prototype
// (PRD/sparkle/concierge-mode/prototype.html `.arow.p2`). The intent was that only the P0/P1 rows
// carry color so the eye lands on what needs you.
//
// The cost was larger than the benefit. `isCalmBand` INCLUDED `working` at the time (a running
// agent is not asking you for anything), so a genuinely-working agent's GREEN dot rendered fully
// desaturated — and `sparkle-pulse` (opacity 1 → .35) compounded it to roughly a quarter opacity.
// On a fleet with live workers, that meant the one signal the column exists to carry, "what is
// actually running right now", was invisible. The filter was removed entirely rather than gated:
// a conditional would have left the same trap one `isCalmBand` edit away.
//
// So this file is the inverse pin. If a future change re-adds a filter over the rows, these fail
// and this comment says why they were written. `isCalmBand` itself still exists and is still
// correct for what it now governs — the TERMINAL's own xterm theme (Workspace.tsx), which
// desaturates an EXITED agent's text without ever touching the sidebar. It no longer includes
// `working` at all (bead sparkle-e7a3f3), so the specific collision above cannot recur — but the
// removal was never conditional on that, and re-adding a row filter is still wrong. Do not
// re-wire it here.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_STATUS } from "@sparkle/ui";
import { __setAuthRecoveryDeps, pollNudgeFlags } from "../services/authRecovery";

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
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, AgentTabStatus, Project } from "../types";
import type { WorkflowStageId } from "../engine/workflowStage";
import { dotInk, expectedDotColor, filterOn } from "./statusDotTestUtils";

function mkAgent(id: string, name: string): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,  } as AgentTab;
}

/** Three top-level agents spanning the three dot colors, so a single render covers every tier the
 *  old calm predicate split on:
 *    Unlanded — idle + committed work, which withUnmergedWork escalates to `unmerged` (GRAY, and
 *               the one status the calm predicate carved OUT of dimming).
 *    Finished — idle + already on main → `done` (GRAY; this row is the one the old test asserted
 *               WAS dimmed, so it is the direct regression case).
 *    Running  — `working` (GREEN). The whole point: the color must survive to the DOM.
 *  None is selected, so no row gets the active-row exemption the old filter had — the dots are
 *  read under exactly the conditions that used to gray them. */
function seed(): Project {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    agents: [mkAgent("a1", "Unlanded"), mkAgent("a2", "Finished"), mkAgent("a3", "Running")],
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    branchStatus: {},
    // `building_saved` is the committed-but-unlanded stage withUnmergedWork escalates on; `merged`
    // is past it.
    workflowStage: {
      a1: "building_saved", a2: "merged", a3: "merged",
    } as Record<string, WorkflowStageId>,
    status: { a1: "idle", a2: "idle", a3: "working" } as Record<string, AgentTabStatus>,
    openAgentIds: ["a1", "a2", "a3"],
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

/** The row element that used to carry the calm treatment, found from its visible name. */
function rowFor(name: string): HTMLElement {
  return screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;
}

beforeEach(() => {
  useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
});
afterEach(cleanup);

describe("AgentSidebar — no filter may sit over a row's status dot", () => {
  it("does not filter a genuinely finished row (the old treatment's main case)", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(filterOn(rowFor("Finished"))).toBe("");
  });

  it("does not filter a WORKING row — the case that made live state invisible", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(filterOn(rowFor("Running"))).toBe("");
  });

  it("does not filter a row whose work is committed but not landed", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(filterOn(rowFor("Unlanded"))).toBe("");
  });

  // The assertions above prove nothing is dimmed; this one proves the color actually ARRIVES. A row
  // could be unfiltered and still render a gray disc if the status plumbing were broken — which is
  // exactly the alternative root cause the removal had to rule out.
  it("paints the working dot the live GREEN, not a gray", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    const dot = screen.getByTitle(AGENT_STATUS.working.label);
    expect(dot.style.background).toBe(expectedDotColor("working"));
    // …and it is not the gray every other status in this seed resolves to.
    expect(dot.style.background).not.toBe(expectedDotColor("done"));
    expect(filterOn(dot)).toBe("");
  });
});

// ── THE DOT MUST REPAINT WHEN A NUDGER FLAG ARRIVES AFTER MOUNT (roborev 65461) ────────────────────
//
// The founder's report is about the DOT, and the dot comes from `AgentSidebar`'s `stallReportOf` /
// `escalatedStatus` memos and `AgentRow`'s own `stallReport` — not from the composer pill, which is
// the only surface the previous round's subscription test covered.
//
// The flag table lives outside React, so a silent agent's row can be on screen when `nudge_ladder`
// flips its reply to `blocked-on-human` with nothing else about that row changing. The subscription
// is then the ENTIRE mechanism by which the dot can go red — and none of it was pinned: swapping
// `useNudgeFlagSnapshot()` for a plain call, or dropping `nudgeFlags` from either hand-maintained
// dep array (one of which sits under an `eslint-disable` that suppresses the rule in both
// directions), left the whole suite green.
describe("a blocked-on-human flag arriving after mount turns the dot RED", () => {
  const founderFlag = (agentId: string, reply: string) => ({
    agentId,
    target: "founder",
    raisedAtMs: 1,
    nudges: 3,
    delivered: 3,
    blockedBy: null,
    silentSecs: 300,
    reply,
  });

  const raise = async (flags: ReturnType<typeof founderFlag>[]) => {
    await act(async () => {
      __setAuthRecoveryDeps({ readNudgeFlags: async () => flags } as never);
      await pollNudgeFlags();
    });
  };

  afterEach(async () => {
    await raise([]);
    __setAuthRecoveryDeps(null);
  });

  /** THE ROW'S DOT — the element, found the way this file's sibling `AgentSidebar.redWorker.test`
   *  finds it, then read through `dotInk`.
   *
   *  ⚠️ THE FIRST CUT HAND-ROLLED BOTH HALVES AND WAS WRONG THREE WAYS (roborev 65470), each of
   *  which `statusDotTestUtils` already existed to prevent — its charter names THIS FILE:
   *    • It scanned every descendant's `style` for the colour, so the `askPill`'s red BORDER (same
   *      prop, same hex) satisfied a test headed "turns the dot RED". A change stripping the disc's
   *      ink but leaving the pill would have stayed green.
   *    • It compared against `background` only, so the RING variant — a head standing in for a
   *      worker paints an inset `box-shadow` over a transparent background — reads as not-red. That
   *      is verbatim the trap `dotInk`'s docblock records ("adding the ring turned three green
   *      rollup guards red"), and an orchestrator case is the obvious next test here.
   *    • It re-implemented hex→rgb a third time, in the one file `asRgb`'s charter calls out.
   *  So: the shared helpers, not local copies. */
  const dotOfRow = (name: string) => rowFor(name).querySelector<HTMLElement>("span[title]");

  /** ONE plain resting agent, seeded here rather than reusing this file's shared `seed()`.
   *
   *  ⚠️ THE ROW HAS TO BE ESCALATABLE, which is why the shared fixture is wrong for this: its rows
   *  carry `building_saved`/`merged` stages, and `stallEscalation.ESCALATABLE` is `idle`/`unmerged`
   *  only — a `done` row is deliberately never repainted "needs you to unstick it". Reaching for the
   *  convenient fixture is what made the first two drafts of this test fail. */
  function seedResting(): Project {
    const project: Project = {
      id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
      createdAt: new Date(0).toISOString(), selectedAgentId: null,
      agents: [mkAgent("a1", "Quiet")],
    };
    useProjectStore.setState({ projects: [project] } as never);
    useRuntimeStore.setState({
      branchStatus: {},
      workflowStage: {},
      status: { a1: "idle" } as Record<string, AgentTabStatus>,
      openAgentIds: ["a1"],
      open: vi.fn(),
      pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    return project;
  }

  it("repaints on the SAME mount, with no store write and no forced re-render", async () => {
    const project = seedResting();
    await raise([]);
    render(<AgentSidebar project={project} />);
    // Nothing on screen is claiming a person is blocked.
    expect(dotInk(dotOfRow("Quiet")!)).not.toBe(expectedDotColor("blocked"));

    // The agent answers the ladder. No store write; nothing else about the row moves.
    await raise([founderFlag("a1", "blocked-on-human")]);

    expect(dotInk(dotOfRow("Quiet")!)).toBe(expectedDotColor("blocked"));
    // …and the row says WHY, so the colour does not arrive unexplained. The founder's row had the
    // words without the colour; the inverse would be just as wrong.
    expect(screen.getByTitle(/blocked on you/)).toBeTruthy();
  });

  it("a reply naming a DIFFERENT blocker leaves the dot alone", async () => {
    // THE PAIRED NEGATIVE. Identical mount, identical flag shape — only the reply differs, so a
    // change that reddened every flagged row (or every row) fails here.
    const project = seedResting();
    await raise([]);
    render(<AgentSidebar project={project} />);
    await raise([founderFlag("a1", "blocked-on-ci")]);
    expect(dotInk(dotOfRow("Quiet")!)).not.toBe(expectedDotColor("blocked"));
  });
});
