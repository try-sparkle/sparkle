// Frontend wrapper over the Rust straude commands (src-tauri/src/straude.rs, bead sparkle-862tw9)
// — the opt-in reporter that publishes this machine's DAILY TOKEN TOTALS to straude.com.
//
// straude COMPETES with the Builder Index; it is not listed on it. The two are independent in
// every way (own flag, own sign-in, own state file), so nothing here may read or write anything in
// builderIndex.ts. A user can run either, both, or neither.
//
// The sign-in token travels ONE WAY. Rust puts it straight in the keychain and nothing here can
// read it back — `status.hasToken` is a boolean, never the token. So the modal can say "you are
// signed in" without ever holding a credential that could land in a React state tree, a devtools
// snapshot, or a log line.
import { invoke } from "@tauri-apps/api/core";

/** Everything the settings surface renders. Mirrors `StraudeStatus` in straude.rs. */
export interface StraudeStatus {
  /** `[tools].straude`. */
  enabled: boolean;
  username: string;
  /** True when a sign-in token is in the keychain. The token itself is never returned. */
  hasToken: boolean;
  /** Whether the one-time consent confirmation has been answered with "publish". */
  consented: boolean;
  /** Per-machine id straude keys rows on (informational). */
  deviceId: string;
  /** The label sent with each report. Defaults to "Sparkle" — never the machine's hostname. */
  deviceName: string;
  reportDays: number;
  /** Epoch SECONDS of the last successful report. */
  lastReportAt: number | null;
  lastStatus: string | null;
  /** Null when a report would go out; otherwise a short reason why it wouldn't, in prose. */
  blockedBy: string | null;
  /** The same answer as a stable code — see `SkipReason::code` in straude.rs. Read THIS, never
   *  `blockedBy`'s wording, when deciding how to treat a blocked reporter. */
  blockedCode: string | null;
  /** Days until the sign-in lapses, when that is close enough to be worth showing.
   *
   *  `0` means it expires WITHIN THE DAY and is still usable. An already-lapsed sign-in reports
   *  `null` here and `expired: true` — Rust fills this only from `TokenState::ExpiringSoon`. Do not
   *  test `expiresInDays === 0` for a lapsed sign-in: that check can never fire, and it is the
   *  exact ambiguity the separate `expired` field exists to remove.
   *
   *  `| null`, not optional-only: this is a Rust `Option<u32>` and serde emits the key with a
   *  `null` for `None`, so a `expiresInDays?: number` would describe a shape the wire cannot
   *  produce and the parser would reject every payload. */
  expiresInDays: number | null;
  /** The sign-in has LAPSED. Its own field because `expiresInDays: 0` could not tell "already
   *  dead" from "expires within the day", and those need different words from the UI. */
  expired: boolean;
  serverUrl: string;
}

/** How long a LIVE reporter may go without a SUCCESSFUL report before [`straudeReportFailing`]
 *  calls it failing — 24 hours, twelve of the reporter's 2-hour cycles.
 *
 *  Same generosity, and the same bias toward a false NEGATIVE, as the Builder Index badge: the
 *  cost of crying wolf is that the user learns to ignore it, and the failure worth surfacing is
 *  chronic rather than momentary. */
export const STRAUDE_STALE_AFTER_SECS = 24 * 60 * 60;

/** The literal prefix `record_outcome` is handed on the failure branches in straude.rs. A fast
 *  path only — see [`straudeReportFailing`]. */
const FAILED_STATUS_PREFIX = "Last report failed";

/** The blocked reasons that are the NORMAL state of an install, and so must never raise an alarm.
 *
 *  Deliberately an allow-list of codes, not `blockedBy != null`. straude's `blocked_by` is NOT the
 *  same shape as the Builder Index's: it runs the full gate, so it also carries `bad_token`,
 *  `token_expired` and `rate_limited` — which are exactly the states the badge exists for. Treating
 *  any non-null value as benign (which is what copying the sibling's predicate did) made the row go
 *  silent for a broken sign-in and for a rate-limited account. The rate-limit case is the worst: a
 *  429 can set a backoff of up to six hours while the loop cycles every two, so a chronically
 *  limited account is in backoff nearly all the time.
 *
 *  `cooling_down` is benign because it means a report just went out.
 *
 *  `no_token` is NOT here, and the reasoning is the same as for `bad_token`. It looks like the
 *  normal state of an install that never signed in, but it cannot be: `consent_gate` reports the
 *  toggle and consent FIRST (straude.rs), so `no_token` is only reachable once the user is both
 *  enabled and consented — and `ToolsPane` only evaluates this predicate when the toggle is on.
 *  What actually reaches here is an opted-in install whose keychain entry is gone or unreadable
 *  (`read_token` folds every keychain error into `NoToken` — deleted credential, migrated machine,
 *  locked or denied keychain). Reporting is permanently dead and only the user can fix it. */
const BENIGN_BLOCKED_CODES = new Set(["disabled", "no_consent", "cooling_down"]);

/**
 * Is the reporter LIVE and did its last cycle fail to land?
 *
 * `lastReportAt` is the LOAD-BEARING signal and it is structural rather than textual: straude.rs
 * calls `record_outcome` with `Some(now)` only where every submitted day landed, and with `None`
 * on every failure path, so the timestamp advances if and only if a report actually landed.
 * `lastStatus` is rewritten either way. The prefix check is a fast path so the badge appears on
 * the first failed cycle rather than a day later; if that Rust string is ever reworded this
 * degrades to the timestamp rule rather than to silence.
 *
 * NOT failures, and the order matters:
 *   • `blockedBy` set — off, no consent, no sign-in. No report would go out at all, which is the
 *     normal state of an install that never opted in. Checked FIRST and winning outright, because
 *     rendering that as an alarm is the one thing this must not do.
 *   • `lastStatus === null` — no cycle has recorded an outcome yet. Reporting starts five minutes
 *     after launch.
 *
 * A RATE-LIMITED cycle is deliberately not a failure either. straude.rs records the
 * `SkipReason::RateLimited` text rather than the failure prefix, and leaves `lastReportAt` alone —
 * so a long backoff eventually trips the staleness rule, which is correct: reporting really has
 * stopped, and the user should be told.
 */
export function straudeReportFailing(status: StraudeStatus, nowSecs: number): boolean {
  // A blocked reporter is exempt only when the reason is BENIGN. An unrecognized code is NOT
  // treated as benign — a new gate reason should surface rather than silently mute the badge.
  if (status.blockedCode && BENIGN_BLOCKED_CODES.has(status.blockedCode)) return false;
  // A lapsed, broken or vanished sign-in is a failure the moment we know it, without waiting out
  // staleness: only the user can fix it, and nothing else will tell them.
  if (
    status.blockedCode === "bad_token" ||
    status.blockedCode === "token_expired" ||
    status.blockedCode === "no_token"
  )
    return true;
  if (!status.lastStatus) return false;
  if (status.lastStatus.startsWith(FAILED_STATUS_PREFIX)) return true;
  // `== null` covers the serde shape: a Rust `Option` with no `skip_serializing_if` always emits
  // the key, so "never succeeded" arrives as an explicit `null`, not as an absent field.
  if (status.lastReportAt == null) return true;
  return nowSecs - status.lastReportAt > STRAUDE_STALE_AFTER_SECS;
}

/** Should the modal nag about the sign-in running out? */
export function straudeSignInExpiring(status: StraudeStatus): boolean {
  return status.expired || status.expiresInDays != null;
}

/** What the user must do to finish signing in. Mirrors `LoginChallenge` in straude.rs. */
export interface LoginChallenge {
  /** Shown so the user can confirm they are approving THIS machine rather than someone else's
   *  request that happens to be open in their browser. */
  code: string;
  verifyUrl: string;
}

/** Current reporter state (toggle, sign-in, consent, last cycle). */
export function straudeStatus(): Promise<StraudeStatus> {
  return invoke("straude_status", {});
}

/** Begin a browser sign-in. Returns the code + URL for the UI to open. */
export function straudeLoginBegin(): Promise<LoginChallenge> {
  return invoke("straude_login_begin", {});
}

/** Ask whether the user has approved yet. `null` means "still waiting", NOT an error — the UI
 *  keeps polling until it gets a username back or the user gives up. */
export function straudeLoginPoll(): Promise<string | null> {
  return invoke("straude_login_poll", {});
}

/** Record consent and the device label, in ONE call so the two cannot get out of step. */
export function straudeConsent(deviceName: string, consent: boolean): Promise<void> {
  return invoke("straude_consent", { deviceName, consent });
}

/** Forget consent, username, the pinned device id, and the stored sign-in token. */
export function forgetStraude(): Promise<void> {
  return invoke("straude_forget", {});
}

/** Report immediately instead of waiting for the next background cycle. Rejects with the skip
 *  reason when a report would not go out (including the 60s manual cooldown). */
export function straudeReportNow(): Promise<string> {
  return invoke("straude_report_now", {});
}

/** The public site, for the row's "Learn more". */
export const STRAUDE_URL = "https://straude.com";
