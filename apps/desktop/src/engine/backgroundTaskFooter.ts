// backgroundTaskFooter — read Claude Code's own "N background task(s) live" footer.
//
// WHY THIS EXISTS (bead sparkle-262p7). `engine/inMotion` keeps a parent agent GREEN while a
// `kind:"worker"` child TAB is working, but it explicitly does NOT cover a lone agent whose motion
// is carried by background work that spawned no tab — a `run_in_background` Bash, a backgrounded
// Task subagent, a backgrounded MCP call. inMotion.ts:17-24 names that gap and the reason the hook
// stream cannot close it: Claude fires `PostToolUse` when a call merely moves to the BACKGROUND, so
// the log shows Pre→Post→Stop for a backgrounded task exactly as it does for a finished one. "Is a
// tool still outstanding?" is therefore not derivable from hooks. The "Improve Sparkle" agent hits
// this every time — it delegates through Task subagents and background agents, holds ZERO worker
// tabs, and so settles to `idle` (GRAY) the instant its turn closes while its delegates keep running.
//
// The one signal that IS reliable is Claude Code's own footer. While background work outlives the
// turn it draws a persistent line the app already has on the rendered screen:
//
//     1 background task live [ctrl+b to manage]
//     3 background tasks live [ctrl+b to manage]
//
// (Verbatim template ` background task(s) live [` confirmed in the shipped claude 2.1.231 binary.)
// This module turns that line into a COUNT, which `services/backgroundTaskRegistry` parks per agent
// and `useAttentionNotifications.composeRollup` reads to keep an idle-but-delegating agent green.
//
// ── DELIBERATELY A SEPARATE SIGNAL, NOT A `WORKING_PATTERNS` ENTRY (inMotion.ts:20-24) ────────────
// Folding this marker into `statusEngine`'s spinner detection would be the WRONG way to add it: the
// status router's watchdog reads "hooks say idle + screen says working" as proof the hook stream
// died, and a legitimate background task produces exactly that contradiction — so a spinner-path
// entry would fire the watchdog on healthy sessions. This is its own channel that feeds `isInMotion`,
// never a status.
//
// Pure, like its siblings (screenClassifier, claudeCodeScreen): the answer is testable without a PTY
// or an xterm.
//
// RETUNE POINT — this tracks a Claude Code TUI detail that drifts, exactly like
// statusEngine's WORKING_PATTERNS and screenClassifier's footer matchers. Add a fixture in TODAY's
// shape whenever the wording moves, or the signal silently goes dead (a green suite that says
// nothing — the failure mode WORKING_PATTERNS' own header records from 2026-07-28).

/**
 * Claude Code's live-background-task footer, with the count captured.
 *
 * `tasks?` covers both the singular ("1 background task live") and plural ("3 background tasks
 * live") forms — Claude pluralizes `task(s)` at render. `live` is required (and is what keeps this
 * off the FOREGROUND "Running 1 shell command…" status line, which carries no "live" and is already
 * the spinner's job). Unanchored within the line so a leading glyph or indent does not defeat it;
 * the digits are bounded (`\d{1,4}`) so a pathological run cannot backtrack — the same discipline
 * WORKING_PATTERNS' header spells out.
 */
const BACKGROUND_TASK_FOOTER = /(?<!\d)(\d{1,4})\s+background\s+tasks?\s+live\b/i;

/**
 * How many background tasks Claude reports as LIVE on this rendered screen, or `null` when the
 * footer is absent.
 *
 * Feed it the VIEWPORT snapshot (`snapshotScreen` / `getScreen`), never streamed scrollback: the
 * footer is bottom-anchored chrome, and scrollback that merely QUOTES the phrase (a transcript being
 * paged) has no bottom to anchor against. The status engine already reads exactly this viewport on
 * settle, which is the only surface this is asked of.
 *
 * `0` is normalized to `null` — a footer that says "0 background tasks live" is not live work, and
 * treating it as absent keeps every consumer on one definition of "in motion". A count is returned
 * only when it is strictly positive.
 */
export function parseBackgroundTaskCount(screen: string): number | null {
  if (!screen) return null;
  // Scan per line and take the LAST match: the footer is at the bottom, and reading the last
  // occurrence means a stale earlier line (were one ever present) never wins over the live footer.
  let count: number | null = null;
  for (const line of screen.split(/[\r\n]/)) {
    const m = BACKGROUND_TASK_FOOTER.exec(line);
    if (!m?.[1]) continue;
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) count = n;
  }
  return count;
}

/** Does this rendered screen show at least one live background task? */
export function hasLiveBackgroundTasks(screen: string): boolean {
  return parseBackgroundTaskCount(screen) !== null;
}
