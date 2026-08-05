// Frontend service for multi Claude Max account support (design spec
// docs/superpowers/specs/2026-06-26-multi-max-account-design.md). An "account" is an isolated
// Claude config dir the user logged into via a normal `claude login`; Sparkle owns the folder,
// never the credentials. This module is the thin JS surface over the Rust `accounts_*` Tauri
// commands (Worker A), plus the PURE selection logic the spawn-path integrator (Worker C) calls
// to choose CLAUDE_CONFIG_DIR per job.
//
// Testability: every Tauri call goes through `invoke` (mocked at the module boundary in tests, see
// accountStore.test.ts). The decision logic — `pickAccount` and the pin map — is pure / in-memory
// so it unit-tests without any IO.
import { invoke } from "@tauri-apps/api/core";
import type { LimitEvent } from "./rateLimitWatch";
import type { Ceiling } from "./headroom";

/** Sparkle metadata for one registered Claude config dir. `configDir` is the absolute path we set
 *  as CLAUDE_CONFIG_DIR when spawning under this account. `isDefault` marks the imported `~/.claude`
 *  (cannot be removed). `createdAt` is epoch SECONDS — the unit the Rust side stores and returns
 *  verbatim (persisted in accounts.json). It's display-only on this side, never compared to
 *  `Date.now()`; the one field that IS time-compared here — {@link Usage.exhaustedUntil} — is
 *  converted to ms at the boundary (see {@link mapUsage}). */
export interface Account {
  id: string;
  nickname: string;
  configDir: string;
  isDefault: boolean;
  createdAt: number;
}

/** Per-account token tally (camelCase boundary type used by the whole app). `tokens5h` / `tokens7d`
 *  are the windowed token tallies read from that account's own transcripts. `exhaustedUntil` is the
 *  epoch-MS instant a real rate-limit is expected to reset (null = not exhausted). The Rust side
 *  stores/reasons in epoch SECONDS; {@link mapUsage} multiplies by 1000 so everything on this side
 *  (pickAccount vs `Date.now()`, `new Date(exhaustedUntil)` in AccountsScreen) stays in ms. */
export interface Usage {
  id: string;
  tokens5h: number;
  tokens7d: number;
  exhaustedUntil: number | null;
}

/** The REAL authenticated Claude identity for an account, read by the Rust side from that account's
 *  own `<configDir>/.claude.json` (`oauthAccount`). This is the TRUSTWORTHY label — the email the
 *  user actually logged into — as opposed to the user-typed {@link Account.nickname}. `email`/`org`
 *  are null for an account with no identity yet (config dir created but never `claude login`ed). */
export interface Identity {
  id: string;
  email: string | null;
  organization: string | null;
  /** Anthropic's own account id. The ONLY reliable way to tell whether two registered accounts are
   *  really the same login — see {@link duplicateAccountGroups}. `null` on a login predating the
   *  field, or an account never signed into. */
  accountUuid: string | null;

  // ── The three fields below arrive from the Rust `AccountIdentity` (PRD/sparkle/
  // claude-account-identity-truth.md §4a). They are declared OPTIONAL deliberately: this UI can
  // ship before the Rust does, and every read below coalesces (`?? null` / `?? false`) so a build
  // whose backend predates them degrades to "no fork known" rather than crashing or — much worse —
  // raising a fork warning about a shell identity nobody actually read.

  /** The identity a plain terminal `claude` would run as (`$HOME/.claude.json`, read with no
   *  CLAUDE_CONFIG_DIR). Present ONLY on the default account: a named account's own config dir is
   *  its own truth, and the shell's login has no bearing on it. */
  shellEmail?: string | null;
  /** `accountUuid` of that same shell identity. On the DEFAULT account, differing from
   *  {@link Identity.accountUuid} is the FORK condition the UI surfaces — Sparkle exports
   *  `CLAUDE_CONFIG_DIR=~/.claude` and so reads `~/.claude/.claude.json`, while the user's terminal
   *  reads `~/.claude.json`. Both can hold valid logins for DIFFERENT Anthropic accounts. */
  shellAccountUuid?: string | null;
  /** True when this config dir is known to have hosted a different `accountUuid` inside the ceiling
   *  learn window, so any learned headroom/ceiling number was partly measured against someone
   *  else. Absent (older backend) means "not known to have changed" — never assume it did. */
  identityChanged?: boolean;
}

/** Raw shape the Rust side returns — mapped to {@link Usage} at the boundary. `AccountUsage` in
 *  accounts.rs is `#[serde(rename_all = "camelCase")]`, so the keys arrive camelCase with the digit
 *  attached (`tokens_5h` → `tokens5h`); the Rust test `account_usage_serializes_camel_case_keys`
 *  pins that contract. This interface once declared snake_case, which typechecks fine (the invoke
 *  result is cast, never validated) but made every tally read `undefined` → the AccountsScreen bars
 *  showed 0 for every account. Only the unit differs from {@link Usage}: `exhaustedUntil` is epoch
 *  SECONDS here (Rust's unit) and `mapUsage` converts it to ms. */
interface RawUsage {
  id: string;
  tokens5h: number;
  tokens7d: number;
  exhaustedUntil: number | null;
}

/** Seconds ⇄ milliseconds at the Rust boundary. accounts.rs stores/filters `exhausted_until` in
 *  epoch SECONDS (`now_secs()`); this side works in ms (`Date.now()`). Keeping the conversion in the
 *  two boundary fns ({@link mapUsage} reading, {@link markExhausted} writing) is the whole fix for
 *  the unit mismatch that made the Rust future-filter a permanent no-op (sparkle-ggvp). */
const MS_PER_SEC = 1000;

function mapUsage(raw: RawUsage): Usage {
  return {
    id: raw.id,
    tokens5h: raw.tokens5h,
    tokens7d: raw.tokens7d,
    // Rust seconds → JS ms so callers can compare against Date.now() / feed new Date(...).
    exhaustedUntil: raw.exhaustedUntil != null ? raw.exhaustedUntil * MS_PER_SEC : null,
  };
}

// ── Thin async command wrappers ───────────────────────────────────────────────────────────────
// Tauri auto-maps these camelCase arg keys to the Rust command's snake_case params.

/** List all registered accounts. */
export function listAccounts(): Promise<Account[]> {
  return invoke<Account[]>("accounts_list");
}

/** Register a fresh, empty config dir under `nickname` and return the new account. The caller still
 *  has to run the `claude login` flow in `account.configDir` — see the {@link AccountsScreen}
 *  `onLogin` seam; this command only creates the folder + metadata. */
export function addAccount(nickname: string): Promise<Account> {
  return invoke<Account>("accounts_add", { nickname });
}

/** Rename an account. */
export function setNickname(id: string, nickname: string): Promise<void> {
  return invoke("accounts_set_nickname", { id, nickname });
}

/** Remove an account (the Rust side refuses to remove the default; the UI also guards). */
export function removeAccount(id: string): Promise<void> {
  return invoke("accounts_remove", { id });
}

/** Import the existing `~/.claude` as the default account (by reference, not copied). */
export function importDefault(): Promise<Account> {
  return invoke<Account>("accounts_import_default");
}

/** Current windowed usage for every account, mapped snake_case → camelCase. */
export async function getUsage(): Promise<Usage[]> {
  const raw = await invoke<RawUsage[]>("accounts_usage");
  return raw.map(mapUsage);
}

/** The REAL authenticated identity (email + org) for every account, read from each account's own
 *  `<configDir>/.claude.json`. `email`/`organization` are null for an account never logged into. */
export function getIdentities(): Promise<Identity[]> {
  return invoke<Identity[]>("accounts_identities");
}

// NO TypeScript binding for the Rust `accounts_spend` command lives here any more. It backed the
// concierge SPEND pill — a trailing-24h estimate of cross-project token value at Anthropic LIST
// price, in dollars, that only ever counted UP and was never billed. It sat 8px from the remaining
// BALANCE badge (`me.balanceCents`, real credits, counting DOWN), both rendered as "$…", and the
// resulting "which number is my money?" is why the pill was deleted
// (PRD/sparkle/concierge-chrome-and-credits.md). The `Spend` interface and `getSpend()` went with
// it, along with `stores/spendStore.ts`.
//
// The Rust side is deliberately still there and still registered — the transcript scan and the
// per-model list pricing are the expensive part, and re-deriving them later would be strictly worse
// than leaving them. A FUTURE spend surface should re-add the binding here, next to the other
// `invoke` wrappers, and must present the figure as an unbilled list-price ESTIMATE — never beside
// the credit balance without saying which is which. Note that Settings → History & Spend is a
// DIFFERENT feature entirely (`services/spendApi.ts` → the Rust `spend_report` command).

/** What every identity surface renders when an account has no verified login. A LITERAL string, not
 *  a name — see {@link accountDisplay} for why it is never the nickname. */
export const NOT_SIGNED_IN = "Not signed in";

/** Everything a surface needs to identify an account HONESTLY, derived in one place so no caller
 *  can re-invent the fallback this type exists to remove.
 *
 *  Frozen shape — PRD/sparkle/claude-account-identity-truth.md §4c. Three workers build against it. */
export type AccountDisplay = {
  /** What to render in the identity slot: the live logged-in email, or the literal
   *  {@link NOT_SIGNED_IN}. NEVER the nickname. */
  primary: string;
  /** Whether {@link AccountDisplay.primary} is a verified identity — i.e. whether there is an EMAIL
   *  to show. Governs the identity SLOT only. Do NOT use it for availability: see
   *  {@link AccountDisplay.hasLogin}. */
  signedIn: boolean;
  /** Whether this account has a real Claude login at all — `accountUuid` OR `email`.
   *
   *  DELIBERATELY WIDER than {@link AccountDisplay.signedIn}, and the two must not be conflated.
   *  `signedIn` answers "can I print a name?"; this answers "is this account usable?". An
   *  `oauthAccount` carrying a uuid but no readable `emailAddress` is fully signed in and fully
   *  usable — `AccountsScreen`'s own affordance and `duplicateAccountGroups` both already key on
   *  uuid — so keying the live dot, the muted ink or any PROSE on `signedIn` renders such an
   *  account as unusable, and made {@link forkNotice} emit the flatly false "Sparkle runs this
   *  account as an account that isn't signed in". Availability and prose key on THIS. */
  hasLogin: boolean;
  /** The user's own label. Always available, and may be shown ONLY as a secondary alias. */
  nickname: string;
  organization: string | null;
  accountUuid: string | null;
  /** Default account only: the user's terminal is signed in as a DIFFERENT Anthropic account than
   *  the one Sparkle runs this account as. See {@link forkNotice}. */
  shellForked: boolean;
  /** The terminal's email, when known. Null when unknown (incl. a backend predating the field). */
  shellEmail: string | null;
};

/** Derive the honest display for one account.
 *
 *  THE BUG THIS FIXES: `accountLabel` was `identity?.email ?? account.nickname`. An account whose
 *  config dir was registered but never `claude login`ed reports `email: null`, so the UI rendered
 *  the USER-TYPED nickname in the exact slot reserved for a verified identity — presenting a string
 *  the user invented as the Anthropic account their work runs under. Measured on the founder's
 *  machine: account "DROdio Gmail" has a config dir whose `.claude.json` carries no `oauthAccount`
 *  at all, and the pill had been showing his own label back to him as though it were a login.
 *  A WRONG IDENTITY IS WORSE THAN NONE (contract §5), so the fallback is gone: an unverified
 *  account reads as unavailable, never as a differently-named account.
 *
 *  All three `shell*`/`identityChanged` reads coalesce, so this is safe against a backend that does
 *  not yet send them: no fork is claimed unless a shell uuid was actually read. */
/** The key an identity is filed under — TS mirror of Rust `accounts::identity_key`.
 *
 *  `accountUuid` when the login records one, otherwise `email:<addr>`, otherwise null (no login at
 *  all). The uuid ALONE is not enough: it is absent on logins predating the field, and those are
 *  fully signed in and fully attributable by email. Rust keys the identity ledger and the ceiling
 *  gate this way; TypeScript must match, or the two halves of one product disagree about who an
 *  account is. */
export function identityKey(identity: Identity | undefined): string | null {
  const uuid = identity?.accountUuid ?? null;
  if (uuid) return uuid;
  const email = identity?.email ?? null;
  return email ? `email:${email}` : null;
}

/** Do two identities denote DIFFERENT Anthropic accounts? TS mirror of Rust
 *  `accounts::identities_differ`.
 *
 *  The uuid decides when BOTH sides have one; otherwise fall back to the email. A bare `!==` on the
 *  uuids reads `null !== "x"` as a difference and INVENTS one — which, on the fork notice, means
 *  telling the user their terminal is on a different account when it may well be the same. Never
 *  claims a difference it cannot show. */
export function identitiesDiffer(
  a: { accountUuid: string | null; email: string | null },
  b: { accountUuid: string | null; email: string | null },
): boolean {
  if (a.accountUuid && b.accountUuid) return a.accountUuid !== b.accountUuid;
  if (a.email && b.email) return a.email !== b.email;
  return false; // unresolvable on one side — unknown, NOT different
}

export function accountDisplay(account: Account, identity: Identity | undefined): AccountDisplay {
  const email = identity?.email ?? null;
  const accountUuid = identity?.accountUuid ?? null;
  const shellAccountUuid = identity?.shellAccountUuid ?? null;
  const shellEmail = identity?.shellEmail ?? null;
  return {
    primary: email ?? NOT_SIGNED_IN,
    signedIn: email != null,
    hasLogin: email != null || accountUuid != null,
    nickname: account.nickname,
    organization: identity?.organization ?? null,
    accountUuid,
    // Default account ONLY (the shell's login is irrelevant to a named account's own dir), and only
    // when a shell uuid was actually read — an absent one is "unknown", never "forked".
    // Requires the default account and a shell identity we could actually RESOLVE — an unknown
    // terminal identity is unknown, never "forked". Given that, two cases are a fork:
    //
    //  * both sides resolvable and DIFFERENT — decided by `identitiesDiffer`, i.e. the uuid when
    //    both have one, else the email. NOT a bare uuid `!==`, which reads `null !== "x"` as a
    //    difference and would announce a fork between what may be one account (knightwatch probe 1).
    //  * this account has no login at all while the terminal does. That is not a claim that they
    //    are different ACCOUNTS — it is the honest "nothing here, something there", and it is worth
    //    surfacing rather than swallowing. `accountSentenceName` names it without inventing a name.
    shellForked:
      account.isDefault &&
      (shellAccountUuid != null || shellEmail != null) &&
      ((accountUuid == null && email == null) ||
        identitiesDiffer(
          { accountUuid, email },
          { accountUuid: shellAccountUuid, email: shellEmail },
        )),
    shellEmail,
  };
}

/** The authoritative label to show for an account. Signature UNCHANGED so no consumer breaks; the
 *  BEHAVIOUR changed — it is now `accountDisplay(...).primary`, which is the verified email or
 *  {@link NOT_SIGNED_IN} and never the nickname. Prefer {@link accountDisplay} in new code, which
 *  also carries the alias, the org and the fork state. */
export function accountLabel(account: Account, identity: Identity | undefined): string {
  return accountDisplay(account, identity).primary;
}

/** Whether this account's learned headroom/ceiling numbers were partly measured against a DIFFERENT
 *  Anthropic login that previously occupied the same config dir. Absent → false ("not known to have
 *  changed"), so an older backend never manufactures a caveat. */
export function identityChanged(identity: Identity | undefined): boolean {
  return identity?.identityChanged ?? false;
}

/** The one-sentence fork warning, or null when there is no fork to report.
 *
 *  The founder's literal complaint: his terminal reads `~/.claude.json` (gmail) while Sparkle's
 *  default account exports `CLAUDE_CONFIG_DIR=~/.claude` and so reads `~/.claude/.claude.json`
 *  (storytell) — two valid logins in two different files, and nothing said so. We deliberately do
 *  NOT offer to migrate: the Rust guard that refuses to normalize a config dir holding a login is
 *  correct and stays (contract §5). Making the fork VISIBLE is the whole fix. */
export function forkNotice(display: AccountDisplay): string | null {
  if (!display.shellForked) return null;
  const sparkleAs = accountSentenceName(display);
  const shellAs = display.shellEmail ?? "a different account";
  return `Sparkle runs this account as ${sparkleAs}; your terminal is signed in as ${shellAs}.`;
}

/** How to name an account inside PROSE. {@link NOT_SIGNED_IN} is a slot label, not a name — dropped
 *  into a sentence it reads as an account literally called "Not signed in". */
export function accountSentenceName(display: AccountDisplay): string {
  if (display.signedIn) return display.primary;
  // A login with a uuid but no readable email IS signed in — saying otherwise in prose is a false
  // statement about the user's own account, rendered in the dropdown and the tooltip. Name it
  // without claiming a name we do not have.
  if (display.hasLogin) return "the account Sparkle is signed into";
  return "an account that isn't signed in";
}

/** A set of registered accounts that are all the SAME Anthropic login — proven by an identical
 *  `accountUuid`, or INFERRED from a shared verified email when no uuid is recorded (see
 *  {@link duplicateAccountGroups} for the two-pass rule and its ambiguity guard). Every group
 *  returned has ≥2 members — a group of one isn't a duplicate. */
export interface DuplicateGroup {
  /** Stable, never-null identifier for this group — the uuid when it has one, else `email:<addr>`.
   *  Use this as a React key; {@link DuplicateGroup.accountUuid} is nullable and cannot serve. */
  key: string;
  /** The shared login's uuid, or null when the group was keyed by EMAIL (a login predating the
   *  `accountUuid` field). Null here does NOT mean "not a duplicate" — see
   *  {@link duplicateAccountGroups}. */
  accountUuid: string | null;
  /** The shared login's email, for display. */
  email: string | null;
  /** The registered accounts that resolve to it, in input order. */
  accounts: Account[];
}

/** Find registered accounts that are really the same Anthropic login.
 *
 *  This exists because it happened: two accounts nicknamed "DROdio Storytell" and "DROdio Gmail"
 *  held logins to the SAME Anthropic account, so failing over between them switched to the same
 *  quota and re-hit the limit immediately while the UI showed two independent headroom bars.
 *
 *  MATCHING IS TWO-PASS, uuid first:
 *    1. every row that records an `accountUuid` buckets by it — the authoritative discriminator;
 *    2. a row with an email but NO uuid joins a uuid group only when that email identifies exactly
 *       ONE such group. If the email maps to two or more, it is ambiguous and the row is not
 *       grouped at all; if no uuid group claims it, email-only rows pair among themselves.
 *
 *  The email fallback is not a nicety: `accountUuid` is absent on logins predating the field, and
 *  without it a pre-field registration and its uuid-bearing twin are never seen as siblings — so
 *  only one is benched when their SHARED quota runs out and auto-pick routes straight back into the
 *  exhausted account. The nickname is never used; it is user-typed and proves nothing. */
export function duplicateAccountGroups(
  accounts: Account[],
  identities: Identity[],
): DuplicateGroup[] {
  const byId = new Map(identities.map((i) => [i.id, i]));

  // TWO PASSES, uuid first. A single pass keyed on `identityKey` still splits ONE login across two
  // groups whenever one registration reports an `accountUuid` and its twin does not — the modern
  // client records the field, an older login in another config dir does not. `siblingMap` is
  // derived from these groups, so a split means only one of the pair gets benched when their SHARED
  // quota runs out, and auto-pick immediately routes work back into the exhausted account. That is
  // precisely the failure this function exists to prevent (knightwatch probe 1).
  const groups = new Map<string, DuplicateGroup>();
  const emailToUuidKeys = new Map<string, Set<string>>();

  // Pass 1 — every row that HAS a uuid. The uuid is the authoritative discriminator.
  for (const a of accounts) {
    const identity = byId.get(a.id);
    const uuid = identity?.accountUuid ?? null;
    if (!uuid) continue;
    const g = groups.get(uuid);
    if (g) g.accounts.push(a);
    else groups.set(uuid, { key: uuid, accountUuid: uuid, email: identity?.email ?? null, accounts: [a] });
    const email = identity?.email;
    if (email) {
      const keys = emailToUuidKeys.get(email) ?? new Set<string>();
      keys.add(uuid);
      emailToUuidKeys.set(email, keys);
    }
  }

  // Pass 2 — rows with an email but no uuid. Merge into a uuid group ONLY when that email
  // identifies exactly one such group: with two, the email is ambiguous (it genuinely maps to more
  // than one Anthropic account) and guessing would bench an account that is not actually a sibling,
  // which is worse than missing the pairing. Otherwise they group among themselves by email.
  for (const a of accounts) {
    const identity = byId.get(a.id);
    if (identity?.accountUuid) continue;
    const email = identity?.email;
    if (!email) continue; // no login at all → not comparable
    const candidates = emailToUuidKeys.get(email);
    if (candidates && candidates.size > 1) {
      // AMBIGUOUS, so this row is not grouped AT ALL — not with a uuid group, and not with the
      // other refused rows either. Falling through to email bucketing here was a real bug: given
      // a(u1,X) b(u2,X) c(no-uuid,X) d(no-uuid,X), c and d landed in one `email:X` group of two,
      // which survives the length filter. That is the SAME unfounded guess the line above just
      // declined — c may be u1 and d may be u2 — except this branch actually produces a group, so
      // `siblingMap` benched d when c exhausted, and the banner told the user "2 accounts are the
      // same Claude login" about accounts we had just proven we cannot pair (roborev 58175).
      continue;
    }
    if (candidates?.size === 1) {
      groups.get([...candidates][0]!)!.accounts.push(a);
      continue;
    }
    // No uuid group claims this email: pair the email-only rows among themselves. `identityKey` is
    // the shared ladder (and here always returns the `email:` form, since uuid-bearing rows already
    // `continue`d), so this key cannot drift from the Rust rule it mirrors.
    const key = identityKey(identity)!;
    const g = groups.get(key);
    if (g) g.accounts.push(a);
    else groups.set(key, { key, accountUuid: null, email, accounts: [a] });
  }

  return [...groups.values()].filter((g) => g.accounts.length > 1);
}

/** Ids of accounts that duplicate another account's login (flattened {@link duplicateAccountGroups}). */
export function duplicateAccountIds(accounts: Account[], identities: Identity[]): Set<string> {
  return new Set(
    duplicateAccountGroups(accounts, identities).flatMap((g) => g.accounts.map((a) => a.id)),
  );
}

/** Raw {@link LimitEvent} shape from Rust — `atEpoch` is epoch SECONDS (Rust's unit). */
interface RawLimitEvent {
  id: string;
  atEpoch: number;
  text: string;
}

/** The newest REAL rate-limit event per account (empty = nothing is rate-limited right now).
 *
 *  Read from the structured `error: "rate_limit"` records in each account's own transcripts — the
 *  authoritative signal, which replaced Phase 1's terminal-text scraping. Seconds are converted to
 *  ms at this boundary, matching the {@link Usage.exhaustedUntil} convention. */
export async function listLimitEvents(): Promise<LimitEvent[]> {
  const raw = await invoke<RawLimitEvent[]>("accounts_limit_events");
  return raw.map((r) => ({ accountId: r.id, at: r.atEpoch * MS_PER_SEC, text: r.text }));
}

/** Per-account LEARNED rate-limit ceilings (Rust `accounts_ceilings`): the median 5h consumption
 *  observed at that account's past limit episodes. `ceiling` is null until enough episodes exist —
 *  callers must treat that as "unknown", never zero. Backs the proactive switch banner. */
export function listCeilings(): Promise<Ceiling[]> {
  return invoke<Ceiling[]>("accounts_ceilings");
}

/** Flag an account as rate-limited until `untilEpoch` (epoch MS — callers pass a `Date.now()`-based
 *  instant, e.g. from rateLimitWatch). Selection excludes it until then. Converts to epoch SECONDS
 *  for the Rust side, which stores + future-filters in seconds (sparkle-ggvp): persisting ms there
 *  made `exhausted_until > now_secs()` always true, so expired exhaustions never cleared. */
export function markExhausted(id: string, untilEpoch: number): Promise<void> {
  return invoke("accounts_mark_exhausted", { id, untilEpoch: Math.round(untilEpoch / MS_PER_SEC) });
}

// ── Selection logic (pure) ────────────────────────────────────────────────────────────────────

/** Soft per-window token ceilings used by {@link pickAccount} to skip accounts that are *near* a
 *  cap (we can't read Anthropic's real caps). An account at/above either threshold is excluded from
 *  auto-pick — but never below the all-excluded fallback.
 *  TODO(Phase 2): learn these per-account from real rate-limit failures (record the token level at
 *  which the account got limited as that window's ceiling) instead of these static defaults. */
export interface NearCap {
  tokens5h: number;
  tokens7d: number;
}

// No static cap by default. Anthropic's real Max limits aren't readable, and any fixed guess (the
// old 5M/30M) is wrong by orders of magnitude once cache-read tokens are counted — it marked every
// real account "near cap" and collapsed auto-pick to the fallback (always the default account)
// instead of routing to the least-used one. So default to effectively no ceiling: pickAccount then
// ranks purely by LOWEST usage, with each account's `exhaustedUntil` (set when a real rate-limit
// message is observed) as the reactive backstop. Phase 2 can learn per-account ceilings from real
// rate-limit failures and pass them via PickOptions.nearCap.
export const DEFAULT_NEAR_CAP: NearCap = {
  tokens5h: Number.MAX_SAFE_INTEGER,
  tokens7d: Number.MAX_SAFE_INTEGER,
};

export interface PickOptions {
  /** Manual per-agent override. If set and it names an existing account, that account wins
   *  unconditionally (even if exhausted/near-cap/not signed in) — a human chose it on purpose. */
  pinnedAccountId?: string;
  /** Soft window ceilings; defaults to {@link DEFAULT_NEAR_CAP}. */
  nearCap?: NearCap;
  /** Ids of accounts that are actually `claude login`ed (see {@link signedInAccountIds}). When
   *  supplied and at least one listed account matches, auto-pick considers ONLY these. Omit (or pass
   *  a set matching no account) to skip the filter entirely — see the rationale on `pickAccount`. */
  signedInIds?: readonly string[];
  /** Current time (epoch ms), injectable for tests. Defaults to `Date.now()`. */
  now?: number;
}

/** The ids of accounts with a REAL authenticated identity — i.e. actually `claude login`ed. An
 *  account whose config dir exists but was never logged into reports `email: null`
 *  ({@link Identity}). Feed this to {@link PickOptions.signedInIds}.
 *
 *  `email != null` is the authoritative signed-in signal, not a heuristic: the Rust side derives it
 *  from `<configDir>/.claude.json`'s `oauthAccount.emailAddress`, and a missing/empty
 *  `oauthAccount` OR a missing/empty `emailAddress` all yield None (accounts.rs `read_identity`).
 *  It is the same field the first-run gate's `claude_signed_in` keys on. Deliberately NOT widened
 *  to `organization`, which accounts.rs can leave None even for a completed login. */
export function signedInAccountIds(identities: Identity[]): string[] {
  return identities.filter((i) => i.email != null).map((i) => i.id);
}

/** Choose the account a new job should run under. PURE — no IO.
 *
 *  Order (design spec §"Per-job account selection"):
 *    1. A valid `pinnedAccountId` override wins outright.
 *    2. Otherwise keep only SIGNED-IN accounts (when `signedInIds` is supplied), then drop those
 *       that are exhausted (`exhaustedUntil` in the future) or near a window cap, then pick the
 *       LOWEST `tokens7d` (tie-break: lowest `tokens5h`).
 *    3. If that leaves nothing, fall back to the default account (else the first account) — we
 *       never return null while any account exists; the hard rate-limit is the real backstop.
 *  Returns null only for an empty account list. Accounts with no usage row are treated as having
 *  the most headroom (zero tokens, not exhausted).
 *
 *  The signed-in filter exists because those two rules compose into a trap (sparkle-gms0): an
 *  account dir that was created but never `claude login`ed has no transcripts, so its tally is
 *  zero — the most headroom of all — and it would win auto-pick for EVERY agent, spawning each one
 *  into a login prompt. It degrades safely: if no listed account is signed in (identities not
 *  loaded yet, or an IPC hiccup returning []), the filter is skipped rather than blocking spawns. */
export function pickAccount(
  accounts: Account[],
  usage: Usage[],
  opts: PickOptions = {},
): Account | null {
  if (accounts.length === 0) return null;

  const { pinnedAccountId } = opts;

  if (pinnedAccountId) {
    const pinned = accounts.find((a) => a.id === pinnedAccountId);
    if (pinned) return pinned;
  }

  const { eligible, candidates } = partitionAccounts(accounts, usage, opts);
  const usageFor = usageLookup(usage);

  if (candidates.length === 0) {
    // Everyone is exhausted / near-cap: fall back rather than block. Prefer the default account.
    // eligible is non-empty (accounts is guarded above), so eligible[0] is defined.
    return eligible.find((a) => a.isDefault) ?? (eligible[0] as Account);
  }

  // Lowest 7d tally wins; tie-break on lowest 5h. Stable — equal entries keep input order.
  return candidates.reduce((best, a) => {
    const ua = usageFor(a);
    const ub = usageFor(best);
    if (ua.tokens7d !== ub.tokens7d) return ua.tokens7d < ub.tokens7d ? a : best;
    if (ua.tokens5h !== ub.tokens5h) return ua.tokens5h < ub.tokens5h ? a : best;
    return best;
  });
}

/** Usage row per account, treating a missing row as "no usage yet" (the most headroom). */
function usageLookup(usage: Usage[]): (a: Account) => Usage {
  const usageById = new Map(usage.map((u) => [u.id, u]));
  const ZERO: Usage = { id: "", tokens5h: 0, tokens7d: 0, exhaustedUntil: null };
  return (a: Account) => usageById.get(a.id) ?? ZERO;
}

/** Split the account list the way {@link pickAccount} does, in ONE place.
 *
 *  - `eligible` — signed-in accounts, or the full list when that filter would empty it (better a
 *    login prompt than a dead agent).
 *  - `candidates` — those of `eligible` that are neither exhausted nor near a window cap. May be
 *    empty, which is what drives `pickAccount`'s fall-back branch.
 *
 *  Extracted because a SECOND caller now needs the same judgement: sticky selection
 *  ({@link eligibleAccounts}) has to ask "is the account I chose last time still a healthy pick?",
 *  and re-deriving "healthy" there would be a second definition of eligibility, drifting from this
 *  one the first time either changed. */
function partitionAccounts(
  accounts: Account[],
  usage: Usage[],
  opts: PickOptions = {},
): { eligible: Account[]; candidates: Account[] } {
  const { nearCap = DEFAULT_NEAR_CAP, signedInIds, now = Date.now() } = opts;

  // Signed-in accounts only — unless that would eliminate everything, in which case we keep the
  // full list so a spawn still happens (better a login prompt than a dead agent).
  const signedIn = signedInIds ? new Set(signedInIds) : null;
  const authed = signedIn ? accounts.filter((a) => signedIn.has(a.id)) : [];
  const eligible = authed.length > 0 ? authed : accounts;

  const usageFor = usageLookup(usage);
  const isExhausted = (u: Usage) => u.exhaustedUntil != null && u.exhaustedUntil > now;
  const isNearCap = (u: Usage) => u.tokens5h >= nearCap.tokens5h || u.tokens7d >= nearCap.tokens7d;

  const candidates = eligible.filter((a) => {
    const u = usageFor(a);
    return !isExhausted(u) && !isNearCap(u);
  });
  return { eligible, candidates };
}

/** The accounts auto-pick would consider RIGHT NOW: signed in, not exhausted, not near a cap.
 *  `pickAccount` returns the best of these; this exposes the whole healthy set so a caller can ask
 *  whether a PARTICULAR account is still a sound choice without re-implementing the rule.
 *
 *  Note it deliberately ignores `pinnedAccountId` — a pin overrides the judgement, it does not
 *  change it. */
export function eligibleAccounts(
  accounts: Account[],
  usage: Usage[],
  opts: PickOptions = {},
): Account[] {
  return partitionAccounts(accounts, usage, opts).candidates;
}

// ── Persisted pin map (agentId → accountId) ───────────────────────────────────────────────────
// A manual per-agent override the spawn-path integrator reads before each spawn and passes to
// `pickAccount({ pinnedAccountId })`.
//
// This was in-memory only in Phase 1, which turned out to be the whole of sparkle-gms0: restarting
// Sparkle dropped every pin, auto-pick resumed, and each agent could land on a DIFFERENT account
// than before the restart — including one never logged into — so every agent demanded a fresh
// login. Agent ids are stable across restarts (AgentTab.id is persisted by projectStore), so
// keying the persisted map by agentId is sound.
//
// localStorage (not a zustand store) because the pin API is a plain function surface consumed
// outside React; every access is wrapped so a disabled/full/corrupt store degrades to auto-pick
// rather than throwing on the spawn path.

/** localStorage key holding the agentId → accountId pin map. Exported for tests. */
export const PINS_STORAGE_KEY = "sparkle.accountPins.v1";

function readPins(): Map<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(PINS_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    // Drop non-string values defensively — a hand-edited or older blob must not yield a pin whose
    // "account id" is a number/object, which would silently never match an account.
    return new Map(
      Object.entries(parsed as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    );
  } catch {
    return new Map(); // unparseable / storage unavailable → no pins, everything auto-picks
  }
}

function writePins(map: Map<string, string>): void {
  try {
    globalThis.localStorage?.setItem(PINS_STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // Storage unavailable or over quota. The in-memory map still holds for this session; the pin
    // just won't survive a restart. Never let this break a spawn.
  }
}

// Every operation reads through to storage rather than caching a module-level Map. localStorage is
// shared across windows but we subscribe to no `storage` event, so a cached copy would let this
// window mask a pin (or unpin) another window just wrote — and a read-modify-write over a stale
// copy would drop the other window's edits entirely. These calls happen at spawn time and on a
// manual pin, i.e. rarely, so a JSON round-trip per access costs nothing worth optimizing.

/** The account this agent is pinned to, or undefined if it auto-picks. */
export function getPin(agentId: string): string | undefined {
  return readPins().get(agentId);
}

/** Pin `agentId` to `accountId` (manual override for all of this agent's future spawns). */
export function setPin(agentId: string, accountId: string): void {
  const m = readPins();
  m.set(agentId, accountId);
  writePins(m);
}

/** Clear an agent's pin (revert it to auto-pick). Called when an agent is closed, so persisted
 *  pins don't accumulate for agents that no longer exist. */
export function clearPin(agentId: string): void {
  const m = readPins();
  if (!m.delete(agentId)) return; // nothing pinned → don't rewrite storage
  writePins(m);
}

/** Drop all pins (e.g. on full reset). Exposed mainly for tests/teardown. */
export function clearAllPins(): void {
  writePins(new Map());
}
