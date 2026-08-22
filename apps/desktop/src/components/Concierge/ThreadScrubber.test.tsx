// @vitest-environment jsdom
//
// The rail as rendered. The numeric contract is proved in `railGeometry.test.ts` — jsdom lays
// nothing out, so nothing here measures a position (docs/jsdom-test-caveats.md). What IS decidable
// in a DOM, and what these rows assert:
//
//   • WHICH marks exist, and that a merged one is drawn DIFFERENTLY — the count is how "never drop a
//     prompt" shows up in a tree that has no geometry.
//   • THAT A DRAG SCRUBS CONTINUOUSLY — `onScrub`'s call count and its arguments across a sequence
//     of moves. This is the founder's headline defect (*"it's not scrolling in real time"*), and a
//     test asserting only "onScrub fired" would pass against a rail that emitted once at mouseup,
//     which is exactly the shipped bug.
//   • WHICH mark a click commits — `onPick`'s ARGUMENT, not merely that it fired. A test asserting
//     "onPick was called" would pass against a rail that always picks the first prompt.
//   • THAT the drag listeners are on `document` — by dispatching there and requiring the effect.
//     AGENTS.md records a shipped bug from a test firing at the wrong target while the listener sat
//     on another (`no-cross-target-event-dispatch`), so these rows fire where the USER's events go.
//
// The rail's height comes from the `railHeightPx` prop throughout: every `getBoundingClientRect` in
// jsdom reads 0, so without it a drag's fraction would be a division by zero and every assertion
// below would be about NaN.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MARK_WIDTH,
  scrubberHandleLabel,
  SCRUBBER_SCOPE_LABEL,
  THREAD_SCRUBBER_TESTID,
  ThreadScrubber,
  TRACK_WIDTH,
  type ThreadScrubberProps,
} from "./ThreadScrubber";
import { C } from "../../theme/colors";
import { SCRUBBER_SCOPES } from "./scrubberGeometry";
import type { RailMark } from "./railGeometry";

/** What the track paints when the query SUCCEEDED — read from the token, not restated. */
const SOLID_TRACK_BACKGROUND = C.hairline;

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const RAIL = 200;

afterEach(cleanup);

const mk = (index: number, fraction: number, textPrefix = `prompt number ${index}`): RailMark => ({
  id: `m${index}`,
  fraction,
  textPrefix,
  index,
  createdAt: NOW - index * DAY,
});

/** Four prompts spread far enough apart never to merge at RAIL=200 (6px gap = 0.03 of the axis). */
const SPREAD: RailMark[] = [
  mk(1, 0.05, "the oldest one"),
  mk(2, 0.35, "Search public data sources to find me 20 people that are most like Zoe"),
  mk(3, 0.65, "third"),
  mk(4, 0.95, "the newest one"),
];

function draw(over: Partial<ThreadScrubberProps> = {}) {
  const props: ThreadScrubberProps = {
    marks: SPREAD,
    scope: "1d",
    onScopeChange: vi.fn(),
    now: NOW,
    railHeightPx: RAIL,
    position: 1,
    onPick: vi.fn(),
    ...over,
  };
  return { ...render(<ThreadScrubber {...props} />), props };
}

const marksOf = () => screen.queryAllByTestId(`${THREAD_SCRUBBER_TESTID}-mark`);
const handle = () => screen.getByTestId(`${THREAD_SCRUBBER_TESTID}-handle`);
const track = (c: HTMLElement) =>
  c.querySelector('[data-scrubber-track="yes"] > div[aria-hidden]') as HTMLElement;

/**
 * Give the rail a real laid-out height and top, which jsdom otherwise reports as 0 for everything.
 * The drag maths divides by this, so without it every fraction below would be NaN.
 */
function measureRailAs(height: number, top = 0): void {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      const isRail = this.getAttribute("data-scrubber-track") === "yes";
      return {
        top: isRail ? top : 0,
        left: 0,
        right: 0,
        bottom: top + height,
        width: 26,
        height: isRail ? height : 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    },
  });
}
function unmeasure(): void {
  // @ts-expect-error restore jsdom's own zero-rect implementation
  delete HTMLElement.prototype.getBoundingClientRect;
}

// ── DEFECT 2 / 11: the thread must track the hand ───────────────────────────────────────────────
describe("a drag scrubs CONTINUOUSLY", () => {
  afterEach(unmeasure);

  // THE HEADLINE DEFECT. The shipped rail moved only the handle during the drag and scrolled the
  // thread once, at mouseup — which the founder read as "it doesn't really seem to be doing
  // anything". So the assertion is on the COUNT and the SEQUENCE, not on "it fired": a rail that
  // emits once at the end passes any weaker test.
  it("emits onScrub on EVERY move — not once at the end", () => {
    measureRailAs(1000);
    const onScrub = vi.fn();
    const onScrubEnd = vi.fn();
    const { container } = draw({ onScrub, onScrubEnd });
    const rail = container.querySelector('[data-scrubber-track="yes"]')!;

    fireEvent.mouseDown(rail, { button: 0, clientY: 100 });
    // The press itself is a scrub: a click on the track jumps there, the way a scrollbar track does.
    expect(onScrub).toHaveBeenCalledTimes(1);
    expect(onScrub).toHaveBeenLastCalledWith(0.1);

    for (const y of [200, 300, 400, 500, 600]) {
      fireEvent.mouseMove(document, { clientY: y });
    }
    // FIVE MOVES, FIVE EMISSIONS — plus the press. Anything debounced, throttled, or deferred to
    // mouseup reports fewer, and the thread stops tracking the hand.
    expect(onScrub).toHaveBeenCalledTimes(6);
    expect(onScrub.mock.calls.map((c) => c[0])).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    // …and nothing has ENDED yet. A rail that reported the gesture over on every move would let the
    // controller page history in mid-drag, which yanks the transcript out from under the hand.
    expect(onScrubEnd).not.toHaveBeenCalled();
  });

  it("lands exactly where the pointer was released, then says the gesture is over", () => {
    measureRailAs(1000);
    const onScrub = vi.fn();
    const onScrubEnd = vi.fn();
    const { container } = draw({ onScrub, onScrubEnd });
    const rail = container.querySelector('[data-scrubber-track="yes"]')!;

    fireEvent.mouseDown(rail, { button: 0, clientY: 100 });
    fireEvent.mouseMove(document, { clientY: 500 });
    fireEvent.mouseUp(document, { button: 0, clientY: 770 });

    // The release position is scrubbed to, so the thread cannot settle at the previous coalesced
    // move rather than where the hand actually let go.
    expect(onScrub).toHaveBeenLastCalledWith(0.77);
    expect(onScrubEnd).toHaveBeenCalledTimes(1);
  });

  it("stops scrubbing once the drag is over", () => {
    measureRailAs(1000);
    const onScrub = vi.fn();
    const { container } = draw({ onScrub });
    const rail = container.querySelector('[data-scrubber-track="yes"]')!;
    fireEvent.mouseDown(rail, { button: 0, clientY: 100 });
    fireEvent.mouseUp(document, { button: 0, clientY: 100 });
    const after = onScrub.mock.calls.length;
    fireEvent.mouseMove(document, { clientY: 900 });
    // A rail still listening after mouseup drags the thread on every mouse move anywhere in the app.
    expect(onScrub).toHaveBeenCalledTimes(after);
  });

  it("clamps a drag that ran off either end of the rail", () => {
    measureRailAs(1000);
    const onScrub = vi.fn();
    const { container } = draw({ onScrub });
    const rail = container.querySelector('[data-scrubber-track="yes"]')!;
    fireEvent.mouseDown(rail, { button: 0, clientY: 500 });
    fireEvent.mouseMove(document, { clientY: -400 });
    expect(onScrub).toHaveBeenLastCalledWith(0);
    fireEvent.mouseMove(document, { clientY: 9000 });
    expect(onScrub).toHaveBeenLastCalledWith(1);
  });

  // A right-click must not start a drag: without the guard, releasing the context menu committed a
  // scroll to somewhere the reader never asked for (roborev 66386).
  it("ignores a non-primary press", () => {
    measureRailAs(1000);
    const onScrub = vi.fn();
    const { container } = draw({ onScrub });
    fireEvent.mouseDown(container.querySelector('[data-scrubber-track="yes"]')!, {
      button: 2,
      clientY: 100,
    });
    expect(onScrub).not.toHaveBeenCalled();
    fireEvent.mouseMove(document, { clientY: 500 });
    expect(onScrub).not.toHaveBeenCalled();
  });

  // THE BACKSTOP for a release that never arrives. Without it the rail stays armed for the rest of
  // the session and every later mouse move drags the thread.
  it.each(["contextmenu", "blur"] as const)("disarms on %s", (kind) => {
    measureRailAs(1000);
    const onScrub = vi.fn();
    const onScrubEnd = vi.fn();
    const { container } = draw({ onScrub, onScrubEnd });
    fireEvent.mouseDown(container.querySelector('[data-scrubber-track="yes"]')!, {
      button: 0,
      clientY: 100,
    });
    if (kind === "contextmenu") fireEvent.contextMenu(document);
    else fireEvent.blur(window);
    expect(onScrubEnd).toHaveBeenCalledTimes(1);
    const after = onScrub.mock.calls.length;
    fireEvent.mouseMove(document, { clientY: 900 });
    expect(onScrub).toHaveBeenCalledTimes(after);
  });

  // A CANCELLED GESTURE DOES NOT REWIND THE THREAD, and that is a deliberate change from the time
  // rail. Every move has already scrolled — the reader is looking at where they dragged to — so
  // undoing it on a context menu would yank the transcript away from them.
  it("does not scrub BACK when a gesture is cancelled", () => {
    measureRailAs(1000);
    const onScrub = vi.fn();
    const { container } = draw({ onScrub, position: 1 });
    fireEvent.mouseDown(container.querySelector('[data-scrubber-track="yes"]')!, {
      button: 0,
      clientY: 100,
    });
    fireEvent.mouseMove(document, { clientY: 300 });
    onScrub.mockClear();
    fireEvent.contextMenu(document);
    expect(onScrub).not.toHaveBeenCalled();
  });
});

// ── DEFECT 8 / 9: the handle answers the grab ───────────────────────────────────────────────────
describe("the handle answers the grab", () => {
  afterEach(unmeasure);

  it("is a hairline at rest and shows no grip", () => {
    draw();
    expect(handle().getAttribute("data-grabbed")).toBe("no");
    expect(screen.queryByTestId(`${THREAD_SCRUBBER_TESTID}-grip`)).toBeNull();
  });

  // HIS WORDS: "when I click on the little white slider, it should become fatter. And it should
  // have rows". The assertion is on the RENDERED GRIP — six square dots in three columns — because
  // "the handle got a new attribute" would pass against a handle that looks identical.
  it("expands into a 3x2 square-dot grip on pointerdown, and puts it away on release", () => {
    measureRailAs(1000);
    const { container } = draw();
    const rail = container.querySelector('[data-scrubber-track="yes"]')!;

    fireEvent.mouseDown(rail, { button: 0, clientY: 100 });
    expect(handle().getAttribute("data-grabbed")).toBe("yes");
    const grip = screen.getByTestId(`${THREAD_SCRUBBER_TESTID}-grip`);
    expect(grip.children).toHaveLength(6);
    // THREE columns — the app's existing 2x3 pull-tab field turned 90 degrees, which is exactly
    // what he asked for ("three columns and two... flipped 90 degrees from the drag sliders").
    expect(grip.style.gridTemplateColumns).toBe("repeat(3, 3px)");
    // SQUARE, not round — the founder's own earlier call, and the reason ColumnPullTab's metrics
    // are imported rather than restated.
    expect((grip.children[0] as HTMLElement).style.borderRadius).toBe("0");

    fireEvent.mouseUp(document, { button: 0, clientY: 100 });
    expect(handle().getAttribute("data-grabbed")).toBe("no");
    expect(screen.queryByTestId(`${THREAD_SCRUBBER_TESTID}-grip`)).toBeNull();
  });

  it("gets FATTER while grabbed, not merely brighter", () => {
    measureRailAs(1000);
    const { container } = draw();
    const rest = handle().style.width;
    fireEvent.mouseDown(container.querySelector('[data-scrubber-track="yes"]')!, {
      button: 0,
      clientY: 100,
    });
    const grabbed = handle().style.width;
    // EXACT VALUES ON BOTH SIDES: a `not.toBe` would be satisfied by an absent declaration.
    // EXACT VALUES ON BOTH SIDES, and they must differ by enough to SEE: an earlier draft derived
    // the rest width from RAIL_WIDTH and landed on 18 vs 19, which satisfies "greater than" while
    // being invisible — the defect, not the fix.
    expect(rest).toBe("14px");
    expect(grabbed).toBe("21px");
    expect(parseFloat(grabbed)).toBeGreaterThan(parseFloat(rest));
    expect(parseFloat(handle().style.height)).toBeGreaterThan(3);
  });
});

// ── DEFECT 10: marks are lines, not dots ────────────────────────────────────────────────────────
describe("marks are LINES", () => {
  it("draws every mark square-ended and wider than it is tall", () => {
    draw();
    const first = marksOf()[0]!;
    // His correction: "those dots are gonna be way too thick. I think we need it to be little lines
    // instead of dots." A radius of anything is a dot at these sizes.
    expect(first.style.borderRadius).toBe("0");
    expect(first.style.width).toBe(`${MARK_WIDTH}px`);
    expect(parseFloat(first.style.width)).toBeGreaterThan(parseFloat(first.style.height));
  });

  it("draws a merged band TALLER and brighter than a single mark — never fatter and round", () => {
    // Three marks 0.005 apart on a 200px rail are 1px apart: under the 6px gap, so they merge.
    const { container } = draw({ marks: [mk(1, 0.5), mk(2, 0.505), mk(3, 0.51)] });
    const all = marksOf();
    expect(all).toHaveLength(1);
    const band = all[0]!;
    expect(band.getAttribute("data-band-size")).toBe("3");
    expect(band.style.borderRadius).toBe("0");
    expect(parseFloat(band.style.height)).toBeGreaterThan(1);
    expect(band.style.background).toBe(C.accentInk);
    expect(container).toBeTruthy();
  });

  it("draws one mark per prompt when they are far enough apart", () => {
    draw();
    expect(marksOf()).toHaveLength(4);
  });
});

// ── DEFECT 5 / 6: the scope menu is discoverable, and stops shouting after a pick ────────────────
describe("the scope menu", () => {
  it("offers every scope, ALL included", () => {
    draw();
    const select = screen.getByLabelText(SCRUBBER_SCOPE_LABEL) as HTMLSelectElement;
    expect(select.options).toHaveLength(SCRUBBER_SCOPES.length);
    expect(Array.from(select.options).map((o) => o.value)).toEqual([...SCRUBBER_SCOPES]);
    // The founder liked picking "1y" by name, and "all" is the answer to "how far back do you have".
    expect(Array.from(select.options).map((o) => o.value)).toContain("1y");
    expect(Array.from(select.options).map((o) => o.value)).toContain("all");
  });

  // HIS WORDS: "there should be, like, a little down arrow to the right of the 3d, to make it
  // obvious that I can change that time period." Asserted as a DRAWN chevron beside the token —
  // `appearance: none` on the old select removed the platform one and nothing replaced it.
  it("draws a chevron beside the token", () => {
    draw();
    const chip = screen.getByTestId(`${THREAD_SCRUBBER_TESTID}-scope`);
    expect(chip.textContent).toContain("1d");
    expect(chip.querySelector("svg")).not.toBeNull();
  });

  // THE RING'S FIX IS STRUCTURAL, so this is what a DOM test can honestly pin: the select is the
  // invisible layer (so the UA ring cannot show) and the chip is its NEXT SIBLING carrying the class
  // the `:focus-visible` rule in index.css targets. If either half moves, the ring comes back or the
  // keyboard ring never appears — and `index.css` cannot be asserted from jsdom.
  it("hides the UA ring by making the select invisible, and keeps the chip as its next sibling", () => {
    draw();
    const select = screen.getByLabelText(SCRUBBER_SCOPE_LABEL) as HTMLSelectElement;
    expect(select.className).toBe("scrubber-scope-select");
    expect(select.style.opacity).toBe("0");
    const chip = select.nextElementSibling as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.className).toBe("scrubber-scope-chip");
  });

  it("reports the TRUE extent behind All, so he never has to ask how far back history goes", () => {
    // 2026-08-12T07:21:39Z — the measured oldest row in his store.
    draw({ oldestMs: Date.UTC(2026, 7, 12, 14, 21, 39) });
    const select = screen.getByLabelText(SCRUBBER_SCOPE_LABEL) as HTMLSelectElement;
    const all = Array.from(select.options).find((o) => o.value === "all")!;
    expect(all.textContent).toMatch(/^All — since Aug 1[23]$/);
  });

  it("says plain All when the store has not answered yet — never a made-up date", () => {
    draw({ oldestMs: null });
    const select = screen.getByLabelText(SCRUBBER_SCOPE_LABEL) as HTMLSelectElement;
    expect(Array.from(select.options).find((o) => o.value === "all")!.textContent).toBe("All");
  });

  it("reports a pick to the caller", () => {
    const { props } = draw();
    fireEvent.change(screen.getByLabelText(SCRUBBER_SCOPE_LABEL), { target: { value: "1y" } });
    expect(props.onScopeChange).toHaveBeenCalledWith("1y");
  });
});

// ── DEFECT 4: a drag on this control is not a text selection ─────────────────────────────────────
describe("the rail declares itself a CONTROL", () => {
  // The opt-out attribute is the whole mechanism (see controlGesture.ts): the selection-driven
  // features walk up from the pressed node looking for it. Declared on the ROOT so every child —
  // handle, marks, scope menu — inherits it by `closest()`, which is what makes this an opt-out a
  // control sets on itself rather than a selector list the next control must remember to join.
  it("carries the opt-out attribute on its root, so every child is covered", () => {
    draw();
    const root = screen.getByTestId(THREAD_SCRUBBER_TESTID);
    expect(root.getAttribute("data-control-gesture")).toBe("yes");
    expect(handle().closest('[data-control-gesture="yes"]')).toBe(root);
    expect(marksOf()[0]!.closest('[data-control-gesture="yes"]')).toBe(root);
  });
});

// ── DEFECT 7: the rail must not lie about how much history there is ─────────────────────────────
describe("the rail never claims the loaded thread is all there is", () => {
  it("says how many prompts are still older than what is loaded", () => {
    draw({ moreAbove: 2_311 });
    expect(handle().getAttribute("aria-label")).toBe(
      "Thread scrubber — 4 prompts loaded, 2311 older still in history",
    );
  });

  it("says nothing extra when everything is loaded", () => {
    draw({ moreAbove: 0 });
    expect(handle().getAttribute("aria-label")).toBe("Thread scrubber — 4 prompts loaded");
  });

  // A REJECTED QUERY IS NOT AN EMPTY ONE. Both leave the rail quiet, and only the rail can tell the
  // reader which it is looking at (roborev 66429).
  it("distinguishes a failed history read from a quiet week", () => {
    expect(scrubberHandleLabel(0, "1d", true)).toBe(
      "Thread scrubber — could not read your history for 1 day",
    );
    expect(scrubberHandleLabel(0, "1d", false)).toBe("Thread scrubber — no prompts in 1 day");
    expect(scrubberHandleLabel(1, "all", false)).toBe("Thread scrubber — 1 prompt loaded");
  });
});

describe("the track says when the query failed", () => {
  // EXACT VALUES ON BOTH SIDES (roborev 66481). A `not.toBe(...)` is satisfied by an ABSENT
  // declaration, so the ordinary-empty row would pass against a track painting NOTHING AT ALL — a
  // worse version of the "an empty rail reads as broken" misreading this block exists to prevent.
  it("draws the track DASHED, so a sighted reader can tell too", () => {
    const { container } = draw({ marks: [], failed: true });
    const t = track(container);
    expect(t.style.borderLeftStyle).toBe("dashed");
    expect(t.style.borderLeftWidth).toBe(`${TRACK_WIDTH}px`);
    // The solid fill must GO, or a dashed border over it is invisible.
    expect(t.style.background).toBe("transparent");
    expect(t.style.opacity).toBe("0.7");
  });

  it("…and leaves the track SOLID and fully opaque on an ordinary empty week", () => {
    const { container } = draw({ marks: [], failed: false });
    const t = track(container);
    expect(container.querySelector('[data-scrubber-failed="yes"]')).toBeNull();
    expect(t.style.background).toBe(SOLID_TRACK_BACKGROUND);
    expect(t.style.borderLeftStyle).toBe("");
    expect(t.style.opacity).toBe("1");
  });
});

describe("clicking a mark", () => {
  it("commits THAT mark, not merely something", () => {
    const { props } = draw();
    fireEvent.click(marksOf()[2]!);
    expect(props.onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "m3", index: 3 }));
  });

  // A merged band's card prints the NEWEST member's text, so a click must land on that same prompt.
  // Landing anywhere else takes the reader somewhere other than the words they just read.
  it("commits the NEWEST member of a merged band — the one the card named", () => {
    const { props } = draw({ marks: [mk(1, 0.5), mk(2, 0.505), mk(3, 0.51)] });
    fireEvent.click(marksOf()[0]!);
    expect(props.onPick).toHaveBeenCalledWith(expect.objectContaining({ index: 3 }));
  });

  it("does not ALSO start a drag — a single click must not scrub to where it landed", () => {
    measureRailAs(1000);
    const onScrub = vi.fn();
    draw({ onScrub });
    fireEvent.mouseDown(marksOf()[0]!, { button: 0, clientY: 100 });
    expect(onScrub).not.toHaveBeenCalled();
    unmeasure();
  });
});

describe("the hover card", () => {
  it("names the prompt and its age", () => {
    draw();
    fireEvent.mouseEnter(marksOf()[1]!);
    const card = screen.getByTestId(`${THREAD_SCRUBBER_TESTID}-card`);
    expect(card.textContent).toContain("Prompt 2");
    expect(card.textContent).toContain("most like Zoe");
    expect(card.textContent).toContain("2 days ago");
    expect(card.textContent).toContain("DROdio");
  });

  // A live bubble has a rendered row before it has a history row, so its instant is genuinely
  // unknown. Omitting the age is the honest outcome; "just now" would be a claim the rail cannot
  // support, and it would be WRONG for a paged-in prompt whose write simply has not been read yet.
  it("omits the age rather than inventing one when the store has not answered", () => {
    draw({ marks: [{ id: "live", fraction: 0.5, textPrefix: "just typed", index: 1 }] });
    fireEvent.mouseEnter(marksOf()[0]!);
    const card = screen.getByTestId(`${THREAD_SCRUBBER_TESTID}-card`);
    expect(card.textContent).toContain("just typed");
    expect(card.textContent).not.toContain("ago");
    expect(card.textContent).not.toContain("DROdio");
  });

  it("goes away when the pointer leaves", () => {
    draw();
    fireEvent.mouseEnter(marksOf()[1]!);
    fireEvent.mouseLeave(marksOf()[1]!);
    expect(screen.queryByTestId(`${THREAD_SCRUBBER_TESTID}-card`)).toBeNull();
  });
});

describe("the keyboard", () => {
  // Stepping by MARK, not by a fixed fraction: the founder is looking for a prompt, and a percentage
  // step lands between prompts almost every time.
  it("steps to the previous and next prompt", () => {
    const { props } = draw({ position: 0.35 });
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(props.onPick).toHaveBeenLastCalledWith(expect.objectContaining({ index: 1 }));
    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    expect(props.onPick).toHaveBeenLastCalledWith(expect.objectContaining({ index: 3 }));
  });

  // HOME/END ARE PART OF THE ROLE `role="slider"` promises, and Left/Right are what a screen reader
  // announcing a slider invites — a key the announced role implies must not be dead.
  it("takes Home to the oldest and End to the newest, and accepts Left/Right", () => {
    const { props } = draw({ position: 0.5 });
    fireEvent.keyDown(handle(), { key: "Home" });
    expect(props.onPick).toHaveBeenLastCalledWith(expect.objectContaining({ index: 1 }));
    fireEvent.keyDown(handle(), { key: "End" });
    expect(props.onPick).toHaveBeenLastCalledWith(expect.objectContaining({ index: 4 }));
    // `position` is CONTROLLED and this render holds it at 0.5 throughout, so Left steps back from
    // 0.5 — to the mark at 0.35 — rather than from wherever End just went. That is the contract: the
    // rail steps from where the HANDLE is, never from its own memory of the last key.
    fireEvent.keyDown(handle(), { key: "ArrowLeft" });
    expect(props.onPick).toHaveBeenLastCalledWith(expect.objectContaining({ index: 2 }));
  });

  it("stays on the end mark rather than going dead at the ends", () => {
    const { props } = draw({ position: 0 });
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(props.onPick).toHaveBeenLastCalledWith(expect.objectContaining({ index: 1 }));
  });

  it("announces itself as a VERTICAL slider — the default is horizontal and would be a lie", () => {
    draw();
    expect(handle().getAttribute("aria-orientation")).toBe("vertical");
    expect(handle().getAttribute("role")).toBe("slider");
    expect(handle().getAttribute("aria-valuenow")).toBe("1");
  });

  it("does nothing when there is nothing to step to", () => {
    const { props } = draw({ marks: [] });
    fireEvent.keyDown(handle(), { key: "End" });
    expect(props.onPick).not.toHaveBeenCalled();
  });
});
