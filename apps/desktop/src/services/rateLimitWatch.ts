// Rate-limit detection for multi Claude Max failover (design spec
// docs/superpowers/specs/2026-06-26-multi-max-account-design.md, and the Phase-2 rewrite in
// docs/superpowers/specs/2026-07-26-rate-limit-truth-design.md).
//
// PHASE 2 REWRITE — why this module no longer scrapes terminal text.
//
// Phase 1 matched a regex (`rate limit|usage limit|limit reached|too many requests`) against a
// rolling 4KB window of raw PTY output. That is unsound in principle and was actively harmful in
// practice: a coding agent's own prose about rate limiting is textually indistinguishable from a
// real limit message, so *discussing* rate limits benched a healthy account for hours. Measured on
// a real machine (2026-07-26): every exhaustion flag present was either a false positive from the
// agent's own output, or a real limit assigned the WRONG reset time by the blind 4h backoff. The
// matcher also missed the message Claude Code actually prints ("You've hit your session limit"),
// so it never once fired correctly on a genuine limit.
//
// The replacement reads GROUND TRUTH. Claude Code records a real limit in its own transcript as a
// structured envelope:
//
//     { "type": "assistant", "error": "rate_limit", "isApiErrorMessage": true,
//       "apiErrorStatus": 429, "timestamp": "2026-07-24T23:40:26.360Z",
//       "message": { "content": [{ "type": "text",
//                    "text": "You've hit your session limit · resets 8pm (America/Los_Angeles)" }] } }
//
// `error === "rate_limit"` is unambiguous — prose can never forge it. The Rust side scans each
// account's own `<configDir>/projects/**/*.jsonl` (so an event self-attributes to the account that
// produced it) and hands the raw text + event instant to the PURE parser below.
//
// Timezone handling lives HERE rather than in Rust on purpose: the reset string carries an IANA
// zone (`America/Bogota`, `America/Los_Angeles` — both observed on one machine), and JS resolves
// those exactly via `Intl.DateTimeFormat` with zero dependencies and correct DST. src-tauri
// deliberately carries no date/time crate (it hand-rolls `days_from_civil`), so doing it in Rust
// would mean vendoring the whole tz database for one string.

/** A structured rate-limit event read out of an account's transcript by the Rust side. */
export interface LimitEvent {
  /** The account this event belongs to (derived from which config dir's transcripts held it). */
  accountId: string;
  /** Epoch MS of the event itself (the transcript's UTC `timestamp`). */
  at: number;
  /** The synthetic message text, e.g. `You've hit your session limit · resets 2:20pm (America/Bogota)`. */
  text: string;
}

/** Claude Max session windows are 5 hours, so a *session* limit always resets within 5h of the
 *  event. Used as the fallback bound when the reset time can't be parsed — strictly tighter and
 *  better-founded than Phase 1's blind 4h guess, which was neither. */
export const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;

/** Upper bound on any parsed reset. A weekly-cap message can legitimately name a time up to a day
 *  out; anything beyond that means we misparsed, and benching an account for longer than this on a
 *  bad parse is worse than re-hitting the limit once. */
const MAX_RESET_HORIZON_MS = 24 * 60 * 60 * 1000;

/** Milliseconds to ADD to a UTC instant to get wall-clock time in `tz`. Returns null for a zone
 *  `Intl` doesn't recognize (invalid name, or a runtime without full ICU data). */
function tzOffsetMs(ms: number, tz: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(ms));
    const p: Record<string, string> = {};
    for (const { type, value } of parts) p[type] = value;
    if (!p.year || !p.month || !p.day || !p.hour || !p.minute || !p.second) return null;
    // `hour12:false` yields "24" for midnight in some ICU versions — normalize to 0.
    const hour = p.hour === "24" ? 0 : Number(p.hour);
    const asIfUtc = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      hour,
      Number(p.minute),
      Number(p.second),
    );
    return Number.isFinite(asIfUtc) ? asIfUtc - ms : null;
  } catch {
    return null; // unknown time zone
  }
}

/** The UTC instant at which wall-clock time in `tz` is `y-mo-d h:mi`. Two-pass so a target that
 *  straddles a DST transition resolves to the offset in effect AT the target, not at the guess. */
function zonedWallTimeToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  tz: string,
): number | null {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const off1 = tzOffsetMs(guess, tz);
  if (off1 == null) return null;
  const off2 = tzOffsetMs(guess - off1, tz);
  if (off2 == null) return null;
  return guess - off2;
}

/** Wall-clock Y/M/D in `tz` at instant `ms`. */
function zonedDate(ms: number, tz: string): { y: number; mo: number; d: number } | null {
  const off = tzOffsetMs(ms, tz);
  if (off == null) return null;
  const shifted = new Date(ms + off);
  return {
    y: shifted.getUTCFullYear(),
    mo: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
  };
}

/** Pulls `(hour, minute, meridiem, tz)` out of a reset phrase.
 *
 *  Matches the real forms Claude Code emits — `resets 8pm (America/Los_Angeles)`,
 *  `resets 2:20pm (America/Bogota)` — and tolerates the older `will reset at 3pm`. Unlike Phase 1
 *  this does NOT require the word "at" (the live message has no "at", which is why the old parser
 *  fell through to a blind backoff on every real event). */
const RESET_RE =
  /\breset(?:s|ting)?\b(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(\s*([A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)\s*\))?/i;

/** Compute the epoch-MS instant a limit is expected to reset, given the message `text` and the
 *  instant `at` the event occurred. PURE.
 *
 *  Resolution order:
 *    1. A parseable clock time WITH an IANA zone → the next occurrence of that wall time in that
 *       zone strictly after `at`. Exact, DST-correct.
 *    2. Anything unparseable (no time, unknown zone, ambiguous bare hour, absurd result) →
 *       `at + SESSION_WINDOW_MS`.
 *
 *  A bare hour with NO meridiem and NO zone stays ambiguous and falls back — guessing AM for
 *  "resets at 3" can bench an account ~15h instead of a few. */
export function parseResetInstant(text: string, at: number): number {
  const fallback = at + SESSION_WINDOW_MS;
  const m = RESET_RE.exec(text);
  if (!m?.[1]) return fallback;

  let hour = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase();
  const tz = m[4];

  if (!Number.isFinite(hour) || !Number.isFinite(min) || min > 59) return fallback;
  if (ap === "pm" && hour < 12) hour += 12;
  if (ap === "am" && hour === 12) hour = 0;
  // No meridiem: only an unambiguous 24h hour (13–23) is usable; 0–12 could be either half.
  if (!ap && hour <= 12) return fallback;
  if (hour > 23) return fallback;

  if (!tz) return fallback; // a wall time with no zone can't be placed on the timeline
  const today = zonedDate(at, tz);
  if (!today) return fallback;

  let reset = zonedWallTimeToUtc(today.y, today.mo, today.d, hour, min, tz);
  if (reset == null) return fallback;
  if (reset <= at) {
    // Already passed today in that zone → the next occurrence is tomorrow. Recompute from the
    // NEXT calendar day rather than adding 24h, so a DST shift doesn't skew the wall time.
    const next = zonedDate(at + 24 * 60 * 60 * 1000, tz);
    if (!next) return fallback;
    reset = zonedWallTimeToUtc(next.y, next.mo, next.d, hour, min, tz);
    if (reset == null || reset <= at) return fallback;
  }
  if (reset - at > MAX_RESET_HORIZON_MS) return fallback;
  return reset;
}

/** Convenience: resolve a {@link LimitEvent} straight to the instant its account frees up. */
export function resetInstantFor(ev: LimitEvent): number {
  return parseResetInstant(ev.text, ev.at);
}
