// The wordmark's motion model, pinned as pure math (the canvas painting isn't under test):
// still-but-drifting at rest, buzzy waveform only while listening/speaking.
import { describe, expect, it } from "vitest";
import {
  activeTarget,
  advanceTwinkle,
  buzzLevel,
  createStars,
  starFrame,
  stepActiveAmt,
  stepFlick,
  type Star,
} from "./starfieldMath";

/** Tiny deterministic LCG so field creation is reproducible in tests. */
function seededRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const star = (over: Partial<Star> = {}): Star => ({
  bx: 0.3,
  by: -0.2,
  sz: 1,
  tw: 0,
  tws: 1,
  dxp: 0.5,
  dyp: 1.5,
  ds: 0.3,
  jr: 20,
  jp: 1,
  ...over,
});

describe("buzzLevel — idle is exactly still, listening buzzes hardest", () => {
  it("idle is 0 no matter the flicker", () => {
    expect(buzzLevel("idle", 0)).toBe(0);
    expect(buzzLevel("idle", 1)).toBe(0);
  });

  it("listening outranks speaking at every flicker value", () => {
    for (const flick of [0, 0.25, 0.5, 1]) {
      expect(buzzLevel("listening", flick)).toBeGreaterThan(buzzLevel("speaking", flick));
    }
  });

  it("both active modes are non-zero even at flick 0 (the buzz never fully drops out)", () => {
    expect(buzzLevel("listening", 0)).toBeCloseTo(0.5);
    expect(buzzLevel("speaking", 0)).toBeCloseTo(0.3);
  });
});

describe("activity envelope", () => {
  it("targets 1 for active modes, 0 for idle", () => {
    expect(activeTarget("idle")).toBe(0);
    expect(activeTarget("listening")).toBe(1);
    expect(activeTarget("speaking")).toBe(1);
  });

  it("eases toward the target from either side and converges", () => {
    let up = 0;
    let down = 1;
    for (let i = 0; i < 100; i++) {
      up = stepActiveAmt(up, "listening");
      down = stepActiveAmt(down, "idle");
    }
    expect(up).toBeGreaterThan(0.99);
    expect(down).toBeLessThan(0.01);
  });

  it("flicker smoothing stays in [0,1) for rand in [0,1)", () => {
    const rand = seededRand(7);
    let flick = 0;
    for (let i = 0; i < 200; i++) {
      flick = stepFlick(flick, rand);
      expect(flick).toBeGreaterThanOrEqual(0);
      expect(flick).toBeLessThan(1);
    }
  });
});

describe("starFrame — idle vs active amplitude", () => {
  const geom = { cx: 100, cy: 25, rx: 90, ry: 20 } as const;

  it("with the envelope at 0 the buzz contributes NOTHING (level can't leak through)", () => {
    const s = star();
    const t = 1.234;
    const silent = starFrame(s, t, 0, 0, geom.cx, geom.cy, geom.rx, geom.ry);
    const leaky = starFrame(s, t, 0, 1, geom.cx, geom.cy, geom.rx, geom.ry);
    expect(leaky.y).toBe(silent.y);
    expect(leaky.x).toBe(silent.x);
  });

  it("fully active with a live level shifts y (the vertical waveform) but never x", () => {
    const s = star();
    const t = 1.234;
    const rest = starFrame(s, t, 0, 0, geom.cx, geom.cy, geom.rx, geom.ry);
    const buzz = starFrame(s, t, 1, 1, geom.cx, geom.cy, geom.rx, geom.ry);
    expect(buzz.y).not.toBe(rest.y);
    expect(buzz.x).toBe(rest.x);
  });

  it("idle drift is a small closed wander: position stays near the base point over time", () => {
    const s = star();
    for (const t of [0, 1, 2, 5, 10, 60]) {
      const f = starFrame(s, t, 0, 0, geom.cx, geom.cy, geom.rx, geom.ry);
      expect(Math.abs(f.x - (geom.cx + s.bx * geom.rx))).toBeLessThanOrEqual(0.03 * geom.rx);
      expect(Math.abs(f.y - (geom.cy + s.by * geom.ry))).toBeLessThanOrEqual(0.05 * geom.ry);
    }
  });

  it("active stars draw brighter and larger than idle ones", () => {
    const s = star();
    const idle = starFrame(s, 0, 0, 0, geom.cx, geom.cy, geom.rx, geom.ry);
    const active = starFrame(s, 0, 1, 1, geom.cx, geom.cy, geom.rx, geom.ry);
    expect(active.alpha).toBeGreaterThan(idle.alpha);
    expect(active.size).toBeGreaterThan(idle.size);
    expect(active.alpha).toBeLessThanOrEqual(1);
  });

  it("twinkle advances faster while active (the shimmer speeds up)", () => {
    const idleTw = advanceTwinkle(0, 1, 0.016, 0);
    const activeTw = advanceTwinkle(0, 1, 0.016, 1);
    expect(activeTw).toBeGreaterThan(idleTw);
    expect(activeTw).toBeCloseTo(idleTw * 3);
  });
});

describe("createStars", () => {
  it("is deterministic under an injected rand and lands every star on the unit disc", () => {
    const a = createStars(50, seededRand(42));
    const b = createStars(50, seededRand(42));
    expect(a).toEqual(b);
    expect(a).toHaveLength(50);
    for (const s of a) {
      expect(Math.hypot(s.bx, s.by)).toBeLessThanOrEqual(1.0001);
      expect(s.sz).toBeGreaterThanOrEqual(0.5);
      expect(s.sz).toBeLessThanOrEqual(2);
    }
  });
});
