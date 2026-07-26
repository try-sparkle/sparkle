// Desktop-local theme color layer. The shared @sparkle/ui tokens stay literal hex (mobile
// is React Native and web reads them at build, neither can consume CSS var()), so the
// light/dark switch lives entirely in the desktop app.
//
// THEME_HEX is the ONE place the light/dark hex values live. index.css mirrors these into
// CSS variables (an enforced equality test guards the mirror — see theme.test / index.css),
// and Terminal reads them directly via xtermTheme() because xterm needs concrete hex.
import { C as BRAND, AGENT_STATUS } from "@sparkle/ui";

// Two tinted chrome surfaces sit around the `forest` terminal content (white in light, deep navy
// in dark), and they are deliberately DIFFERENT shades:
//
// • deepForest — the LEFT SIDEBAR (and its internals: the Think/Plan/Build chevron seam, the
//   sticky New-Agent slot, the active card's flare border) plus shared secondary surfaces
//   (modals, dropdowns, pills). Held ONE STEP away from `forest` so the active row — painted in
//   `forest` — stands out against inactive rows: ~10% darker than near-white in light
//   (#f1f4fa → #d9dce1, toward black), ~10% lighter than the base navy in dark (#0f2350 → #273962,
//   toward white).
//
// • barSurface — the TOP BAR and the COMPOSER input box. These frame the live terminal directly,
//   so they stay at the LIGHTER original chrome shade (#f1f4fa light / #0f2350 dark) and recede
//   against the content instead of competing with the darker sidebar. (This is exactly the old
//   deepForest value, split off so the sidebar can go darker without dragging the bars with it.)
//
// • conciergeSurface — the SPARKLE CONCIERGE column, the LIGHTEST of the three depth layers in
//   the concierge shell (PRD/sparkle/concierge-mode.md §3: "three depth layers, Sparkle lightest →
//   builder → terminal darkest"). One step lifted from `deepForest` (the builder column) so the
//   three columns read as receding planes rather than one flat surface. In light mode the ordering
//   inverts with the theme, exactly as deepForest/barSurface already do.
//
// All preserve the original blue tint — only the light/dark placement relative to `forest` changes.
export const THEME_HEX = {
  dark: { forest: "#0a1a3f", deepForest: "#273962", conciergeSurface: "#33477a", conciergeMuted: "#adbfe0", barSurface: "#0f2350", cream: "#eaf1ff", muted: "#8aa0c4", chatBubble: "#1d3a7a", chatBubbleActive: "#2c57b0", accentInk: "#34e0f0", agentIdle: "#8aa0c4", successInk: "#34c759" },
  light: { forest: "#ffffff", deepForest: "#d9dce1", conciergeSurface: "#eceef2", conciergeMuted: "#5b6b8c", barSurface: "#f1f4fa", cream: "#0a1a3f", muted: "#5b6b8c", chatBubble: "#d6e0f5", chatBubbleActive: "#bccdf2", accentInk: "#0a1a3f", agentIdle: "#3f4e6b", successInk: "#15803d" },
} as const;

// Themed token object for component inline styles. The four theme-dependent tokens become
// var()-based, so a single `data-theme` flip on <html> re-themes the whole app through CSS
// with no React re-render. Everything else (teal, amber, accent, status, …) is brand
// identity, unchanged across themes, and passes through as literal hex from BRAND.
export const C = {
  ...BRAND,
  forest: "var(--c-forest)",
  deepForest: "var(--c-deep-forest)",
  // The concierge column — the lightest of the shell's three depth layers. See THEME_HEX above.
  conciergeSurface: "var(--c-concierge-surface)",
  // Secondary text INSIDE the concierge column. `muted` (#8aa0c4) is tuned for the darker forest /
  // deepForest surfaces; on the lifted conciergeSurface (#33477a) it falls to ~3.4:1, well short of
  // WCAG AA for body text — and that column is where the scope line, the vitals and every secondary
  // label live (roborev 46254-L). This ink clears 4.5:1 on that surface. Light mode was already
  // fine (the surface goes light there), so it stays at the ordinary muted value.
  conciergeMuted: "var(--c-concierge-muted)",
  // Lighter chrome for the top bar + composer box — the original deepForest shade. Kept distinct
  // from (lighter than) deepForest so those bars recede against the terminal while the sidebar
  // stays a step darker. See THEME_HEX above.
  barSurface: "var(--c-bar-surface)",
  cream: "var(--c-cream)",
  muted: "var(--c-muted)",
  // Cyan (brand accent) is legible as TEXT only on dark backgrounds. As text it must flip to
  // dark ink in light mode — so this themed token is cyan in dark, navy in light. Use it for
  // accent-colored text/glyphs; keep BRAND.accent (constant cyan) for fills/strokes/borders.
  accentInk: "var(--c-accent-ink)",
  // Inactive (done/stopped) agent name text. The brand "gray" (#8aa0c4) is too light to read
  // on the light sidebar, so this themed token keeps it in dark mode but goes much darker in
  // light. (AGENT_STATUS red/amber stay brand-constant; the green flips via successInk below.)
  agentIdle: "var(--c-agent-idle)",
  // Brand success GREEN as TEXT. #34c759 reads fine on dark navy but is too light on the white
  // light-mode sidebar — so this themed token keeps the brand green in dark and goes to a darker,
  // readable green (#15803d) in light. Use it for green text/glyphs (the "working" status name,
  // the ✓ "Landed" mark, the ahead pill's label/border); keep BRAND.success (constant green) for
  // fills, alpha tints, and status dots, the same split as accentInk vs accent.
  successInk: "var(--c-success-ink)",
};

export const CHAT_USER_BUBBLE = "var(--c-chat-bubble)";

// The starker active-row fill — one notch more contrast than CHAT_USER_BUBBLE so three states read
// at a glance: idle (transparent), hovered/expanded card (CHAT_USER_BUBBLE), and the row you're
// actually IN (this). Brighter/more-saturated blue in dark, darker blue in light.
export const ROW_ACTIVE_BUBBLE = "var(--c-chat-bubble-active)";

// Map a raw AGENT_STATUS color to a light-mode-legible THEMED ink, for use as TEXT/glyph color.
// The brand gray (idle/done/stopped) and brand green (working) are both too light to read
// on the white light-mode sidebar, so they flip to darker themed tokens in light mode (and keep
// their brand color in dark, via the var()s). Red/amber/violet are already legible in both themes
// and pass through unchanged (`blocked` is red, so its name reads red; `unmerged` is gray). For FILLS
// (status dots, badges) keep the raw brand color instead.
export function statusInk(color: string): string {
  if (color === AGENT_STATUS.done.color) return C.agentIdle; // brand gray
  if (color === AGENT_STATUS.working.color) return C.successInk; // brand green
  return color;
}

// Foreground for text/icons sitting ON a brand-colored fill (e.g. teal). The fill is constant
// across themes, so this must stay light in BOTH — use the brand cream LITERAL, not the themed
// var, which flips to navy ink in light mode and would go low-contrast on teal.
export const ON_BRAND_FILL = BRAND.cream;

// Counterpart for text/icons sitting on a LIGHT brand fill (e.g. the cyan Think button),
// where dark ink reads better than cream. Constant navy in both themes — the fill is constant too.
export const ON_BRAND_FILL_DARK = BRAND.forest;

// Error/alert text (failed browser hand-off, redeem errors). Constant across themes — small
// alert strings on the dark forest/deepForest surfaces. One place so the error UX never drifts
// between the gate, the welcome screen, and the trial pill.
export const DANGER = "#e5484d";

// xterm cannot use CSS var() — it needs concrete hex. Build its theme from THEME_HEX indexed
// by the resolved theme (order-independent, unlike reading the live data-theme). `cursor` is
// the brand accent (constant across themes), so it stays literal from BRAND.
/** The calm inks (PRD §3 / prototype `.terminal.calm .term-body span { color: #7d818e }`),
 *  INDEXED BY THEME (roborev 46341): the prototype's grays were picked against a navy terminal
 *  and go ~3.9:1 on light mode's white background, so light mode gets its own values.
 *  Two luminance levels per theme — `dim` for the dark ANSI slots, `bright` for the bright ones —
 *  so a TUI that paints cell BACKGROUNDS (diff hunks, selected rows) keeps text/background
 *  contrast instead of collapsing to gray-on-identical-gray.
 *
 *  TWO FLOORS, BOTH ENFORCED (roborev 46485-M), because the palette has two jobs that pull apart:
 *   1. every ink ≥ CALM_MIN_CONTRAST against the theme's own `forest` — the common case is text on
 *      the terminal background, and the first cut chose `dim` by "how far can it fall toward the
 *      background", landing too close to the background to read (that cut is why the floor exists — the exact
 *      values live only in xtermTheme.test.ts);
 *   2. `bright` ≥ CALM_MIN_SPLIT against `dim` — the reason the two levels exist at all, so a TUI
 *      that paints cell BACKGROUNDS (diff hunks, selected rows) keeps text/fill contrast instead
 *      of collapsing to gray-on-identical-gray. Raising `dim` to satisfy (1) had quietly crushed
 *      this split below its floor while this comment still claimed it held.
 *
 *  ONE PAIR IS DELIBERATELY UNCOVERED: `ink` over a `dim`-painted fill (default-foreground text on
 *  a cell whose background came from a dark ANSI slot). Satisfying that too would push the band so
 *  far apart that calm stops reading as calm, and it is the rarest combination on screen — a TUI
 *  that paints a background almost always paints its foreground too, which is the pair (2) covers.
 *  NO RATIOS ARE WRITTEN IN THESE COMMENTS (roborev 46897): the first set of annotations was
 *  measurably wrong (a "4.6:1" that was really 6.7:1, "2.1:1" pairs that were 2.03), and a reader
 *  checks the comment before the test. `xtermTheme.test.ts` computes both floors from the actual
 *  hex and is the only contract — inequality assertions ("bright is lighter than dim") are what let
 *  the first regression through, so it asserts numbers.
 *
 *  MARGIN: light mode is the tight one. `bright` has to clear the background floor against WHITE
 *  while staying light enough to read as the brighter of the two levels, which leaves it close to
 *  both limits — nudging either light value is likely to trip a floor, and that is the test's job
 *  to catch. Dark mode has room, so `bright` there sits comfortably clear of `dim` rather than
 *  hugging CALM_MIN_SPLIT. */
const CALM = {
  dark: {
    ink: "#7d818e", // the prototype's value
    dim: "#656a77", // recessive, still legible on navy
    bright: "#a2a8b5", // clearly above dim — see the margin note below
    selectionForeground: "#c8ccd6",
  },
  light: {
    ink: "#5f6470", // readable on white, still recessive
    dim: "#575c68", // in LIGHT mode the dark ANSI slots read DARKER, not lighter
    bright: "#8b909c", // the lightest ink that still clears the background floor on white
    selectionForeground: "#1f232c",
  },
} as const;

/** Floor for a calm ink against the terminal background it sits on. */
export const CALM_MIN_CONTRAST = 3;
/** Floor between the two calm levels, so a painted-background cell stays readable. */
export const CALM_MIN_SPLIT = 2;

/** Every ANSI slot pointed at a calm gray — flattened hue, preserved luminance ordering. */
function calmAnsi(c: (typeof CALM)["dark" | "light"]) {
  return {
    black: c.dim,
    red: c.dim,
    green: c.dim,
    yellow: c.dim,
    blue: c.dim,
    magenta: c.dim,
    cyan: c.dim,
    white: c.dim,
    brightBlack: c.dim,
    brightRed: c.bright,
    brightGreen: c.bright,
    brightYellow: c.bright,
    brightBlue: c.bright,
    brightMagenta: c.bright,
    brightCyan: c.bright,
    brightWhite: c.bright,
  } as const;
}

/**
 * The xterm theme object. `calm` desaturates the terminal's OWN COLORS — the prototype's treatment
 * — rather than putting a CSS `filter` on an ancestor of the pane (roborev 46254). A filter over
 * the stage costs a full-layer composite on every frame of streaming output (calm is the default
 * state for a `working` agent, i.e. exactly the heavy-output case, and the canvas is WebGL), grays
 * the pane's chrome and the onboarding empty states along with the text, and — because a non-`none`
 * filter makes the element a containing block for `position: fixed` descendants — silently shrank
 * the account-switcher's full-screen click-away backdrop to the stage.
 */
export function xtermTheme(resolved: "light" | "dark", calm = false) {
  const hex = THEME_HEX[resolved];
  const calmC = CALM[resolved];
  return {
    background: hex.forest,
    foreground: calm ? calmC.ink : hex.cream,
    cursor: calm ? calmC.bright : BRAND.accent,
    selectionBackground: hex.chatBubble,
    // While calm the text goes gray, so pin a selection foreground that stays readable over
    // the selection fill (roborev 46341).
    ...(calm ? { selectionForeground: calmC.selectionForeground } : {}),
    // ANSI blue override. xterm's default blue is a light periwinkle that reads fine on the
    // dark-mode navy background but goes low-contrast on the light-mode white background — and
    // TUIs like Claude Code paint headings/links/prompts in (bright) blue. In light mode we
    // pin both to the PRIMARY brand blue (#2f6bff, the right end of the logo's blue→cyan fade),
    // which is dark enough to stay legible on white. Dark mode keeps xterm's defaults.
    ...(resolved === "light" ? { blue: BRAND.teal, brightBlue: BRAND.teal } : {}),
    // LAST, so calm wins: while calm, even the legibility override above is one of the colors
    // being flattened.
    ...(calm ? calmAnsi(calmC) : {}),
  };
}

// Re-export the non-themed runtime VALUES so re-pointed components import one module.
// (Types stay on @sparkle/ui — this module intentionally does not re-export them.)
export { AGENT_STATUS, FONT, FONT_WEIGHT } from "@sparkle/ui";
