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
  /** The pay-as-you-go USAGE-CREDITS meter, or null when the account carries none.
   *
   *  `?: T | null` and NOT `?: T`: the Rust side is `Option<LiveExtraUsage>`, and a Rust `Option`
   *  crosses the wire as an explicit `null`, never as an absent key (AGENTS.md's serde/TS seam).
   *  Typing it `?: T` would describe a shape the wire cannot produce. The `?` is here only so
   *  existing test fixtures that predate this field still typecheck; treat absent and null as the
   *  same "no credits meter reported" answer — {@link summarizeMeter} does. */
  extraUsage?: LiveExtraUsage | null;
}

/** One entry of the upstream `limits` array. Every field nullable, for the same reason as above. */
export interface LiveLimit {
  kind: string | null;
  group: string | null;
  percent: number | null;
  severity: string | null;
  resetsAt: string | null;
  isActive: boolean | null;
  /** WHICH model/surface this limit is scoped to; null on an account-wide window. Same
   *  `T | null` reasoning as `extraUsage` above — the wire sends `"scope": null`, not an absent key. */
  scope?: LiveLimitScope | null;
}

/** The scope of a scoped limit. Only `model` is projected from upstream. */
export interface LiveLimitScope {
  model?: LiveLimitModel | null;
}

/** The model a scoped limit belongs to. `displayName` is the readable one ("Fable"). */
export interface LiveLimitModel {
  id?: string | null;
  displayName?: string | null;
}

/** The pay-as-you-go usage-credits meter (`extra_usage` upstream). Every field nullable — a
 *  subscription-only account sends `isEnabled: false` with the rest `null`. */
export interface LiveExtraUsage {
  isEnabled?: boolean | null;
  monthlyLimit?: number | null;
  usedCredits?: number | null;
  utilization?: number | null;
  spendLimitReached?: boolean | null;
}

/** WHICH BILLING METER an account is spending against, reduced to the three facts a human needs at
 *  a glance BEFORE a fleet of agents runs into a limit — not after.
 *
 *  `meter` is "usageCredits" only on an explicit `isEnabled: true`: null, undefined and false all
 *  mean the subscription windows are the whole story, and defaulting an unknown to "credits" would
 *  invent a spend story the payload never told. Same for `spendLimitReached` — only an explicit
 *  `true` is a warning. */
export interface MeterSummary {
  meter: "subscription" | "usageCredits";
  /** Credits consumed this month, or null when unreported. */
  usedCredits: number | null;
  /** The configured monthly credit ceiling, or null when unreported. */
  monthlyLimit: number | null;
  /** TRUE only on an explicit upstream `spend_limit_reached: true`. */
  spendLimitReached: boolean;
}

/** Reduce a live payload to {@link MeterSummary}. Pure; tolerates null AND undefined identically. */
export function summarizeMeter(live: AccountUsageLive): MeterSummary {
  const extra = live.extraUsage ?? null;
  return {
    meter: extra?.isEnabled === true ? "usageCredits" : "subscription",
    usedCredits: extra?.usedCredits ?? null,
    monthlyLimit: extra?.monthlyLimit ?? null,
    spendLimitReached: extra?.spendLimitReached === true,
  };
}

/** The readable model name a scoped limit belongs to ("Fable"), or null when the limit is
 *  account-wide or upstream sent no name. Answers "WHOSE weekly window am I looking at". */
export function scopedModelName(limit: LiveLimit): string | null {
  return limit.scope?.model?.displayName ?? null;
}

/** Fetch REAL live usage for the account whose config dir is `configDir`.
 *
 *  `force` (default false) BYPASSES the Rust TTL token cache: it drops
 *  `<dir>/.sparkle-usage-cache.json` before reading, so the fetch re-reads the account's
 *  creds file / keychain and re-queries Anthropic **now**. This is the "Refresh usage" button's
 *  path — a macOS keychain prompt on the forced read is EXPECTED (the user asked to true up levels
 *  on demand), not a failure. The per-account screen effect calls this WITHOUT `force`, keeping the
 *  quiet cached path that raises no prompt on an ordinary screen open.
 *
 *  Rejects (the Rust command returns `Err`) on no token, network failure, 401, or an unparseable
 *  body — callers MUST treat a rejection as "usage unavailable" and fall back to the local-tally
 *  {@link import("./accountStore").getUsage} estimate, never letting it break the screen. */
export function getAccountUsageLive(
  configDir: string,
  force = false,
): Promise<AccountUsageLive> {
  // Tauri auto-maps the camelCase arg keys `configDir`/`force` to the Rust command's params.
  return invoke<AccountUsageLive>("account_usage_live", { configDir, force });
}
