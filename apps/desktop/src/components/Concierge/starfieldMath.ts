// Pure math for the star-field wordmark, ported from the canonical prototype
// (PRD/sparkle/concierge-mode/prototype.html). Kept free of canvas/DOM so the motion model —
// still firefly drift + twinkle at rest, buzzy waveform while listening/speaking — is
// unit-testable; StarfieldWordmark.tsx owns only the painting.

import type { WordmarkMode } from "./types";

export const STAR_COUNT = 260;
/** Honor prefers-reduced-motion with a static (single-frame) field; fewer stars keeps it airy. */
export const REDUCED_STAR_COUNT = 120;

export interface Star {
  /** Base position on the unit disc (density-biased toward the center, like the prototype). */
  bx: number;
  by: number;
  /** Sprite half-size in px. */
  sz: number;
  /** Twinkle phase + speed (phase advances per frame via advanceTwinkle). */
  tw: number;
  tws: number;
  /** Firefly drift phases + speed — the slow idle wander. */
  dxp: number;
  dyp: number;
  ds: number;
  /** Buzz rate + phase — the vertical waveform jitter while active. */
  jr: number;
  jp: number;
}

/** `rand` is injectable so tests get a deterministic field. */
export function createStars(
  count: number = STAR_COUNT,
  rand: () => number = Math.random,
): Star[] {
  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    const ang = rand() * Math.PI * 2;
    const rad = Math.pow(rand(), 0.7);
    stars.push({
      bx: Math.cos(ang) * rad,
      by: Math.sin(ang) * rad,
      sz: 0.5 + rand() * 1.5,
      tw: rand() * 6.28,
      tws: 0.5 + rand() * 1.3,
      dxp: rand() * 6.28,
      dyp: rand() * 6.28,
      ds: 0.25 + rand() * 0.4,
      jr: 12 + rand() * 22,
      jp: rand() * 6.28,
    });
  }
  return stars;
}

/** Where the eased activity envelope is headed: 0 at rest, 1 in either active mode. */
export function activeTarget(mode: WordmarkMode): number {
  return mode === "idle" ? 0 : 1;
}

/** One easing step of the activity envelope toward its target (the prototype's 0.12 lerp). */
export function stepActiveAmt(prev: number, mode: WordmarkMode): number {
  return prev + (activeTarget(mode) - prev) * 0.12;
}

/** One smoothing step of the flicker noise (rand in [0,1) keeps flick in [0,1)). */
export function stepFlick(prev: number, rand: () => number = Math.random): number {
  return prev + (rand() - prev) * 0.4;
}

/**
 * The buzz drive level for a frame. Idle is EXACTLY 0 — the resting field owes all its motion
 * to the firefly drift, never the waveform. Listening (user talking) buzzes harder than
 * speaking (Sparkle typing a reply), matching the prototype's listening/typing split.
 */
export function buzzLevel(mode: WordmarkMode, flick: number): number {
  if (mode === "listening") return 0.5 + 0.5 * flick;
  if (mode === "speaking") return 0.3 + 0.12 * flick;
  return 0;
}

/** Per-frame twinkle-phase advance; activity doubles the shimmer rate on top of base speed. */
export function advanceTwinkle(
  tw: number,
  tws: number,
  dt: number,
  activeAmt: number,
): number {
  return tw + tws * dt * (1 + activeAmt * 2);
}

export interface StarFrame {
  x: number;
  y: number;
  /** Composite alpha in [0,1]. */
  alpha: number;
  /** Half-size in px to draw the sprite at. */
  size: number;
}

/**
 * One star's position/appearance for a frame. The idle drift is a small closed wander around
 * the base point; the buzz is a vertical sine gated by BOTH the eased envelope (activeAmt) and
 * the mode's drive level — at rest (either factor 0) it contributes exactly nothing, so the
 * field is provably still-but-drifting when idle.
 */
export function starFrame(
  s: Star,
  t: number,
  activeAmt: number,
  level: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): StarFrame {
  const idleX = Math.sin(t * s.ds + s.dxp) * 0.03;
  const idleY = Math.cos(t * s.ds * 1.1 + s.dyp) * 0.05;
  const buzzY = activeAmt * level * Math.sin(t * s.jr + s.jp) * 0.5;
  const twk = 0.5 + 0.5 * Math.sin(s.tw);
  return {
    x: cx + (s.bx + idleX) * rx,
    y: cy + (s.by + idleY + buzzY) * ry,
    alpha: Math.min(1, (0.3 + 0.5 * twk) * (0.7 + 0.45 * activeAmt + 0.4 * level)),
    size: s.sz * (1 + level * 0.4 + activeAmt * 0.15),
  };
}
