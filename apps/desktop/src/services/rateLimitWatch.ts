// Best-effort (Phase 1) rate-limit detection on raw PTY output, for multi Claude Max failover
// (design spec docs/superpowers/specs/2026-06-26-multi-max-account-design.md, §"failover-on-rate-
// limit"). When a running `claude` hits its account's usage/rate limit, the terminal prints a
// message; detecting it lets us flag THAT account exhausted (markExhausted) so pickAccount routes
// the next job to an account with headroom. The hard rate-limit is ground truth — it corrects a
// bad usage estimate.
//
// This module is PURE and side-effect-free so it unit-tests without a terminal, and so the caller
// (Terminal.tsx) can wrap it such that a detection failure NEVER breaks terminal rendering.
//
// Phase-1 caveats (intentional): matching is conservative text-scraping, not structured; the reset
// time is parsed only from a simple "reset … at H[:MM] am/pm" phrasing, otherwise we back off a few
// hours. Phase 2 replaces this with robust detection + learned ceilings.

/** Default backoff when the message gives no parseable reset time: 4 hours out (conservative — long
 *  enough to clear most short windows, short enough that a recovered account returns to rotation). */
export const DEFAULT_BACKOFF_MS = 4 * 60 * 60 * 1000;

/** Conservative match for Claude's usage/rate-limit phrasing — the ONLY trigger for a failover.
 *  Deliberately narrow (no bare "reset … at" branch): a coding agent legitimately prints things
 *  like "the cache resets at 9am" or "git reset … at HEAD", and a false match would bench a healthy
 *  account for hours. Phase 1 accepts the occasional miss over a false failover. The reset-time
 *  parse below runs ONLY after this confirms a real limit message. */
const RATE_LIMIT_RE = /\b(rate limit|usage limit|limit reached|too many requests)\b/i;

/** Parse a reset clock time out of "...reset... at 3pm" / "resets at 11:30 PM" into an epoch-ms
 *  instant at or after `now` (rolls to tomorrow if that time already passed today). Returns null
 *  when no parseable time is present — the caller then uses {@link DEFAULT_BACKOFF_MS}.
 *
 *  A bare hour ≤ 12 with NO am/pm marker is treated as AMBIGUOUS and rejected (→ backoff): guessing
 *  AM for "resets at 3" can roll to tomorrow and bench the account ~15h instead of the intended few,
 *  and a bare "12" is midnight-vs-noon ambiguous. Only an explicit meridiem or an unambiguous 24h
 *  hour (13–23) is accepted. */
function parseResetEpoch(text: string, now: number): number | null {
  const m = text.match(/reset[^.\n]*?\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m || m[1] === undefined) return null;
  let hour = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3]?.toLowerCase();
  if (!ap && hour <= 12) return null; // ambiguous AM/PM (incl. midnight-vs-noon 12) → conservative backoff
  if (ap === "pm" && hour < 12) hour += 12;
  if (ap === "am" && hour === 12) hour = 0;
  if (hour > 23 || min > 59) return null;
  const d = new Date(now);
  d.setHours(hour, min, 0, 0);
  let epoch = d.getTime();
  if (epoch <= now) epoch += 24 * 60 * 60 * 1000; // the time already passed today → next occurrence
  return epoch;
}

/** Detect a rate/usage-limit message in `text`. Returns the epoch-ms instant the limit is expected
 *  to reset (parsed if present, else `now + DEFAULT_BACKOFF_MS`), or null if no limit is detected. */
export function detectRateLimitReset(text: string, now: number): number | null {
  if (!RATE_LIMIT_RE.test(text)) return null;
  return parseResetEpoch(text, now) ?? now + DEFAULT_BACKOFF_MS;
}
