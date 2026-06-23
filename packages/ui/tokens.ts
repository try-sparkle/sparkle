// Sparkle design tokens — derived from the brand logo (images/logos). The single
// source of truth for color, type, and weight. Import these everywhere; DO NOT
// hardcode colors. Token KEYS are kept stable (forest/teal/amber/sienna/cream/muted)
// so consumers don't churn; the VALUES are the brand palette and the comments below
// describe each key's real role.

export const C = {
  // Backgrounds — brand navy (logo deep background)
  forest: "#0a1a3f", // primary app background (deep navy)
  deepForest: "#0f2350", // sidebar, modals, cards (lifted navy)

  // Interactive
  teal: "#2f6bff", // PRIMARY brand blue — CTAs, approve, active indicator
  amber: "#e0982f", // caution / progress / waiting (kept warm for legibility)
  sienna: "#e0533f", // dangerous actions / error / deny (kept red for legibility)

  // Text
  cream: "#eaf1ff", // headings, button labels, primary text (light on navy)
  muted: "#8aa0c4", // secondary text, timestamps, metadata (blue-gray)

  // Brand sparkle accent (logo cyan)
  accent: "#34e0f0", // highlights, progress sheen, the "sparkle"

  // Agent status dots (background on an 8px circle)
  status: {
    active: "#2f6bff", // brand blue
    waiting: "#e0982f", // amber
    error: "#e0533f", // red
    paused: "#3a4a6a", // muted navy
    complete: "#0a1a3f", // navy (rendered with an accent/blue border)
  },
} as const;

export const FONT = {
  ui: '"IBM Plex Sans", sans-serif',
  mono: '"Source Code Pro", monospace', // Expert Mode only
} as const;

export const FONT_WEIGHT = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

// User-message bubble tint (mid navy-blue) — see ChatPanel spec.
export const CHAT_USER_BUBBLE = "#1d3a7a" as const;

export type AgentStatus = keyof typeof C.status;
