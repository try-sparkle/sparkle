// @vitest-environment jsdom
//
// CAN THE USER ACTUALLY RESIZE A COLUMN? — the WIRING, not the unit.
//
// `ColumnPullTab.test.tsx` already proves the component turns a drag into an `onWidth` call, and it
// passes. That is the unit. What no test covered is the CHAIN the user actually operates:
//
//     drag the seam → onWidth → Workspace state → the column's own width
//
// Every link in that chain lives in a different file, so each one had a green test while the whole
// thing could still be broken — which is exactly the shape of the v0.63.0 report ("the divider
// registers, the cursor changes, nothing moves"). A tab that calls `onWidth` into a handler nobody
// reads is indistinguishable from a working one at the unit level.
//
// So these assert the SIDE EFFECT — the width the concierge column is actually rendered at — and
// never the precondition that `onWidth` fired.
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
// The `sparkleAgent` mock below SPREADS THE ORIGINAL rather than replacing it — the same shape
// `Workspace.cockpit.test.tsx` uses, and for a reason worth keeping: a full-replacement mock breaks
// the moment the module gains an export some unrelated transitive import needs. That is not
// hypothetical, it is why this line changed — `SPARKLE_AGENT_ID` arrived on main and
// `conciergeTools/terminal.ts` reads it at module scope, so a replacement mock made this whole file
// fail to LOAD (0 tests collected) while the suite still reported "no tests failed".
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
  sparkleAgentIdFor: () => "sparkle",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));
vi.mock("./AgentPane", () => ({
  AgentPane: ({ agent }: { agent: { id: string } }) => <div data-testid={`pane-${agent.id}`} />,
}));
vi.mock("./AgentSidebar", () => ({
  AgentSidebar: () => <div data-testid="sidebar" />,
  NewBuildAgentButton: () => null,
}));
// THE STUB PUBLISHES THE WIDTH IT WAS HANDED, and that is the whole point of it. A stub that
// ignored `width` — like the cockpit suite's, which renders a bare div — would make every
// assertion below vacuous: the drag could write into a prop nobody reads and the test would still
// be green, which is the exact defect class this file exists to catch.
vi.mock("./ConciergeHost", () => ({
  ConciergeHost: ({ width }: { width?: number }) => (
    <div data-testid="concierge" data-width={String(width)} style={{ width }} />
  ),
}));
vi.mock("./OfflineBanner", () => ({ OfflineBanner: () => null }));
vi.mock("./ZeroCreditBanner", () => ({ ZeroCreditBanner: () => null }));
vi.mock("./SparkleAgentPane", () => ({ SparkleAgentPane: () => null }));
vi.mock("./ProjectModal", () => ({ ProjectModal: () => null }));
vi.mock("./ClosePrompt", () => ({ ClosePrompt: () => null }));
vi.mock("./BoardView", () => ({ BoardView: () => null }));
vi.mock("./Concierge/KebabMenu", () => ({ ConciergeTopRight: () => null }));
vi.mock("./OpenPrMenu", () => ({ OpenPrMenu: () => null, agentLinkForBranch: () => null }));
vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));
vi.mock("./StatusStrip", () => ({ StatusStrip: () => null }));
vi.mock("./NewCloudAgentDialog", () => ({ NewCloudAgentDialog: () => null }));

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

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}
function mkProject(id: string, name: string, agents: AgentTab[]): Project {
  return {
    id, name, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: agents[0]!.id, agents,
  };
}

beforeEach(() => {
  localStorage.clear();
  useProjectStore.setState({
    projects: [mkProject("p1", "Alpha", [mkAgent("a1")])],
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
  localStorage.clear();
});

/** The width the concierge column is CURRENTLY rendered at — the thing the user sees move. */
const conciergeWidth = () => Number(screen.getByTestId("concierge").dataset.width);
const dots = () => screen.getByTestId("concierge-pull-tab-dots");

/** Grab the seam the way a POINTER does — cross the rail first, and assert the reveal actually
 *  happened rather than assuming it.
 *
 *  This discipline comes from the version of this file that landed on `main` in parallel (PR #817),
 *  and it is better than what this file had: pressing the dots directly skips the hover, so the suite
 *  stays green against a tab that is invisible and pointer-inert in a real browser. That is not
 *  hypothetical for this component — it has shipped a dead reveal once already, where the tab never
 *  became `shown` and the drag could not be started at all (roborev 54850), and the identical bug
 *  shipped again this session on the pair-count control. The two files were merged rather than one
 *  replacing the other: the cases below are this branch's, the grab is theirs. */
function grabSeam(clientX: number) {
  fireEvent.mouseEnter(screen.getByTestId("concierge-pull-tab"));
  expect(screen.getByTestId("concierge-pull-tab").getAttribute("data-shown")).toBe("true");
  expect(screen.getByTestId("concierge-pull-tab-tab").style.pointerEvents).toBe("auto");
  fireEvent.mouseDown(dots(), { button: 0, clientX, buttons: 1 });
}

/** The same width, read back as the RAW ATTRIBUTE STRING.
 *
 *  Two independent versions of this file were written in parallel — this branch's (#825) and the one
 *  that landed on main as #828 — and they disagreed on exactly one thing: whether the reader coerces.
 *  This branch's `conciergeWidth` returns a `number`; #828's returned the attribute string and its
 *  five cases compare against `String(...)` and against each other as strings.
 *
 *  Both suites are kept, so the disagreement is resolved by giving #828's block its own reader
 *  instead of rewriting either author's assertions. Silently keeping the numeric one would have left
 *  `expect(conciergeWidth()).toBe(String(start + dx))` comparing a number to a string — green only
 *  by never being reached, red the moment it was. Nothing about what either suite PROVES changed. */
const conciergeWidthAttr = () => screen.getByTestId("concierge").getAttribute("data-width");

/** Drive the seam end to end. `buttons: 1` is not decoration — the tab cancels a drag whose button
 *  is no longer held. */
function drag(from: number, to: number) {
  grabSeam(from);
  fireEvent.mouseMove(window, { clientX: to, buttons: 1 });
  fireEvent.mouseUp(window, { clientX: to });
}

describe("the concierge seam actually moves the concierge", () => {
  it("widens the column when the seam is dragged outward", () => {
    render(<Workspace />);
    const before = conciergeWidth();
    drag(500, 560);
    // THE SIDE EFFECT: the column is rendered wider. Not "onWidth was called" — that is the
    // precondition, and it was already true while the user could not resize anything.
    expect(conciergeWidth()).toBe(before + 60);
  });

  it("narrows it when the seam is dragged inward", () => {
    render(<Workspace />);
    const before = conciergeWidth();
    drag(500, 460);
    expect(conciergeWidth()).toBe(before - 40);
  });

  it("tracks the pointer continuously, not only on release", () => {
    // A drag that only commits on mouseup reads as a dead control for its whole duration, which is
    // indistinguishable from the reported "nothing moves".
    render(<Workspace />);
    const before = conciergeWidth();
    grabSeam(500);
    fireEvent.mouseMove(window, { clientX: 520, buttons: 1 });
    expect(conciergeWidth()).toBe(before + 20);
    fireEvent.mouseMove(window, { clientX: 540, buttons: 1 });
    expect(conciergeWidth()).toBe(before + 40);
    fireEvent.mouseUp(window, { clientX: 540 });
  });

  it("stops at the clamp rather than following the pointer past it", () => {
    render(<Workspace />);
    drag(500, 5000);
    const max = conciergeWidth();
    // Pinned at the ceiling, and a further drag in the same direction changes nothing.
    drag(500, 6000);
    expect(conciergeWidth()).toBe(max);
    // …and the ceiling is a real clamp, not the column simply refusing to move at all.
    expect(max).toBeGreaterThan(360);
  });

  it("survives the release being lost outside the window", () => {
    // `buttons: 0` means the button came up somewhere the app never saw. The column must stop
    // following the bare cursor — otherwise every later mouse move resizes.
    render(<Workspace />);
    grabSeam(500);
    fireEvent.mouseMove(window, { clientX: 520, buttons: 1 });
    const parked = conciergeWidth();
    fireEvent.mouseMove(window, { clientX: 900, buttons: 0 });
    fireEvent.mouseMove(window, { clientX: 200, buttons: 0 });
    expect(conciergeWidth()).toBe(parked);
  });

  it("keeps the width across a re-render of the shell", () => {
    // The drag writes React state, and the shell re-renders constantly (every projectStore write).
    // A width that survives the drag but not the next unrelated render is still a dead control.
    render(<Workspace />);
    drag(500, 540);
    const after = conciergeWidth();
    useProjectStore.setState({
      projects: [mkProject("p1", "Alpha renamed", [mkAgent("a1")])],
    } as never);
    expect(conciergeWidth()).toBe(after);
  });
});

// A DEBOUNCE THAT NEVER FLUSHES IS A WAY TO LOSE A WIDTH, not a way to write it less often. The
// per-pixel write it replaced could not lose a committed value; a trailing timer whose cleanup only
// cancels can. Nothing covered persistence at all before this, which is why the hole was invisible.
describe("the width the user set actually survives", () => {
  const stored = () => localStorage.getItem("sparkle-concierge-width");

  it("persists the width once the drag settles", async () => {
    const { unmount } = render(<Workspace />);
    drag(500, 540);
    await new Promise((r) => setTimeout(r, 260));
    expect(Number(stored())).toBe(conciergeWidth());
    unmount();
  });

  it("does NOT lose the width when the tree tears down inside the debounce window", () => {
    // Resize the seam and quit immediately. The regression: nothing had been written yet and the
    // cleanup only cleared the timer, so the next launch restored the OLD width.
    const { unmount } = render(<Workspace />);
    drag(500, 540);
    const set = conciergeWidth();
    unmount();
    expect(Number(stored())).toBe(set);
  });

  // THE QUIT PATH, WHICH IS THE ONE THE REPORT NAMED. A native window close destroys the webview
  // and React never unmounts, so `unmount()` above does NOT cover it — these fire the actual
  // teardown events instead. All three are registered because `pagehide` alone is the one signal
  // this codebase never relies on by itself (projectStore registers the same trio).
  for (const [name, fire] of [
    ["pagehide", () => window.dispatchEvent(new Event("pagehide"))],
    ["beforeunload", () => window.dispatchEvent(new Event("beforeunload"))],
    [
      "visibilitychange → hidden",
      () => {
        // RESTORED AFTERWARDS. Redefining this and walking away leaves every later test in the file
        // rendering into a document that reports itself hidden, and this app has several
        // visibility-gated paths — so a future case would pass or fail for a reason unrelated to
        // its subject, which is worse than failing outright.
        const orig = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
        Object.defineProperty(
          document,
          "visibilityState",
          orig ?? { configurable: true, get: () => "visible" },
        );
      },
    ],
  ] as const) {
    it(`flushes the width on ${name}, without unmounting`, () => {
      const { unmount } = render(<Workspace />);
      drag(500, 535);
      const set = conciergeWidth();
      fire();
      expect(Number(stored())).toBe(set);
      unmount();
    });
  }

  it("restores that width on the next launch", () => {
    // The whole point of persisting: end-to-end, not just "a string reached localStorage".
    const first = render(<Workspace />);
    drag(500, 545);
    const set = conciergeWidth();
    first.unmount();
    render(<Workspace />);
    expect(conciergeWidth()).toBe(set);
  });
});

describe("the seam is reachable in the five-column cockpit", () => {
  it("still resizes once the LEFT pair has shipped", () => {
    // `TERM │ BUILD │ CONCIERGE │ BUILD │ TERM`. The concierge is between two pairs now, and its
    // seam control is mounted on one side of it only — so this is the configuration the report came
    // from, not the single-pair one every other test renders.
    useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
    render(<Workspace />);
    expect(screen.getByTestId("workspace-shell").getAttribute("data-pairs")).toBe("2");
    const before = conciergeWidth();
    drag(500, 550);
    expect(conciergeWidth()).toBe(before + 50);
  });
});

// ── A LIT CABLE MUST HAVE AN AGENT ON THE FAR END ─────────────────────────────────────────────
//
// `selectAndWire` refuses to patch when it seats nothing, which closed one route in. It cannot close
// the routes that REMOVE something: switch the wired pair to an agent-less project, or close its
// last agent, and `wired` still names that side while there is nothing there. The shell then floods
// that pair and recedes the other while the compose box falls back to Sparkle — the cable is lit and
// the user's next message goes somewhere else. So the invariant is enforced where the state is READ.
describe("the shell reports no circuit when the far end is empty", () => {
  it("reads wired at rest", () => {
    render(<Workspace />);
    expect(screen.getByTestId("workspace-shell").getAttribute("data-wired")).toBe("off");
  });

  it("lights the cable when the wired pair HAS a selected agent", () => {
    render(<Workspace />);
    act(() => useCableStore.getState().patch("right"));
    expect(screen.getByTestId("workspace-shell").getAttribute("data-wired")).toBe("right");
  });

  it("reports OFF when the wired pair's project has no selected agent", () => {
    // The state an acquisition guard cannot prevent, because nothing is being acquired.
    render(<Workspace />);
    act(() => useCableStore.getState().patch("right"));
    act(() => {
      useProjectStore.setState({
        projects: [{ ...mkProject("p1", "Alpha", [mkAgent("a1")]), selectedAgentId: null }],
      } as never);
    });
    expect(screen.getByTestId("workspace-shell").getAttribute("data-wired")).toBe("off");
    // The store still holds the patch — this is a read-side projection, so nothing had to remember
    // to unbind, and re-selecting an agent lights it again without another gesture.
    expect(useCableStore.getState().wired).toBe("right");
  });
});

/** Drag from `clientX` to `clientX + dx` and release. */
function dragSeamBy(dx: number, from = 500) {
  grabSeam(from);
  fireEvent.mouseMove(window, { clientX: from + dx, buttons: 1 });
  fireEvent.mouseUp(window);
}

/**
 * ══ NOTHING BELOW HARDCODES A WIDTH, A BOUND, OR THE STORAGE KEY ═══════════════════════════════
 *
 * `Workspace.tsx` keeps those four values module-private, and they are NOT exported for this file's
 * benefit: that file is owned by a concurrent agent reworking the cockpit layout, and a third party
 * editing it — even additively — is the convergence collision AGENTS.md calls the most expensive
 * recurring failure in this repo.
 *
 * Copying the literals instead would have been worse than either option. This file exists to catch
 * width-DELIVERY bugs, so a changed default must not surface here as unexplained numeric failures
 * reading like "the drag broke" (roborev 55342). So every expectation is OBSERVED:
 *
 *   • the default    — read off the column at mount;
 *   • the storage key — discovered as the key the drag actually writes;
 *   • the bounds      — LEARNED, by dragging past each end and reading where the column stops;
 *   • the drag deltas — a FRACTION of the learned headroom, never a fixed number of pixels;
 *   • out-of-clamp    — seeded ONE PAST a learned bound, so the seed pins that bound exactly.
 *
 * The last three are corrections, and the reasons are worth keeping (roborev 55393):
 *
 *   • A fixed `dragSeamBy(40)` trades a hardcoded WIDTH for a hardcoded DELTA — the same coupling.
 *     It silently assumes ≥40px of headroom between the default and the max; re-tune the default
 *     upward and the commit clamps, so the assertion fails as "the width didn't arrive" — precisely
 *     the misleading failure this observation strategy exists to avoid.
 *   • Seeding a magic extreme (`1`, `1000000`) pins only `MIN > 1` and `MAX < 1000000`. Weakening the
 *     initializer to `saved >= 50` restores a stale 50 and wedges the column to a sliver, while both
 *     extreme seeds still fall through to the default and stay green. One past the LEARNED bound
 *     pins the bound itself, and still without a literal in this file.
 *   • The movement guard cannot be unconditional: if the default ever coincides with a bound, a
 *     perfectly working clamp reads as "the drag registers but nothing moves".
 */
const mountAndReadDefault = () => {
  render(<Workspace />);
  return conciergeWidthAttr();
};

/** Every key currently in storage. Enumerated through the Web Storage API rather than
 *  `Object.keys`, which does not enumerate this environment's localStorage. */
function storageKeys(): string[] {
  return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(
    (k): k is string => k !== null,
  );
}

/** The key the drag wrote, found by diffing localStorage rather than by knowing its name.
 *
 *  ASYNC, and the await is load-bearing. #828 wrote this against a persist that hit localStorage on
 *  EVERY mousemove, so diffing storage the instant the drag returned found the key. #825 — merged
 *  with it here — turned that into a 200ms TRAILING DEBOUNCE (`Workspace.tsx`, fixing a synchronous
 *  disk write sitting on the drag's hot path), so at that instant nothing has been written yet and
 *  this found ZERO keys. That is a real interaction between the two PRs, not a merge artifact.
 *
 *  So it waits past the debounce instead of asserting the old timing. It still DISCOVERS the key by
 *  diffing rather than naming it, which is what #828 built it for; only the moment it looks moved.
 *  `toHaveLength(1)` is kept deliberately — it is what catches a persist that never flushes at all,
 *  the same regression #825's own "a debounce that never flushes is a way to LOSE a width" cases
 *  guard from the other side. */
async function keyWrittenBy(action: () => void): Promise<string> {
  const before = new Set(storageKeys());
  action();
  // 260ms — past the 200ms trailing timer, the same margin #825's persistence cases already use.
  // Awaiting a resolved promise would not do: this is a real timer, not a microtask.
  await new Promise((r) => setTimeout(r, 260));
  const added = storageKeys().filter((k) => !before.has(k));
  expect(added).toHaveLength(1);
  return added[0] as string;
}

/** Mount, drag far past one end, and read where the column came to rest. A fresh mount + cleared
 *  storage each time, so the value is the CLAMP and not a leftover from an earlier phase. */
function learnBound(direction: -1 | 1): number {
  cleanup();
  localStorage.clear();
  const start = Number(mountAndReadDefault());
  dragSeamBy(direction * 9000);
  const bound = Number(conciergeWidthAttr());
  cleanup();
  localStorage.clear();
  return bound === start ? start : bound;
}

/** The default, and the real clamp either side of it — all read out of the running component. */
function learnGeometry() {
  const start = Number(mountAndReadDefault());
  cleanup();
  localStorage.clear();
  return { start, min: learnBound(-1), max: learnBound(1) };
}

/** A drag that is guaranteed to land strictly INSIDE the clamp — a quarter of the headroom above
 *  the default, so it never silently collides with the max the way a fixed +40 can. */
function safeDelta(start: number, max: number): number {
  return Math.max(1, Math.floor((max - start) / 4));
}

describe("dragging the concierge seam moves the column", () => {
  it("delivers the dragged width to the column, not just to the handler", () => {
    const { start, max } = learnGeometry();
    const dx = safeDelta(start, max);

    render(<Workspace />);
    expect(Number(conciergeWidthAttr())).toBe(start);
    dragSeamBy(dx);

    // Both the base and the delta come from the running component, so a re-tuned default or a
    // narrowed range stays green while a width that fails to arrive still fails.
    expect(conciergeWidthAttr()).toBe(String(start + dx));
  });

  /**
   * Drag past a bound twice and return the two widths, having first proven the column MOVED.
   *
   * The movement check is the load-bearing part. Comparing phase 2 to phase 1 alone has a
   * degenerate pass mode: if the width stops reaching the column at all, BOTH phases render at the
   * mount default, the two agree, and the test is green — while showing exactly the "the drag
   * registers but nothing moves" symptom this file exists to catch. It survived only because
   * sibling tests happened to catch that mutation; on its own it asserted nothing (roborev 55390).
   *
   * Storage is also cleared between the phases. Phase 1 persists the CLAMPED value, so without the
   * clear phase 2 mounts already at the bound and its "bigger" drag never travels from the default.
   */
  function twoDragsPastBound(first: number, second: number) {
    cleanup();
    localStorage.clear();
    const start = Number(mountAndReadDefault());
    dragSeamBy(first);
    const bound = conciergeWidthAttr();
    cleanup();
    localStorage.clear();

    const restart = Number(mountAndReadDefault());
    expect(restart).toBe(start); // phase 2 really does begin at the default
    dragSeamBy(second);
    return { start, bound, again: conciergeWidthAttr() };
  }

  it("clamps at the maximum on the DELIVERY path, not just in the handler", () => {
    // `ColumnPullTab.test.tsx` clamps against a mocked `onWidth`; this drives a past-the-end drag
    // through the real Workspace, so a clamp bypassed anywhere between handler and column is caught.
    //
    // Asserted by IDEMPOTENCE rather than against the bound's value: whatever the max is, dragging
    // further must not move the column past it. That is the property, and it needs no literal.
    const { start, bound, again } = twoDragsPastBound(4000, 9000);
    // Guarded, not unconditional: were the default ever re-tuned ONTO the max, a working clamp would
    // legitimately not move, and asserting movement would turn that into a false "nothing arrived".
    if (Number(bound) !== start) expect(Number(bound)).toBeGreaterThan(start);
    expect(again).toBe(bound);
  });

  it("persists the dragged width AND reads it back on the next launch", async () => {
    const { start, max } = learnGeometry();
    const dx = safeDelta(start, max);

    render(<Workspace />);
    const key = await keyWrittenBy(() => dragSeamBy(dx));
    const dragged = String(start + dx);
    expect(localStorage.getItem(key)).toBe(dragged);

    // THE ROUND TRIP, not just the write. Asserting only the localStorage value leaves the
    // `useState` initializer that reads it back completely uncovered — a wrong key or an inverted
    // clamp comparison would keep this green while the column snapped back to the default on every
    // launch, which is the same "the drag registers but nothing sticks" symptom this file exists to
    // catch (roborev 55342).
    cleanup();
    render(<Workspace />);
    expect(conciergeWidthAttr()).toBe(dragged);
  });

  it("clamps at the minimum on the DELIVERY path too", () => {
    // BOTH ends, not just the max. A min bypass between handler and column is a different edit from
    // a max bypass, and asserting only the upper bound leaves the lower one unguarded.
    const { start, bound, again } = twoDragsPastBound(-4000, -9000);
    if (Number(bound) !== start) expect(Number(bound)).toBeLessThan(start);
    expect(again).toBe(bound);
    // And it must be a real floor, not a collapse to nothing.
    expect(Number(bound)).toBeGreaterThan(0);
  });

  // BOTH HALVES of the read-back validation, seeded ONE PAST each LEARNED bound.
  //
  // The initializer is `saved >= MIN && saved <= MAX ? saved : DEFAULT`, and a seed only ever
  // exercises the side it is on — so both sides are needed. But the seed must also sit exactly one
  // step outside the real bound: a magic extreme (`1`, `1000000`) pins only `MIN > 1` and
  // `MAX < 1000000`, so weakening the initializer to `saved >= 50` would restore a stale 50 and
  // wedge the column to a sliver while both extremes still fell through to the default
  // (roborev 55387 found the missing half, 55393 found the seeds too loose to pin it).
  //
  // Empty storage cannot substitute for either case: `Number(null) === 0` reaches the default
  // through the same branch without testing a bound at all.
  it.each([
    ["above the maximum", (g: { min: number; max: number }) => g.max + 1],
    ["below the minimum", (g: { min: number; max: number }) => g.min - 1],
  ])("ignores a persisted width %s rather than restoring it", async (_label, seedFor) => {
    const geo = learnGeometry();
    render(<Workspace />);
    const key = await keyWrittenBy(() => dragSeamBy(safeDelta(geo.start, geo.max)));
    cleanup();
    localStorage.setItem(key, String(seedFor(geo)));

    render(<Workspace />);
    expect(Number(conciergeWidthAttr())).toBe(geo.start);
  });
});
