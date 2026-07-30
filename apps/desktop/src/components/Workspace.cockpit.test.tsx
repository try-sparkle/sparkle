// @vitest-environment jsdom
//
// THE COCKPIT — the shell's layout contract and the cable's two unbind gestures, asserted on the
// real DOM the app renders.
//
// The user sits centred on the concierge like an F1 driver:
//
//     TERM │ BUILD │ CONCIERGE │ BUILD │ TERM
//
// Four things these pin, each of which the shell got wrong or lacked before:
//
//   1. `data-pairs` / `data-wired` live on the shell ROOT — one value, so every visual consequence
//      can follow from CSS instead of scattered component state (MAPPING.md's explicit instruction).
//   2. The project tabs belong to the PAIR. Build and terminal are one project; the strip sits above
//      the pair and NEVER above the concierge. It used to be a full-width bar spanning everything.
//   3. Escape and a click off a build agent row are the SAME single state change — unbind.
//   4. Wiring docks the overlay: a floating concierge sits on top of the very row it claims to be
//      wired to, so those two states cannot both be true.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => Promise.resolve(() => {}),
    setTitle: () => Promise.resolve(),
  }),
  getAllWindows: () => Promise.resolve([{}]),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

vi.mock("../windowContext", async () => {
  const { useProjectStore } = await import("../stores/projectStore");
  return {
    useCurrentProjectId: () => useProjectStore((s) => s.selectedProjectId),
    useIsMainWindow: () => false,
    useCurrentWindowLabel: () => "main",
  };
});

vi.mock("../services/orchestrationListener", () => ({
  startOrchestrationListener: () => Promise.resolve(() => {}),
}));
vi.mock("../services/controlListener", () => ({
  startControlListener: () => Promise.resolve(() => {}),
}));
vi.mock("../services/crossWindowSync", () => ({ subscribeToCrossWindowSync: () => () => {} }));
vi.mock("../services/cloudAgents/startup", () => ({
  reattachProjectOnOpen: async () => [] as string[],
}));
// PARTIAL, not a replacement: the real module also exports the reserved-id constants
// (SPARKLE_AGENT_ID / SPARKLE_PROJECT_ID / isSparkleAgentId), which other modules in this render
// tree now import transitively. A whole-module mock silently drops them, and the failure surfaces as
// an unrelated import error in whichever file happens to need one — so spread the original and
// override only the three launch decisions this suite is steering.
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
  sparkleAgentIdFor: () => "sparkle",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));

vi.mock("./AgentPane", () => ({
  AgentPane: ({ agent }: { agent: { id: string } }) => <div data-testid={`pane-${agent.id}`} />,
}));
// The sidebar stub publishes the SAME accessibility structure the real one does — a
// `[data-agent-tree]` container of `role="treeitem"` rows. That structure is what the click-away
// gesture recognises a build agent row by (engine/cable's BUILD_ROW_SELECTOR), so a stub without it
// would make the "clicking a row does not unbind" case vacuously pass.
// THE STUB PUBLISHES `slotSide`, and that is load-bearing rather than tidy. The real component only
// consults the prop when `project` is null, which is exactly the state the left stage renders in when
// its tab is closed — and the prop's default is "right", so deleting `slotSide="left"` from the JSX is
// SILENT: the component-level row keeps passing (it hands the prop in by hand) while the empty left
// column goes back to seeding from and clobbering the right column's width (roborev 55539). A stub
// that dropped the prop could not tell the two apart.
vi.mock("./AgentSidebar", () => ({
  AgentSidebar: ({ slotSide = "right" }: { slotSide?: string }) => (
    <div data-testid="sidebar" data-slot-side={slotSide}>
      <div role="tree" aria-label="Build agents" data-agent-tree>
        <div role="treeitem" aria-selected data-testid="fake-row">
          <span data-testid="fake-row-label">Stripe checkout retry</span>
        </div>
      </div>
    </div>
  ),
  NewBuildAgentButton: () => null,
}));
vi.mock("./ConciergeHost", () => ({ ConciergeHost: () => <div data-testid="concierge" /> }));
vi.mock("./OfflineBanner", () => ({ OfflineBanner: () => null }));
vi.mock("./ZeroCreditBanner", () => ({ ZeroCreditBanner: () => null }));
vi.mock("./SparkleAgentPane", () => ({ SparkleAgentPane: () => null }));
vi.mock("./ProjectModal", () => ({ ProjectModal: () => null }));
vi.mock("./ClosePrompt", () => ({ ClosePrompt: () => null }));
vi.mock("./BoardView", () => ({ BoardView: () => <div data-testid="board" /> }));
vi.mock("./Concierge/KebabMenu", () => ({ ConciergeTopRight: () => null }));
vi.mock("./OpenPrMenu", () => ({ OpenPrMenu: () => null, agentLinkForBranch: () => null }));
vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));
vi.mock("./StatusStrip", () => ({ StatusStrip: () => null }));
vi.mock("./NewCloudAgentDialog", () => ({ NewCloudAgentDialog: () => null }));

import { Pair, Workspace } from "./Workspace";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuthStore } from "../stores/authStore";
import { useConnectionStore } from "../stores/connectionStore";
import { markProjectVisited, resetVisitedProjects } from "../services/sessionProjects";
import { resetCable, useCableStore } from "../stores/cableStore";
import { RELEASE_ARM_WINDOW_MS } from "../engine/cable";
import { openProjectTab } from "../services/openProjectTab";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}
function mkProject(id: string, name: string, agents: AgentTab[], selectedAgentId: string): Project {
  return {
    id, name, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId, agents,
  };
}

beforeEach(() => {
  useProjectStore.setState({
    projects: [mkProject("p1", "Alpha", [mkAgent("a1")], "a1")],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: ["a1"], status: {} } as never);
  useUiStore.setState({
    activeSpecial: null, workMode: "build", pinnedProjectId: null, openProjectIds: null,
    pairAssignment: {}, leftProjectId: null,
  } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false } as never);
  useConnectionStore.setState({ isOnline: true } as never);
  resetVisitedProjects();
  resetCable();
});
afterEach(() => {
  cleanup();
  resetCable();
});

const shell = () => screen.getByTestId("workspace-shell");
const patch = (side: "left" | "right") => act(() => useCableStore.getState().patch(side));

// ── 1. THE STATE LIVES ON THE ROOT ────────────────────────────────────────────────────────────
describe("the shell root carries the whole cockpit state", () => {
  it("publishes data-pairs and data-wired, unplugged at rest", () => {
    render(<Workspace />);
    expect(shell().getAttribute("data-pairs")).toBe("1");
    expect(shell().getAttribute("data-wired")).toBe("off");
    expect(shell().getAttribute("data-over")).toBe("off");
  });

  it("projects the patched side onto data-wired", () => {
    render(<Workspace />);
    patch("right");
    expect(shell().getAttribute("data-wired")).toBe("right");

    // ONE LIVE CIRCUIT — patching the other side MOVES the cable, never lights both. Seeded with a
    // real LEFT pair, because `data-wired` is a projection now, not a mirror: it names a side only
    // when there is an agent on the far end of the cable. This used to patch left with no left pair
    // in the fixture at all and assert "left" anyway — i.e. it pinned the lit-cable-with-nothing-
    // there state as the contract, which is the bug the projection exists to make unrepresentable.
    act(() => {
      useUiStore.setState({ pairAssignment: { p2: "left" }, leftProjectId: "p2" } as never);
      useProjectStore.setState({
        projects: [
          mkProject("p1", "Alpha", [mkAgent("a1")], "a1"),
          mkProject("p2", "Beta", [mkAgent("b1")], "b1"),
        ],
      } as never);
    });
    patch("left");
    expect(shell().getAttribute("data-wired")).toBe("left");
  });

  // THE STATE AN ACQUISITION GUARD CANNOT PREVENT, because nothing is being acquired: patch a side,
  // then empty it. `selectAndWire` refuses to patch when it seats no agent, and that closes one
  // route; switching the wired pair to an agent-less project or closing its last agent closes
  // nothing. Left unprojected, the shell floods that pair and recedes the other while the compose
  // box falls back to Sparkle — a lit cable whose prompt goes somewhere else (roborev 55249).
  it("reports OFF when the wired side has no agent on the far end", () => {
    render(<Workspace />);
    patch("right");
    expect(shell().getAttribute("data-wired")).toBe("right");
    act(() => {
      useProjectStore.setState({
        projects: [mkProject("p1", "Alpha", [mkAgent("a1")], null as never)],
      } as never);
    });
    expect(shell().getAttribute("data-wired")).toBe("off");
    // The STORE still holds the patch — this is a read-side projection, so nothing had to remember
    // to unbind and re-selecting an agent lights it again with no second gesture.
    expect(useCableStore.getState().wired).toBe("right");
  });

  // THE WIRING for the empty left column's width key, which is the half that regressed.
  //
  // `AgentSidebar` falls back to `slotSide` only when `project` is null — and the left stage renders
  // exactly that whenever the left pair's tab is closed. The prop defaults to "right", so deleting
  // `slotSide="left"` from the JSX leaves the component-level row green (it passes the prop by hand)
  // while the empty left column silently goes back to seeding from and overwriting
  // `sparkle-sidebar-width:right` (roborev 55539). Asserted on BOTH columns, because a stub that
  // reported "left" for every slot would satisfy a one-sided check.
  it("tells the LEFT stage's column which side it is on, even with no project in it", () => {
    act(() => {
      // p2 EXISTS and is assigned left, so the pair stays open (`pairCountFor` counts the assignment
      // over ALL projects — closing a tab must not unmount its panes) — but its TAB is closed, so it
      // is not among the open projects the side resolves against and the left stage's `project` is
      // null. That is precisely the state the fallback exists for, and it is reachable by one click.
      useUiStore.setState({
        pairAssignment: { p2: "left" }, leftProjectId: "p2", openProjectIds: ["p1"],
      } as never);
      useProjectStore.setState({
        projects: [
          mkProject("p1", "Alpha", [mkAgent("a1")], "a1"),
          mkProject("p2", "Beta", [mkAgent("b1")], "b1"),
        ],
      } as never);
    });
    render(<Workspace />);
    const sides = screen
      .getAllByTestId("sidebar")
      .map((el) => el.getAttribute("data-slot-side"));
    expect(sides).toContain("left");
    expect(sides).toContain("right");
  });

  // The whole point of the attribute: nothing else needs to change for the app to look wired, so a
  // future consumer (the concierge's flood, the receding pair) reads this one element.
  it("keeps data-wired on ONE element — the shell root, not scattered per column", () => {
    render(<Workspace />);
    patch("right");
    expect(document.querySelectorAll("[data-wired]")).toHaveLength(1);
  });
});

// ── 2. THE PAIR OWNS ITS TABS ─────────────────────────────────────────────────────────────────
describe("the pair", () => {
  it("puts the project tabs inside the pair, never above the concierge", () => {
    render(<Workspace />);
    const pair = screen.getByTestId("pair-right");
    expect(pair.contains(screen.getByTestId("project-tabs-strip"))).toBe(true);
    // The concierge is a SIBLING of the pair, so a strip inside the pair cannot span it.
    expect(pair.contains(screen.getByTestId("concierge"))).toBe(false);
  });

  it("holds build and terminal as one unsplit unit, build first", () => {
    render(<Workspace />);
    const cols = screen.getByTestId("pair-cols-right");
    expect(cols.contains(screen.getByTestId("sidebar"))).toBe(true);
    expect(cols.contains(screen.getByTestId("terminal-stage"))).toBe(true);
    // [build, terminal] in DOM order on BOTH sides — the mirror reverses the flow, not the markup,
    // so reading order and tab order are identical left and right. index.css's
    // `.paircols > :first-child` selector depends on exactly this.
    expect(cols.firstElementChild).toBe(screen.getByTestId("sidebar"));
  });

  it("mirrors: build stays adjacent to the concierge on both sides", () => {
    const { getByTestId } = render(
      <>
        <Pair side="left" tabs={<i />}>
          <div data-testid="l-build" />
          <div data-testid="l-term" />
        </Pair>
        <Pair side="right" tabs={<i />}>
          <div data-testid="r-build" />
          <div data-testid="r-term" />
        </Pair>
      </>,
    );
    // Left pair reads TERM │ BUILD │ concierge — the terminal is outboard, so the flow reverses.
    expect(getByTestId("pair-cols-left").style.flexDirection).toBe("row-reverse");
    expect(getByTestId("pair-cols-right").style.flexDirection).toBe("row");
    // …and the DOM order is untouched by the mirror.
    expect(getByTestId("pair-cols-left").firstElementChild).toBe(getByTestId("l-build"));
  });

  it("publishes data-side so the seam and the tab mirror are pure CSS", () => {
    render(<Workspace />);
    expect(screen.getByTestId("pair-right").getAttribute("data-side")).toBe("right");
    expect(screen.getByTestId("project-tabs-strip").getAttribute("data-side")).toBe("right");
  });
});

// ── 3. THE UNBIND GESTURES ────────────────────────────────────────────────────────────────────
describe("unbinding", () => {
  it("ESCAPE returns the concierge to floating middle", () => {
    render(<Workspace />);
    patch("right");
    expect(shell().getAttribute("data-wired")).toBe("right");
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(shell().getAttribute("data-wired")).toBe("off");
  });

  it("clicking anywhere that is NOT a build agent row does the same", () => {
    render(<Workspace />);
    patch("left");
    act(() => {
      fireEvent.pointerDown(screen.getByTestId("terminal-stage"));
    });
    expect(shell().getAttribute("data-wired")).toBe("off");
  });

  it("clicking a build agent row does NOT unbind — that is how you patch", () => {
    render(<Workspace />);
    patch("right");
    act(() => {
      fireEvent.pointerDown(screen.getByTestId("fake-row-label"));
    });
    expect(shell().getAttribute("data-wired")).toBe("right");
  });

  // Escape is a busy key (modals, the palette, a rename input). Unwired, this listener must decide
  // nothing, so it cannot become a second handler competing for every press.
  it("is inert while nothing is patched", () => {
    render(<Workspace />);
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.pointerDown(screen.getByTestId("terminal-stage"));
    });
    expect(shell().getAttribute("data-wired")).toBe("off");
  });

  it("survives a handler that stops propagation — the gesture listens in capture", () => {
    // FIRES ON THE SHELL ROOT, NOT THE TERMINAL. This used to press `terminal-stage` and expect an
    // unbind, which encoded the very defect roborev 54697 found: the terminal of the pair you are
    // PATCHED INTO is part of the live circuit, and pressing it must not drop the cable. The
    // capture-phase claim is orthogonal to which surface is used, so it is made on a surface that
    // genuinely sits outside the circuit.
    render(<Workspace />);
    patch("right");
    const root = shell();
    const swallow = (e: Event) => e.stopPropagation();
    root.addEventListener("pointerdown", swallow);
    act(() => {
      fireEvent.pointerDown(root);
    });
    root.removeEventListener("pointerdown", swallow);
    expect(shell().getAttribute("data-wired")).toBe("off");
  });

  // ── THE CIRCUIT IS NOT JUST THE ROW (roborev 54697) ─────────────────────────────────────────
  // The predicate was "unbind unless the press hit a build agent row", which made the wired state
  // unreachable: the primary flow is patch-then-TYPE, and the first click of that flow — into the
  // compose box — dropped the cable. These pin the three surfaces that are part of the circuit.
  it("pressing inside Sparkle does NOT unbind — patch, then type, is the primary flow", () => {
    render(<Workspace />);
    patch("right");
    const concierge = document.querySelector("[data-concierge-root]");
    expect(concierge).not.toBeNull();
    act(() => {
      fireEvent.pointerDown(concierge!);
    });
    expect(shell().getAttribute("data-wired")).toBe("right");
  });

  it("pressing the WIRED pair's own terminal does NOT unbind", () => {
    render(<Workspace />);
    patch("right");
    act(() => {
      fireEvent.pointerDown(screen.getByTestId("terminal-stage"));
    });
    expect(shell().getAttribute("data-wired")).toBe("right");
  });

  it("Escape does not unbind while a dismissible surface owns the press", () => {
    // Fifteen components treat Escape as "close me". With a cable patched, one Escape aimed at a
    // modal produced TWO state changes and the unasked-for one was invisible until reflow.
    render(<Workspace />);
    patch("right");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(shell().getAttribute("data-wired")).toBe("right");
    dialog.remove();
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(shell().getAttribute("data-wired")).toBe("off");
  });
});

// ── 3b. ESCAPE IS A TWO-STEP RELEASE ──────────────────────────────────────────────────────────
//
// Founder: *"pressing Escape once detaches the concierge from the build row"* — that half already
// worked — *"pressing Escape AGAIN detaches the ACTIVE BUILD ROW itself. After the second Escape
// there is no active build row at all, and the terminal column shows nothing."* A third press does
// nothing rather than escalating further.
//
// These drive REAL key events through the window listener and assert the store writes that follow.
// The visual consequences of each step (the cable, the flood, the connector) belong to the agent
// that owns the cockpit chrome; what is pinned here is the state machine underneath them.
describe("Escape — the progressive release", () => {
  const selectedAgent = () =>
    useProjectStore.getState().projects.find((p) => p.id === "p1")?.selectedAgentId;
  const escape = () => act(() => void fireEvent.keyDown(window, { key: "Escape" }));

  it("first press unwires the concierge and LEAVES the row selected", () => {
    render(<Workspace />);
    patch("right");
    expect(selectedAgent()).toBe("a1");
    escape();
    expect(shell().getAttribute("data-wired")).toBe("off");
    // THE INTERMEDIATE STATE IS THE FEATURE. If one press did both, the user would never see the
    // "detached but still looking at that agent" step they confirmed is exactly right.
    expect(selectedAgent()).toBe("a1");
  });

  it("second press clears the active build row, leaving nothing selected", () => {
    render(<Workspace />);
    patch("right");
    escape();
    escape();
    expect(shell().getAttribute("data-wired")).toBe("off");
    expect(selectedAgent()).toBeNull();
  });

  it("a third press does nothing rather than escalating further", () => {
    render(<Workspace />);
    patch("right");
    escape();
    escape();
    const before = useProjectStore.getState().projects;
    escape();
    expect(selectedAgent()).toBeNull();
    expect(shell().getAttribute("data-wired")).toBe("off");
    // Not merely "still null": the store was not WRITTEN. `selectAgent` bails on a selection that
    // already matches, so the third press churns no projects array and re-renders no pane. A
    // reference-equality check is what makes "does nothing" mean nothing, rather than "does the
    // same thing again harmlessly".
    expect(useProjectStore.getState().projects).toBe(before);
  });

  // ══ THE REGRESSION THAT MADE ESCAPE DESTRUCTIVE EVERYWHERE (roborev 55373) ═══════════════════
  // This case previously asserted the OPPOSITE — that an Escape with nothing patched clears the row
  // — which encoded the bug as intended behavior and guaranteed the suite would never catch it.
  //
  // `wired === "off"` is the app's DEFAULT, not "you already pressed Escape once". So the old rule
  // meant every Escape pressed anywhere, at any time, blanked the terminal column. Rung 2 now needs
  // positive evidence that a release is under way, and cannot be reached without rung 1 firing.
  it("does NOTHING on an Escape when no release is under way — the app's resting state", () => {
    render(<Workspace />);
    expect(shell().getAttribute("data-wired")).toBe("off");
    escape();
    escape();
    escape();
    expect(selectedAgent()).toBe("a1");
  });

  // THE CASE THAT MADE IT DANGEROUS, asserted concretely. Escape is the most common key in an agent
  // terminal — vim, `less`, interrupting Claude Code — and `Terminal.tsx`'s custom key handler
  // claims only the composer chord and ⌘C, so it bubbles to the window listener. Under the old rule
  // the user deselected the very agent whose terminal they were typing in, and watched it vanish.
  it("leaves the row alone when Escape is typed into a terminal", () => {
    render(<Workspace />);
    act(() => {
      fireEvent.keyDown(screen.getByTestId("terminal-stage"), { key: "Escape", bubbles: true });
    });
    expect(selectedAgent()).toBe("a1");
  });

  // A CLICK-AWAY UNBIND MUST NOT ARM RUNG 2. Clicking away is the other unbind gesture and reaches
  // the same `wired: "off"`, so under the old rule the very next Escape — for any reason at all —
  // cleared the row. The latch is set by the KEY path only.
  it("does not arm the second rung when the cable was unbound by a click", () => {
    render(<Workspace />);
    patch("right");
    act(() => {
      fireEvent.pointerDown(shell());
    });
    expect(shell().getAttribute("data-wired")).toBe("off");
    escape();
    expect(selectedAgent()).toBe("a1");
  });

  // A pointer press between the two Escapes means the user moved on, so the second press is a fresh
  // first press rather than the back half of a gesture.
  it("disarms when the user does anything else between the two presses", () => {
    render(<Workspace />);
    patch("right");
    escape(); // rung 1 — armed
    act(() => {
      fireEvent.pointerDown(screen.getByTestId("terminal-stage"));
    });
    escape();
    expect(selectedAgent()).toBe("a1");
  });

  // ══ THE LATCH MUST MEAN "THE NEXT PRESS", NOT "ANY LATER ESCAPE" (roborev 55478) ═══════════════
  //
  // Cleared only by a POINTER press, the latch survived indefinitely across keyboard-only work — so
  // an Escape typed into a PTY an hour later still blanked the terminal column. Note this is the case
  // the earlier "Escape typed into a terminal" test could NOT catch: that one runs UNARMED, where
  // rung 2 is unreachable for a different reason, so it only re-proved the 55373 revert.
  it("leaves the row alone when Escape reaches a terminal AFTER a release was armed", () => {
    render(<Workspace />);
    patch("right");
    escape(); // rung 1 — armed
    // Keyboard-only work: the user carries on typing. No pointer press ever happens.
    act(() => {
      fireEvent.keyDown(screen.getByTestId("terminal-stage"), { key: "j", bubbles: true });
    });
    act(() => {
      fireEvent.keyDown(screen.getByTestId("terminal-stage"), { key: "Escape", bubbles: true });
    });
    expect(selectedAgent()).toBe("a1");
  });

  // ══ A HELD ESCAPE IS ONE PRESS, NOT TWO (roborev 55491) ═══════════════════════════════════════
  // The OS delivers keydown #2 after the repeat delay (~500ms, configurable to ~120ms on macOS). By
  // then rung 1 has unwired, so `unbindsOnKey` is false and the repeat fell straight through to rung
  // 2 — and nothing could disarm in between, because the repeat IS an Escape.
  it("ignores an autorepeat, so holding Escape does not walk both rungs", () => {
    render(<Workspace />);
    patch("right");
    escape(); // rung 1 — armed
    act(() => void fireEvent.keyDown(window, { key: "Escape", repeat: true }));
    expect(selectedAgent()).toBe("a1");
    // And the latch SURVIVES the repeat it ignored — a repeat is not the user moving on, so the
    // deliberate second press still completes the release.
    escape();
    expect(selectedAgent()).toBeNull();
  });

  it("disarms when focus leaves the window between the two presses", () => {
    render(<Workspace />);
    patch("right");
    escape(); // rung 1 — armed
    act(() => void fireEvent.blur(window));
    escape();
    expect(selectedAgent()).toBe("a1");
  });

  // ══ THE STALE-LATCH CASE THE EVENT CLEARS CANNOT REACH (roborev 55491) ════════════════════════
  // Typing in a focused terminal disarms NOTHING: xterm's handler ends in
  // `CoreBrowserTerminal.cancel()`, which calls `preventDefault()` and `stopPropagation()` for every
  // key it turns into a PTY sequence, so those keydowns never reach the `window` listener at all. No
  // pointer press, no blur, no foreign keydown — the latch simply outlived the gesture, and the first
  // Escape to arrive once focus fell outside the terminal cleared the row.
  //
  // The clock is mocked rather than the keyboard because the point is that NO event is required: the
  // latch goes stale on its own. (Mocked only AFTER the arming press, so the render itself still runs
  // on a real clock.)
  //
  // THE CLOCK IS FROZEN ACROSS BOTH PRESSES, and the first draft of these two rows was not — it
  // anchored the mock to the time the mock was installed rather than to the arming press, so a couple
  // of milliseconds of render overhead pushed the "within the window" case past the window and it
  // failed only when the whole file ran. Pin `t0` once and step it deliberately.
  function atFrozenClock(run: (advanceTo: (t: number) => void) => void) {
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      run((offset) => void clock.mockReturnValue(t0 + offset));
    } finally {
      clock.mockRestore();
    }
  }

  it("expires a stale latch, so a much later Escape cannot clear the row", () => {
    render(<Workspace />);
    patch("right");
    atFrozenClock((advanceTo) => {
      escape(); // rung 1 — armed at exactly t0
      advanceTo(RELEASE_ARM_WINDOW_MS + 1);
      escape();
      expect(selectedAgent()).toBe("a1");
    });
  });

  // The complement, so the expiry cannot pass by simply never arming: WITHIN the window it still
  // fires. Without this row, setting RELEASE_ARM_WINDOW_MS to 0 would leave the suite green.
  it("still completes the release when the second press is within the window", () => {
    render(<Workspace />);
    patch("right");
    atFrozenClock((advanceTo) => {
      escape();
      advanceTo(RELEASE_ARM_WINDOW_MS - 1);
      escape();
      expect(selectedAgent()).toBeNull();
    });
  });

  // ARMING IS GATED ON `defaultPrevented` TOO, not just rung 2. Several Escape-owning surfaces carry
  // no dialog role for the DOM probe to find and only call `preventDefault`; under the first cut such
  // a press unbound AND armed, so the user's NEXT Escape at that same surface cleared the row.
  it("does not arm the second rung on a press another handler has already claimed", () => {
    render(<Workspace />);
    patch("right");
    const claim = (e: KeyboardEvent) => {
      if (e.key === "Escape") e.preventDefault();
    };
    window.addEventListener("keydown", claim, true);
    escape(); // unbinds — rung 1's reach is confirmed behavior — but must NOT arm
    window.removeEventListener("keydown", claim, true);
    expect(shell().getAttribute("data-wired")).toBe("off");
    escape();
    expect(selectedAgent()).toBe("a1");
  });

  // The 54697 hazard, one rung along and worse: emptying the terminal column behind a dialog the
  // user was only dismissing is a change they did not ask for and cannot watch happen.
  it("leaves the row alone while a dismissible surface owns the press", () => {
    render(<Workspace />);
    patch("right");
    escape(); // rung 1 — the release is now under way
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    escape(); // belongs to the dialog, not to the cockpit
    expect(selectedAgent()).toBe("a1");
    dialog.remove();
    // The latch SURVIVES a press it declined — the user has not moved on, a modal merely
    // intercepted one press. So the release completes on the next real Escape.
    escape();
    expect(selectedAgent()).toBeNull();
  });
});

// ── 4. WIRING DOCKS THE OVERLAY ───────────────────────────────────────────────────────────────
describe("wiring and the overlay cannot both be true", () => {
  it("patching a cable ends a floating concierge", () => {
    render(<Workspace />);
    act(() => useCableStore.getState().overlayTo("assist"));
    expect(shell().getAttribute("data-over")).toBe("assist");
    patch("right");
    expect(shell().getAttribute("data-over")).toBe("off");
    expect(shell().getAttribute("data-wired")).toBe("right");
  });

  it("floating the concierge over a wired row unbinds it", () => {
    render(<Workspace />);
    patch("left");
    act(() => useCableStore.getState().overlayTo("assist"));
    expect(shell().getAttribute("data-wired")).toBe("off");
    expect(shell().getAttribute("data-over")).toBe("assist");
  });
});

// ── 5. THE SECOND PAIR ────────────────────────────────────────────────────────────────────────
//
// The left half of `TERM │ BUILD │ CONCIERGE │ BUILD │ TERM`. The interesting assertions here are
// not "does a second column appear" — they are about OWNERSHIP: a project's panes must be mounted
// in exactly one stage. Zero means dead terminals under a live tab; two means two xterms on one
// PTY, which is what `pty_spawn`'s `sessions.insert` orphans a child process over.
describe("the second pair", () => {
  /** Two projects, both visited so both sets of panes are eligible to mount. */
  const twoProjects = () => {
    useProjectStore.setState({
      projects: [
        mkProject("p1", "Alpha", [mkAgent("a1")], "a1"),
        mkProject("p2", "Beta", [mkAgent("a2")], "a2"),
      ],
      selectedProjectId: "p1",
    } as never);
    useRuntimeStore.setState({ openAgentIds: ["a1", "a2"], status: {} } as never);
    markProjectVisited("p1");
    markProjectVisited("p2");
  };
  const sendLeft = (id: string) =>
    act(() => useUiStore.getState().assignProjectToPair(id, "left"));

  it("renders ONE pair until something is assigned to the left", () => {
    // The upgrade path: an install that has never used the left pair must get byte-identical
    // layout to the shell it had, which is what the sparse "absent means right" map buys.
    twoProjects();
    render(<Workspace />);
    expect(shell().getAttribute("data-pairs")).toBe("1");
    expect(screen.queryByTestId("pair-left")).toBeNull();
  });

  it("renders the left pair as soon as a project is sent there", () => {
    twoProjects();
    render(<Workspace />);
    sendLeft("p2");
    expect(shell().getAttribute("data-pairs")).toBe("2");
    expect(screen.getByTestId("pair-left")).toBeTruthy();
  });

  // THE INVARIANT. Not "the left pane exists" — that would pass with the pane rendered in both
  // stages, which is the failure mode that costs a user their terminal.
  it("mounts each project's panes in EXACTLY ONE stage", () => {
    twoProjects();
    render(<Workspace />);
    sendLeft("p2");

    // Exactly one of each — never two.
    expect(screen.getAllByTestId("pane-a1")).toHaveLength(1);
    expect(screen.getAllByTestId("pane-a2")).toHaveLength(1);
    // …and each in ITS OWN pair's stage.
    const left = screen.getByTestId("terminal-stage-left");
    const right = screen.getByTestId("terminal-stage");
    expect(left.contains(screen.getByTestId("pane-a2"))).toBe(true);
    expect(left.contains(screen.getByTestId("pane-a1"))).toBe(false);
    expect(right.contains(screen.getByTestId("pane-a1"))).toBe(true);
    expect(right.contains(screen.getByTestId("pane-a2"))).toBe(false);
  });

  it("gives each pair its own tab strip, listing only that pair's projects", () => {
    twoProjects();
    render(<Workspace />);
    sendLeft("p2");
    const leftPair = screen.getByTestId("pair-left");
    const rightPair = screen.getByTestId("pair-right");
    // A tab naming a project the OTHER pair holds would let a click select a project whose panes
    // are mounted in the other stage — agent rows with no terminal beside them.
    expect(leftPair.textContent).toContain("Beta");
    expect(leftPair.textContent).not.toContain("Alpha");
    expect(rightPair.textContent).toContain("Alpha");
    expect(rightPair.textContent).not.toContain("Beta");
  });

  it("collapses back to one pair when the last left project is sent back", () => {
    // Derived from the assignment map, so "an empty left pair" is unrepresentable rather than a
    // state someone has to remember to clean up.
    twoProjects();
    render(<Workspace />);
    sendLeft("p2");
    expect(shell().getAttribute("data-pairs")).toBe("2");
    act(() => useUiStore.getState().assignProjectToPair("p2", "right"));
    expect(shell().getAttribute("data-pairs")).toBe("1");
    expect(screen.queryByTestId("pair-left")).toBeNull();
    // The panes came back rather than vanishing with the pair.
    expect(screen.getAllByTestId("pane-a2")).toHaveLength(1);
  });

  it("does not let the left pair move the app-wide current project", () => {
    // `selectedProjectId` means "the current project" to the concierge feed, notifications, capture
    // and satellite ownership. The left pair having its own slot is what keeps those ten call sites
    // meaning what they meant.
    twoProjects();
    render(<Workspace />);
    sendLeft("p2");
    expect(useProjectStore.getState().selectedProjectId).toBe("p1");
  });

  it("drops a stale assignment when its project is gone", () => {
    // Otherwise the entry keeps the pair open forever with no tab in it and no way to close it.
    twoProjects();
    render(<Workspace />);
    sendLeft("p2");
    expect(shell().getAttribute("data-pairs")).toBe("2");
    act(() => {
      useProjectStore.setState({
        projects: [mkProject("p1", "Alpha", [mkAgent("a1")], "a1")],
        selectedProjectId: "p1",
      } as never);
    });
    expect(shell().getAttribute("data-pairs")).toBe("1");
    expect(useUiStore.getState().pairAssignment).toEqual({});
  });

  // THE RELAUNCH SHAPE — the bug the tests above could not see, because `twoProjects()` marks both
  // projects visited by hand and so pre-satisfies the mount gate. `pairAssignment`/`leftProjectId`
  // are PERSISTED; the visited set is module-level and is NOT. So a cold launch restores a left pair
  // whose strip and sidebar are full while its stage is blank, and no click can repair it because
  // the gate is per PROJECT. (roborev 55149)
  it("mounts the left pair's panes on a cold launch, with nothing visited", () => {
    useProjectStore.setState({
      projects: [
        mkProject("p1", "Alpha", [mkAgent("a1")], "a1"),
        mkProject("p2", "Beta", [mkAgent("a2")], "a2"),
      ],
      selectedProjectId: "p1",
    } as never);
    useRuntimeStore.setState({ openAgentIds: ["a1", "a2"], status: {} } as never);
    // Exactly what a relaunch looks like: assignment restored from the blob, visited set empty.
    resetVisitedProjects();
    useUiStore.setState({ pairAssignment: { p2: "left" }, leftProjectId: "p2" } as never);

    render(<Workspace />);

    expect(screen.getByTestId("pair-left")).toBeTruthy();
    const left = screen.getByTestId("terminal-stage-left");
    expect(left.contains(screen.getByTestId("pane-a2"))).toBe(true);
  });

  // Every cross-app "show me this project" path funnels through `openProjectTab` — notifications,
  // the palette, history, the concierge and its tools. Before this it always wrote the RIGHT pair's
  // selection, so revealing a left-pair agent either did nothing or yanked the right pair away.
  it("routes a reveal of a left-assigned project INTO the left pair", () => {
    twoProjects();
    render(<Workspace />);
    sendLeft("p2");
    act(() => useProjectStore.getState().selectProject("p1"));
    act(() => openProjectTab("p2"));
    expect(useUiStore.getState().leftProjectId).toBe("p2");
    // …and it did NOT drag the right pair off its own project.
    expect(useProjectStore.getState().selectedProjectId).toBe("p1");
  });

  // Assigning alone left the destination pair's selection where it was, so sending a SECOND project
  // across mounted its panes invisibly and the control read as "does nothing but grow a tab".
  it("moves the selection with the project", () => {
    useProjectStore.setState({
      projects: [
        mkProject("p1", "Alpha", [mkAgent("a1")], "a1"),
        mkProject("p2", "Beta", [mkAgent("a2")], "a2"),
        mkProject("p3", "Gamma", [mkAgent("a3")], "a3"),
      ],
      selectedProjectId: "p1",
    } as never);
    useRuntimeStore.setState({ openAgentIds: ["a1", "a2", "a3"], status: {} } as never);
    markProjectVisited("p1");
    markProjectVisited("p2");
    markProjectVisited("p3");
    render(<Workspace />);
    sendLeft("p2");
    act(() => openProjectTab("p2"));
    expect(useUiStore.getState().leftProjectId).toBe("p2");
    // Now send a second one across; the left pair must follow it rather than stay on Beta.
    sendLeft("p3");
    act(() => openProjectTab("p3"));
    expect(useUiStore.getState().leftProjectId).toBe("p3");
    expect(screen.getByTestId("terminal-stage-left").contains(screen.getByTestId("pane-a3"))).toBe(true);
  });
});
