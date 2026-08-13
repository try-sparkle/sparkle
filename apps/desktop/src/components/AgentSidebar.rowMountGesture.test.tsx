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
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { FOLD_DOUBLE_PRESS_GRACE_MS } from "./AgentRow";
import { AGENT_NAME_MIN_WIDTH_PX } from "./FittedAgentName";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { resetCable, useCableStore } from "../stores/cableStore";
import { resetPaneFocus, usePaneFocusStore } from "../stores/paneFocusStore";
import { doubleClickRow, openAgentCard, singleClickRow } from "../testing/rowGestures";
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

/** The agent NAME inside a row — the span that used to own `dblclick` for rename, and that covers
 *  the row's whole flexible width. See the "on the agent name" block below. */
const nameIn = (row: HTMLElement) => within(row).getByTestId("row-agent-name");

const wired = () => useCableStore.getState().wired;

const selectedAgentId = () =>
  useProjectStore.getState().projects.find((x) => x.id === "p1")?.selectedAgentId ?? null;

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
    useCableStore.getState().patch("right", null);
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
    // RECORDS THE AGENT TOO, not just the side. The mount now pins its far end (roborev 63145 #4),
    // and a spy that dropped the agent would let a mount onto the WRONG row read as correct here.
    const patched: string[] = [];
    const real = useCableStore.getState().patch;
    useCableStore.setState({
      // FORWARD BOTH ARGUMENTS, and RECORD both. The spy stands in for the real action, so
      // dropping the far-end here would hand the store `undefined` and quietly unpin the cable for
      // the whole test — the mount would still be counted, which is what this case asserts, while
      // the thing the pin exists to protect went untested. Recording `side:agentId` rather than
      // `side` alone is what makes the mount's TARGET part of the assertion too.
      patch: (side, agentId) => {
        patched.push(`${side}:${agentId}`);
        real(side, agentId);
      },
    });
    try {
      render(<AgentSidebar project={PROJECT} />);
      doubleClickRow(rowFor(OTHER));
      expect(patched).toEqual(["right:a2"]);
      expect(wired()).toBe("right");
    } finally {
      useCableStore.setState({ patch: real });
    }
  });

  it("the two clicks BEFORE the dblclick patch nothing at all", () => {
    // The other half of "exactly once", and the one that pins WHICH event carries the mount: if the
    // count above were satisfied by a click rather than by the dblclick, this fails. Same wrapper,
    // stopped one event short of the gesture.
    // RECORDS THE AGENT TOO, not just the side. The mount now pins its far end (roborev 63145 #4),
    // and a spy that dropped the agent would let a mount onto the WRONG row read as correct here.
    const patched: string[] = [];
    const real = useCableStore.getState().patch;
    useCableStore.setState({
      // Both arguments, recorded the same way, for the reason in the case above.
      patch: (side, agentId) => {
        patched.push(`${side}:${agentId}`);
        real(side, agentId);
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
      expect(patched).toEqual(["right:a2"]);
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

// ══ ON THE AGENT NAME — THE BIGGEST TARGET ON THE ROW ══════════════════════════════════════════
// The name span is `display: block` inside a `flex: 1` parent, so it covers the row's entire
// flexible width: aim anywhere a person would actually aim and this is what you hit. It owned
// `dblclick` for rename and called `stopPropagation`, so the mount gesture that shipped the same day
// was dead over exactly that area — it worked on the disc, the chips and the gutter, and nowhere
// else (roborev 63145). Nothing covered a double click landing on the name.
//
// Founder, asked how the two gestures should resolve: *"double click mounts. right click to
// rename."* Both halves are asserted here, and both fail against the code as it shipped: the double
// click never reached the row, and a right click on the name opened the detail card rather than the
// editor.
describe("the two gestures on the agent name", () => {
  // ══ AIMED AT THE LETTERS, NOT THE OUTER SPAN — roborev 63223 ══════════════════════════════════
  // These two cases dispatched on `nameIn(...)`, the OUTER span, and were vacuous: they passed
  // against the pre-change code. The `dblclick` that swallowed the mount lived on the INNER span
  // (the element holding the text), and a synthetic event propagates from its target UPWARD — so
  // an event dispatched on the outer span never traverses the inner one, never met the old
  // `stopPropagation`, and bubbled to the row and mounted under the old code too. Re-attaching
  // `onDoubleClick` to the inner span — the exact regression — left both green, which is measured,
  // not argued: with it restored, all seven cases in this describe still passed.
  //
  // So the letters case aims where the old handler actually was, and the padding case keeps the
  // reserved flexible width pinned. They fail for DIFFERENT reasons, which is why both are here.
  // The innermost element carrying the text — i.e. the inner span, which is where the retired
  // `dblclick` lived. `rowFor` already walks up from exactly this element.
  const lettersFor = (name: string) => screen.getByText(name);

  it("a double click on the LETTERS mounts the concierge", () => {
    // The case the regression would break. Verified to go red with `onDoubleClick={beginRename}`
    // restored on the inner span.
    render(<AgentSidebar project={PROJECT} />);
    doubleClickRow(lettersFor(OTHER));
    expect(wired()).toBe("right");
  });

  it("…and the name RESERVES that padding, which is why aiming beside the letters works", () => {
    // WHAT THIS PINS, after roborev 63321: the flexible width, not a second mount.
    //
    // It used to double-click the OUTER span and assert `wired() === "right"`, described as a case
    // the letters case could not catch. That was false. `FittedAgentName` nests inner-inside-outer,
    // so an event on the inner span propagates through outer → row while an event on the outer span
    // propagates through row alone: the padding case's event path is a strict SUBSET of the letters
    // case's. Anything on the outer span or the row that reds padding also reds letters, and the
    // stated discriminator ("a guard that bailed on the name element itself") does not exist —
    // `AgentRow`'s guard is `closest`, which walks ancestors, so a hit on the letters resolves to
    // that same outer span and bails identically. Only an identity test would separate them, and
    // the row has none. It was a case presented as pinning something it cannot pin — the very shape
    // this describe block was rewritten to remove, re-created one commit later.
    //
    // So it now asserts the thing only the outer span expresses, and the thing its title always
    // claimed: the name reserves the row's flexible width, which is WHY there is padding to aim at.
    // Inline styles, so this is jsdom-safe — no stylesheet or layout is involved
    // (docs/jsdom-test-caveats.md).
    render(<AgentSidebar project={PROJECT} />);
    const outer = nameIn(rowFor(OTHER));
    // `flexGrow`, not the `flex` shorthand — jsdom expands `flex: 1` to the longhand `1 1 0%`, so
    // asserting the shorthand string pins a serialisation detail rather than the behaviour.
    expect(outer.style.flexGrow).toBe("1");
    // A floor, so a long sibling cannot truncate the name to nothing — the reason the padding is
    // reserved at all rather than merely left over.
    //
    // THE EXACT VALUE, not `.not.toBe("")` (roborev 63497). The regression this line claims to floor
    // is the name going back to `minWidth: 0` — and `"0"` is not `""`, so the loose form stayed green
    // against precisely the state it was written to catch. jsdom measures the column at 0, which
    // `agentNameFloorFor` maps to the WIDE floor (see FittedAgentName), so the value is pinned rather
    // than layout-dependent.
    expect(AGENT_NAME_MIN_WIDTH_PX).toBeGreaterThan(0);
    expect(outer.style.minWidth).toBe(`${AGENT_NAME_MIN_WIDTH_PX}px`);
    expect(outer.style.display).toBe("block");
  });

  it("…on the name of the row that is ALREADY selected too", () => {
    // The realistic sequence, aimed where the pointer actually goes: read the agent, then double
    // click its name to talk to it. On the letters, for the reason in the block above.
    render(<AgentSidebar project={PROJECT} />);
    doubleClickRow(lettersFor(SELECTED));
    expect(wired()).toBe("right");
  });

  it("a RIGHT click on the name opens the rename editor", () => {
    render(<AgentSidebar project={PROJECT} />);
    expect(screen.queryByDisplayValue(OTHER)).toBeNull();
    fireEvent.contextMenu(nameIn(rowFor(OTHER)));
    expect(screen.getByDisplayValue(OTHER)).toBeInstanceOf(HTMLInputElement);
  });

  it("…and does NOT touch the cable", () => {
    // Rename is not a mount. Asserted from BOTH resting states, because "unchanged" is only half an
    // assertion from one of them: an unpatched cable staying off could be a handler that never ran.
    render(<AgentSidebar project={PROJECT} />);
    fireEvent.contextMenu(nameIn(rowFor(OTHER)));
    expect(wired()).toBe("off");
    cleanup();
    useCableStore.getState().patch("right", null);
    render(<AgentSidebar project={PROJECT} />);
    fireEvent.contextMenu(nameIn(rowFor(OTHER)));
    expect(wired()).toBe("right");
  });

  it("…and does NOT also open the detail card", () => {
    // `contextmenu` is a gesture the ROW uses — it is how the card opens — so the name has to claim
    // the event. `openCard` selects the row first, so a selection that never moves is the proof it
    // did not run. Without the `stopPropagation` this reads "a2".
    render(<AgentSidebar project={PROJECT} />);
    expect(selectedAgentId()).toBe("a1");
    fireEvent.contextMenu(nameIn(rowFor(OTHER)));
    expect(selectedAgentId()).toBe("a1");
  });

  it("…on the EXPANDED name inside the detail card too", () => {
    // THE ROW HAS TWO NAME LAYOUTS AND THEY ARE SEPARATE ELEMENTS. The collapsed row draws
    // `FittedAgentName`; the detail card's header draws its own "Title:  description" line, with its
    // own copy of the rename wiring. Both used to be `dblclick`, so both had to move — and a test
    // that only drove the collapsed one reported the change as covered while the card's line kept
    // whatever it was given (AGENTS.md: "a covered sibling does not vouch for an uncovered one";
    // mutation-check flagged exactly this site).
    render(<AgentSidebar project={PROJECT} />);
    openAgentCard(rowFor(OTHER));
    const card = screen.getByTestId("agent-hover-card");
    fireEvent.contextMenu(within(card).getByText(OTHER));
    expect(screen.getByDisplayValue(OTHER)).toBeInstanceOf(HTMLInputElement);
  });

  it("…and leaves no native context menu standing behind the editor", () => {
    // `fireEvent` returns false when a handler called `preventDefault`. The founder's rule is a
    // rename editor, not a rename editor with the OS menu on top of it.
    render(<AgentSidebar project={PROJECT} />);
    expect(fireEvent.contextMenu(nameIn(rowFor(OTHER)))).toBe(false);
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

// ══ MOUNTING AN ORCHESTRATOR MUST NOT RESTRUCTURE THE COLUMN ═══════════════════════════════════
// roborev 63145, finding 3. The row has a SECOND second-click rule: clicking a row you are already
// on folds/unfolds its worker subtree. The mount is keyed on `dblclick` and the fold on `click`, so
// they never collide per EVENT — but a double press RAISES BOTH, and its second click always
// satisfies the fold's `wasAlreadySelected`. So patching the cable onto an orchestrator always
// folded or unfolded its workers, and that state is PERSISTED.
//
// Nothing caught it because every mount-gesture case above uses a childless row, where
// `subtreeCollapsed` is null and the fold rule does not exist at all. These use a real orchestrator.
//
// `collapsedOrchestrators` reads a MISSING entry as collapsed (uiStore), so "untouched" is asserted
// as the absence of an entry, and an unwanted toggle shows up as an explicit `false`.
describe("a double click on an ORCHESTRATOR with workers", () => {
  const HEAD = "Fleet lead";
  const WORKER = "Parser worker";

  function mkWorker(id: string, name: string, parentId: string): AgentTab {
    return { ...mkAgent(id, name), kind: "worker", parentId, baseBranch: "main" };
  }

  const ORCH: Project = {
    id: "p1", name: "Alpha", rootPath: "/tmp/p1", defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: "o1",
    agents: [mkAgent("o1", HEAD), mkWorker("w1", WORKER, "o1")],
  };

  const foldOf = (id: string) => useUiStore.getState().collapsedOrchestrators[id];
  /** Wait past FOLD_DOUBLE_PRESS_GRACE_MS, so "no fold happened" cannot mean "not yet". */
  const settle = () => new Promise((r) => setTimeout(r, FOLD_DOUBLE_PRESS_GRACE_MS + 60));

  beforeEach(() => {
    useProjectStore.setState({ projects: [ORCH], selectedProjectId: "p1" } as never);
    useRuntimeStore.setState({ openAgentIds: ["o1", "w1"], status: {} } as never);
  });

  it("mounts the concierge", () => {
    // The gesture still has to WORK on an orchestrator — this is the half that a fix suppressing
    // the whole double press would break.
    render(<AgentSidebar project={ORCH} />);
    doubleClickRow(rowFor(HEAD));
    expect(wired()).toBe("right");
  });

  it("…and leaves the worker subtree exactly as it found it — THE REGRESSION", async () => {
    // Against the code as it shipped this reads `false`: the subtree was thrown open by a gesture
    // that says nothing about workers, and the change was persisted.
    //
    // The row here is ALREADY SELECTED, which is the case a click-count test cannot reach and the
    // one a real user is in — you click a row to read it, then double-click it to talk to it. The
    // fold that fires is the one on the FIRST click, where nothing yet distinguishes a single press
    // from half a double.
    render(<AgentSidebar project={ORCH} />);
    expect(foldOf("o1")).toBeUndefined();
    doubleClickRow(rowFor(HEAD));
    // Held past the grace window, because a fold that merely ARRIVES LATE is the same bug wearing a
    // delay: the assertion has to outlive the timer that would have written it.
    await settle();
    expect(foldOf("o1")).toBeUndefined();
  });

  it("…in the other direction too — an OPEN subtree is not folded shut by a mount", async () => {
    // Asserted from both resting states, because "unchanged" from the default is weak: a fold that
    // wrote the value it already had would pass the case above and fail this one.
    useUiStore.setState({ collapsedOrchestrators: { o1: false } } as never);
    render(<AgentSidebar project={ORCH} />);
    doubleClickRow(rowFor(HEAD));
    await settle();
    expect(foldOf("o1")).toBe(false);
    expect(wired()).toBe("right");
  });

  it("but a DELIBERATE second click still folds — the gesture is not gone", async () => {
    // THE PAIRED CASE, and the one that keeps the suppression honest: without it, deleting
    // `onToggleSubtree` outright would satisfy every case above. Two presses OUTSIDE the double
    // click interval is what a user folding a subtree actually does, and no `dblclick` follows —
    // so the deferred fold is never cancelled and lands.
    render(<AgentSidebar project={ORCH} />);
    singleClickRow(rowFor(HEAD));
    await waitFor(() => expect(foldOf("o1")).toBe(false));
    // …and no cable came with it. The fold is the whole outcome of that gesture.
    expect(wired()).toBe("off");
  });

  it("an assistive-tech activation keeps its fold too", async () => {
    // roborev 53837's users. Detail 0 is the AT / synthetic-jump class, which has no double form at
    // all — so it takes the same deferred path rather than a second branch that could drift, and
    // its fold simply lands one interval later. Narrowing the suppression to `detail !== 1` would
    // have taken folding away from the users least able to work around it.
    render(<AgentSidebar project={ORCH} />);
    fireEvent.click(rowFor(HEAD), { detail: 0 });
    await waitFor(() => expect(foldOf("o1")).toBe(false));
  });

  it("and a row unmounted mid-gesture never writes its fold afterwards", async () => {
    // The deferral put a persisted write on a timer, which is a new way to be wrong: a row can go
    // away between the click and the fold (a filter, a project switch, a retirement). Writing then
    // would restructure a column nobody is looking at, for a row that may no longer exist.
    const { unmount } = render(<AgentSidebar project={ORCH} />);
    singleClickRow(rowFor(HEAD));
    unmount();
    await settle();
    expect(foldOf("o1")).toBeUndefined();
  });
});
