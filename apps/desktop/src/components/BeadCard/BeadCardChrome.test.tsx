// @vitest-environment jsdom
//
// THE CARD'S CHROME — the founder's items 15-22 from the 2026-08-20 self-interview.
//
// ══ WHY EVERY ROW HERE IS SHAPED THE WAY IT IS ═════════════════════════════════════════════════
// Four of these items are REMOVALS (the second border, the top edge, the rounded top, the blue
// bar), and a removal is the easiest thing in this repo to "prove" vacuously: `expect(queryByTestId
// (x)).toBeNull()` passes just as happily against a card that threw during render and put nothing
// on screen at all. AGENTS.md's fourth vacuous-test shape is exactly this. So:
//
//   * EVERY absence row first asserts the card's REAL CONTENT is on screen — its title, its meta
//     row, its description — and only then that the removed thing is gone. A card that failed to
//     render fails the first half.
//   * The border rows COUNT the edges that survive rather than asserting one element lacks one.
//     "No double border" is a statement about a CHAIN, and the chains themselves are pinned where
//     they actually exist: `EpicInlineCard.chrome.test.tsx` for the epics column's, and
//     `BoardView.test.tsx` ("the open card draws no second border inside the panel") for the
//     board's. This file pins the card's own half of each.
//   * The placement rows assert DOCUMENT ORDER, never a prop. "The card received `onChat`" says
//     nothing about where the button sits, which is the entire content of items 15 and 16.
//
// ══ READING BORDERS IN JSDOM ═══════════════════════════════════════════════════════════════════
// Off `style`, never `getComputedStyle` — these are inline styles, and jsdom never loads the
// stylesheet (docs/jsdom-test-caveats.md). One quirk shaped the CODE as well as this file: jsdom's
// cssstyle will not expand the `border` shorthand into longhands when the colour is a `var()`, and
// it DROPS a following `borderTop: "none"` override entirely. So a card written as `border` +
// `borderTop: "none"` serializes with all four sides intact and no test can tell the top edge went
// away. `ChromeSpec.edge` therefore names the three sides that survive; see the note on it.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BeadCard, type BeadCardChrome } from "./BeadCard";
import { C } from "../../theme/colors";
import { FONT_MONO, RADIUS, TYPE } from "../../theme/scale";
import { TAG } from "../labelTreatment";
import type { Bead } from "../../services/beads";

afterEach(() => cleanup());

function bead(over: Partial<Bead> & { id: string }): Bead {
  return {
    title: "Epics column and epic card redesign",
    description: "Items 15-24 of the founder's 2026-08-20 self-interview.",
    status: "open",
    type: "task",
    priority: 1,
    labels: ["agent-feedback"],
    parent: null,
    commentCount: 0,
    ...over,
  };
}

const EPIC = bead({ id: "sparkle-huw924", type: "epic" });
const TASK = bead({ id: "sparkle-huw924.5", title: "Epic card chrome", type: "task" });

const ID = (chrome: BeadCardChrome) =>
  chrome === "epics" ? "epics-bead-card" : `${chrome}-bead-card`;

function mount(
  chrome: BeadCardChrome,
  over: Partial<Parameters<typeof BeadCard>[0]> = {},
) {
  return render(
    <BeadCard bead={EPIC} chrome={chrome} stage="planned" workers={[]} {...over} />,
  );
}

/**
 * Which of the four edges the element actually paints.
 *
 * A SIDE LONGHAND FIRST, THE `border` SHORTHAND AS THE FALLBACK — which is exactly the cascade the
 * real thing has, and the only readable one here. jsdom's cssstyle refuses to expand `border` into
 * its longhands when the colour is a `var()` (every colour in this app is one), so
 * `border-bottom-style` reads empty on a card that plainly has a border. The serialized values it
 * DOES keep are the shorthand and any side longhand, so those are what this reads.
 */
function borderedSides(el: HTMLElement): string[] {
  const all = el.style.border;
  const sides = { top: el.style.borderTop, right: el.style.borderRight, bottom: el.style.borderBottom, left: el.style.borderLeft };
  return Object.entries(sides)
    .filter(([, own]) => {
      const v = own !== "" ? own : all;
      return v !== "" && v !== "none";
    })
    .map(([side]) => side);
}

/** True when `a` comes before `b` in document order. */
function precedes(a: Element, b: Element): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/** The card really rendered — asserted BEFORE any absence claim, so an absence can never be the
 *  absence of the whole card. */
function assertCardIsReallyThere(t: string, expected: Bead) {
  expect(screen.getByTestId(`${t}-title`).textContent).toBe(expected.title);
  expect(screen.getByTestId(`${t}-meta`)).toBeTruthy();
  expect(screen.getByTestId(`${t}-description`).textContent).toContain("Items 15-24");
  expect(screen.getByTestId(`${t}-id`).textContent).toBe(expected.id);
}

// ── ITEMS 15 + 16 — THE TOP-RIGHT CLUSTER ───────────────────────────────────────────────────────

describe("items 15+16 — the id and the Chat button, top right, id on the LEFT", () => {
  const t = ID("epics");

  // [09:52] "chat would go to the right. The SparkLE ID would go to the left of chat."
  it("renders BOTH inside one corner cluster, with the id first", () => {
    mount("epics", { onChat: () => {} });
    const corner = screen.getByTestId(`${t}-corner`);
    const id = screen.getByTestId(`${t}-id`);
    const chat = screen.getByTestId(`${t}-chat`);

    expect(corner.contains(id)).toBe(true);
    expect(corner.contains(chat)).toBe(true);
    // THE ORDER IS THE ITEM. Source order is render order inside a row flex container, so document
    // order IS left-to-right here — and swapping the two nodes reds this and nothing else.
    expect(precedes(id, chat)).toBe(true);
  });

  // The id used to sit on a line of ITS OWN, below the title. [05:02] "we take the sparkle ID and
  // we just move that to the top right." Asserting it is inside the corner is only half of that;
  // the other half is that it no longer trails the title.
  it("moves the id OUT of its old standalone line under the title", () => {
    mount("epics", { onChat: () => {} });
    const id = screen.getByTestId(`${t}-id`);
    const title = screen.getByTestId(`${t}-title`);

    expect(title.contains(id)).toBe(false);
    // It is now ABOVE the title, not below it — the reverse of where it was.
    expect(precedes(id, title)).toBe(true);
  });

  // ══ THE TITLE MUST STAY SELECTABLE, EVEN AS A BUTTON ══════════════════════════════════════
  // The disclosure control is a native `<button>` so it gets Enter, Space and a focus ring — but a
  // button's LABEL is not a selection target, so in the Tauri WKWebView the title could no longer
  // be swept at all. That silently removed the very capability the card's drag-selection guard
  // exists to protect ("select the title, copy it"), and left that guard protecting nothing.
  // jsdom applies no UA stylesheet for `user-select`, so no behavioural test can demonstrate it —
  // this pins the style value the way the card's other layout-invisible rules are pinned.
  it("keeps the title's text selectable, so the copy gesture the guard protects still exists", () => {
    mount("epics", { onToggleCollapsed: () => {} });
    const title = screen.getByTestId(`${t}-title`);

    expect(title.tagName).toBe("BUTTON");
    expect(title.style.userSelect).toBe("text");
    // THE WEBKIT PREFIX IS NOT ASSERTED, and that is a jsdom limit rather than an oversight worth
    // hiding: its cssstyle implementation drops `-webkit-user-select` from both the property list
    // and the serialized inline style, so there is nothing here to read. React still writes it to
    // the real node, which is where it matters — the Tauri WKWebView is the runtime this rule
    // exists for. The unprefixed value above is what jsdom CAN see, and it is what a refactor of
    // this reset would take out alongside it.
  });

  // [05:17] "make it smaller font size… It can be that career style font" — courier, i.e. keep mono.
  it("shrinks the id to the micro step and keeps it MONO", () => {
    mount("epics");
    const id = screen.getByTestId(`${t}-id`);

    expect(id.style.fontFamily).toBe(FONT_MONO);
    expect(id.style.fontSize).toBe(`${TYPE.micro}px`);
    // It was TYPE.small. Spelling that out is what makes this row about the CHANGE rather than
    // about whatever the current value happens to be.
    expect(id.style.fontSize).not.toBe(`${TYPE.small}px`);
  });

  // A button in the right corner that is wired to nothing is the failure this row exists to catch:
  // every placement assertion above passes against a dead control.
  it("still FIRES the callback after the move", () => {
    const onChat = vi.fn();
    mount("epics", { onChat });
    fireEvent.click(screen.getByTestId(`${t}-chat`));
    expect(onChat).toHaveBeenCalledTimes(1);
  });

  // ══ THE CLUSTER MUST BE ABLE TO SHRINK, AND ONLY THE ID MAY GIVE ═════════════════════════════
  // It carries the id plus up to three buttons — the concierge supplies all three at once — in a
  // column that is ~280px in the epics ladder and user-resizable smaller in the concierge. A
  // cluster pinned at `0 0 auto` pushes itself through the card's padding box and past its border,
  // because the row's only other flexible item is a zero-content spacer.
  //
  // ASSERTED AS STYLE VALUES, deliberately. jsdom has no layout engine (docs/jsdom-test-caveats.md)
  // — every box is 0×0 and nothing ever overflows — so a width assertion here would be theatre.
  // These are the four declarations that decide the behaviour, and they are inline.
  it("lets the cluster give ground, and makes the ID the thing that gives", () => {
    mount("concierge", { onChat: () => {}, onClose: () => {}, onViewOnBoard: () => {} });
    const ct = ID("concierge");
    const corner = screen.getByTestId(`${ct}-corner`);
    const id = screen.getByTestId(`${ct}-id`);

    // `0 1 auto`: shrinkable. `0 0 auto` is the bug this row exists to keep out.
    expect(corner.style.flex).toBe("0 1 auto");
    // "0", not "0px" — React writes a unitless zero through for `minWidth` and jsdom keeps it
    // verbatim. Both are the same length; asserting the string that is actually there is what
    // stops this row failing on a formatting detail rather than on the behaviour.
    expect(corner.style.minWidth).toBe("0");
    // The id truncates instead of shoving. Without `minWidth: 0` a nowrap span refuses to shrink
    // below its content, which is what makes the two above ineffective on their own.
    expect(id.style.minWidth).toBe("0");
    expect(id.style.overflow).toBe("hidden");
    expect(id.style.textOverflow).toBe("ellipsis");

    // …and every BUTTON holds its size, so the squeeze never costs the reader a control. The close
    // button is the way out of the card; losing it to an overflowing id is the worst outcome here.
    for (const control of ["chat", "view-on-board", "close"]) {
      expect(screen.getByTestId(`${ct}-${control}`).style.flex).toBe("0 0 auto");
    }
  });

  // Callback-is-the-switch, the convention every other control on this card follows. Mounted and
  // checked: the card IS on screen, so "no chat button" is about the button.
  it("draws no Chat button at all when the surface passes none", () => {
    mount("epics");
    assertCardIsReallyThere(t, EPIC);
    expect(screen.queryByTestId(`${t}-chat`)).toBeNull();
  });
});

// ── ITEMS 17 + 18 — THE TYPE PILL ───────────────────────────────────────────────────────────────

describe("items 17+18 — the TYPE pill, top LEFT, above the title", () => {
  const t = ID("epics");

  // [08:42] "We have it above the title. So that should be above the title… And then in the top
  // left, it'll say epic." [10:08] "it should look the same when it's open as it does when it's
  // closed."
  it("sits above the title and left of the corner cluster", () => {
    mount("epics", { onChat: () => {} });
    const pill = screen.getByTestId(`${t}-type-pill`);

    expect(pill.textContent).toBe("EPIC");
    expect(precedes(pill, screen.getByTestId(`${t}-title`))).toBe(true);
    expect(precedes(pill, screen.getByTestId(`${t}-corner`))).toBe(true);
  });

  // ══ THE POINT OF THE EXTRACTION ═══════════════════════════════════════════════════════════════
  // The founder asked for the pill the board ALREADY draws, not for a second gold pill. These are
  // the same four values `BoardView.test.tsx` pins on the collapsed card, so a divergence in either
  // direction reds one of the two suites — which is the only thing that makes "shared" mean
  // anything once two surfaces draw it.
  it("carries the board's own treatment, not a second one drawn by eye", () => {
    mount("epics");
    const pill = screen.getByTestId(`${t}-type-pill`);

    expect(pill.style.background).toBe(C.epicPillFill);
    expect(pill.style.color).toBe(C.onEpicPillFill);
    expect(pill.style.fontFamily).toBe(TAG.fontFamily);
    expect(pill.style.letterSpacing).toBe(TAG.letterSpacing);
  });

  // ══ NOT AN EPIC-ONLY BADGE — bead `sparkle-huw924.8` ══════════════════════════════════════════
  // This row used to assert the pill was ABSENT on a task card. The founder's next screenshot was an
  // OPEN card of type `bug` with that corner empty and the type printed as plain lowercase text in
  // the metadata row: *"an epic reads EPIC, a bug reads BUG, a task reads TASK. Do not special-case
  // epics."* So the assertion is inverted, and it is on the two things that actually distinguish a
  // TASK pill from the EPIC one — its LABEL and its FILL.
  it.each([
    ["task", "TASK"],
    ["bug", "BUG"],
    ["feature", "FEATURE"],
  ])("labels a %s card %s, in the non-epic fill", (type, label) => {
    render(
      <BeadCard bead={{ ...TASK, type }} chrome="epics" stage="planned" workers={[]} />,
    );
    expect(screen.getByTestId(`${t}-title`).textContent).toBe(TASK.title);
    const pill = screen.getByTestId(`${t}-type-pill`);
    expect(pill.textContent).toBe(label);
    expect(pill.style.background).toBe(C.typePillFill);
    expect(pill.style.color).toBe(C.onTypePillFill);
    // The gold is the EPIC's, and only the epic's — the whole point of the two-token split.
    expect(pill.style.background).not.toBe(C.epicPillFill);
  });

  // THE OTHER HALF: the type is shown ONCE. The metadata row printed `bead.type` as plain lowercase
  // prose, which is the duplicate the founder was looking at. Mounted and checked — the row IS on
  // screen with its other items, so this is a statement about the type item and not an empty tree.
  it("does NOT also print the type as plain text in the metadata row", () => {
    render(<BeadCard bead={{ ...TASK, type: "bug" }} chrome="epics" stage="planned" workers={[]} />);
    const meta = screen.getByTestId(`${t}-meta`);
    expect(meta.textContent).toContain("P1");
    expect(meta.textContent).not.toContain("bug");
    expect(screen.getByTestId(`${t}-type-pill`).textContent).toBe("BUG");
  });

  // Mounted and checked, per this file's header: the card is fully on screen, so the missing pill is
  // a statement about a bead bd gave no type at all — the one case that still renders no pill.
  it("is absent on a card with NO type, which is otherwise fully rendered", () => {
    render(
      <BeadCard bead={{ ...TASK, type: undefined }} chrome="epics" stage="planned" workers={[]} />,
    );
    expect(screen.getByTestId(`${t}-title`).textContent).toBe(TASK.title);
    expect(screen.getByTestId(`${t}-meta`)).toBeTruthy();
    expect(screen.queryByTestId(`${t}-type-pill`)).toBeNull();
  });

  // It is drawn from the BEAD, never from the surface — so the board's expanded card gets it too.
  it("appears in every chrome, because the switch is bead.type and not the chrome", () => {
    for (const chrome of ["board", "concierge", "epics"] as const) {
      cleanup();
      mount(chrome);
      expect(screen.getByTestId(`${ID(chrome)}-type-pill`).textContent).toBe("EPIC");
    }
  });
});

// ── ITEMS 19 + 20 + 21 — ONE BORDER, SQUARE TOP, NO DIVIDING LINE ───────────────────────────────

describe("items 19+20+21 — the card's own edge", () => {
  // [09:41] "So we can get rid of the double border. Just have one border." The board's detail
  // overlay is itself a bordered, rounded, shadowed panel and the card drew a second one 20px
  // inside it. THE PANEL KEEPS ITS EDGE; the card drops its own. The other half of this — that the
  // panel still has one, so the chain has exactly ONE rather than zero — is in BoardView.test.tsx,
  // where the real panel exists.
  it("board: the card paints NO edge of its own, inside a panel that has one", () => {
    const t = ID("board");
    mount("board");
    assertCardIsReallyThere(t, EPIC);
    expect(borderedSides(screen.getByTestId(t))).toEqual([]);
  });

  // The concierge card mounts inline in a sentence with nothing around it, so its own border is the
  // only thing making it a card. This row is what stops "remove the double border" being read as
  // "remove the border" everywhere.
  it("concierge: keeps all four sides, because nothing else draws them", () => {
    const t = ID("concierge");
    mount("concierge");
    expect(borderedSides(screen.getByTestId(t))).toEqual(["top", "right", "bottom", "left"]);
  });

  // [13:07] "there's a line in between the row and the card, it should just be solid." That line
  // WAS this card's border-top, sitting between two fills of the same colour.
  it("epics: three sides and NO top edge, so the row runs straight into the card", () => {
    const t = ID("epics");
    mount("epics");
    assertCardIsReallyThere(t, EPIC);
    expect(borderedSides(screen.getByTestId(t))).toEqual(["right", "bottom", "left"]);
  });

  // [12:55] "the top of the card is rounded. But it shouldn't be rounded."
  it("epics: squares the TOP corners and leaves the bottom pair rounded", () => {
    const t = ID("epics");
    mount("epics");
    expect(screen.getByTestId(t).style.borderRadius).toBe(
      `0 0 ${RADIUS.modal}px ${RADIUS.modal}px`,
    );
  });
});

// ── ITEM 22 — THE BLUE BAR ──────────────────────────────────────────────────────────────────────

describe("item 22 — the blue bar comes off the epic card and stays everywhere else", () => {
  // ══ THE PAIR IS THE EVIDENCE ══════════════════════════════════════════════════════════════════
  // One row proving absence is ambiguous — it passes for a card that renders nothing, and it passes
  // for a component that lost its stage line entirely. The row below it is what pins the CAUSE to
  // the switch: same component, same bead, same everything, and the bar is there.
  it("is GONE when the caller asks — with the card's real content still on screen", () => {
    const t = ID("epics");
    mount("epics", { showStageLine: false });
    assertCardIsReallyThere(t, EPIC);
    expect(screen.queryByTestId(`${t}-stage`)).toBeNull();
    expect(screen.queryByTestId(`${t}-stage-label`)).toBeNull();
  });

  it("is STILL THERE by default — the same card, one prop apart", () => {
    const t = ID("epics");
    mount("epics");
    assertCardIsReallyThere(t, EPIC);
    expect(screen.getByTestId(`${t}-stage`)).toBeTruthy();
    expect(screen.getByTestId(`${t}-stage-label`).textContent).toBe("Planned");
  });

  // The default is what every other surface relies on, and the founder asked for this line ON the
  // board and the concierge in the round before this one. A default flipped to `false` would take
  // it off all three at once and only the epics row above would notice.
  it("survives on the board and the concierge, which never pass the prop", () => {
    for (const chrome of ["board", "concierge"] as const) {
      cleanup();
      mount(chrome);
      expect(screen.getByTestId(`${ID(chrome)}-stage-label`).textContent).toBe("Planned");
    }
  });
});
