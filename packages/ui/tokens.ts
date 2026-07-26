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
 * nine states for precise tooltips/legends, but they collapse to exactly THREE colors
 * so a glance tells you only what you need to act on:
 *   GREEN  — running                              (working)
 *   RED    — needs your action                    (waiting, approval, errored, blocked)
 *   GRAY   — nothing is stopping you              (idle, done, stopped, unmerged)
 * RED means the agent needs YOU before it can make progress: it's waiting on your input (a question
 * or an approval it drew on screen, OR a finished-turn ask the followup judge flagged as blocked on
 * you — see turnFollowup.ts / statusRouter.ts); OR it crashed/exited with an error; OR it went
 * quiet/stalled (`blocked`). A finished turn is GRAY (`idle`/`done`), as is a cleanly-exited agent.
 *
 * `unmerged` — finished, with committed work not yet on main — is GRAY BY DESIGN, not an oversight;
 * it is a landing state rather than an alarm, and it is the one gray status that still outranks the
 * calm tier in engine/agentOrdering (its own band) and in conciergeFeed (P1). See its token below
 * for why it stopped being red on 2026-07-26.
 * Never hardcode these — import AGENT_STATUS. `label` is the human phrase shown on hover.
 *
 * NOTE: color, badge, and notifications are three SEPARATE concerns. Color is here (the sidebar
 * dot + the cross-project red banding, which keys off THIS color tier via windowStatus.isRedStatus).
 * The dock badge + banner notifications key off the NARROWER attention set in engine/attention.ts
 * (waiting/approval/errored only) — `blocked` recolors the dot and surfaces cross-project but
 * deliberately does NOT add to the badge count or fire a banner (it's "needs you eventually", not
 * "answer this now"). Notifications stay user-configurable per status (settingsStore).
 *
 * THE TWO SETS ARE DIFFERENT ON PURPOSE, AND THAT IS A TRAP. Code that means "is this row red?"
 * must call windowStatus.isRedStatus; code that means "is this agent asking me something right
 * now?" must call attention.needsAttention. Reaching for the wrong one is a bug that has actually
 * shipped twice — engine/workerAttention.ts used needsAttention behind a comment reading "only RED
 * workers bubble", so a `blocked` worker never surfaced on its orchestrator's row at all.
 */
const GREEN = C.success; // #34c759 — running, leave it be
const RED = C.sienna; //   #e0533f — needs your action
const GRAY = C.muted; //   #8aa0c4 — not active (legible on navy)
export const AGENT_STATUS = {
  working: { color: GREEN, label: "Working" }, // actively producing output
  idle: { color: GRAY, label: "Done — your turn" }, // finished its turn, nothing left for you
  waiting: { color: RED, label: "Needs you" }, // asked a question (on-screen prompt)
  approval: { color: RED, label: "Approve?" }, // caution/dangerous action pending
  blocked: { color: RED, label: "Blocked" }, // went quiet / stalled — needs you to unstick it
  errored: { color: RED, label: "Errored" }, // process crashed/exited with an error — red so it stands out
  // Done, but committed work isn't on main yet — open/merge the PR. GRAY, deliberately: this is a
  // LANDING state, not an alarm. It was red until 2026-07-26, and on a real fleet that made red
  // meaningless — 27 of 51 agents sat in the committed-but-unlanded band, so the wall of red said
  // "most of your agents have a branch", not "these agents need you". Worse, it was undismissable:
  // the dismissal tier only ever covered waiting|approval|errored, so there was no way to calm it.
  // The row still carries the fact — this label on hover, and the workflow line + ✓ that show
  // exactly how far the work got — and agentOrdering still floats it above the calm tier. What it
  // no longer does is impersonate "answer me now". See engine/redTaxonomySeparation.test.ts.
  unmerged: { color: GRAY, label: "Needs merge" },
  done: { color: GRAY, label: "Done" }, // finished cleanly AND landed — nothing left for you
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
