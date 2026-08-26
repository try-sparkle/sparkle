// @vitest-environment jsdom
//
// `Column | Board` — THE DESTINATION LINKS, RIGHT OF THE YELLOW EPIC PILL (beads sparkle-42onk2,
// sparkle-huw924.14).
//
// The founder, 2026-08-24, with a screenshot of the epics column open in front of him: *"For epics
// on the epic column, I want a [link] to the right of the yellow epic pill that says 'board view'
// and opens the epic on the planning board"*. Asked where the concierge's existing pair should go
// and how far the hyperlink should extend, he settled both: *"for concierge card view do `[EPIC]
// Column | Board view` where 'Column' and 'Board' are hyperlinks. then in the epic column just have
// 'Board view' where 'Board' is hyperlink."*
//
// ══ AND THEN, 2026-08-26, HE DROPPED THE TRAILING WORD AND THE MISALIGNMENT WITH IT ════════════
// *"this 'Column | Board view' text isn't aligned the same; board is lower. fix that. also take out
// the word 'view' just have the column and board parts that link."* The two asks are ONE change:
// `view` was the only reason `Board` lived inside an extra `display: "inline"` wrapper (so the
// space in the phrase would survive into `textContent` rather than being a flex `gap`), and that
// wrapper was the misalignment. Blockified as a flex item it established its own inline formatting
// context whose strut takes the INHERITED type — the UA default 16px / `line-height: normal`, since
// nothing between `body` and this row sets one — so its box measured 19.8px against `Column`'s
// 16.8px and its baseline sat deeper inside it. `align-items: center` aligns BOXES, so `Board`
// landed 0.61px low. Measured in real Chrome on this exact markup; jsdom cannot see any of it,
// which is why the rows below pin the STRUCTURE and the STYLE EXPRESSION that produce the geometry.
//
// ══ WHAT THIS FILE HAS TO PIN, AND WHY EACH HALF IS NECESSARY ══════════════════════════════════
// The ask is a POSITION and a WORDING. Both are invisible to a test that only checks a callback
// fired — `onViewOnBoard` was wired up long before this change and firing it proves nothing about
// where the control sits or what it says. So every row here asserts DOCUMENT ORDER inside the
// chrome row, or the visible text, and never a prop.
//
// ══ AND IT IS A MOVE, SO THE ABSENCES MATTER AS MUCH AS THE PRESENCES ══════════════════════════
// Two board affordances were DELETED to make room: a bordered `View on board` button in the corner
// cluster, and an `Open · in column · on board` group above Build It. A card that grew the new link
// while keeping either of the old ones would offer one destination twice, inches apart — which is
// the exact duplication the retired group had itself been introduced to prevent. Absence rows here
// follow AGENTS.md's rule and assert the card's real content FIRST: `queryByTestId(x) === null`
// passes just as happily against a card that threw during render.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BeadCard, type BeadCardChrome } from "./BeadCard";
import { C } from "../../theme/colors";
import type { Bead } from "../../services/beads";

afterEach(() => cleanup());

const EPIC: Bead = {
  id: "sparkle-s3g2",
  title: "Token-maxer defaults epic: plugin foundation + Tier 1 tools",
  description: "The card in the founder's screenshot.",
  status: "open",
  type: "epic",
  priority: 2,
  labels: [],
  parent: null,
  commentCount: 0,
};

const ID = (chrome: BeadCardChrome) => (chrome === "epics" ? "epics-bead-card" : `${chrome}-bead-card`);

function mount(chrome: BeadCardChrome, over: Partial<Parameters<typeof BeadCard>[0]> = {}) {
  return render(<BeadCard bead={EPIC} chrome={chrome} stage="planned" workers={[]} {...over} />);
}

/** The card is REALLY on screen. Every absence claim below runs after this, because absence in a
 *  component that never rendered is the vacuous shape AGENTS.md names. */
function assertTheCardIsReallyThere(t: string) {
  expect(screen.getByTestId(`${t}-title`).textContent).toBe(EPIC.title);
  expect(screen.getByTestId(`${t}-id`).textContent).toBe(EPIC.id);
  expect(screen.getByTestId(`${t}-description`)).toBeTruthy();
}

/** Where a node sits along the chrome row, by DOM order — which IS the visual order along a row
 *  flex container. jsdom has no layout engine, so an x-coordinate assertion here would be theatre:
 *  every rect it reports is zeroes (docs/jsdom-test-caveats.md). */
function chromeOrder(t: string, el: HTMLElement): number {
  const kids = Array.from(screen.getByTestId(`${t}-chrome`).children);
  return kids.findIndex((k) => k === el || k.contains(el));
}

// ── THE PLACEMENT — THE WHOLE CONTENT OF THE ASK ────────────────────────────────────────────────

describe("the board link sits immediately right of the epic pill", () => {
  it("comes AFTER the pill and BEFORE the id and Chat, on the epics card", () => {
    const t = ID("epics");
    mount("epics", { onViewOnBoard: vi.fn(), onChat: vi.fn() });
    assertTheCardIsReallyThere(t);

    // THE YELLOW EPIC PILL — drawn by `TypePill`, which renders EPIC/BUG/TASK from `bead.type`
    // and owns the epic colour. It replaced the epic-only `EpicPill` on `main`, so the testid is
    // `type-pill`; the founder's *"yellow epic pill"* is this node when the bead is an epic.
    const pill = chromeOrder(t, screen.getByTestId(`${t}-type-pill`));
    const board = chromeOrder(t, screen.getByTestId(`${t}-open-on-board`));
    const corner = chromeOrder(t, screen.getByTestId(`${t}-corner`));

    // -1 means "not a child of the chrome row at all", and it would satisfy `pill < board` on its
    // own — so every index is proven real before the two comparisons that carry the founder's ask.
    for (const [name, i] of [["pill", pill], ["board", board], ["corner", corner]] as const) {
      expect(i, `${name} is not in the chrome row`).toBeGreaterThan(-1);
    }
    expect(board).toBeGreaterThan(pill);
    expect(board).toBeLessThan(corner);
    // IMMEDIATELY right of it — *"directly adjacent to the EPIC pill — not at the right-hand end
    // next to Chat"*. `board > pill` alone is satisfied by every position along the row, including
    // the one he rejected, so adjacency is the assertion that carries the ask.
    expect(board).toBe(pill + 1);
  });

  // ══ THE GAP IS THE POINT, AND ONLY THE SPACER CAN PROVE IT ═════════════════════════════════
  // "Right of the pill" and "at the right-hand end next to Chat" are BOTH after the pill in DOM
  // order, so the row above cannot tell them apart on its own. The chrome row's layout is one
  // `flex: 1` spacer that eats all the slack and pins everything after it to the right edge — so
  // the founder's placement is precisely "on the LEFT side of that spacer", and that is a
  // statement this test can make exactly. Put the link back in the corner cluster and this row
  // goes red while the one above stays green.
  it("sits on the LEFT of the flex spacer, which is what puts it in the gap", () => {
    const t = ID("epics");
    const { container } = mount("epics", { onViewOnBoard: vi.fn(), onChat: vi.fn() });
    // THE SPACER IS THE ONE CHILD THAT GROWS. Matched on its flex-grow rather than on a testid it
    // deliberately does not have (it is `aria-hidden` — it says nothing), and read off `style.flex`
    // as jsdom serializes it, which expands the shorthand to "1 1 0%".
    const kids = Array.from(screen.getByTestId(`${t}-chrome`).children);
    const spacer = kids.findIndex((k) => /^1[\s]/.test((k as HTMLElement).style.flex));

    expect(spacer, "the chrome row has no flex spacer").toBeGreaterThan(-1);
    expect(chromeOrder(t, screen.getByTestId(`${t}-open-on-board`))).toBeLessThan(spacer);
    // …and the things the founder wants on the far side of the gap really are on the far side.
    expect(chromeOrder(t, screen.getByTestId(`${t}-corner`))).toBeGreaterThan(spacer);
    expect(container.querySelectorAll("div")).toHaveLength(0);
  });
});

// ── THE WORDING — TWO LINKED NOUNS, AND NOT A WORD MORE ─────────────────────────────────────────

describe("the wording the founder chose", () => {
  it("says 'Board' and nothing else — no 'view' anywhere in the row", () => {
    const t = ID("epics");
    mount("epics", { onViewOnBoard: vi.fn() });

    const board = screen.getByTestId(`${t}-open-on-board`);
    const row = screen.getByTestId(`${t}-destinations`);
    expect(board.textContent).toBe("Board");
    // THE ASK, stated as the property rather than as one expected string: *"take out the word
    // 'view'"*. Asserting the row equals "Board" would go green again the day a third destination
    // is added; asserting the WORD is absent stays true whatever else the row grows.
    expect(row.textContent).toBe("Board");
    expect(row.textContent?.toLowerCase()).not.toContain("view");
    // The wrapper and the plain word are DELETED, not hidden — a hidden suffix would still put its
    // 16px strut in the row and the baseline would still be wrong.
    expect(screen.queryByTestId(`${t}-open-on-board-suffix`)).toBeNull();
    expect(screen.queryByTestId(`${t}-open-on-board-phrase`)).toBeNull();
  });

  // ══ THE ALIGNMENT FIX, PINNED ON ITS REAL CAUSE ══════════════════════════════════════════════
  // jsdom has no layout engine — every `getBoundingClientRect` is zeroes and a class-derived
  // `getComputedStyle` reads empty (docs/jsdom-test-caveats.md) — so a measured y-coordinate here
  // would be theatre. What jsdom CAN see is the two things that produced the 0.61px drop in real
  // Chrome: the extra wrapper around one of the two links, and the row's `align-items`. Both are
  // pinned as structure and as the inline-style expression, which is exactly what the browser reads.
  it("hangs both links off ONE baseline-aligned parent, as equal siblings", () => {
    const t = ID("concierge");
    mount("concierge", { onViewOnBoard: vi.fn(), onOpenInColumn: vi.fn(), onChat: vi.fn() });
    assertTheCardIsReallyThere(t);

    const row = screen.getByTestId(`${t}-destinations`);
    const column = screen.getByTestId(`${t}-open-in-column`);
    const board = screen.getByTestId(`${t}-open-on-board`);

    // 1. NO NESTING ASYMMETRY. `Column` was always a direct flex item; `Board` was one level down,
    //    inside a blockified wrapper with its own line box. Same parent is the whole repair.
    expect(board.parentElement).toBe(row);
    expect(column.parentElement).toBe(row);
    // 2. SAME ELEMENT TYPE, so neither can pick up a different UA box.
    expect(board.tagName).toBe(column.tagName);
    // 3. SAME TYPE METRICS — a flex item's box height IS its line-height here, and a difference in
    //    either of these is what put the two baselines at different depths.
    expect(board.style.fontSize).toBe(column.style.fontSize);
    expect(board.style.lineHeight).toBe(column.style.lineHeight);
    // 4. AND THE ROW SAYS SO OUT LOUD. `center` aligns boxes; only `baseline` aligns baselines, and
    //    it is the one of the two that survives a future item of a different size being added.
    expect(row.style.alignItems).toBe("baseline");
  });

  it("paints both links identically, so the pair reads as one choice", () => {
    const t = ID("concierge");
    mount("concierge", { onViewOnBoard: vi.fn(), onOpenInColumn: vi.fn() });
    const column = screen.getByTestId(`${t}-open-in-column`);
    const board = screen.getByTestId(`${t}-open-on-board`);

    expect(board.style.color).toBe(C.accentInk);
    expect(board.style.textDecoration).toBe("underline");
    expect(column.style.color).toBe(board.style.color);
    expect(column.style.textDecoration).toBe(board.style.textDecoration);
  });

  // The visible text is one word, so the accessible name has to carry the rest — and a `title`
  // cannot: `disableNativeTooltips()` strips every one app-wide and rescues it into `aria-label`
  // only for a control with no other accessible name.
  it("keeps the destination in the accessible name, minus the word that left the screen", () => {
    const t = ID("concierge");
    mount("concierge", { onViewOnBoard: vi.fn(), onOpenInColumn: vi.fn() });
    const board = screen.getByTestId(`${t}-open-on-board`);
    const label = board.getAttribute("aria-label") ?? "";

    // WCAG 2.5.3 Label in Name, exactly rather than merely satisfied: the name STARTS with the
    // visible word. It used to start "Board view", naming a word no sighted reader can now see.
    expect(label.startsWith(board.textContent ?? "")).toBe(true);
    expect(label.toLowerCase()).not.toContain("view");
    // …and the CONTEXT the label exists for survives the trim. A one-word link named `Board` says
    // neither which board nor what changes, so dropping the clause would be the real regression.
    expect(label).toContain("Plan board");
    // Its sibling is named the same way, which is the convention the trim was made to match.
    expect(screen.getByTestId(`${t}-open-in-column`).getAttribute("aria-label")).toContain("Column —");
  });
});

// ── THE PAIR, AND THE SINGLE — CALLBACK-IS-THE-SWITCH ───────────────────────────────────────────

describe("a surface gets exactly the destinations it supplies", () => {
  it("reads 'Column | Board' when both are real", () => {
    const t = ID("concierge");
    mount("concierge", { onViewOnBoard: vi.fn(), onOpenInColumn: vi.fn(), onChat: vi.fn() });
    assertTheCardIsReallyThere(t);

    const column = screen.getByTestId(`${t}-open-in-column`);
    const board = screen.getByTestId(`${t}-open-on-board`);
    expect(column.textContent).toBe("Column");
    expect(board.textContent).toBe("Board");
    // ORDER, not just presence: he wrote Column first.
    expect(column.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The separator is visible but is NOT a third control, and never reaches the AX tree.
    const group = screen.getByTestId(`${t}-destinations`);
    expect(group.textContent).toBe("Column|Board");
    expect(group.querySelectorAll("button")).toHaveLength(2);
    // Both halves are painted identically, so the pair reads as one choice rather than two ranks.
    expect(column.style.color).toBe(board.style.color);
    expect(column.style.textDecoration).toBe(board.style.textDecoration);
  });

  // THE EPICS COLUMN'S CASE, and the reason it is its own row: the founder asked for the board link
  // ALONE there. A `Column` link would be a second, quieter way to do what clicking the epic row
  // already did to open this card.
  it("reads 'Board' alone when the surface has no column to narrow", () => {
    const t = ID("epics");
    mount("epics", { onViewOnBoard: vi.fn(), onChat: vi.fn() });
    assertTheCardIsReallyThere(t);
    expect(screen.getByTestId(`${t}-destinations`).textContent).toBe("Board");
    expect(screen.queryByTestId(`${t}-open-in-column`)).toBeNull();
    expect(screen.getByTestId(`${t}-destinations`).querySelectorAll("button")).toHaveLength(1);
  });

  it("reads 'Column' alone when the surface has no board to open", () => {
    const t = ID("concierge");
    mount("concierge", { onOpenInColumn: vi.fn(), onChat: vi.fn() });
    assertTheCardIsReallyThere(t);
    expect(screen.getByTestId(`${t}-destinations`).textContent).toBe("Column");
    expect(screen.queryByTestId(`${t}-open-on-board`)).toBeNull();
    // …and no orphaned separator with nothing on its right. The bar is drawn only when BOTH
    // destinations are real, so a single-destination row is one word and no punctuation.
    expect(screen.getByTestId(`${t}-destinations`).textContent).not.toContain("|");
  });

  it("draws no destinations at all on a read-only card", () => {
    const t = ID("board");
    mount("board");
    assertTheCardIsReallyThere(t);
    expect(screen.queryByTestId(`${t}-destinations`)).toBeNull();
  });
});

// ── THE MOVE — THE OLD DRAWINGS ARE GONE, NOT HIDDEN ────────────────────────────────────────────

describe("the retired board affordances", () => {
  // Both used to render on exactly this mount: the standalone button when only the board was
  // supplied, the group when both were. If either came back, the concierge card would carry two
  // live board links at once.
  it("draws the board exactly ONCE, however many destinations the surface supplies", () => {
    for (const props of [
      { onViewOnBoard: vi.fn() },
      { onViewOnBoard: vi.fn(), onOpenInColumn: vi.fn() },
    ]) {
      const t = ID("concierge");
      mount("concierge", { ...props, onChat: vi.fn(), onClose: vi.fn() });
      assertTheCardIsReallyThere(t);
      expect(screen.getAllByTestId(`${t}-open-on-board`)).toHaveLength(1);
      // The two retired testids, by name — the group and the corner button.
      expect(screen.queryByTestId(`${t}-view-on-board`)).toBeNull();
      expect(screen.queryByTestId(`${t}-open-links`)).toBeNull();
      cleanup();
    }
  });
});

// ── AND IT STILL NAVIGATES ──────────────────────────────────────────────────────────────────────

describe("pressing a destination", () => {
  it("calls the surface's callback without collapsing the card", () => {
    const t = ID("epics");
    const onViewOnBoard = vi.fn();
    const onOpenInColumn = vi.fn();
    const onToggleCollapsed = vi.fn();
    mount("epics", { onViewOnBoard, onOpenInColumn, onToggleCollapsed, collapsed: false });

    fireEvent.click(screen.getByTestId(`${t}-open-on-board`));
    expect(onViewOnBoard).toHaveBeenCalledTimes(1);
    expect(onOpenInColumn).not.toHaveBeenCalled();
    // THE FOUNDER'S OTHER RULE, and half of this row: the card body is the expand target, so
    // without `stopPropagation` the press navigates AND folds the card in one gesture.
    expect(onToggleCollapsed).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId(`${t}-open-in-column`));
    expect(onOpenInColumn).toHaveBeenCalledTimes(1);
    expect(onViewOnBoard).toHaveBeenCalledTimes(1);
    expect(onToggleCollapsed).not.toHaveBeenCalled();
  });

  // THE SEPARATOR IS THE ONLY NON-LINK LEFT IN THE ROW, and it must stay that way. It replaces
  // the row that used to press the plain `view` — that word is gone, but the question it asked
  // ("is there anything in this row that LOOKS pressable and is not, or vice versa?") is still
  // live, and the bar is now the whole answer.
  it("leaves the separator inert and out of the accessibility tree", () => {
    const t = ID("concierge");
    const onViewOnBoard = vi.fn();
    const onOpenInColumn = vi.fn();
    mount("concierge", { onViewOnBoard, onOpenInColumn });

    const row = screen.getByTestId(`${t}-destinations`);
    const kids = Array.from(row.children) as HTMLElement[];
    // Three items and no more: link, bar, link. A fourth would mean something came back.
    expect(kids.map((k) => k.textContent)).toEqual(["Column", "|", "Board"]);
    const bar = kids[1]!;
    expect(bar.tagName).not.toBe("BUTTON");
    expect(bar.closest("button")).toBeNull();
    expect(bar.getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(bar);
    expect(onViewOnBoard).not.toHaveBeenCalled();
    expect(onOpenInColumn).not.toHaveBeenCalled();
  });
});
