// ── THE BLUEPRINT DESIGN SYSTEM: TYPE, RADIUS, SPACING AND THE FONTS ───────────────────────────
//
// THESE VALUES COME FROM THE APPROVED SPEC, NOT FROM TASTE — AND THEY ARE NO LONGER RE-TYPED HERE.
// `PRD/sparkle/ui-directions/index.html` is the direction the founder signed off, authored as real
// CSS custom properties (not a picture). Its `[data-dir="blueprint"]` block is extracted verbatim
// into `./design-tokens.json` by `apps/desktop/scripts/extract-design-tokens.mjs`, and every scale
// below is DERIVED from that JSON at module load — so the spec is a machine-readable source of
// truth and "does the app match the design" is a diff, not a judgement someone re-makes by hand.
// `theme/designTokens.fidelity.test.ts` asserts the JSON still matches the spec AND that every
// export below matches the JSON.
//
// That provenance is the whole point, because the first version of this file re-derived by hand and
// got it wrong: it invented a scale (10/11/12/13/16/22, radii 4/6/8/12) that looked reasonable and
// matched nothing. The app shipped two releases carrying a correctly-derived PALETTE on top of
// typography and geometry the design never asked for, and the founder's verdict was that it
// "doesn't look anything like" the design. A hand-authored file is exactly what let that happen;
// deriving from the JSON is what stops it happening again.
//
// The spec's thesis, quoted from it: *structure is drawn, not filled — hairlines on a faint grid,
// panels are outlines, and the registers separate by LINE WEIGHT.* That is why the radii below are
// small enough to read as drawn boxes rather than pills, and why the type tops out at 17px: this is
// a dense instrument, not a marketing page.
//
// ── HOW THE DERIVATION WORKS ───────────────────────────────────────────────────────────────────
// `design-tokens.json` mirrors the spec's two CSS rules: `base` (all scale tokens + the LIGHT
// colour ramp) and `dark` (the `--k-*` colour overrides). This file reads the SCALE tokens out of
// `base`; the colour ramp is consumed by `colors.ts`. `px()` pulls the leading number off a spec
// value ("13px" → 13, "6px 9px" → 6), and `part()` reaches a later component of a multi-value
// padding ("6px 9px" → 9). The prop names passed to them are checked against the JSON's key set at
// compile time, so a typo or a spec rename is a build error, not a silent NaN.
import tokens from "./design-tokens.json";

const BASE = tokens.base;
type BaseProp = keyof typeof BASE;
/** The numbers in a spec value, in order: "6px 9px" → [6, 9], "13px" → [13], "500" → [500]. */
const nums = (prop: BaseProp): number[] =>
  String(BASE[prop])
    .trim()
    .split(/\s+/)
    .map((t) => Number(t.replace(/px$/, "")));
/** The FIRST number of a spec value — the scalar case ("13px" → 13) and a padding's first axis. */
const px = (prop: BaseProp): number => nums(prop)[0]!;
/** A later component of a multi-value spec padding ("6px 9px", 1) → 9. */
const part = (prop: BaseProp, i: number): number => nums(prop)[i]!;

/**
 * FOUR type steps. Ten, twelve, thirteen, seventeen — that is the entire scale.
 *
 * The app had twenty-three sizes running to 42px. Nothing chose between them; 15, 17 and 18 all
 * meant "a dialog heading". A four-step scale is not an austerity measure, it is what makes a dense
 * UI read as one system instead of a pile of decisions.
 */
export const TYPE = {
  /** 10 — the tracked mono LABELS (see `LABEL`), badges, stage ticks. (`--t-micro`) */
  micro: px("--t-micro"),
  /** 12 — secondary UI: chips, hints, metadata, most controls. Also the terminal's own size. (`--t-small`) */
  small: px("--t-small"),
  /** 13 — primary UI text: rows, labels, body copy, the composer, the thread. (`--t-body`) */
  body: px("--t-body"),
  /** 17 — section and dialog titles. THE CEILING. A hero is 17px bold, not 28px light. (`--t-title`) */
  title: px("--t-title"),
} as const;

/**
 * The terminal's type size, named separately because it is a different register — it answers to the
 * shell's output, not to the UI's hierarchy — even though it currently coincides with `small`.
 * (`--t-term`)
 */
export const TERM_TYPE = px("--t-term");

/**
 * FOUR radii, all small. The spec draws boxes; a 12px corner reads as a pill and a pill reads as a
 * consumer app. `sm` is for the smallest chips, `modal` is the largest thing on screen.
 */
export const RADIUS = {
  /** 3 — swatches, ticks, the smallest chips. (`--r-sm`) */
  sm: px("--r-sm"),
  /** 4 — inputs, buttons, cards, the chat bubble. The workhorse. (`--r-input`) */
  input: px("--r-input"),
  /** 4 — the chat bubble, named for the call site so the tail treatment has somewhere to hang. (`--r-bubble`) */
  bubble: px("--r-bubble"),
  /** 6 — modals and the largest surfaces. THE CEILING. (`--r-modal`) */
  modal: px("--r-modal"),
} as const;

/**
 * A `borderRadius` big enough to round any edge fully. NOT a scale step: on a SQUARE box this is a
 * circle (a status dot, an avatar) and on a wide box a capsule. Both are shapes no fixed radius
 * expresses, which is why the literal survives where the arbitrary ones do not.
 */
export const PILL = 999;

/** Weights. The spec uses exactly two above regular, and `bold` is 600 — not 700.
 *  (`--w-med` / `--w-bold`) */
export const WEIGHT = { med: px("--w-med"), bold: px("--w-bold") } as const;

/** Reading line-height for prose (the thread, modal body copy). (`--lh-read`) */
export const LINE_READ = px("--lh-read");

/**
 * THE FONTS, and this is the loudest single difference between the spec and what shipped.
 *
 * The app renders its UI in IBM Plex Sans and the concierge column in **Verdana** — a deliberate
 * older decision ("the concierge doesn't share the workspace's UI font"). The spec uses the system
 * face for both. A humanist webfont and Verdana against `system-ui` is not a subtle change: it is
 * most of why the running app reads as a different product from the design.
 */
export const FONT_UI = BASE["--k-ui"];
export const FONT_MONO = BASE["--k-mono"];

/**
 * The LABEL treatment: monospace, uppercase, tracked. Section headers, lane names, column titles.
 * This is the single most characteristic mark of the direction — it is what makes the shell read as
 * an instrument — and the app has none of it today.
 */
export const LABEL = {
  fontFamily: FONT_MONO, // `--k-label` (identical to `--k-mono` in the spec)
  fontSize: TYPE.micro,
  letterSpacing: BASE["--ls-label"], // "0.1em"
  textTransform: BASE["--tt-label"], // "uppercase"
  fontWeight: WEIGHT.med,
} as const;

/**
 * Spacing, from the spec's `--sp-*`. Not a mathematical grid — these are the measured paddings the
 * direction actually uses, which is why 9 and 11 appear.
 *
 * Each step names the spec padding it is lifted from, so the mapping is auditable rather than
 * coincidental. `--sp-navitem`'s 10px is the one spec padding component with no named step here —
 * the direction uses it once, for nav items — and it is deliberately left unexposed rather than
 * given a key nothing reads (the fidelity test records it as a known-unexposed spec value).
 */
export const SPACE = {
  /** 6 — tight row padding (vertical). (`--sp-row` axis 1) */
  xs: px("--sp-row"),
  /** 8 — bubble padding (vertical), compose gaps. (`--sp-bubble` axis 1) */
  sm: px("--sp-bubble"),
  /** 9 — row padding (horizontal). (`--sp-row` axis 2) */
  row: part("--sp-row", 1),
  /** 11 — bubble/input padding (horizontal). (`--sp-bubble` axis 2) */
  input: part("--sp-bubble", 1),
  /** 12 — compose box, header bottom. (`--sp-comp`) */
  md: px("--sp-comp"),
  /** 14 — header sides. (`--sp-hd` axis 1) */
  lg: px("--sp-hd"),
  /** 16 — thread padding, gap between messages. (`--sp-thread`) */
  xl: px("--sp-thread"),
} as const;

/** The terminal's reading measure — the spec caps output width so long lines stay scannable.
 *  (`--term-measure`) */
export const TERM_MEASURE = BASE["--term-measure"];

export type TypeStep = (typeof TYPE)[keyof typeof TYPE];
export type RadiusStep = (typeof RADIUS)[keyof typeof RADIUS];

/** Every value the scales permit, for the ratchet guard in scale.test.ts. */
export const ALLOWED_TYPE: readonly number[] = [...new Set(Object.values(TYPE))];
// `0` is allowed because "no rounding" is not a scale question — a square corner is a shape
// decision, not a step someone failed to pick.
export const ALLOWED_RADIUS: readonly number[] = [0, ...new Set(Object.values(RADIUS)), PILL];
