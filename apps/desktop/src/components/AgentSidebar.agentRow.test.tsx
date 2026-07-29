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
import { resetCable } from "../stores/cableStore";
import { landAgentBranch, refreshAgentBranch } from "../services/branchStatus";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Project, AgentTab } from "../types";
import type { BranchStatus } from "../services/branchStatus";

// Both collapsed and hover render the same TITLE; the one-sentence DESCRIPTION (and the
// Location/Status/Progress detail lines) appear ONLY in the hover overlay. Tests use the
// overlay-only path/description as the "is the slide-out open?" marker.
const TITLE = "Agent Name";
const DESCRIPTION = "Refines the agent sidebar hover card";

// The default fixture is a top-level BUILD agent (orchestrator) — the canonical renderable row.
// Workers are never top-level rows (orderedTopLevelAgents filters kind === "worker"), so a lone
// `kind: "worker"` fixture would be filtered out and render nothing; tests that specifically need
// a nested worker set kind + parentId explicitly (see "counts workers … for an orchestrator").
function mkAgent(over: Partial<AgentTab> = {}): AgentTab {
  return {
    id: "a1",
    name: TITLE,
    kind: "build",
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
  // AT REST, EXPLICITLY. Clicks in this file land inside a row's hover card, and that bubbles to the
  // row — which patches the cable, which opens every row's CONCIERGE end (engine/rowGeometry). The
  // cable store is module state, so without this the geometry assertions below would read whatever
  // the previous test left patched and pass or fail on test ORDER.
  resetCable();
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  resetCable();
});

describe("AgentRow — rename input is a single instance across hover", () => {
  it("keeps exactly one input while editing, regardless of hover changes", () => {
    render(<AgentSidebar project={mkProject([mkAgent()])} />);

    // Hover the collapsed row → the slide-out overlay mounts and reveals the Location line (an
    // overlay-only element). (mouseOver is how React's onMouseEnter is triggered in jsdom.)
    fireEvent.contextMenu(screen.getByText(TITLE));
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
  const openOverlay = () => fireEvent.contextMenu(screen.getByText(TITLE));

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
    fireEvent.contextMenu(screen.getByText(TITLE));
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
    fireEvent.contextMenu(screen.getByText(TITLE));
    expect(document.body.textContent).toContain(DESCRIPTION);
  });

  it("shows 'Title: description' inline on a single non-wrapping line in the strip", () => {
    // The expanded strip shows the title AND the description inline on ONE line. The line is
    // nowrap + ellipsis, so a long description truncates instead of wrapping and growing the strip
    // taller over the column rows beneath it. (Earlier the description lived in the drop-down; the
    // single-line-ellipsis approach lets it sit beside the title without the column-growth bug.)
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    fireEvent.contextMenu(screen.getByText(TITLE));
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
    // (past the list padding) so it reaches the sidebar's right border.
    //
    // THE ROW BLEEDS THROUGH — there is no drawn boundary here. The row, the column's right edge
    // and the terminal beyond it are all `C.forest`, so the active row runs straight out of the
    // list and into the pane it selects; the square corner and the concave fillets shape that edge
    // into an opening rather than a card.
    //
    // This paragraph said the opposite for one commit. A `hairline` rule had been added to the
    // column when the black-and-gold palette flattened this plane pair to 1.08:1, and the row
    // DOCKED against it. Blueprint restores the step (1.216 dark / 1.201 light, now bounded from
    // both sides in theme/chromeContrast) and the rule is gone again — see the seam rule beside the
    // plane tokens in theme/colors for why this seam in particular cannot carry one.
    const row = document.querySelector('[draggable="true"]') as HTMLElement;
    expect(row.style.background).toBe("var(--c-forest)");
    expect(row.style.marginRight).toBe("-8px");
    // Hover → the card is the terminal color with NO drop-shadow (it merges into the terminal).
    fireEvent.contextMenu(row);
    const card = screen.getByTestId("agent-hover-card");
    expect(["none", ""]).toContain(card.style.filter);
    const strip = (Array.from(card.children) as HTMLElement[])[0]!;
    expect(strip.style.background).toBe("var(--c-forest)");
    // A border outlines the card over the terminal so its text stays distinguishable from the
    // terminal text behind it. It is the `hairline` token, NOT a depth plane: it used to be
    // deep-forest ("lighter than forest"), which the black-and-gold repaint leaves a hair from the
    // terminal the card is outlined against — an outline you cannot see. `hairline`'s floor
    // against every plane is enforced in theme/chromeContrast.test.ts.
    expect(strip.style.border).toContain("var(--c-hairline)");
    expect(strip.style.border).not.toContain("var(--c-deep-forest)");
  });

  it("a HOVER-only card is a plane, not a row-state fill — it carries the column's own inks", () => {
    // The card had `background: CHAT_USER_BUBBLE` while being a full content panel: DetailLine's
    // `muted` labels, PathReveal's `muted` path, the `successInk` landed mark. Those are PLANE inks,
    // and no value of a chrome fill can carry them (theme/chromeContrast.test.ts measures that in
    // both directions), so the surface moved rather than the token. `barSurface` is the plane for
    // something that FRAMES the terminal, which is what a floating card over it is.
    useUiStore.setState({ activeSpecial: null } as never);
    const project = mkProject([mkAgent()]);
    project.selectedAgentId = null; // → NOT active, so the card takes the hover-only treatment
    render(<AgentSidebar project={project} />);
    fireEvent.contextMenu(screen.getByText(TITLE));
    const card = screen.getByTestId("agent-hover-card");
    const [strip, detail] = Array.from(card.children) as HTMLElement[];
    for (const half of [strip!, detail!]) {
      expect(half.style.background).toBe("var(--c-bar-surface)");
      expect(half.style.background).not.toBe("var(--c-chat-bubble)");
    }
    // And the inks inside it really are the column's — this is what the surface was chosen for.
    const label = screen.getByText("Location:");
    expect(label.style.color).toBe("var(--c-muted)");
  });

  // THE SEAM IS A PLANE STEP AGAIN, NOT A DRAWN LINE — and the palette is the reason the
  // assertion could flip. This used to demand a `hairline` here, because the black-and-gold
  // repaint left `deepForest` and `forest` 1.08:1 apart: a boundary with neither a fill step nor
  // a line, so a rule was the only way to make the app's most prominent structural edge exist.
  //
  // Blueprint re-derives the ramp to darken left to right, and this exact pair is now a measured
  // step in both themes (theme/chromeContrast.test.ts owns that floor, which is why this file
  // asserts the ABSENCE of a border rather than restating a ratio it cannot see).
  //
  // Drawing it is now actively wrong: the line cut across the active row, which is painted in the
  // terminal's own colour so it can flow INTO the pane it opens. With a rule there the row docked
  // against it and the concave fillets shaped an opening that was immediately sealed.
  //
  // On the assertion itself: jsdom serializes `borderRight: "none"` to the EMPTY STRING, so
  // `toBe("none")` fails against a component that is doing exactly the right thing. Both spellings
  // are accepted, and the load-bearing half is the second one — no hairline, whatever the
  // serializer prints — so re-drawing the rule fails this test rather than slipping through.
  it("the column has NO drawn right border — the plane step carries the boundary", () => {
    const { container } = render(<AgentSidebar project={mkProject([mkAgent()])} />);
    const column = container.firstElementChild as HTMLElement;
    expect(column.style.background).toBe("var(--c-deep-forest)");
    expect(["", "none"]).toContain(column.style.borderRight);
    expect(column.style.borderRight).not.toContain("var(--c-hairline)");
  });

  it("omits the description span entirely when the description is empty", () => {
    render(<AgentSidebar project={mkProject([mkAgent({ autoNameVariants: { title: TITLE, description: "" } })])} />);
    fireEvent.contextMenu(screen.getByText(TITLE));
    expect(screen.getByText("/tmp/demo/.worktrees/a1")).toBeTruthy(); // overlay is open…
    // …but with no description there is no leading "colon-space-space" run anywhere in the card.
    expect(document.body.textContent).not.toContain(":  ");
  });

  it("Status line reads 'Up to date' when the branch is neither ahead nor behind", () => {
    seedBranch("a1", bs({ ahead: 0, behind: 0 }));
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    fireEvent.contextMenu(screen.getByText(TITLE));
    expect(document.body.textContent).toContain("Up to date with main");
  });

  it("Progress line shows percent-only (no worker count) for a leaf agent", () => {
    seedBranch("a1", bs({ behind: 1 })); // behind copy avoids the word 'worker' in the Status line
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    fireEvent.contextMenu(screen.getByText(TITLE));
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
    fireEvent.contextMenu(screen.getByText("Orchestrator"));
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

  const stubLayout = (innerHeight: number, detailContent = 120) => {
    savedInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: innerHeight });
    const isList = (el: HTMLElement) => el.getAttribute?.("data-testid") === "agent-list-scroll";
    // The ROW reports a low rect (top: 380) so the captured rect.top sits near the bottom, while the
    // LIST container starts at the top of the sidebar (top: 0). That gap is the headroom the reveal
    // may consume: it must never scroll the row above the list's top (380 − 0 = 380px of headroom).
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return isList(this)
        ? ({ left: 0, top: 0, width: 200, right: 200, bottom: 300, height: 300, x: 0, y: 0, toJSON: () => {} } as DOMRect)
        : ({ left: 10, top: 380, width: 200, right: 210, bottom: 420, height: 40, x: 10, y: 380, toJSON: () => {} } as DOMRect);
    };
    // The scroll container reports a tall, scrollable list; the card halves report fixed heights.
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return isList(this) ? 1000 : detailContent; // list room vs. detail content
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

    fireEvent.contextMenu(screen.getByText(TITLE));

    expect(scrollTo).toHaveBeenCalledTimes(1);
    const opts = scrollTo.mock.calls[0]![0]!;
    expect(opts.behavior).toBe("smooth"); // slow, not jarring
    expect(opts.top).toBeGreaterThan(0); // scrolled the top rows up out of view
    expect(opts.top).toBe(380 + NEEDED + 16 - 400); // exactly the overflow
  });

  it("caps the reveal at the list's top so a tall many-worker card never drags the row off-screen", () => {
    // Regression: a card far taller than the viewport (many subworkers → detail 2000px) overflows by
    // 2000 + 80 + 16 + 380 − 400 = 2076px. The naive reveal asked the list to scroll by the FULL
    // overflow (clamped only to the list's 700px max scroll), dragging the clicked row clean off the
    // TOP of the list — which visually deselects it and, once the auto-scroll settles, closes the
    // card. The reveal must instead cap at the row-top-to-list-top distance (380 − 0 = 380); the
    // card's own maxH + detail overflow scroll cover the remainder (the subworkers scroll INSIDE the
    // card). So the row's top lands exactly at the list top and stays visible.
    stubLayout(400, 2000);
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    const list = screen.getByTestId("agent-list-scroll");
    const scrollTo = vi.fn((opts: ScrollToOptions) => {
      list.scrollTop = opts.top ?? 0;
    });
    list.scrollTo = scrollTo as typeof list.scrollTo;

    fireEvent.contextMenu(screen.getByText(TITLE));

    expect(scrollTo).toHaveBeenCalledTimes(1);
    const opts = scrollTo.mock.calls[0]![0]!;
    expect(opts.top).toBe(380); // capped at row.top − list.top, NOT the 700px list max scroll
    expect(screen.getByText("/tmp/demo/.worktrees/a1")).toBeTruthy(); // card stayed open
  });

  it("does NOT move the column when the card already fits", () => {
    stubLayout(2000); // tall viewport → 380 + 200 + 16 well within → no overflow
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    const list = screen.getByTestId("agent-list-scroll");
    const scrollTo = vi.fn();
    list.scrollTo = scrollTo as typeof list.scrollTo;

    fireEvent.contextMenu(screen.getByText(TITLE));

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
    fireEvent.contextMenu(row); // open the card → reveal scrolls up to 196 (baseline captured as 0)
    expect(scrollTo).toHaveBeenCalledTimes(1);

    fireEvent.mouseOut(row); // leave → after the close + restore debounce, ease back to baseline 0
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

    fireEvent.contextMenu(screen.getByText(TITLE)); // reveal → scrolls up to 196
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
    fireEvent.contextMenu(screen.getByText(TITLE)); // open the hover card
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

// THE LADDER'S SITES, PINNED AS SITES. The numeric floors live in theme/chromeContrast.test.ts, but
// a floor only binds a token — it cannot notice that a COMPONENT reached for the wrong one. Every
// case below is a site the ladder sweep missed precisely because nothing here named it (roborev
// 53613 / 53614 / 53616), so each asserts the token the site reaches for, and the one it came from.
describe("AgentSidebar — the chrome tokens the hover card and its chips reach for", () => {
  const openOverlay = () => fireEvent.contextMenu(screen.getByText(TITLE));

  // The ahead pill painted `${C.success}22` behind `successInk`. The ladder's table measured that
  // ink on the BARE plane (light 4.552) and never on the wash it actually sits on, where it fell to
  // 4.127 — under AA — in exchange for 1.103:1 of visible fill. The behind pill next to it was
  // already transparent; these are one control in two states.
  it("the ahead pill is untinted, like the behind pill it shares a control with", () => {
    seedBranch("a1", bs({ ahead: 2 }));
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openOverlay();
    const ahead = screen.getByRole("button", { name: /ahead/i });
    expect(ahead.style.background).toBe("transparent");
    // The ink is what the wash was starving, so pin that it is still the one being protected.
    expect(ahead.style.color).toBe("var(--c-success-ink)");
  });

  it("both branch pills read by their border, not by a fill", () => {
    seedBranch("a1", bs({ behind: 3 }));
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openOverlay();
    expect(screen.getByRole("button", { name: /behind main/i }).style.background).toBe("transparent");
  });

  // `deepForest` is a PLANE. Filling a chip with it inside a `barSurface` card is a plane on a
  // plane — 1.079/1.248, a filled chip with no visible fill. `pillFill` is the token whose
  // documented role is exactly a filled chip.
  it("the close button's hover pill fills with pillFill, not the deepForest plane", () => {
    render(<AgentSidebar project={mkProject([mkAgent()])} />);
    openOverlay();
    const close = screen.getByRole("button", { name: /close agent/i });
    fireEvent.mouseEnter(close);
    expect(close.style.background).toBe("var(--c-pill-fill)");
    expect(close.style.background).not.toBe("var(--c-deep-forest)");
  });
});

// The pinned "Improve Sparkle" footer row. It painted CHAT_USER_BUBBLE when active — a CHROME FILL —
// under a comment claiming it matched the agent rows' selected treatment, which takes `C.forest`.
// That made it the fourth consumer of a chrome fill carrying PLANE inks, and made the ladder's own
// recorded claim ("what is left on this token is chat bubbles and row fills, carrying `cream`")
// false for the second time. Everything the row carries is a plane ink — a `cream` title, `muted`
// badges, and the StatusDot the row is actually read by, which measured 4.56/1.01 (dark/light) for
// green on the bubble, i.e. invisible in light mode. (Those inks are now the BUILD ROWS' inks, since
// the row shares their anatomy; the measurement that picked `forest` is unaffected — if anything the
// neutral title is a strictly easier case than the `statusInk(...)` one it replaced.)
describe("AgentSidebar — the Improve Sparkle row is a plane when active, never a chrome fill", () => {
  const sparkleRow = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-hint="improve"]')!;

  it("takes the terminal plane when active — the same token a selected agent row takes", () => {
    useUiStore.setState({ workMode: "build", activeSpecial: "sparkle" } as never);
    const { container } = render(<AgentSidebar project={mkProject([mkAgent()])} />);
    const row = sparkleRow(container);
    expect(row.style.background).toBe("var(--c-forest)");
    // The token it came from, named so a revert cannot pass quietly.
    expect(row.style.background).not.toBe("var(--c-chat-bubble)");
  });

  it("is transparent when inactive, so it sits on the column's own plane", () => {
    useUiStore.setState({ workMode: "build", activeSpecial: null } as never);
    const { container } = render(<AgentSidebar project={mkProject([mkAgent()])} />);
    expect(sparkleRow(container).style.background).toBe("transparent");
  });

  // THE SELECTED STATE IS THE BUILD ROW'S GEOMETRY NOW, and these tests are the third version of
  // this contract. The history is worth keeping because the CONSTRAINT survived all three:
  //
  //   v1: a `3px solid C.goldFill` rail — cut, because the column is a quiet list and the rail was
  //       the last colored decoration in it.
  //   v2: a neutral `hairline` outline. It could not just be deleted: `forest` on the `deepForest`
  //       column measures 1.082 (dark) / 1.375 (light), so the active FILL is not visible, and
  //       fill-only would be a control with NO perceivable selected state — WCAG 1.4.11, not a
  //       taste question (roborev 53814). The outline was the cheapest thing that satisfied it.
  //   v3 (here): the row took the BUILD ROW's geometry instead — square right edge (`6px 0 0 6px`)
  //       plus the two concave fillets that flare it open into the terminal. That is what carries
  //       selection on every agent row, and it is exactly what v2's comment said this row lacked.
  //       With the geometry present the bespoke outline has nothing left to compensate for, so it
  //       went — one less piece of private vocabulary on the one row that had any.
  //
  // The constraint is unchanged: this row may never be fill-only. Do not restore the gold rail, do
  // not reinstate the hairline, and do NOT drop the fillets to "simplify" — that last one silently
  // reintroduces the 1.08:1 no-selected-state failure the whole history is about.
  it("marks the active row with the build rows' square edge, not a rail or an outline", () => {
    useUiStore.setState({ workMode: "build", activeSpecial: "sparkle" } as never);
    const { container } = render(<AgentSidebar project={mkProject([mkAgent()])} />);
    const row = sparkleRow(container);
    expect(row.style.borderRadius).toBe("6px 0 0 6px");
    expect(row.style.borderLeft).toBe(""); // no bespoke outline
    expect(row.style.borderLeft).not.toContain("gold");
  });

  it("rounds fully when inactive, like an unselected build row", () => {
    useUiStore.setState({ workMode: "build", activeSpecial: null } as never);
    const { container } = render(<AgentSidebar project={mkProject([mkAgent()])} />);
    expect(sparkleRow(container).style.borderRadius).toBe("6px");
  });

  // The half of the selected state that is actually VISIBLE, given the 1.08:1 fill step. Two
  // absolutely-positioned quarter-discs, one above the right edge and one below, painting the
  // terminal color everywhere except a concave cut — the same pair a selected agent row draws.
  it("draws the concave fillets that make the selection perceivable", () => {
    useUiStore.setState({ workMode: "build", activeSpecial: "sparkle" } as never);
    const { container } = render(<AgentSidebar project={mkProject([mkAgent()])} />);
    const fillets = sparkleRow(container).querySelectorAll<HTMLElement>('[aria-hidden][style*="radial-gradient"]');
    expect(fillets).toHaveLength(2);
    for (const f of fillets) expect(f.style.position).toBe("absolute");
  });

  it("draws no fillets when it is not the selected row", () => {
    useUiStore.setState({ workMode: "build", activeSpecial: null } as never);
    const { container } = render(<AgentSidebar project={mkProject([mkAgent()])} />);
    expect(
      sparkleRow(container).querySelectorAll('[aria-hidden][style*="radial-gradient"]'),
    ).toHaveLength(0);
  });

  // THE DIVIDER ABOVE THE ROW IS GONE, and unlike the outline it was not replaced by anything. It
  // was the only horizontal rule in the whole column, and what it said — "this row is separate" —
  // is already said by position: the row is pinned below the scroll container, outside every stage
  // group. Two renderings of one fact, the smaller one in a vocabulary nothing else uses.
  it("draws no divider rule above itself, active or not", () => {
    for (const activeSpecial of ["sparkle", null]) {
      useUiStore.setState({ workMode: "build", activeSpecial } as never);
      const { container, unmount } = render(<AgentSidebar project={mkProject([mkAgent()])} />);
      expect(sparkleRow(container).style.borderTop).toBe("");
      unmount();
    }
  });
});

// The epic pill is the THIRD chip in the card's top strip, and the one that could not follow the
// other two onto `pillFill`: its ink is `C.teal`, which measures 1.828/1.610 there — the fill that
// would make it a proper chip is the fill that destroys its ink. So it keeps the `deepForest` fill
// and takes its boundary from its BORDER instead, which is what `hairline` exists for. The border
// it had was `${C.teal}55`, measuring 1.376:1 against the dark `barSurface` card — under the chrome
// floor, leaving the chip with no boundary from any direction. Same remedy as ApprovalsMenu's
// notice well (roborev 53568/1). The numbers are floored in theme/chromeContrast.test.ts.
describe("AgentSidebar — the epic pill takes a hairline border, not a teal tint", () => {
  it("draws a border the card can actually show", () => {
    render(<AgentSidebar project={mkProject([mkAgent({ epicId: "e1" })])} />);
    fireEvent.contextMenu(screen.getByText(TITLE));
    // TWO instances, and both are meant to be there: the collapsed column row renders the same
    // strip the expanded hover card does. Assert on both rather than picking one — the card's is
    // the copy the `barSurface` measurement is about, and the row's still has to clear the column.
    const pills = screen.getAllByTitle(/^Epic e1 ·/);
    expect(pills.length).toBeGreaterThan(0);
    for (const pill of pills) {
      expect(pill.style.border).toContain("var(--c-hairline)");
      // The tint it replaced — named so a revert cannot pass quietly.
      expect(pill.style.border).not.toContain("55");
    }
  });
});
