import { describe, it, expect } from "vitest";
import {
  COMPOSE_CAP_H,
  COMPOSE_CAP_LINES,
  COMPOSE_LINE_H,
  COMPOSE_MIN_H,
  COMPOSE_MIN_THREAD_H,
  composeDragH,
  composeDragReleasesManual,
  composeMaxH,
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
