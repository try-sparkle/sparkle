// Desktop-local theme color layer. The shared @sparkle/ui tokens stay literal hex (mobile
// is React Native and web reads them at build, neither can consume CSS var()), so the
// light/dark switch lives entirely in the desktop app.
//
// THEME_HEX is the ONE place the light/dark hex values live. index.css mirrors these into
// CSS variables (an enforced equality test guards the mirror — see theme.test / index.css),
// and Terminal reads them directly via xtermTheme() because xterm needs concrete hex.
import { C as BRAND } from "@sparkle/ui";

export const THEME_HEX = {
  dark: { forest: "#0a1a3f", deepForest: "#0f2350", cream: "#eaf1ff", muted: "#8aa0c4", chatBubble: "#1d3a7a" },
  light: { forest: "#ffffff", deepForest: "#f1f4fa", cream: "#0a1a3f", muted: "#5b6b8c", chatBubble: "#d6e0f5" },
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
};

export const CHAT_USER_BUBBLE = "var(--c-chat-bubble)";

// Foreground for text/icons sitting ON a brand-colored fill (e.g. teal). The fill is constant
// across themes, so this must stay light in BOTH — use the brand cream LITERAL, not the themed
// var, which flips to navy ink in light mode and would go low-contrast on teal.
export const ON_BRAND_FILL = BRAND.cream;

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
  };
}

// Re-export the non-themed runtime VALUES so re-pointed components import one module.
// (Types stay on @sparkle/ui — this module intentionally does not re-export them.)
export { AGENT_STATUS, FONT, FONT_WEIGHT } from "@sparkle/ui";
