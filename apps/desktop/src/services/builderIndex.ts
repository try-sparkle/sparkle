// Frontend wrapper over the Rust Builder Index commands (src-tauri/src/builder_index.rs,
// bead sparkle-s3g2.6) — the opt-in reporter that publishes this machine's DAILY TOKEN TOTALS to
// the public tokenmaxxing leaderboard.
//
// The API key deliberately travels ONE WAY. `setBuilderIndexIdentity` hands it to Rust, which
// puts it straight in the keychain; nothing here can read it back — `status.hasApiKey` is a
// boolean, not the key. So the modal can say "a key is stored" without ever holding one, and no
// key can end up in a React state tree, a devtools snapshot, or a log line.
import { invoke } from "@tauri-apps/api/core";

/** Everything the settings surface renders. Mirrors `BuilderIndexStatus` in builder_index.rs. */
export interface BuilderIndexStatus {
  /** `[tools].builder_index`. */
  enabled: boolean;
  username: string;
  /** True when an API key is in the keychain. The key itself is never returned. */
  hasApiKey: boolean;
  /** Whether the one-time consent confirmation has been answered with "publish". */
  consented: boolean;
  /** Per-machine id the leaderboard keys rows on (informational). */
  clientId: string;
  reportDays: number;
  /** Epoch SECONDS of the last successful post. */
  lastReportAt: number | null;
  lastStatus: string | null;
  /** Null when a report would go out; otherwise a short reason why it wouldn't. */
  blockedBy: string | null;
  serverUrl: string;
}

/** How long a LIVE reporter may go without a SUCCESSFUL report before [`builderIndexReportFailing`]
 *  calls it failing — 24 hours, twelve of the reporter's 2-hour cycles.
 *
 *  Deliberately generous, and biased toward a false NEGATIVE. The cost of crying wolf is that the
 *  user learns to ignore the badge, which is the same reasoning `discard_reason` in
 *  builder_index.rs gives for not failing a row SHORTFALL; and the failure this exists to surface
 *  is chronic — the measured one ran every two hours for weeks — not momentary. A day late to
 *  report a permanent breakage is still the first time anyone was told. */
export const BUILDER_INDEX_STALE_AFTER_SECS = 24 * 60 * 60;

/** The literal `record_outcome` is handed on BOTH failure branches in builder_index.rs
 *  (`format!("Last report failed — {msg}.")`). See [`builderIndexReportFailing`] for why this is
 *  only a fast path and never the load-bearing signal. */
const FAILED_STATUS_PREFIX = "Last report failed";

/**
 * Is the reporter LIVE and did its last cycle fail to land? — the state that, until the Tools row,
 * had no surface outside the consent modal nobody opens.
 *
 * WHY `lastReportAt` IS THE LOAD-BEARING SIGNAL, and it is structural rather than textual:
 * `record_outcome` in builder_index.rs is called with `Some(now_secs())` on the ONE success branch
 * and with `None` on both failure branches, so `last_report_at` advances if and only if a report
 * actually landed. `last_status` is rewritten either way. A live reporter whose last success is
 * many cycles old is therefore a reporter whose cycles are running and being discarded — a
 * conclusion reached without reading a word of the message. What would break it: the Rust side
 * starting to stamp `last_report_at` on a cycle that did not land (i.e. passing `Some(..)` on a
 * failure path), which would make every failure look fresh.
 *
 * The `lastStatus` prefix is a FAST PATH only, so the badge appears on the first failed cycle
 * instead of a day later. It is the fragile half — a Rust string literal at two call sites, and a
 * reword there switches it off with nothing going red. That is tolerable precisely because it
 * degrades to the timestamp rule above rather than to silence.
 *
 * THREE THINGS THAT ARE NOT FAILURES:
 *   • `blockedBy` set — off, no consent, no username, no API key. No report would go out at all,
 *     which is the normal state of an install that never opted in. Checked FIRST and winning
 *     outright (even over a stored failure message from before the toggle went off) because
 *     rendering that as an alarm is the one thing this must not do.
 *   • `lastStatus === null` — no cycle has recorded an outcome yet, so there is nothing to call
 *     failed. Reporting starts five minutes after launch.
 *   • An unreadable status — the caller's problem, not the reporter's; see ToolsPane.
 *
 * KNOWN FALSE POSITIVE, and it is a real gap rather than a rounding error: nothing exposed here
 * says when a cycle last RAN, only when one last SUCCEEDED. So a reporter that is live but has not
 * yet had the chance to report — the app was closed for two days, or the toggle was off for a week
 * and was just switched back on — reads as failing until its next cycle lands. It self-clears
 * within about five minutes of launch. Closing it needs a `last_attempt_at` on the Rust side; no
 * existing field carries it, and this deliberately does not add one.
 */
export function builderIndexReportFailing(status: BuilderIndexStatus, nowSecs: number): boolean {
  if (status.blockedBy) return false;
  if (!status.lastStatus) return false;
  if (status.lastStatus.startsWith(FAILED_STATUS_PREFIX)) return true;
  // `== null` covers the serde shape: a Rust `Option` with no `skip_serializing_if` always emits
  // the key, so "never succeeded" arrives as an explicit `null`, not as an absent field.
  if (status.lastReportAt == null) return true;
  return nowSecs - status.lastReportAt > BUILDER_INDEX_STALE_AFTER_SECS;
}

/** A one-shot report's result. `skipped` is the normal answer for an un-opted-in install. */
export type ReportOutcome =
  | {
      status: "posted";
      rows: number;
      days: number;
      /** The transcript scan hit its file cap, so these numbers UNDERSTATE reality. Surfaced on
       *  the outcome (not only in `lastStatus`) because the modal shows the fresh message. */
      truncated: boolean;
      /** The server's own warning on a report that DID land — an outdated client, an agentsview
       *  update. Same reason `truncated` is here: the modal shows the fresh outcome and hides
       *  `lastStatus`, so a warning that lived only in the stored status is never read.
       *
       *  `| null`, NOT optional-only: this is a Rust `Option<String>` with no
       *  `skip_serializing_if`, so serde ALWAYS emits the key and sends `null` for `None`. A
       *  `notice?: string` would describe a shape the wire cannot produce. */
      notice?: string | null;
    }
  | { status: "skipped"; reason: string };

/** Current reporter state (toggle, credentials, consent, last cycle). */
export function builderIndexStatus(): Promise<BuilderIndexStatus> {
  return invoke("builder_index_status", {});
}

/**
 * Store the username + API key and (when `consent`) record consent, in ONE call so the two can't
 * get out of step. An empty `apiKey` keeps the key already in the keychain, so the modal can be
 * re-opened to change just the username without re-typing a secret.
 */
export function setBuilderIndexIdentity(
  username: string,
  apiKey: string,
  consent: boolean,
): Promise<void> {
  return invoke("builder_index_set_identity", { username, apiKey, consent });
}

/** Forget consent, username, the pinned client id, and the stored API key. */
export function forgetBuilderIndex(): Promise<void> {
  return invoke("builder_index_forget", {});
}

/** Report immediately instead of waiting for the next background cycle. */
export function builderIndexReportNow(): Promise<ReportOutcome> {
  return invoke("builder_index_report_now", {});
}

/** The public leaderboard, for the row's "Learn more". Not the API host — see builder_index.rs. */
export const BUILDER_INDEX_URL = "https://www.watchmepivot.com/builder-index";
