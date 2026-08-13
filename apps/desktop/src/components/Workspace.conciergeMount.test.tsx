// @vitest-environment jsdom
//
// DOUBLE-CLICKING A ROW MOUNTS THE CONCIERGE TO THAT AGENT — end to end, through the REAL sidebar.
//
// It was a SINGLE click until 2026-08-12, when the founder split the two gestures: *"I had also
// asked for a single click to not mount the concierge. And to for a double click to be what mounts
// it."* Only the gesture moved — everything this file asserts about the mount's consequences is
// unchanged, which is why the cases below read the same with `doubleClickRow` in place of the click.
// The rule itself is `engine/cable`'s `mountsOnRowActivation`, and what a single click does INSTEAD
// is `AgentSidebar.rowMountGesture.test.tsx`.
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
import { useKeybindingsStore } from "../stores/keybindingsStore";
import { doubleClickRow } from "../testing/rowGestures";
import type { AgentTab, Project } from "../types";
import { C } from "../theme/colors";

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
    collapsedOrchestrators: {},
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
    doubleClickRow(rowFor(SLIDER));
    expect(shell().getAttribute("data-wired")).toBe("right");
  });

  it("mounts to the LEFT pair's agent when that is where the project lives", () => {
    act(() => {
      useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
    });
    render(<Workspace />);
    doubleClickRow(rowFor(SLIDER));
    expect(shell().getAttribute("data-wired")).toBe("left");
  });

  // ── THE JOIN IS PAINTED, NOT JUST RECORDED ───────────────────────────────────────────────────
  //
  // THE SEAM THE FOUNDER REPORTED FIVE TIMES, and the reason five "fixes" did not change it: every
  // one of them asserted the mount was RECORDED (`data-wired`, the store, the pair flag) and none
  // asserted anything was PAINTED across the boundary. All of those assertions were already true
  // while the line was still on screen, so the whole suite stayed green through five rounds.
  //
  // The line was never a border. It is the shell's own ground (`bridge`) seen through the 6px
  // in-flow rail that separates the concierge from the build column — a HOLE, which no amount of
  // border removal can close, and which the row cannot cover from its own side because
  // `agent-list-scroll` is `overflow:auto` and clips at the column's edge.
  //
  // These cases assert the FILL: the element that closes the hole, on the correct seam, in the same
  // token the concierge floods with. Measured proof that the pixels are actually continuous lives in
  // `scripts/visual/seam-probe.mjs` — jsdom computes no layout and cannot settle a pixel question
  // (see the `jsdom cannot verify CSS clamps` note); what jsdom CAN prove is that the fill exists,
  // carries the joined plane, and is absent when it must not paint. Both halves are needed.
  describe("the mounted row's plane runs unbroken into the concierge", () => {
    const fill = () => document.querySelector('[data-testid="concierge-pull-tab-fill"]');

    it("paints nothing at rest — an unmounted concierge separates by its lift shadow", () => {
      render(<Workspace />);
      // Filling the rail here would paint over the ONLY thing holding the unwired edge apart: the
      // fill step alone measures under EDGE_MIN_CONTRAST, so the shadow is the separation.
      expect(fill()).toBeNull();
    });

    it("closes the seam with the concierge's own plane when a row is clicked", () => {
      render(<Workspace />);
      expect(fill()).toBeNull();

      doubleClickRow(rowFor(SLIDER));

      const el = fill() as HTMLElement | null;
      expect(el).not.toBeNull();
      // THE JOINED PLANE, by token. `C.forest` is `var(--c-forest)` = `BLUEPRINT[mode].term` — the
      // exact value the concierge floods with and the selected row paints in, which is what makes
      // the three surfaces one plane in BOTH themes rather than three colours that agree in dark.
      expect((el as HTMLElement).style.background).toBe(C.forest);
    });

    it("un-paints it when the cable is dropped", () => {
      render(<Workspace />);
      doubleClickRow(rowFor(SLIDER));
      expect(fill()).not.toBeNull();

      act(() => {
        useCableStore.getState().unbind();
      });
      expect(fill()).toBeNull();
    });

    // WHICH SEAM. The concierge has a rail on each side and only the one facing the pair that holds
    // the cable is a joint; filling both would paint a plane onto a boundary that is still a
    // boundary. With the project in the LEFT pair the RIGHT-hand rail must stay clear.
    //
    // BOTH HALVES, and the positive one is the point. Asserting only that the RIGHT rail is clear
    // was itself a vacuous test of the very kind this file exists to end: assigning a project left
    // makes `pairCountFor` return 2, so `left-pair-pull-tab` really is mounted here — and flipping
    // its prop to `shownWired === "right"`, or dropping it outright, would have left every case in
    // this file green with the founder's seam back in the two-pair cockpit (roborev 57327). An
    // absence assertion cannot notice a fill that never appears.
    // THE LEFT RAIL'S *CONDITION*, not just its truthy branch. The positive case above runs in the
    // one state where the condition is true, and the other cases run single-pair — where
    // `left-pair-pull-tab` is not mounted at all, so its fill is trivially absent. So
    // `seamFill={C.forest}` unconditional would have left the whole file green while the two-pair
    // cockpit painted the joined plane across the left rail AT REST, i.e. a plane onto a boundary
    // that is still a boundary (roborev 57352). The right rail already has its negatives
    // ("paints nothing at rest", "un-paints it"); this is the left rail's.
    it("leaves the LEFT rail unpainted at rest, even with two pairs mounted", () => {
      act(() => {
        useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
      });
      render(<Workspace />);

      // Two pairs, so the left rail IS mounted — its fill being absent is a real observation here,
      // not the vacuous absence of an unmounted component.
      expect(document.querySelector('[data-testid="left-pair-pull-tab"]')).not.toBeNull();
      expect(shell().getAttribute("data-wired")).toBe("off");
      expect(document.querySelector('[data-testid="left-pair-pull-tab-fill"]')).toBeNull();
    });

    // THE OTHER HALF OF THE LEFT RAIL'S CONDITION — and the mutant it kills is the founder's defect
    // verbatim: the joined plane painted across the LEFT rail while the cable sits on the RIGHT
    // pair, i.e. a plane onto a boundary that is still a boundary.
    //
    // The at-rest case above only pins `shownWired === "off"`, so `shownWired !== "off"` would have
    // left every case in this file green — the two-pair cases were at-rest (mutant paints nothing)
    // and cable-left (mutant paints exactly what is expected). The mirror rail was already protected
    // against this by "fills the LEFT rail, and only that rail"; the asymmetry WAS the gap
    // (roborev 57377). A previous commit message claimed this state was covered. It was not.
    it("leaves the LEFT rail unpainted while the cable sits on the RIGHT pair", () => {
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
        // p2 on the LEFT, p1 stays on the right — the same fixture the MOVES case builds.
        useUiStore.setState({
          ...useUiStore.getState(),
          openProjectIds: ["p1", "p2"], pairAssignment: { p2: "left" }, leftProjectId: "p2",
        } as never);
      });
      render(<Workspace />);
      // Click a row in the RIGHT pair.
      doubleClickRow(rowFor(SLIDER));

      expect(shell().getAttribute("data-wired")).toBe("right");
      // The left rail is MOUNTED (two pairs), so its empty fill is a real observation.
      expect(document.querySelector('[data-testid="left-pair-pull-tab"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="left-pair-pull-tab-fill"]')).toBeNull();
      // …and the rail that IS the joint does paint.
      expect(fill()).not.toBeNull();
    });

    it("fills the LEFT rail, and only that rail, when the left pair holds the cable", () => {
      act(() => {
        useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
      });
      render(<Workspace />);
      doubleClickRow(rowFor(SLIDER));

      expect(shell().getAttribute("data-wired")).toBe("left");

      const left = document.querySelector('[data-testid="left-pair-pull-tab-fill"]') as HTMLElement | null;
      expect(left).not.toBeNull();
      expect((left as HTMLElement).style.background).toBe(C.forest);
      // …and the concierge's other boundary is still a boundary.
      expect(fill()).toBeNull();
    });
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
    doubleClickRow(rowFor(SLIDER));

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
    doubleClickRow(rowFor(SLIDER));
    expect(shell().getAttribute("data-wired")).toBe("right");
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(shell().getAttribute("data-wired")).toBe("off");
    // The STORE must be clear too, not merely the projection — a projection that reads "off" over a
    // store still holding "right" re-lights the cable the moment anything else re-renders.
    expect(useCableStore.getState().wired).toBe("off");
  });

  // ── AND THE CHORD, READ LIVE ────────────────────────────────────────────────────────────────
  // The second way out, and the one that works from inside a terminal where Escape belongs to the
  // running program. Two things are asserted together on purpose:
  //
  //   1. It still unmounts a cable patched by the NEW gesture. Changing what mounts must not change
  //      what unmounts — a mount with no matching exit is the wedge the founder reported as "I could
  //      not unmount the concierge".
  //   2. It follows a REBOUND binding rather than a hard-coded ⌘⇧U. The chord is rebindable, so a
  //      literal would be a shortcut that silently does nothing for anyone who moved it. Rebinding it
  //      here and firing the NEW keys is what makes that falsifiable: firing ⌘⇧U instead would pass
  //      against a hard-coded handler.
  it("the rebindable unmount chord unmounts too, read LIVE from the binding", () => {
    useKeybindingsStore.getState().setBinding("unmountCable", {
      kind: "chord",
      meta: true,
      ctrl: false,
      alt: true,
      shift: false,
      key: "k",
    });
    try {
      render(<Workspace />);
      doubleClickRow(rowFor(SLIDER));
      expect(shell().getAttribute("data-wired")).toBe("right");
      act(() => {
        fireEvent.keyDown(window, { key: "k", metaKey: true, altKey: true });
      });
      expect(shell().getAttribute("data-wired")).toBe("off");
      expect(useCableStore.getState().wired).toBe("off");
    } finally {
      // PERSISTED store — a rebind left behind follows every later case in this worker.
      useKeybindingsStore.getState().resetBinding("unmountCable");
    }
  });

  // OUTSIDE THE CIRCUIT, not merely "off a row". The wired pair's OWN terminal is deliberately part
  // of the live circuit (engine/cable's CIRCUIT_SELECTOR) — patch-then-type is the primary flow, and
  // an earlier cut that unbound on any non-row press dropped the cable on the first click
  // (roborev 54697). So the press that must unmount is one on the shell chrome itself.
  it("clicking outside the circuit unmounts", () => {
    render(<Workspace />);
    doubleClickRow(rowFor(SLIDER));
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
    doubleClickRow(rowFor(SLIDER));
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

    doubleClickRow(rowFor(SLIDER));
    expect(shell().getAttribute("data-wired")).toBe("right");
    expect([left(), right()]).toEqual(["false", "true"]);

    // The move. `data-wired` flips right → left, which the single-pair version could never observe.
    doubleClickRow(rowFor(FAR));
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
  // invokes nothing at all — the gesture would not be delivered and the case could not fail
  // (roborev 55529). This repo documents the correct form at AgentSidebar.agentRow.test.tsx:113.
  //
  // ── THE POSITIVE CONTROL HAD TO CHANGE. ─────────────────────────────────────────────────────
  // It used to be "hover-intent SELECTED the row, and the cable stayed off" — proving the dwell
  // timer really fired. Selection is click-only now, so hover selects nothing and that control is
  // gone; asserting only "nothing happened" would be exactly the vacuous shape the note above
  // warns about, since an undelivered gesture looks identical.
  //
  // So the control moved to the END: after resting on the row we CLICK it, and that must mount.
  // A green result therefore means "this harness can observe a mount on this row, and hovering it
  // did not produce one" — not "nothing in this test does anything".
  it("hovering does NOT mount or select, however long the cursor rests", () => {
    vi.useFakeTimers();
    try {
      render(<Workspace />);
      const before = useProjectStore.getState().projects[0]?.selectedAgentId;
      fireEvent.mouseOver(rowFor(SLIDER));
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      // Well past the 90ms dwell the removed hover-intent gate used, and past any longer one a
      // future edit might reinstate.
      expect(useProjectStore.getState().projects[0]?.selectedAgentId).toBe(before);
      expect(shell().getAttribute("data-wired")).toBe("off");
      expect(useCableStore.getState().wired).toBe("off");

      // THE POSITIVE CONTROL: the same row, clicked, DOES mount.
      doubleClickRow(rowFor(SLIDER));
      expect(useProjectStore.getState().projects[0]?.selectedAgentId).toBe("a2");
      expect(useCableStore.getState().wired).not.toBe("off");
    } finally {
      vi.useRealTimers();
    }
  });
});
