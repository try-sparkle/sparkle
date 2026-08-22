// @vitest-environment jsdom
//
// THE COMMENT THREAD — the founder's items 23 and 24, plus the 2026-08-22 reorder.
//
// ══ THE REORDER: NEWEST FIRST, COMPOSE BOX ON TOP ══════════════════════════════════════════════
// Its own describe block at the foot of this file, with the ask quoted there. The one thing to
// carry up here: those assertions read the RENDERED DOM ORDER, never a sorted array or a helper
// call, because a component that sorts correctly and then renders the unsorted prop would pass the
// latter. Item 23's "bottom of the thread" row changed meaning as a result — see its comment.
//
// ══ 23: THE BUTTON MOVED, WHICH IS A CLAIM ABOUT THE ROW, NOT ABOUT THE BUTTON ═════════════════
// [11:06] *"Let's put the comments button bottom right instead of bottom left."* A control's
// position in a flex row is decided by the ROW, so the assertion has to read the row: both that
// the button is the last thing in it and that the row pushes its contents to the end. Asserting
// the button rendered would pass against the old bottom-left layout unchanged, which is the
// definition of a vacuous test here.
//
// ══ 24: THE TIME IS THE POINT, AND ITS TEST MUST NOT DEPEND ON THE MACHINE'S ZONE ═══════════════
// [11:28] *"We should have the time. So instead of the date being the way that it is, it should be,
// like, a u g space twenty space twenty twenty six at 10:14AM or whatever."*
//
// `when()` reads LOCAL time, so a fixture written as a UTC instant would assert a different clock
// on every machine — green in one CI zone and red in the founder's. Every fixture below is built
// with `new Date(y, m, d, h, min)`, the LOCAL-time constructor, so the wall clock it renders is the
// wall clock the test names no matter where it runs.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentThread, when } from "./CommentThread";
import type { BeadComment } from "../../services/beadsCommands";

afterEach(() => cleanup());

const T = "epics-bead-card-comments";

/** An ISO string for a LOCAL wall clock — see this file's header for why that matters. */
const localIso = (y: number, m: number, d: number, h: number, min: number) =>
  new Date(y, m - 1, d, h, min).toISOString();

function comment(over: Partial<BeadComment> = {}): BeadComment {
  return {
    id: "c1",
    author: "DROdio",
    text: "took about ten seconds to show up",
    createdAt: localIso(2026, 8, 20, 10, 14),
    ...over,
  };
}

function mount(over: Partial<Parameters<typeof CommentThread>[0]> = {}) {
  return render(
    <CommentThread testId={T} comments={[comment()]} onComment={async () => {}} {...over} />,
  );
}

// ── ITEM 24 — THE TIMESTAMP ─────────────────────────────────────────────────────────────────────

describe("item 24 — a comment says WHEN, to the minute", () => {
  // The founder's own example, verbatim. A row that only checked "contains 2026" would pass against
  // the date-only string this replaced.
  it("renders exactly `Aug 20, 2026 at 10:14 AM` on the rendered comment", () => {
    mount();
    const item = screen.getByTestId(`${T}-item`);
    expect(item.textContent).toContain("Aug 20, 2026 at 10:14 AM");
    // …and NOT the ISO date it used to print, which is the half that pins the change.
    expect(item.textContent).not.toContain("2026-08-20");
  });

  // The author and the text still travel with it — a timestamp change that ate the rest of the row
  // would otherwise pass the assertion above on a `textContent` that is only the date.
  it("keeps the author and the text beside it", () => {
    mount();
    const item = screen.getByTestId(`${T}-item`);
    expect(item.textContent).toContain("DROdio");
    expect(screen.getByTestId(`${T}-item-text`).textContent).toBe(
      "took about ten seconds to show up",
    );
  });

  // ══ THE CASES THAT ARE EASY TO GET WRONG WITH A HAND-ROLLED CLOCK ═══════════════════════════
  // Midnight and noon are where a `% 12` goes wrong in one direction or the other, and a
  // single-digit minute is where a missing pad shows up as `10:4 AM`. All three are silent.
  it.each([
    ["midnight is 12 AM, not 0 AM", localIso(2026, 8, 20, 0, 5), "Aug 20, 2026 at 12:05 AM"],
    ["noon is 12 PM, not 0 PM", localIso(2026, 8, 20, 12, 0), "Aug 20, 2026 at 12:00 PM"],
    ["one minute past is padded", localIso(2026, 1, 3, 13, 1), "Jan 3, 2026 at 1:01 PM"],
    ["the evening is PM", localIso(2026, 12, 31, 23, 59), "Dec 31, 2026 at 11:59 PM"],
  ])("%s", (_name, iso, expected) => {
    expect(when(iso)).toBe(expected);
  });

  // ══ NO SEPARATOR SURPRISES ════════════════════════════════════════════════════════════════════
  // `Intl` renders the day period after a NARROW NO-BREAK SPACE (U+202F) in current ICU, and a
  // string carrying one looks identical to this one in every log, diff and terminal. This row is
  // why `when()` is spelled out by hand rather than delegating to `toLocaleString`.
  //
  // ESCAPES, NOT THE CHARACTERS THEMSELVES. eslint's `no-irregular-whitespace` is an ERROR in this
  // tree, and it is right to be: a rule about invisible characters cannot be written with the
  // invisible characters in it, or the source is as unreadable as the bug. U+2009 (thin space) is
  // in the class too — it is what some locales use in the same slot.
  it("separates the time and the period with an ORDINARY space", () => {
    expect(when(localIso(2026, 8, 20, 10, 14))).not.toMatch(/[\u202f\u00a0\u2009]/);
  });

  // Degrade to nothing, never to "Invalid Date" — the behaviour this had before and must keep.
  it.each([
    ["a comment with no recorded time", null],
    ["an unparseable value", "not a date"],
  ])("shows nothing for %s, with the comment itself still on screen", (_name, iso) => {
    mount({ comments: [comment({ createdAt: iso })] });
    const item = screen.getByTestId(`${T}-item`);
    expect(item.textContent).toContain("DROdio");
    expect(item.textContent).not.toContain("Invalid");
    expect(item.textContent).not.toContain("NaN");
    expect(item.textContent).not.toContain(" at ");
  });
});

// ── ITEM 23 — THE BUTTON MOVES TO THE BOTTOM RIGHT ──────────────────────────────────────────────

describe("item 23 — the Comment button sits bottom RIGHT", () => {
  it("is the LAST thing in its row, and the row pushes to the end", () => {
    mount();
    const row = screen.getByTestId(`${T}-submit-row`);
    const button = screen.getByTestId(`${T}-submit`);

    expect(row.contains(button)).toBe(true);
    // BOTH halves are needed. Last-child alone is satisfied by a left-packed row with one control
    // in it — which is precisely the layout this replaced.
    expect(row.lastElementChild).toBe(button);
    expect(row.style.justifyContent).toBe("flex-end");
    // …and the button must not stretch across the row instead of sitting at its end.
    expect(button.style.flex).toBe("0 0 auto");
  });

  // "Bottom" means the bottom of the COMPOSE BLOCK. It used to also mean the bottom of the whole
  // thread, and that half is deliberately gone: the compose block now leads the section (see the
  // reorder describe below), so the button sits ABOVE the comments. What item 23 actually claimed —
  // the button is under the field it submits, at the right-hand end of its row — is unchanged.
  it("is the bottom of the COMPOSE BLOCK, under the input it submits", () => {
    mount();
    const row = screen.getByTestId(`${T}-submit-row`);
    const after = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING);

    expect(after(row, screen.getByTestId(`${T}-input`))).toBe(true);
    // …and it is still the LAST thing in the compose block, not floating loose in the thread.
    expect(screen.getByTestId(`${T}-compose`).lastElementChild).toBe(row);
  });

  // A relocated button wired to nothing passes every placement row above. This is the side effect.
  it("still POSTS the draft from its new corner", async () => {
    const onComment = vi.fn(async () => {});
    mount({ onComment });

    fireEvent.change(screen.getByTestId(`${T}-input`), {
      target: { value: "bottom right now" },
    });
    fireEvent.click(screen.getByTestId(`${T}-submit`));

    await waitFor(() => expect(onComment).toHaveBeenCalledWith("bottom right now"));
  });
});

// ── NEWEST FIRST, AND THE COMPOSE BOX LEADS ─────────────────────────────────────────────────────
//
// [2026-08-22] *"I want to reorder the comments to have the newest comments at the top and I want
// the comment box to be right below the comments section header. The comment section header should
// say 'Comments (newest first):' since the comments can be long, the comments would be ordered from
// newest to oldest, descending."*
//
// EVERY assertion below reads the RENDERED DOM — the node order, the document positions, the
// header's own text. None of them asks whether a helper was called or whether an array came back
// sorted: a component that sorts perfectly and then renders the prop would pass that, and it is
// exactly the bug worth catching here.

describe("the comments section reads newest → oldest", () => {
  const iso = (d: number, h: number, min: number) => localIso(2026, 8, d, h, min);

  /** The rendered comment bodies, top to bottom. `getAllByTestId` returns document order. */
  const renderedTexts = () =>
    screen.getAllByTestId(`${T}-item-text`).map((n) => n.textContent);

  it("renders the header the founder asked for, verbatim", () => {
    mount();
    // The literal, not a constant imported from the component — comparing the string to itself
    // would pass against any typo, including the one that drops the parenthetical entirely.
    expect(screen.getByTestId(`${T}-header`).textContent).toBe("Comments (newest first):");
  });

  it("puts the NEWEST comment at the top and the oldest at the bottom", () => {
    mount({
      comments: [
        // Handed over oldest-first, which is the order bd returns.
        comment({ id: "a", text: "oldest", createdAt: iso(18, 9, 0) }),
        comment({ id: "b", text: "middle", createdAt: iso(19, 9, 0) }),
        comment({ id: "c", text: "newest", createdAt: iso(20, 9, 0) }),
      ],
    });
    expect(renderedTexts()).toEqual(["newest", "middle", "oldest"]);
  });

  it("keeps comments that share a timestamp in the order they arrived", () => {
    // Agents write in bursts, so a shared second is the normal case, not a corner. Stability is the
    // only deterministic answer available, and an unstable comparator reshuffles them per render.
    const same = iso(20, 9, 0);
    mount({
      comments: [
        comment({ id: "t1", text: "burst one", createdAt: same }),
        comment({ id: "t2", text: "burst two", createdAt: same }),
        comment({ id: "t3", text: "burst three", createdAt: same }),
        comment({ id: "older", text: "yesterday", createdAt: iso(19, 9, 0) }),
      ],
    });
    expect(renderedTexts()).toEqual(["burst one", "burst two", "burst three", "yesterday"]);
  });

  it.each([
    ["no recorded time", null],
    ["an unparseable time", "not a date"],
  ])("sinks a comment with %s to the BOTTOM, never floats it to the top", (_name, bad) => {
    // An undated comment is not evidence of being the newest. It is also where a `NaN` comparator
    // result comes from, and a `NaN` return makes the whole sort's result unspecified — which
    // presents as "the list came back in input order" with nothing logged.
    //
    // FIVE ROWS, TWO UNDATED, INTERLEAVED — deliberately, and this is the fixture's whole point.
    // The rule is TWO lines in the comparator (`ta === null` and `tb === null`) and the realistic
    // typo flips only one of them, leaving a comparator that contradicts itself. Measured: a
    // three-row fixture with a single undated comment stayed GREEN against exactly that mutation —
    // V8's sort happened to reach the same answer — so it proved nothing about the rule. At this
    // width the one-sided flip is caught.
    mount({
      comments: [
        comment({ id: "u1", text: "undated one", createdAt: bad }),
        comment({ id: "o", text: "oldest", createdAt: iso(17, 9, 0) }),
        comment({ id: "m", text: "middle", createdAt: iso(18, 9, 0) }),
        comment({ id: "u2", text: "undated two", createdAt: bad }),
        comment({ id: "n", text: "newest", createdAt: iso(20, 9, 0) }),
      ],
    });
    // The dated ones descend; both undated ones sit under all of them, in the caller's order.
    expect(renderedTexts()).toEqual([
      "newest",
      "middle",
      "oldest",
      "undated one",
      "undated two",
    ]);
  });

  it("does NOT mutate the array it was handed", () => {
    // The prop is the caller's array, shared with whatever memo produced it. An in-place `.sort()`
    // here reorders a list elsewhere in the app at render time, with nothing to point at — and it
    // is invisible to every other assertion in this file, which all read the rendering.
    const input = [
      comment({ id: "a", text: "oldest", createdAt: iso(18, 9, 0) }),
      comment({ id: "b", text: "middle", createdAt: iso(19, 9, 0) }),
      comment({ id: "c", text: "newest", createdAt: iso(20, 9, 0) }),
    ];
    const identities = [...input];
    mount({ comments: input });

    expect(input.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(input).toEqual(identities); // same objects, same slots
    // …and the render really did reorder, so the row above is about the input rather than about a
    // component that never sorted anything.
    expect(renderedTexts()).toEqual(["newest", "middle", "oldest"]);
  });

  it("puts the compose box BEFORE the first comment, directly under the header", () => {
    mount({
      comments: [
        comment({ id: "a", text: "oldest", createdAt: iso(18, 9, 0) }),
        comment({ id: "c", text: "newest", createdAt: iso(20, 9, 0) }),
      ],
    });
    const before = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

    const header = screen.getByTestId(`${T}-header`);
    const compose = screen.getByTestId(`${T}-compose`);
    const firstItem = screen.getAllByTestId(`${T}-item`)[0]!;

    // Document position, not a class name or a style — the founder judges this by where the box IS.
    expect(before(header, compose)).toBe(true);
    expect(before(compose, firstItem)).toBe(true);
    // "Right below the header": nothing renders between them in the thread's own children.
    const kids = Array.from(screen.getByTestId(T).children);
    expect(kids.indexOf(compose)).toBe(kids.indexOf(header) + 1);
  });

  it("puts the compose box above the EMPTY state too", () => {
    mount({ comments: [] });
    const compose = screen.getByTestId(`${T}-compose`);
    const empty = screen.getByTestId(`${T}-empty`);
    expect(
      Boolean(compose.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });

  it("names the list with the header, so the order is announced and not just seen", () => {
    // A screen-reader user gets no visual cue that the order flipped. The list is a `<span>` (this
    // subtree must stay phrasing content), so the list semantics are carried by ARIA.
    mount();
    const list = screen.getByTestId(`${T}-list`);
    expect(list.getAttribute("role")).toBe("list");
    expect(list.getAttribute("aria-labelledby")).toBe(screen.getByTestId(`${T}-header`).id);
    expect(screen.getByTestId(`${T}-item`).getAttribute("role")).toBe("listitem");
  });

  it("keeps the error beside the control that produced it, above the thread", async () => {
    const onComment = vi.fn().mockRejectedValue(new Error("bd is busy"));
    mount({ comments: [comment({ id: "a", text: "history" })], onComment });
    fireEvent.change(screen.getByTestId(`${T}-input`), { target: { value: "try me" } });
    fireEvent.click(screen.getByTestId(`${T}-submit`));

    const error = await screen.findByTestId(`${T}-error`);
    expect(
      Boolean(
        error.compareDocumentPosition(screen.getByTestId(`${T}-item`)) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
  });
});
