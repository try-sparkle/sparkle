import { describe, it, expect } from "vitest";
import {
  COMPOSE_BORDER_H,
  COMPOSE_CAP_H,
  COMPOSE_CAP_LINES,
  COMPOSE_CHROME_H,
  COMPOSE_LINE_H,
  COMPOSE_LINE_PX,
  COMPOSE_MIN_H,
  COMPOSE_MIN_THREAD_H,
  composeDragH,
  composeDragReleasesManual,
  composeInterimExtraH,
  composeMaxH,
  composePlaceholderFloorH,
  composeRenderH,
} from "./composeBoxHeight";

// The space the compose box and thread SHARE (not the window) — see composeMaxH.
const AVAILABLE = 800;

describe("composeRenderH — auto-grow", () => {
  it("rests at one line before anything is measured", () => {
    expect(composeRenderH({ contentH: null, userH: null, availableH: AVAILABLE })).toBe(COMPOSE_MIN_H);
  });

  it("grows with the content", () => {
    const one = composeRenderH({ contentH: COMPOSE_MIN_H, userH: null, availableH: AVAILABLE });
    const three = composeRenderH({
      contentH: COMPOSE_LINE_H * 3 + 22,
      userH: null,
      availableH: AVAILABLE,
    });
    expect(three).toBeGreaterThan(one);
  });

  it("stops growing at the ten-line cap, however much is typed", () => {
    // Past the cap the textarea scrolls its own overflow — the box must not eat the conversation.
    const huge = composeRenderH({ contentH: 5000, userH: null, availableH: AVAILABLE });
    expect(huge).toBe(COMPOSE_CAP_H);
    // TEN LINES EXACTLY — the cap's text area is `COMPOSE_CAP_LINES` RENDERED lines and no more.
    //
    // Asserted against `COMPOSE_LINE_PX` (18.2, the real 13 × 1.4) rather than `COMPOSE_LINE_H`
    // (19, that value rounded up for the one-line floor). Multiplying the ROUNDED line by the cap
    // multiplies the rounding error by ten, which is what made a cap named "ten lines" resolve to
    // 10.4 of them — the eleventh line half-showing under a rule that says it should not show.
    expect(COMPOSE_CAP_H - COMPOSE_CHROME_H).toBe(Math.ceil(COMPOSE_LINE_PX * COMPOSE_CAP_LINES));
    expect((COMPOSE_CAP_H - COMPOSE_CHROME_H) / COMPOSE_LINE_PX).toBeCloseTo(COMPOSE_CAP_LINES, 1);
  });

  it("the cap is TEN LINES AT ANY WIDTH, because a line's height does not depend on width", () => {
    // The founder's constraint: *"no matter what the width is … show the first 10 lines of text."*
    //
    // Wrapping changes how many LINES the content occupies; it does not change how TALL a line is.
    // So the same cap is ten rendered lines in a narrow column and in a wide one — what differs is
    // only how much text those ten lines hold. Modelled here by measuring the same paragraph at two
    // widths: narrow wraps it to 40 lines, wide to 12, and the box is the identical height for both
    // and shows ten lines of each.
    //
    // (`contentH` is a wrapped `scrollHeight`, so the WIDTH's effect lives entirely in that input —
    // which is why ComposeBox must re-measure on a column resize, and why `columnWidth` is a
    // dependency of its layout effect.)
    const lines = (n: number) => Math.ceil(COMPOSE_LINE_PX * n) + COMPOSE_CHROME_H - COMPOSE_BORDER_H;
    const narrow = composeRenderH({ contentH: lines(40), userH: null, availableH: AVAILABLE });
    const wide = composeRenderH({ contentH: lines(12), userH: null, availableH: AVAILABLE });
    expect(narrow).toBe(wide);
    expect((narrow - COMPOSE_CHROME_H) / COMPOSE_LINE_PX).toBeCloseTo(COMPOSE_CAP_LINES, 1);
  });

  it("shows a NINE-line draft whole — the cap only bites past ten", () => {
    // The other side of the boundary, and the one the founder actually lives in. Without it the
    // rows above would pass for a cap set anywhere at or below nine lines: "it stops at ten" says
    // nothing about whether nine are ever reached. His measured box was stuck at TWO.
    const nine = Math.ceil(COMPOSE_LINE_PX * 9) + COMPOSE_CHROME_H - COMPOSE_BORDER_H;
    const h = composeRenderH({ contentH: nine, userH: null, availableH: AVAILABLE });
    expect(h).toBeLessThan(COMPOSE_CAP_H);
    expect((h - COMPOSE_CHROME_H) / COMPOSE_LINE_PX).toBeCloseTo(9, 1);
  });

  it("never renders below the one-line floor, even on a bogus measurement", () => {
    expect(composeRenderH({ contentH: 0, userH: null, availableH: AVAILABLE })).toBe(COMPOSE_MIN_H);
    expect(composeRenderH({ contentH: -50, userH: null, availableH: AVAILABLE })).toBe(COMPOSE_MIN_H);
  });
});

// The live dictation preview is painted in a layer behind the textarea and is NOT in the textarea's
// value, so it is invisible to `contentH` — and it is not scrollable, not selectable, and has no
// caret. A box too short for it does not hide those words the way a short box hides typed text; it
// erases them from the screen. Hence a floor, in BOTH branches (roborev 57324 / 57333).
describe("composeRenderH — the words being spoken lift the box", () => {
  it("is an INCREMENT, not a floor — no borders of its own", () => {
    // The whole shape of this input, and the correction roborev 57354 forced. A placeholder stands
    // in for the box's entire content, so it returns a complete floor and adds the textarea's chrome
    // because bare copy carries none of it. The interim rides on top of a draft already accounted
    // for, so it adds nothing: both call sites count the borders exactly once already.
    const extra = 76;
    expect(composeInterimExtraH(extra)).toBe(extra);
    expect(composePlaceholderFloorH(extra)).toBe(extra + COMPOSE_CHROME_H);
    expect(COMPOSE_BORDER_H).toBeLessThan(COMPOSE_CHROME_H);
  });

  it("is nothing at all when no phrase is provisional", () => {
    expect(composeInterimExtraH(null)).toBe(0);
    expect(composeInterimExtraH(0)).toBe(0);
    const quiet = composeRenderH({ contentH: 60, userH: null, availableH: AVAILABLE });
    expect(composeRenderH({ contentH: 60, userH: null, availableH: AVAILABLE, interimH: 0 })).toBe(
      quiet,
    );
  });

  it("adds the spoken lines on top of the typed ones", () => {
    const extra = 76;
    expect(
      composeRenderH({ contentH: 20, userH: null, availableH: AVAILABLE, interimH: extra }),
    ).toBe(20 + COMPOSE_BORDER_H + extra);
  });

  it("LIFTS a dragged height — the one thing that does", () => {
    // `userH` otherwise returns outright, ignoring every measurement. A user who once dragged this
    // box short would keep a box that erases dictation, with nothing on screen to say so.
    //
    // To exactly what the draft plus the phrase NEEDS — not `dragged + extra`, which this asserted
    // while the lift was unconditional. The two differ whenever the box was not already full, and
    // the difference is overshoot: growth nobody can see, undone on the next settle.
    const dragged = COMPOSE_MIN_H + 20;
    const typed = 20;
    const extra = 76;
    expect(
      composeRenderH({ contentH: typed, userH: dragged, availableH: AVAILABLE, interimH: extra }),
    ).toBe(typed + COMPOSE_BORDER_H + extra);
  });

  it("a long TYPED draft raises a dragged box TO THE CAP — and does not oscillate there", () => {
    // THIS ROW REVERSES ITS OWN EARLIER ASSERTION, deliberately, and the reason it can is that the
    // defect it was written for is now unreachable rather than merely re-guarded.
    //
    // It used to assert `toBe(dragged)`: a fifteen-line draft in a two-line dragged box stayed two
    // lines. That was the rule the founder overruled — his own box sat at 59px (two lines) with the
    // ten-line cap unreachable, which is what "it doesn't change height at all" was. Content now
    // raises a dragged box to the cap, exactly as it would an undragged one.
    //
    // THE OSCILLATION roborev 57354 CAUGHT IS STILL GONE, and this row still proves it — by the two
    // assertions being EQUAL rather than by either one's value. That bug was the box jumping to the
    // cap on a partial and snapping back on the settle, several times an utterance. It needed the
    // draft's height to apply only WHILE speaking; here it applies either way, so there is no
    // settle to snap back to. Silence and speech agree, which is the property that matters.
    const dragged = COMPOSE_MIN_H + 20;
    const fifteenLines = 300;
    const silent = composeRenderH({
      contentH: fifteenLines,
      userH: dragged,
      availableH: AVAILABLE,
      interimH: 0,
    });
    const speaking = composeRenderH({
      contentH: fifteenLines,
      userH: dragged,
      availableH: AVAILABLE,
      interimH: 40,
    });
    expect(silent).toBe(COMPOSE_CAP_H);
    expect(speaking).toBe(silent);
  });

  it("THE FOUNDER'S STUCK BOX: a 59px drag no longer pins the cap out of reach", () => {
    // His measured `conciergeComposeH`, read off the app's persisted UI state: 59.13px — two lines,
    // and fractional because it came off a pointer drag. Above the ≤ MIN release threshold, so it
    // stuck; and persisted, so it survived every relaunch. He had never once reached a cap that has
    // said ten lines since the day it was written.
    //
    // NOT REDUNDANT with the row above, which uses a tidy `MIN + 20`. This is the actual number
    // from the actual bug report, and a fix that worked for round values and not for his would be
    // indistinguishable from no fix at all — to him.
    const HIS = 59.1328125;
    const longDraft = 5000;
    expect(composeRenderH({ contentH: longDraft, userH: HIS, availableH: AVAILABLE })).toBe(
      COMPOSE_CAP_H,
    );
    // …and the half of the old rule that was RIGHT still holds: it does not collapse back under him
    // when he deletes the draft. The drag is a floor, not a freeze — not a floor, not a nothing.
    expect(composeRenderH({ contentH: 20, userH: HIS, availableH: AVAILABLE })).toBe(HIS);
  });

  it("…and hands the height straight back when the phrase settles", () => {
    // The lift lasts exactly as long as the words are un-scrollable. It is not a new resting size.
    const dragged = COMPOSE_MIN_H + 20;
    expect(
      composeRenderH({ contentH: 20, userH: dragged, availableH: AVAILABLE, interimH: 0 }),
    ).toBe(dragged);
  });

  it("never lifts a dragged box ABOVE the auto cap, however long the phrase", () => {
    // A dragged box may exceed the cap because the user said so; a spoken sentence may not decide
    // that on their behalf.
    expect(
      composeRenderH({ contentH: 20, userH: COMPOSE_MIN_H, availableH: AVAILABLE, interimH: 5000 }),
    ).toBe(COMPOSE_CAP_H);
  });

  it("leaves a box the user dragged TALLER than the cap exactly where it is", () => {
    const tall = COMPOSE_CAP_H + 100;
    expect(
      composeRenderH({ contentH: 20, userH: tall, availableH: AVAILABLE, interimH: 96 }),
    ).toBe(tall);
  });

  it("does not move a dragged box that ALREADY has room for the phrase", () => {
    // THE OSCILLATION IN THE STABLE BRANCH. `userH + speaking` unconditionally grew every dragged
    // box on every partial and snapped it back on every settle — several times an utterance — even
    // though nothing was ever clipped in a roomy box: the mirror is `inset: 0`, so it already fills
    // the box and every line of it is on screen. Motion with no payoff is the exact defect class
    // this branch exists to remove.
    //
    // Deliberately BELOW the cap (150, not 300): above it the cap bound would pin this assertion on
    // its own and the test could not tell whether "grow only as far as needed" exists at all.
    const roomy = 150;
    const oneTypedLine = 20;
    expect(
      composeRenderH({ contentH: oneTypedLine, userH: roomy, availableH: AVAILABLE, interimH: 40 }),
    ).toBe(roomy);
  });

  it("still grows a box dragged ABOVE the cap when its draft fills it", () => {
    // The cap is a bound on the GROWTH, not on the absolute height, and the difference is only
    // visible here. Expressed as a `Math.max(userH, CAP)` CEILING it makes `userH` its own ceiling
    // for any box dragged past the cap — which does not bound dictation growth, it disables it, so
    // the phrase is erased in precisely the boxes the user made roomiest. The earlier test above
    // cannot catch that: with a one-line draft such a box needs no growth at all.
    const tall = 260; // dragged past COMPOSE_CAP_H (212)
    const nearlyFull = 250; // …and a draft that nearly fills it
    const spoken = 40;
    expect(
      composeRenderH({ contentH: nearlyFull, userH: tall, availableH: AVAILABLE, interimH: spoken }),
    ).toBe(nearlyFull + COMPOSE_BORDER_H + spoken);
  });
});

describe("composeRenderH — a dragged height wins", () => {
  it("EXCEEDS the auto cap when dragged past it — the point of the handle", () => {
    const dragged = composeRenderH({ contentH: 100, userH: COMPOSE_CAP_H + 200, availableH: AVAILABLE });
    expect(dragged).toBeGreaterThan(COMPOSE_CAP_H);
    expect(dragged).toBe(COMPOSE_CAP_H + 200);
  });

  it("does NOT shrink back as content is deleted", () => {
    // A box that collapsed under you while you deleted a line would fight the size you just chose.
    const tall = COMPOSE_CAP_H + 100;
    expect(composeRenderH({ contentH: 5000, userH: tall, availableH: AVAILABLE })).toBe(tall);
    expect(composeRenderH({ contentH: 20, userH: tall, availableH: AVAILABLE })).toBe(tall);
  });

  it("a SHORT drag can no longer clip the voice-error notice out of reach", () => {
    // A side effect of the drag becoming a floor, and the one worth a row of its own because it
    // reverses the old rule rather than extending it: an explicit drag used to outrank the
    // placeholder floor, so a box dragged short clipped the notice that carries Dismiss / Open
    // System Settings — stranding the user at a broken mic with the remedy just below the edge.
    //
    // The floor can only make the box TALLER, so the direction is the safe one.
    const tallNotice = 90; // the error overlay's natural height — three lines of copy plus controls
    const draggedShort = COMPOSE_MIN_H;
    const h = composeRenderH({
      contentH: null,
      userH: draggedShort,
      availableH: AVAILABLE,
      placeholderH: tallNotice,
    });
    expect(h).toBe(composePlaceholderFloorH(tallNotice));
    expect(h).toBeGreaterThan(draggedShort);
  });

  it("still leaves room for the thread", () => {
    // Without a ceiling the handle could swallow the whole column, leaving nothing to drag against.
    const greedy = composeRenderH({ contentH: null, userH: 10_000, availableH: AVAILABLE });
    expect(greedy).toBe(AVAILABLE - COMPOSE_MIN_THREAD_H);
    expect(AVAILABLE - greedy).toBeGreaterThanOrEqual(COMPOSE_MIN_THREAD_H);
  });

  it("keeps the cap reachable even in a very short column", () => {
    // A tiny column must not make the ordinary auto cap unreachable.
    expect(composeMaxH(150)).toBe(COMPOSE_CAP_H);
    expect(composeRenderH({ contentH: 5000, userH: null, availableH: 150 })).toBe(COMPOSE_CAP_H);
  });
});

describe("composeDragH", () => {
  it("dragging UP makes the box TALLER", () => {
    // The handle is on the box's TOP edge, so a negative (upward) dy must grow it. Getting this
    // sign backwards is the classic resize bug.
    expect(composeDragH(100, -40, AVAILABLE)).toBe(140);
  });

  it("dragging DOWN makes it shorter", () => {
    expect(composeDragH(200, 60, AVAILABLE)).toBe(140);
  });

  it("clamps to the floor and the ceiling", () => {
    expect(composeDragH(100, 9999, AVAILABLE)).toBe(COMPOSE_MIN_H);
    expect(composeDragH(100, -9999, AVAILABLE)).toBe(composeMaxH(AVAILABLE));
  });

  it("a zero-delta drag changes nothing", () => {
    expect(composeDragH(180, 0, AVAILABLE)).toBe(180);
  });
});

describe("composeDragReleasesManual", () => {
  it("releases back to auto-grow when dragged down to the resting height", () => {
    // The natural "put it back" gesture. Without it, one stray drag freezes the box for the session.
    expect(composeDragReleasesManual(COMPOSE_MIN_H)).toBe(true);
    expect(composeDragReleasesManual(COMPOSE_MIN_H - 10)).toBe(true);
  });

  it("keeps the manual height anywhere above resting", () => {
    expect(composeDragReleasesManual(COMPOSE_MIN_H + 1)).toBe(false);
    expect(composeDragReleasesManual(COMPOSE_CAP_H)).toBe(false);
  });
});

describe("composeMaxH — the ceiling is the SHARED pool, not the window", () => {
  it("does not over-allocate by the column's fixed chrome", () => {
    // The failure this replaced: sizing against window.innerHeight in an 800px window allowed a
    // 680px box, but the column also carries ~180px of incompressible header — so 180 + 680 > 800,
    // the thread collapsed to zero and the Send row was clipped off the bottom. Persisted, so it
    // survived a relaunch (roborev 53572).
    const WINDOW = 800;
    const CHROME = 180; // wordmark + spend pill + scope vitals + suggestions slot
    const pool = WINDOW - CHROME; // what the thread and the box actually divide

    const ceiling = composeMaxH(pool);
    expect(CHROME + ceiling).toBeLessThanOrEqual(WINDOW);
    // And the thread still gets its floor out of the pool.
    expect(pool - ceiling).toBeGreaterThanOrEqual(COMPOSE_MIN_THREAD_H);

    // The old window-based ceiling would have overflowed the window outright.
    expect(CHROME + composeMaxH(WINDOW)).toBeGreaterThan(WINDOW);
  });

  it("a greedy drag can never clip the box out of its own column", () => {
    for (const pool of [300, 500, 900, 1400]) {
      const h = composeRenderH({ contentH: null, userH: 99_999, availableH: pool });
      // Either the thread keeps its floor, or the pool was too small for even the auto cap — in
      // which case we render the cap and the column scrolls, rather than clipping the send row.
      expect(h).toBeLessThanOrEqual(Math.max(COMPOSE_CAP_H, pool - COMPOSE_MIN_THREAD_H));
    }
  });
});
