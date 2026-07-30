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
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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

import { CONCIERGE_WIDTH_KEY, LEFT_PAIR_WIDTH_KEY, Workspace } from "./Workspace";
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

// ── THE CONCIERGE HAS TWO EDGES, AND THEY MOVE INDEPENDENTLY ──────────────────────────────────
//
// THE REPORT: "I'm still not able to change the width of the concierge… When I change the width on the
// right side, it doesn't move the left side. When I change the width on the left side, it doesn't move
// the right side." Two defects in one sentence, and neither is a clamp:
//
//   1. The concierge's LEFT edge had NO HANDLE AT ALL. One `ColumnPullTab` was mounted, after the
//      column, so from the left pair's side the concierge was a wall.
//   2. The edges were not independent. The concierge stored ONE width and both pairs were `flex: 1`,
//      so that single width was the only adjustable number in the row: growing it shrank both
//      neighbours EQUALLY and the column grew about its CENTRE. Drag the right edge, and the left edge
//      slid left by half the delta on its own.
//
// The fix is one boundary owning one column — each seam resizes the column on its own left — so these
// rows assert the OTHER edge held still, which is the property that was missing. They fail against the
// pre-change code twice over: `left-pair-pull-tab` does not exist, and `pair-left` has no width to hold.
const leftPairWidth = () => Number(screen.getByTestId("pair-left").dataset.width);
function grabLeftSeam(clientX: number) {
  fireEvent.mouseEnter(screen.getByTestId("left-pair-pull-tab"));
  expect(screen.getByTestId("left-pair-pull-tab").getAttribute("data-shown")).toBe("true");
  fireEvent.mouseDown(screen.getByTestId("left-pair-pull-tab-dots"), {
    button: 0,
    clientX,
    buttons: 1,
  });
}
function dragLeftSeam(from: number, to: number) {
  grabLeftSeam(from);
  fireEvent.mouseMove(window, { clientX: to, buttons: 1 });
  fireEvent.mouseUp(window, { clientX: to });
}

describe("the concierge's two edges are independently draggable", () => {
  // A REALISTIC WINDOW, stated rather than inherited. jsdom defaults to 1024px, where the left pair's
  // window-aware ceiling is genuinely 372 — the clamp doing its job — so absolute widths asserted
  // below would be measuring the clamp instead of the drag. 1600 is a normal laptop; the narrow case
  // gets its own row, at the 900px minimum `tauri.conf.json` allows.
  const realWidth = window.innerWidth;
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true });
    useUiStore.setState({ pairAssignment: { p1: "left" }, leftProjectId: "p1" } as never);
  });
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
  });

  it("gives the concierge a handle on BOTH sides once the left pair is open", () => {
    render(<Workspace />);
    expect(screen.getByTestId("workspace-shell").getAttribute("data-pairs")).toBe("2");
    // The right seam has always been here; the left one is what the report was missing.
    expect(screen.getByTestId("concierge-pull-tab")).toBeTruthy();
    expect(screen.getByTestId("left-pair-pull-tab")).toBeTruthy();
  });

  it("dragging the LEFT edge moves it and leaves the concierge's width alone", () => {
    render(<Workspace />);
    const conciergeBefore = conciergeWidth();
    const leftBefore = leftPairWidth();

    dragLeftSeam(500, 580);

    // The edge the user grabbed moved…
    expect(leftPairWidth()).toBe(leftBefore + 80);
    // …and the concierge's own width did NOT, which is the independence claim. Under the single-width
    // model there was no left handle to grab at all, so this row could not even run.
    expect(conciergeWidth()).toBe(conciergeBefore);
  });

  it("dragging the RIGHT edge changes the width and leaves the LEFT edge where it was", () => {
    render(<Workspace />);
    const conciergeBefore = conciergeWidth();
    const leftBefore = leftPairWidth();
    // THE PRECONDITION, WITHOUT WHICH THIS ROW IS VACUOUS — and it was, in the first version. Against
    // the pre-change code `pair-left` carries no inline width, so the reader returns 0 both before and
    // after and "the left edge did not move" is trivially true. Measured: the row passed against
    // origin/main while the other three reddened. A pinned width is a POSITIVE number, so requiring
    // that makes the row fail when the mechanism is absent rather than when the bug is.
    expect(leftBefore).toBeGreaterThan(0);

    drag(500, 570);

    expect(conciergeWidth()).toBe(conciergeBefore + 70);
    // THE ROW THAT PINS THE FIX. With both pairs `flex: 1` the left pair absorbed half of every such
    // drag, so the concierge's left edge moved whenever its right edge did. Pinning the left pair is
    // what takes it out of that negotiation.
    expect(leftPairWidth()).toBe(leftBefore);
  });

  // ── THE NARROW WINDOW, which the first version of this change broke outright ────────────────
  //
  // Pinning the left pair with `flex: 0 0 auto` made the row's non-shrinkable width
  // 640 + 6 + 360 + 6 = 1012px at the defaults, while `tauri.conf.json` allows a 900px window. Below
  // ~1012 the PRIMARY pair — build column and terminal — was squeezed to zero and clipped away by
  // `body { overflow: hidden }`, with no scroll to reach it. A resize feature that can evict the pane
  // the user actually works in is worse than the wall it replaced (roborev 55847).
  it("YIELDS instead of evicting the primary pair — pinned is not unshrinkable", () => {
    render(<Workspace />);
    const left = screen.getByTestId("pair-left");
    // Shrink 1, so the pair gives way under real pressure rather than pushing its neighbour off-screen.
    expect(left.style.flex).toBe("0 1 auto");
    // …and the paint is clamped against the LIVE row, so an already-set width cannot survive a window
    // that shrank under it (roborev 55869).
    expect(left.style.width).toContain("min(");
    expect(left.style.width).toContain("calc(100% -");
    // …but not to nothing: it still has to hold a build column and a terminal.
    expect(left.style.minWidth).toBe("280px");
  });

  it("lowers the left pair's CEILING on a window that cannot afford it", () => {
    // 900 is the narrowest window tauri.conf.json permits. Reserve is concierge-min + both rails + a
    // primary pair worth having (280 + 12 + 360 = 652), so 900 leaves 248 — below the pair's own 320
    // minimum, and the ceiling floors there rather than inverting the range.
    const realWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 900, configurable: true });
    try {
      localStorage.setItem(LEFT_PAIR_WIDTH_KEY, "1200");
      render(<Workspace />);
      // The persisted 1200 is REJECTED rather than restored onto a window that cannot show it — which
      // is what would otherwise put the seam's own handle past the viewport edge with no way back.
      expect(leftPairWidth()).toBeLessThanOrEqual(320);
    } finally {
      Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
    }
  });

  // ── THE NEW PERSISTED STATE, which shipped with no coverage at all ──────────────────────────
  //
  // `LEFT_PAIR_WIDTH_KEY` had no round-trip, no restore and no out-of-range rejection, while the
  // concierge width beside it has a full suite for exactly those paths. A regression in the write, the
  // teardown flush or the range guard would have been silent (roborev 55847).
  it("persists the left pair's width once the drag settles, and reads it back", async () => {
    const { unmount } = render(<Workspace />);
    dragLeftSeam(500, 560);
    const dragged = leftPairWidth();
    expect(dragged).toBe(700);
    await waitFor(() => expect(localStorage.getItem(LEFT_PAIR_WIDTH_KEY)).toBe(String(dragged)));
    unmount();

    render(<Workspace />);
    expect(leftPairWidth()).toBe(dragged);
  });

  it("ignores a persisted left-pair width outside the range rather than restoring it", () => {
    localStorage.setItem(LEFT_PAIR_WIDTH_KEY, "12");
    render(<Workspace />);
    // The default, not the stored nonsense — a stale entry must not wedge the pair off-screen.
    expect(leftPairWidth()).toBe(640);
  });

  it("flushes the left pair's width on teardown, independently of the concierge's", () => {
    const { unmount } = render(<Workspace />);
    dragLeftSeam(500, 540);
    const dragged = leftPairWidth();
    // Unmount INSIDE the debounce window: a trailing timer whose cleanup only cancels would lose it.
    unmount();
    expect(localStorage.getItem(LEFT_PAIR_WIDTH_KEY)).toBe(String(dragged));
  });

  // ONE DIRTY FLAG PER WIDTH, asserted — collapse the two refs back into one and this is what reddens.
  // A shared flag makes moving EITHER width persist BOTH, which destroys a stored preference the local
  // window was too small to seed: 900 comes back as 628, and dragging only the concierge writes the 628
  // over it (roborev 55883/55897). Nothing covered it, because every other persistence row drags the
  // width it then reads.
  it("dragging ONLY the concierge does not persist the left pair's width", () => {
    // A preference set on a bigger display, which this window cannot seed at full value.
    localStorage.setItem(LEFT_PAIR_WIDTH_KEY, "1300");
    const { unmount } = render(<Workspace />);
    // The seeded state is lower than the stored preference — the precondition that makes the clobber
    // possible at all.
    expect(leftPairWidth()).toBeLessThan(1300);

    drag(500, 540); // the CONCIERGE seam only
    unmount();

    // The preference SURVIVES. With one shared ref this reads the seeded-down value instead.
    expect(localStorage.getItem(LEFT_PAIR_WIDTH_KEY)).toBe("1300");
  });

  // THE RESERVE TRACKS THE LIVE CONCIERGE, asserted against a WIDENED concierge — at the default width
  // the old constant and the live expression are numerically identical (652), so a row taken at
  // defaults would be vacuous no matter how exact it looked (roborev 55897).
  it("reserves the concierge's LIVE width, not its minimum", () => {
    render(<Workspace />);
    drag(500, 700); // widen the concierge well past its default
    const concierge = conciergeWidth();
    expect(concierge).toBeGreaterThan(360);

    // The PAINT bound follows the width the concierge actually has. 360 — not `PINNED_PAIR_MIN_WIDTH`
    // — is what the primary pair is owed; borrowing the pinned pair's 280 squeezed it by 80px in a way
    // no default-width row could see, because both compositions total 652 at a 360px concierge
    // (roborev 55910).
    const expected = concierge + 12 + 360;
    expect(screen.getByTestId("pair-left").style.width).toContain(`${expected}px`);
  });

  // THE GESTURE BOUND, ASSERTED SEPARATELY FROM THE PAINT — and this is the row the previous pass was
  // missing. The paint reserve had tracked the live concierge since before that commit, so the row
  // above stayed green while the DRAG ceiling was still on the old constant: revert only `leftPairMax`
  // and nothing reddened. A bound is only as good as the places that agree on it, and each place needs
  // its own assertion (roborev 55910).
  it("stops the left seam at the SAME bound the paint uses, once the concierge is widened", () => {
    render(<Workspace />);
    drag(500, 700); // concierge to its ceiling
    const concierge = conciergeWidth();
    const bound = 1600 - (concierge + 12 + 360);

    // Shove the left seam far past that bound — the gesture must stop exactly where the paint would.
    dragLeftSeam(500, 5000);

    expect(leftPairWidth()).toBe(bound);
    // …and the OLD constant-based ceiling would have permitted 948, so this is not a coincidence of
    // the pair simply refusing to move.
    expect(leftPairWidth()).toBeLessThan(948);
  });

  // THE CONCIERGE'S OWN EDGE IS BOUNDED TOO — the one seam in the row that answered to nobody. With a
  // bare 560 ceiling, a 900px window let this column be dragged over the primary pair entirely: left
  // pair yields to 280, and `900 - 280 - 12 - 560 = 48px` is left for a build column that paints at its
  // 160px floor, putting its pull tab past an `overflow: hidden` viewport (roborev 55910).
  it("lowers the CONCIERGE's ceiling on a window that cannot afford it", () => {
    const realWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 900, configurable: true });
    try {
      const { unmount } = render(<Workspace />);
      expect(screen.getByTestId("workspace-shell").getAttribute("data-pairs")).toBe("2");
      // Drag the right seam as far as it will go. Against the bare 560 constant this reached 560.
      drag(500, 5000);
      const pinned = conciergeWidth();
      const leftPair = leftPairWidth(); // read BEFORE teardown — the DOM is gone after `unmount()`

      // THE GESTURE BOUND, READ WHERE IT IS ACTUALLY DISTINGUISHABLE FROM THE PAINT — and the first
      // version of this row got that wrong, which is worth recording because it is the same mistake
      // finding #1 was about. `data-width` carries the RENDERED width, and the render clamp pins that
      // to 280 whether or not the drag was bounded — so asserting it passed against the bare 560 and
      // proved nothing. What separates the two is the value that gets PERSISTED: the gesture commits
      // raw state, so an unbounded drag stores 560 — a width the layout will never paint, restored on
      // the next launch as a preference that lies (roborev 55897's exact harm).
      unmount();
      expect(localStorage.getItem(CONCIERGE_WIDTH_KEY)).toBe("280");
      // WHAT THE BOUND ACTUALLY PROMISES, stated exactly. 900 cannot seat five columns at their
      // minimums — `320 + 6 + 280 + 6 + 360 = 972` — so the promise is NOT "everyone gets their
      // minimum"; it is that this seam's ceiling collapses to the column's own floor instead of
      // staying at 560 and eating the difference out of the primary pair. `windowAwareMax` floors at
      // `min` rather than inverting the range, and that floor is what shows up here.
      expect(pinned).toBe(280);
      // The primary pair is left something a build column can paint into. Against the bare 560 this
      // was 48px — below the column's own 160 floor, so it overflowed an `overflow: hidden` viewport
      // and took its pull tab off-screen with it. Now it clears that floor.
      expect(900 - leftPair - 12 - pinned).toBeGreaterThan(160);
    } finally {
      Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
    }
  });

  // ── THE PAINT CLAMP, AND THE GESTURE THAT HAS TO START FROM IT ──────────────────────────────
  //
  // A stored width the local window cannot honour is the only state where `conciergeWidth` (stored)
  // and `renderedConciergeWidth` (painted) DIVERGE, so it is the only state in which either of these
  // two fixes is observable. Every other row in this file drives the state to the ceiling with a drag
  // FIRST and then asserts, which makes the clamp invisible (roborev 55948). 1200px with a left pair
  // open: reserve is `320 + 12 + 360 = 692`, so the ceiling is 508 while storage still holds 560.
  function renderWithOversizedStoredConcierge() {
    localStorage.setItem(CONCIERGE_WIDTH_KEY, "560");
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    const r = render(<Workspace />);
    expect(screen.getByTestId("workspace-shell").getAttribute("data-pairs")).toBe("2");
    return r;
  }

  it("PAINTS the concierge at the window's ceiling while leaving the stored width alone", () => {
    renderWithOversizedStoredConcierge();

    // The column is on screen at the ceiling, not at the 560 it was asked for…
    expect(conciergeWidth()).toBe(508);
    // …and the preference is UNTOUCHED, which is the half a state-reconciling clamp would have lost.
    // Re-open on a display that can afford 560 and the user gets 560 back.
    expect(localStorage.getItem(CONCIERGE_WIDTH_KEY)).toBe("560");
  });

  it("starts the seam's drag from the PAINTED width, not the stored one", () => {
    renderWithOversizedStoredConcierge();

    // Drag inward 10px. The seam must track the pointer from 508.
    drag(500, 490);

    // 498 = 508 - 10. Handed the stored 560 instead, `clampWidth(560 - 10)` pins to the 508 ceiling:
    // the first 52px of travel move nothing, and the stored preference collapses on the first
    // pointer-down rather than on a drag the user meant.
    expect(conciergeWidth()).toBe(498);
  });

  // THE SAME TWO PROPERTIES ON THE SIBLING SEAM. The left pair's stored/painted split is reached by a
  // WINDOW RESIZE rather than by a restore — unlike the concierge, its read-through rejects an
  // out-of-range stored width at mount, so state can only outgrow the ceiling after `useWindowWidth`
  // reports a smaller window (roborev 55966).
  it("keeps the LEFT pair's stored width but drags it from the PAINTED one after a shrink", () => {
    render(<Workspace />);
    dragLeftSeam(500, 5000); // to the ceiling this window allows
    const wide = leftPairWidth();
    expect(wide).toBe(868); // 1600 - (360 concierge + 12 rails + 360 primary pair)

    act(() => {
      Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
      window.dispatchEvent(new Event("resize"));
    });

    // THE PREFERENCE SURVIVES THE SHRINK. `Pair` still gets the raw state, and the CSS `min()` brings
    // the paint down without rewriting it — so re-widening the window gives 868 back.
    expect(leftPairWidth()).toBe(wide);

    // …and the seam now drags from the width that is actually on screen. At 1200 the concierge floors
    // at 280, so the pair's ceiling is `1200 - (280 + 12 + 360) = 548`.
    dragLeftSeam(500, 490); // 10px inward
    // 538 = 548 - 10. Handed the stored 868, `clampWidth(868 - 10)` pins to 548: the seam is dead for
    // 320px of outward travel and the stored 868 collapses on the first pointer-down.
    expect(leftPairWidth()).toBe(538);
  });

  it("the left pair is PINNED rather than elastic, which is the mechanism", () => {
    render(<Workspace />);
    // Stated as its own row so the two independence rows above cannot be read as coincidence: the
    // right pair stays elastic on purpose (something must absorb the give — see engine/columnResize).
    expect(screen.getByTestId("pair-left").getAttribute("data-width-mode")).toBe("pinned");
    expect(screen.getByTestId("pair-right").getAttribute("data-width-mode")).toBe("elastic");
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
    ["above the maximum", (g: { min: number; max: number }) => g.max + 1],
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
