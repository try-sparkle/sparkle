// ── THE BLUEPRINT DESIGN SYSTEM: TYPE, RADIUS, SPACING AND THE FONTS ───────────────────────────
//
// THESE VALUES COME FROM THE APPROVED SPEC, NOT FROM TASTE. `PRD/sparkle/ui-directions/index.html`
// is the direction the founder signed off, and it is real CSS rather than a picture — every number
// below is lifted from its `[data-dir="blueprint"]` block. That provenance is the whole point of
// this header, because the first version of this file did NOT do that: it invented a scale
// (10/11/12/13/16/22, radii 4/6/8/12) that looked reasonable and matched nothing. The app shipped
// two releases carrying a correctly-derived PALETTE on top of typography and geometry the design
// never asked for, and the founder's verdict was that it "doesn't look anything like" the design.
//
// The spec's thesis, quoted from it: *structure is drawn, not filled — hairlines on a faint grid,
// panels are outlines, and the registers separate by LINE WEIGHT.* That is why the radii below are
// small enough to read as drawn boxes rather than pills, and why the type tops out at 17px: this is
// a dense instrument, not a marketing page.

/**
 * FOUR type steps. Ten, twelve, thirteen, seventeen — that is the entire scale.
 *
 * The app had twenty-three sizes running to 42px. Nothing chose between them; 15, 17 and 18 all
 * meant "a dialog heading". A four-step scale is not an austerity measure, it is what makes a dense
 * UI read as one system instead of a pile of decisions.
 */
export const TYPE = {
  /** 10 — the tracked mono LABELS (see `LABEL`), badges, stage ticks. */
  micro: 10,
  /** 12 — secondary UI: chips, hints, metadata, most controls. Also the terminal's own size. */
  small: 12,
  /** 13 — primary UI text: rows, labels, body copy, the composer, the thread. */
  body: 13,
  /** 17 — section and dialog titles. THE CEILING. A hero is 17px bold, not 28px light. */
  title: 17,
} as const;

/**
 * The terminal's type size, named separately because it is a different register — it answers to the
 * shell's output, not to the UI's hierarchy — even though it currently coincides with `small`.
 */
export const TERM_TYPE = 12;

/**
 * FOUR radii, all small. The spec draws boxes; a 12px corner reads as a pill and a pill reads as a
 * consumer app. `sm` is for the smallest chips, `modal` is the largest thing on screen.
 */
export const RADIUS = {
  /** 3 — swatches, ticks, the smallest chips. */
  sm: 3,
  /** 4 — inputs, buttons, cards, the chat bubble. The workhorse. */
  input: 4,
  /** 4 — the chat bubble, named for the call site so the tail treatment has somewhere to hang. */
  bubble: 4,
  /** 6 — modals and the largest surfaces. THE CEILING. */
  modal: 6,
} as const;

/**
 * A `borderRadius` big enough to round any edge fully. NOT a scale step: on a SQUARE box this is a
 * circle (a status dot, an avatar) and on a wide box a capsule. Both are shapes no fixed radius
 * expresses, which is why the literal survives where the arbitrary ones do not.
 */
export const PILL = 999;

/** Weights. The spec uses exactly two above regular, and `bold` is 600 — not 700. */
export const WEIGHT = { med: 500, bold: 600 } as const;

/** Reading line-height for prose (the thread, modal body copy). */
export const LINE_READ = 1.62;

/**
 * THE FONTS, and this is the loudest single difference between the spec and what shipped.
 *
 * The app renders its UI in IBM Plex Sans and the concierge column in **Verdana** — a deliberate
 * older decision ("the concierge doesn't share the workspace's UI font"). The spec uses the system
 * face for both. A humanist webfont and Verdana against `system-ui` is not a subtle change: it is
 * most of why the running app reads as a different product from the design.
 */
export const FONT_UI = 'system-ui, -apple-system, "Segoe UI", sans-serif';
export const FONT_MONO = 'ui-monospace, "SF Mono", Menlo, monospace';

/**
 * The LABEL treatment: monospace, uppercase, tracked. Section headers, lane names, column titles.
 * This is the single most characteristic mark of the direction — it is what makes the shell read as
 * an instrument — and the app has none of it today.
 */
export const LABEL = {
  fontFamily: FONT_MONO,
  fontSize: TYPE.micro,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  fontWeight: WEIGHT.med,
} as const;

/**
 * Spacing, from the spec's `--sp-*`. Not a mathematical grid — these are the measured paddings the
 * direction actually uses, which is why 9 and 11 appear.
 */
export const SPACE = {
  /** 6 — tight row padding (vertical). */
  xs: 6,
  /** 8 — bubble padding (vertical), compose gaps. */
  sm: 8,
  /** 9 — row padding (horizontal). */
  row: 9,
  /** 11 — bubble/input padding (horizontal). */
  input: 11,
  /** 12 — compose box, header bottom. */
  md: 12,
  /** 14 — header sides. */
  lg: 14,
  /** 16 — thread padding, gap between messages. */
  xl: 16,
} as const;

/** The terminal's reading measure — the spec caps output width so long lines stay scannable. */
export const TERM_MEASURE = "74ch";

export type TypeStep = (typeof TYPE)[keyof typeof TYPE];
export type RadiusStep = (typeof RADIUS)[keyof typeof RADIUS];

/** Every value the scales permit, for the ratchet guard in scale.test.ts. */
export const ALLOWED_TYPE: readonly number[] = [...new Set(Object.values(TYPE))];
// `0` is allowed because "no rounding" is not a scale question — a square corner is a shape
// decision, not a step someone failed to pick.
export const ALLOWED_RADIUS: readonly number[] = [0, ...new Set(Object.values(RADIUS)), PILL];
