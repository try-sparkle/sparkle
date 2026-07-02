// @vitest-environment jsdom
//
// AgentRow behavioral tests for the hover slide-out rework: the rename <input> must stay a SINGLE
// instance across hover changes (so a hover-driven unmount can't commit a half-typed name), and the
// behind/ahead pill must be a clickable rebase button ONLY when behind (the green ahead pill is
// purely informational). Heavy leaf components + the Tauri opener are mocked so the sidebar renders.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
// Stub the branch git actions (keep the store's status/workflow helpers real) so we can assert the
// pills are wired to the right action: red → rebase (refreshAgentBranch), green → land.
vi.mock("../services/branchStatus", async (orig) => ({
  ...(await orig<typeof import("../services/branchStatus")>()),
  landAgentBranch: vi.fn(async () => ({ ok: false as const, reason: "busy" as const })),
  refreshAgentBranch: vi.fn(async () => ({ ok: false as const, reason: "busy" as const })),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
// HistorySearch renders its own search <input>; mock it out so the only textbox on screen is the
// rename field under test.
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

import { AgentSidebar } from "./AgentSidebar";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { landAgentBranch, refreshAgentBranch } from "../services/branchStatus";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Project, AgentTab } from "../types";
import type { BranchStatus } from "../services/branchStatus";

// Both collapsed and hover render the same TITLE; the one-sentence DESCRIPTION (and the
// Location/Status/Progress detail lines) appear ONLY in the hover overlay. Tests use the
// overlay-only path/description as the "is the slide-out open?" marker.
const TITLE = "Agent Name";
const DESCRIPTION = "Refines the agent sidebar hover card";

function mkAgent(over: Partial<AgentTab> = {}): AgentTab {
  return {
    id: "a1",
    name: TITLE,
    kind: "worker",
    parentId: null,
    runtime: "local",
    worktreePath: "/tmp/demo/.worktrees/a1",
    branch: "sparkle/agent-a1",
    baseBranch: "main",
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: { title: TITLE, description: DESCRIPTION },
    shellCommand: null,
    pinnedIndex: null,
    ...over,
  };
}

function mkProject(agents: AgentTab[]): Project {
  return {
    id: "p1",
    name: "Demo",
    rootPath: "/tmp/demo",
    defaultBranch: null,
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    agents,
  };
}

function seedBranch(id: string, bs: BranchStatus) {
  useRuntimeStore.setState({ branchStatus: { [id]: bs }, status: {} });
}
const bs = (over: Partial<BranchStatus> = {}): BranchStatus => ({
  ahead: 0,
  behind: 0,
  dirty: false,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  ...over,
});

beforeEach(() => {
  useRuntimeStore.setState({ branchStatus: {}, status: {} });
  // Mode lives in the singleton uiStore now; reset to the Build default so the worker/build
  // agents under test are listed (Think mode would filter them out).
  useUiStore.setState({ workMode: "build" });
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("AgentRow — rename input is a single instance across hover", () => {
  it("keeps exactly one input while editing, regardless of hover changes", () => {
    render(<AgentSidebar project={mkProject([mkAgent()])} />);

    // Hover the collapsed row → the slide-out overlay mounts and reveals the Location line (an
    // overlay-only element). (mouseOver is how React's onMouseEnter is triggered in jsdom.)
    fireEvent.mouseOver(screen.getByText(TITLE));
    expect(screen.getByText("/tmp/demo/.worktrees/a1")).toBeTruthy();

    // Double-click the overlay's title to rename → the overlay is suppressed and the in-flow row
    // owns the ONE input. The title text disappears (input stands in for it). After hover the title
    // exists twice (hidden in-flow + overlay); the overlay copy is the last one.
    const titles = screen.getAllByText(TITLE);
    fireEvent.doubleClick(titles[titles.length - 1]!);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByText(TITLE)).toBeNull();

    // Toggling hover mid-rename must NOT spawn or swap a second input.
    const row = screen.getByRole("textbox").closest("div")!;
    fireEvent.mouseOut(row);
    fireEvent.mouseOver(row);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("Escape cancels the rename without committing (no second input, edit dropped)", () => {
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    fireEvent.doubleClick(screen.getByText(TITLE));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "scratch-typing" } });
    fireEvent.keyDown(input, { key: "Escape" });
    // Edit dropped → back to the name, no lingering input.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(TITLE)).toBeTruthy();
  });
});

describe("AgentRow — Status line behind/ahead pill", () => {
  // The pill now lives on the hover card's "Status" line (not in the collapsed row), so each test
  // opens the slide-out first. mouseOver triggers React's onMouseEnter in jsdom.
  const openOverlay = () => fireEvent.mouseOver(screen.getByText(TITLE));

  it("renders the behind pill as a clickable catch-up button", () => {
    seedBranch("a1", bs({ behind: 4 }));
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openOverlay();
    const pill = screen.getByRole("button", { name: /behind main/i });
    expect(pill.textContent).toMatch(/catch up/i);
  });

  it("renders the ahead pill as a clickable land (merge) button", () => {
    seedBranch("a1", bs({ ahead: 2 }));
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openOverlay();
    const pill = screen.getByRole("button", { name: /ahead/i });
    expect(pill.textContent).toMatch(/merge/i);
    expect(pill.textContent).not.toMatch(/catch up/i);
  });

  it("clicking the green pill invokes the land flow (not a rebase)", () => {
    seedBranch("a1", bs({ ahead: 2 }));
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openOverlay();
    fireEvent.click(screen.getByRole("button", { name: /ahead/i }));
    expect(landAgentBranch).toHaveBeenCalledTimes(1);
    expect(refreshAgentBranch).not.toHaveBeenCalled();
  });

  it("clicking the red pill invokes the rebase flow (not a land)", () => {
    seedBranch("a1", bs({ behind: 3 }));
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openOverlay();
    fireEvent.click(screen.getByRole("button", { name: /behind main/i }));
    expect(refreshAgentBranch).toHaveBeenCalledTimes(1);
    expect(landAgentBranch).not.toHaveBeenCalled();
  });
});

describe("AgentRow — clickable path", () => {
  it("clicking the expanded path reveals the worktree folder in Finder", () => {
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    // Path only shows in the hover-expanded overlay.
    fireEvent.mouseOver(screen.getByText(TITLE));
    fireEvent.click(screen.getByText("/tmp/demo/.worktrees/a1"));
    expect(revealItemInDir).toHaveBeenCalledWith("/tmp/demo/.worktrees/a1");
  });
});

describe("AgentRow — hover card title + description and detail lines", () => {
  it("reveals the one-sentence description on hover; collapsed shows only the title", () => {
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    // Collapsed: the title is shown, the description is NOT.
    expect(screen.getByText(TITLE)).toBeTruthy();
    expect(document.body.textContent).not.toContain(DESCRIPTION);
    // Hover → the overlay reveals "Title:  description".
    fireEvent.mouseOver(screen.getByText(TITLE));
    expect(document.body.textContent).toContain(DESCRIPTION);
  });

  it("shows 'Title: description' inline on a single non-wrapping line in the strip", () => {
    // The expanded strip shows the title AND the description inline on ONE line. The line is
    // nowrap + ellipsis, so a long description truncates instead of wrapping and growing the strip
    // taller over the column rows beneath it. (Earlier the description lived in the drop-down; the
    // single-line-ellipsis approach lets it sit beside the title without the column-growth bug.)
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    fireEvent.mouseOver(screen.getByText(TITLE));
    const card = screen.getByTestId("agent-hover-card");
    const strip = (Array.from(card.children) as HTMLElement[])[0]!;
    expect(strip.textContent).toContain(TITLE);
    expect(strip.textContent).toContain(DESCRIPTION);
    // The title+description share one nowrap container (the title span's parent), so it can't wrap.
    const lineEl = within(strip).getByText(TITLE).parentElement as HTMLElement;
    expect(lineEl.style.whiteSpace).toBe("nowrap");
    expect(lineEl.style.textOverflow).toBe("ellipsis");
  });

  it("active agent: the in-flow row AND its card take the terminal color and merge into it", () => {
    useUiStore.setState({ activeSpecial: null } as never);
    const project = mkProject([mkAgent()]);
    project.selectedAgentId = "a1"; // → isActive
    render(<AgentSidebar project={project} />);
    // Resting active row: the terminal color (var(--c-forest)), square right edge, pulled 8px right
    // (past the list padding) so it meets the sidebar border / terminal with no seam.
    const row = document.querySelector('[draggable="true"]') as HTMLElement;
    expect(row.style.background).toBe("var(--c-forest)");
    expect(row.style.marginRight).toBe("-8px");
    // Hover → the card is the terminal color with NO drop-shadow (it merges into the terminal).
    fireEvent.mouseEnter(row);
    const card = screen.getByTestId("agent-hover-card");
    expect(["none", ""]).toContain(card.style.filter);
    const strip = (Array.from(card.children) as HTMLElement[])[0]!;
    expect(strip.style.background).toBe("var(--c-forest)");
    // A thin border in the SIDEBAR color (deep-forest) outlines the card over the terminal so its
    // text stays distinguishable from the terminal text behind it.
    expect(strip.style.border).toContain("var(--c-deep-forest)");
  });

  it("omits the description span entirely when the description is empty", () => {
    render(<AgentSidebar project={mkProject([mkAgent({ autoNameVariants: { title: TITLE, description: "" } })])} />);
    fireEvent.mouseOver(screen.getByText(TITLE));
    expect(screen.getByText("/tmp/demo/.worktrees/a1")).toBeTruthy(); // overlay is open…
    // …but with no description there is no leading "colon-space-space" run anywhere in the card.
    expect(document.body.textContent).not.toContain(":  ");
  });

  it("Status line reads 'Up to date' when the branch is neither ahead nor behind", () => {
    seedBranch("a1", bs({ ahead: 0, behind: 0 }));
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    fireEvent.mouseOver(screen.getByText(TITLE));
    expect(document.body.textContent).toContain("Up to date with main");
  });

  it("Progress line shows percent-only (no worker count) for a leaf agent", () => {
    seedBranch("a1", bs({ behind: 1 })); // behind copy avoids the word 'worker' in the Status line
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    fireEvent.mouseOver(screen.getByText(TITLE));
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/% complete\./);
    expect(body).not.toContain("% complete overall"); // leaf → no "overall"
  });

  it("Progress line counts workers and says 'overall' for an orchestrator", () => {
    const build = mkAgent({
      id: "b1",
      name: "Orchestrator",
      kind: "build",
      autoNameVariants: { title: "Orchestrator", description: "" },
    });
    const worker = mkAgent({
      id: "w1",
      name: "Worker",
      kind: "worker",
      parentId: "b1",
      autoNameVariants: { title: "Worker", description: "" },
      worktreePath: "/tmp/demo/.worktrees/w1",
    });
    useRuntimeStore.setState({ branchStatus: { b1: bs({ behind: 1 }), w1: bs({ behind: 1 }) }, status: {} });
    render(<AgentSidebar project={mkProject([build, worker])} />);
    fireEvent.mouseOver(screen.getByText("Orchestrator"));
    expect(document.body.textContent).toMatch(/1 worker\. \d+% complete overall\./);
  });
});

// The hover card on a row near the bottom of the column would otherwise be clipped by the viewport.
// On hover we GENTLY scroll the list up by just enough to fit the whole card, and ease it back on
// un-hover — but ONLY when the card actually overflows. jsdom has no layout, so we stub the few
// measurements the logic reads: the row's rect (getBoundingClientRect), the card halves' heights
// (offsetHeight / scrollHeight), the scroll container's metrics, and window.innerHeight.
describe("AgentRow — auto-scrolls the column so a bottom-of-viewport hover card isn't clipped", () => {
  const NEEDED = 200; // strip.offsetHeight (80) + detail.scrollHeight (120)
  let savedInnerHeight: number;

  const stubLayout = (innerHeight: number) => {
    savedInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: innerHeight });
    // Every element reports a low row (top: 380) so the captured rect.top sits near the bottom.
    HTMLElement.prototype.getBoundingClientRect = () =>
      ({ left: 10, top: 380, width: 200, right: 210, bottom: 420, height: 40, x: 10, y: 380, toJSON: () => {} }) as DOMRect;
    // The scroll container reports a tall, scrollable list; the card halves report fixed heights.
    const isList = (el: HTMLElement) => el.getAttribute?.("data-testid") === "agent-list-scroll";
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return isList(this) ? 1000 : 120; // list room vs. detail content
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return isList(this) ? 300 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 80 });
  };

  afterEach(() => {
    // stubLayout assigns getBoundingClientRect as an OWN prop on HTMLElement.prototype (the real one
    // lives on Element.prototype); deleting it unconditionally restores the inherited impl. The other
    // three are defined props, also deleted, so none of these stubs leak into later test files.
    Reflect.deleteProperty(HTMLElement.prototype, "getBoundingClientRect");
    Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
    Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: savedInnerHeight });
  });

  it("gently scrolls the list up (smooth) so the full card fits when it would overflow the bottom", () => {
    // innerHeight 400, card needs 380 (rect.top) + 200 + 16 margin → overflows by 196px.
    stubLayout(400);
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    const list = screen.getByTestId("agent-list-scroll");
    const scrollTo = vi.fn((opts: ScrollToOptions) => {
      list.scrollTop = opts.top ?? 0; // reflect the scroll so the baseline/restore math is real
    });
    list.scrollTo = scrollTo as typeof list.scrollTo;

    fireEvent.mouseOver(screen.getByText(TITLE));

    expect(scrollTo).toHaveBeenCalledTimes(1);
    const opts = scrollTo.mock.calls[0]![0]!;
    expect(opts.behavior).toBe("smooth"); // slow, not jarring
    expect(opts.top).toBeGreaterThan(0); // scrolled the top rows up out of view
    expect(opts.top).toBe(380 + NEEDED + 16 - 400); // exactly the overflow
  });

  it("does NOT move the column when the card already fits", () => {
    stubLayout(2000); // tall viewport → 380 + 200 + 16 well within → no overflow
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    const list = screen.getByTestId("agent-list-scroll");
    const scrollTo = vi.fn();
    list.scrollTo = scrollTo as typeof list.scrollTo;

    fireEvent.mouseOver(screen.getByText(TITLE));

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("eases the column back to its prior position after the cursor leaves", async () => {
    stubLayout(400);
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    const list = screen.getByTestId("agent-list-scroll");
    const scrollTo = vi.fn((opts: ScrollToOptions) => {
      list.scrollTop = opts.top ?? 0;
    });
    list.scrollTo = scrollTo as typeof list.scrollTo;

    const row = screen.getByText(TITLE);
    fireEvent.mouseOver(row); // reveal → scrolls up to 196 (baseline captured as 0)
    expect(scrollTo).toHaveBeenCalledTimes(1);

    fireEvent.mouseOut(row); // un-hover → after the close + restore debounce, ease back to baseline 0
    await vi.waitFor(
      () => {
        const last = scrollTo.mock.calls.at(-1)![0]!;
        expect(scrollTo.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(last.top).toBe(0);
        expect(last.behavior).toBe("smooth");
      },
      { timeout: 1000 },
    );
  });

  it("does NOT yank the list back when the user's OWN scroll closes the card", async () => {
    // Regression: a user scroll closes the card (setHover false), which used to fire restore() and
    // undo the user's deliberate scroll. Now the reveal is abandoned, so no ease-back happens.
    stubLayout(400);
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    const list = screen.getByTestId("agent-list-scroll");
    const scrollTo = vi.fn((opts: ScrollToOptions) => {
      list.scrollTop = opts.top ?? 0;
    });
    list.scrollTo = scrollTo as typeof list.scrollTo;

    fireEvent.mouseOver(screen.getByText(TITLE)); // reveal → scrolls up to 196
    expect(screen.getByText("/tmp/demo/.worktrees/a1")).toBeTruthy(); // card open
    expect(scrollTo).toHaveBeenCalledTimes(1);

    // The reveal's scrollTo already put scrollTop on its target; the first scroll event merely
    // DETECTS that landing and clears the "auto" flag (during our animation the card re-pins rather
    // than closing). The SECOND scroll is therefore treated as a genuine user scroll → it closes.
    fireEvent.scroll(list);
    fireEvent.scroll(list);

    // The card closed and the list was NOT eased back (no further scrollTo calls after a beat).
    expect(screen.queryByText("/tmp/demo/.worktrees/a1")).toBeNull();
    await new Promise((r) => setTimeout(r, 150)); // past the 90ms restore debounce
    expect(scrollTo).toHaveBeenCalledTimes(1); // still just the reveal — no restore
  });
});

// The hover card is a fixed-position portal on document.body, so wheel events over it never reach
// the list's overflow:auto container — and because a card covers whatever row the cursor is on,
// this made the list unscrollable basically ALWAYS. The sidebar owns a window-level wheel listener
// that forwards the delta to the list whenever the POINTER is over the list's box but the event is
// riding an overlay (the card — or document.body, where Chromium retargets the remainder of a
// scroll gesture after the card under it unmounts). These tests pin that forwarding contract.
describe("AgentSidebar — two-finger scroll works while a hover card is open", () => {
  // The listener reads only the LIST's rect (pointer-in-box gate); stub it on the instance.
  const LIST_RECT = { left: 0, top: 0, right: 200, bottom: 600, width: 200, height: 600, x: 0, y: 0, toJSON: () => {} } as DOMRect;
  const setup = () => {
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    const list = screen.getByTestId("agent-list-scroll");
    list.getBoundingClientRect = () => LIST_RECT;
    fireEvent.mouseOver(screen.getByText(TITLE)); // open the hover card
    return { list, card: screen.getByTestId("agent-hover-card") };
  };

  it("forwards a wheel over the hover card to the list and consumes the event", () => {
    const { list, card } = setup();
    const notPrevented = fireEvent.wheel(card, { deltaY: 48, clientX: 100, clientY: 100, cancelable: true });
    expect(list.scrollTop).toBe(48);
    expect(notPrevented).toBe(false); // preventDefault — nothing else may double-consume the delta
  });

  it("normalizes line-mode wheels (real mouse wheel) to pixels", () => {
    const { list, card } = setup();
    fireEvent.wheel(card, { deltaY: 3, deltaMode: 1, clientX: 100, clientY: 100, cancelable: true });
    expect(list.scrollTop).toBe(48); // 3 lines × 16px
  });

  it("keeps forwarding when the gesture retargets to document.body (card unmounted mid-scroll)", () => {
    const { list } = setup();
    fireEvent.wheel(document.body, { deltaY: 30, clientX: 100, clientY: 100, cancelable: true });
    expect(list.scrollTop).toBe(30);
  });

  it("leaves the wheel alone when the pointer is past the list's edge (terminal side of the card)", () => {
    const { list, card } = setup();
    const notPrevented = fireEvent.wheel(card, { deltaY: 48, clientX: 500, clientY: 100, cancelable: true });
    expect(list.scrollTop).toBe(0);
    expect(notPrevented).toBe(true);
  });

  it("leaves the wheel alone over the list's own content (native scroll owns it)", () => {
    const { list } = setup();
    const notPrevented = fireEvent.wheel(list, { deltaY: 48, clientX: 100, clientY: 100, cancelable: true });
    expect(list.scrollTop).toBe(0); // no forwarding — jsdom has no native scroll, so 0 proves we didn't touch it
    expect(notPrevented).toBe(true);
  });
});
