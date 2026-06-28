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
  accentMid: "#32a6f8", // midpoint of teal→accent — the center of the logo's blue→cyan fade

  // Agent status dots (background on an 8px circle)
  status: {
    active: "#2f6bff", // brand blue
    waiting: "#e0982f", // amber
    error: "#e0533f", // red
    paused: "#3a4a6a", // muted navy
    complete: "#0a1a3f", // navy (rendered with an accent/blue border)
  },

  // New brand-aligned colors for the desktop status taxonomy (spec §6).
  violet: "#8b6df0", // blocked / stalled on something external
  success: "#34c759", // done / completed cleanly
} as const;

/**
 * Agent tab status taxonomy + colors (desktop workspace spec §6). The taxonomy keeps
 * eight states for precise tooltips/legends, but they collapse to exactly THREE colors
 * so a glance tells you only what you need to act on:
 *   GREEN  — running                              (working)
 *   RED    — needs your attention                 (waiting, approval, errored)
 *   GRAY   — done / not blocked / not active       (idle, blocked, done, stopped)
 * RED means something is wrong or wants you: the agent is waiting on YOUR input (a question
 * or an approval it drew on screen) OR it crashed/exited with an error. A finished turn
 * sitting at the idle prompt is GRAY (the work is done; it isn't asking you anything) and a
 * cleanly-exited agent is GRAY too. Never hardcode these — import AGENT_STATUS. `label` is
 * the human phrase shown on hover.
 *
 * NOTE: color, badge, and notifications are three SEPARATE concerns. Color is here. The dock
 * badge counts only waiting/approval (attention.ts — "how many need an answer"). Notifications
 * are user-configurable per status (settingsStore.notifyStatuses, default-on for the red +
 * finished tiers incl. errored) — so an errored agent is red AND pings by default, but which
 * statuses ping is the user's choice, independent of this color tier.
 */
const GREEN = C.success; // #34c759 — running, leave it be
const RED = C.sienna; //   #e0533f — needs your answer
const GRAY = C.muted; //   #8aa0c4 — not active (legible on navy)
export const AGENT_STATUS = {
  working: { color: GREEN, label: "Working" }, // actively producing output
  idle: { color: GRAY, label: "Done — your turn" }, // finished its turn, not blocked on you
  waiting: { color: RED, label: "Needs you" }, // asked a question (on-screen prompt)
  approval: { color: RED, label: "Approve?" }, // caution/dangerous action pending
  blocked: { color: GRAY, label: "Stalled" }, // quiet, no on-screen question — not blocking you
  errored: { color: RED, label: "Errored" }, // process crashed/exited with an error — red so it stands out
  done: { color: GRAY, label: "Done" }, // finished cleanly, not active
  stopped: { color: GRAY, label: "Stopped" }, // not running (persisted tab)
} as const;

export type AgentTabStatus = keyof typeof AGENT_STATUS;

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
