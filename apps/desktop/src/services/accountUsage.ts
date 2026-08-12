// Frontend service for REAL, live per-account Claude subscription usage — the actual server-side
// utilization Anthropic reports for an account, as opposed to the LOCAL transcript token-tally in
// `accountStore.ts` (`getUsage`). This is a thin JS surface over the Rust `account_usage_live`
// Tauri command (see src-tauri/src/account_usage.rs), which reads the account's OAuth token and
// calls Anthropic's OAuth usage endpoint. Secrets never cross this boundary — only the parsed
// windows do.
//
// Testability: the `invoke` call is mocked at the module boundary in tests (same pattern as
// accountStore.ts). The AccountsScreen consumes this through an injectable `getUsageLive` dep so
// the component can be driven without a Tauri bridge.
import { invoke } from "@tauri-apps/api/core";

/** Live usage for one account, mirroring the Rust `AccountUsageLive` (camelCase serialized).
 *
 *  EVERY field is nullable because the upstream Anthropic payload can send any window as `null` (or
 *  omit it): a Rust `Option<T>` crosses the wire as `null`, so these are `T | null`, never
 *  `T | undefined` (see AGENTS.md — the serde/TS null-vs-absent seam). A window Anthropic didn't
 *  report reads `null` here, and the UI shows "—" rather than a fabricated 0%. */
export interface AccountUsageLive {
  /** 5-hour session window utilization percent (0–100), or null when the window is absent. */
  fiveHourPercent: number | null;
  /** ISO-8601 instant the 5-hour window resets, or null. */
  fiveHourResetsAt: string | null;
  /** 7-day window utilization percent (0–100), or null. */
  sevenDayPercent: number | null;
  /** ISO-8601 instant the 7-day window resets, or null. */
  sevenDayResetsAt: string | null;
  /** The raw `limits` array passed through for richer surfaces (per-model scoped windows etc.). */
  limits: LiveLimit[];
}

/** One entry of the upstream `limits` array. Every field nullable, for the same reason as above. */
export interface LiveLimit {
  kind: string | null;
  group: string | null;
  percent: number | null;
  severity: string | null;
  resetsAt: string | null;
  isActive: boolean | null;
}

/** Fetch REAL live usage for the account whose config dir is `configDir`.
 *
 *  Rejects (the Rust command returns `Err`) on no token, network failure, 401, or an unparseable
 *  body — callers MUST treat a rejection as "usage unavailable" and fall back to the local-tally
 *  {@link import("./accountStore").getUsage} estimate, never letting it break the screen. */
export function getAccountUsageLive(configDir: string): Promise<AccountUsageLive> {
  // Tauri auto-maps the camelCase arg key `configDir` to the Rust command's `config_dir` param.
  return invoke<AccountUsageLive>("account_usage_live", { configDir });
}
