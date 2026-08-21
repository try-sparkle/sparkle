// Pure, React-free view helpers for the accounts screen. Kept in their own module (not inline in
// AccountsScreen.tsx) so each can be unit-tested WITHOUT rendering the whole component or mocking a
// Tauri bridge — the sort order, the usage→colour mapping and the reset caption are all decidable
// from plain inputs. AccountsScreen.tsx imports and applies them.

// ── Item 1: order accounts by "most space" (session+weekly blend), descending ─────────────────────

/** The inputs the space-ordering comparator needs for ONE account, projected out of the live
 *  Anthropic usage + sign-in state. `sessionUsedPct` / `weeklyUsedPct` are the REAL used percents
 *  (0–100), or `null` when that window is unknown/unreadable. `usable` is false for a signed-out or
 *  otherwise unusable account. `alias` is the display name, used only as the final tie-break. */
export interface AccountSpaceInput {
  id: string;
  alias: string;
  usable: boolean;
  sessionUsedPct: number | null;
  weeklyUsedPct: number | null;
}

/** The "how much room is left" score for an account with known usage: free% blended across the two
 *  windows, weekly weighted HIGHER (0.6 vs 0.4) because the 7-day window is the scarcer, slower-
 *  resetting resource. Higher = more space. Pure; free% is `100 - used%`. */
export function spaceScore(sessionUsedPct: number, weeklyUsedPct: number): number {
  return 0.4 * (100 - sessionUsedPct) + 0.6 * (100 - weeklyUsedPct);
}

/** Sort tier: 0 = usable with full usage data (ranked by score), 1 = usable but usage unknown
 *  (sorts BELOW those with data), 2 = signed-out/unusable (sorts LAST). */
function spaceTier(x: AccountSpaceInput): 0 | 1 | 2 {
  if (!x.usable) return 2;
  if (x.sessionUsedPct == null || x.weeklyUsedPct == null) return 1;
  return 0;
}

/** Comparator implementing the founder's ordering: most space first. Tier first (data ▸ unknown ▸
 *  signed-out), then within the data tier by `spaceScore` DESC, then by higher weekly-free, then by
 *  `alias.localeCompare` (also the sole order within the unknown / signed-out tiers). Returns the
 *  usual negative/zero/positive. */
export function compareBySpace(a: AccountSpaceInput, b: AccountSpaceInput): number {
  const ta = spaceTier(a);
  const tb = spaceTier(b);
  if (ta !== tb) return ta - tb; // lower tier (more usable / more data) first
  if (ta === 0) {
    const sa = spaceScore(a.sessionUsedPct!, a.weeklyUsedPct!);
    const sb = spaceScore(b.sessionUsedPct!, b.weeklyUsedPct!);
    if (sb !== sa) return sb - sa; // higher score (more space) first
    const wa = 100 - a.weeklyUsedPct!;
    const wb = 100 - b.weeklyUsedPct!;
    if (wb !== wa) return wb - wa; // tie-break: higher weekly-free first
  }
  return a.alias.localeCompare(b.alias);
}

/** Order an arbitrary list "most space first" using {@link compareBySpace}, via a projection to the
 *  comparator's inputs. Returns a NEW array; the input is not mutated. */
export function orderBySpace<T>(items: readonly T[], toInput: (t: T) => AccountSpaceInput): T[] {
  return [...items].sort((x, y) => compareBySpace(toInput(x), toInput(y)));
}

// ── Item 9: colour-code a usage bar by its USED percent ───────────────────────────────────────────

export type UsageColor = "green" | "blue" | "yellow" | "orange" | "red";

/** Bucket a used-percent (0–100) into a traffic-light colour. Half-open buckets, lower bound
 *  INCLUSIVE at each step so there is no overlap: <40 green, [40,60) blue, [60,80) yellow,
 *  [80,90) orange, >=90 red. Pure. */
export function usageColor(usedPct: number): UsageColor {
  if (usedPct < 40) return "green";
  if (usedPct < 60) return "blue";
  if (usedPct < 80) return "yellow";
  if (usedPct < 90) return "orange";
  return "red";
}

/** Hex for each {@link usageColor} bucket — Apple-system-ish values that read on the dark card. */
export const USAGE_COLOR_HEX: Record<UsageColor, string> = {
  green: "#34c759",
  blue: "#5ac8fa",
  yellow: "#ffd60a",
  orange: "#ff9f0a",
  red: "#ff453a",
};

// ── Item 12: humanised reset caption, "Resets in 36 hours (Aug 17, 3:59am PT)" ────────────────────

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The relative half: "Resets in N minutes/hours/days" (singular-aware). Minutes when < 1h, hours
 *  when < 48h, days at/above 48h. `now`/`resetMs` are epoch ms; a reset already past reads
 *  "Resets now". Pure — the clock is passed IN, never read here (the workflow forbids argless Date).
 *
 *  The bucket is chosen from the ROUNDED value, not the raw diff, so rounding can never emit a phrase
 *  the bucketing forbids: 59m40s rounds to 60 minutes, which is not `< 60`, so it reads "1 hour"
 *  rather than the impossible "60 minutes"; 47h50m rounds to 48 hours, not `< 48`, so it reads
 *  "2 days" rather than "48 hours". Without this, `diff < HOUR_MS` picked the bucket off the raw diff
 *  and `Math.round` then pushed the value across the very boundary the bucket documents. */
export function relativeResetPhrase(now: number, resetMs: number): string {
  const diff = resetMs - now;
  if (diff <= 0) return "Resets now";
  const m = Math.max(1, Math.round(diff / MINUTE_MS));
  if (m < 60) return `Resets in ${m} ${m === 1 ? "minute" : "minutes"}`;
  const h = Math.round(diff / HOUR_MS);
  if (h < 48) return `Resets in ${h} ${h === 1 ? "hour" : "hours"}`;
  const d = Math.round(diff / DAY_MS);
  return `Resets in ${d} ${d === 1 ? "day" : "days"}`;
}

/** The absolute half in America/Los_Angeles, "(Mon D, h:mmam/pm PT)" — e.g. "Aug 17, 3:59am PT".
 *  Lowercase am/pm, no leading zero on the hour, always the PT label. Returned WITHOUT the parens.
 *  Pure (formats the given instant). */
export function absolutePtPhrase(resetMs: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(resetMs));
  const get = (t: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === t)?.value ?? "";
  const meridiem = get("dayPeriod").toLowerCase().replace(/[.\s]/g, ""); // "AM" / "a.m." → "am"
  return `${get("month")} ${get("day")}, ${get("hour")}:${get("minute")}${meridiem} PT`;
}

/** The full reset caption: relative countdown + absolute PT time in parens, e.g.
 *  "Resets in 36 hours (Aug 17, 3:59am PT)". `now` is passed in so the result is deterministic and
 *  testable without the real clock. */
export function formatResetCaption(now: number, resetMs: number): string {
  return `${relativeResetPhrase(now, resetMs)} (${absolutePtPhrase(resetMs)})`;
}

// ── Item 13: collapse a long "Running agents" list to one line ────────────────────────────────────

/** How the running-agents list shows when COLLAPSED. With 3 or fewer, show them all inline and no
 *  "+ N more" (a "+1 more" reads worse than the third name). With more, show the first 2 and report
 *  the remainder as `moreCount`. The expanded view (all names) is the component's job; this is the
 *  pure decision of what the collapsed line contains. */
export function collapsedRunningAgents(names: readonly string[]): {
  shown: string[];
  moreCount: number;
} {
  if (names.length <= 3) return { shown: [...names], moreCount: 0 };
  return { shown: names.slice(0, 2), moreCount: names.length - 2 };
}

// ── A SIGN-IN THAT NEVER FINISHED ────────────────────────────────────────────────────────────────
//
// The founder found an account whose title still read "Signing in…" long after the fact. That is
// not a spinner that got stuck — it is PERSISTED state. `AccountLimitModal` creates the account row
// (and its config dir) BEFORE running the login, because the credential has to land in that account
// 's own directory rather than the shared one; the placeholder below is written as the row's real
// `nickname` in accounts.json. Only `onSignedIn` renames it, and that fires solely when the login is
// CONFIRMED. So an abandoned or failed login leaves the placeholder in the store forever, and every
// later render faithfully shows it.
//
// Nothing new has to be persisted to notice: `createdAt` is already stored (epoch SECONDS, the unit
// the Rust side normalizes to), and a row still carrying the placeholder well past a plausible login
// is by definition one that never completed.

/** The nickname written to a row while its login runs. Lives HERE, in the React-free module, so the
 *  staleness rule below can be unit-tested without importing a modal — `AccountLimitModal`
 *  re-exports it for its existing callers. */
export const PENDING_NICKNAME = "Signing in…";

/** What a stalled sign-in shows instead. The founder's words: "just error out to a 'Trouble signing
 *  in' notice." */
export const STALLED_SIGN_IN_TITLE = "Trouble signing in";

/** The generic label a RETAINED-BUT-EXPIRED login keeps: a dir that was signed in once, whose
 *  `oauthAccount` Claude Code has since cleared. The Rust side (`adopt_orphan_dirs_at`, on
 *  `LoginEvidence::SignedOutButUsed`) writes this exact string as the row's `nickname`, and — because
 *  the cleared `oauthAccount` makes `read_oauth_identity_at` return `None` — such a row carries
 *  `email: null` AND `accountUuid: null`, so `rotationReadiness` files it under `notSignedIn` (NOT
 *  `noEmail`). This MUST stay byte-identical to `EXPIRED_LOGIN_NICKNAME` in
 *  `src-tauri/src/accounts.rs`; `scripts/tests/expired-nickname-sync.test.sh` fails the build if it
 *  drifts, since there is no generated binding across the boundary for it. */
export const EXPIRED_LOGIN_NICKNAME = "Login expired — reconnect";

/** How long a sign-in may sit unfinished before it is called a failure. The founder proposed "maybe
 *  within two minutes or something like that"; an OAuth round trip through a browser is seconds,
 *  so two minutes is already generous and a row past it is not merely slow. */
export const SIGN_IN_STALL_SECONDS = 120;

/**
 * Has this account been stuck mid-sign-in past {@link SIGN_IN_STALL_SECONDS}?
 *
 * Pure, so the boundary is testable without a clock or a render. `nowMs` is milliseconds (what
 * `Date.now()` gives) while `createdAtSeconds` is SECONDS — the mismatch is the whole reason this
 * is one named function rather than an inline comparison at the call site, since getting it wrong
 * by 1000x reads as "never stalled" and would look exactly like the bug being fixed.
 *
 * A row whose nickname is anything else has completed (or was never a pending sign-in), so it is
 * never stalled no matter how old it is.
 */
export function signInStalled(
  nickname: string,
  createdAtSeconds: number,
  nowMs: number,
  stallSeconds: number = SIGN_IN_STALL_SECONDS,
): boolean {
  if (nickname !== PENDING_NICKNAME) return false;
  if (!Number.isFinite(createdAtSeconds) || createdAtSeconds <= 0) return false;
  return nowMs / 1000 - createdAtSeconds > stallSeconds;
}
