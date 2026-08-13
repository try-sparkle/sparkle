// @vitest-environment jsdom
//
// SELECTING A BUILD ROW PATCHES THE CABLE — the gesture the whole connection feature hangs off.
//
// Everything downstream of `wired` was built and correct long before this: the concierge's flood and
// lift, the shell root's `data-wired`, the seam that vanishes at the wired pair, and `promptTarget`
// routing to that pair's selected agent. None of it could ever fire, because NOTHING IN APP CODE
// CALLED `patch`. The only producers were the test suite and a DEV-only capture handle, so in a
// shipped build `wired` was permanently "off" and the two `workspace-wired-*` visual surfaces were
// capturing a state no user could reach (roborev 55221).
//
// These CLICK A ROW rather than calling `patch` directly, which is the entire point: a test that
// drives the store proves the store works and says nothing about whether a user can get there. That
// distinction is what let the break survive — `ConciergeColumn.wired.test.tsx` asserted the flood in
// full, supplying the prop itself, and passed the whole time the feature was dead.
//
// ══ THE GESTURE IS A DOUBLE CLICK SINCE 2026-08-12 ══════════════════════════════════════════════
// Founder: *"I had also asked for a single click to not mount the concierge. And to for a double
// click to be what mounts it."* Every mount below therefore goes through `doubleClickRow`, which
// fires the click/click/dblclick sequence a browser actually delivers. That the SINGLE click no
// longer patches — and what it does instead — is `AgentSidebar.rowMountGesture.test.tsx`; the cases
// here are about which SIDE the cable lands on and what it displaces, which the new gesture did not
// change. `fireEvent.click` would still have passed them, and that is the trap: its default
// `detail: 0` is an assistive-tech activation, not a mouse press, so this file would have gone on
// describing a path no user takes (testing/rowGestures spells out both).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { resetCable, useCableStore } from "../stores/cableStore";
import { doubleClickRow } from "../testing/rowGestures";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string, name: string): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}

const PROJECT: Project = {
  id: "p1",
  name: "Alpha",
  rootPath: "/tmp/p1",
  defaultBranch: null,
  createdAt: new Date(0).toISOString(),
  selectedAgentId: "a1",
  agents: [mkAgent("a1", "Stripe checkout retry"), mkAgent("a2", "Concierge column layout")],
};

const rowFor = (name: string) =>
  screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;

beforeEach(() => {
  useProjectStore.setState({ projects: [PROJECT], selectedProjectId: "p1" } as never);
  useRuntimeStore.setState({ openAgentIds: ["a1", "a2"], status: {} } as never);
  useUiStore.setState({
    activeSpecial: null,
    collapsedOrchestrators: {},
    pairAssignment: {},
    leftProjectId: null,
  } as never);
  resetCable();
});
afterEach(() => {
  cleanup();
  resetCable();
});

describe("selecting a build row patches the cable", () => {
  it("is unwired until a row is clicked", () => {
    render(<AgentSidebar project={PROJECT} />);
    expect(useCableStore.getState().wired).toBe("off");
  });

  it("patches to the RIGHT for a right-assigned project", () => {
    // Absent from the assignment map means right — the historical single-pair home, and what every
    // pre-existing project reads as.
    render(<AgentSidebar project={PROJECT} />);
    doubleClickRow(rowFor("Concierge column layout"));
    expect(useCableStore.getState().wired).toBe("right");
  });

  it("patches to the LEFT when this sidebar's project lives in the left pair", () => {
    // The side is the SIDEBAR'S OWN pair, read from the assignment map — not a prop and not a
    // guess, so it cannot disagree with the stage its panes are mounted in.
    useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
    render(<AgentSidebar project={PROJECT} />);
    doubleClickRow(rowFor("Concierge column layout"));
    expect(useCableStore.getState().wired).toBe("left");
  });

  it("MOVES the cable rather than lighting both sides", () => {
    // ONE LIVE CIRCUIT. This falls out of `patchCable`'s reducer rather than being re-imposed here,
    // which is why patching the other side is a move and never an addition.
    render(<AgentSidebar project={PROJECT} />);
    doubleClickRow(rowFor("Concierge column layout"));
    expect(useCableStore.getState().wired).toBe("right");
    useUiStore.setState({ pairAssignment: { p1: "left" } } as never);
    cleanup();
    render(<AgentSidebar project={PROJECT} />);
    doubleClickRow(rowFor("Stripe checkout retry"));
    expect(useCableStore.getState().wired).toBe("left");
  });

  // ── HOVER IS NOT A DELIBERATE ACT ───────────────────────────────────────────────────────────
  //
  // `onSelect` is BOTH paths: `armSelect` fires it from a 90ms setTimeout on plain mouseenter, with
  // no click anywhere. Hanging the patch on it meant a cursor merely RESTING over a row re-wired
  // the cable (roborev 55234) — which defeated the unbind gestures, and, far worse, re-routed
  // `promptTarget` across pairs so Send delivered to a terminal the user never plugged into.
  //
  // Selection may follow the mouse. The cable may not.
  it("does NOT patch on hover-intent, however long the cursor rests", () => {
    vi.useFakeTimers();
    try {
      render(<AgentSidebar project={PROJECT} />);
      fireEvent.mouseEnter(rowFor("Concierge column layout"));
      // Well past the 90ms dwell — the hover-commit has definitely fired.
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(useCableStore.getState().wired).toBe("off");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hovering does not STEAL a cable already patched to the other side", () => {
    // The prompt-routing case, which is the one that costs a user their message: patched left,
    // cursor transits the right column, Send must still go left.
    useCableStore.getState().patch("left", null);
    vi.useFakeTimers();
    try {
      render(<AgentSidebar project={PROJECT} />);
      fireEvent.mouseEnter(rowFor("Stripe checkout retry"));
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(useCableStore.getState().wired).toBe("left");
    } finally {
      vi.useRealTimers();
    }
  });

  it("wires the agent it just SPAWNED", () => {
    // Creating an agent is the strongest "talk to this one" there is — and it was the path that
    // left the cable off. In the far pair it actively DROPPED it: the shell's pointerdown capture
    // reads the "+ New Build Agent" row as outside the circuit and unbinds, so the next prompt went
    // to Sparkle instead of the agent the user had just asked for. (roborev 55234)
    render(<AgentSidebar project={PROJECT} />);
    expect(useCableStore.getState().wired).toBe("off");
    fireEvent.click(screen.getByText("+ Local Agent"));
    expect(useCableStore.getState().wired).toBe("right");
  });

  // ── THE BUILD CHEVRON ───────────────────────────────────────────────────────────────────────
  //
  // Switching INTO Build puts a build agent in front of you, which is the same act as clicking its
  // row — so it wires. But it is also the one caller that passes NULL: a pair with no build rows
  // clears the selection instead. Both directions live here because the second was the regression.
  const clickBuildChevron = () => fireEvent.click(screen.getByTitle(/^Build mode/));

  it("wires when the Build chevron seats a row", () => {
    // Parked on Sparkle, so this is a real switch INTO Build rather than the second-click spawn.
    useUiStore.setState({ activeSpecial: "sparkle" } as never);
    render(<AgentSidebar project={PROJECT} />);
    clickBuildChevron();
    expect(useCableStore.getState().wired).toBe("right");
  });

  it("does NOT patch when the chevron seats NOTHING — and cannot steal the other pair's cable", () => {
    // `firstRenderedRowId ?? firstVisibleAgentId` is null when the pair has no build agents at all,
    // and `onPickBuild` passes that null through deliberately (→ the empty Build state). Patching
    // on it wires a circuit with no agent on the far end: `promptTarget` derives from the selected
    // agent, so it falls back to Sparkle — and here it would ALSO drop a cable already seated on a
    // real agent in the other pair, sending the user's next message somewhere they never plugged in.
    const EMPTY: Project = { ...PROJECT, agents: [], selectedAgentId: null };
    useProjectStore.setState({ projects: [EMPTY], selectedProjectId: "p1" } as never);
    useRuntimeStore.setState({ openAgentIds: [], status: {} } as never);
    useUiStore.setState({ activeSpecial: "sparkle" } as never);
    useCableStore.getState().patch("left", null);
    render(<AgentSidebar project={EMPTY} />);
    clickBuildChevron();
    expect(useCableStore.getState().wired).toBe("left");
  });

  it("docks a floating concierge, so wired and floating cannot both be true", () => {
    // Also `patchCable`'s own invariant: a floating concierge sits on top of the very row it claims
    // to be wired to. Asserted through the GESTURE so the guarantee is the user's, not the store's.
    useCableStore.getState().overlayTo("assist");
    render(<AgentSidebar project={PROJECT} />);
    doubleClickRow(rowFor("Concierge column layout"));
    expect(useCableStore.getState().overlay).toBe("off");
    expect(useCableStore.getState().wired).toBe("right");
  });
});
