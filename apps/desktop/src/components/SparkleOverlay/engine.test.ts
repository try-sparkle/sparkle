// Particle-engine math: the galaxy bulge distribution, frozen targets, the stiff-spring
// full-stop contract, absorption bookkeeping, reduced-motion count, and color helpers.
// All pure — no canvas pixels are inspected anywhere (per the unit's test contract).
import { describe, expect, it } from "vitest";
import {
  applyTransition,
  computeTargets,
  createParticles,
  FULL_PARTICLE_COUNT,
  GALAXY_HALF_WIDTH,
  galaxyBoost,
  galaxyDim,
  galaxySizeFactor,
  galaxyU,
  hexToRgba,
  lightenHex,
  parseHex,
  particleCount,
  REDUCED_PARTICLE_COUNT,
  seedAtPerch,
  stepParticle,
  syntheticMicLevel,
  syntheticVoiceLevel,
  type TargetInputs,
} from "./engine";

/** Deterministic rng so distribution assertions never flake. */
function makeRng(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function baseInputs(over: Partial<TargetInputs> = {}): TargetInputs {
  return {
    anchor: "perch",
    mode: "still",
    t: 0,
    micLevel: 0,
    voiceLevel: 0,
    perch: { x: 500, y: 20 },
    orbBox: { left: 400, top: 300, width: 200, height: 120 },
    cardBox: { left: 700, top: 400, width: 230, height: 90 },
    rowBox: { left: 10, top: 200, width: 200, height: 36 },
    ...over,
  };
}

describe("reduced-motion particle count", () => {
  it("thins the swarm when the OS asks for reduced motion", () => {
    expect(particleCount(false)).toBe(FULL_PARTICLE_COUNT);
    expect(particleCount(true)).toBe(REDUCED_PARTICLE_COUNT);
    expect(REDUCED_PARTICLE_COUNT).toBeLessThan(FULL_PARTICLE_COUNT);
  });
});

describe("galaxy bulge distribution", () => {
  it("gBoost peaks (=1) at the center and decays to ~0 at the arm tips", () => {
    expect(galaxyBoost(0)).toBe(1);
    // |gu|=1 is the extreme arm tip: exp(-(1.8)^2) ≈ 0.039 — visually "tapering to nothing".
    expect(galaxyBoost(1)).toBeLessThan(0.05);
    expect(galaxyBoost(-1)).toBeLessThan(0.05);
    // Strictly decreasing away from the bulge, symmetric in sign.
    expect(galaxyBoost(0.2)).toBeGreaterThan(galaxyBoost(0.5));
    expect(galaxyBoost(0.5)).toBeGreaterThan(galaxyBoost(0.9));
    expect(galaxyBoost(0.6)).toBeCloseTo(galaxyBoost(-0.6), 12);
  });

  it("galaxyU crowds uniform jitter toward the center (center-dense bulge)", () => {
    // The signed-square map sends |jx|=.5 to |gu|=.25 — points bunch near 0.
    expect(galaxyU(0.5)).toBeCloseTo(0.25, 12);
    expect(galaxyU(-0.5)).toBeCloseTo(-0.25, 12);
    expect(galaxyU(1)).toBe(1);
    // More than half of a uniform population lands in the inner half of the line.
    const rng = makeRng(7);
    let inner = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const jx = (rng() - 0.5) * 2;
      if (Math.abs(galaxyU(jx)) < 0.5) inner++;
    }
    expect(inner / n).toBeGreaterThan(0.65);
  });

  it("createParticles bakes gu/gBoost consistently and shapes brightness/size off them", () => {
    const parts = createParticles(50, makeRng(3));
    expect(parts).toHaveLength(50);
    for (const p of parts) {
      expect(p.gu).toBeCloseTo(galaxyU(p.jx), 12);
      expect(p.gBoost).toBeCloseTo(galaxyBoost(p.gu), 12);
      expect(p.k).toBeGreaterThanOrEqual(62);
      expect(p.k).toBeLessThanOrEqual(132);
    }
    // Bulge stars render brighter and larger than arm-tip stars.
    expect(galaxyDim(1)).toBeGreaterThan(galaxyDim(0.04));
    expect(galaxySizeFactor(1)).toBeGreaterThan(galaxySizeFactor(0.04));
  });
});

describe("computeTargets — perch (galaxy home)", () => {
  it("is motionless while still: targets are time-independent and un-rippled", () => {
    const parts = createParticles(40, makeRng(5));
    computeTargets(parts, baseInputs({ t: 0 }));
    const first = parts.map((p) => [p.tx, p.ty]);
    computeTargets(parts, baseInputs({ t: 123.456 }));
    parts.forEach((p, i) => {
      expect(p.tx).toBe(first[i]![0]);
      expect(p.ty).toBe(first[i]![1]);
    });
  });

  it("spans the galaxy line from the perch center, bulge-thick in the middle", () => {
    const parts = createParticles(60, makeRng(9));
    const inp = baseInputs();
    computeTargets(parts, inp);
    for (const p of parts) {
      expect(Math.abs(p.tx - inp.perch.x)).toBeLessThanOrEqual(GALAXY_HALF_WIDTH + 1e-9);
      // Vertical thickness is bounded by the bulge cap (2.5 + 9.5·gBoost ≤ 12).
      expect(Math.abs(p.ty - inp.perch.y)).toBeLessThanOrEqual(12);
    }
  });

  it("ripples ONLY while listening, with amplitude scaled by mic level and the bulge", () => {
    const mk = () => createParticles(30, makeRng(11));
    const still = mk();
    const listening = mk();
    computeTargets(still, baseInputs({ mode: "still", t: 1.3, micLevel: 1 }));
    computeTargets(listening, baseInputs({ mode: "listening", t: 1.3, micLevel: 1 }));
    // Same frozen particles, same clock — any ty difference is the waveform ripple.
    let moved = 0;
    listening.forEach((p, i) => {
      if (Math.abs(p.ty - still[i]!.ty) > 0.5) moved++;
    });
    expect(moved).toBeGreaterThan(10);

    // Silence kills the ripple even in listening mode (amplitude ∝ micLevel).
    const silent = mk();
    computeTargets(silent, baseInputs({ mode: "listening", t: 1.3, micLevel: 0 }));
    silent.forEach((p, i) => {
      expect(p.ty).toBeCloseTo(still[i]!.ty, 9);
    });
  });
});

describe("computeTargets — away anchors", () => {
  it("center: every particle targets the shell around the orb box", () => {
    const parts = createParticles(30, makeRng(13));
    const inp = baseInputs({ anchor: "center" });
    computeTargets(parts, inp);
    const cx = 500;
    const cy = 360;
    for (const p of parts) {
      // Shell radius rx≤(142)·1.18 + jitter — generous bound, but NOT the perch line.
      expect(Math.abs(p.tx - cx)).toBeLessThan(200);
      expect(Math.abs(p.ty - cy)).toBeLessThan(160);
    }
  });

  it("card: divers/absorbed target inside the card, the rest stay on the shell", () => {
    const parts = createParticles(40, makeRng(15));
    applyTransition(parts, "card", { x: 0, y: 0 });
    const inp = baseInputs({ anchor: "card" });
    computeTargets(parts, inp);
    const c = inp.cardBox!;
    for (const p of parts) {
      const inCard =
        p.tx >= c.left &&
        p.tx <= c.left + c.width &&
        p.ty >= c.top &&
        p.ty <= c.top + c.height;
      expect(inCard).toBe(p.diving);
    }
  });

  it("row: the whole swarm targets inside the row box", () => {
    const parts = createParticles(25, makeRng(17));
    applyTransition(parts, "row", { x: 0, y: 0 });
    const inp = baseInputs({ anchor: "row" });
    computeTargets(parts, inp);
    const r = inp.rowBox!;
    for (const p of parts) {
      expect(p.tx).toBeGreaterThanOrEqual(r.left);
      expect(p.tx).toBeLessThanOrEqual(r.left + r.width);
      expect(p.ty).toBeGreaterThanOrEqual(r.top);
      expect(p.ty).toBeLessThanOrEqual(r.top + r.height);
    }
  });
});

describe("spring physics", () => {
  it("zips to the target and comes to a TRUE full stop (still-at-rest rule)", () => {
    const parts = createParticles(1, makeRng(19));
    const p = parts[0]!;
    p.x = 0;
    p.y = 0;
    p.tx = 300;
    p.ty = 150;
    // Simulate ~2s at 60fps — far past the ~250-350ms design arrival window.
    for (let i = 0; i < 120; i++) stepParticle(p, 1 / 60);
    expect(p.x).toBe(p.tx);
    expect(p.y).toBe(p.ty);
    expect(p.vx).toBe(0);
    expect(p.vy).toBe(0);
  });

  it("absorbs a diving particle once it reaches its target, until re-materialized", () => {
    const parts = createParticles(1, makeRng(21));
    const p = parts[0]!;
    p.diving = true;
    p.x = p.tx = 100;
    p.y = p.ty = 100;
    for (let i = 0; i < 30 && !p.absorbed; i++) stepParticle(p, 1 / 60);
    expect(p.absorbed).toBe(true);
    expect(p.fade).toBe(0);
    expect(p.diving).toBe(false);

    // The next transition re-materializes it at the spawn point, faded out, to fade in.
    applyTransition(parts, "perch", { x: 50, y: 60 });
    expect(p.absorbed).toBe(false);
    expect(p.fade).toBe(0);
    expect(Math.abs(p.x - 50)).toBeLessThanOrEqual(42);
    expect(Math.abs(p.y - 60)).toBeLessThanOrEqual(18);
    stepParticle(p, 1 / 60);
    expect(p.fade).toBeGreaterThan(0);
  });

  it("seedAtPerch gathers the swarm loosely around the perch", () => {
    const parts = createParticles(20, makeRng(23));
    seedAtPerch(parts, { x: 400, y: 19 });
    for (const p of parts) {
      expect(Math.abs(p.x - 400)).toBeLessThanOrEqual(30);
      expect(Math.abs(p.y - 19)).toBeLessThanOrEqual(10);
    }
  });
});

describe("synthetic level sources (standalone-demo defaults)", () => {
  it("mic chatter stays in a lively 0..1.25 band", () => {
    for (let t = 0; t < 10; t += 0.03) {
      const v = syntheticMicLevel(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1.25);
    }
  });

  it("voice level hums in the .35...65 band", () => {
    for (let t = 0; t < 10; t += 0.03) {
      const v = syntheticVoiceLevel(t);
      expect(v).toBeGreaterThanOrEqual(0.35);
      expect(v).toBeLessThanOrEqual(0.65);
    }
  });
});

describe("color helpers", () => {
  it("parses 6-digit hex and rejects anything canvas can't take", () => {
    expect(parseHex("#e0982f")).toEqual([0xe0, 0x98, 0x2f]);
    expect(parseHex("var(--c-amber)")).toBeNull();
    expect(parseHex("#fff")).toBeNull();
  });

  it("lightens toward white and converts to rgba", () => {
    expect(lightenHex("#000000", 1)).toBe("#ffffff");
    expect(lightenHex("#e0982f", 0)).toBe("#e0982f");
    expect(hexToRgba("#ff0000", 0.5)).toBe("rgba(255,0,0,0.5)");
  });
});
