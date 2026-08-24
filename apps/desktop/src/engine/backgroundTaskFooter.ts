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

import { chromeBarTailBelow, liveBackgroundSubagentCount } from "./claudeCodeScreen";
import { nothingUnrecognizedBelowFooter } from "./screenClassifier";

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
  const lines = screen.split(/[\r\n]/);
  let at = -1;
  let count: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = BACKGROUND_TASK_FOOTER.exec(lines[i] ?? "");
    if (!m?.[1]) continue;
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) {
      count = n;
      at = i;
    }
  }
  if (at < 0) return null;
  // ⚠️ POSITION-CHECKED, exactly like the subagent roster — and this arm was added because the
  // commit that introduced the Rust twin made the old "the wording is not quotable" argument false
  // IN THE SAME COMMIT (roborev 68247, High). `apps/desktop/shared/delegated-work.fixture.json` and
  // this file's own header now both carry `3 background tasks live [ctrl+b to manage]` verbatim, so
  // an agent that `cat`s either one ends its turn with the phrase still on the viewport.
  //
  // On a MOUNTED pane that is a transient wrong answer a live writer corrects. On the mount-
  // independent path it is a LATCH: the screen is static, nothing scrolls the line off, and the row
  // stays green forever for an agent doing nothing — the precise failure the roster's walk exists
  // to prevent, arriving through the surface that had been exempted from it.
  //
  // Claude's real footer TERMINATES the grid; a quoted one has prose under it. Both readers apply
  // this rule and the shared fixture pins them together, so they cannot drift apart again.
  //
  // ── TWO SHAPES OF "TERMINATES", BECAUSE THE LINE-ANCHORED WALK ALONE IS A NARROW-PANE BUG ──────
  // `nothingUnrecognizedBelowFooter` is strictly line-anchored, and `claudeCodeScreen` records that
  // on a narrow grid Claude's status bar WRAPS: `  ⏸ manual mode on · ? for shortcuts` becomes three
  // rows and only the first carries a glyph the walk recognises (roborev 64464). Requiring the walk
  // alone therefore answered `null` on a REAL narrow pane with subagents running — which fires
  // `forgetBackgroundTasks` and takes the row GRAY, reintroducing sparkle-262p7's bug through the
  // fix for the quote-latch (roborev 68275). `chromeBarTailBelow` rejoins those rows and requires
  // the JOIN to open with one of Claude's own bar phrases, so it accepts the wrapped bar while
  // still rejecting a document, whose tail opens with its own prose.
  if (!nothingUnrecognizedBelowFooter(lines, at) && !chromeBarTailBelow(lines, at)) return null;
  return count;
}

/** Does this rendered screen show at least one live background task? */
export function hasLiveBackgroundTasks(screen: string): boolean {
  return parseBackgroundTaskCount(screen) !== null;
}

/**
 * How much delegated work this rendered screen shows as live — from EITHER of Claude Code's two
 * surfaces — or `null` when it shows none.
 *
 * ══ WHY TWO SURFACES, AND WHY THE FOOTER ALONE WAS NOT ENOUGH ═══════════════════════════════════
 * The founder named two states that must both read GREEN:
 *   1. the agent is working AND has subagents running;
 *   2. the agent has delegated and is BLOCKED WAITING on them.
 * He called (2) out specifically — "sometimes I've noticed that it's waiting on the sub agents to
 * finish, and it should again be green when that's happening" — and it is the one that was missed,
 * because from the parent's own PTY it looks exactly like doing nothing: no spinner, no output, no
 * tool calls, for minutes.
 *
 * The `N background task(s) live` footer covers work Claude has explicitly BACKGROUNDED. It does not
 * cover the roster Claude draws while it is running subagents — `◯ <kind>  <label>  <elapsed>` — and
 * that roster REPLACES the composer box, so a screen showing it has no other sign of life on it at
 * all. `engine/claudeCodeScreen` has parsed those rows since bead sparkle-tbsvf, but only to answer
 * "is this a Claude Code screen"; the rows, kinds and elapsed clocks were discarded. This is where
 * that evidence finally reaches a status.
 *
 * THE MAX, NOT THE SUM. The two surfaces can describe the SAME work — a backgrounded Task subagent
 * is both a background task and a roster row — so adding them would double-count. Nothing downstream
 * reads the magnitude (`hasLiveBackgroundTasksForAgent` asks only `> 0`), so the max is the honest
 * answer to "at least this much is live" without inventing delegates that do not exist.
 *
 * `null` when neither surface is present, mirroring {@link parseBackgroundTaskCount} — an ABSENCE,
 * never a zero-valued entry, so every reader keeps one definition of "in motion".
 */
export function parseDelegatedWorkCount(screen: string): number | null {
  const footer = parseBackgroundTaskCount(screen);
  const roster = liveBackgroundSubagentCount(screen);
  if (footer === null && roster === null) return null;
  return Math.max(footer ?? 0, roster ?? 0) || null;
}
