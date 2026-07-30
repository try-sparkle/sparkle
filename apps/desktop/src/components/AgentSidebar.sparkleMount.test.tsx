// @vitest-environment jsdom
//
// CLICKING "IMPROVE SPARKLE" MOUNTS THE CONCIERGE TO IT — like any other build row.
//
// Founder, 2026-07-29: "I also want this same mounting functionality to work for the improve sparkle
// agent at the bottom of the build column. It should work the same way."
//
// It did not. `onSelectSparkle` seated the pane (`setActiveSpecial("sparkle")` + `open(id)`) and
// deliberately never patched the cable, which was defensible while the pane carried its own composer
// — there was another way to talk to the agent. That composer is gone (SparkleAgentPane), so a click
// that seats the pane without patching leaves the agent with no input surface but its raw terminal.
//
// Every case here CLICKS THE REAL ROW the real sidebar rendered and then reads the store, never
// calling `patch` itself. That distinction is the whole reason the sibling suite exists: a test that
// drives the store proves the store works and says nothing about whether a user can get there
// (roborev 55221).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { resetCable, useCableStore } from "../stores/cableStore";
import { sparkleAgentIdFor } from "../services/sparkleAgent";
import { APP_WINDOW_LABEL } from "../windowContext";
import type { AgentTab, Project } from "../types";

/** The id this window's row seats — derived, not spelled, so the assertion tracks the real key. */
const SPARKLE_ID = sparkleAgentIdFor(APP_WINDOW_LABEL);

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
  agents: [mkAgent("a1", "Stripe checkout retry")],
};

/** The Improve Sparkle row itself — found by its label, the way a user finds it. (`data-hint` is
 *  `improve` rather than `agent`: the hint tour names this row separately. Same handle
 *  AgentSidebar.sparkleRow.test.tsx uses.) */
const sparkleRow = () =>
  screen.getByText("Improve Sparkle").closest('[data-hint="improve"]') as HTMLElement;

beforeEach(() => {
  useProjectStore.setState({ projects: [PROJECT], selectedProjectId: "p1" } as never);
  useRuntimeStore.setState({ openAgentIds: ["a1"], status: {} } as never);
  useUiStore.setState({
    activeSpecial: null,
    collapsedOrchestrators: {},
    autoExpandedOrchestrators: {},
    pairAssignment: {},
    leftProjectId: null,
  } as never);
  resetCable();
});
afterEach(() => {
  cleanup();
  resetCable();
});

describe("clicking the Improve Sparkle row patches the cable", () => {
  it("is unwired until the row is clicked", () => {
    render(<AgentSidebar project={PROJECT} />);
    expect(sparkleRow()).toBeTruthy(); // the row is really on screen — not a false negative below
    expect(useCableStore.getState().wired).toBe("off");
  });

  it("patches to the RIGHT for a right-assigned project", () => {
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      fireEvent.click(sparkleRow());
    });
    expect(useCableStore.getState().wired).toBe("right");
  });

  it("patches to the LEFT when this sidebar's project lives in the left pair", () => {
    // The side is the SIDEBAR'S OWN pair, exactly as for a build row — so the cable lands on the
    // side whose pane the click just revealed, and cannot disagree with it.
    useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      fireEvent.click(sparkleRow());
    });
    expect(useCableStore.getState().wired).toBe("left");
  });

  it("MOVES a cable already patched to the other side rather than lighting both", () => {
    // ONE LIVE CIRCUIT, from patchCable's own reducer. This row must not be the exception that
    // leaves two pairs looking connected at once.
    useCableStore.getState().patch("left");
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      fireEvent.click(sparkleRow());
    });
    expect(useCableStore.getState().wired).toBe("right");
  });

  it("docks a floating concierge, so wired and floating cannot both be true", () => {
    // A floating concierge sits on top of the very row it claims to be wired to. Asserted through
    // the GESTURE, so the guarantee is the user's rather than the store's.
    useCableStore.getState().overlayTo("assist");
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      fireEvent.click(sparkleRow());
    });
    expect(useCableStore.getState().overlay).toBe("off");
    expect(useCableStore.getState().wired).toBe("right");
  });

  it("still does everything the click already did — seats the pane and opens the agent", () => {
    // The patch is an ADDITION. If wiring came at the cost of revealing the pane, the founder's
    // click would light a cable into a pane they can't see.
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      fireEvent.click(sparkleRow());
    });
    expect(useUiStore.getState().activeSpecial).toBe("sparkle");
    expect(useRuntimeStore.getState().openAgentIds).toContain(SPARKLE_ID);
  });

  it("does not write the Sparkle id into the project's selection", () => {
    // Why this row calls `patchCable` directly instead of reusing `selectAndWire`: that helper also
    // runs `selectAgent(project.id, id)`, and this id is not one of the project's agents. Writing it
    // there would leave the project pointing at an agent it does not contain.
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      fireEvent.click(sparkleRow());
    });
    const p = useProjectStore.getState().projects.find((x) => x.id === "p1")!;
    expect(p.selectedAgentId).toBe("a1");
  });

  // ── HOVER IS NOT A DELIBERATE ACT, HERE EITHER ──────────────────────────────────────────────
  //
  // Build rows learned this the expensive way: `onSelect` also fires from a 90ms hover-intent timer,
  // and hanging the patch on it meant a cursor merely RESTING over a row re-routed the user's next
  // prompt across pairs (roborev 55234). This row has no hover-select path today; the case pins that,
  // so adding one later cannot quietly acquire the patch.
  //
  // `mouseOver` because it is the event REACT ACTUALLY LISTENS FOR — React runs onMouseEnter off
  // delegated mouseover/mouseout (EnterLeaveEventPlugin), so firing it says the intent directly
  // instead of relying on a shim. `fireEvent.mouseEnter` would ALSO work here, and it is worth being
  // precise about why, because the opposite was asserted twice on this branch and is false:
  // @testing-library/react patches the DOM helper for exactly this case —
  // `dist/fire-event.js:21-26` reassigns `fireEvent.mouseEnter = (...a) => { mouseEnter(...a);
  // return fireEvent.mouseOver(...a) }` — so it delivers a `mouseover` to the delegated root
  // listener and a hover handler DOES fire. Verified by mutation: with `onMouseEnter={onSelect}` on
  // the row, the earlier `mouseEnter` form of this case went red too. So do NOT "fix" the sibling
  // case in Workspace.conciergeMount.test.tsx on the theory that `mouseEnter` reaches nothing; it
  // reaches React fine.
  //
  // What the earlier form genuinely lacked is the POSITIVE CONTROL: a click after the dwell that
  // must flip the cable. Without it, "nothing happened" is indistinguishable from "the harness never
  // delivered anything" — and that ambiguity, not a dead event, is what made the case worth
  // hardening. (roborev 55564 raised the vacuity; 55592 corrected its mechanism.)
  it("does NOT patch on hover, however long the cursor rests — but a click still does", () => {
    vi.useFakeTimers();
    try {
      render(<AgentSidebar project={PROJECT} />);
      act(() => {
        fireEvent.mouseOver(sparkleRow());
        vi.advanceTimersByTime(1000);
      });
      expect(useCableStore.getState().wired).toBe("off");

      // Positive control: the row IS reachable and the store IS writable from this harness.
      act(() => {
        fireEvent.click(sparkleRow());
      });
      expect(useCableStore.getState().wired).toBe("right");
    } finally {
      vi.useRealTimers();
    }
  });
});
