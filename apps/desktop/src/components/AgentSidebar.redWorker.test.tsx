// @vitest-environment jsdom
//
// A worker that needs attention (waiting / approval / errored) — or an unstarted/stranded one — must
// never be lost now that workers no longer render as inline column lines. It bubbles its attention up
// to the orchestrator's head row (which floats up + goes red, noticed via the TopBar dot), and it
// stays reachable + clickable inside the orchestrator's detail card (opened by clicking the head).
// These tests pin that reachability for each attention status.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
vi.mock("../services/branchStatus", () => ({
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, AgentTabStatus, Project } from "../types";
import { expectedDotColor, filterOn } from "./statusDotTestUtils";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,    ...over,
  };
}

// Orchestrator a1 (name pinned so the head keeps "Alpha" to target) with one worker w1. When
// `hasStatus` is false the worker has NO live status entry — a strand (worktree cut, never mounted).
function seed(
  workerStatus: AgentTabStatus | null,
): { project: Project; open: ReturnType<typeof vi.fn> } {
  const orchestrator = mkAgent("a1", "Alpha", { namePinned: true });
  const worker = mkAgent("w1", "Fix The Parser", {
    kind: "worker", parentId: "a1", baseBranch: "main", worktreePath: "/wt/w1",
  });
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    agents: [orchestrator, worker],
  };
  useProjectStore.setState({ projects: [project] } as never);
  const open = vi.fn();
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: {},
    status: (workerStatus ? { w1: workerStatus } : {}) as Record<string, AgentTabStatus>,
    // A strand has the parent open but the worker NOT open.
    openAgentIds: workerStatus ? ["a1", "w1"] : ["a1"],
    open,
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return { project, open };
}

function openHeadCard() {
  const head = screen.getByText("Alpha").closest('[data-hint="agent"]') as HTMLElement;
  fireEvent.contextMenu(head);
}

beforeEach(() => {
  useUiStore.setState({ collapsedOrchestrators: {}, autoExpandedOrchestrators: {}, activeSpecial: null } as never);
});
afterEach(cleanup);

describe("AgentSidebar — attention workers stay reachable via the card", () => {
  it("a RED (errored) worker is reachable + clickable in the orchestrator's card", () => {
    const { project, open } = seed("errored");
    render(<AgentSidebar project={project} />);
    // Not in the collapsed column…
    expect(screen.queryByRole("button", { name: /Open Fix The Parser/i })).toBeNull();
    // …but present in the card, and clicking it opens that worker.
    openHeadCard();
    fireEvent.click(screen.getByRole("button", { name: /Open Fix The Parser/i }));
    expect(open).toHaveBeenCalledWith("w1");
  });

  it("a worker awaiting you (waiting) is reachable + clickable in the card", () => {
    const { project, open } = seed("waiting");
    render(<AgentSidebar project={project} />);
    openHeadCard();
    fireEvent.click(screen.getByRole("button", { name: /Open Fix The Parser/i }));
    expect(open).toHaveBeenCalledWith("w1");
    expect(useProjectStore.getState().projects[0]!.selectedAgentId).toBe("w1");
  });

  it("a healthy (working) worker is reachable in the card too", () => {
    const { project } = seed("working");
    render(<AgentSidebar project={project} />);
    openHeadCard();
    expect(screen.getByRole("button", { name: /Open Fix The Parser/i })).toBeTruthy();
  });

  it("an UNSTARTED/stranded worker (no live status) still shows in the card so it can be started", () => {
    const { project, open } = seed(null); // strand: worktree cut, parent open, worker never mounted
    render(<AgentSidebar project={project} />);
    openHeadCard();
    const line = screen.getByRole("button", { name: /Open Fix The Parser/i });
    expect(line).toBeTruthy();
    fireEvent.click(line);
    expect(open).toHaveBeenCalledWith("w1");
  });
});

// A head row's appearance must agree with the concierge feed, which applies the worker overlays
// (publishedStatusFor). Deriving it from the row's own un-overlaid status instead is roborev
// 46254-M4: an orchestrator listed under "Needs you" by the concierge while its own row rendered
// calm. The overlays are what carry a WORKER's red up to the head that owns it.
//
// This block used to test that agreement through the CALM treatment — `filter: grayscale(1)
// opacity(.72)` — because that filter was what the derivation drove. The filter is gone (see
// AgentSidebar.liveStatusDots.test.tsx: it made a working agent's green dot invisible), so
// asserting `filter === ""` now passes for every seed no matter what the derivation does. That is
// an inert test, not a guard.
//
// The agreement is therefore pinned where it actually lives now: the head's rendered DOT COLOR,
// which comes from `st` (= `effectiveStatus[a.id]`) at the AgentRow call site.
//
// Be precise about WHICH revert each case catches, because the overlays are layered and the names
// are easy to mix up (roborev 53676 caught an earlier version of this comment overclaiming):
//   • `liveStatus`      — the raw runtime map, NO overlays.
//   • `status`          — liveStatus + withUnstartedWorkerAttention + withRedWorkerAttention.
//                         The WORKER overlays are already in here.
//   • `effectiveStatus` — status + withUnmergedWork + withDismissedAlerts.
// Case by case, so this comment cannot drift into claiming coverage that is not here:
//   • "takes its worker's RED"      — catches a revert to `liveStatus` (goes gray). Not `status`.
//   • "goes red for an UNSTARTED"   — catches a revert to `liveStatus` (goes gray). Not `status`.
//   • "stays gray when … working"   — catches NEITHER. a1 has no status of its own, so the head
//                                     reads `stopped` under every map in the chain. It is the
//                                     contrast that stops "always red" from passing case 1, not a
//                                     guard against any revert.
//   • "reads a DISMISSED red …"     — the only seed where `status` and `effectiveStatus` disagree,
//                                     so the only one that catches `effectiveStatus → status`.
// Measured, not assumed: reverting to `liveStatus` fails 3 (the two above plus the dismissed case);
// reverting to `status` fails 1 (the dismissed case).
describe("AgentSidebar — a head row's color agrees with the concierge feed", () => {
  const headRow = () => screen.getByText("Alpha").closest('[data-hint="agent"]') as HTMLElement;
  /** The head row's own status disc (its children's discs live in their own rows). */
  const headDot = () => headRow().querySelector<HTMLElement>('span[title]');

  it("takes its worker's RED, rather than its own quiet status", () => {
    const { project } = seed("errored");
    render(<AgentSidebar project={project} />);
    // a1 has no status of its own — it reads `stopped`, which is GRAY. Red here can only have come
    // from the worker overlay, so this asserts the overlay chain end-to-end at the render site.
    expect(headDot()?.style.background).toBe(expectedDotColor("errored"));
    expect(headDot()?.style.background).not.toBe(expectedDotColor("stopped"));
    expect(filterOn(headRow())).toBe("");
  });

  it("goes GREEN, not red, when its worker is quietly working", () => {
    const { project } = seed("working");
    render(<AgentSidebar project={project} />);
    // CONTRAST CASE, not a guard — see the per-layer note above. Its job is to stop "always red"
    // from passing the case above: a working worker is not an ATTENTION signal and must not bubble
    // as one. That is what this test has always been for, and it still holds.
    expect(headDot()?.style.background).not.toBe(expectedDotColor("errored"));
    // What changed is the calm end. This used to assert GRAY, because a1 has no status of its own
    // and so reads `stopped`. The head's disc now rolls its workers up (engine/workerRollup): a
    // subtree is folded by default, so painting this row gray said "nothing happening here" about
    // an orchestrator with live work under it. Working workers → green.
    expect(headDot()?.style.background).toBe(expectedDotColor("working"));
    expect(filterOn(headRow())).toBe("");
  });

  it("goes red for an UNSTARTED worker (the feed calls a strand attention)", () => {
    const { project } = seed(null); // parent open, worker never mounted
    render(<AgentSidebar project={project} />);
    // withUnstartedWorkerAttention synthesizes the red; a stranded worker that signalled nothing is
    // the failure this overlay exists for.
    expect(headDot()?.style.background).toBe(expectedDotColor("errored"));
    expect(filterOn(headRow())).toBe("");
  });

  // The ONE seed where `status` and `effectiveStatus` differ, and so the only case that pins the
  // outermost overlay layer. a1 is genuinely `errored` and the user has DISMISSED that episode
  // (dismissedSeq === seq), so withDismissedAlerts de-escalates errored → stopped. Read the raw or
  // the merely worker-overlaid map and the row stays RED — i.e. a dismissal the user performed
  // would silently stop working, on the dot, the glyph and the tooltip alike.
  it("reads a DISMISSED red as de-escalated, not as red", () => {
    const orchestrator = mkAgent("a1", "Alpha", {
      namePinned: true,
      alert: { seq: 1, lastRed: "errored", dismissedSeq: 1 },
    });
    const project: Project = {
      id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
      createdAt: new Date(0).toISOString(), selectedAgentId: null,
      agents: [orchestrator],
    };
    useProjectStore.setState({ projects: [project] } as never);
    useRuntimeStore.setState({
      branchStatus: {}, workflowStage: {},
      status: { a1: "errored" } as Record<string, AgentTabStatus>,
      openAgentIds: ["a1"],
      open: vi.fn(),
      pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    render(<AgentSidebar project={project} />);

    expect(headDot()?.style.background).toBe(expectedDotColor("stopped"));
    expect(headDot()?.style.background).not.toBe(expectedDotColor("errored"));
  });
});
