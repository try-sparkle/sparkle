// ── THE TYPE, RADIUS AND SPACING SCALES ────────────────────────────────────────────────────────
// Colour got a token layer and a set of enforced floors; geometry never did. Two dozen distinct
// `fontSize` values and a dozen-plus `borderRadius` values had accumulated across ~500 inline style
// objects, and nothing was choosing between them — 15, 17 and 18 all mean "a dialog heading", 8, 9
// and 10 all mean "a card corner". That is what "the UI is a mess" looks like written down.
//
// THE EXACT INVENTORY LIVES IN `scale.test.ts`, NOT HERE, and deliberately so. The first version of
// this header restated the counts and got them wrong — it said fourteen font sizes when there were
// twenty-three, silently dropping every fractional value, which were its own headline argument — so
// the two new files disagreed with each other on day one. A number measured in one place and
// re-typed in another is the drift this token layer exists to stop. The test counts; read it there.
//
// These are the canonical steps. Import them; do not type a number.
//
// ── WHY THIS FILE DOES NOT ALSO MIGRATE THE 500 CALL SITES ────────────────────────────────────
// Because it cannot be verified. There is not one `fontSize` assertion in the entire desktop suite,
// so a sweep that rewrote every heading would be both unguarded and invisible — a green suite would
// say nothing about whether the app still reads. Collapsing a 28px hero to 22px, or every 18px
// dialog title to 16px, is a decision that needs eyes on the running app, not a regex.
//
// So the ratchet below is the mechanism instead: `scale.test.ts` counts off-scale values and pins
// the count as a CEILING. New code cannot add sprawl, and the migration can land in reviewable
// pieces with the number falling each time. A ratchet that measures the real thing beats a sweep
// that changes 500 call sites on one person's guess.

/**
 * SIX type steps, and the app is dense on purpose — the founder's brief was "rationalize the
 * scale but keep it dense", so the band is 10–22 rather than a typographic 1.25 ratio that would
 * put body text at 16px and a heading at 31px.
 *
 * Each step has ONE job. If two sizes would mean the same thing, that is the bug this file exists
 * to prevent — reach for the neighbouring step instead of adding a value.
 */
export const TYPE = {
  /** 10 — badges, keycap chiclets, stage ticker marks. The floor: nothing may be smaller. */
  micro: 10,
  /** 11 — metadata, timestamps, the secondary line under a title. */
  tiny: 11,
  /** 12 — secondary UI: chips, hints, most controls. The workhorse. */
  small: 12,
  /** 13 — primary UI text: rows, labels, body copy, the composer. */
  body: 13,
  /** 16 — section and dialog titles. */
  title: 16,
  /** 22 — page-level headings and empty-state heroes. The ceiling for TEXT. */
  hero: 22,
} as const;

/**
 * FOUR radius steps. `pill` is deliberately not one of them — see below.
 */
export const RADIUS = {
  /** 4 — chips, inputs, small controls. */
  sm: 4,
  /** 6 — buttons, menu rows. */
  md: 6,
  /** 8 — cards, panels, the agent row. */
  lg: 8,
  /** 12 — modals and the largest surfaces. */
  xl: 12,
} as const;

/**
 * A `borderRadius` big enough to round any edge fully. NOT a scale step, and not interchangeable
 * with one: on a SQUARE box this is a circle (a status dot, an avatar) and on a wide box it is a
 * capsule (a pill button). Both are legitimate shapes that no fixed radius expresses, which is why
 * the literal survives where the arbitrary ones did not — it means "fully round", not "999px".
 */
export const PILL = 999;

/**
 * EIGHT spacing steps: a 4px grid, PLUS TWO HALF-STEPS (2 and 6). Gaps and padding drift the same
 * way radii do, and for the same reason — 7px and 8px look identical in isolation and different
 * side by side.
 *
 * The half-steps are stated rather than hidden: this was documented as "on a 4px grid" over values
 * that plainly were not, which is the same drift the header warns about, one screen further down.
 * They earn their place because the app is dense — a 4px gap is the difference between a chip and
 * its label, and 2px is the tightest legible seam — but they ARE the exception, so a ninth step
 * needs a better reason than "8 was too big and 12 too small".
 *
 * NO RATCHET ON SPACING YET, and that is a deliberate deferral rather than an oversight. `gap:` and
 * `padding:` take shorthand strings far more often than `fontSize` does, so counting them well
 * needs the value-expression scan to handle multi-value shorthand semantically (which edge does a
 * `"6px 12px"` belong to?). Type and radius were the sprawl worth stopping first. The ordering and
 * distinctness of these steps IS guarded in scale.test.ts.
 */
export const SPACE = {
  xxs: 2,
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 24,
  xxxl: 32,
} as const;

export type TypeStep = (typeof TYPE)[keyof typeof TYPE];
export type RadiusStep = (typeof RADIUS)[keyof typeof RADIUS];

/** Every value the scales permit, for the ratchet guard in scale.test.ts. */
export const ALLOWED_TYPE: readonly number[] = Object.values(TYPE);
// `0` is allowed because "no rounding" is not a scale question — a square corner is a shape
// decision, not a step someone failed to pick.
export const ALLOWED_RADIUS: readonly number[] = [0, ...Object.values(RADIUS), PILL];
