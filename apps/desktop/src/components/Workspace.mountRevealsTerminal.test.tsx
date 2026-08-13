// @vitest-environment jsdom
//
// MOUNTING AN AGENT MUST PUT ITS TERMINAL ON SCREEN — even when the column is showing something
// else. Founder, 2026-08-13, asked what the pane should show when you mount the concierge onto
// agent X: *"X's terminal, always — Mounting is also a selection: the terminal pane follows the
// MOUNTED agent, and shows X's live terminal immediately."*
//
// ══ THE HALF-STATE THIS PINS ═══════════════════════════════════════════════════════════════════
//
// A pair's stage shows exactly one of three things, chosen by `uiStore.workModeBySide[side]` plus
// the window-global `activeSpecial`. `Workspace` turns that into the ONE value the panes read:
//
//   paneVisibleAgentId.right = sparkleActive || boardActive || previewActive ? null : activeAgentId
//
// `null` means NO AgentPane is visible on that side (`Workspace`'s `visible = agent.id ===
// visibleAgentId[side]` can then match nothing). So a mount that moves the SELECTION but leaves the
// column in Plan/Preview — or under the Improve-Sparkle pane — seats an agent nobody can see. The
// concierge says "Chatting with X" while no terminal for X ever appears, which is the report.
//
// `uiStore` already owns the fix and says so at its declaration (uiStore.ts:350-352): `showBuildStage`
// puts a column into Build **and** makes its stage actually visible, and *"anything meaning 'show me
// the terminal/rows' uses this, not a bare `setWorkMode`"*. The Build chevron (`onPickBuild`) used it;
// the row gestures did not — they cleared `activeSpecial` by hand and never touched the mode.
//
// ONE CALL SITE CARRIES ALL OF IT: `AgentSidebar.onSelect`. `onMount` deliberately has no copy,
// because there is no route to it that has not already been through `onSelect` —
// `AgentRow.onRowClick` seats the row on its first line for every click (AgentRow.tsx:458), AT
// activations included, and a double press is two of those before the `dblclick`. That is why the
// double-click cases below matter even though a single click reveals the stage on its own: they are
// what holds that ordering. If `AgentRow` ever mounts without seating first, they go red.
//
// ══ WHERE THE BUG IS ACTUALLY REACHABLE, MEASURED RATHER THAN ASSUMED ══════════════════════════
//
// The three covering surfaces are NOT symmetric, because the sidebar renders differently under each.
// This was probed against the real shell before the cases below were written, and the answers decide
// which gestures can even be performed:
//
//   PREVIEW  → the row list RENDERS (AgentSidebar's list only short-circuits on "plan"). Both row
//              gestures are reachable, and the pane is present-but-hidden. THE BUG, end to end.
//   SPARKLE  → the column renders in full, INCLUDING "+ Local Agent". The spawn path reaches
//              `selectAndWire`, which never cleared the special. THE BUG, by a different gesture.
//   PLAN     → the list returns `null` (AgentSidebar.tsx:2797 — "sidebar list stays clear"), so
//              there are NO rows to click and the pane is not even portalled (its stage is gone).
//              A row gesture is UNREACHABLE here, so a "double-click a row in Plan mode" case would
//              be testing a state no user can produce. It gets a REACHABILITY GUARD below instead,
//              which fails the day that stops being true — see that case's own note.
//
// ══ WHAT IS ASSERTED ═══════════════════════════════════════════════════════════════════════════
//
// The SIDE EFFECT the user sees, never the input. `workMode === "build"` is the input — asserting it
// would pass against a version that sets the mode and still renders no pane. These assert the pane's
// own rendered visibility, through the REAL `paneVisibilityStyle` (panes never use `display: none`;
// they stay laid out and hide with `visibility` — see components/paneVisibility.ts), so what is
// checked is the thing the founder is looking at: is agent X's terminal painted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
// The real `getCurrentWebview()` throws outside a Tauri window, and the drop hooks call it at mount
// — an unhandled rejection that kills every case before an assertion is reached.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
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
// The REAL app-owned Sparkle agent id (services/sparkleAgent.SPARKLE_AGENT_ID) — the shell gates the
// Improve-Sparkle surface on `isSparkleAgentId`, which only matches that namespace.
const SPARKLE_ID = "__sparkle_self__";
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
  sparkleAgentIdFor: () => "__sparkle_self__",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));
// The concierge's PAID brain. Nothing here sends anything; the host still mounts for real.
vi.mock("../services/concierge", () => ({
  startConciergeTurn: vi.fn(async () => null),
  startProactiveConciergeTurn: vi.fn(async () => null),
  isProactiveTurn: () => false,
  onConciergeTool: () => () => {},
  onConciergeDelta: () => () => {},
  onConciergeDone: () => () => {},
  onConciergeError: () => () => {},
  onConciergeTurnsAbandoned: () => () => {},
  isSupersededDetail: () => false,
  SUPERSEDED_DETAILS: [],
}));
vi.mock("../services/conciergeRouter", () => ({
  routeMessage: vi.fn(async () => ({ target: "sparkle", reason: "test", source: "heuristic" })),
}));

// ── THE PANE MOCKS CARRY THE REAL VISIBILITY STYLE ─────────────────────────────────────────────
// Not a bare `<div/>`: these render `paneVisibilityStyle(visible)`, the SAME helper the production
// panes use, so `getComputedStyle(...).visibility` in a case below is the real contract rather than a
// stand-in the test invented. The `visible` prop itself still comes from the real `Workspace` →
// `AgentPaneList` chain, which is the seam under test.
vi.mock("./AgentPane", async () => {
  const { paneVisibilityStyle } = await import("./paneVisibility");
  return {
    AgentPane: ({ agent, visible }: { agent: { id: string }; visible: boolean }) => (
      <div
        data-testid={`pane-${agent.id}`}
        data-visible={String(visible)}
        style={paneVisibilityStyle(visible)}
      />
    ),
  };
});
vi.mock("./SparkleAgentPane", async () => {
  const { paneVisibilityStyle } = await import("./paneVisibility");
  return {
    SparkleAgentPane: ({ visible }: { visible: boolean }) => (
      <div data-testid="sparkle-pane" data-visible={String(visible)} style={paneVisibilityStyle(visible)} />
    ),
  };
});
// The concierge column is not the subject here (Workspace.conciergeMountWiring.test.tsx owns that
// seam); stubbing it keeps the failure surface on pane visibility.
vi.mock("./ConciergeHost", () => ({ ConciergeHost: () => <div data-testid="concierge" /> }));
vi.mock("./OfflineBanner", () => ({ OfflineBanner: () => null }));
vi.mock("./ZeroCreditBanner", () => ({ ZeroCreditBanner: () => null }));
vi.mock("./ProjectModal", () => ({ ProjectModal: () => null }));
vi.mock("./ClosePrompt", () => ({ ClosePrompt: () => null }));
vi.mock("./BoardView", () => ({ BoardView: () => <div data-testid="board" /> }));
vi.mock("./Concierge/KebabMenu", () => ({ ConciergeTopRight: () => null }));
vi.mock("./OpenPrMenu", () => ({ OpenPrMenu: () => null, agentLinkForBranch: () => null }));
vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));
vi.mock("./StatusStrip", () => ({ StatusStrip: () => null }));
vi.mock("./NewCloudAgentDialog", () => ({ NewCloudAgentDialog: () => null }));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./BalanceBadge", () => ({ BalanceBadge: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

import { Workspace } from "./Workspace";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useConnectionStore } from "../stores/connectionStore";
import { resetVisitedProjects } from "../services/sessionProjects";
import { resetCable } from "../stores/cableStore";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import { doubleClickRow, openRowMenu, singleClickRow } from "../testing/rowGestures";
import type { AgentTab, Project } from "../types";

const MOUNTED = "Stripe checkout retry"; // a1
const OTHER = "Talk/Send Mode Slider"; // a2

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

const rowFor = (name: string) =>
  screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;

/**
 * IS THERE A SIDEBAR ROW FOR THIS AGENT? Used to prove a close actually tore the row down.
 *
 * Deliberately NOT `queryByText(name)`. An agent's NAME appears in surfaces that outlive its row —
 * the concierge names the agent it is mounted on — so a bare text query reports "still there" after
 * a perfectly correct close. Every match is walked, and only a `[data-hint="agent"]` ancestor counts.
 */
const rowExistsFor = (name: string) =>
  screen.queryAllByText(name).some((el) => el.closest('[data-hint="agent"]') !== null);

/**
 * The Improve-Sparkle row, which is NOT a `[data-hint="agent"]`.
 *
 * It is a pinned row rendered outside the agent list (`SparkleAgentRow`, `data-hint="improve"`) —
 * which is precisely why it survives Plan mode when every ordinary row is gone, and therefore why it
 * is the one row gesture the Plan case below can actually perform.
 */
function improveSparkleRow(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-hint="improve"]');
  if (!el) throw new Error('no [data-hint="improve"] row in the tree');
  return el;
}

/**
 * How many BUILD ROWS the column is rendering, by the same query in both directions.
 *
 * Both attributes sit on the one `<div>` AgentRow returns (AgentRow.tsx:2435 and :2455), so this is
 * a real row count and not an accidental zero. Shared by the Preview premise (expects > 0) and the
 * Plan guard (expects 0) precisely so a mistake in the selector cannot make both pass.
 */
const ROW_SELECTOR_COUNT = () =>
  document.querySelectorAll('[data-hint="agent"][role="treeitem"]').length;

/** The pane element for an agent id, or null when the shell never portalled one at all. */
const paneFor = (id: string) => document.querySelector<HTMLElement>(`[data-testid="pane-${id}"]`);

/**
 * IS THIS AGENT'S TERMINAL ON SCREEN? The one question every case here asks.
 *
 * Deliberately NOT `expect(pane).toBeTruthy()` plus a separate style read: a pane that was never
 * portalled (the Plan case, whose stage does not exist) and a pane that is portalled but hidden are
 * DIFFERENT states, and both mean "no terminal". Collapsing them here keeps every case asserting the
 * user-visible fact instead of accidentally asserting which of the two failures occurred.
 */
function terminalOnScreen(id: string): boolean {
  const el = paneFor(id);
  if (!el) return false;
  return getComputedStyle(el).visibility === "visible";
}

/**
 * Render and let React resolve the lazy pane chunks.
 *
 * `Workspace` loads `AgentPane`/`SparkleAgentPane`/`BoardView` through `lazy()`, so a bare
 * synchronous `render()` can observe the Suspense fallback rather than the panes — and "the pane is
 * absent" is exactly this file's failure signal, which would make such a case pass for the wrong
 * reason. Awaiting a pane testid is the same flush `Workspace.paneMounting.test.tsx` uses.
 *
 * `waitForPane` is opt-out for the ONE case whose premise is that no pane is portalled at all
 * (Plan), where waiting for one can only time out.
 */
async function mount(waitForPane = true) {
  render(<Workspace />);
  if (waitForPane) await screen.findAllByTestId(/^pane-/);
}

/** The shared fixture: one project, two open build agents, `a1` selected. */
function seed(opts: { mode?: string; special?: string | null; openSparkle?: boolean } = {}) {
  const { mode = "build", special = null, openSparkle = false } = opts;
  useProjectStore.setState({
    projects: [mkProject("p1", "Alpha", [mkAgent("a1", MOUNTED), mkAgent("a2", OTHER)], "a1")],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({
    openAgentIds: openSparkle ? [SPARKLE_ID, "a1", "a2"] : ["a1", "a2"],
    status: {},
  } as never);
  useUiStore.setState({
    activeSpecial: special,
    workModeBySide: { left: "build", right: mode },
    pinnedProjectId: null,
    openProjectIds: null,
    pairAssignment: {},
    leftProjectId: null,
    collapsedOrchestrators: {},
  } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useConnectionStore.setState({ isOnline: true } as never);
  enableAiEnhancementsForTests();
  resetVisitedProjects();
  resetCable();
}

afterEach(() => {
  cleanup();
  resetCable();
});

// ══ PREVIEW — the column is showing a dev-server slot, and the rows are still there ═════════════
describe("a row gesture reveals the agent's terminal from PREVIEW mode", () => {
  beforeEach(() => seed({ mode: "preview" }));

  // THE PREMISE, asserted so the two cases below are genuine transitions rather than lucky defaults.
  // Both halves matter: the row must be clickable (Preview keeps the list, unlike Plan), and the
  // terminal must start OFF SCREEN — otherwise "it is visible afterwards" proves nothing.
  it("starts with the row on screen and the terminal hidden behind the preview slot", async () => {
    await mount();
    expect(rowFor(MOUNTED)).toBeTruthy();
    // THE POSITIVE CONTROL FOR THE PLAN GUARD at the bottom of this file, which asserts this exact
    // selector counts ZERO. A "no rows" assertion is only meaningful if the selector can be non-zero
    // — a typo in it would satisfy the guard in every mode and pin nothing at all. Same query, same
    // shell, opposite expectation, so the pair cannot silently agree.
    expect(ROW_SELECTOR_COUNT()).toBeGreaterThan(0);
    // Portalled but not painted — the exact half-state. `display` stays "flex" either way, which is
    // why this reads `visibility` (see components/paneVisibility.ts).
    expect(paneFor("a1")).toBeTruthy();
    expect(terminalOnScreen("a1")).toBe(false);
  });

  // ── THE DOUBLE CLICK — a MOUNT (`onMount` → `selectAndWire`) ────────────────────────────────
  // The founder's sentence, directly: mounting shows X's live terminal immediately.
  it("double-clicking a row shows THAT agent's terminal", async () => {
    await mount();
    doubleClickRow(rowFor(MOUNTED));
    expect(terminalOnScreen("a1")).toBe(true);
  });

  // ── THE SINGLE CLICK — a SELECT (`onSelect`) ────────────────────────────────────────────────
  // Same hole, and worse in one specific way: `onSelect` also calls `requestPaneFocus(id)`, so
  // before the fix it handed the caret to a pane the user cannot see. A single click is deliberately
  // NOT a mount (it moves no cable — commit c60b17e46), but it is still "put this agent in front of
  // me", so the terminal has to appear.
  it("single-clicking a row shows THAT agent's terminal too", async () => {
    await mount();
    singleClickRow(rowFor(MOUNTED));
    expect(terminalOnScreen("a1")).toBe(true);
  });

  // ── AND ONLY THAT ONE ───────────────────────────────────────────────────────────────────────
  // The paired case. Without it, "the mounted agent's terminal is visible" is satisfied by a change
  // that reveals EVERY pane at once — which is a different bug (two stacked terminals in one stage)
  // wearing this test's green.
  it("reveals only the gestured agent, not every open pane", async () => {
    await mount();
    doubleClickRow(rowFor(MOUNTED));
    expect(terminalOnScreen("a1")).toBe(true);
    expect(terminalOnScreen("a2")).toBe(false);
  });

  // ── THE MOUNT STILL MOVES ON A LATER GESTURE ────────────────────────────────────────────────
  // Guards the fix against being read as "pin the stage to the first agent mounted". The terminal
  // pane follows the agent you last put in front of yourself; only the CABLE is pinned to the mount
  // (that split is deliberate — c60b17e46, "look at B without changing who you're talking to").
  it("moves the visible terminal to the next row gestured", async () => {
    await mount();
    doubleClickRow(rowFor(MOUNTED));
    singleClickRow(rowFor(OTHER));
    expect(terminalOnScreen("a2")).toBe(true);
    expect(terminalOnScreen("a1")).toBe(false);
  });
});

// ══ THE IMPROVE-SPARKLE PANE — a covering surface that is not a work MODE ═══════════════════════
//
// `activeSpecial === "sparkle"` forces `paneVisibleAgentId.right` to null exactly as Plan/Preview do,
// but the column renders in FULL underneath it — rows, chevrons and "+ Local Agent" all present. So
// the gestures are reachable here in a way they are not under Plan.
describe("a gesture reveals the agent's terminal from under the Improve-Sparkle pane", () => {
  beforeEach(() => seed({ mode: "build", special: "sparkle", openSparkle: true }));

  it("starts with the Sparkle pane covering the stage and no agent terminal painted", async () => {
    await mount();
    expect(terminalOnScreen("a1")).toBe(false);
  });

  it("double-clicking a row shows that agent's terminal", async () => {
    await mount();
    doubleClickRow(rowFor(MOUNTED));
    expect(terminalOnScreen("a1")).toBe(true);
  });

  it("single-clicking a row shows that agent's terminal", async () => {
    await mount();
    singleClickRow(rowFor(MOUNTED));
    expect(terminalOnScreen("a1")).toBe(true);
  });
});

// ══ PLAN — THE REACHABILITY GUARD, NOT A SKIPPED CASE ═══════════════════════════════════════════
//
// Plan is the one covering surface where a row gesture CANNOT be performed: `AgentSidebar` returns
// `null` for its whole list in Plan mode (AgentSidebar.tsx:2797, "sidebar list stays clear (board
// shows in main pane)"), and with the stage taken by the board the agent panes are not portalled at
// all. A "double-click a row under a Plan board" case would therefore be asserting against a state no
// user can reach — the vacuous shape AGENTS.md names as this repo's #1 fleet-wide finding.
//
// So the invariant that MAKES it unreachable is what gets pinned. The day Plan starts rendering rows
// — a filter chip, a pinned row, a search result, a partial board — this case goes red and tells the
// next agent, in the file where the coverage would belong, that the row gestures now need a Plan case
// too. That is the opposite of silence.
describe("PLAN mode keeps the row gestures out of reach — the reason there is no Plan case above", () => {
  beforeEach(() => seed({ mode: "plan" }));

  it("renders no agent rows at all while the board holds the stage", async () => {
    // No pane is portalled in this state, so waiting for one would only time out.
    await mount(false);
    // The same query the Preview premise asserts is > 0 — see ROW_SELECTOR_COUNT.
    expect(ROW_SELECTOR_COUNT()).toBe(0);
    expect(screen.queryByText(MOUNTED)).toBeNull();
    // …and consequently no terminal, which is correct here: the user asked for the board.
    expect(terminalOnScreen("a1")).toBe(false);
  });
});

// ══ AND THE ONE SURFACE THAT WAS ALREADY RIGHT ═════════════════════════════════════════════════
//
// `onSelectSparkle` sets `activeSpecial = "sparkle"` rather than clearing it, which is CORRECT — it
// is showing the Sparkle pane, not a build terminal. Verified rather than assumed (the task asked for
// exactly that): `boardActive` carries a `&& !sparkleActive` term, so the pane wins the stage back
// from a Plan board without the column leaving Plan. A NON-REGRESSION guard — green before and after
// the fix — kept because a future "always call showBuildStage on a row click" would break it, and
// this is the row whose click must NOT reveal a build terminal.
describe("Improve Sparkle still reveals the SPARKLE pane, even from a Plan board", () => {
  it("swaps the board out for the Sparkle pane and leaves the column in Plan", async () => {
    seed({ mode: "plan", special: null, openSparkle: true });
    await mount(false);
    singleClickRow(improveSparkleRow());
    await screen.findByTestId("sparkle-pane");
    expect(getComputedStyle(screen.getByTestId("sparkle-pane")).visibility).toBe("visible");
    expect(useUiStore.getState().activeSpecial).toBe("sparkle");
    // The user's Plan choice is KEPT — leaving Sparkle brings their board back (Workspace.tsx's note
    // on `boardActive`). A row click that forced Build here would silently discard it.
    expect(useUiStore.getState().workModeBySide.right).toBe("plan");
  });
});

// ══ CLOSING THE MOUNTED AGENT MUST NOT TAKE THE SURVIVING TERMINAL OFF SCREEN ═══════════════════
//
// THE GAP THIS FILLS (bead sparkle-4uw52). `Workspace.conciergeMountWiring.test.tsx` already pins
// that closing the pinned agent drops the cable — and its own comment says what it asserts:
// "ASSERTED AS THE STORE GOING OFF". That is the PRECONDITION, not the side effect. It proves the
// unbind fired; it cannot see whether anything is still painted afterwards, because that suite stubs
// the panes away entirely.
//
// The founder's report is the other half: after v0.103.0, panes stopped showing their terminal. The
// unbind added in PR #1817 is a NEW, gesture-free way for `wired` to flip, and `wired` feeds the
// shell's layout — so "the store went off" and "a terminal is still on screen" are two different
// facts, and only the second one is the thing he sees. This file owns pane visibility, so the
// user-visible half belongs here.
//
// Deliberately asserted on the SURVIVING agent. Asserting that the closed agent's pane is gone would
// pass against a shell that tore down every pane in the pair, which is the regression itself.
//
// ══ THE CLOSE IS DRIVEN THROUGH THE × BUTTON, NOT WRITTEN INTO THE STORE ═══════════════════════
//
// The first draft of this file hand-wrote the post-close state (`projects: [only a2]`,
// `selectedAgentId: "a2"`, `openAgentIds: ["a2"]`) and then asserted a2 was painted. roborev killed
// it, correctly: `paneVisibleAgentId.right` derives from `activeAgentId` (Workspace.tsx:1733), so
// that fixture made a2 visible BECAUSE THE TEST SAID SO. It asserted the post-close selection
// instead of exercising the code that computes it.
//
// And that code is the single most likely producer of the founder's report. The real path is
//
//   close gesture → AgentSidebar.requestClose → teardownAgent → close(id) + removeAgent
//                 → reselectAfterClose → engine/closeAgent.selectionAfterClose
//
// where `selectionAfterClose` decides who is selected afterwards and CAN legitimately return null
// (the blank first-load state, AgentSidebar.tsx:1403-1426), and `firstRenderedRowId` can land on a
// filtered/hidden row. Either outcome paints no terminal — exactly the symptom — and the hand-written
// fixture could not see it, because it replaced that computation with its own answer.
//
// ══ WHAT THIS STILL DOES NOT GRIP — measured, not assumed ══════════════════════════════════════
//
// Driving the real teardown is a genuine improvement over the fixture, but `mutation-check` says it
// does NOT yet grip the reselect: blanking `AgentSidebar.tsx:1427`
// (`if (decision.reselect) selectAgent(...)`) leaves this file GREEN.
//
// The reason is a SECOND fallback underneath it. `projectStore.removeAgent` re-points selection at
// `agents[0]?.id ?? null` on its own, so with exactly two agents the survivor gets selected whether
// or not `reselectAfterClose` runs at all. The reselect is only load-bearing when those two answers
// DIFFER — which is precisely the filtered/hidden-row case roborev named: `firstRenderedRowId` skips
// rows the status filter hides, while `removeAgent`'s fallback does not, so `agents[0]` can be a row
// the user cannot see (or the decision can be `null`). That is still untested, and it remains the
// best open candidate for the founder's symptom. Tracked on bead sparkle-4uw52.
//
// What this file DOES grip is the visibility seam it was written for: mutating `Workspace.tsx:292`
// (`agent.id === visibleAgentId[side]`) turns it red. So the cases below are meaningful about
// WHICH PANE IS PAINTED, and silent about who gets selected when the two fallbacks disagree.
//
// THE GESTURE IS THE CONTEXT MENU'S "Close agent", NOT THE ×, and that is a jsdom constraint rather
// than a preference. The × renders only when the row is `expanded` (hover) or when
// `isActive && stageChipShows(columnWidth)` (AgentRow.tsx:2080) — and **jsdom never lays out**, so
// every measured width is 0 and the hover card is positioned from an all-zero rect
// (docs/jsdom-test-caveats.md). Clicking the × here silently found no button and the row survived.
// The menu item is the SAME production entry point — `AgentSidebar.rowContextMenu.test.tsx` pins it
// as "the same outcome as the × on it", both landing in `requestClose` — and it needs no geometry.
describe("closing the MOUNTED agent leaves the surviving agent's terminal on screen", () => {
  // PREVIEW, not the default Build. Under `seed()`'s defaults (`mode: "build"`, `selectedAgentId:
  // "a1"`) a1's terminal is ALREADY painted before any gesture, so the premise below held identically
  // with the double-click deleted — vacuous, and its comment claimed the opposite. Preview starts the
  // terminal hidden behind the dev-server slot, so the mount is a genuine transition.
  beforeEach(() => {
    seed({ mode: "preview" });
    // A CLEAN, POLLED BRANCH STATUS FOR BOTH ROWS — required for the close to be silent, and the
    // requirement is real production logic rather than test scaffolding. `closeDecision` answers
    // `work-at-risk-prompt` when `branchStatus` is UNDEFINED (engine/closeAgent.ts:110 — "we can't
    // rule out work at risk"), so without this the × / menu item opens the Ship-Save-Discard dialog
    // and no teardown runs at all. That is what the first version of this case actually exercised.
    useRuntimeStore.setState({
      branchStatus: {
        a1: { ahead: 0, behind: 0, dirty: false, filesChanged: 0, insertions: 0, deletions: 0 },
        a2: { ahead: 0, behind: 0, dirty: false, filesChanged: 0, insertions: 0, deletions: 0 },
      },
      workflowStage: {},
    } as never);
  });

  // THE PREMISE, so the case below is a genuine transition rather than a lucky default: the terminal
  // starts OFF screen, and the mount is what puts it there.
  it("starts with the mounted agent's terminal hidden, and the mount paints it", async () => {
    await mount();
    expect(terminalOnScreen("a1")).toBe(false);
    doubleClickRow(rowFor(MOUNTED));
    expect(terminalOnScreen("a1")).toBe(true);
  });

  it("still paints the surviving agent's terminal once the mounted one is closed", async () => {
    await mount();
    doubleClickRow(rowFor(MOUNTED));
    expect(terminalOnScreen("a1")).toBe(true);

    // THE REAL TEARDOWN. `mkAgent` leaves `branch`/`worktreePath` null and the runtime store carries
    // no branchStatus, so `closeDecision` returns neither the work-at-risk prompt nor the retirement
    // confirm and `requestClose` goes straight to `teardownAgent` — one click, no dialog.
    // TWO SEPARATE `act`s, deliberately. The menu is rendered from state the right-click sets, so
    // querying for its item inside the SAME act finds nothing — React has not re-rendered yet.
    await act(async () => {
      openRowMenu(rowFor(MOUNTED));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("row-menu-close-agent"));
    });

    // THE CLOSE REALLY HAPPENED — otherwise the assertion below is about a teardown that never ran.
    // Scoped to a ROW rather than `queryByText(MOUNTED)`: the mounted agent's NAME survives the close
    // in other surfaces (the concierge names who it is talking to), so a bare text query fails here
    // against a perfectly correct close. The row is the thing that must be gone.
    expect(rowExistsFor(MOUNTED)).toBe(false);
    expect(rowExistsFor(OTHER)).toBe(true);

    // THE USER-VISIBLE FACT, and now it is the SHELL's answer rather than the fixture's: whatever
    // `selectionAfterClose` chose, the survivor's terminal is on screen. Not `paneFor("a2") !== null`
    // — a pane that is portalled but hidden is precisely the reported symptom, and `terminalOnScreen`
    // is what tells the two apart.
    expect(terminalOnScreen("a2")).toBe(true);
  });
});

// ══ SWITCHING THE WIRED PAIR'S PROJECT TAB, WITH AN AGENT MOUNTED ══════════════════════════════
//
// THE SECOND PATH PR #1817's OWN COMMENT NAMES as no longer self-healing (bead sparkle-4uw52). Its
// note lists two click-reachable states that used to recover on their own and no longer do, because
// the control pressed is itself inside the circuit so no unbind fires from the gesture:
//
//   1. closing the mounted agent  — covered by the describe above
//   2. switching the wired pair's project tab  — THIS ONE, previously untested
//
// The tab bar renders INSIDE the wired pair, so the cable survives the press while `wiredProject`
// becomes a project the pin has no agent in. #1817's new effect is what is supposed to notice that
// and drop the cable. What no test asked is the founder-visible question: with the cable dropped out
// from under it, does the newly-selected project still PAINT a terminal?
//
// Asserted on the ARRIVING project's agent — that is the pane the user is looking at after the
// click. Asserting the departed project's pane went hidden would pass against a shell that painted
// nothing at all, which is the reported symptom rather than a guard against it.
describe("switching the project tab while an agent is MOUNTED still paints the new tab's terminal", () => {
  beforeEach(() => {
    seed();
    // A second project with its own open agent, so there is somewhere to switch TO. `seed` builds a
    // single-project shell; everything else about it is reused unchanged.
    useProjectStore.setState({
      projects: [
        mkProject("p1", "Alpha", [mkAgent("a1", MOUNTED), mkAgent("a2", OTHER)], "a1"),
        mkProject("p2", "Beta", [mkAgent("a3", "Beta agent")], "a3"),
      ],
      selectedProjectId: "p1",
    } as never);
    useRuntimeStore.setState({ openAgentIds: ["a1", "a2", "a3"], status: {} } as never);
  });

  // THE PREMISE: the mount really did paint a1, and the other project's pane is NOT showing yet.
  // Both halves matter — without the second, "a3 is visible later" could be true from the start.
  it("starts with the mounted agent painted and the other project's agent not", async () => {
    await mount();
    doubleClickRow(rowFor(MOUNTED));
    expect(terminalOnScreen("a1")).toBe(true);
    expect(terminalOnScreen("a3")).toBe(false);
  });

  it("paints the arriving project's terminal after the tab switch", async () => {
    await mount();
    doubleClickRow(rowFor(MOUNTED));
    expect(terminalOnScreen("a1")).toBe(true);

    await act(async () => {
      useProjectStore.getState().selectProject("p2");
    });

    expect(terminalOnScreen("a3")).toBe(true);
  });
});
