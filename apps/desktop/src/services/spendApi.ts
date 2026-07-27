// Thin wrapper over the Rust `spend_report` command (src-tauri/src/spend.rs). Everything it
// returns is derived from Claude Code's own session transcripts on THIS machine — the command
// makes no network calls, and neither does this module. The shapes mirror the Rust structs
// (serde camelCase); `Bucket` is flattened into each row there, so the token/cost fields sit
// directly on `DayTotal`/`ModelTotal`/… rather than under a nested key.
import { invoke } from "@tauri-apps/api/core";

/** Token counts for one rollup bucket. `total` is computed in Rust so every consumer agrees. */
export interface Tokens {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  total: number;
}

/** The token + cost payload shared by every rollup row (Rust `Bucket`, serde-flattened). */
export interface Bucket {
  tokens: Tokens;
  /** Estimated USD at list rates, covering only the records we could price. */
  estimatedCostUsd: number;
  /** Tokens that belonged to a model with no known price — cost for these is unknown, not zero. */
  unpricedTokens: number;
  /** Billed assistant turns in this bucket. */
  messages: number;
}

/** One calendar day. The report always carries a contiguous run, including zero-usage days. */
export interface DayTotal extends Bucket {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
}

export interface ModelTotal extends Bucket {
  model: string;
  /** False when we have no published rate — render "—" for cost, never "$0.00". */
  priced: boolean;
}

export interface ProjectTotal extends Bucket {
  project: string;
  sessions: number;
  lastActive: string;
}

export interface SessionTotal extends Bucket {
  sessionId: string;
  project: string;
  lastActive: string;
}

export interface SpendReport {
  windowDays: number;
  /** Epoch SECONDS the scan ran. */
  generatedAt: number;
  days: DayTotal[];
  models: ModelTotal[];
  projects: ProjectTotal[];
  sessions: SessionTotal[];
  totals: Bucket;
  /** Models seen with no published rate, so an unpriced total is explainable. */
  unknownModels: string[];
  filesScanned: number;
  /** True when the file cap cut the scan short — a partial scan must not read as complete. */
  truncated: boolean;
  /** Transcript roots that were read. */
  roots: string[];
  /** The estimates caveat, rendered verbatim. Owned by Rust so it can't drift from the math. */
  pricingNote: string;
  /** The timezone every `date`/`lastActive` is bucketed in (always "UTC"). Carried so the pane can
   *  SAY so: for a user west of UTC an evening session lands on "tomorrow", so today's column reads
   *  as zero until mid-morning. Stating it beats surprising them. */
  timezone: string;
}

/**
 * Scan the local transcripts and aggregate the trailing `windowDays` (Rust default: 30, clamped
 * to 1..=365). Repeat calls are cheap — Rust memoizes parsed records per file identity — but this
 * is still filesystem work, so call it on pane open / explicit refresh rather than on a timer.
 */
export function fetchSpendReport(windowDays?: number): Promise<SpendReport> {
  return invoke<SpendReport>("spend_report", { windowDays });
}
