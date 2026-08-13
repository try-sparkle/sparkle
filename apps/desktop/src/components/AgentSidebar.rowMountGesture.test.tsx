// @vitest-environment jsdom
//
// SINGLE CLICK SELECTS. DOUBLE CLICK MOUNTS. The founder's rule, asserted through the real rows.
//
// Verbatim, 2026-08-12: *"I had also asked for a single click to not mount the concierge. And to for
// a double click to be what mounts it."* Until this landed, one click patched the cable — so the
// press you make to READ what an agent is doing also dropped you into a pane you never asked for.
//
// ══ WHY THIS FILE EXISTS BESIDE `cable.rowActivation.test.ts` ═══════════════════════════════════
// That file pins the RULE as a pure table. It cannot tell you whether the row is wired to it, or
// which of the three events a real double press raises actually reaches the mount — and that gap is
// the exact shape of this feature's worst historical bug: every consumer of `wired` was correct and
// NOTHING in app code called `patch`, so the whole connection feature was dead in shipped builds
// while its unit tests passed (roborev 55221). So these CLICK ROWS and read the cable store.
//
// ══ WHAT IS ASSERTED IS THE SIDE EFFECT ════════════════════════════════════════════════════════
// `useCableStore.getState().wired` and the recorded pane-focus request — not that a handler exists,
// and not that a prop was passed. Every case below fails against the code as it was before this
// change: a single click patched then, and there was no `onDoubleClick` on the row at all.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
import { resetPaneFocus, usePaneFocusStore } from "../stores/paneFocusStore";
import { doubleClickRow, singleClickRow } from "../testing/rowGestures";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string, name: string): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}

const OTHER = "Concierge column layout";
const SELECTED = "Stripe checkout retry";

const PROJECT: Project = {
  id: "p1",
  name: "Alpha",
  rootPath: "/tmp/p1",
  defaultBranch: null,
  createdAt: new Date(0).toISOString(),
  selectedAgentId: "a1",
  agents: [mkAgent("a1", SELECTED), mkAgent("a2", OTHER)],
};

const rowFor = (name: string) =>
  screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;

const wired = () => useCableStore.getState().wired;

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
  resetPaneFocus();
});
afterEach(() => {
  cleanup();
  resetCable();
  resetPaneFocus();
});

describe("a single click on a build row", () => {
  it("does NOT patch the cable — the founder's whole ask", () => {
    render(<AgentSidebar project={PROJECT} />);
    singleClickRow(rowFor(OTHER));
    expect(wired()).toBe("off");
  });

  it("does not patch it a second, third or fourth time either", () => {
    // Deliberately slow, separated presses — the gesture of someone reading down the column. Each is
    // its own `detail: 1` click, which is precisely what a browser sends when the presses are far
    // enough apart to NOT be a double click. Repetition must not accumulate into a mount.
    render(<AgentSidebar project={PROJECT} />);
    for (let i = 0; i < 4; i++) singleClickRow(rowFor(OTHER));
    expect(wired()).toBe("off");
  });

  it("does NOT drop a cable already patched to this pair", () => {
    // The row is inside the live circuit, so a press on it is not a "you have left" gesture. Making
    // single-click stop patching must not turn it into an UNPATCH — the founder asked for one thing
    // to stop happening, not for the opposite thing to start.
    render(<AgentSidebar project={PROJECT} />);
    useCableStore.getState().patch("right");
    singleClickRow(rowFor(OTHER));
    expect(wired()).toBe("right");
  });

  it("still SELECTS the row", () => {
    // The half of the gesture that must survive: not mounting is not the same as doing nothing.
    render(<AgentSidebar project={PROJECT} />);
    singleClickRow(rowFor(OTHER));
    const p = useProjectStore.getState().projects.find((x) => x.id === "p1");
    expect(p?.selectedAgentId).toBe("a2");
  });

  it("moves the caret to THAT agent's terminal", () => {
    // The second half of the founder's sentence. Asserted as the request the pane consumes, because
    // the terminal handle lives in AgentPane — `AgentPane.focusRequest.test.tsx` closes the chain by
    // proving the pane actually focuses its terminal when one of these lands.
    render(<AgentSidebar project={PROJECT} />);
    expect(usePaneFocusStore.getState().requests["a2"]).toBeUndefined();
    singleClickRow(rowFor(OTHER));
    expect(usePaneFocusStore.getState().requests["a2"]).toBeDefined();
    // …and only that agent's. A click on one row must not yank the caret into a different terminal.
    expect(usePaneFocusStore.getState().requests["a1"]).toBeUndefined();
  });

  it("asks AGAIN on a second click of the same row", () => {
    // A latch would swallow this. The pane consumes each request, so a user who clicks back to the
    // row they are working in gets the caret back rather than nothing.
    render(<AgentSidebar project={PROJECT} />);
    singleClickRow(rowFor(OTHER));
    const first = usePaneFocusStore.getState().requests["a2"];
    usePaneFocusStore.getState().consume("a2");
    singleClickRow(rowFor(OTHER));
    expect(usePaneFocusStore.getState().requests["a2"]).toBeDefined();
    expect(usePaneFocusStore.getState().requests["a2"]).not.toBe(first);
  });
});

describe("a double click on a build row", () => {
  it("mounts the concierge onto it", () => {
    render(<AgentSidebar project={PROJECT} />);
    doubleClickRow(rowFor(OTHER));
    expect(wired()).toBe("right");
  });

  it("mounts to the LEFT when this sidebar's project lives in the left pair", () => {
    // The side is the SIDEBAR'S OWN pair, exactly as it was when a single click patched — the
    // gesture changed, the side rule did not.
    useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
    render(<AgentSidebar project={PROJECT} />);
    doubleClickRow(rowFor(OTHER));
    expect(wired()).toBe("left");
  });

  it("mounts EXACTLY ONCE across the whole click/click/dblclick sequence", () => {
    // THE THING THAT IS EASY TO GET WRONG: a double click is not one event, it is three, and two of
    // them are ordinary clicks. So "exactly once" has to be COUNTED, and the count cannot come from
    // `wired` or from a store subscription: `patchCable` returns the SAME OBJECT for a repeat patch,
    // so zustand skips its listeners and a second mount is invisible in both. Wrapping the store's
    // own `patch` action is what makes a duplicate observable at all — and it is the action the row's
    // whole mount path (`onMount → selectAndWire → patchCable`) funnels through.
    const patched: string[] = [];
    const real = useCableStore.getState().patch;
    useCableStore.setState({
      patch: (side) => {
        patched.push(side);
        real(side);
      },
    });
    try {
      render(<AgentSidebar project={PROJECT} />);
      doubleClickRow(rowFor(OTHER));
      expect(patched).toEqual(["right"]);
      expect(wired()).toBe("right");
    } finally {
      useCableStore.setState({ patch: real });
    }
  });

  it("the two clicks BEFORE the dblclick patch nothing at all", () => {
    // The other half of "exactly once", and the one that pins WHICH event carries the mount: if the
    // count above were satisfied by a click rather than by the dblclick, this fails. Same wrapper,
    // stopped one event short of the gesture.
    const patched: string[] = [];
    const real = useCableStore.getState().patch;
    useCableStore.setState({
      patch: (side) => {
        patched.push(side);
        real(side);
      },
    });
    try {
      render(<AgentSidebar project={PROJECT} />);
      const row = rowFor(OTHER);
      fireEvent.click(row, { detail: 1 });
      fireEvent.click(row, { detail: 2 });
      expect(patched).toEqual([]);
      expect(wired()).toBe("off");
      // …and the dblclick that completes the gesture is the one that patches.
      fireEvent.doubleClick(row, { detail: 2 });
      expect(patched).toEqual(["right"]);
    } finally {
      useCableStore.setState({ patch: real });
    }
  });

  it("mounts a row that was ALREADY selected", () => {
    // The realistic sequence: click once to read the agent, then double click to talk to it. The
    // second gesture lands on a row that is already seated, which is also the row whose subtree the
    // fold rule cares about — so this is the case where the two rules meet.
    render(<AgentSidebar project={PROJECT} />);
    singleClickRow(rowFor(SELECTED));
    expect(wired()).toBe("off");
    doubleClickRow(rowFor(SELECTED));
    expect(wired()).toBe("right");
  });
});

describe("the activations that have no double form still mount", () => {
  it("Enter on the focused row", () => {
    // The keyboard's deliberate activation. Removing its mount would leave keyboard-only users with
    // no path to the cable at all.
    render(<AgentSidebar project={PROJECT} />);
    fireEvent.keyDown(rowFor(OTHER), { key: "Enter" });
    expect(wired()).toBe("right");
  });

  it("Space on the focused row", () => {
    render(<AgentSidebar project={PROJECT} />);
    fireEvent.keyDown(rowFor(OTHER), { key: " " });
    expect(wired()).toBe("right");
  });

  it("a click with no pointer sequence behind it — assistive tech, and the keyboard jump", () => {
    // `detail: 0` is what an AXPress and HintOverlay's synthetic jump dispatch. Neither can raise a
    // `dblclick`, so this is their only route to a mount — and the jump mounted before this change.
    render(<AgentSidebar project={PROJECT} />);
    fireEvent.click(rowFor(OTHER), { detail: 0 });
    expect(wired()).toBe("right");
  });
});
