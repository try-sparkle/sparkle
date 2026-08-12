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
