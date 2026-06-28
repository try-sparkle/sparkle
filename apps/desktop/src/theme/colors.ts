// Desktop-local theme color layer. The shared @sparkle/ui tokens stay literal hex (mobile
// is React Native and web reads them at build, neither can consume CSS var()), so the
// light/dark switch lives entirely in the desktop app.
//
// THEME_HEX is the ONE place the light/dark hex values live. index.css mirrors these into
// CSS variables (an enforced equality test guards the mirror — see theme.test / index.css),
// and Terminal reads them directly via xtermTheme() because xterm needs concrete hex.
import { C as BRAND, AGENT_STATUS } from "@sparkle/ui";

export const THEME_HEX = {
  dark: { forest: "#0a1a3f", deepForest: "#0f2350", cream: "#eaf1ff", muted: "#8aa0c4", chatBubble: "#1d3a7a", accentInk: "#34e0f0", agentIdle: "#8aa0c4", successInk: "#34c759" },
  light: { forest: "#ffffff", deepForest: "#f1f4fa", cream: "#0a1a3f", muted: "#5b6b8c", chatBubble: "#d6e0f5", accentInk: "#0a1a3f", agentIdle: "#3f4e6b", successInk: "#15803d" },
} as const;

// Themed token object for component inline styles. The four theme-dependent tokens become
// var()-based, so a single `data-theme` flip on <html> re-themes the whole app through CSS
// with no React re-render. Everything else (teal, amber, accent, status, …) is brand
// identity, unchanged across themes, and passes through as literal hex from BRAND.
export const C = {
  ...BRAND,
  forest: "var(--c-forest)",
  deepForest: "var(--c-deep-forest)",
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

// Map a raw AGENT_STATUS color to a light-mode-legible THEMED ink, for use as TEXT/glyph color.
// The brand gray (idle/done/blocked/stopped) and brand green (working) are both too light to read
// on the white light-mode sidebar, so they flip to darker themed tokens in light mode (and keep
// their brand color in dark, via the var()s). Red/amber/violet are already legible in both themes
// and pass through unchanged. For FILLS (status dots, badges) keep the raw brand color instead.
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
export function xtermTheme(resolved: "light" | "dark") {
  const hex = THEME_HEX[resolved];
  return {
    background: hex.forest,
    foreground: hex.cream,
    cursor: BRAND.accent,
    selectionBackground: hex.chatBubble,
    // ANSI blue override. xterm's default blue is a light periwinkle that reads fine on the
    // dark-mode navy background but goes low-contrast on the light-mode white background — and
    // TUIs like Claude Code paint headings/links/prompts in (bright) blue. In light mode we
    // pin both to the PRIMARY brand blue (#2f6bff, the right end of the logo's blue→cyan fade),
    // which is dark enough to stay legible on white. Dark mode keeps xterm's defaults.
    ...(resolved === "light" ? { blue: BRAND.teal, brightBlue: BRAND.teal } : {}),
  };
}

// Re-export the non-themed runtime VALUES so re-pointed components import one module.
// (Types stay on @sparkle/ui — this module intentionally does not re-export them.)
export { AGENT_STATUS, FONT, FONT_WEIGHT } from "@sparkle/ui";
