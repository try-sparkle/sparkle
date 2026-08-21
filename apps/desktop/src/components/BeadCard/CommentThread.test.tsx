// @vitest-environment jsdom
//
// THE COMMENT THREAD — the founder's items 23 and 24.
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

  it("is the bottom of the thread, under the comment and the input", () => {
    mount();
    const row = screen.getByTestId(`${T}-submit-row`);
    const after = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING);

    expect(after(row, screen.getByTestId(`${T}-item`))).toBe(true);
    expect(after(row, screen.getByTestId(`${T}-input`))).toBe(true);
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
