// @vitest-environment jsdom
//
// CLICKING A ROW MOUNTS THE CONCIERGE TO THAT AGENT — end to end, through the REAL sidebar.
//
// ── WHY THIS FILE EXISTS: THE SEAM NEITHER SUITE COVERED ──────────────────────────────────────
//
// The cable had two test suites and a hole exactly between them, and the hole is the shape of the
// bug the founder reported ("I clicked the row, the concierge did not connect"):
//
//   • `AgentSidebar.patchCable.test.tsx` renders the REAL sidebar and clicks a REAL row — then
//     asserts `useCableStore.getState().wired`. It stops AT THE STORE.
//   • `Workspace.cockpit.test.tsx` renders the REAL shell and asserts `data-wired` on the root —
//     but it MOCKS the sidebar with a hand-built `<div role="treeitem">` and patches by calling
//     `useCableStore.getState().patch(side)` directly. It starts AT THE STORE.
//
// Each suite assumes the other half works. Neither ever runs the real click through to the real
// DOM, so any break in the wire between "the sidebar decided a side" and "the shell projected it"
// is invisible to a fully green suite — which is precisely what a user reports as "the mount is
// broken" while CI stays green.
//
// So every case below drives the GESTURE (a click on a row the real sidebar rendered) and asserts
// the SIDE EFFECT the founder can actually see (the shell root's `data-wired`, the row's bold).
// Nothing here calls `patch`. AGENTS.md: assert the side effect, not the precondition.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

// ── Tauri surface, as the cockpit suite mocks it ───────────────────────────────────────────────
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
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));

// PARTIAL — the real sidebar (unmocked here, unlike in the cockpit suite) reads APP_WINDOW_LABEL
// off this module, so a whole-module replacement throws at render.
vi.mock("../windowContext", async (orig) => {
  const { useProjectStore } = await import("../stores/projectStore");
  return {
    ...(await orig<typeof import("../windowContext")>()),
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
vi.mock("../services/branchStatus", () => ({
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
}));
// PARTIAL — the real module also exports the reserved-id constants this render tree imports
// transitively; a whole-module mock drops them and fails somewhere unrelated.
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
  sparkleAgentIdFor: () => "sparkle",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));

// THE SIDEBAR IS DELIBERATELY *NOT* MOCKED. That mock is the hole this file exists to close — a
// stub row cannot exercise `onSelect → selectAndWire → patchCable(pairSide)`, which is the code
// under test. Everything else heavy is stubbed so the failure surface stays the cable.
vi.mock("./AgentPane", () => ({
  AgentPane: ({ agent }: { agent: { id: string } }) => <div data-testid={`pane-${agent.id}`} />,
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
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

import { Workspace } from "./Workspace";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuthStore } from "../stores/authStore";
import { useConnectionStore } from "../stores/connectionStore";
import { resetVisitedProjects } from "../services/sessionProjects";
import { resetCable, useCableStore } from "../stores/cableStore";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string, name: string): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}
function mkProject(id: string, name: string, agents: AgentTab[], selectedAgentId: string | null): Project {
  return {
    id, name, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: selectedAgentId as never, agents,
  };
}

// The founder's own fixture: the row they clicked was "Talk/Send Mode Slider".
const SLIDER = "Talk/Send Mode Slider";
const OTHER = "Stripe checkout retry";
/** A row in the OTHER pair — the only way "the cable moved" is observable at all. */
const FAR = "Windows port smoke test";

const shell = () => screen.getByTestId("workspace-shell");
/**
 * The real sidebar's row for `name`.
 *
 * DISAMBIGUATES HERE, not at the call site. This was `screen.getByText(name).closest(…)`, an
 * UNSCOPED `getByText` that throws on multiple matches — so an agent's name rendering a second time
 * anywhere in the shell (a pane header, a tab label, a breadcrumb) killed every case that used it
 * with "found multiple elements", from inside this helper. Scoping a caller with
 * `within(rowFor(name))` could not fix that, because this unscoped query runs FIRST (roborev 55718).
 *
 * So: take ALL renderings of the name, keep the ones inside a row, and require exactly one ROW. A
 * second rendering outside a row is now ignored; two matching rows still fail, loudly and by name.
 */
const rowFor = (name: string): HTMLElement => {
  const rows = screen
    .getAllByText(name)
    .map((el) => el.closest('[data-hint="agent"]'))
    .filter((el): el is HTMLElement => el !== null);
  const unique = Array.from(new Set(rows));
  if (unique.length !== 1) {
    throw new Error(`expected exactly one agent row for "${name}", found ${unique.length}`);
  }
  return unique[0] as HTMLElement;
};

beforeEach(() => {
  useProjectStore.setState({
    projects: [mkProject("p1", "Alpha", [mkAgent("a1", OTHER), mkAgent("a2", SLIDER)], "a1")],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: ["a1", "a2"], status: {} } as never);
  useUiStore.setState({
    activeSpecial: null, workModeBySide: { left: "build", right: "build" }, pinnedProjectId: null, openProjectIds: null,
    pairAssignment: {}, leftProjectId: null,
    collapsedOrchestrators: {}, autoExpandedOrchestrators: {},
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

describe("clicking an agent row mounts the concierge to it", () => {
  it("is unmounted at rest — the concierge talks to Sparkle until asked otherwise", () => {
    render(<Workspace />);
    expect(shell().getAttribute("data-wired")).toBe("off");
  });

  // THE FOUNDER'S EXACT GESTURE, and the one no suite ran: a click on a row the REAL sidebar
  // rendered, asserted on the shell root the CSS keys off. If the wire between the sidebar's
  // `patchCable(pairSide)` and the shell's `data-wired` is broken anywhere, this is the case that
  // fails — and it is the only one that can.
  it("projects the mount onto the shell root, from a real row click", () => {
    render(<Workspace />);
    fireEvent.click(rowFor(SLIDER));
    expect(shell().getAttribute("data-wired")).toBe("right");
  });

  it("mounts to the LEFT pair's agent when that is where the project lives", () => {
    act(() => {
      useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
    });
    render(<Workspace />);
    fireEvent.click(rowFor(SLIDER));
    expect(shell().getAttribute("data-wired")).toBe("left");
  });

  // The founder's words: "that one row would be bold". The mount has to be legible ON THE ROW.
  //
  // BUT BOLD IS NOT A CABLE SIGNAL, and this case used to claim it was. The weight comes from
  // `rowTitleWeight(isActive)` where `isActive` is `project.selectedAgentId === a.id` — pure
  // SELECTION. `onSelect` calls `selectAgent` before `patchCable`, so the assertion passed against
  // the exact broken code where `patch` was never called at all, and it stays true after Escape
  // while `data-wired` is "off". So bold alone cannot tell the user where their typing goes, which
  // was this case's whole stated rationale (roborev 55529).
  //
  // Both facts are now asserted, and kept apart: bold tracks SELECTION (still the founder's visual
  // ask, and it must survive an unmount), while the CABLE-derived signal is the pair's own
  // `data-wired-pair` — which really does appear and disappear with the mount.
  it("bolds the selected row, and lights the pair only while mounted", () => {
    render(<Workspace />);
    fireEvent.click(rowFor(SLIDER));

    // Read the weight off the TITLE element specifically. The old helper took the first descendant
    // declaring any inline font-weight, which need not be the title, and its `|| 400` fallbacks
    // silently substituted a default when nothing was found — so a pass could come from unrelated
    // chrome, or from no weight existing anywhere.
    // SCOPED TO THE ROW, mirroring `rowFor`. A bare `screen.getByText(name)` throws on multiple
    // matches, and an agent's name can legitimately render more than once in the shell (a row title
    // plus a pane header or tab label) — most likely for the agent just mounted, which is exactly
    // this case. Unscoped, an unrelated UI addition that echoes the name turns this into "found
    // multiple elements" rather than a signal about weight (roborev 55704).
    const titleWeight = (name: string) => {
      const title = within(rowFor(name)).getByText(name) as HTMLElement;
      const declared = title.style.fontWeight || getComputedStyle(title).fontWeight;
      if (!declared) throw new Error(`no font-weight on the title for "${name}"`);
      return Number(declared);
    };
    expect(titleWeight(SLIDER)).toBeGreaterThan(titleWeight(OTHER));

    // THE CABLE-DERIVED HALF. This is the one that distinguishes mounted from merely selected.
    const pair = () => screen.getByTestId("pair-right");
    expect(pair().getAttribute("data-wired-pair")).toBe("true");

    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    // Unmounted: the pair goes dark, and the row STAYS bold because it is still the selected agent.
    // That contrast is the point — it is what proves the two signals are independent, and it is what
    // the old single assertion could not have shown.
    expect(pair().getAttribute("data-wired-pair")).toBe("false");
    expect(titleWeight(SLIDER)).toBeGreaterThan(titleWeight(OTHER));
  });

  // ── UNMOUNT ─────────────────────────────────────────────────────────────────────────────────
  // A mount fix that leaks a stale binding is worse than no mount: the cable stays drawn to a row
  // the user has left, and their next message goes somewhere they are not looking.
  it("ESCAPE unmounts, leaving no stale binding behind", () => {
    render(<Workspace />);
    fireEvent.click(rowFor(SLIDER));
    expect(shell().getAttribute("data-wired")).toBe("right");
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(shell().getAttribute("data-wired")).toBe("off");
    // The STORE must be clear too, not merely the projection — a projection that reads "off" over a
    // store still holding "right" re-lights the cable the moment anything else re-renders.
    expect(useCableStore.getState().wired).toBe("off");
  });

  // OUTSIDE THE CIRCUIT, not merely "off a row". The wired pair's OWN terminal is deliberately part
  // of the live circuit (engine/cable's CIRCUIT_SELECTOR) — patch-then-type is the primary flow, and
  // an earlier cut that unbound on any non-row press dropped the cable on the first click
  // (roborev 54697). So the press that must unmount is one on the shell chrome itself.
  it("clicking outside the circuit unmounts", () => {
    render(<Workspace />);
    fireEvent.click(rowFor(SLIDER));
    expect(shell().getAttribute("data-wired")).toBe("right");
    act(() => {
      fireEvent.pointerDown(shell());
    });
    expect(shell().getAttribute("data-wired")).toBe("off");
    expect(useCableStore.getState().wired).toBe("off");
  });

  // The counterpart, and the reason the case above cannot just target any non-row element: pressing
  // the terminal of the agent you are mounted to must KEEP the mount.
  it("pressing the mounted agent's own terminal does NOT unmount", () => {
    render(<Workspace />);
    fireEvent.click(rowFor(SLIDER));
    act(() => {
      fireEvent.pointerDown(screen.getByTestId("terminal-stage"));
    });
    expect(shell().getAttribute("data-wired")).toBe("right");
  });

  // ONE LIVE CIRCUIT — the cable MOVES, it never lights both pairs.
  //
  // This case used to click two rows that both lived in project p1, i.e. both on the RIGHT pair, so
  // `data-wired` read "right" before, during and after — a broken move, or no second patch at all,
  // was indistinguishable from a working one. Its companion count assertion was worse: with
  // ConciergeHost mocked, the shell root is the ONLY element in the tree carrying `data-wired`, so
  // `:not([data-wired="off"])` could never exceed 1 even at rest with zero clicks (roborev 55529).
  //
  // So the second click now lands in the OTHER pair, and the assertions are on the per-pair
  // attributes, which genuinely exist on both sides and genuinely flip.
  it("clicking a row in the other pair MOVES the mount rather than lighting two", () => {
    // MERGED into what `beforeEach` established, not substituted for it. These are `as never` casts,
    // so TypeScript cannot warn that a wholesale replacement dropped a field the pair layout depends
    // on — the cast defeats exactly the check that would have caught it (roborev 55704).
    act(() => {
      useProjectStore.setState({
        ...useProjectStore.getState(),
        projects: [
          mkProject("p1", "Alpha", [mkAgent("a1", OTHER), mkAgent("a2", SLIDER)], "a2"),
          mkProject("p2", "Beta", [mkAgent("b1", FAR)], "b1"),
        ],
        selectedProjectId: "p1",
      } as never);
      useRuntimeStore.setState({
        ...useRuntimeStore.getState(),
        openAgentIds: ["a1", "a2", "b1"],
      } as never);
      // p2 on the left, p1 left where it is on the right — so the two clicks land in different pairs.
      useUiStore.setState({
        ...useUiStore.getState(),
        openProjectIds: ["p1", "p2"], pairAssignment: { p2: "left" }, leftProjectId: "p2",
      } as never);
    });
    render(<Workspace />);

    const left = () => screen.getByTestId("pair-left").getAttribute("data-wired-pair");
    const right = () => screen.getByTestId("pair-right").getAttribute("data-wired-pair");

    // ASSERT THE FIXTURE'S PREMISE BEFORE EXERCISING IT. The whole case rests on the two rows living
    // in DIFFERENT pairs. If the layout degrades to both projects on the right, `pair-left` can still
    // exist while FAR's row sits on the right — and the final `["true", "false"]` assertion would
    // then be asserting something else entirely, passing or failing for reasons unrelated to the
    // cable. This makes that degradation read as "the fixture broke" (roborev 55704).
    // `[data-pair]`, not `[data-testid^="pair-"]` — the latter also matches the inner `pair-cols-*`
    // wrapper, which is nearer the row and would have made this read "pair-cols-right".
    const pairOf = (name: string) =>
      rowFor(name).closest("[data-pair]")?.getAttribute("data-testid");
    expect(pairOf(SLIDER)).toBe("pair-right");
    expect(pairOf(FAR)).toBe("pair-left");

    fireEvent.click(rowFor(SLIDER));
    expect(shell().getAttribute("data-wired")).toBe("right");
    expect([left(), right()]).toEqual(["false", "true"]);

    // The move. `data-wired` flips right → left, which the single-pair version could never observe.
    fireEvent.click(rowFor(FAR));
    expect(shell().getAttribute("data-wired")).toBe("left");
    // AND ONLY ONE IS LIT. Falsifiable now: both attributes exist, so "lighting two" is a state this
    // assertion can actually catch.
    expect([left(), right()]).toEqual(["true", "false"]);
  });

  // Hover PREVIEWS, click COMMITS. A cursor crossing the column must not mount anything — the
  // founder wants hover to show a terminal, and a mount that follows the mouse would re-route
  // their typing to whatever row they last passed over.
  //
  // `mouseOver`, NOT `mouseEnter`. React synthesizes `onMouseEnter` from DELEGATED mouseover/mouseout
  // listeners on the root container and never binds a native `mouseenter`, so `fireEvent.mouseEnter`
  // invokes nothing at all: `armSelect` never runs, no 90ms timer is armed, and advancing the clock
  // advances nothing. The assertion was then just the at-rest precondition — the case could not fail,
  // and hover-patching could have been reintroduced under a green test (roborev 55529). This repo
  // already documents the correct form at AgentSidebar.agentRow.test.tsx:113.
  it("hovering does NOT mount, however long the cursor rests", () => {
    vi.useFakeTimers();
    try {
      render(<Workspace />);
      fireEvent.mouseOver(rowFor(SLIDER));
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      // THE POSITIVE CONTROL, and the whole reason this case now proves anything: the dwell really
      // did fire — hover-intent SELECTED the row (`onSelect(id, "hover")` calls `selectAgent`) — so
      // a green result means "the timer ran and the cable stayed off", not "nothing happened".
      // Without this, a silently-inert gesture is indistinguishable from a correctly ignored one.
      expect(useProjectStore.getState().projects[0]?.selectedAgentId).toBe("a2");
      expect(shell().getAttribute("data-wired")).toBe("off");
      expect(useCableStore.getState().wired).toBe("off");
    } finally {
      vi.useRealTimers();
    }
  });
});
