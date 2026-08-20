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
    useCableStore.getState().patch("left", null);
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

// ══ THE ROW'S ACTIVATIONS: REACHABLE FROM EVERYTHING, AND EVERY ONE OF THEM MOUNTS ══════════════
// (bead sparkle-gyvjyt.) The founder, on v0.114.0: *"I am able to double click to mount regular
// build agents and write to them so those are working OK. It's only the Improve-Sparkle one that's
// not working."*
//
// The cases ABOVE all use `fireEvent.click`, which jsdom dispatches with `detail: 0`. That is the
// assistive-tech / HintOverlay arm, so those cases could never see the two things actually wrong
// with this row: it had no `role`, no `tabIndex`, no `onKeyDown` and no `onDoubleClick`, which made
// it operable by POINTER ONLY — on the one row where that costs the whole feature, since
// SparkleAgentPane has no composer and the cable is this agent's only input surface.
//
// ══ AND THE HALF THAT IS *NOT* PARITY, WHICH REVIEW CAUGHT BEFORE IT LANDED ══════════════════════
// The first cut routed the click through the shared `mountsOnRowActivation` predicate, whose rule is
// "a plain single press SELECTS and does not patch". That is safe for a build row and re-opens the
// silent misroute here: the cable pin, not the visible pane, is what routing reads, so a pane-seated
// single press would leave the founder looking at Improve Sparkle while his words went to whatever
// the cable was still pinned to. `pins the cable to THIS row even when it was already patched
// elsewhere` below is that exact scenario, and it is the case the old suite never had.
describe("the Improve Sparkle row is reachable from every activation, and each one mounts", () => {
  it("is OPERABLE — role, tab stop and all, which is what makes the keyboard cases below reachable", () => {
    render(<AgentSidebar project={PROJECT} />);
    expect(sparkleRow().getAttribute("role")).toBe("button");
    expect(sparkleRow().getAttribute("tabindex")).toBe("0");
  });

  it("a plain SINGLE press seats the pane AND patches — this row does not do seat-without-patch", () => {
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      fireEvent.click(sparkleRow(), { detail: 1 });
    });
    expect(useUiStore.getState().activeSpecial).toBe("sparkle");
    expect(useCableStore.getState().wired).toBe("right");
    expect(useCableStore.getState().agentId).toBe(SPARKLE_ID);
  });

  // ══ THE CASE THAT CARRIES THE GUARANTEE ═════════════════════════════════════════════════════════
  // Every other case here starts from `resetCable()`, so `agentId === SPARKLE_ID` is satisfied both
  // by "the press re-pinned the cable" and — if the press ever stopped patching — by nothing at all
  // having happened to a cable that was already off. Only a cable pinned to a DIFFERENT agent can
  // tell those apart, and that is the state where the failure is a message in the wrong PTY rather
  // than a cosmetic one.
  it("pins the cable to THIS row even when it was already patched elsewhere", () => {
    useCableStore.getState().patch("right", "a1");
    expect(useCableStore.getState().agentId).toBe("a1"); // the precondition really took
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      fireEvent.click(sparkleRow(), { detail: 1 });
    });
    expect(useUiStore.getState().activeSpecial).toBe("sparkle");
    // THE PANE ON SCREEN AND THE FAR END OF THE CABLE ARE THE SAME AGENT. Routing reads the pin, not
    // the pane, so a stale pin here is the founder typing into a build agent while looking at Sparkle.
    expect(useCableStore.getState().agentId).toBe(SPARKLE_ID);
  });

  it("a DOUBLE press mounts — the founder's actual gesture", () => {
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      // The real browser order, not a shortcut: click, click, dblclick.
      fireEvent.click(sparkleRow(), { detail: 1 });
      fireEvent.click(sparkleRow(), { detail: 2 });
      fireEvent.doubleClick(sparkleRow());
    });
    expect(useUiStore.getState().activeSpecial).toBe("sparkle");
    expect(useCableStore.getState().wired).toBe("right");
    expect(useCableStore.getState().agentId).toBe(SPARKLE_ID);
  });

  it("a DOUBLE press re-pins a cable that was patched elsewhere, too", () => {
    // The double press is the founder's gesture, so it gets the same non-reset precondition the
    // single press does rather than inheriting its guarantee from the case above.
    useCableStore.getState().patch("right", "a1");
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      fireEvent.click(sparkleRow(), { detail: 1 });
      fireEvent.click(sparkleRow(), { detail: 2 });
      fireEvent.doubleClick(sparkleRow());
    });
    expect(useCableStore.getState().agentId).toBe(SPARKLE_ID);
  });

  it("ENTER on the focused row mounts", () => {
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      fireEvent.keyDown(sparkleRow(), { key: "Enter" });
    });
    expect(useCableStore.getState().wired).toBe("right");
    expect(useCableStore.getState().agentId).toBe(SPARKLE_ID);
  });

  it("SPACE on the focused row mounts", () => {
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      fireEvent.keyDown(sparkleRow(), { key: " " });
    });
    expect(useCableStore.getState().wired).toBe("right");
    expect(useCableStore.getState().agentId).toBe(SPARKLE_ID);
  });

  it("an unrelated key does nothing at all", () => {
    // The negative control for the two cases above: without it, a handler that patched on EVERY
    // keydown would pass both of them.
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      fireEvent.keyDown(sparkleRow(), { key: "a" });
    });
    expect(useUiStore.getState().activeSpecial).toBeNull();
    expect(useCableStore.getState().wired).toBe("off");
  });
});
