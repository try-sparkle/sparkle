import { describe, it, expect } from "vitest";
import {
  COMPOSE_BORDER_H,
  COMPOSE_CAP_H,
  COMPOSE_CAP_LINES,
  COMPOSE_CHROME_H,
  COMPOSE_LINE_H,
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
    expect(COMPOSE_CAP_H).toBe(COMPOSE_LINE_H * COMPOSE_CAP_LINES + 22);
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

  it("a long TYPED draft never lifts a dragged box — only speech does", () => {
    // THE OSCILLATION roborev 57354 caught, and the reason this input is an increment. While the
    // measurement was the mirror's TOTAL it carried the whole draft, so a two-line box holding a
    // fifteen-line draft jumped to the cap on the first partial and snapped back on every settle —
    // several times an utterance, which is the "text jumps" class this branch exists to remove.
    const dragged = COMPOSE_MIN_H + 20;
    const fifteenLines = 300;
    expect(
      composeRenderH({ contentH: fifteenLines, userH: dragged, availableH: AVAILABLE, interimH: 0 }),
    ).toBe(dragged);
    // …and while speaking it grows by the spoken lines ALONE, not by the draft it sits on.
    expect(
      composeRenderH({
        contentH: fifteenLines,
        userH: dragged,
        availableH: AVAILABLE,
        interimH: 40,
      }),
    ).toBe(dragged + 40);
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
