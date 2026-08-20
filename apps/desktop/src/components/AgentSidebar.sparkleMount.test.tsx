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
// Every case here PRESSES THE REAL ROW the real sidebar rendered and then reads the store, never
// calling `patch` itself. That distinction is the whole reason the sibling suite exists: a test that
// drives the store proves the store works and says nothing about whether a user can get there
// (roborev 55221).
//
// ══ AND THE GESTURE IS THE DOUBLE PRESS (bead sparkle-9useo2) ═══════════════════════════════════
// Founder, 2026-08-20: *"For build agents, I have to double click on them to mount the concierge
// pane. I want the improve sparkle to work the same way."* So the cases below drive `doubleClickRow`
// rather than a bare `fireEvent.click`, and that is not cosmetic: jsdom's default click carries
// `detail: 0`, which is the ASSISTIVE-TECH arm of `mountsOnRowActivation` and mounts on its own. A
// suite written that way goes green against a row that has lost the mouse mount entirely — it would
// have stayed green through this very change in either direction.
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
import { mountsOnRowActivation } from "../engine/cable";
import { doubleClickRow, singleClickRow } from "../testing/rowGestures";
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
      doubleClickRow(sparkleRow());
    });
    expect(useCableStore.getState().wired).toBe("right");
  });

  it("patches to the LEFT when this sidebar's project lives in the left pair", () => {
    // The side is the SIDEBAR'S OWN pair, exactly as for a build row — so the cable lands on the
    // side whose pane the click just revealed, and cannot disagree with it.
    useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      doubleClickRow(sparkleRow());
    });
    expect(useCableStore.getState().wired).toBe("left");
  });

  it("MOVES a cable already patched to the other side rather than lighting both", () => {
    // ONE LIVE CIRCUIT, from patchCable's own reducer. This row must not be the exception that
    // leaves two pairs looking connected at once.
    useCableStore.getState().patch("left", null);
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      doubleClickRow(sparkleRow());
    });
    expect(useCableStore.getState().wired).toBe("right");
  });

  it("docks a floating concierge, so wired and floating cannot both be true", () => {
    // A floating concierge sits on top of the very row it claims to be wired to. Asserted through
    // the GESTURE, so the guarantee is the user's rather than the store's.
    useCableStore.getState().overlayTo("assist");
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      doubleClickRow(sparkleRow());
    });
    expect(useCableStore.getState().overlay).toBe("off");
    expect(useCableStore.getState().wired).toBe("right");
  });

  it("still does everything the click already did — seats the pane and opens the agent", () => {
    // The patch is an ADDITION. If wiring came at the cost of revealing the pane, the founder's
    // click would light a cable into a pane they can't see.
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      doubleClickRow(sparkleRow());
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
      doubleClickRow(sparkleRow());
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
        doubleClickRow(sparkleRow());
      });
      expect(useCableStore.getState().wired).toBe("right");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ══ THE ROW'S ACTIVATIONS: REACHABLE FROM EVERYTHING, ON THE BUILD ROW'S OWN RULE ══════════════
// (beads sparkle-gyvjyt, sparkle-9useo2.) The founder, on v0.114.0: *"I am able to double click to
// mount regular build agents and write to them so those are working OK. It's only the
// Improve-Sparkle one that's not working."* — and on 2026-08-20: *"it shouldn't mount the concierge
// pane unless I double click on improve sparkle just like any other build agent works."*
//
// Two things were wrong with this row and they are fixed in opposite directions. It had no `role`,
// no `tabIndex`, no `onKeyDown` and no `onDoubleClick`, so it was operable by POINTER ONLY — on the
// one row where that costs the whole feature, since SparkleAgentPane has no composer and the cable
// is this agent's only input surface. And its click MOUNTED UNCONDITIONALLY, so merely looking at
// the row hijacked the concierge. It now asks `engine/cable.mountsOnRowActivation`, the same
// predicate `AgentRow` asks, and the parity suite at the bottom of this file pins that agreement
// gesture by gesture against a real build row rendered beside it.
describe("the Improve Sparkle row is reachable from every activation", () => {
  it("is OPERABLE — role, tab stop and all, which is what makes the keyboard cases below reachable", () => {
    render(<AgentSidebar project={PROJECT} />);
    expect(sparkleRow().getAttribute("role")).toBe("button");
    expect(sparkleRow().getAttribute("tabindex")).toBe("0");
  });

  it("a plain SINGLE press SEATS THE PANE AND DOES NOT PATCH — the founder's ask", () => {
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      singleClickRow(sparkleRow());
    });
    // The select half still runs in full: this is "open it to look at it", not "do nothing".
    expect(useUiStore.getState().activeSpecial).toBe("sparkle");
    expect(useRuntimeStore.getState().openAgentIds).toContain(SPARKLE_ID);
    // …and the cable stayed exactly where it was.
    expect(useCableStore.getState().wired).toBe("off");
    expect(useCableStore.getState().agentId).toBeNull();
  });

  // ══ THE CASE THAT CARRIES THE GUARANTEE ═════════════════════════════════════════════════════════
  // The case above starts from `resetCable()`, where "the cable did not move" is satisfied both by
  // the press correctly declining to patch and by a cable that was already off and could not show a
  // move. Only a cable pinned to a DIFFERENT agent can tell those apart — and this is the exact
  // scenario roborev 65160 objected to, pinned here in the direction the founder asked for, so a
  // future reader can see it is a decision rather than an oversight. It is LABELLED, not silent: the
  // concierge column resolves its mount from the cable's own pin (bead sparkle-9gsjqm), so it keeps
  // showing "Chatting with ● Stripe checkout retry" while this pane is on screen.
  it("a SINGLE press leaves a cable patched elsewhere exactly where it was", () => {
    useCableStore.getState().patch("right", "a1");
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      singleClickRow(sparkleRow());
    });
    expect(useUiStore.getState().activeSpecial).toBe("sparkle");
    expect(useCableStore.getState().agentId).toBe("a1");
  });

  it("a DOUBLE press mounts — the founder's actual gesture", () => {
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      doubleClickRow(sparkleRow());
    });
    expect(useUiStore.getState().activeSpecial).toBe("sparkle");
    expect(useCableStore.getState().wired).toBe("right");
    expect(useCableStore.getState().agentId).toBe(SPARKLE_ID);
  });

  it("a DOUBLE press re-pins a cable that was patched elsewhere", () => {
    // The non-reset precondition again, on the gesture that IS supposed to move the cable: without
    // it, `agentId === SPARKLE_ID` is satisfied by a cable that had nowhere else to be.
    useCableStore.getState().patch("right", "a1");
    expect(useCableStore.getState().agentId).toBe("a1"); // the precondition really took
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      doubleClickRow(sparkleRow());
    });
    expect(useCableStore.getState().agentId).toBe(SPARKLE_ID);
  });

  it("an ASSISTIVE-TECH press (detail 0) mounts — it has no double form to promote", () => {
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      fireEvent.click(sparkleRow(), { detail: 0 });
    });
    expect(useCableStore.getState().wired).toBe("right");
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

// ══ PARITY, ASSERTED WITH BOTH ROWS MOUNTED AT ONCE (bead sparkle-9useo2) ═══════════════════════
// The founder's ask is not "the Sparkle row mounts on a double click"; it is *"just like any other
// build agent works"*. Those are different claims, and a suite that only ever drives the Sparkle row
// can prove the first while the second quietly stops being true — which is exactly the history here:
// this row has now been on THREE different gesture rules while every ordinary row stayed on one.
//
// So each case below renders ONE sidebar containing a real build row and the Improve Sparkle row,
// makes the SAME gesture on each, and asserts they reach the same verdict — with
// `mountsOnRowActivation` named as the third party both are compared against, so the case cannot be
// satisfied by two rows agreeing on the wrong answer. That is the AGENTS.md rule about mounting
// every candidate at once: absence on a row that is not in the tree proves nothing.
//
// It runs against the CABLE PIN rather than a spy, because the pin is what routing reads — the fact
// a wrong answer would cost the founder.
describe("Improve Sparkle resolves the same mount predicate as an ordinary build row", () => {
  /** The ordinary build row, found the way a user finds it — beside the Sparkle row, same tree. */
  const buildRow = () =>
    screen.getByText("Stripe checkout retry").closest('[data-hint="agent"]') as HTMLElement;

  const GESTURES = [
    {
      name: "a plain single press",
      press: singleClickRow,
      activation: { type: "click", detail: 1 } as const,
    },
    {
      name: "a double press",
      press: doubleClickRow,
      activation: { type: "dblclick" } as const,
    },
    {
      name: "an assistive-tech press (detail 0)",
      press: (row: HTMLElement) => fireEvent.click(row, { detail: 0 }),
      activation: { type: "click", detail: 0 } as const,
    },
    {
      name: "Enter on the focused row",
      press: (row: HTMLElement) => fireEvent.keyDown(row, { key: "Enter" }),
      activation: { type: "key" } as const,
    },
  ];

  for (const g of GESTURES) {
    it(`${g.name}: both rows agree with mountsOnRowActivation`, () => {
      const shouldMount = mountsOnRowActivation(g.activation);
      // Pinned SOMEWHERE ELSE first, and to an id neither row owns. Without it "did not mount" is
      // indistinguishable from "the cable had nowhere to move from", and every case below would pass
      // against a row whose mount is dead.
      useCableStore.getState().patch("left", "cable-parked-elsewhere");
      render(<AgentSidebar project={PROJECT} />);

      act(() => {
        g.press(buildRow());
      });
      const afterBuild = useCableStore.getState().agentId;
      expect(afterBuild).toBe(shouldMount ? "a1" : "cable-parked-elsewhere");

      // Re-park, so the Sparkle row is judged from the same starting state the build row was.
      act(() => {
        useCableStore.getState().patch("left", "cable-parked-elsewhere");
      });
      act(() => {
        g.press(sparkleRow());
      });
      expect(useCableStore.getState().agentId).toBe(
        shouldMount ? SPARKLE_ID : "cable-parked-elsewhere",
      );
    });
  }

  it("…and the SELECT half runs on every one of them, mount or no mount", () => {
    // The other side of the parity claim, and the one a "does not mount" assertion cannot see: a row
    // that had lost its click handler entirely would satisfy every `not.toMount` case above.
    render(<AgentSidebar project={PROJECT} />);
    act(() => {
      singleClickRow(sparkleRow());
    });
    expect(useUiStore.getState().activeSpecial).toBe("sparkle");
    expect(useRuntimeStore.getState().openAgentIds).toContain(SPARKLE_ID);
  });
});
