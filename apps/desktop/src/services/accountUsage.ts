// Frontend service for REAL, live per-account Claude subscription usage — the actual server-side
// utilization Anthropic reports for an account, as opposed to the LOCAL transcript token-tally in
// `accountStore.ts` (`getUsage`). This is a thin JS surface over the Rust `account_usage_live`
// Tauri command (see src-tauri/src/account_usage.rs), which reads the account's OAuth token and
// calls Anthropic's OAuth usage endpoint. Secrets never cross this boundary — only the parsed
// windows do.
//
// ── TWO ENTRY POINTS, AND THE SPLIT IS THE SAFETY PROPERTY ────────────────────────────────────
// `account_usage_live` is the ONLY thing in Sparkle that can raise the macOS
// 'Sparkle wants to access key "Claude Code-credentials-<hex>" in your keychain' dialog: it reads
// that item IN-PROCESS, so macOS names Sparkle because Sparkle IS the caller. A prompt the user
// asked for is fine; a prompt raised by a background timer is not, and this screen is polled from
// three separate intervals (10s / 60s / 120s) that all funnel into `refreshLiveUsage`.
//
// So the force flag is NOT a parameter any more — it is the difference between two exports:
//   * {@link getAccountUsageLive}       — QUIET. Never touches the keychain. Cache/creds-file only.
//   * {@link getAccountUsageLiveForced} — INTERACTIVE. May prompt. USER-INITIATED ONLY.
// A timer path holds a reference to the quiet function and there is no boolean it can pass to turn
// it into the loud one. That is the whole point: prose asking callers not to force did not survive
// a refactor, a type signature does.
//
// Testability: the `invoke` call is mocked at the module boundary in tests (same pattern as
// accountStore.ts). The AccountsScreen consumes both through injectable `getUsageLive` /
// `getUsageLiveForced` deps so the component can be driven without a Tauri bridge.
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

/** The EXACT, stable prefix the Rust `account_usage_live` command puts on a quiet miss.
 *
 *  A quiet (`force: false`) read looks only at Sparkle's TTL token cache and `<dir>/.credentials.json`
 *  — never the keychain. When neither holds a usable token it rejects with a message beginning with
 *  this literal. That is NOT a malfunction: the account is very likely healthy and its cached OAuth
 *  token has merely lapsed, and the ONE thing that would recover it (a keychain read) is precisely
 *  what a background poll must not do. Callers render it as "usage unknown" and point the user at the
 *  user-initiated {@link getAccountUsageLiveForced} path, never as an error.
 *
 *  Kept as a shared constant rather than typed twice: it is a cross-language contract with
 *  `src-tauri/src/account_usage.rs`, and a drifting copy would silently reclassify every lapsed
 *  account back into the scary error state this exists to prevent. */
export const USAGE_UNKNOWN_PREFIX = "usage unknown: ";

/** The prefix the Rust side stamps when the keychain REFUSED an item that exists — the user
 *  declined the macOS prompt, or a prior decline is still inside its suppression window
 *  (`KEYCHAIN_DENIED_PREFIX` in `src-tauri/src/account_usage.rs`).
 *
 *  This is emphatically NOT "the account is signed out": the credential is very likely there and we
 *  were simply not allowed to look. It reaches the frontend only on the INTERACTIVE path, because
 *  the quiet path never asks the keychain anything. */
export const KEYCHAIN_DENIED_PREFIX = "keychain access not granted";

/** The prefix the Rust side stamps when it refused to read the keychain because the read would have
 *  run on the AppKit main thread (`KEYCHAIN_MAIN_THREAD_PREFIX` in
 *  `src-tauri/src/account_usage.rs`).
 *
 *  It is a Sparkle-side bug report, not a statement about the account — so it must never be rendered
 *  as "check your connection or sign in again", which would send the user chasing a fault that is
 *  ours. It shares the calm "unknown" rendering because the user-facing truth is identical: we could
 *  not look, and nothing is known to be wrong with their account. */
export const KEYCHAIN_MAIN_THREAD_PREFIX = "keychain read refused on the main thread";

/** Every prefix that means "we could not ANSWER", as opposed to "we asked and it went wrong".
 *
 *  All three are cross-language contracts with `src-tauri/src/account_usage.rs`, kept in one list so
 *  a new Rust refusal has exactly one place to be added on this side. */
const UNANSWERABLE_PREFIXES = [
  USAGE_UNKNOWN_PREFIX,
  KEYCHAIN_DENIED_PREFIX,
  KEYCHAIN_MAIN_THREAD_PREFIX,
] as const;

/** True when `err` is one of the Rust command's "I could not answer" rejections.
 *
 *  THE SET MATTERS, not just the common member. The quiet path can only ever reject with
 *  {@link USAGE_UNKNOWN_PREFIX}, so for a long time matching that alone looked sufficient — but the
 *  INTERACTIVE path has two more outcomes that are equally not-an-error: the user declined the
 *  keychain prompt ({@link KEYCHAIN_DENIED_PREFIX}), and the read was refused for running on the
 *  main thread ({@link KEYCHAIN_MAIN_THREAD_PREFIX}). Matching only the first classified a declined
 *  prompt as a hard failure and told the user to "check your connection or sign in again" — advice
 *  that is wrong in both halves, for a user who had just answered a dialog. A remedy message is an
 *  instruction someone will follow, so misclassifying here is a user-facing defect, not a cosmetic
 *  one.
 *
 *  Tolerates the three shapes a rejected Tauri `invoke` can hand back — the bare string a Rust
 *  `Err(String)` becomes, an `Error` wrapping it, and any object carrying a string `message`. Anything
 *  else (a network failure, a 401, an unparseable body) is a GENUINE error and returns false, which is
 *  what keeps the real error state meaningful. */
export function isUsageUnknownError(err: unknown): boolean {
  const msg =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : typeof (err as { message?: unknown } | null)?.message === "string"
          ? ((err as { message: string }).message)
          : "";
  const trimmed = msg.trimStart();
  return UNANSWERABLE_PREFIXES.some((p) => trimmed.startsWith(p));
}

/** Fetch REAL live usage for `configDir` on the QUIET path — the one every automatic caller uses.
 *
 *  NEVER PROMPTS. It takes no `force` argument, by design: the Rust command is called with
 *  `force: false`, which reads Sparkle's TTL token cache and `<dir>/.credentials.json` and stops
 *  there. It cannot reach the keychain, so no screen effect, poll or background refresh routed
 *  through here can raise a macOS confidential-information dialog — no matter how often it fires.
 *
 *  Rejects on no usable cached token (message prefixed {@link USAGE_UNKNOWN_PREFIX} — render "usage
 *  unknown", NOT an error; see {@link isUsageUnknownError}), and on the genuine failures: network,
 *  401, an unparseable body. Callers MUST treat ANY rejection as "no live figure right now" and fall
 *  back to whatever they showed before, never letting it break the screen. */
export function getAccountUsageLive(configDir: string): Promise<AccountUsageLive> {
  // Tauri auto-maps the camelCase arg keys `configDir`/`force` to the Rust command's params. `force`
  // is passed EXPLICITLY false rather than omitted so the Rust `Option<bool>` receives a concrete
  // value instead of depending on an absent key.
  return invoke<AccountUsageLive>("account_usage_live", { configDir, force: false });
}

/** Fetch REAL live usage for `configDir` on the INTERACTIVE path. USER-INITIATED ONLY.
 *
 *  MAY PROMPT, and that is the point. `force: true` bypasses the TTL token cache and re-reads the
 *  account's credentials — including the keychain — so a macOS
 *  'Sparkle wants to access key "Claude Code-credentials-…"' dialog here is EXPECTED and WANTED: the
 *  user just asked to true up this account's levels on demand and this is the read that does it.
 *
 *  THE ONLY LEGITIMATE CALLER IS A USER GESTURE — today the per-card ⋮ → "Check usage levels" item in
 *  AccountsScreen.tsx, and nothing else. It is a separate export precisely so a timer, poll, mount
 *  effect or background refresher CANNOT reach this behaviour by passing a boolean; wiring it to one
 *  reintroduces the constant-prompt bug (`sparkle-dkxuf6`, `sparkle-oe9y1k`) and no test of the quiet
 *  path would notice. If you are adding a caller and it is not a click, you want
 *  {@link getAccountUsageLive}.
 *
 *  Same rejection contract as the quiet path. A {@link USAGE_UNKNOWN_PREFIX} rejection HERE means the
 *  interactive read itself could not produce a token (the prompt was declined, or there is no stored
 *  credential at all) — still not a reason to tell a user their connection is broken. */
export function getAccountUsageLiveForced(configDir: string): Promise<AccountUsageLive> {
  return invoke<AccountUsageLive>("account_usage_live", { configDir, force: true });
}
