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

import {
  CONCIERGE_WIDTH_KEY,
  CONCIERGE_WIDTH_KEY_PAIRED,
  PRIMARY_PAIR_ROW_RESERVE,
  Workspace,
} from "./Workspace";
// ONLY THE VARIABLE NAME. The geometry helpers were imported here to run the app's rendered numbers
// through `cockpitGeometry`, which turned out to prove nothing: the model's concierge centre reduces
// to `windowWidth / 2` algebraically for every input, so restating it at the app level was a
// pass-by-construction check (roborev 56086). The arithmetic lives in `engine/columnResize.test.ts`;
// what this file pins is the DOM structure that model assumes — see `assertRowStructure`.
import {
  COLUMN_HARD_MAX,
  COLUMN_MIN_WIDTH,
  CONCIERGE_DEFAULT_WIDTH,
  CONCIERGE_MAX_WIDTH,
  CONCIERGE_MIN_WIDTH,
  CONCIERGE_WIDTH_VAR,
  windowAwareMax,
} from "../engine/columnResize";
import { applyVisualFixtures } from "../dev/visualFixtures";
import { DEV_BYPASS_AUTH_FLAG } from "../dev/devBypassAuth";
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
    activeSpecial: null, workModeBySide: { left: "build", right: "build" }, pinnedProjectId: null, openProjectIds: null,
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
  fireEvent.pointerDown(dots(), { pointerId: 1, button: 0, clientX, buttons: 1 });
}

/** THE WIDTH THE COLUMN IS PAINTED AT *RIGHT NOW*, including mid-drag.
 *
 *  The drag no longer calls `onWidth` per move — it writes this custom property on the root element,
 *  which is what takes the gesture off React state — so the committed prop on the column is stale
 *  until release. A case about what the user SEES during a drag has to read this; a case about what
 *  was COMMITTED reads `conciergeWidth()` after the release. */
const paintedConciergeWidth = () =>
  Number(document.documentElement.style.getPropertyValue(CONCIERGE_WIDTH_VAR).replace("px", ""));

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
  fireEvent.pointerMove(window, { pointerId: 1, clientX: to, buttons: 1 });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: to });
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
    // A drag that only commits on release reads as a dead control for its whole duration, which is
    // indistinguishable from the reported "nothing moves".
    //
    // WHAT TRACKS IS THE PAINT, NOT THE STATE, and that is the change. The column follows the pointer
    // through the CSS variable while React does nothing at all — the measured cost of the old
    // per-move `setState` was 30 shell re-renders and 1,668ms of jank in a single drag. So this reads
    // the painted width, and the case below asserts the state was NOT written per move.
    render(<Workspace />);
    const before = conciergeWidth();
    grabSeam(500);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 520, buttons: 1 });
    expect(paintedConciergeWidth()).toBe(before + 20);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 540, buttons: 1 });
    expect(paintedConciergeWidth()).toBe(before + 40);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 540 });
    // …and the release is what finally moves the React-held width.
    expect(conciergeWidth()).toBe(before + 40);
  });

  it("does NOT write React state per pointer move — the drag is off the render path", () => {
    // The regression this catches is the one that was measured. `data-width` on the column is the
    // committed prop, so it must not move until the gesture ends, however far the pointer travels.
    render(<Workspace />);
    const before = conciergeWidth();
    grabSeam(500);
    for (let x = 505; x <= 560; x += 5) {
      fireEvent.pointerMove(window, { pointerId: 1, clientX: x, buttons: 1 });
    }
    expect(conciergeWidth()).toBe(before); // still the pre-drag value…
    expect(paintedConciergeWidth()).toBe(before + 60); // …while the paint has tracked all of it
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(conciergeWidth()).toBe(before + 60);
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
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 520, buttons: 1 });
    const parked = paintedConciergeWidth();
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 900, buttons: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, buttons: 0 });
    expect(conciergeWidth()).toBe(parked);
    expect(paintedConciergeWidth()).toBe(parked);
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
  const stored = () => localStorage.getItem(CONCIERGE_WIDTH_KEY);

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
  // A WINDOW THAT CAN ACTUALLY SEAT FIVE COLUMNS, for the same reason the pinned-pair block below
  // states its own: jsdom defaults to 1024, and 1024 cannot hold `320 + 6 + 280 + 6 + 360` even with
  // every column at its minimum — so the concierge's window-aware ceiling correctly pins it at 280
  // there and this row would be measuring the clamp instead of the seam (roborev 55910).
  const realWidth = window.innerWidth;
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
  });

  it("still resizes once the LEFT pair has shipped", () => {
    // `TERM │ BUILD │ EPICS │ CONCIERGE │ EPICS │ BUILD │ TERM`. The concierge is between two pairs now, and its
    // seam control is mounted on one side of it only — so this is the configuration the report came
    // from, not the single-pair one every other test renders.
    useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
    render(<Workspace />);
    expect(screen.getByTestId("workspace-shell").getAttribute("data-pairs")).toBe("2");
    const before = conciergeWidth();
    drag(500, 550);
    // 2·dx: with a left pair open the concierge is the anchor and grows from both edges at once.
    expect(conciergeWidth()).toBe(before + 100);
  });
});

// ── THE CONCIERGE IS THE CENTRED ANCHOR OF THE DOUBLE-PAIR ROW ────────────────────────────────
//
// THIS BLOCK REPLACES THE ONE THAT PINNED THE OPPOSITE CONTRACT, deliberately. What stood here
// asserted that dragging the left seam moved the LEFT PAIR by +80 and left the concierge's width
// untouched — "one boundary owns one column", which made the two edges independent. That was a
// coherent design and it is the one the founder rejected, because it had two consequences it could
// not avoid: no gesture grew the concierge leftward at all (it slid sideways as a rigid block — "it
// drags the whole app"), and the right pair, being the only elastic column, swallowed a 3-display
// span (`640 + 360` of 5760 left it ~4,700px — "spanning like one and a half displays").
//
// The new contract, in the founder's words: "I basically want to be able to drag out from the
// middle… make it so that the concierge both sides grow when you pull one side." So BOTH seams own
// the CONCIERGE, both commit the same width, and each pixel of travel buys two of column.
//
// WHAT IS ASSERTED WHERE. jsdom has no layout engine — `min()`/`calc()` never resolve and every
// `getBoundingClientRect` is zero — so the resulting positions cannot be read off the rendered DOM.
// The split is:
//   • `engine/columnResize.test.ts` owns the ARITHMETIC: given the row's numbers, where does every
//     column land, and is the concierge dead centre.
//   • This file owns the WIRING: that the app actually renders the inputs that model assumes, and
//     that a gesture moves the number the model reads.
// `assertRowStructure()` below is the join between them — it pins the DOM structure the model
// assumes, which is the only thing that can make the model solve a row the app is not rendering.

const half = (side: "left" | "right") => screen.getByTestId(`pair-${side}`);

/**
 * THE DOM FACTS THAT DECIDE THE GEOMETRY — asserted here because they are the only half of the
 * question jsdom can answer, and because getting them wrong is invisible everywhere else.
 *
 * THIS REPLACES A SET OF CENTRING ASSERTIONS THAT COULD NOT FAIL. They read
 * `centreOf(cockpitGeometry({...}), "concierge")` and compared it to `windowWidth / 2` — but the
 * model defines `x_concierge = half + RAIL` with `half = (W − C − 2·RAIL)/2`, so that centre reduces
 * to `W/2` ALGEBRAICALLY, for every input, whatever the app rendered. Restating the engine's own
 * theorem at the app level proved nothing about the app, and it is exactly why a real off-centre
 * defect sailed through this suite: the left seam rail was rendered INSIDE the width-bearing box, so
 * the shipped concierge was 3px right of centre with 6px of itself under the right rail, and every
 * centring assertion here stayed green (roborev 56086).
 *
 * The arithmetic belongs to `columnResize.test.ts`, which owns it. What this file must pin is that
 * the app feeds that model the structure it assumes:
 *
 *     [ pair-left: flex 1 1 0 ][ rail ][ concierge box: var(--concierge-w) ][ rail ][ pair-right ]
 *
 * Both halves elastic and identical, the box holding ONLY the column, and a rail on each SIDE of the
 * box rather than inside it. Get any of those wrong and the model is solving a row the app is not
 * rendering — which is the one failure a shared model can have.
 */
function assertRowStructure() {
  // Equal halves are what centre the concierge. `1 1 0px` — jsdom normalises the basis to a length.
  expect(half("left").style.flex).toBe("1 1 0px");
  expect(half("right").style.flex).toBe(half("left").style.flex);

  const root = document.querySelector("[data-concierge-root]")!;
  const box = screen.getByTestId("concierge-box");
  // The box is a DIRECT child of the row's concierge group, not nested inside a rail or a wrapper.
  expect(box.parentElement).toBe(root);
  // …sized by the variable the drag writes, not by a rendered number.
  expect((box as HTMLElement).style.width).toContain(`var(${CONCIERGE_WIDTH_VAR}`);

  // THE BOX CONTAINS THE COLUMN AND NOTHING ELSE. Anything else in here is width the column does not
  // get: a 6px rail inside the box is 6px of overflow and 3px of off-centre.
  expect(box.querySelector("[data-testid$='-pull-tab']")).toBeNull();

  // A RAIL ON EACH SIDE OF THE BOX. Reading the row's element order is what makes "the concierge is
  // between its two seams" a fact about the DOM rather than about the model.
  // Elements only, and nothing that paints nothing: a `<style>` or a hidden node between the box and
  // its rail would make "a rail either side" read as false for a row that is perfectly correct.
  const kids = Array.from(root.children).filter(
    (el) => el.tagName !== "STYLE" && (el as HTMLElement).style.display !== "none",
  );
  const boxAt = kids.indexOf(box);
  expect(boxAt).toBeGreaterThan(0);
  const isRail = (el: Element | undefined) =>
    !!el && (el.matches("[data-testid$='-pull-tab']") || !!el.querySelector("[data-testid$='-pull-tab']"));
  expect(isRail(kids[boxAt - 1])).toBe(true);
  expect(isRail(kids[boxAt + 1])).toBe(true);
}

function grabLeftSeam(clientX: number) {
  fireEvent.mouseEnter(screen.getByTestId("left-pair-pull-tab"));
  expect(screen.getByTestId("left-pair-pull-tab").getAttribute("data-shown")).toBe("true");
  fireEvent.pointerDown(screen.getByTestId("left-pair-pull-tab-dots"), {
    pointerId: 1,
    button: 0,
    clientX,
    buttons: 1,
  });
}
function dragLeftSeam(from: number, to: number) {
  grabLeftSeam(from);
  fireEvent.pointerMove(window, { pointerId: 1, clientX: to, buttons: 1 });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: to });
}

describe("the concierge is the centred anchor in double mode", () => {
  // A REALISTIC WINDOW, stated rather than inherited: jsdom defaults to 1024, which cannot seat five
  // columns at their minimums, so the concierge's window-aware ceiling correctly pins it at 280 and
  // every absolute assertion would be measuring the clamp instead of the gesture.
  const realWidth = window.innerWidth;
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 2560, configurable: true });
    useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
  });
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
    document.documentElement.removeAttribute("style");
  });

  it("gives the concierge a handle on BOTH sides once the left pair is open", () => {
    render(<Workspace />);
    expect(screen.getByTestId("workspace-shell").getAttribute("data-pairs")).toBe("2");
    expect(screen.getByTestId("concierge-pull-tab")).toBeTruthy();
    expect(screen.getByTestId("left-pair-pull-tab")).toBeTruthy();
  });

  it("renders the structure the centring depends on — equal halves, a rail on EACH SIDE of the box", () => {
    render(<Workspace />);
    assertRowStructure();
  });

  // ── EITHER EDGE, OUT BY dx → +2·dx, STILL CENTRED ────────────────────────────────────────────
  it("grows the concierge by 2·dx when the RIGHT edge is pulled outward, and keeps it centred", () => {
    render(<Workspace />);
    const before = conciergeWidth();
    drag(500, 560); // 60px of travel
    expect(conciergeWidth()).toBe(before + 120);
    assertRowStructure();
  });

  it("grows the SAME width by 2·dx when the LEFT edge is pulled outward", () => {
    // THE ROW THAT INVERTS THE OLD CONTRACT. This used to assert `pair-left` gained 80 and the
    // concierge's width was untouched; now the left seam owns the concierge, outward is LEFT, and
    // there is no left-pair width to move.
    render(<Workspace />);
    const before = conciergeWidth();
    dragLeftSeam(500, 440); // 60px outward, in the other direction
    expect(conciergeWidth()).toBe(before + 120);
    assertRowStructure();
  });

  // ── "TAKES dx FROM EACH TERMINAL" AND "MOVES BOTH SEAMS" LIVE IN THE ENGINE SUITE ──────────
  //
  // They were here, computed through `cockpitGeometry` from the painted width — and both reduce to
  // `half` shifting by −dx, which is arithmetic the model owns and this file cannot independently
  // confirm. `columnResize.test.ts` asserts them against the model directly; what remains here is
  // the part that is genuinely about the app: the width a gesture commits, and the structure the
  // model is handed.

  it("wires the concierge's box to the live variable, not to a rendered number", () => {
    // The mechanism behind every "painted" assertion above: the box is sized by the custom property
    // the drag writes. A box given a plain number would make the drag dead until release.
    render(<Workspace />);
    expect(screen.getByTestId("concierge-box").style.width).toContain(`var(${CONCIERGE_WIDTH_VAR}`);
  });

  // ── THE ROW LISTENS TO THE BUILD COLUMNS ─────────────────────────────────────────────────────
  //
  // The paired ceiling reserves both builders at the widths they ACTUALLY have. That is only as good
  // as the mirror it reads, and the mirror is fed by `sparkle:build-width`. `AgentSidebar` is stubbed
  // in this suite, so the EMITTER is pinned in `AgentSidebar.pullTabs.test.tsx` ("announces ON
  // MOUNT"); this is the other half — that the shell acts on what it hears.
  // THE RULE THIS ROW ASSERTS WAS REVERSED ON PURPOSE. It used to require that announcing a wider
  // build column LOWERED this ceiling by twice the extra width, because the reserve was
  // `2 * max(left, right)`. That is precisely what the founder asked to remove: "Nothing should block
  // the other columns from going to any sort of width except for maybe a minimum width of 50 pixels
  // for any given column." Under the old rule, widening one column made another un-widenable — and on
  // a ~890px window it drove this ceiling down ONTO its own floor, so `min === max` and the seam went
  // dead through three consecutive drags in a real session.
  //
  // The guarantee the old reserve bought — a widened builder never gets squeezed — is now delivered
  // by paint clamping plus stored-width preservation instead (see `conciergePairedReserve`), so the
  // preference survives the squeeze and springs back.
  it("does NOT lower the concierge's ceiling when a build column announces a wider width", () => {
    render(<Workspace />);
    // Where the seam stops with the builders at their default.
    drag(500, 9000);
    const ceilingAtDefault = conciergeWidth();
    expect(ceilingAtDefault).toBeGreaterThan(360);

    act(() => {
      window.dispatchEvent(
        new CustomEvent("sparkle:build-width", { detail: { side: "left", width: 800 } }),
      );
    });

    // The same shove stops in exactly the same place: a neighbour's width is not this column's
    // business. Against the old reserve this is `ceilingAtDefault - 1160`.
    drag(500, 9000);
    expect(conciergeWidth()).toBe(ceilingAtDefault);
  });

  // The duplicate-announcement guard is asserted in `Workspace.renderCost.test.tsx`, not here. The
  // version that lived at this spot re-announced the width the mirror already held and checked the
  // ceiling — which is a pure function of the build widths, so it read the same with or without the
  // guard and could never fail (roborev 56115). What the guard actually buys is that a re-announcement
  // writes no state and renders nothing, and only the render-cost harness can see that.

  // ── THE STORED WIDTH IS KEYED BY PAIR COUNT ──────────────────────────────────────────────────
  it("writes the PAIRED key and leaves the single-pair preference alone", async () => {
    localStorage.setItem(CONCIERGE_WIDTH_KEY, "360");
    const { unmount } = render(<Workspace />);
    drag(500, 560);
    const set = conciergeWidth();
    unmount();
    expect(localStorage.getItem(CONCIERGE_WIDTH_KEY_PAIRED)).toBe(String(set));
    // The single-pair width is untouched — which is the whole reason the keys were split. Sharing one
    // means closing the left pair leaves a concierge sized for a 3-display cockpit.
    expect(localStorage.getItem(CONCIERGE_WIDTH_KEY)).toBe("360");
  });

  it("SEEDS the paired width from the single-pair one on first use", () => {
    // An existing install must not snap to a default the moment it opens a left pair.
    localStorage.setItem(CONCIERGE_WIDTH_KEY, "420");
    render(<Workspace />);
    expect(conciergeWidth()).toBe(420);
  });

  it("restores the paired width on the next launch, independently of the single one", () => {
    const first = render(<Workspace />);
    drag(500, 600);
    const set = conciergeWidth();
    first.unmount();
    render(<Workspace />);
    expect(conciergeWidth()).toBe(set);
  });
});

// ── THE FOUNDER'S TWO TARGET LAYOUTS, END TO END ──────────────────────────────────────────────
//
// (A) concierge + both build columns on the centre monitor of a 3×1920 span;
// (B) concierge filling the centre monitor, build columns on the outer ones.
// `CONCIERGE_MAX_WIDTH = 560` blocked both by 2–3.5×. The engine suite proves the geometry delivers
// them; these prove the APP does — that the ceiling permits the drag and the width round-trips.
describe("the 5760px target layouts are reachable in the running shell", () => {
  const realWidth = window.innerWidth;
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 5760, configurable: true });
    useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
  });
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
    document.documentElement.removeAttribute("style");
  });

  for (const [name, target] of [
    ["A — concierge + both builders on the centre monitor", 1100],
    ["B — concierge fills the centre monitor", 1920],
  ] as const) {
    it(`reaches ${name}`, () => {
      render(<Workspace />);
      const start = conciergeWidth();
      // Travel is HALF the width wanted, because the column grows from both edges.
      drag(500, 500 + (target - start) / 2);
      // NOT CLAMPED AWAY — the assertion the old 560 ceiling fails.
      expect(conciergeWidth()).toBe(target);
      expect(paintedConciergeWidth()).toBe(target);
      assertRowStructure();
    });

    it(`round-trips ${name} through localStorage`, () => {
      const first = render(<Workspace />);
      const start = conciergeWidth();
      drag(500, 500 + (target - start) / 2);
      expect(conciergeWidth()).toBe(target);
      first.unmount();
      expect(localStorage.getItem(CONCIERGE_WIDTH_KEY_PAIRED)).toBe(String(target));

      render(<Workspace />);
      expect(conciergeWidth()).toBe(target);
      assertRowStructure();
    });
  }

  it("still collapses to the shared floor on a window too narrow to seat the row", () => {
    // The small-window behaviour is unchanged in KIND: the ceiling floors at the column's own minimum
    // rather than inverting the range. The window has to be genuinely tiny now — with every column on
    // a 50px floor, 900px is roomy, which is exactly the point of the change.
    Object.defineProperty(window, "innerWidth", { value: 200, configurable: true });
    localStorage.setItem(CONCIERGE_WIDTH_KEY_PAIRED, "1920");
    render(<Workspace />);
    // The stored 1920 is KEPT (re-docking to the big display restores it) but PAINTED at the floor.
    expect(paintedConciergeWidth()).toBe(COLUMN_MIN_WIDTH);
  });

  it("keeps the width the window cannot show, and restores it when the window can again", () => {
    localStorage.setItem(CONCIERGE_WIDTH_KEY_PAIRED, "1920");
    const { unmount } = render(<Workspace />);
    expect(conciergeWidth()).toBe(1920);
    unmount();
    // A trip through a laptop-sized window must not destroy the preference.
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    const small = render(<Workspace />);
    expect(paintedConciergeWidth()).toBeLessThan(1920);
    small.unmount();
    expect(localStorage.getItem(CONCIERGE_WIDTH_KEY_PAIRED)).toBe("1920");
  });
});

// ── SINGLE MODE IS UNCHANGED ──────────────────────────────────────────────────────────────────
//
// "Single mode is working fine." Every rule above is gated on `pairCount === 2`, and these are what
// hold that gate up: one seam, 1:1 travel, its own storage key, its own 560 ceiling.
describe("the single-pair shell is untouched by the anchor model", () => {
  const realWidth = window.innerWidth;
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 2560, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
    document.documentElement.removeAttribute("style");
  });

  it("mounts ONE seam — there is no left edge to grow from", () => {
    render(<Workspace />);
    expect(screen.getByTestId("workspace-shell").getAttribute("data-pairs")).toBe("1");
    expect(screen.getByTestId("concierge-pull-tab")).toBeTruthy();
    expect(screen.queryByTestId("left-pair-pull-tab")).toBeNull();
  });

  it("moves 1:1 with the pointer, NOT 2·dx", () => {
    // The symmetric factor is the double-mode rule. Applying it here would make the one seam this
    // layout has twice as fast for no reason.
    render(<Workspace />);
    const before = conciergeWidth();
    drag(500, 560);
    expect(conciergeWidth()).toBe(before + 60);
  });

  it("keeps its own window-aware ceiling and its own storage key", () => {
    // The single-pair row has its OWN reserve (one rail, one pair) and so its own ceiling — that
    // separation is what this row pins, not the old bare 560, which the founder's "nothing should
    // block a column but a 50px floor" rule removed along with every other fixed cap.
    const { unmount } = render(<Workspace />);
    drag(500, 5000);
    // TWO ASSERTIONS, BECAUSE ONE OF THEM CANNOT SEE THE REGRESSION IT NAMES.
    //
    // The wiring check below builds `expected` from the production helper and the production
    // constants — the same expression `Workspace` evaluates. That pins that the ceiling really is
    // this formula rather than a stray literal, but it is a CONSTRUCTION MIRROR: move
    // `PRIMARY_PAIR_ROW_RESERVE` and both sides move together and it stays green. Which is exactly
    // how the reserve slid 360 → 250 unnoticed, and my first attempt at fixing that shipped the same
    // blind spot (roborev 57344 then 57371).
    //
    // So the VALUE is pinned independently, as a literal. If the single-pair reserve is ever meant to
    // change, this line is the one that has to be edited on purpose.
    expect(PRIMARY_PAIR_ROW_RESERVE).toBe(360);
    expect(conciergeWidth()).toBe(window.innerWidth - 366); // 360 reserve + the one 6px rail

    const expected = windowAwareMax(
      COLUMN_HARD_MAX,
      window.innerWidth,
      6 + PRIMARY_PAIR_ROW_RESERVE,
      COLUMN_MIN_WIDTH,
    );
    expect(conciergeWidth()).toBe(expected);
    expect(expected).toBeGreaterThan(560); // the wall that used to stop this drag is gone
    unmount();
    expect(localStorage.getItem(CONCIERGE_WIDTH_KEY)).toBe(String(expected));
    // …and nothing was written under the paired key by a single-pair drag.
    expect(localStorage.getItem(CONCIERGE_WIDTH_KEY_PAIRED)).toBeNull();
  });

  it("leaves the concierge at the row's LEFT — one rail, and it is on the far side", () => {
    render(<Workspace />);
    const root = document.querySelector("[data-concierge-root]")!;
    const box = screen.getByTestId("concierge-box");
    const kids = Array.from(root.children).filter(
      (el) => el.tagName !== "STYLE" && (el as HTMLElement).style.display !== "none",
    );
    // The box leads its group: nothing is rendered before it, so there is no left seam and the
    // column cannot be centred by construction.
    expect(kids.indexOf(box)).toBe(0);
    expect(root.querySelectorAll("[data-testid$='-pull-tab']")).toHaveLength(1);
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
    act(() => useCableStore.getState().patch("right", null));
    expect(screen.getByTestId("workspace-shell").getAttribute("data-wired")).toBe("right");
  });

  it("reports OFF when the wired pair's project has no selected agent", () => {
    // The state an acquisition guard cannot prevent, because nothing is being acquired.
    render(<Workspace />);
    act(() => useCableStore.getState().patch("right", null));
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
  fireEvent.pointerMove(window, { pointerId: 1, clientX: from + dx, buttons: 1 });
  fireEvent.pointerUp(window, { pointerId: 1 });
}

/**
 * ══ NOTHING BELOW HARDCODES A WIDTH, A BOUND, OR THE STORAGE KEY ═══════════════════════════════
 *
 * `Workspace.tsx` keeps the WIDTHS and BOUNDS module-private, and this file does not re-spell them.
 *
 * THE STORAGE KEY IS THE ONE EXCEPTION, and it is a reversal — this block used to forbid exporting
 * anything from `Workspace.tsx` on the grounds that the file was owned by a concurrent agent and any
 * third-party edit, even additive, is the convergence collision AGENTS.md calls this repo's most
 * expensive recurring failure. That concern is real and still worth weighing. It lost here because
 * the alternative turned out to be worse: the key was instead DISCOVERED by diffing localStorage and
 * asserting exactly one key appeared, which asserts a GLOBAL property ("the drag was the only thing
 * in the app that persisted anything in this window") to test a LOCAL one. Once `projectStore` began
 * flushing `sparkle-projects` through its own 400ms debounce inside the same window, that assertion
 * put `main` red across several consecutive commits and blocked every release cut (roborev 55445,
 * bead `sparkle-rqb9`). A single named export is additive and survives a layout rework; a storage
 * census couples this file to every other persister in the application, forever.
 *
 * Copying the literals instead would have been worse than either option. This file exists to catch
 * width-DELIVERY bugs, so a changed default must not surface here as unexplained numeric failures
 * reading like "the drag broke" (roborev 55342). So every expectation is OBSERVED:
 *
 *   • the default    — read off the column at mount;
 *   • the storage key — IMPORTED from the component, never re-spelled and never rediscovered;
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

/** What the drag actually flushed to the width key, read past the 200ms trailing debounce.
 *
 *  ASYNC, and the await is load-bearing. #828 asserted against a persist that hit localStorage on
 *  EVERY mousemove, so reading storage the instant the drag returned saw the write. #825 — merged
 *  with it here — turned that into a 200ms TRAILING DEBOUNCE (`Workspace.tsx`, fixing a synchronous
 *  disk write sitting on the drag's hot path), so at that instant nothing has been written yet.
 *  That is a real interaction between the two PRs, not a merge artifact.
 *
 *  Returns the stored string (or `null`) so callers assert the VALUE. `null` is what catches a
 *  persist that never flushes at all — the same regression #825's own "a debounce that never
 *  flushes is a way to LOSE a width" cases guard from the other side.
 *
 *  It reads `CONCIERGE_WIDTH_KEY` imported from the component rather than DISCOVERING the key by
 *  diffing localStorage, which is what this used to do and why main went red (bead `sparkle-rqb9`).
 *  A diff plus `expect(added).toHaveLength(1)` asserts a GLOBAL property — "the drag was the only
 *  thing in the app that persisted anything in this window" — to test a LOCAL one. It survived only
 *  while nothing else wrote inside the window; once `projectStore` began flushing `sparkle-projects`
 *  there, the diff found 2 keys and this file failed on `main` with the resize path working fine.
 *  Importing the constant cannot desync from the component the way a re-spelled literal would, and
 *  the round-trip assertions below are what still pin read and write to the SAME key. */
async function widthFlushedBy(action: () => void): Promise<string | null> {
  action();
  // 260ms — past the 200ms trailing timer, the same margin #825's persistence cases already use.
  // Awaiting a resolved promise would not do: this is a real timer, not a microtask.
  await new Promise((r) => setTimeout(r, 260));
  return localStorage.getItem(CONCIERGE_WIDTH_KEY);
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
    const dragged = String(start + dx);
    // The flush itself: `null` here is a debounce that never fired, a wrong value is a width that
    // arrived at the column but not at storage.
    expect(await widthFlushedBy(() => dragSeamBy(dx))).toBe(dragged);

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
    // ONE PAST THE VALIDATION BOUND, which is the HARD ceiling rather than the window-aware one:
    // the initializer deliberately keeps a width chosen on a bigger display and clamps it at PAINT
    // (see `renderedConciergeWidth`), so seeding one past the learned window max would be restored
    // on purpose and this row would be asserting the opposite of the contract.
    // THE CONCIERGE'S ceiling, not the shared column one. They are the same number today, which is
    // exactly why this drifted: the initialiser validates through `acceptsStoredConciergeWidth`,
    // which reads `CONCIERGE_MAX_WIDTH`, so seeding `COLUMN_HARD_MAX + 1` stops being "one step
    // outside the real bound" the moment the two part — still green, no longer probing anything
    // (roborev 57533, and the same drift this change closes elsewhere).
    ["above the maximum", () => CONCIERGE_MAX_WIDTH + 1],
    ["below the minimum", (g: { min: number; max: number }) => g.min - 1],
  ])("ignores a persisted width %s rather than restoring it", async (_label, seedFor) => {
    const geo = learnGeometry();
    render(<Workspace />);
    // Prove the persist really happened BEFORE seeding over it. Without this the case could seed a
    // key nothing ever writes and still pass, asserting nothing about the initializer's guard.
    const dx = safeDelta(geo.start, geo.max);
    expect(await widthFlushedBy(() => dragSeamBy(dx))).toBe(String(geo.start + dx));
    cleanup();
    localStorage.setItem(CONCIERGE_WIDTH_KEY, String(seedFor(geo)));

    render(<Workspace />);
    expect(Number(conciergeWidthAttr())).toBe(geo.start);
  });
});

// ── THE CAPTURE HARNESS'S SEED IS HONOURED BY THE REAL SHELL ───────────────────────────────────
//
// `dev/visualFixtures` seeds a concierge width for the `open-pr-menu-narrow` surface, and it bounds
// what it will seed with `acceptsStoredConciergeWidth` — the same predicate this component's state
// initialiser calls. Two rounds of review went into making those agree, and the test that was
// supposed to pin it lives in a NODE-environment file that never imports `Workspace`: it computed
// the expected verdict with the parser's own expression and compared it to the parser, so it
// restated the implementation and could not have gone red if the shell had stopped honouring the
// seed at all (roborev 57522, and the reviewer was right — verified by dropping the initialiser's
// validation and watching that test stay green).
//
// This is the assertion that observes BOTH sides. It seeds through the real fixture entry point and
// mounts the real shell, so it fails if either half moves: the fixture writing a key nobody reads,
// or the initialiser refusing a width the fixture was willing to seed. Either failure is silent in
// production and shows up as a screenshot of the DEFAULT width filed under a name claiming
// otherwise — which is the whole failure mode the parameter's own docs say it exists to prevent.
describe("a width seeded by the visual fixtures survives into the rendered shell", () => {
  const ON = { DEV: true, [DEV_BYPASS_AUTH_FLAG]: "1" };

  it("renders at the seeded width, not at the default", () => {
    // 190 is the width `open-pr-menu-narrow` actually asks for, so this pins the live surface.
    expect(applyVisualFixtures("?visual=1&concierge=190", ON)).toBe(true);
    render(<Workspace />);
    expect(conciergeWidth()).toBe(190);
    // …and specifically NOT the fallback, which is what a broken seed silently produces.
    expect(conciergeWidth()).not.toBe(CONCIERGE_DEFAULT_WIDTH);
  });

  it("honours the floor the predicate accepts", () => {
    expect(applyVisualFixtures(`?visual=1&concierge=${CONCIERGE_MIN_WIDTH}`, ON)).toBe(true);
    render(<Workspace />);
    expect(conciergeWidth()).toBe(CONCIERGE_MIN_WIDTH);
  });

  it("falls back to the default when the parameter names a width the shell would refuse", () => {
    // Below the floor: the fixture must decline to seed, and the shell must then use its default —
    // a capture at the default is wrong, but a capture at a width nothing agreed on is worse.
    expect(applyVisualFixtures(`?visual=1&concierge=${CONCIERGE_MIN_WIDTH - 1}`, ON)).toBe(true);
    render(<Workspace />);
    expect(conciergeWidth()).toBe(CONCIERGE_DEFAULT_WIDTH);
  });

  it("leaves the default alone when no width is asked for", () => {
    expect(applyVisualFixtures("?visual=1", ON)).toBe(true);
    render(<Workspace />);
    expect(conciergeWidth()).toBe(CONCIERGE_DEFAULT_WIDTH);
  });
});

// ── EVERY CAPTURE SURFACE'S SEEDED WIDTH IS ONE THE CAPTURE VIEWPORT CAN ACTUALLY PAINT ────────
//
// `acceptsStoredConciergeWidth` answers "will the state initialiser KEEP this number" and nothing
// more. It is not the whole story, and the doc block that once implied it was has been corrected:
// the shell also clamps at PAINT time (`renderedConciergeWidth = min(width, conciergeMax)`, where
// `conciergeMax` is window-aware), so a width the initialiser happily stores can still be painted
// narrower. At the harness's 1600px viewport the widest paintable single-pair concierge is a good
// deal under the 8000 the predicate allows — so `?concierge=2000` would parse, store, survive the
// initialiser, and photograph clamped, under a filename claiming 2000 (roborev 57522).
//
// That is latent today (the one surface asks for 190, far under any ceiling) and it is a
// SURFACE-AUTHORING mistake rather than a runtime condition, so the guard belongs here rather than
// as a branch in the parser: it reads the real registry, seeds through the real fixture, mounts the
// real shell at the real capture viewport, and asserts the painted width is the one asked for.
//
// IT REPLAYS EACH SURFACE'S WHOLE QUERY, not just the `concierge` parameter it is asking about, and
// that is load-bearing rather than tidy (roborev 57531). The first version rebuilt the search as
// `?visual=1&concierge=<n>`, silently dropping every other parameter — including `pairs`, which
// selects a DIFFERENT paint ceiling: the two-pair shell uses `conciergePairedMax` (~1388 at 1600),
// the single-pair one `windowAwareMax` with a bigger reserve (~1234). A `pairs=2` surface already
// exists in the registry, so `query: "pairs=2&concierge=1300"` was one edit away from failing here
// against a layout the capture never uses — a FALSE red on a legitimate surface, which is how a
// guard gets weakened by the next person rather than trusted. Replaying the real query also means
// any future fixture parameter that moves the ceiling is covered without touching this test.
describe("the visual surfaces ask for widths the capture viewport can paint", () => {
  const ON = { DEV: true, [DEV_BYPASS_AUTH_FLAG]: "1" };
  const realWidth = window.innerWidth;
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
  });

  it("paints each surface's requested concierge width unclamped, in that surface's own layout", async () => {
    // The REGISTRY for both — capture.mjs pulls in node built-ins and cannot load here.
    const { SURFACES, DEFAULT_VIEWPORT } = await import("../../scripts/visual/surfaces.mjs");
    // The `concierge` value decides WHETHER a surface participates and what to compare against; the
    // full `query` is what gets replayed.
    const asking = SURFACES.map((s) => ({
      name: s.name,
      query: s.query ?? "",
      width: new URLSearchParams(s.query ?? "").get("concierge"),
    })).filter((s): s is { name: string; query: string; width: string } => s.width !== null);
    // NON-VACUITY. If the parameter is ever renamed, this loop would silently iterate nothing and
    // read as green — the exact shape this repo keeps re-learning.
    expect(asking.length, "no surface asks for a concierge width — has the param been renamed?")
      .toBeGreaterThan(0);

    for (const { name, query, width } of asking) {
      Object.defineProperty(window, "innerWidth", {
        value: DEFAULT_VIEWPORT.width,
        configurable: true,
      });
      localStorage.clear();
      // THE SURFACE'S OWN QUERY, verbatim — see the note above.
      expect(applyVisualFixtures(`?visual=1&${query}`, ON), name).toBe(true);
      const { unmount } = render(<Workspace />);
      // The PAINTED width, which is what the screenshot records — not the stored one.
      expect(conciergeWidth(), `${name} captures clamped, not at the ${width}px it asks for`).toBe(
        Number(width),
      );
      unmount();
    }
  });
});

describe("the concierge grip clears the pair's tab strip", () => {
  // THE FOUNDER'S REPORT: "those 6 dots are placed in a different place vertically on the concierge
  // and the build columns. They should be in the same spot vertically."
  //
  // The build rail is absolute INSIDE the build column, and that column starts below `.pairtabs`;
  // this rail spans the whole row. Both used the same 34px offset from their own rail, so on screen
  // the build grip sat lower by exactly the strip's height. The build grip cannot rise without
  // overhanging the project tabs, so this one comes down to meet it.
  //
  // The strip is content-sized (`flex: 0 0 auto`), so its height is a layout outcome — hence a
  // `calc()` against a published custom property rather than a constant. `ResizeObserver` never
  // fires in jsdom, so the property is never set here and the fallback `0px` applies; the RESOLVED
  // offset is a browser fact and is deliberately not claimed by this suite. What is assertable, and
  // what actually distinguishes the fix, is that each rail reads the strip of the pair BESIDE it.
  const zoneTop = (testId: string) =>
    screen.getByTestId(`${testId}-zone`).style.top;

  it("reads the RIGHT pair's strip on the right-hand rail", () => {
    render(<Workspace />);
    expect(zoneTop("concierge-pull-tab")).toBe("calc(var(--pairtabs-h-right, 0px) + 34px)");
  });

  it("reads each pair's OWN strip, with both rails mounted at once", () => {
    // MOUNT BOTH, because that is the only state in which a swapped variable is visible: with one
    // pair there is a single rail and either wiring looks identical. The left rail exists only in
    // the two-pair cockpit.
    useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
    render(<Workspace />);
    expect(screen.getByTestId("workspace-shell").getAttribute("data-pairs")).toBe("2");

    expect(zoneTop("left-pair-pull-tab")).toBe("calc(var(--pairtabs-h-left, 0px) + 34px)");
    expect(zoneTop("concierge-pull-tab")).toBe("calc(var(--pairtabs-h-right, 0px) + 34px)");
    // ...and they are not the same property, which is the swap this pins.
    expect(zoneTop("left-pair-pull-tab")).not.toBe(zoneTop("concierge-pull-tab"));
  });

  it("publishes a height property per side, not one shared between the pairs", () => {
    // A single `--pairtabs-h` would be last-writer-wins between two pairs whose strips can differ.
    useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
    render(<Workspace />);
    for (const t of ["left-pair-pull-tab", "concierge-pull-tab"]) {
      expect(zoneTop(t)).toMatch(/^calc\(var\(--pairtabs-h-(left|right), 0px\) \+ 34px\)$/);
    }
  });
});
