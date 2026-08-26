// SparkleOverlay particle engine — the pure math, no DOM. Ported 1:1 from the canonical
// prototype (PRD/sparkle/living-sparkle-overlay/prototype.html), Galaxy home only (the
// settled default; the five alternate homes were design comparisons and do not ship).
//
// Design grammar this encodes (PRD §2 — do not re-litigate):
//  • Still at rest: every target is a FROZEN position; motion happens only in transit
//    or while listening/speaking. Particles snap to a genuine full stop on arrival.
//  • Zippy, not slow: a stiff per-particle spring (k ∈ [62,132]) arrives in ~250-350ms;
//    the spread of k across particles is what produces the comet-tail look in flight.
//  • The home is an edge-on galaxy: center-dense bulge, thin arms tapering to nothing,
//    rippling like a waveform ONLY while listening (amplitude ∝ mic level × bulge).

import { modeMotion, type Anchor, type Mode, type ModeMotion } from "./state";
import { divesOnTransition } from "./state";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type SpriteKind = "gold" | "hot" | "cool";

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
  size: number;
  /** Twinkle phase + speed — the only motion allowed at rest is this subtle shimmer. */
  tw: number;
  twS: number;
  /** Fixed golden-angle position on the shell — the shell never rotates. */
  phi: number;
  /** Frozen jitter in [-1,1] — gives organic thickness without per-frame randomness. */
  jx: number;
  jy: number;
  /** Fixed depth in the shell, 0.82..1.18. */
  shellR: number;
  /** Per-particle spring stiffness — the comet spread while zipping. */
  k: number;
  /** Fixed 0..1 spot inside an infused card/row. */
  ix: number;
  iy: number;
  /** Fixed position along the edge-on galaxy: gu ∈ [-1,1] center-dense, gBoost its bulge weight. */
  gu: number;
  gBoost: number;
  fade: number;
  diving: boolean;
  absorbed: boolean;
  sprite: SpriteKind;
}

export const FULL_PARTICLE_COUNT = 240;
export const REDUCED_PARTICLE_COUNT = 100;

/** Reduced-motion honors the OS setting by thinning the swarm (prototype parity). */
export function particleCount(reducedMotion: boolean): number {
  return reducedMotion ? REDUCED_PARTICLE_COUNT : FULL_PARTICLE_COUNT;
}

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Half-width of the edge-on galaxy line in px (the home slot is ~264px wide). */
export const GALAXY_HALF_WIDTH = 130;

/**
 * Map a uniform jitter jx ∈ [-1,1] to a position along the galaxy line. Squaring while
 * keeping the sign (u·|u|) crowds uniform samples toward 0 — that crowding IS the
 * center-dense bulge; the arm tips (|gu| → 1) get only the sparse tail.
 */
export function galaxyU(jx: number): number {
  return jx * Math.abs(jx);
}

/**
 * Brightness/thickness weight along the galaxy: 1 at the bulge, falling off as a
 * gaussian to effectively 0 at the tapered arm tips (exp(-(1.8)²) ≈ 0.039 at |gu|=1).
 */
export function galaxyBoost(gu: number): number {
  return Math.exp(-Math.pow(gu * 1.8, 2));
}

/** Galaxy alpha shaping: bright bulge, faint arm tips. */
export function galaxyDim(gBoost: number): number {
  return 0.35 + 0.75 * gBoost;
}

/** Galaxy size shaping: bulge stars render larger than arm-tip stars. */
export function galaxySizeFactor(gBoost: number): number {
  return 0.5 * (0.6 + 0.8 * gBoost);
}

export function createParticles(
  n: number,
  rng: () => number = Math.random,
): Particle[] {
  const parts: Particle[] = [];
  for (let i = 0; i < n; i++) {
    const r1 = rng();
    const r2 = rng();
    const r3 = rng();
    const r4 = rng();
    const jx = (r1 - 0.5) * 2;
    const gu = galaxyU(jx);
    parts.push({
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      tx: 0,
      ty: 0,
      size: 3.5 + r1 * 8,
      tw: r2 * Math.PI * 2,
      twS: 0.4 + r3 * 1.6,
      phi: i * GOLDEN_ANGLE,
      jx,
      jy: (r2 - 0.5) * 2,
      shellR: 0.82 + r3 * 0.36,
      k: 62 + r4 * 70,
      ix: r3,
      iy: r4,
      gu,
      gBoost: galaxyBoost(gu),
      fade: 1,
      diving: false,
      absorbed: false,
      sprite: r4 < 0.1 ? "cool" : r1 < 0.3 ? "hot" : "gold",
    });
  }
  return parts;
}

/** Seed the swarm loosely gathered at the perch so first paint doesn't fly in from (0,0). */
export function seedAtPerch(parts: Particle[], perch: Point): void {
  for (const p of parts) {
    p.x = perch.x + p.jx * 30;
    p.y = perch.y + p.jy * 10;
  }
}

/**
 * Handle a state transition's particle bookkeeping: anything absorbed earlier
 * re-materializes at the new anchor (fade-in in place — no visible travel from inside
 * the old element), and the divers for the NEW anchor are marked.
 */
export function applyTransition(
  parts: Particle[],
  anchor: Anchor,
  spawn: Point,
): void {
  for (const p of parts) {
    if (p.absorbed) {
      p.absorbed = false;
      p.fade = 0;
      p.x = spawn.x + p.jx * 42;
      p.y = spawn.y + p.jy * 18;
      p.vx = 0;
      p.vy = 0;
    }
    p.diving = divesOnTransition(anchor, p.ix);
  }
}

export interface TargetInputs {
  anchor: Anchor;
  mode: Mode;
  /** Animation clock in seconds — drives the listening ripple only. */
  t: number;
  micLevel: number;
  voiceLevel: number;
  /** Center of the galaxy home slot in the top bar. */
  perch: Point;
  /** The orb-text bubble's current box — the shell hugs it. */
  orbBox: Rect;
  cardBox: Rect | null;
  rowBox: Rect | null;
}

function shellTarget(
  p: Particle,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  pulse: number,
): void {
  p.tx = cx + Math.cos(p.phi) * rx * p.shellR * pulse + p.jx * 7;
  p.ty = cy + Math.sin(p.phi) * ry * p.shellR * pulse + p.jy * 7;
}

/**
 * How fast a particle twinkles in a given motion. Broken out of the render loop so the mode union
 * is decoded in exactly one place: the chained ternary this replaces would have silently handed a
 * newly-added variant the RESTING rate, which is the bug that makes a new state look like no state
 * at all.
 */
export function twinkleRate(motion: ModeMotion): number {
  switch (motion) {
    case "ripple":
      return 2.2;
    case "pulse":
      return 1.6;
    case "swirl":
      return 2.8;
    case "rest":
      return 0.45;
    default: {
      const _exhaustive: never = motion;
      return _exhaustive;
    }
  }
}

/**
 * The shell's breathing scale for a motion. `swirl` (the genie thinking) breathes on the CLOCK
 * rather than on any input level — there is no mic signal during processing and no reply yet, so
 * a level-driven pulse would sit dead flat and read as a frozen overlay.
 */
export function shellPulse(
  motion: ModeMotion,
  micLevel: number,
  voiceLevel: number,
  t: number,
): number {
  switch (motion) {
    case "ripple":
      return 1 + micLevel * 0.22;
    case "pulse":
      return 1 + voiceLevel * 0.16;
    case "swirl":
      return 1 + 0.07 + 0.05 * Math.sin(t * 4.2);
    case "rest":
      return 1;
    default: {
      const _exhaustive: never = motion;
      return _exhaustive;
    }
  }
}

/**
 * The vertical displacement of a particle along the edge-on galaxy at the perch.
 *
 * `ripple` is the prototype's waveform — the line ripples like speech while you talk. `swirl` is
 * the processing beat: a slow travelling wave that runs along the galaxy independently of any
 * input level, so the swarm visibly CHURNS while the genie thinks instead of going motionless the
 * instant you stop speaking. `rest` and `pulse` hold the line flat, as they always did.
 */
export function perchWave(
  motion: ModeMotion,
  x: number,
  t: number,
  micLevel: number,
  gBoost: number,
): number {
  switch (motion) {
    case "ripple":
      return Math.sin(x * 0.085 + t * 9) * 11 * micLevel * (0.25 + gBoost);
    case "swirl":
      return Math.sin(x * 0.05 - t * 3.4) * 6 * (0.35 + gBoost);
    case "pulse":
    case "rest":
      return 0;
    default: {
      const _exhaustive: never = motion;
      return _exhaustive;
    }
  }
}

/**
 * Compute every particle's frozen target for the current state. All positions are
 * static unless listening/speaking pulses them — "motion only happens in transit".
 */
export function computeTargets(parts: Particle[], inp: TargetInputs): void {
  const { anchor, mode, t, micLevel, voiceLevel } = inp;
  const motion = modeMotion(mode);
  // Branch on the MOTION, not the mode literal: a chained ternary over the literals silently
  // stops covering the moment the union grows, and `processing` is exactly the variant that
  // would have fallen through to the `still` arm and shown a motionless swarm mid-thought.
  const pulse = shellPulse(motion, micLevel, voiceLevel, t);

  if (anchor === "perch") {
    // Edge-on galaxy: dense bright bulge, thin tapered arms. The line ripples like a
    // waveform ONLY while you talk — otherwise every target is motionless.
    for (const p of parts) {
      const x = p.gu * GALAXY_HALF_WIDTH;
      const thick = 2.5 + 9.5 * p.gBoost;
      const wave = perchWave(motion, x, t, micLevel, p.gBoost);
      p.tx = inp.perch.x + x * pulse;
      p.ty = inp.perch.y + p.jy * thick + wave;
    }
    return;
  }

  const box = inp.orbBox;
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const rx = Math.max(84, box.width / 2 + 42);
  const ry = Math.max(66, box.height / 2 + 38);

  if (anchor === "center") {
    for (const p of parts) shellTarget(p, cx, cy, rx, ry, pulse);
    return;
  }

  if (anchor === "row") {
    // The whole swarm dives into the freshly-born agent row and is absorbed there.
    const r = inp.rowBox;
    if (!r) {
      for (const p of parts) shellTarget(p, cx, cy, rx, ry, pulse);
      return;
    }
    for (const p of parts) {
      p.tx = r.left + 6 + p.ix * (r.width - 12);
      p.ty = r.top + 4 + p.iy * (r.height - 8);
    }
    return;
  }

  // card: divers pour INTO the card (then it just glows); the rest stay as Sparkle's
  // own slightly-tightened shell so the conversation can continue over the card.
  const c = inp.cardBox;
  for (const p of parts) {
    if (c && (p.diving || p.absorbed)) {
      p.tx = c.left + 10 + p.ix * (c.width - 20);
      p.ty = c.top + 10 + p.iy * (c.height - 20);
    } else {
      shellTarget(p, cx, cy, rx * 0.85, ry * 0.85, pulse);
    }
  }
}

/**
 * Advance one particle one frame: stiff spring toward the target, exponential damping,
 * hard snap to a TRUE full stop near arrival (the "still at rest" rule — no residual
 * micro-drift), plus the dive/absorb fade bookkeeping. Returns the squared speed so the
 * renderer can decide whether to draw a streak without recomputing it.
 */
export function stepParticle(p: Particle, dt: number): number {
  const dx = p.tx - p.x;
  const dy = p.ty - p.y;
  p.vx += dx * p.k * dt;
  p.vy += dy * p.k * dt;
  const damp = Math.exp(-9 * dt);
  p.vx *= damp;
  p.vy *= damp;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  const sp2 = p.vx * p.vx + p.vy * p.vy;
  if (sp2 < 4 && dx * dx + dy * dy < 1) {
    p.x = p.tx;
    p.y = p.ty;
    p.vx = 0;
    p.vy = 0;
  }

  // Absorption: divers fade out inside their target, then stay gone until the next
  // transition re-materializes them; everything else fades (back) in.
  if (p.diving) {
    if (dx * dx + dy * dy < 140) {
      p.fade -= dt * 5;
      if (p.fade <= 0) {
        p.fade = 0;
        p.diving = false;
        p.absorbed = true;
      }
    }
  } else if (!p.absorbed && p.fade < 1) {
    p.fade = Math.min(1, p.fade + dt * 2.2);
  }
  return sp2;
}

/**
 * The prototype's synthetic mic level — a lively multi-sine chatter pattern. Ships as
 * the DEFAULT source so the component is demoable standalone; Batch 2 injects the real
 * `dictation://level` signal in its place.
 */
export function syntheticMicLevel(t: number): number {
  return (
    Math.abs(Math.sin(t * 5.1) * Math.sin(t * 2.3)) +
    0.25 * Math.abs(Math.sin(t * 7.7))
  );
}

/** Synthetic level for the "speaking" mode, which now means SPARKLE IS TYPING A REPLY, not making
 *  a sound: text-to-speech was removed whole (PRD/feat/ui-refresh-2026-07-27 §5), so this sine IS
 *  the source — it is not a placeholder for a TTS analyser that arrives later. */
export function syntheticVoiceLevel(t: number): number {
  return 0.35 + 0.3 * Math.abs(Math.sin(t * 6.4) * Math.sin(t * 3.1));
}

/** A level source: called each frame with the animation clock, returns roughly 0..1. */
export type LevelSource = (tSeconds: number) => number;

// ---- color helpers (pure so the sprite palette is testable) ----

/** Parse #rrggbb → [r,g,b]. Returns null for anything else (var() etc. must not reach canvas). */
export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  const digits = m?.[1];
  if (!digits) return null;
  const v = parseInt(digits, 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** Mix a hex color toward white by t ∈ [0,1] — how the hot/gold sprite tints derive from brand amber. */
export function lightenHex(hex: string, t: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const c = rgb.map((v) => Math.round(v + (255 - v) * Math.max(0, Math.min(1, t))));
  return (
    "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("")
  );
}

export function hexToRgba(hex: string, alpha: number): string {
  const rgb = parseHex(hex) ?? [255, 255, 255];
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}
